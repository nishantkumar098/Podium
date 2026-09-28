import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { CreatePnlStatementInput, PnlSection } from "@podium/shared-types";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { allowedCityIds, type RequestUser } from "../common/types";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The statement's totals, worked out here so every screen shows the same figures. */
export function pnlTotals(lines: Array<{ section: string; amount: unknown }>) {
  const sum = (s: PnlSection) => round2(lines.filter((l) => l.section === s).reduce((t, l) => t + Number(l.amount), 0));
  const revenue = sum("REVENUE");
  const directCosts = sum("DIRECT_COST");
  const opex = sum("OPEX");
  const otherIncome = sum("OTHER_INCOME");
  const tax = sum("TAX");
  const grossProfit = round2(revenue - directCosts);
  const operatingProfit = round2(grossProfit - opex);
  const profitBeforeTax = round2(operatingProfit + otherIncome);
  const netProfit = round2(profitBeforeTax - tax);
  const pctOf = (v: number) => (revenue > 0 ? Math.round((v / revenue) * 1000) / 10 : null);
  return {
    revenue,
    directCosts,
    grossProfit,
    opex,
    operatingProfit,
    otherIncome,
    profitBeforeTax,
    tax,
    netProfit,
    grossMarginPct: pctOf(grossProfit),
    operatingMarginPct: pctOf(operatingProfit),
    netMarginPct: pctOf(netProfit),
  };
}

const INCLUDE = {
  lines: { orderBy: { position: "asc" as const } },
};

/**
 * Hand-built P&L statements. City rules match every other city-scoped
 * record: a statement for a city is visible to people with that city; a
 * company-wide one (no city) to all-cities people only.
 */
@Injectable()
export class PnlStatementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
  ) {}

  async list(user: RequestUser) {
    const allowed = allowedCityIds(user);
    const rows = await this.prisma.client.pnlStatement.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null, ...(allowed === "ALL" ? {} : { cityId: { in: allowed } }) },
      include: { lines: { select: { section: true, amount: true } } },
      orderBy: { updatedAt: "desc" },
    });
    const names = await this.names(rows);
    return rows.map(({ lines, ...s }) => ({ ...s, ...names(s), lineCount: lines.length, totals: pnlTotals(lines) }));
  }

  async get(user: RequestUser, id: string) {
    const s = await this.prisma.client.pnlStatement.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null }, include: INCLUDE });
    if (!s) throw new NotFoundException("P&L statement not found.");
    this.cityScope.assertCanAccessCity(user, s.cityId);
    const names = await this.names([s]);
    return { ...s, ...names(s), totals: pnlTotals(s.lines) };
  }

  async create(user: RequestUser, input: CreatePnlStatementInput) {
    const refs = await this.checkRefs(user, input);
    const s = await this.prisma.client.pnlStatement.create({
      data: {
        workspaceId: user.workspaceId,
        createdById: user.id,
        ...this.fields(input, refs.cityId),
        lines: { create: input.lines.map((l, position) => ({ ...l, position })) },
      },
    });
    return this.get(user, s.id);
  }

  async update(user: RequestUser, id: string, input: CreatePnlStatementInput) {
    await this.get(user, id);
    const refs = await this.checkRefs(user, input);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.pnlStatement.update({ where: { id }, data: this.fields(input, refs.cityId) });
      // A statement's lines are one coherent sheet: replace them together.
      await tx.pnlLine.deleteMany({ where: { statementId: id } });
      if (input.lines.length) await tx.pnlLine.createMany({ data: input.lines.map((l, position) => ({ ...l, position, statementId: id })) });
    });
    return this.get(user, id);
  }

  async remove(user: RequestUser, id: string) {
    await this.get(user, id);
    await this.prisma.client.pnlStatement.update({ where: { id }, data: { deletedAt: new Date() } });
    return { id, deleted: true };
  }

  private fields(input: CreatePnlStatementInput, cityId: string | null) {
    return {
      title: input.title.trim(),
      cityId,
      projectId: input.projectId ?? null,
      periodFrom: input.periodFrom ? new Date(`${input.periodFrom}T00:00:00Z`) : null,
      periodTo: input.periodTo ? new Date(`${input.periodTo}T00:00:00Z`) : null,
      notes: input.notes?.trim() || null,
    };
  }

  /**
   * The city and project must be real and yours to see. A project statement
   * takes the project's city, so its visibility follows the project.
   */
  private async checkRefs(user: RequestUser, input: CreatePnlStatementInput): Promise<{ cityId: string | null }> {
    let cityId = input.cityId ?? null;
    if (input.projectId) {
      const project = await this.prisma.client.project.findFirst({ where: { id: input.projectId, workspaceId: user.workspaceId, deletedAt: null }, select: { cityId: true } });
      if (!project) throw new BadRequestException("That project can't be found.");
      if (cityId && cityId !== project.cityId) throw new BadRequestException("That project belongs to a different city.");
      cityId = project.cityId;
    }
    if (cityId) {
      const city = await this.prisma.client.city.count({ where: { id: cityId, workspaceId: user.workspaceId, deletedAt: null } });
      if (!city) throw new BadRequestException("That city can't be found.");
    }
    this.cityScope.assertCanAccessCity(user, cityId);
    return { cityId };
  }

  /** City, project and author names for display. */
  private async names(rows: Array<{ cityId: string | null; projectId: string | null; createdById: string }>) {
    const db = this.prisma.client;
    const [cities, projects, users] = await Promise.all([
      db.city.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.cityId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
      db.project.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.projectId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
      db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, name: true } }),
    ]);
    const c = new Map(cities.map((x) => [x.id, x.name]));
    const p = new Map(projects.map((x) => [x.id, x.name]));
    const u = new Map(users.map((x) => [x.id, x.name]));
    return (r: { cityId: string | null; projectId: string | null; createdById: string }) => ({
      cityName: r.cityId ? c.get(r.cityId) ?? null : null,
      projectName: r.projectId ? p.get(r.projectId) ?? null : null,
      createdByName: u.get(r.createdById) ?? null,
    });
  }
}

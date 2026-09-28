import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";
import { buildRequirementSheet, standardKit, type SheetSection } from "./requirement-sheet";

/** The same 10% planning buffer the Requirements screen shows. */
const BUFFER = 1.1;

export interface RequirementSheetRequest {
  projectId?: string | null;
  eventName?: string | null;
  eventDate?: string | null;
  address?: string | null;
  pax: number;
  to?: string | null;
  from?: string | null;
  hookah?: string | null;
  staffing?: string | null;
  inclusions?: string | null;
  menu: Array<{ recipeId: string; serves: number }>;
}

/**
 * Which part of the challan an ingredient belongs under. Checked in order:
 * an "Orange juice" is a mixer, a "Monin Orange Syrup" is a syrup.
 */
const SECTIONS: Array<{ title: string; test: RegExp }> = [
  { title: "Spirits / liquor", test: /\b(gin|vodka|whisk|rum|tequila|brandy|bourbon|scotch|rye|vermouth|campari|liqueur|schnapps|absinthe|prosecco|champagne|wine|lillet|drambuie|galliano|triple sec|curacao|aperol|bitters?\b.*liqueur)\b/i },
  { title: "Syrup", test: /\b(syrup|sauce|bitters|worcestershire|tabasco|foamer|coffee powder|puree|cordial|grenadine)\b/i },
  { title: "Mixers", test: /\b(soda|tonic|cola|coke|pepsi|sprite|fanta|ginger ale|ginger beer|lemonade|juice|water|red bull|energy|perrier|milk|cream|espresso|coffee|tea|club soda)\b/i },
  { title: "Fresh ingredients / garnish", test: /.*/ },
];

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The "out" column: a whole, carryable amount with its unit. */
function outAmount(qty: number, unit: string): string {
  const u = unit.trim().toLowerCase();
  const withBuffer = qty * BUFFER;
  if (u === "ml") {
    if (withBuffer >= 1000) return `${round1(Math.ceil(withBuffer / 100) / 10)} L`;
    return `${Math.ceil(withBuffer)} ml`;
  }
  if (u === "as needed") return "as needed";
  const n = Math.ceil(withBuffer);
  return `${n.toLocaleString("en-IN")} ${unit.trim()}`;
}

@Injectable()
export class RequirementSheetService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The drinks side of the challan, from the cocktails and serving counts the
   * Requirements screen was showing — same amounts, same 10% buffer.
   */
  private async drinkSections(user: RequestUser, menu: RequirementSheetRequest["menu"]): Promise<SheetSection[]> {
    const ids = [...new Set(menu.map((m) => m.recipeId))];
    const recipes = await this.prisma.client.recipe.findMany({
      where: { id: { in: ids }, workspaceId: user.workspaceId, deletedAt: null },
      include: { items: { include: { item: true }, orderBy: { position: "asc" } } },
    });
    if (recipes.length !== ids.length) throw new BadRequestException("One or more cocktails could not be found.");
    const servesOf = new Map(menu.map((m) => [m.recipeId, Math.max(0, Math.round(m.serves))]));

    // ingredient + unit -> total for the whole event
    const totals = new Map<string, { name: string; unit: string; qty: number | null }>();
    for (const r of recipes) {
      const serves = servesOf.get(r.id) ?? 0;
      if (!serves) continue;
      for (const i of r.items) {
        const name = (i.ingredient || i.item?.name || "Ingredient").trim();
        const unit = (i.unit || "ml").trim();
        const key = `${name.toLowerCase()}|${unit.toLowerCase()}`;
        const qty = i.qty === null ? null : Number(i.qty) * serves;
        const cur = totals.get(key);
        if (!cur) totals.set(key, { name, unit, qty });
        else if (qty !== null) cur.qty = (cur.qty ?? 0) + qty;
      }
    }

    const grouped = new Map<string, Array<{ name: string; out: string }>>();
    for (const t of [...totals.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const section = SECTIONS.find((s) => s.test.test(t.name))!.title;
      const out = t.qty === null ? "as needed" : outAmount(t.qty, t.unit);
      grouped.set(section, [...(grouped.get(section) ?? []), { name: t.name, out }]);
    }
    return SECTIONS.map((s) => ({ title: s.title, lines: grouped.get(s.title) ?? [] })).filter((s) => s.lines.length > 0);
  }

  async build(user: RequestUser, input: RequirementSheetRequest): Promise<{ buffer: Buffer; filename: string }> {
    const project = input.projectId
      ? await this.prisma.client.project.findFirst({
          where: { id: input.projectId, workspaceId: user.workspaceId, deletedAt: null },
          include: { city: { select: { name: true } }, client: { select: { name: true } } },
        })
      : null;

    const when = input.eventDate ?? project?.eventDate?.toISOString().slice(0, 10) ?? new Date().toISOString().slice(0, 10);
    const [y, m, d] = when.split("-");
    const eventName = input.eventName?.trim() || project?.name || project?.client.name || "Event";
    const drinks = await this.drinkSections(user, input.menu);

    const buffer = await buildRequirementSheet({
      eventName,
      eventDate: d && m && y ? `${d}/${m}/${y}` : when,
      address: input.address?.trim() || project?.name || "",
      pax: input.pax,
      to: input.to?.trim() || project?.city.name || "",
      from: input.from?.trim() || "",
      drinks,
      kit: standardKit(input.pax),
      hookah: input.hookah?.trim() || null,
      staffing: input.staffing?.trim() || null,
      inclusions: input.inclusions?.trim() || null,
    });

    const safe = `Challan ${eventName} ${when}`.replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    return { buffer, filename: `${safe}.xlsx` };
  }
}

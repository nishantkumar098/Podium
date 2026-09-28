import { Injectable, NotFoundException } from "@nestjs/common";
import type { CreateRiskInput, UpdateRiskInput } from "@podium/shared-types";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { recomputeProjectHealth } from "../common/project-health";
import type { RequestUser } from "../common/types";

const RISK_INCLUDE = {
  project: { select: { id: true, name: true, cityId: true } },
  owner: { select: { id: true, name: true } },
} as const;

@Injectable()
export class RisksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
  ) {}

  async list(user: RequestUser, projectId?: string, cityId?: string) {
    const scope = this.cityScope.scopeFilter(user, cityId);
    return this.prisma.client.risk.findMany({
      where: { deletedAt: null, ...(projectId ? { projectId } : {}), project: { workspaceId: user.workspaceId, ...scope } },
      include: RISK_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
  }

  async create(user: RequestUser, input: CreateRiskInput) {
    const project = await this.prisma.client.project.findFirst({ where: { id: input.projectId, workspaceId: user.workspaceId } });
    if (!project) throw new NotFoundException("Project not found.");
    this.cityScope.assertCanAccessCity(user, project.cityId);
    const risk = await this.prisma.client.risk.create({ data: { ...input, status: "OPEN" }, include: RISK_INCLUDE });
    await recomputeProjectHealth(this.prisma.client, project.id);
    return risk;
  }

  async update(user: RequestUser, id: string, input: UpdateRiskInput) {
    const risk = await this.prisma.client.risk.findFirst({ where: { id, deletedAt: null }, include: { project: true } });
    if (!risk || risk.project.workspaceId !== user.workspaceId) throw new NotFoundException("Risk not found.");
    this.cityScope.assertCanAccessCity(user, risk.project.cityId);
    const updated = await this.prisma.client.risk.update({ where: { id: risk.id }, data: input, include: RISK_INCLUDE });
    await recomputeProjectHealth(this.prisma.client, risk.projectId);
    return updated;
  }
}

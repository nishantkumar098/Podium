import { Injectable, NotFoundException } from "@nestjs/common";
import type { CreatePlaybookInput, UpdatePlaybookInput } from "@podium/shared-types";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";

/**
 * Playbooks (blueprint §19): reusable event-type templates. Not city-scoped —
 * a playbook is a workspace-level template, like a flow template, not a
 * per-project record — so this mirrors VendorsService's shape minus city
 * checks, not FlowsService/BudgetsService's project-scoped ones.
 */
@Injectable()
export class PlaybooksService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: RequestUser) {
    return this.prisma.client.playbook.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null },
      orderBy: { name: "asc" },
    });
  }

  async get(user: RequestUser, id: string) {
    const playbook = await this.prisma.client.playbook.findFirst({
      where: { id, workspaceId: user.workspaceId, deletedAt: null },
    });
    if (!playbook) throw new NotFoundException("Playbook not found.");
    return playbook;
  }

  async create(user: RequestUser, input: CreatePlaybookInput) {
    await this.assertFlowTemplatesExist(user, input.defaultFlowTemplateIds);
    return this.prisma.client.playbook.create({
      data: {
        workspaceId: user.workspaceId,
        name: input.name,
        eventType: input.eventType,
        defaultStages: input.defaultStages,
        defaultTasks: input.defaultTasks,
        defaultFlowTemplateIds: input.defaultFlowTemplateIds,
        createdById: user.id,
        updatedById: user.id,
      },
    });
  }

  async update(user: RequestUser, id: string, input: UpdatePlaybookInput) {
    const existing = await this.get(user, id);
    if (input.defaultFlowTemplateIds) await this.assertFlowTemplatesExist(user, input.defaultFlowTemplateIds);
    return this.prisma.client.playbook.update({
      where: { id: existing.id },
      data: { ...input, updatedById: user.id },
    });
  }

  async remove(user: RequestUser, id: string) {
    const existing = await this.get(user, id);
    return this.prisma.client.playbook.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
  }

  private async assertFlowTemplatesExist(user: RequestUser, ids: string[]) {
    if (ids.length === 0) return;
    const found = await this.prisma.client.flowTemplate.count({
      where: { id: { in: ids }, workspaceId: user.workspaceId, deletedAt: null },
    });
    if (found !== new Set(ids).size) {
      throw new NotFoundException("One or more flow templates in defaultFlowTemplateIds do not exist in this workspace.");
    }
  }
}

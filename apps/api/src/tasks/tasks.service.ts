import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { CreateTaskInput, UpdateTaskInput } from "@podium/shared-types";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { AccessScopeService } from "../common/rbac/access-scope.service";
import { recomputeProjectHealth } from "../common/project-health";
import type { RequestUser } from "../common/types";

const TASK_INCLUDE = {
  project: { select: { id: true, name: true, cityId: true } },
  owner: { select: { id: true, name: true } },
} as const;

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
    private readonly accessScope: AccessScopeService,
  ) {}

  async list(user: RequestUser, projectId?: string, cityId?: string) {
    if (projectId) {
      const project = await this.prisma.client.project.findFirst({ where: { id: projectId, workspaceId: user.workspaceId } });
      if (!project) throw new NotFoundException("Project not found.");
      this.cityScope.assertCanAccessCity(user, project.cityId);
      await this.accessScope.assertProject(user, projectId, this.prisma.client);
      // Within an event they may reach, they still only see the tasks that
      // are theirs or their department's — a supporting team gets its own
      // task, not the whole board.
      return this.prisma.client.task.findMany({
        where: { AND: [{ projectId }, this.accessScope.taskWhere(user)] },
        include: TASK_INCLUDE,
        orderBy: { createdAt: "desc" },
      });
    }
    return this.prisma.client.task.findMany({
      where: this.accessScope.taskWhere(user, cityId),
      include: TASK_INCLUDE,
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
    });
  }

  async create(user: RequestUser, input: CreateTaskInput) {
    const project = await this.prisma.client.project.findFirst({ where: { id: input.projectId, workspaceId: user.workspaceId } });
    if (!project) throw new NotFoundException("Project not found.");
    this.cityScope.assertCanAccessCity(user, project.cityId);
    await this.accessScope.assertProject(user, project.id, this.prisma.client);
    const task = await this.prisma.client.task.create({
      // A task with no department of its own belongs to whoever raises it,
      // which is what makes "Operations raises a Sales task" expressible:
      // set primaryDeptId to Sales and only Sales (plus the event's own
      // people) reaches it.
      data: { ...input, primaryDeptId: user.departmentId, status: "BACKLOG", createdById: user.id, updatedById: user.id },
      include: TASK_INCLUDE,
    });
    await recomputeProjectHealth(this.prisma.client, project.id);
    return task;
  }

  async update(user: RequestUser, id: string, input: UpdateTaskInput) {
    const task = await this.prisma.client.task.findFirst({
      where: { AND: [{ id }, this.accessScope.taskWhere(user)] },
      include: { project: true },
    });
    if (!task || task.project.workspaceId !== user.workspaceId) throw new NotFoundException("Task not found.");
    this.cityScope.assertCanAccessCity(user, task.project.cityId);

    // Optimistic concurrency: kanban drag-and-drop from a stale client should
    // not silently clobber a status change made by someone else in between.
    if (input.expectedUpdatedAt && input.expectedUpdatedAt.getTime() !== task.updatedAt.getTime()) {
      throw new ConflictException("This task changed since you last loaded it. Refresh and try again.");
    }
    const { expectedUpdatedAt: _ignored, ...rest } = input;
    const updated = await this.prisma.client.task.update({
      where: { id: task.id },
      data: { ...rest, updatedById: user.id },
      include: TASK_INCLUDE,
    });
    await recomputeProjectHealth(this.prisma.client, task.projectId);
    return updated;
  }
}

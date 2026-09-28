import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { createTaskSchema, updateTaskSchema } from "@podium/shared-types";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { TasksService } from "./tasks.service";

@Controller("tasks")
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @RequirePermissions("tasks:view")
  list(@CurrentUser() user: RequestUser, @Query("projectId") projectId?: string, @Query("cityId") cityId?: string) {
    return this.tasks.list(user, projectId, cityId || undefined);
  }

  @Post()
  @RequirePermissions("tasks:create")
  @Audit("task", "task.create")
  create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createTaskSchema)) body: ReturnType<typeof createTaskSchema.parse>) {
    return this.tasks.create(user, body);
  }

  @Patch(":id")
  @RequirePermissions("tasks:edit")
  @Audit("task", "task.update")
  update(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(updateTaskSchema)) body: ReturnType<typeof updateTaskSchema.parse>) {
    return this.tasks.update(user, id, body);
  }
}

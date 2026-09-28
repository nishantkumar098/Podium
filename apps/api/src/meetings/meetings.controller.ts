import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { MeetingsService } from "./meetings.service";

const meetingSchema = z.object({
  title: z.string().trim().min(1).max(200),
  startsAt: z.coerce.date(),
  durationMinutes: z.number().int().min(5).max(24 * 60),
  projectId: z.string().uuid().nullish(),
  meetLink: z.string().max(300).nullish(),
  notes: z.string().max(20_000).nullish(),
  createMeetLink: z.boolean().optional(),
});
const actionItemSchema = z.object({ text: z.string().trim().min(1).max(500), ownerId: z.string().uuid() });
const promoteSchema = z.object({ projectId: z.string().uuid().optional(), dueAt: z.coerce.date().optional() });

/**
 * Meetings are operational work, so they use the task permissions every
 * operational role already holds: tasks:view to see them, tasks:edit to
 * schedule and minute them.
 */
@Controller()
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  @Get("meetings")
  @RequirePermissions("tasks:view")
  list(@CurrentUser() user: RequestUser, @Query("from") from?: string, @Query("to") to?: string, @Query("projectId") projectId?: string) {
    return this.meetings.list(user, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      projectId: projectId || undefined,
    });
  }

  @Post("meetings")
  @RequirePermissions("tasks:edit")
  create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(meetingSchema)) body: z.infer<typeof meetingSchema>) {
    return this.meetings.create(user, body);
  }

  @Patch("meetings/:id")
  @RequirePermissions("tasks:edit")
  update(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(meetingSchema.partial())) body: Partial<z.infer<typeof meetingSchema>>) {
    return this.meetings.update(user, id, body);
  }

  @Delete("meetings/:id")
  @RequirePermissions("tasks:edit")
  remove(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.meetings.remove(user, id);
  }

  @Post("meetings/:id/action-items")
  @RequirePermissions("tasks:edit")
  addItem(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(actionItemSchema)) body: z.infer<typeof actionItemSchema>) {
    return this.meetings.addActionItem(user, id, body.text, body.ownerId);
  }

  @Post("meeting-action-items/:id/promote")
  @RequirePermissions("tasks:create")
  promote(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(promoteSchema)) body: z.infer<typeof promoteSchema>) {
    return this.meetings.promote(user, id, body);
  }
}

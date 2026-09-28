import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import {
  addRunsheetItemSchema,
  checkInSchema,
  createIncidentSchema,
  createRunsheetSchema,
  setRunsheetItemDoneSchema,
} from "@podium/shared-types";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { EventDayService } from "./eventday.service";

@Controller()
export class EventDayController {
  constructor(private readonly eventDay: EventDayService) {}

  // ---------------------------------------------------------- runsheet
  @Get("projects/:projectId/runsheet")
  @RequirePermissions("tasks:view")
  getRunsheet(@CurrentUser() user: RequestUser, @Param("projectId") projectId: string) {
    return this.eventDay.getRunsheet(user, projectId);
  }

  @Post("projects/:projectId/runsheet")
  @RequirePermissions("projects:edit")
  @Audit("runsheet", "runsheet.create")
  createRunsheet(
    @CurrentUser() user: RequestUser,
    @Param("projectId") projectId: string,
    @Body(new ZodValidationPipe(createRunsheetSchema)) body: ReturnType<typeof createRunsheetSchema.parse>,
  ) {
    return this.eventDay.createRunsheet(user, projectId, body);
  }

  @Post("runsheets/:id/items")
  @RequirePermissions("projects:edit")
  @Audit("runsheet_item", "runsheet_item.create")
  addItem(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(addRunsheetItemSchema)) body: ReturnType<typeof addRunsheetItemSchema.parse>,
  ) {
    return this.eventDay.addRunsheetItem(user, id, body);
  }

  /**
   * Ticking a cue is gated on tasks:edit (every operational role has it); the
   * service then enforces owner-or-PM-or-manager at the row level.
   */
  @Patch("runsheet-items/:id/done")
  @RequirePermissions("tasks:edit")
  @Audit("runsheet_item", "runsheet_item.done")
  setDone(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(setRunsheetItemDoneSchema)) body: ReturnType<typeof setRunsheetItemDoneSchema.parse>,
  ) {
    return this.eventDay.setRunsheetItemDone(user, id, body.done);
  }

  // ---------------------------------------------------------- check-in
  @Get("projects/:projectId/checkins")
  @RequirePermissions("tasks:view")
  listCheckins(@CurrentUser() user: RequestUser, @Param("projectId") projectId: string) {
    return this.eventDay.listCheckins(user, projectId);
  }

  @Post("projects/:projectId/checkins")
  @RequirePermissions("tasks:view")
  @Audit("event_day_checkin", "event_day.checkin")
  checkIn(
    @CurrentUser() user: RequestUser,
    @Param("projectId") projectId: string,
    @Body(new ZodValidationPipe(checkInSchema)) body: ReturnType<typeof checkInSchema.parse>,
  ) {
    return this.eventDay.checkIn(user, projectId, body);
  }

  // --------------------------------------------------------- incidents
  @Get("projects/:projectId/incidents")
  @RequirePermissions("tasks:view")
  listIncidents(@CurrentUser() user: RequestUser, @Param("projectId") projectId: string) {
    return this.eventDay.listIncidents(user, projectId);
  }

  @Post("projects/:projectId/incidents")
  @RequirePermissions("tasks:edit")
  @Audit("event_day_incident", "event_day.incident_logged")
  createIncident(
    @CurrentUser() user: RequestUser,
    @Param("projectId") projectId: string,
    @Body(new ZodValidationPipe(createIncidentSchema)) body: ReturnType<typeof createIncidentSchema.parse>,
  ) {
    return this.eventDay.createIncident(user, projectId, body);
  }
}

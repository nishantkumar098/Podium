import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { convertLeadSchema, createLeadSchema, updateLeadStageSchema } from "@podium/shared-types";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { LeadsService } from "./leads.service";

const LEAD_STAGES = ["LEAD", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "WON", "LOST"] as const;

@Controller("leads")
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  @RequirePermissions("leads:view")
  list(
    @CurrentUser() user: RequestUser,
    @Query("cityId") cityId?: string,
    @Query("kind") kind?: string,
    @Query("stage") stage?: string,
    @Query("sourceSheet") sourceSheet?: string,
    @Query("search") search?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.leads.list(user, {
      cityId,
      kind: kind === "COLD_PROSPECT" ? "COLD_PROSPECT" : kind === "PIPELINE" ? "PIPELINE" : undefined,
      stage: LEAD_STAGES.find((s) => s === stage),
      sourceSheet,
      search,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get(":id")
  @RequirePermissions("leads:view")
  get(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.leads.get(user, id);
  }

  @Post()
  @RequirePermissions("leads:create")
  @Audit("lead", "lead.create")
  create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createLeadSchema)) body: ReturnType<typeof createLeadSchema.parse>) {
    return this.leads.create(user, body);
  }

  @Patch(":id/stage")
  @RequirePermissions("leads:edit")
  @Audit("lead", "lead.stage_changed")
  updateStage(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(updateLeadStageSchema)) body: ReturnType<typeof updateLeadStageSchema.parse>) {
    return this.leads.updateStage(user, id, body.stage);
  }

  /**
   * Marks a lead Won and lets the automation engine decide whether a project
   * can be created from it. Returns the engine's outcome so a BLOCKED result —
   * "this lead has no event date" — is visible to the caller rather than silent.
   */
  @Post(":id/mark-won")
  @RequirePermissions("leads:edit")
  @Audit("lead", "lead.marked_won")
  markWon(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.leads.markWon(user, id);
  }

  @Post(":id/convert")
  @RequirePermissions("leads:edit", "projects:create")
  @Audit("lead", "lead.won_converted")
  convert(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(convertLeadSchema)) body: ReturnType<typeof convertLeadSchema.parse>) {
    return this.leads.convert(user, id, body);
  }
}

import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import {
  advanceLicenceSchema,
  createApprovalSchema,
  createLicenceSchema,
  createRiskSchema,
  decideApprovalSchema,
  updateRiskSchema,
} from "@podium/shared-types";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { ApprovalsService } from "./approvals.service";
import { LicencesService } from "./licences.service";
import { RisksService } from "./risks.service";

@Controller("risks")
export class RisksController {
  constructor(private readonly risks: RisksService) {}

  @Get()
  @RequirePermissions("risks:view")
  list(@CurrentUser() user: RequestUser, @Query("projectId") projectId?: string, @Query("cityId") cityId?: string) {
    return this.risks.list(user, projectId, cityId || undefined);
  }

  @Post()
  @RequirePermissions("risks:create")
  @Audit("risk", "risk.create")
  create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createRiskSchema)) body: ReturnType<typeof createRiskSchema.parse>) {
    return this.risks.create(user, body);
  }

  @Patch(":id")
  @RequirePermissions("risks:edit")
  @Audit("risk", "risk.update")
  update(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(updateRiskSchema)) body: ReturnType<typeof updateRiskSchema.parse>) {
    return this.risks.update(user, id, body);
  }
}

@Controller("approvals")
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequirePermissions("approvals:view")
  list(@CurrentUser() user: RequestUser, @Query("projectId") projectId?: string) {
    return this.approvals.list(user, projectId);
  }

  @Post()
  @RequirePermissions("approvals:create")
  @Audit("approval", "approval.create")
  create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createApprovalSchema)) body: ReturnType<typeof createApprovalSchema.parse>) {
    return this.approvals.create(user, body);
  }

  /**
   * Audited inside the service transaction (Phase B.1) — see
   * ApprovalsService.decide() for why a second @Audit() row here would only
   * duplicate that one.
   */
  @Post(":id/decide")
  @RequirePermissions("approvals:approve")
  decide(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(decideApprovalSchema)) body: ReturnType<typeof decideApprovalSchema.parse>) {
    return this.approvals.decide(user, id, body);
  }
}

@Controller("licences")
export class LicencesController {
  constructor(private readonly licences: LicencesService) {}

  @Get()
  @RequirePermissions("licences:view")
  list(@CurrentUser() user: RequestUser, @Query("cityId") cityId?: string) {
    return this.licences.list(user, cityId);
  }

  @Post()
  @RequirePermissions("licences:create")
  @Audit("licence", "licence.create")
  create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createLicenceSchema)) body: ReturnType<typeof createLicenceSchema.parse>) {
    return this.licences.create(user, body);
  }

  @Post(":id/advance")
  @RequirePermissions("licences:edit")
  @Audit("licence", "licence.advance")
  advance(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(advanceLicenceSchema)) body: ReturnType<typeof advanceLicenceSchema.parse>) {
    return this.licences.advance(user, id, body);
  }
}

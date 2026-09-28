import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query } from "@nestjs/common";
import { toggleAutomationRuleSchema } from "@podium/shared-types";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { AutomationScheduler } from "./automation.scheduler";
import { AutomationService } from "./automation.service";

@Controller("automation")
export class AutomationController {
  constructor(
    private readonly automation: AutomationService,
    private readonly scheduler: AutomationScheduler,
  ) {}

  /** The rule list + on/off state (blueprint §12/screen 30) — name, trigger, actions, isEnabled. */
  @Get("rules")
  @RequirePermissions("automation:view")
  rules(@CurrentUser() user: RequestUser) {
    return this.automation.listRules(user.workspaceId);
  }

  @Patch("rules/:id")
  @RequirePermissions("automation:edit")
  @Audit("automation_rule", "automation_rule.toggled")
  async toggleRule(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(toggleAutomationRuleSchema)) body: ReturnType<typeof toggleAutomationRuleSchema.parse>,
  ) {
    const updated = await this.automation.setRuleEnabled(user.workspaceId, id, body.isEnabled);
    if (!updated) throw new NotFoundException("Automation rule not found.");
    return updated;
  }

  /** The run log — success, blocked and failed, with the reason. */
  @Get("runs")
  @RequirePermissions("automation:view")
  runs(@CurrentUser() user: RequestUser, @Query("limit") limit?: string) {
    return this.automation.runsFor(user.workspaceId, limit ? Number(limit) : undefined);
  }

  @Get("triggers")
  @RequirePermissions("automation:view")
  triggers() {
    return { registered: this.automation.registeredTriggers() };
  }

  /**
   * Runs the time/threshold sweep now. Same code path the cron uses, so a
   * manual run and a scheduled one cannot diverge.
   */
  @Post("sweep")
  @RequirePermissions("automation:edit")
  sweep(@CurrentUser() user: RequestUser) {
    return this.scheduler.sweepWorkspace(user.workspaceId);
  }
}

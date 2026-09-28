import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { completeStepSchema, instantiateFlowSchema, reassignStepSchema } from "@podium/shared-types";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { FlowSlaService } from "./flow-sla.service";
import { FlowsService } from "./flows.service";

@Controller()
export class FlowsController {
  constructor(
    private readonly flows: FlowsService,
    private readonly flowSla: FlowSlaService,
  ) {}

  @Get("flow-templates")
  @RequirePermissions("flows:view")
  listTemplates(@CurrentUser() user: RequestUser) {
    return this.flows.listTemplates(user);
  }

  @Get("flow-instances")
  @RequirePermissions("flows:view")
  listInstances(@CurrentUser() user: RequestUser, @Query("projectId") projectId?: string) {
    return this.flows.listInstances(user, projectId);
  }

  @Get("flow-instances/:id")
  @RequirePermissions("flows:view")
  getInstance(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.flows.getInstance(user, id);
  }

  @Get("flows/my-queue")
  @RequirePermissions("flows:view")
  myQueue(@CurrentUser() user: RequestUser) {
    return this.flows.myQueue(user);
  }

  @Post("flow-instances")
  @RequirePermissions("flows:create")
  @Audit("flow_instance", "flow.instantiate")
  instantiate(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(instantiateFlowSchema)) body: ReturnType<typeof instantiateFlowSchema.parse>) {
    return this.flows.instantiate(user, body);
  }

  @Post("flow-steps/:id/start")
  @RequirePermissions("flows:view")
  @Audit("flow_step", "flow_step.start")
  startStep(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.flows.startStep(user, id);
  }

  @Post("flow-steps/:id/complete")
  @RequirePermissions("flows:view")
  @Audit("flow_step", "flow_step.complete")
  completeStep(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(completeStepSchema)) body: ReturnType<typeof completeStepSchema.parse>) {
    return this.flows.completeStep(user, id, body.note);
  }

  @Post("flow-steps/:id/reassign")
  @RequirePermissions("flows:edit")
  @Audit("flow_step", "flow_step.reassign")
  reassignStep(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(reassignStepSchema)) body: ReturnType<typeof reassignStepSchema.parse>) {
    return this.flows.reassignStep(user, id, body.newOwnerId);
  }

  @Post("flow-steps/:id/nudge")
  @RequirePermissions("flows:view")
  nudgeStep(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.flows.nudgeStep(user, id);
  }

  /**
   * Runs the same SLA-breach sweep the one-minute cron runs, on demand.
   * Gated on `automation:edit` (Founder/Admin only) — this is an
   * operational trigger for the system's own scheduled job, not a normal
   * flow action, and city-scope doesn't apply to it since it sweeps every
   * workspace-wide breach in one pass. Exists both for ops visibility
   * ("did the sweep actually run today") and so tests don't have to wait
   * on a real minute of wall-clock time to verify escalation.
   */
  @Post("flows/sla-check")
  @RequirePermissions("automation:edit")
  runSlaCheck() {
    return this.flowSla.checkSlaBreaches();
  }
}

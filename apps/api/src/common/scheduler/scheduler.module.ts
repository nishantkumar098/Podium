import { Module, type DynamicModule } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AutomationModule } from "../../automation/automation.module";
import { FlowsModule } from "../../flows/flows.module";
import { InvoicesModule } from "../../invoices/invoices.module";
import { INLINE_SCHEDULER_ENABLED, InlineSchedulerService } from "./inline-scheduler.service";

/**
 * Registers the in-process sweeps — but only when this deployment has no
 * Redis worker to run them (PODIUM_INLINE_SCHEDULER=1).
 *
 * `forRoot()` returning an empty module rather than the module being
 * conditionally listed in AppModule's imports is deliberate: the decision is
 * then stated once, here, next to the service whose doc comment explains
 * why it exists, instead of as an inline ternary in a 50-line import list
 * where nobody would find it.
 */
@Module({})
export class SchedulerModule {
  static forRoot(): DynamicModule {
    if (!INLINE_SCHEDULER_ENABLED) return { module: SchedulerModule };
    return {
      module: SchedulerModule,
      imports: [ScheduleModule.forRoot(), InvoicesModule, FlowsModule, AutomationModule],
      providers: [InlineSchedulerService],
    };
  }
}

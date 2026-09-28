import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { FlowsModule } from "../flows/flows.module";
import { LeadIntakeController } from "./lead-intake.controller";
import { LeadIntakeService } from "./lead-intake.service";
import { LeadsController } from "./leads.controller";
import { LeadsService } from "./leads.service";

@Module({
  imports: [AutomationModule, FlowsModule],
  // Intake first: its route is /leads/intake, and Nest matches in order, so
  // it must be registered before LeadsController's /leads/:id.
  controllers: [LeadIntakeController, LeadsController],
  providers: [LeadsService, LeadIntakeService],
})
export class CrmModule {}

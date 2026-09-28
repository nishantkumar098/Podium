import { Module } from "@nestjs/common";
import { ApprovalsController, LicencesController, RisksController } from "./governance.controller";
import { ApprovalsService } from "./approvals.service";
import { LicencesService } from "./licences.service";
import { RisksService } from "./risks.service";

@Module({
  controllers: [RisksController, ApprovalsController, LicencesController],
  providers: [RisksService, ApprovalsService, LicencesService],
})
export class GovernanceModule {}

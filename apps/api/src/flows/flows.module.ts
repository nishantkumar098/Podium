import { Module } from "@nestjs/common";
import { FlowSlaService } from "./flow-sla.service";
import { FlowsController } from "./flows.controller";
import { FlowsService } from "./flows.service";

@Module({
  controllers: [FlowsController],
  providers: [FlowsService, FlowSlaService],
  exports: [FlowsService, FlowSlaService],
})
export class FlowsModule {}

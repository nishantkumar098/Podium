import { Module } from "@nestjs/common";
import { EventDayController } from "./eventday.controller";
import { EventDayService } from "./eventday.service";

@Module({
  controllers: [EventDayController],
  providers: [EventDayService],
})
export class EventDayModule {}

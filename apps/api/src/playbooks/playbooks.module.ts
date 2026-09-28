import { Module } from "@nestjs/common";
import { PlaybooksController } from "./playbooks.controller";
import { PlaybooksService } from "./playbooks.service";

@Module({
  controllers: [PlaybooksController],
  providers: [PlaybooksService],
  exports: [PlaybooksService],
})
export class PlaybooksModule {}

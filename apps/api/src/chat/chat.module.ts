import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";

@Module({
  imports: [AutomationModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}

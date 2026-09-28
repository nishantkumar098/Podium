import { Module } from "@nestjs/common";
import { DocumentsModule } from "../documents/documents.module";
import { LettersController } from "./letters.controller";
import { LettersService } from "./letters.service";

@Module({
  imports: [DocumentsModule],
  controllers: [LettersController],
  providers: [LettersService],
})
export class LettersModule {}

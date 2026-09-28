import { Module } from "@nestjs/common";
import { GoogleModule } from "../google/google.module";
import { MeetingsController } from "./meetings.controller";
import { MeetingsService } from "./meetings.service";

@Module({ imports: [GoogleModule], controllers: [MeetingsController], providers: [MeetingsService] })
export class MeetingsModule {}

import { Module } from "@nestjs/common";
import { GoogleModule } from "../google/google.module";
import { AuditService } from "./audit.service";
import { SettingsService } from "./settings.service";
import { SopsService } from "./sops.service";
import { SystemController } from "./system.controller";

@Module({ imports: [GoogleModule], controllers: [SystemController], providers: [SopsService, AuditService, SettingsService] })
export class SystemModule {}

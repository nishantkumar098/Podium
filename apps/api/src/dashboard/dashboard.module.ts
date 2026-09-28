import { Module } from "@nestjs/common";
import { GoogleModule } from "../google/google.module";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { SearchController } from "./search.controller";
import { SearchService } from "./search.service";

@Module({ imports: [GoogleModule], controllers: [DashboardController, SearchController], providers: [DashboardService, SearchService] })
export class DashboardModule {}

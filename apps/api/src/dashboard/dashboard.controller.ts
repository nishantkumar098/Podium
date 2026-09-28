import { BadRequestException, Body, Controller, Get, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { RequestUser } from "../common/types";
import { DashboardService } from "./dashboard.service";

@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /**
   * Home is everybody's first screen, so it carries no single permission:
   * each widget on it is chosen by what the caller holds (see
   * DashboardService.home, which gates every query individually). Requiring
   * projects:view here locked HR, Creative and every ordinary employee out
   * of the front page of the app.
   */
  @Get()
  home(@CurrentUser() user: RequestUser, @Query("cityId", new ParseUUIDPipe({ optional: true })) cityId?: string) {
    return this.dashboard.home(user, cityId);
  }

  /** Sidebar badge counts. Any signed-in user; each count is already scoped to them. */
  @Get("nav-counts")
  navCounts(@CurrentUser() user: RequestUser) {
    return this.dashboard.navCounts(user);
  }

  @Post("announcements")
  announce(@CurrentUser() user: RequestUser, @Body() body: { text?: unknown }) {
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) throw new BadRequestException("Write something to announce.");
    if (text.length > 1000) throw new BadRequestException("Keep announcements under 1,000 characters.");
    return this.dashboard.announce(user, text);
  }
}

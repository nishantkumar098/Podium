import { Controller, Get, Query } from "@nestjs/common";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { RequestUser } from "../common/types";
import { MeService } from "./me.service";

/** Person-centred views. Every section inside is gated on its own permission by the service. */
@Controller()
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get("me/work")
  work(@CurrentUser() user: RequestUser) {
    return this.me.work(user);
  }

  @Get("calendar")
  calendar(@CurrentUser() user: RequestUser, @Query("from") from?: string, @Query("to") to?: string, @Query("cityId") cityId?: string) {
    return this.me.calendar(user, from, to, cityId || undefined);
  }
}

import { Controller, Get, Query } from "@nestjs/common";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { RequestUser } from "../common/types";
import { SearchService } from "./search.service";

@Controller("search")
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  /** ⌘K search. Each record type is filtered by the caller's own permissions inside the service. */
  @Get()
  search(@CurrentUser() user: RequestUser, @Query("q") q = "", @Query("cityId") cityId?: string) {
    return this.searchService.search(user, q.slice(0, 100), cityId || undefined);
  }
}

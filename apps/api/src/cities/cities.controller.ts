import { Controller, Get } from "@nestjs/common";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";
import { allowedCityIds } from "../common/types";

@Controller("cities")
export class CitiesController {
  constructor(private readonly prisma: PrismaService) {}

  /** Cities the caller may act in — never the full workspace list unconditionally. */
  @Get()
  async list(@CurrentUser() user: RequestUser) {
    const allowed = allowedCityIds(user);
    const where = allowed === "ALL" ? { workspaceId: user.workspaceId } : { id: { in: allowed } };
    return this.prisma.client.city.findMany({ where, orderBy: { name: "asc" } });
  }
}

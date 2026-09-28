import { Delete, Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { createClientSchema, updateClientSchema } from "@podium/shared-types";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { ClientsService } from "./clients.service";

@Controller("clients")
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  @RequirePermissions("clients:view")
  list(
    @CurrentUser() user: RequestUser,
    @Query("cityId") cityId?: string,
    @Query("segment") segment?: string,
    @Query("search") search?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.clients.list(user, {
      cityId,
      segment: segment === "RETAIL_CUSTOMER" ? "RETAIL_CUSTOMER" : segment === "EVENT_CLIENT" ? "EVENT_CLIENT" : undefined,
      search,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get(":id")
  @RequirePermissions("clients:view")
  get(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.clients.get(user, id);
  }

  @Post()
  @RequirePermissions("clients:create")
  @Audit("client", "client.create")
  create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createClientSchema)) body: ReturnType<typeof createClientSchema.parse>) {
    return this.clients.create(user, body);
  }

  @Delete(":id")
  @RequirePermissions("clients:delete")
  @Audit("client", "client.delete")
  remove(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.clients.remove(user, id);
  }

  @Patch(":id")
  @RequirePermissions("clients:edit")
  @Audit("client", "client.update")
  update(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateClientSchema)) body: ReturnType<typeof updateClientSchema.parse>,
  ) {
    return this.clients.update(user, id, body);
  }
}

import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { createVendorSchema, updateVendorSchema } from "@podium/shared-types";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { VendorsService } from "./vendors.service";

@Controller("vendors")
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Get()
  @RequirePermissions("vendors:view")
  list(@CurrentUser() user: RequestUser, @Query("cityId") cityId?: string) {
    return this.vendors.list(user, cityId);
  }

  @Get(":id")
  @RequirePermissions("vendors:view")
  get(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.vendors.get(user, id);
  }

  @Post()
  @RequirePermissions("vendors:create")
  @Audit("vendor", "vendor.create")
  create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createVendorSchema)) body: ReturnType<typeof createVendorSchema.parse>) {
    return this.vendors.create(user, body);
  }

  @Patch(":id")
  @RequirePermissions("vendors:edit")
  @Audit("vendor", "vendor.update")
  update(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(updateVendorSchema)) body: ReturnType<typeof updateVendorSchema.parse>) {
    return this.vendors.update(user, id, body);
  }
}

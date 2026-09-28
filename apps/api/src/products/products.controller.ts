import { Controller, Get, Query } from "@nestjs/common";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import type { RequestUser } from "../common/types";
import { ProductsService } from "./products.service";

@Controller("products")
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @RequirePermissions("products:view")
  list(
    @CurrentUser() user: RequestUser,
    @Query("brand") brandCode?: string,
    @Query("category") category?: string,
    @Query("search") search?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.products.list(user, {
      brandCode,
      category,
      search,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get("brands")
  @RequirePermissions("products:view")
  brands(@CurrentUser() user: RequestUser) {
    return this.products.brands(user);
  }

  @Get("categories")
  @RequirePermissions("products:view")
  categories(@CurrentUser() user: RequestUser, @Query("brand") brandCode?: string) {
    return this.products.categories(user, brandCode);
  }
}

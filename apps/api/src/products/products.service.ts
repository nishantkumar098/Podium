import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";

export interface ProductQuery {
  brandCode?: string;
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * The sellable catalogue for both trading brands.
 *
 * Deliberately NOT city-scoped: a product is a price-list entry belonging to
 * a brand, not a thing that happens in a city, so CityScopeService has
 * nothing to filter on here. Workspace scoping is still enforced on every
 * query.
 */
@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: RequestUser, q: ProductQuery) {
    // Capped: The Cocktail Shop alone is 1,383 rows, and an uncapped list
    // endpoint would ship the whole catalogue on every page load.
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const offset = Math.max(q.offset ?? 0, 0);

    const where = {
      workspaceId: user.workspaceId,
      deletedAt: null,
      ...(q.brandCode ? { brand: { code: q.brandCode } } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: "insensitive" as const } },
              { sku: { contains: q.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.client.product.count({ where }),
      this.prisma.client.product.findMany({
        where,
        include: { brand: { select: { code: true, name: true } } },
        orderBy: [{ category: "asc" }, { name: "asc" }],
        take: limit,
        skip: offset,
      }),
    ]);
    return { total, limit, offset, rows };
  }

  /** Brands with their catalogue size, for the screen's filter chips. */
  async brands(user: RequestUser) {
    const brands = await this.prisma.client.brand.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null },
      orderBy: { name: "asc" },
    });
    const counts = await this.prisma.client.product.groupBy({
      by: ["brandId"],
      where: { workspaceId: user.workspaceId, deletedAt: null },
      _count: { _all: true },
    });
    return brands.map((b) => ({
      id: b.id,
      code: b.code,
      name: b.name,
      tagline: b.tagline,
      productCount: counts.find((c) => c.brandId === b.id)?._count._all ?? 0,
    }));
  }

  async categories(user: RequestUser, brandCode?: string) {
    const rows = await this.prisma.client.product.groupBy({
      by: ["category"],
      where: {
        workspaceId: user.workspaceId,
        deletedAt: null,
        ...(brandCode ? { brand: { code: brandCode } } : {}),
      },
      _count: { _all: true },
    });
    return rows
      .filter((r) => r.category)
      .map((r) => ({ category: r.category!, count: r._count._all }))
      .sort((a, b) => b.count - a.count);
  }
}

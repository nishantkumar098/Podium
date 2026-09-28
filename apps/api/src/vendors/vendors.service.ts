import { Injectable, NotFoundException } from "@nestjs/common";
import type { CreateVendorInput, UpdateVendorInput } from "@podium/shared-types";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { VENDOR_FIELD_POLICY, redact, redactAll } from "../common/rbac/field-policy";
import type { RequestUser } from "../common/types";

@Injectable()
export class VendorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
  ) {}

  /**
   * Vendors with how much work they carry: projects they are assigned to, and
   * the value of purchase orders sent to them but not yet fully received —
   * what Podium will owe them once goods arrive.
   */
  async list(user: RequestUser, cityId?: string) {
    const db = this.prisma.client;
    const scope = this.cityScope.scopeFilter(user, cityId);
    const [vendors, open] = await Promise.all([
      db.vendor.findMany({
        where: { workspaceId: user.workspaceId, deletedAt: null, ...scope },
        include: { city: { select: { name: true } }, _count: { select: { projectVendors: { where: { deletedAt: null } } } } },
        orderBy: { name: "asc" },
      }),
      db.purchaseOrder.groupBy({
        by: ["vendorId"],
        where: { deletedAt: null, status: { in: ["SENT", "PARTIALLY_RECEIVED"] }, vendor: { workspaceId: user.workspaceId } },
        _sum: { total: true },
      }),
    ]);
    const openBy = new Map(open.map((o) => [o.vendorId, o._sum.total?.toNumber() ?? 0]));
    // Operations must see that a vendor is approved and what they supply;
    // their bank details, running balance and payment schedule are money,
    // and follow the money rules. See field-policy.ts.
    return redactAll(
      user,
      VENDOR_FIELD_POLICY,
      vendors.map(({ _count, ...v }) => ({ ...v, projects: _count.projectVendors, openOrders: openBy.get(v.id) ?? 0 })) as unknown as Array<Record<string, unknown>>,
    );
  }

  async get(user: RequestUser, id: string) {
    const vendor = await this.prisma.client.vendor.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
    if (!vendor) throw new NotFoundException("Vendor not found.");
    this.cityScope.assertCanAccessCity(user, vendor.cityId);
    return redact(user, VENDOR_FIELD_POLICY, vendor as unknown as Record<string, unknown>);
  }

  /** The unredacted row, for the write paths that must read before they update. */
  private async getRaw(user: RequestUser, id: string) {
    const vendor = await this.prisma.client.vendor.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
    if (!vendor) throw new NotFoundException("Vendor not found.");
    this.cityScope.assertCanAccessCity(user, vendor.cityId);
    return vendor;
  }

  async create(user: RequestUser, input: CreateVendorInput) {
    this.cityScope.assertCanAccessCity(user, input.cityId ?? null);
    return this.prisma.client.vendor.create({ data: { ...input, workspaceId: user.workspaceId, createdById: user.id, updatedById: user.id } });
  }

  async update(user: RequestUser, id: string, input: UpdateVendorInput) {
    const existing = await this.getRaw(user, id);
    if (input.cityId) this.cityScope.assertCanAccessCity(user, input.cityId);
    return this.prisma.client.vendor.update({ where: { id: existing.id }, data: { ...input, updatedById: user.id } });
  }
}

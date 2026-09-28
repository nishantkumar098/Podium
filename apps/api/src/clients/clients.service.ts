import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { CreateClientInput, UpdateClientInput } from "@podium/shared-types";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

export interface ListClientsOptions {
  cityId?: string;
  segment?: "EVENT_CLIENT" | "RETAIL_CUSTOMER";
  search?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class ClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
  ) {}

  /**
   * Defaults to the EVENT_CLIENT segment. The Cocktail Shop retail dump is
   * ~100x larger than the real B2B client list, so an unfiltered list would
   * bury it — the caller must ask for RETAIL_CUSTOMER explicitly. Results are
   * paged because either segment is far too large to ship whole.
   */
  async list(user: RequestUser, opts: ListClientsOptions = {}) {
    const scope = this.cityScope.scopeFilter(user, opts.cityId);
    const take = Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const where = {
      workspaceId: user.workspaceId,
      deletedAt: null,
      segment: opts.segment ?? ("EVENT_CLIENT" as const),
      ...(opts.search ? { name: { contains: opts.search, mode: "insensitive" as const } } : {}),
      ...scope,
    };
    // In parallel, not a batch $transaction: that runs its queries one after
    // another on one connection plus BEGIN/COMMIT, each a ~320 ms trip to the
    // Sydney database. A list count need not be transactionally exact.
    const [total, rows] = await Promise.all([
      this.prisma.client.client.count({ where }),
      this.prisma.client.client.findMany({
        where,
        include: { city: true, contacts: true, _count: { select: { projects: { where: { deletedAt: null } } } } },
        orderBy: { name: "asc" },
        take,
        skip: opts.offset ?? 0,
      }),
    ]);
    return { total, limit: take, offset: opts.offset ?? 0, rows };
  }

  async get(user: RequestUser, id: string) {
    const client = await this.prisma.client.client.findFirst({
      where: { id, workspaceId: user.workspaceId, deletedAt: null },
      include: { city: true, contacts: true, projects: true },
    });
    if (!client) throw new NotFoundException("Client not found.");
    this.cityScope.assertCanAccessCity(user, client.cityId);
    return client;
  }

  async create(user: RequestUser, input: CreateClientInput) {
    this.cityScope.assertCanAccessCity(user, input.cityId);
    return this.prisma.client.client.create({
      data: { ...input, workspaceId: user.workspaceId, createdById: user.id, updatedById: user.id },
    });
  }

  async update(user: RequestUser, id: string, input: UpdateClientInput) {
    const existing = await this.get(user, id);
    if (input.cityId) this.cityScope.assertCanAccessCity(user, input.cityId);
    return this.prisma.client.client.update({
      where: { id: existing.id },
      data: { ...input, updatedById: user.id },
    });
  }

  /**
   * Removes a client from the list.
   *
   * SOFT, AND REFUSED WHERE IT WOULD BREAK SOMETHING.
   *
   * The row is flagged rather than erased, because a client is pointed at by
   * projects, invoices, leads and the audit log. Erasing it would leave an
   * invoice whose customer no longer exists — which is a bookkeeping problem
   * as much as a software one, since an issued GST invoice must keep naming
   * a real party.
   *
   * And it is refused outright while live projects or invoices exist. The
   * alternative — hiding the client while its invoices remain — produces a
   * Projects screen listing work for a client nobody can open, which reads
   * as a bug and gets reported as one. Better to say plainly what is in the
   * way and let somebody decide.
   */
  async remove(user: RequestUser, id: string) {
    const existing = await this.get(user, id);
    const db = this.prisma.client;
    const [projects, invoices] = await Promise.all([
      db.project.count({ where: { clientId: existing.id, deletedAt: null } }),
      db.invoice.count({ where: { clientId: existing.id, deletedAt: null } }),
    ]);
    if (projects > 0 || invoices > 0) {
      const blockers = [
        projects > 0 ? `${projects} project${projects === 1 ? "" : "s"}` : null,
        invoices > 0 ? `${invoices} invoice${invoices === 1 ? "" : "s"}` : null,
      ]
        .filter(Boolean)
        .join(" and ");
      throw new ConflictException(`${existing.name} still has ${blockers}. Remove or reassign those first.`);
    }

    await db.client.update({ where: { id: existing.id }, data: { deletedAt: new Date(), updatedById: user.id } });
    await db.auditLog.create({
      data: {
        workspaceId: user.workspaceId,
        actorId: user.id,
        action: "client.deleted",
        entityType: "client",
        entityId: existing.id,
        after: { name: existing.name, city: existing.city?.name ?? null },
      },
    });
    return { ok: true as const, name: existing.name };
  }
}

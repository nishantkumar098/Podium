import { Injectable } from "@nestjs/common";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";

export interface SearchHit {
  kind: "project" | "client" | "lead" | "invoice" | "vendor" | "stock" | "person" | "flow" | "document";
  id: string;
  title: string;
  sub: string;
  href: string;
}

const PER_KIND = 5;

/**
 * The ⌘K search. One request fans out to every record type the person may
 * see (each gated on the same permission as the screen it links to, and
 * city-scoped like that screen), all queries in parallel.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
  ) {}

  async search(user: RequestUser, rawQuery: string, cityId?: string): Promise<SearchHit[]> {
    const q = rawQuery.trim();
    if (q.length < 2) return [];
    const db = this.prisma.client;
    const ws = user.workspaceId;
    const can = (p: string) => user.permissions.has(p);
    const scope = this.cityScope.scopeFilter(user, cityId);
    const has = { contains: q, mode: "insensitive" as const };
    const none = Promise.resolve([] as SearchHit[]);

    const groups = await Promise.all([
      can("projects:view")
        ? db.project
            .findMany({
              where: { workspaceId: ws, deletedAt: null, ...scope, OR: [{ name: has }, { type: has }] },
              select: { id: true, name: true, type: true, eventDate: true, city: { select: { name: true } } },
              orderBy: { eventDate: "desc" },
              take: PER_KIND,
            })
            .then((rows) =>
              rows.map((r) => ({
                kind: "project" as const,
                id: r.id,
                title: r.name,
                sub: `${r.type} · ${r.city.name} · ${r.eventDate.toISOString().slice(0, 10)}`,
                href: `/projects/${r.id}`,
              })),
            )
        : none,
      can("clients:view")
        ? db.client
            .findMany({
              where: { workspaceId: ws, deletedAt: null, ...scope, OR: [{ name: has }, { phone: has }, { email: has }] },
              select: { id: true, name: true, phone: true, city: { select: { name: true } } },
              take: PER_KIND,
            })
            .then((rows) =>
              rows.map((r) => ({
                kind: "client" as const,
                id: r.id,
                title: r.name,
                sub: [r.city?.name, r.phone].filter(Boolean).join(" · ") || "Client",
                href: `/clients`,
              })),
            )
        : none,
      can("leads:view")
        ? db.lead
            .findMany({
              where: { workspaceId: ws, deletedAt: null, ...scope, OR: [{ name: has }, { company: has }, { contactName: has }, { phone: has }] },
              select: { id: true, name: true, stage: true, company: true },
              orderBy: { updatedAt: "desc" },
              take: PER_KIND,
            })
            .then((rows) =>
              rows.map((r) => ({
                kind: "lead" as const,
                id: r.id,
                title: r.name,
                sub: [r.company, r.stage.toLowerCase()].filter(Boolean).join(" · "),
                href: `/leads/${r.id}`,
              })),
            )
        : none,
      can("invoices:view")
        ? db.invoice
            .findMany({
              where: { workspaceId: ws, deletedAt: null, ...scope, OR: [{ invoiceNo: has }, { client: { name: has } }] },
              select: { id: true, invoiceNo: true, status: true, total: true, client: { select: { name: true } } },
              orderBy: { createdAt: "desc" },
              take: PER_KIND,
            })
            .then((rows) =>
              rows.map((r) => ({
                kind: "invoice" as const,
                id: r.id,
                title: r.invoiceNo || "Draft invoice",
                sub: `${r.client.name} · ₹${r.total.toNumber().toLocaleString("en-IN")} · ${r.status.toLowerCase().replace(/_/g, " ")}`,
                href: `/invoices/${r.id}`,
              })),
            )
        : none,
      can("vendors:view")
        ? db.vendor
            .findMany({
              where: { workspaceId: ws, deletedAt: null, ...scope, OR: [{ name: has }, { category: has }, { contactName: has }] },
              select: { id: true, name: true, category: true, city: { select: { name: true } } },
              take: PER_KIND,
            })
            .then((rows) =>
              rows.map((r) => ({
                kind: "vendor" as const,
                id: r.id,
                title: r.name,
                sub: [r.category, r.city?.name].filter(Boolean).join(" · ") || "Vendor",
                href: `/vendors`,
              })),
            )
        : none,
      can("inventory:view")
        ? db.inventoryItem
            .findMany({
              where: { workspaceId: ws, deletedAt: null, OR: [{ name: has }, { sku: has }, { category: has }] },
              select: { id: true, name: true, sku: true, category: true },
              take: PER_KIND,
            })
            .then((rows) => rows.map((r) => ({ kind: "stock" as const, id: r.id, title: r.name, sub: `${r.sku} · ${r.category}`, href: `/inventory` })))
        : none,
      db.user
        .findMany({
          where: { workspaceId: ws, deletedAt: null, isActive: true, isExternal: false, OR: [{ name: has }, { username: has }] },
          select: { id: true, name: true, dept: true, primaryRole: { select: { name: true } } },
          take: PER_KIND,
        })
        .then((rows) =>
          rows.map((r) => ({
            kind: "person" as const,
            id: r.id,
            title: r.name,
            sub: [r.primaryRole?.name, r.dept].filter(Boolean).join(" · ") || "Team",
            href: can("people:view") ? `/people` : `/resources`,
          })),
        ),
      can("flows:view")
        ? db.flowInstance
            .findMany({
              where: { deletedAt: null, name: has, project: { workspaceId: ws, ...scope } },
              select: { id: true, name: true, status: true, project: { select: { name: true } } },
              orderBy: { updatedAt: "desc" },
              take: PER_KIND,
            })
            .then((rows) =>
              rows.map((r) => ({ kind: "flow" as const, id: r.id, title: r.name, sub: `${r.project.name} · ${r.status.toLowerCase()}`, href: `/flows` })),
            )
        : none,
      can("documents:view")
        ? db.document
            .findMany({
              where: { workspaceId: ws, deletedAt: null, name: has },
              select: { id: true, name: true, type: true, project: { select: { name: true } } },
              orderBy: { updatedAt: "desc" },
              take: PER_KIND,
            })
            .then((rows) =>
              rows.map((r) => ({
                kind: "document" as const,
                id: r.id,
                title: r.name,
                sub: [r.type.toLowerCase().replace(/_/g, " "), r.project?.name].filter(Boolean).join(" · "),
                href: `/documents`,
              })),
            )
        : none,
    ]);
    // People and projects first — they are what the team looks up most.
    const order: SearchHit["kind"][] = ["person", "project", "invoice", "client", "lead", "vendor", "stock", "flow", "document"];
    return groups.flat().sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind));
  }
}

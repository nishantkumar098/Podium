import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { GoogleConfigService } from "../google/google-config.service";
import type { RequestUser } from "../common/types";
import { ORG_WIDE_ROLES } from "../common/rbac/model";

const ADMIN_ROLES = ORG_WIDE_ROLES;

export interface WorkspaceSettingsInput {
  name?: string;
  gstin?: string | null;
  address?: string | null;
  website?: string | null;
  bankName?: string | null;
  bankAccountName?: string | null;
  bankAccountNo?: string | null;
  bankIfsc?: string | null;
  invoiceTerms?: string[];
  invoiceDeclaration?: string | null;
  procurementApprovalThreshold?: number;
}

/**
 * Settings: the workspace record every invoice and letter is issued under,
 * the roles and what each may do, the cities, and the state of the Google
 * integration. Read by any signed-in person (an invoice's footer is not a
 * secret); only the Founder or an Admin can change it.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleConfigService,
  ) {}

  async get(user: RequestUser) {
    const db = this.prisma.client;
    const [workspace, cities, roles, brands, counts] = await Promise.all([
      db.workspace.findUnique({ where: { id: user.workspaceId } }),
      db.city.findMany({ where: { workspaceId: user.workspaceId, deletedAt: null }, orderBy: [{ isHq: "desc" }, { name: "asc" }] }),
      db.role.findMany({
        where: { workspaceId: user.workspaceId, deletedAt: null },
        include: { rolePermissions: { include: { permission: true } }, _count: { select: { userRoles: true } } },
        orderBy: { name: "asc" },
      }),
      db.brand.findMany({ where: { workspaceId: user.workspaceId, deletedAt: null }, select: { id: true, name: true, code: true, tagline: true } }),
      db.user.count({ where: { workspaceId: user.workspaceId, deletedAt: null, isActive: true } }),
    ]);
    if (!workspace) throw new NotFoundException("Workspace not found.");

    return {
      canEdit: user.roleNames.some((r) => ADMIN_ROLES.includes(r)),
      workspace: {
        id: workspace.id,
        name: workspace.name,
        gstin: workspace.gstin,
        address: workspace.address,
        website: workspace.website,
        bankName: workspace.bankName,
        bankAccountName: workspace.bankAccountName,
        bankAccountNo: workspace.bankAccountNo,
        bankIfsc: workspace.bankIfsc,
        invoiceTerms: workspace.invoiceTerms,
        invoiceDeclaration: workspace.invoiceDeclaration,
        procurementApprovalThreshold: workspace.procurementApprovalThreshold.toNumber(),
      },
      brands,
      cities: cities.map((c) => ({ id: c.id, name: c.name, code: c.code, state: c.state, gstStateCode: c.gstStateCode, isHq: c.isHq })),
      roles: roles.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        people: r._count.userRoles,
        permissions: r.rolePermissions.map((rp) => `${rp.permission.resource}:${rp.permission.action}`).sort(),
      })),
      people: counts,
      integrations: {
        google: {
          mode: this.google.mode,
          credentialsPresent: this.google.hasCredentials(),
          scopes: this.google.scopes,
        },
      },
    };
  }

  async update(user: RequestUser, input: WorkspaceSettingsInput) {
    if (!user.roleNames.some((r) => ADMIN_ROLES.includes(r))) {
      throw new ForbiddenException("Only the Founder or an Admin can change workspace settings.");
    }
    const db = this.prisma.client;
    const before = await db.workspace.findUniqueOrThrow({ where: { id: user.workspaceId } });
    const updated = await db.workspace.update({
      where: { id: user.workspaceId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.gstin !== undefined ? { gstin: input.gstin?.trim() || null } : {}),
        ...(input.address !== undefined ? { address: input.address?.trim() || null } : {}),
        ...(input.website !== undefined ? { website: input.website?.trim() || null } : {}),
        ...(input.bankName !== undefined ? { bankName: input.bankName?.trim() || null } : {}),
        ...(input.bankAccountName !== undefined ? { bankAccountName: input.bankAccountName?.trim() || null } : {}),
        ...(input.bankAccountNo !== undefined ? { bankAccountNo: input.bankAccountNo?.trim() || null } : {}),
        ...(input.bankIfsc !== undefined ? { bankIfsc: input.bankIfsc?.trim().toUpperCase() || null } : {}),
        ...(input.invoiceTerms !== undefined ? { invoiceTerms: input.invoiceTerms.map((t) => t.trim()).filter(Boolean) } : {}),
        ...(input.invoiceDeclaration !== undefined ? { invoiceDeclaration: input.invoiceDeclaration?.trim() || null } : {}),
        ...(input.procurementApprovalThreshold !== undefined ? { procurementApprovalThreshold: input.procurementApprovalThreshold } : {}),
      },
    });
    await db.auditLog.create({
      data: {
        workspaceId: user.workspaceId,
        actorId: user.id,
        action: "settings.updated",
        entityType: "workspace",
        entityId: user.workspaceId,
        // Bank details change where money is sent, so the previous values stay on record.
        before: { name: before.name, gstin: before.gstin, bankAccountNo: before.bankAccountNo, bankIfsc: before.bankIfsc },
        after: { fields: Object.keys(input) },
      },
    });
    return { ok: true, name: updated.name };
  }
}

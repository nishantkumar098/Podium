import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { CreateDocumentMetaInput } from "@podium/shared-types";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { STORAGE_DRIVER, type StorageDriver } from "../common/storage/storage.interface";
import type { RequestUser } from "../common/types";

const DOCUMENT_INCLUDE = { versions: { orderBy: { versionNo: "desc" as const } }, project: { select: { id: true, name: true, cityId: true } } };

/**
 * Documents (Phase F, blueprint §26): metadata lives in Postgres, bytes live
 * behind StorageDriver. Every upload becomes a real DocumentVersion row
 * before the file write is even attempted, and the write happens inside the
 * same operation — if the storage write fails, nothing is left half-done
 * (the version row and the file are created together or not at all, same
 * as invoices.pdf's render-then-store pattern elsewhere in this codebase).
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  async list(user: RequestUser, projectId?: string) {
    return this.withUploaderNames(user, await this.listRows(user, projectId));
  }

  /**
   * DocumentVersion.uploadedById is a plain id (no relation), so the
   * uploader's name — the "By" column — is resolved with one lookup.
   */
  private async withUploaderNames<T extends { versions: Array<{ uploadedById: string }> }>(user: RequestUser, docs: T[]) {
    const ids = [...new Set(docs.flatMap((d) => d.versions.map((v) => v.uploadedById)))];
    const users = await this.prisma.client.user.findMany({ where: { id: { in: ids }, workspaceId: user.workspaceId }, select: { id: true, name: true } });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    return docs.map((d) => ({
      ...d,
      versions: d.versions.map((v) => ({ ...v, uploadedBy: { id: v.uploadedById, name: nameOf.get(v.uploadedById) ?? "—" } })),
    }));
  }

  private async listRows(user: RequestUser, projectId?: string) {
    if (projectId) {
      const project = await this.prisma.client.project.findFirst({ where: { id: projectId, workspaceId: user.workspaceId } });
      if (!project) throw new NotFoundException("Project not found.");
      this.cityScope.assertCanAccessCity(user, project.cityId);
      return this.prisma.client.document.findMany({
        where: { projectId, deletedAt: null },
        include: DOCUMENT_INCLUDE,
        orderBy: { updatedAt: "desc" },
      });
    }
    // Workspace-level documents (no project) carry no city — visible to
    // anyone with documents:view regardless of city scope, same standing as
    // vendors/playbooks. Project-scoped documents in the same query are
    // still filtered per-project below since scopeFilter has no direct hook
    // into Document's own nullable projectId relation shape.
    const scope = this.cityScope.scopeFilter(user);
    return this.prisma.client.document.findMany({
      where: {
        workspaceId: user.workspaceId,
        deletedAt: null,
        OR: [{ projectId: null }, { project: { ...scope } }],
      },
      include: DOCUMENT_INCLUDE,
      orderBy: { updatedAt: "desc" },
    });
  }

  async get(user: RequestUser, id: string) {
    const doc = await this.loadScoped(user, id);
    return doc;
  }

  async create(user: RequestUser, meta: CreateDocumentMetaInput, file: { originalname: string; mimetype: string; size: number; buffer: Buffer }) {
    if (meta.projectId) {
      const project = await this.prisma.client.project.findFirst({ where: { id: meta.projectId, workspaceId: user.workspaceId } });
      if (!project) throw new NotFoundException("Project not found.");
      this.cityScope.assertCanAccessCity(user, project.cityId);
    }

    return this.prisma.client.$transaction(async (tx) => {
      const doc = await tx.document.create({
        data: { workspaceId: user.workspaceId, projectId: meta.projectId, name: meta.name, type: meta.type, createdById: user.id },
      });
      const storageKey = `local/${doc.id}/v1/${file.originalname}`;
      await this.storage.put(storageKey, file.buffer);
      await tx.documentVersion.create({
        data: {
          documentId: doc.id, versionNo: 1, storageKey,
          fileName: file.originalname, mimeType: file.mimetype, sizeBytes: file.size,
          uploadedById: user.id,
        },
      });
      // Written inline, awaited, inside this transaction — not the @Audit()
      // decorator's fire-and-forget interceptor — same reasoning as
      // ExpensesService.decide()/ApprovalsService.decide(): a caller that
      // gets a 201 back must be able to rely on the audit row already
      // existing, not racing a detached write that hasn't landed yet.
      await tx.auditLog.create({
        data: {
          workspaceId: user.workspaceId, actorId: user.id, action: "document.create",
          entityType: "document", entityId: doc.id,
          after: { name: meta.name, type: meta.type, projectId: meta.projectId ?? null, fileName: file.originalname },
        },
      });
      return tx.document.findUniqueOrThrow({ where: { id: doc.id }, include: DOCUMENT_INCLUDE });
    });
  }

  async addVersion(user: RequestUser, documentId: string, file: { originalname: string; mimetype: string; size: number; buffer: Buffer }) {
    const doc = await this.loadScoped(user, documentId);
    const nextVersionNo = (doc.versions[0]?.versionNo ?? 0) + 1;

    return this.prisma.client.$transaction(async (tx) => {
      const storageKey = `local/${doc.id}/v${nextVersionNo}/${file.originalname}`;
      await this.storage.put(storageKey, file.buffer);
      await tx.documentVersion.create({
        data: {
          documentId: doc.id, versionNo: nextVersionNo, storageKey,
          fileName: file.originalname, mimeType: file.mimetype, sizeBytes: file.size,
          uploadedById: user.id,
        },
      });
      // Document has no updatedById column to attribute this to (only
      // createdById) — touch its own name to bump updatedAt so the list
      // view's "most recently touched" ordering reflects the new version.
      await tx.document.update({ where: { id: doc.id }, data: { name: doc.name } });
      await tx.auditLog.create({
        data: {
          workspaceId: user.workspaceId, actorId: user.id, action: "document.new_version",
          entityType: "document_version", entityId: doc.id,
          after: { versionNo: nextVersionNo, fileName: file.originalname },
        },
      });
      return tx.document.findUniqueOrThrow({ where: { id: doc.id }, include: DOCUMENT_INCLUDE });
    });
  }

  async download(user: RequestUser, versionId: string) {
    const version = await this.prisma.client.documentVersion.findFirst({
      where: { id: versionId },
      include: { document: { include: { project: true } } },
    });
    if (!version || version.document.workspaceId !== user.workspaceId || version.document.deletedAt) {
      throw new NotFoundException("Document version not found.");
    }
    if (version.document.project) this.cityScope.assertCanAccessCity(user, version.document.project.cityId);
    const buffer = await this.storage.get(version.storageKey);
    return { buffer, fileName: version.fileName, mimeType: version.mimeType };
  }

  async remove(user: RequestUser, id: string) {
    const doc = await this.loadScoped(user, id);
    // Soft-delete only — same standing as every other module here (budgets,
    // playbooks, vendors): the row and its history stay, just hidden from
    // normal listing. The underlying files are left in storage untouched.
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.document.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });
      await tx.auditLog.create({
        data: { workspaceId: user.workspaceId, actorId: user.id, action: "document.delete", entityType: "document", entityId: doc.id },
      });
      return updated;
    });
  }

  private async loadScoped(user: RequestUser, id: string) {
    const doc = await this.prisma.client.document.findFirst({
      where: { id, workspaceId: user.workspaceId, deletedAt: null },
      include: DOCUMENT_INCLUDE,
    });
    if (!doc) throw new NotFoundException("Document not found.");
    if (doc.project) this.cityScope.assertCanAccessCity(user, doc.project.cityId);
    return doc;
  }
}

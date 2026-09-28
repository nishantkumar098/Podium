/**
 * Podium v2 — import a folder of real business files (Docss.zip, 2026-09-18)
 * as workspace-level Documents.
 *
 * These 12 files (contracts, invoices, offer/reliving/experience letters,
 * the company policy handbook, an agreement) have no structured Podium model
 * of their own — unlike "Vendor's Database.xlsx" (its own sibling importer,
 * `import-vendor-database.ts`) or the event-calendar workbook (already
 * imported as Projects per docs/STATUS.md §0.-13). They're stored exactly
 * the way the app's own upload endpoint (`DocumentsService.create`, Phase F)
 * stores a real upload: one `Document` row, one `DocumentVersion` row with
 * the real fileName/mimeType/sizeBytes, and the bytes written behind
 * `STORAGE_LOCAL_PATH` using the same `local/<id>/v1/<name>` key shape — so
 * these rows are indistinguishable from a file someone uploaded through the
 * UI, and `GET /documents/:versionId/download` serves them unmodified.
 *
 * Idempotent on (workspaceId, projectId: null, name): re-running skips any
 * file whose name already has a live (non-deleted) workspace-level Document,
 * rather than keying on a column Document doesn't have.
 *
 * Usage:
 *   PODIUM_IMPORT_DIR="C:\path\to\extracted\Docss" pnpm import:documents --dry-run
 *   PODIUM_IMPORT_DIR="C:\path\to\extracted\Docss" pnpm import:documents
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";

const prisma = new PrismaClient();

const UPLOADS = process.env.PODIUM_IMPORT_DIR;
const STORAGE_ROOT = path.resolve(process.env.STORAGE_LOCAL_PATH ?? "./.local-storage");
const DRY_RUN = process.argv.includes("--dry-run");

// "Vendor's Database.xlsx" is handled by its own importer (parsed into rows,
// not stored as a raw file) — excluded so a normal run never creates a
// duplicate, unparsed copy of it.
//
// "AMM BRANDS LLP DATABASE.xlsx" is excluded for a harder reason: it carries
// the sheet `LOGIN I`D AND PASSWORDS LIST`, which forbidden-sheet.ts exists to
// keep out of Podium entirely. Storing the workbook as a Document would hand
// every holder of `documents:view` a downloadable copy of those credentials —
// the exact outcome the sheet-level guard prevents on the parsing path. A
// file whose NAME is safe can still be a file whose CONTENTS are not, so this
// list is checked by name before any byte is read.
const EXCLUDE = new Set(["Vendor's Database.xlsx", "AMM BRANDS LLP DATABASE.xlsx"]);

type DocumentType = "CONTRACT" | "DESIGN" | "CREATIVE" | "PURCHASE_ORDER" | "GOVERNMENT_PERMIT" | "GUEST_LIST" | "OTHER";

// Classified by what each file actually is, not guessed from extension —
// checked against the real file list in Docss.zip.
const TYPE_BY_NAME: Record<string, DocumentType> = {
  "EXIT UNDERTAKING.docx": "CONTRACT",
  "Engagement Letter_Divyansh Mahajan.docx": "CONTRACT",
  "Assest one pager agreement.docx": "CONTRACT",
  "FREELANCE BARTENDING SERVICES AGREEMENT copy.docx": "CONTRACT",
  "Reliving Letter.docx": "OTHER",
  "Experience Letter.docx": "OTHER",
  "aryan mishra offer letter (1).pdf": "OTHER",
  "Updated New Company Policies 2026 (1).docx": "OTHER",
  "AMM Brands Estimate invoice.pdf": "OTHER",
  "AMM Brands Tax invoice.pdf": "OTHER",
  "AMM Event Calender for Staff.xlsx": "OTHER",
  "Elixir New Clients Query (1).xlsx": "OTHER",
};

const MIME_BY_EXT: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function resolveStorageKey(key: string): string {
  const full = path.resolve(STORAGE_ROOT, key);
  if (full !== STORAGE_ROOT && !full.startsWith(STORAGE_ROOT + path.sep)) {
    throw new Error(`Storage key escapes the storage root: ${key}`);
  }
  return full;
}

async function main() {
  if (!UPLOADS) throw new Error("PODIUM_IMPORT_DIR must point at the extracted Docss folder");
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "(unknown)";
  console.log(`\n${"=".repeat(72)}`);
  console.log(`${DRY_RUN ? "DRY RUN — " : ""}IMPORT UPLOADED DOCUMENTS — ${dbName}`);
  console.log(`${"=".repeat(72)}`);

  const workspace = await prisma.workspace.findFirst();
  if (!workspace) throw new Error("no workspace in this database");

  const uploader =
    (await prisma.user.findFirst({ where: { primaryRole: { name: "Founder" } }, orderBy: { createdAt: "asc" } })) ??
    (await prisma.user.findFirst({ orderBy: { createdAt: "asc" } }));
  if (!uploader) throw new Error("no users exist — provision employees before importing documents");

  const entries = await fs.readdir(UPLOADS, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && !EXCLUDE.has(e.name)).map((e) => e.name);

  const existing = await prisma.document.findMany({
    where: { workspaceId: workspace.id, projectId: null, deletedAt: null },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((d) => d.name));

  console.log(`\nFound ${files.length} file(s) in ${UPLOADS} (excluding ${[...EXCLUDE].join(", ")})`);
  console.log(`Uploader: ${uploader.name} <${uploader.email}>`);

  let created = 0;
  let skipped = 0;

  for (const fileName of files) {
    if (existingNames.has(fileName)) {
      console.log(`   SKIP  (already imported) ${fileName}`);
      skipped++;
      continue;
    }

    const type = TYPE_BY_NAME[fileName] ?? "OTHER";
    if (!TYPE_BY_NAME[fileName]) {
      console.log(`   WARN  unrecognized file, defaulting to OTHER: ${fileName}`);
    }

    const filePath = path.join(UPLOADS, fileName);
    const stat = await fs.stat(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";

    console.log(`   ${DRY_RUN ? "WOULD CREATE" : "CREATE"}  ${fileName}  (${type}, ${mimeType}, ${stat.size} bytes)`);
    if (DRY_RUN) {
      created++;
      continue;
    }

    const buffer = await fs.readFile(filePath);

    await prisma.$transaction(async (tx) => {
      const doc = await tx.document.create({
        data: { workspaceId: workspace.id, projectId: null, name: fileName, type, createdById: uploader.id },
      });
      const storageKey = `local/${doc.id}/v1/${fileName}`;
      const full = resolveStorageKey(storageKey);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, buffer);

      await tx.documentVersion.create({
        data: {
          documentId: doc.id,
          versionNo: 1,
          storageKey,
          fileName,
          mimeType,
          sizeBytes: stat.size,
          uploadedById: uploader.id,
        },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: workspace.id,
          actorId: uploader.id,
          action: "document.create",
          entityType: "document",
          entityId: doc.id,
          after: { name: fileName, type, projectId: null, fileName } satisfies Prisma.InputJsonValue,
        },
      });
    });
    created++;
  }

  console.log(`\n${DRY_RUN ? "would create" : "created"}: ${created}, skipped (already present): ${skipped}`);
  if (DRY_RUN) {
    console.log("\nDry run — nothing was written.");
    return;
  }
  console.log(`Documents now in ${dbName}: ${await prisma.document.count({ where: { workspaceId: workspace.id, deletedAt: null } })}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

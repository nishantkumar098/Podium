/**
 * What an importer REFUSED, written down.
 *
 * PHASE 0 §B: "Do not silently discard columns because the guard flags them.
 * Flagging must result in controlled restricted handling or explicit
 * quarantine."
 *
 * Until now a flagged column was printed to the console as part of an import
 * run and then existed nowhere. That is a silent discard with extra steps: the
 * moment the terminal scrolls, there is no record that AMM's employee master
 * carried salary, bank and Aadhaar columns, that Podium saw them, and that it
 * declined to read them.
 *
 * So every refusal becomes a manifest on disk: which file, which sheet, which
 * column, which tier, and what was done about it.
 *
 * WHAT A MANIFEST NEVER CONTAINS. Values. Not one cell, not a sample, not a
 * redacted prefix, not a hash. A manifest is a record that data was refused,
 * and a record that quotes the data is not a refusal. It names columns only,
 * and it is safe to commit precisely because of that.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface QuarantinedColumn {
  /** Source workbook, basename only — upload paths are noise in six months. */
  readonly file: string;
  readonly sheet: string;
  /** The column heading as the source writes it, spelling and all. */
  readonly column: string;
  /** Which guard category matched: salary, bank-account, government-id, credential. */
  readonly category: string;
  /** GENERAL | RESTRICTED | HIGHLY_RESTRICTED | CREDENTIAL. */
  readonly tier: string;
  /** What actually happened. "not read" is the normal answer. */
  readonly disposition: string;
}

export interface QuarantineManifest {
  readonly importer: string;
  readonly generatedAt: string;
  readonly refusedSheets: ReadonlyArray<{ file: string; sheet: string; reason: string }>;
  readonly refusedColumns: ReadonlyArray<QuarantinedColumn>;
}

const MANIFEST_DIR = path.join(__dirname, "..", "docs", "quarantine");

export function writeQuarantineManifest(manifest: QuarantineManifest): string {
  mkdirSync(MANIFEST_DIR, { recursive: true });
  const stamp = manifest.generatedAt.replace(/[:.]/g, "-");
  const target = path.join(MANIFEST_DIR, `${manifest.importer}-${stamp}.md`);

  const lines: string[] = [
    `# Quarantine manifest — ${manifest.importer}`,
    "",
    `Generated ${manifest.generatedAt}.`,
    "",
    "Everything listed here was **seen and not read**. No value from any of",
    "these columns was parsed, logged, stored or included in this file.",
    "",
  ];

  if (manifest.refusedSheets.length > 0) {
    lines.push("## Sheets refused whole", "", "| File | Sheet | Reason |", "| --- | --- | --- |");
    for (const s of manifest.refusedSheets) lines.push(`| ${s.file} | ${s.sheet} | ${s.reason} |`);
    lines.push("");
  }

  if (manifest.refusedColumns.length > 0) {
    lines.push("## Columns refused", "", "| File | Sheet | Column | Category | Tier | Disposition |", "| --- | --- | --- | --- | --- | --- |");
    for (const c of manifest.refusedColumns) {
      lines.push(`| ${c.file} | ${c.sheet} | \`${c.column}\` | ${c.category} | **${c.tier}** | ${c.disposition} |`);
    }
    lines.push("");
  }

  if (manifest.refusedSheets.length === 0 && manifest.refusedColumns.length === 0) {
    lines.push("Nothing was refused in this run.", "");
  }

  writeFileSync(target, lines.join("\n"));
  return target;
}

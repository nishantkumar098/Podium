/**
 * Podium — replace the vendor list with AMM's vendor sheet
 * ("VENDOR DETAILS - Vender Infomation.csv").
 *
 * The sheet holds three kinds of rows:
 *   1. the numbered vendor table (brand, contact, GST/PAN, bank, payment terms)
 *   2. a quick-contact list further down ("RENTAL GLASS VENDOR", "BUTLER
 *      VENDOR", "ALL PRINTING"…) — also vendors, with a name, what they
 *      supply and a phone number
 *   3. people, not vendors: the bartender / hookah / service-staff list, the
 *      freelancer rate table and the IBG student table. Those are SKIPPED and
 *      listed at the end — they belong with people, not suppliers.
 *
 * Every vendor already in Podium that is not in this sheet is RETIRED (marked
 * deleted, so it disappears from the app) rather than erased, so nothing is
 * lost if a number is needed later. Nothing referenced them (no purchase
 * orders, requests, project links or stock items), which was checked first.
 *
 * Re-running is safe: each row keeps an idempotency key (`vendor-sheet:<n>`),
 * so rows are updated in place, never duplicated.
 *
 * Usage:  pnpm vendors:import            # dry run
 *         pnpm vendors:import --apply
 * The file is read from PODIUM_IMPORT_DIR (default: the user's Downloads).
 */
import * as path from "node:path";
import { prisma } from "@podium/db";
import * as XLSX from "xlsx";

const APPLY = process.argv.includes("--apply");
const DIR = process.env.PODIUM_IMPORT_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "Downloads");
const FILE = process.env.PODIUM_VENDOR_FILE ?? "VENDOR DETAILS - Vender Infomation.csv";
const IMPORTER = "nishant.kumar";

/** Roles in the sheet's contact list that are people on the team, not suppliers. */
const STAFF_ROLES = ["BARTENDER", "HOOKAH BOY", "SERVICE GIRLS"];

type Cell = string | number;
const txt = (v: Cell | undefined): string => String(v ?? "").trim();
/** "N/A", "-", "NA" and blanks all mean "not recorded". */
const val = (v: Cell | undefined): string | null => {
  const s = txt(v).replace(/^-+$/, "");
  if (!s || /^(n\/?a)$/i.test(s)) return null;
  return s;
};
const digits = (s: string) => s.replace(/\D/g, "");

/** First usable phone number, and the line exactly as written. */
function phones(raw: string | null): { phone: string | null; phoneRaw: string | null } {
  if (!raw) return { phone: null, phoneRaw: null };
  const first = raw.split(/[\/,]/)[0] ?? raw;
  const d = digits(first);
  return { phone: d.length >= 8 ? d : null, phoneRaw: raw };
}

const CITY_HINTS: Array<[RegExp, string]> = [
  [/\b(new delhi|delhi|ghitorni|mehrauli|rohini|gujranwala|sadar bazar|pooth khurd|naharpur)\b/i, "Delhi"],
  [/\b(navi mumbai|mumbai|vashi|malad)\b/i, "Mumbai"],
  [/\bjaipur\b/i, "Jaipur"],
  [/\bchennai\b/i, "Chennai"],
  [/\b(dehradun|mussoorie)\b/i, "Dehradun"],
  [/\b(goa|cuncolim)\b/i, "Goa"],
];
/** Only AMM's own branch cities become a city; anywhere else stays in the address. */
function branchCity(...parts: Array<string | null>): string | null {
  const hay = parts.filter(Boolean).join(" ");
  for (const [re, city] of CITY_HINTS) if (re.test(hay)) return city;
  return null;
}

const gstOf = (v: string | null) => {
  const s = v?.replace(/^gstin:?\s*/i, "").trim();
  return s && /^[0-9A-Z]{15}$/i.test(s) ? s.toUpperCase() : s || null;
};
/** "₹12,980.00", however the encoding mangles the symbol -> 12980. */
const money = (v: string | null) => {
  if (!v) return null;
  const n = Number(v.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
/** A date cell: either 2026-05-06 or the spreadsheet's own day number. */
const date = (v: string | null) => {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00Z`);
  const serial = Number(v);
  if (!Number.isFinite(serial) || serial < 20000 || serial > 60000) return null;
  return new Date(Math.round((serial - 25569) * 86400) * 1000);
};

interface Row {
  key: string;
  name: string;
  brand: string | null;
  website: string | null;
  category: string | null;
  contactName: string | null;
  phone: string | null;
  phoneRaw: string | null;
  email: string | null;
  address: string | null;
  cityName: string | null;
  gstin: string | null;
  pan: string | null;
  bankName: string | null;
  bankAccountNo: string | null;
  bankIfsc: string | null;
  upiId: string | null;
  paymentTerms: string | null;
  creditDays: number | null;
  openingBalance: number | null;
  lastPaymentAt: Date | null;
  nextPaymentDueAt: Date | null;
  remarks: string | null;
}

function read(): { vendors: Row[]; skippedPeople: string[] } {
  // codepage 65001: the file is UTF-8, and without it the rupee sign and any
  // dashes in names arrive as mojibake.
  const wb = XLSX.readFile(path.join(DIR, FILE), { raw: false, codepage: 65001 });
  const rows = XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: "" });

  const head = rows.findIndex((r) => txt(r[0]) === "S.No" && txt(r[3]).toLowerCase().includes("vendor"));
  if (head < 0) throw new Error("Vendor table header (S.No … Vendor/company Name) not found.");
  // Everything from the freelancer tables down is people, not vendors.
  const stopAt = rows.findIndex((r) => r.some((c) => /FREELANCER DATA/i.test(txt(c))));
  const end = stopAt < 0 ? rows.length : stopAt;

  const vendors: Row[] = [];
  const skippedPeople: string[] = [];

  for (let i = head + 1; i < end; i += 1) {
    const r = rows[i]!;
    const name = val(r[3]);
    if (!name) continue;

    const numbered = !!val(r[0]);
    const category = val(r[5]);
    if (!numbered && category && STAFF_ROLES.some((role) => category.toUpperCase().includes(role))) {
      skippedPeople.push(`${name} — ${category}`);
      continue;
    }

    // The quick-contact rows lower down have no "Contact Person": their phone
    // number sits in that column instead.
    const contactCell = val(r[6]);
    const contactIsPhone = !numbered && !!contactCell && digits(contactCell).length >= 8;
    const { phone, phoneRaw } = phones(val(r[7]) ?? (contactIsPhone ? contactCell : null));
    const emails = (val(r[8]) ?? "").split(/[,;]/).map((e) => e.trim()).filter((e) => /@/.test(e));
    const addressParts = [val(r[9]), val(r[10]), val(r[11])].filter(Boolean);
    const extras = emails.slice(1).length ? `Also: ${emails.slice(1).join(", ")}` : null;
    const status = val(r[23]);
    vendors.push({
      key: numbered ? `vendor-sheet:${txt(r[0])}` : `vendor-sheet:contact:${digits(phoneRaw ?? name) || name.toLowerCase().replace(/\W+/g, "-")}`,
      name,
      brand: val(r[1]),
      website: val(r[4]),
      category,
      contactName: contactIsPhone ? null : contactCell,
      phone,
      phoneRaw,
      email: emails[0] ?? null,
      address: addressParts.length ? addressParts.join(", ") : null,
      cityName: branchCity(val(r[10]), val(r[9]), name),
      gstin: gstOf(val(r[12])),
      pan: val(r[13]),
      bankName: val(r[14]),
      bankAccountNo: val(r[15]),
      bankIfsc: val(r[16]),
      upiId: val(r[17]),
      paymentTerms: val(r[18]),
      creditDays: val(r[19]) !== null ? Number(val(r[19])) || 0 : null,
      openingBalance: money(val(r[20])),
      lastPaymentAt: date(val(r[21])),
      nextPaymentDueAt: date(val(r[22])),
      remarks: [status && !/^active$/i.test(status) ? `Status on sheet: ${status}` : null, val(r[24]), extras].filter(Boolean).join(" · ") || null,
    });
  }
  return { vendors, skippedPeople };
}

async function main() {
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { deletedAt: null }, select: { id: true, name: true } });
  const importer = await prisma.user.findFirstOrThrow({ where: { username: IMPORTER }, select: { id: true } });
  const cities = await prisma.city.findMany({ where: { workspaceId: workspace.id, deletedAt: null }, select: { id: true, name: true } });
  const cityId = (name: string | null) => (name ? cities.find((c) => c.name === name)?.id ?? null : null);

  const { vendors, skippedPeople } = read();
  const existing = await prisma.vendor.findMany({ where: { workspaceId: workspace.id, deletedAt: null }, select: { id: true, externalRef: true, name: true } });
  const keys = new Set(vendors.map((v) => v.key));
  const keep = new Map(existing.filter((e) => e.externalRef && keys.has(e.externalRef)).map((e) => [e.externalRef!, e.id]));
  const retire = existing.filter((e) => !e.externalRef || !keys.has(e.externalRef));

  const withBank = vendors.filter((v) => v.bankAccountNo).length;
  const withGst = vendors.filter((v) => v.gstin).length;
  const cityCount = new Map<string, number>();
  for (const v of vendors) cityCount.set(v.cityName ?? "no branch city", (cityCount.get(v.cityName ?? "no branch city") ?? 0) + 1);

  console.log(`${workspace.name} — ${FILE}`);
  console.log(`   ${vendors.length} vendors in the sheet (${withGst} with GST, ${withBank} with bank details)`);
  console.log(`   cities: ${[...cityCount.entries()].map(([c, n]) => `${c} ${n}`).join(" · ")}`);
  console.log(`   ${keep.size} already imported (updated), ${vendors.length - keep.size} new`);
  console.log(`   ${retire.length} existing vendors NOT in the sheet -> retired (hidden, recoverable)`);
  for (const v of vendors) {
    console.log(`   ${(v.brand ?? "—").padEnd(10)} ${v.name.slice(0, 34).padEnd(35)} ${(v.category ?? "").slice(0, 26).padEnd(27)} ${v.phone ?? ""}`);
  }
  if (skippedPeople.length) {
    console.log(`\n   Skipped — people, not vendors (${skippedPeople.length}): they belong with staff/freelancers`);
    for (const p of skippedPeople) console.log(`      ${p}`);
  }
  if (!APPLY) return console.log("\nDry run — nothing was written. Re-run with --apply.");

  let created = 0;
  let updated = 0;
  await prisma.$transaction(
    async (tx) => {
      for (const v of vendors) {
        const data = {
          name: v.name,
          brand: v.brand,
          website: v.website,
          category: v.category,
          contactName: v.contactName,
          phone: v.phone,
          phoneRaw: v.phoneRaw,
          email: v.email,
          address: v.address,
          cityId: cityId(v.cityName),
          gstin: v.gstin,
          pan: v.pan,
          bankName: v.bankName,
          bankAccountNo: v.bankAccountNo,
          bankIfsc: v.bankIfsc,
          upiId: v.upiId,
          paymentTerms: v.paymentTerms,
          creditDays: v.creditDays,
          openingBalance: v.openingBalance,
          lastPaymentAt: v.lastPaymentAt,
          nextPaymentDueAt: v.nextPaymentDueAt,
          remarks: v.remarks,
          source: "Vendor details sheet",
          status: "APPROVED" as const,
          deletedAt: null,
        };
        const id = keep.get(v.key);
        if (id) {
          await tx.vendor.update({ where: { id }, data });
          updated += 1;
        } else {
          await tx.vendor.create({ data: { ...data, workspaceId: workspace.id, externalRef: v.key, createdById: importer.id } });
          created += 1;
        }
      }
      if (retire.length) {
        await tx.vendor.updateMany({ where: { id: { in: retire.map((r) => r.id) } }, data: { deletedAt: new Date(), updatedById: importer.id } });
      }
      await tx.auditLog.create({
        data: {
          workspaceId: workspace.id,
          actorId: importer.id,
          action: "vendors.replaced_from_sheet",
          entityType: "workspace",
          entityId: workspace.id,
          after: { file: FILE, created, updated, retired: retire.length, skippedPeople: skippedPeople.length },
        },
      });
    },
    { maxWait: 20_000, timeout: 180_000 },
  );
  console.log(`\nWritten: ${created} new, ${updated} updated, ${retire.length} retired.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

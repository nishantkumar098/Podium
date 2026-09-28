/**
 * Podium v2 — load AMM's real letterhead, remittance details and invoice
 * boilerplate into the workspace, and register the two trading brands.
 *
 * Every value below is transcribed verbatim from the invoice design Anant
 * supplied on 2026-09-15 (AMM/INV/2026-27/0012). None of it is generated:
 * inventing an address, a bank account or a set of contract terms for a real
 * company would put text on a tax document that AMM never wrote.
 *
 * Configuration, not business data — so `wipe-business-data.ts` leaves the
 * workspace row alone, and this only needs re-running when AMM's details
 * actually change.
 *
 * Usage:
 *   pnpm configure:letterhead --expect-db=podium_dev --dry-run
 *   pnpm configure:letterhead --expect-db=podium_dev
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const DRY_RUN = process.argv.includes("--dry-run");
const EXPECT_DB = arg("expect-db");

// Transcribed from the supplied invoice letterhead.
const LETTERHEAD = {
  name: "AMM BRANDS LLP",
  gstin: "07ACBFA2835N1ZB",
  address: "H-12-B, Basement and Stell, Green Park Main Road, Green Park, New Delhi, South Delhi, Delhi 110016",
  website: "ammbrands.com",
};

// From the "BANK DETAILS FOR PAYMENT" block. These are AMM's OWN account for
// receiving customer payments — they belong on an invoice by design. That is
// a different thing entirely from the employee and third-party financial data
// scripts/forbidden-sheet.ts refuses to import.
const BANK = {
  bankName: "Axis Bank",
  bankAccountName: "AMM BRANDS LLP",
  bankAccountNo: "923020009249121",
  bankIfsc: "UTIB0000015",
};

// Verbatim from "TERMS & CONDITIONS", in the printed order.
const TERMS = [
  "To secure booking, a non refundable advance payment of 50% is required and balance payable on event date.",
  "No refunds will be issued for services already completed.",
  "Shift lasting more than 10 hours will have an additional 50% charges. Also, for supplies 100% advance.",
  "Goods and equipment supplied on rental remain the property of AMM BRANDS LLP and are to be returned in the condition supplied.",
  "Any scope change, additional manpower, travel or accommodation requested on site will be billed separately.",
];

const DECLARATION =
  "We declare that this invoice shows the actual price of the goods and services described and that all particulars are true and correct.";

const BRANDS = [
  { code: "ELIXIR", name: "Elixir Coterie", tagline: "Event bar, hookah & culinary", website: "elixircoterie.com" },
  { code: "TCS", name: "The Cocktail Shop", tagline: "Bar retail & barware", website: "thecocktailshop.in" },
];

async function main() {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!dbName) throw new Error("DATABASE_URL is not set");
  if (!EXPECT_DB) throw new Error("--expect-db=<name> is required, and must match DATABASE_URL");
  if (EXPECT_DB !== dbName) throw new Error(`DATABASE_URL points at "${dbName}" but --expect-db says "${EXPECT_DB}"`);

  const workspace = await prisma.workspace.findFirst();
  if (!workspace) throw new Error("no workspace in this database");

  console.log(`\n${DRY_RUN ? "DRY RUN — " : ""}WORKSPACE LETTERHEAD — ${dbName}\n`);
  console.log(`  name      ${LETTERHEAD.name}`);
  console.log(`  gstin     ${LETTERHEAD.gstin}`);
  console.log(`  address   ${LETTERHEAD.address}`);
  console.log(`  website   ${LETTERHEAD.website}`);
  console.log(`  bank      ${BANK.bankName} · ${BANK.bankAccountName} · A/c ${BANK.bankAccountNo} · IFSC ${BANK.bankIfsc}`);
  console.log(`  terms     ${TERMS.length} clause(s)`);
  console.log(`  brands    ${BRANDS.map((b) => `${b.name} (${b.code})`).join(", ")}`);

  if (DRY_RUN) {
    console.log(`\nDry run — nothing was written.`);
    return;
  }

  await prisma.workspace.update({
    where: { id: workspace.id },
    data: {
      ...LETTERHEAD,
      ...BANK,
      invoiceTerms: TERMS,
      invoiceDeclaration: DECLARATION,
    },
  });

  for (const b of BRANDS) {
    await prisma.brand.upsert({
      where: { workspaceId_code: { workspaceId: workspace.id, code: b.code } },
      create: { workspaceId: workspace.id, ...b },
      update: { name: b.name, tagline: b.tagline, website: b.website },
    });
  }

  const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
  const brands = await prisma.brand.findMany({ where: { workspaceId: workspace.id }, orderBy: { code: "asc" } });
  console.log(`\nWritten. Verifying:`);
  console.log(`  gstin=${after.gstin}  bank=${after.bankName}  terms=${after.invoiceTerms.length}  declaration=${after.invoiceDeclaration ? "set" : "MISSING"}`);
  console.log(`  brands: ${brands.map((b) => `${b.code}=${b.name}`).join(", ")}`);
  if (after.invoiceTerms.length !== TERMS.length || !after.invoiceDeclaration) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

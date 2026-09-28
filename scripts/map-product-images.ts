/**
 * Maps The Cocktail Shop's product photo export onto the products already in
 * Podium, and writes the chosen file for each product to `Product.imageUrl`.
 *
 *   dry run:  pnpm products:images -- --from "C:/path/to/extracted/images"
 *   apply:    pnpm products:images -- --from "C:/path/to/extracted/images" --apply
 *
 * HOW THE MATCH IS MADE, and why it is not fuzzy.
 *
 * Most of the exported filenames carry the shop's own SKU — the same code
 * Podium already stores on `Product.sku` ("3-Ring-Muddler_TCS-E-044_1.jpg").
 * That is an exact join, so it is the only one this script performs. Photos
 * without a code in the filename are LEFT ALONE rather than guessed at from
 * the words around them: a muddler photographed next to a shaker would be
 * matched to the shaker about as often as not, and a wrong photo on a price
 * list is worse than no photo at all.
 *
 * Where several files carry the same code, one is chosen, in this order:
 *   1. the file the export marked as primary (a `_1` suffix)
 *   2. otherwise the largest file, which is reliably the least cropped
 * The rest are reported as unused so nothing disappears silently.
 *
 * Images are copied into `apps/web/public/products/<SKU>.<ext>` and stored as
 * a site-relative path, so they are served as ordinary static files by the
 * same process that serves the app — no storage driver, no signed URLs, and
 * they ship with the deploy bundle.
 */
import { PrismaClient } from "@prisma/client";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const fromIdx = args.indexOf("--from");
const FROM = fromIdx >= 0 ? args[fromIdx + 1] : undefined;

const OUT_DIR = resolve(__dirname, "../apps/web/public/products");
/** Web path the app will request. Must match where OUT_DIR is served from. */
const webPath = (file: string) => `/products/${file}`;

const db = new PrismaClient();

/**
 * Every SKU-looking code in a filename, upper-cased.
 *
 * No `\b` anchors: the export separates the code with underscores
 * ("3-Ring-Muddler_TCS-E-044_1.jpg"), and `_` is a word character, so a word
 * boundary never occurs there and every match silently failed. The guards
 * below are explicit about which characters may surround a code instead.
 */
function codesIn(filename: string): string[] {
  const out = new Set<string>();
  for (const m of filename.matchAll(/(TCS-[A-Z]+-\d+)/gi)) out.add(m[1]!.toUpperCase());
  // MS-### is short enough to appear inside unrelated names, so it must sit
  // at a boundary of the filename or be delimited by a separator.
  for (const m of filename.matchAll(/(?:^|[^A-Z0-9])(MS-\d{2,4})(?![0-9])/gi)) out.add(m[1]!.toUpperCase());
  return [...out];
}

/** The export marks a product's main photo with a _1 suffix before the extension. */
const isPrimary = (file: string) => /_1\.[a-z0-9]+$/i.test(file);

async function main() {
  if (!FROM) throw new Error('Pass the extracted image folder: --from "C:/path/to/images"');
  if (!existsSync(FROM)) throw new Error(`No such folder: ${FROM}`);

  const files = readdirSync(FROM).filter((f) => /\.(jpe?g|png|webp|avif)$/i.test(f));
  console.log(`\n${files.length} image files in ${FROM}`);
  console.log(APPLY ? "Mode: APPLY — files will be copied and the database updated.\n" : "Mode: DRY RUN — nothing is copied or written.\n");

  // --- filename -> candidate codes
  const byCode = new Map<string, string[]>();
  let uncoded = 0;
  for (const f of files) {
    const codes = codesIn(f);
    if (codes.length === 0) {
      uncoded += 1;
      continue;
    }
    for (const c of codes) byCode.set(c, [...(byCode.get(c) ?? []), f]);
  }
  console.log(`${byCode.size} distinct codes found in filenames; ${uncoded} files carry no code`);

  // --- products we could match
  const products = await db.product.findMany({
    where: { deletedAt: null, sku: { not: null } },
    select: { id: true, sku: true, name: true, imageUrl: true },
  });
  const bySku = new Map(products.map((p) => [p.sku!.toUpperCase(), p]));
  console.log(`${products.length} products carry a SKU`);

  // --- decide one file per product
  const chosen: Array<{ id: string; sku: string; name: string; file: string; was: string | null }> = [];
  const unusedCodes: string[] = [];
  for (const [code, candidates] of byCode) {
    const product = bySku.get(code);
    if (!product) {
      unusedCodes.push(code);
      continue;
    }
    const pick =
      candidates.find(isPrimary) ??
      [...candidates].sort((a, b) => statSync(join(FROM, b)).size - statSync(join(FROM, a)).size)[0]!;
    chosen.push({ id: product.id, sku: product.sku!, name: product.name, file: pick, was: product.imageUrl });
  }

  const changes = chosen.filter((c) => c.was !== webPath(`${c.sku}${extname(c.file).toLowerCase()}`));
  console.log(`\nmatched   ${chosen.length} products to a photo`);
  console.log(`to write  ${changes.length} (the rest already point at the same file)`);
  console.log(`no photo  ${products.length - chosen.length} products`);
  console.log(`codes in filenames with no product: ${unusedCodes.length}${unusedCodes.length ? ` (e.g. ${unusedCodes.slice(0, 5).join(", ")})` : ""}`);

  for (const c of changes.slice(0, 15)) console.log(`   ${c.sku.padEnd(12)} ${c.name.slice(0, 44).padEnd(46)} <- ${c.file}`);
  if (changes.length > 15) console.log(`   …and ${changes.length - 15} more`);

  if (!APPLY) {
    console.log("\nRe-run with --apply to copy the files and update the products.\n");
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  let copied = 0;
  for (const c of chosen) {
    const dest = `${c.sku}${extname(c.file).toLowerCase()}`;
    copyFileSync(join(FROM, c.file), join(OUT_DIR, dest));
    await db.product.update({ where: { id: c.id }, data: { imageUrl: webPath(dest) } });
    copied += 1;
    if (copied % 100 === 0) console.log(`   ${copied}/${chosen.length}…`);
  }
  console.log(`\n${copied} photos copied to apps/web/public/products and linked to their product.\n`);
}

main()
  .catch((e) => {
    console.error("\nmap-product-images failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

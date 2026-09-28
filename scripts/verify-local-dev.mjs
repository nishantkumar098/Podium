/**
 * Local-development smoke test: proves a freshly set-up stack actually
 * works, by using it the way a person would.
 *
 * This exists because "local dev works" had been a status claim rather than
 * an observation. It drives a real browser against a real API and a real
 * seeded database, and every check below is a thing that was actually
 * broken at some point: a screen that renders its shell but no rows, or a
 * login that lands on a blank dashboard, passes a naive "did the page load"
 * check and fails this one.
 *
 * Run it after the README's "Local development" steps, with both servers up:
 *
 *   node scripts/verify-local-dev.mjs
 *
 * Env: WEB_URL (default http://localhost:3000), API_URL (default
 * http://localhost:3001), EMAIL, PASSWORD, SHOT_DIR (default ./.local-verify).
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
const API_URL = process.env.API_URL ?? "http://localhost:3001";
const EMAIL = process.env.EMAIL ?? "anant.sharma@ammbrands.in";
const PASSWORD = process.env.PASSWORD ?? "Podium123!";
const SHOT_DIR = process.env.SHOT_DIR ?? ".local-verify";

mkdirSync(SHOT_DIR, { recursive: true });

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

console.log("health");
const health = await fetch(`${API_URL}/api/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
check("API health endpoint reports ok", health.status === "ok" && health.database === "up", JSON.stringify(health));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const page = await (await browser.newContext()).newPage();

// A page that throws on render can still look fine in a screenshot.
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

console.log("\nlogin");
await page.goto(`${WEB_URL}/login`, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOT_DIR}/01-login.png`, fullPage: true });
await page.fill('input[type="email"], input[name="email"]', EMAIL);
await page.fill('input[type="password"], input[name="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 20000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${SHOT_DIR}/02-dashboard.png`, fullPage: true });
check("login lands on the dashboard", page.url().includes("/dashboard"));
check("dashboard shows real project cards", (await page.locator(".pcard").count()) > 0);

// Every screen below is asserted on its *content*, never just its URL.
const screens = [
  { name: "invoices", path: "/invoices", rows: "table tbody tr" },
  { name: "vendors", path: "/vendors", rows: "table tbody tr" },
  { name: "automation", path: "/automation", rows: "table tbody tr" },
  { name: "projects", path: "/projects", rows: ".pcard, table tbody tr" },
];

for (const screen of screens) {
  console.log(`\n${screen.name}`);
  await page.goto(`${WEB_URL}${screen.path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const rows = await page.locator(screen.rows).count();
  check(`${screen.name} renders real rows`, rows > 0, `${rows} rows`);
  await page.screenshot({ path: `${SHOT_DIR}/03-${screen.name}.png`, fullPage: true });
}

console.log("\ninvoice detail");
await page.goto(`${WEB_URL}/invoices`, { waitUntil: "networkidle" });
// The invoice number is the link; the row itself isn't clickable.
await page.locator('table tbody tr a[href^="/invoices/"]').first().click();
await page.waitForURL(/\/invoices\/[0-9a-f-]+$/, { timeout: 20000 });
await page.waitForTimeout(1200);
const invoiceHasTotal = (await page.getByText(/Total/i).count()) > 0;
check("invoice detail opens and shows its totals", invoiceHasTotal, page.url());
await page.screenshot({ path: `${SHOT_DIR}/04-invoice-detail.png`, fullPage: true });

console.log("\nproject budget tab");
await page.goto(`${WEB_URL}/projects`, { waitUntil: "networkidle" });
await page.locator(".pcard, table tbody tr").first().click();
await page.waitForURL(/\/projects\/[0-9a-f-]+$/, { timeout: 20000 });
await page.waitForTimeout(1000);
await page.locator("button.tab", { hasText: "budget" }).click();
await page.waitForTimeout(1500);
const budgetRendered = (await page.locator(".panel").count()) > 0;
check("project budget tab renders", budgetRendered, page.url());
await page.screenshot({ path: `${SHOT_DIR}/05-project-budget.png`, fullPage: true });

check("no uncaught page errors anywhere in the walkthrough", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
console.log(`\nscreenshots in ${SHOT_DIR}/`);
console.log(failures.length === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);

/**
 * Session keep-alive verification (real browser, real stack).
 *
 * Proves the thing that actually matters to a user: with the app open and
 * in use, the session outlives the access token's TTL, and no request ever
 * fails with a 401 the user can see. Before the keep-alive existed, the
 * session simply died at JWT_ACCESS_TTL (15 minutes by default) and the
 * next click bounced to /login mid-task.
 *
 * Why this is a script and not a jest spec: the behaviour lives in the
 * browser (a timer, real activity events, fetch retry-on-401 against real
 * Set-Cookie headers). There is nothing meaningful to assert about it
 * without a browser and a running API, so this drives both.
 *
 * Usage — against a stack already running per README "Local development":
 *
 *   node scripts/verify-session-refresh.mjs
 *
 * It waits out whatever JWT_ACCESS_TTL the API was started with, so for a
 * fast run start the API with a short one (the mechanism is TTL-agnostic):
 *
 *   JWT_ACCESS_TTL=20s pnpm dev:api
 *   SESSION_TTL_SECONDS=20 node scripts/verify-session-refresh.mjs
 *
 * The two modes prove different halves, and both matter:
 *
 *   (default, idle)  Sit still past the TTL, then act. The proactive timer
 *                    deliberately does NOT fire for an idle session, so this
 *                    exercises the retry-on-401 recovery in lib/api.ts.
 *
 *   SOAK_MINUTES=17  Behave like someone actually working — activity every
 *                    30s for longer than the real 15-minute TTL. Here the
 *                    proactive timer is what keeps the session alive, so the
 *                    bar is higher: zero 401s may occur at all, because the
 *                    token should never be allowed to lapse in the first
 *                    place. This is the "left the app open and kept working"
 *                    case that used to end in a forced re-login.
 *
 * Env:
 *   WEB_URL               default http://localhost:3000
 *   EMAIL / PASSWORD      default the seeded Founder / dev password
 *   SESSION_TTL_SECONDS   how long to idle past, default 20 (idle mode)
 *   SOAK_MINUTES          run the active-user soak instead, for this long
 */
import { chromium } from "playwright";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
const EMAIL = process.env.EMAIL ?? "anant.sharma@ammbrands.in";
const PASSWORD = process.env.PASSWORD ?? "Podium123!";
const TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS ?? 20);

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const page = await (await browser.newContext()).newPage();

// Every API response the page makes, so "no 401 reached the user" is an
// observation rather than an assumption. A 401 that is immediately followed
// by a refresh + replay is the mechanism working; one that is not is a bug.
const apiCalls = [];
page.on("response", (res) => {
  const url = new URL(res.url());
  if (url.pathname.startsWith("/api/")) apiCalls.push({ path: url.pathname, status: res.status() });
});

await page.goto(`${WEB_URL}/login`, { waitUntil: "networkidle" });
await page.fill('input[type="email"], input[name="email"]', EMAIL);
await page.fill('input[type="password"], input[name="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 15000 });
check("logs in and lands on the dashboard", page.url().includes("/dashboard"), page.url());

const callsBefore = apiCalls.length;

const soakMinutes = Number(process.env.SOAK_MINUTES ?? 0);
if (soakMinutes > 0) {
  // Active-user soak: real activity every 30s for longer than the token's
  // real lifetime. The proactive timer should keep the session alive the
  // whole way, so a single 401 anywhere is a failure — not something to be
  // recovered from, something that should never have happened.
  const until = Date.now() + soakMinutes * 60 * 1000;
  console.log(`\nsoaking ${soakMinutes} minutes as an active user…`);
  let laps = 0;
  while (Date.now() < until) {
    await page.waitForTimeout(30_000);
    await page.mouse.move(300 + (laps % 40), 300);
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.press("Shift");
    laps += 1;
    if (laps % 4 === 0) {
      // Periodically fetch real data, so "still logged in" is continuously
      // observed rather than only checked at the end.
      await page.goto(`${WEB_URL}${laps % 8 === 0 ? "/projects" : "/vendors"}`, { waitUntil: "networkidle" });
      const elapsed = Math.round((soakMinutes * 60 * 1000 - (until - Date.now())) / 60000);
      console.log(`  ~${elapsed}m: ${page.url().includes("/login") ? "LOGGED OUT" : "still signed in"}`);
    }
  }

  const soakCalls = apiCalls.slice(callsBefore);
  const refreshes = soakCalls.filter((c) => c.path === "/api/auth/refresh" && c.status < 400).length;
  const unauthorized = soakCalls.filter((c) => c.status === 401);

  check("still signed in after the full soak", !page.url().includes("/login"), page.url());
  check("the proactive timer refreshed the session", refreshes > 0, `${refreshes} refresh call(s)`);
  check("not a single request failed with 401", unauthorized.length === 0, JSON.stringify(unauthorized));

  await browser.close();
  console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures.join(", ")}`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

// Idle past the access token's lifetime, then act as a working user would.
// The pointer events also keep the activity gate satisfied, which is what
// distinguishes "someone is using this" from "a tab left open overnight".
const waitMs = (TTL_SECONDS + 5) * 1000;
console.log(`\nidling ${waitMs / 1000}s to outlive the access token…`);
await page.waitForTimeout(waitMs);
await page.mouse.move(400, 400);
await page.mouse.down();
await page.mouse.up();

// A real navigation to a real data screen after expiry: this is the request
// that used to 401 and bounce the user to /login.
await page.goto(`${WEB_URL}/vendors`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const stillIn = !page.url().includes("/login");
check("still authenticated after the access token expired", stillIn, page.url());

const vendorRows = await page.locator("table tbody tr").count();
check("a data screen still loads real rows post-expiry", vendorRows > 0, `${vendorRows} vendor rows`);

const after = apiCalls.slice(callsBefore);
const refreshed = after.some((c) => c.path === "/api/auth/refresh" && c.status < 400);
check("the client actually called /auth/refresh", refreshed);

// Any 401 must have been followed by a successful refresh — i.e. recovered,
// not surfaced. An unrecovered 401 is exactly the old broken behaviour.
const unrecovered = after.filter(
  (c, i) => c.status === 401 && !after.slice(i + 1).some((n) => n.path === "/api/auth/refresh" && n.status < 400),
);
check("no 401 was left unrecovered", unrecovered.length === 0, JSON.stringify(unrecovered));

await browser.close();

console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures.join(", ")}`}`);
process.exit(failures.length === 0 ? 0 : 1);

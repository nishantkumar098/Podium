import { config } from "dotenv";
import { resolve } from "path";

/**
 * §1.9 database isolation. The test suite has its own database, loaded from
 * its own env file — never `.env`, which is whatever a developer has pointed
 * at real or dev data. This used to load `.env` directly, meaning the test
 * suite mutated WHATEVER DATABASE_URL happened to point at; on more than one
 * occasion that was the database holding AMM Brands' real records.
 *
 * `.env.test` is git-ignored (like `.env`); `.env.test.example` is the
 * checked-in template. CI sets these env vars directly rather than writing a
 * file — see .github/workflows/ci.yml.
 */
config({ path: resolve(__dirname, "../../../.env.test"), override: false });

const url = process.env.DATABASE_URL ?? "";
const dbName = url.split("/").pop()?.split("?")[0] ?? "";

if (!dbName.endsWith("_test")) {
  throw new Error(
    `Refusing to run tests: DATABASE_URL resolves to database "${dbName}", whose name does not end "_test".\n` +
      "The test suite TRUNCATES and writes real rows — it must never be pointed at a dev or production database.\n" +
      "Fix: create apps/api/../../.env.test from .env.test.example (see docs/STATUS.md §1.9) so DATABASE_URL " +
      'targets a database like "podium_test".',
  );
}

// The shadow database is legitimately named "..._test_shadow" (Prisma's own
// migrate-diff tooling appends "_shadow"), so the check is "_test appears as
// a real name segment", not "the name ends with _test" — that stricter check
// rejected every valid shadow database name and silently blocked the entire
// suite from running at all until this was caught.
const shadowUrl = process.env.SHADOW_DATABASE_URL ?? "";
const shadowDbName = shadowUrl.split("/").pop()?.split("?")[0] ?? "";
if (shadowUrl && !/(^|_)test(_|$)/.test(shadowDbName)) {
  throw new Error(
    `Refusing to run tests: SHADOW_DATABASE_URL resolves to database "${shadowDbName}", which doesn't look like a test database.`,
  );
}

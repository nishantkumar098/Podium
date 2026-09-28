#!/usr/bin/env node
/**
 * Runs a command against Supabase's TRANSACTION pooler (port 6543) instead of
 * the session pooler (5432).
 *
 * WHY. The session pooler hands each client a dedicated Postgres backend and
 * allows very few of them. Once the deployed app is running it holds those
 * slots, and a maintenance script run from a laptop is simply refused —
 * Prisma reports it as "Can't reach database server", which reads like the
 * database is down when it is merely full.
 *
 * The transaction pooler multiplexes thousands of clients over a small pool,
 * which is exactly right for a short-lived script. It cannot do prepared
 * statements, hence `pgbouncer=true`, and it must not be used for
 * migrations — those need the session pooler or the direct connection.
 *
 * The URL is rewritten in memory only. Nothing is written to disk and the
 * value is never printed.
 *
 * Usage: node scripts/with-txn-pooler.cjs <command> [...args]
 */
const { spawn } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const ROOT_ENV = resolve(__dirname, "../../../.env");
if (existsSync(ROOT_ENV)) {
  for (const line of readFileSync(ROOT_ENV, "utf8").split("\n")) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    let value = (match[2] ?? "").trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

const original = process.env.DATABASE_URL;
if (!original) {
  console.error("with-txn-pooler: DATABASE_URL is not set");
  process.exit(1);
}

try {
  const url = new URL(original);
  url.port = "6543";
  url.searchParams.set("pgbouncer", "true");
  // The transaction pooler is shared; a handful of connections is plenty for
  // a script and leaves the pool alone for everyone else.
  url.searchParams.set("connection_limit", "3");
  process.env.DATABASE_URL = url.toString();
  console.log("Using the transaction pooler (port 6543) for this run.");
} catch {
  console.error("with-txn-pooler: DATABASE_URL is not a URL this can rewrite");
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("with-txn-pooler: no command given");
  process.exit(1);
}

spawn(command, args, { stdio: "inherit", env: process.env, shell: process.platform === "win32" }).on("exit", (code, signal) =>
  process.exit(signal ? 1 : (code ?? 0)),
);

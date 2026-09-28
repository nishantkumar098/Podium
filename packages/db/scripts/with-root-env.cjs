#!/usr/bin/env node
/**
 * Runs a command with the monorepo-root `.env` loaded.
 *
 * Every script in this package is invoked through pnpm, which runs it with
 * cwd = packages/db. The Prisma CLI only auto-loads `.env` from its own cwd,
 * so the root `.env` the README tells you to create was never read: `prisma
 * migrate` failed with `P1012 Environment variable not found: DATABASE_URL`,
 * and the seed script reported `resolved database: ""` — both of which look
 * like a missing/typo'd value rather than a file nobody opened.
 *
 * Real process env always wins: CI sets DATABASE_URL directly and has no
 * `.env` file at all, so values already in the environment are never
 * overwritten, and a missing file is not an error.
 *
 * Usage: node scripts/with-root-env.cjs <command> [...args]
 */
const { spawn } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const ROOT_ENV = resolve(__dirname, "../../../.env");

if (existsSync(ROOT_ENV)) {
  for (const line of readFileSync(ROOT_ENV, "utf8").split("\n")) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match) continue; // blank line or comment
    const key = match[1];
    if (process.env[key] !== undefined) continue; // never clobber a real env var
    let value = (match[2] ?? "").trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1); // strip matching quotes
    process.env[key] = value;
  }
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("with-root-env: no command given");
  process.exit(1);
}

spawn(command, args, { stdio: "inherit", env: process.env, shell: process.platform === "win32" })
  .on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));

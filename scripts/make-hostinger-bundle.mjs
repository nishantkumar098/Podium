/**
 * Builds a flat, self-contained bundle of Podium for managed Node hosting
 * (Hostinger Web Apps, Render, Railway — anything that runs one app).
 *
 *   node scripts/make-hostinger-bundle.mjs
 *
 * WHY A BUNDLE RATHER THAN THE REPOSITORY. The repository is a pnpm
 * workspace whose packages are consumed as TypeScript source. That is right
 * for development and fine inside the Docker image, which controls its own
 * Node version and package manager. Managed hosting controls neither: it
 * runs `npm install` on whatever Node version it happens to offer. Handing it
 * the workspace means betting on pnpm being available AND on Node being
 * 22.18+ (for the type stripping `@podium/db` relies on).
 *
 * So this produces something that needs neither bet:
 *
 *   - every workspace package is COMPILED to JavaScript first, so the host's
 *     Node version only has to be new enough to run the output (18+), not new
 *     enough to execute TypeScript;
 *   - workspace links become ordinary folders under `vendor/`, referenced by
 *     `file:` paths, so plain `npm install` resolves them;
 *   - the web app ships already built, so the host never runs `next build`
 *     (which is the slowest and most memory-hungry step, and the one most
 *     likely to be killed on a small plan).
 *
 * The host's only jobs are `npm install` (which fetches third-party packages
 * and generates the Prisma client for Linux) and `npm start`.
 *
 * LAYOUT, and why the odd bits are the way they are:
 *
 *   package.json          flat npm manifest; "start" runs server/main.js
 *   .env                  YOU create this on the host (see .env.example)
 *   server/main.js        the merged entry point (apps/server, compiled)
 *   web/                  the built Next.js app (.next-prod + config)
 *   vendor/api/src/       the compiled API. `src` is deliberate: the entry
 *                         point imports "@podium/api/src/app.module", so the
 *                         compiled files have to sit where that path points.
 *                         Renaming it would mean a source change that only
 *                         exists for the bundle, which is worse.
 *   vendor/db/            compiled @podium/db
 *   vendor/shared-types/  compiled @podium/shared-types
 *   prisma/schema.prisma  read by `prisma generate` during npm install
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "..", "podium-app");

const run = (cmd) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
};
const step = (msg) => console.log(`\n=== ${msg}`);

/**
 * `prisma generate` rewrites a native .dll on Windows, which fails with
 * EPERM whenever anything else has the Prisma engine loaded — a running
 * `pnpm dev:api` is enough. The generated JavaScript client is not what
 * fails; only the engine swap is, and the client on disk is already the one
 * the build needs.
 *
 * So a failure here is tolerated ONLY when the generated client is provably
 * newer than the schema it came from. If the schema has moved on, the build
 * stops, because shipping a client that predates a migration would fail at
 * runtime with a confusing "column does not exist".
 */
function generatePrismaClient() {
  const client = resolve(ROOT, "node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/.prisma/client/index.d.ts");
  const schema = resolve(ROOT, "packages/db/prisma/schema.prisma");
  try {
    run("pnpm --filter @podium/db generate");
    return;
  } catch (err) {
    if (!existsSync(client)) throw err;
    const clientAt = statSync(client).mtimeMs;
    const schemaAt = statSync(schema).mtimeMs;
    if (clientAt < schemaAt) {
      throw new Error(
        "prisma generate failed and the client on disk is older than the schema.\n" +
          "Stop anything using the database (pnpm dev:api, a running server) and try again.",
      );
    }
    console.log("\n  ! prisma generate could not swap its engine (a dev server has it open).");
    console.log("  ! The generated client is newer than the schema, so the build continues.\n");
  }
}

// ---------------------------------------------------------------- 1. build
step("Compiling every workspace package to JavaScript");
run("pnpm --filter @podium/shared-types build");
generatePrismaClient();
run("pnpm exec tsc -p packages/db/tsconfig.build.json");
run("pnpm --filter @podium/api build");
run("pnpm --filter @podium/web build");
run("pnpm --filter @podium/server build");

// ------------------------------------------------------------- 2. assemble
step(`Assembling ${OUT}`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const copy = (from, to) => {
  const src = resolve(ROOT, from);
  if (!existsSync(src)) throw new Error(`missing build output: ${from} — did an earlier step fail?`);
  cpSync(src, join(OUT, to), { recursive: true });
  console.log(`  ${from} -> ${to}`);
};

copy("apps/server/dist", "server");
copy("apps/api/dist", "vendor/api/src");
copy("packages/db/dist", "vendor/db/dist");
copy("packages/shared-types/dist", "vendor/shared-types/dist");
copy("packages/db/prisma/schema.prisma", "prisma/schema.prisma");
copy("packages/db/prisma/migrations", "prisma/migrations");

// The web app: the build output, its config (distDir + rewrites) and the
// static assets Next serves itself.
copy("apps/web/.next-prod", "web/.next-prod");
copy("apps/web/next.config.mjs", "web/next.config.mjs");
if (existsSync(resolve(ROOT, "apps/web/public"))) copy("apps/web/public", "web/public");
writeFileSync(join(OUT, "web/package.json"), JSON.stringify({ name: "podium-web", private: true, version: "0.1.0" }, null, 2) + "\n");

// Fonts and any other non-TS assets the API reads at runtime (letterhead
// logo, signature image) live beside the source and are not emitted by tsc.
for (const assets of ["apps/api/src/letters/assets", "apps/api/src/invoices/assets"]) {
  if (existsSync(resolve(ROOT, assets))) copy(assets, `vendor/api/src/${assets.split("/src/")[1]}`);
}

// ------------------------------------------------- 3. the vendor manifests
const vendorPkg = (name, dir) =>
  writeFileSync(
    join(OUT, dir, "package.json"),
    JSON.stringify({ name, version: "0.1.0", private: true, main: "dist/index.js", types: "dist/index.d.ts" }, null, 2) + "\n",
  );
vendorPkg("@podium/db", "vendor/db");
vendorPkg("@podium/shared-types", "vendor/shared-types");
writeFileSync(
  join(OUT, "vendor/api/package.json"),
  JSON.stringify({ name: "@podium/api", version: "0.1.0", private: true, main: "src/main.js" }, null, 2) + "\n",
);

// ---------------------------------------------------- 4. the npm manifest
step("Writing the flat package.json");
const apiPkg = JSON.parse(readFileSync(resolve(ROOT, "apps/api/package.json"), "utf8"));
const webPkg = JSON.parse(readFileSync(resolve(ROOT, "apps/web/package.json"), "utf8"));
const serverPkg = JSON.parse(readFileSync(resolve(ROOT, "apps/server/package.json"), "utf8"));

const deps = {};
for (const pkg of [apiPkg, webPkg, serverPkg]) {
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    // Workspace links become folders; everything else keeps its range.
    if (version.startsWith("workspace:")) continue;
    deps[name] = version;
  }
}
// Redis and BullMQ belonged to the worker process, which this deployment
// does not run — the sweeps are in-process crons here. Leaving them in would
// download two large packages nothing requires.
delete deps.bullmq;
delete deps.ioredis;
// Prisma's CLI is needed at install time to generate the client for the
// host's own platform; @prisma/client is what the code imports.
deps["@prisma/client"] = "^5.22.0";
deps.prisma = "^5.22.0";
deps["@podium/api"] = "file:./vendor/api";
deps["@podium/db"] = "file:./vendor/db";
deps["@podium/shared-types"] = "file:./vendor/shared-types";

writeFileSync(
  join(OUT, "package.json"),
  JSON.stringify(
    {
      name: "podium",
      version: "0.1.0",
      private: true,
      description: "Podium — AMM Brands LLP. One Node process: the web app and the API on a single port.",
      engines: { node: ">=18.18" },
      scripts: {
        // Runs automatically after `npm install`: builds the Prisma query
        // engine for the host's platform, which cannot be shipped from Windows.
        postinstall: "prisma generate --schema=./prisma/schema.prisma",
        // A no-op, on purpose: some hosts run `npm run build`
        // unconditionally and fail the deploy on a missing script. Everything
        // here is already compiled.
        build: "echo Already built by scripts/make-hostinger-bundle.mjs",
        start: "node server/main.js",
        migrate: "prisma migrate deploy --schema=./prisma/schema.prisma",
      },
      dependencies: Object.fromEntries(Object.entries(deps).sort()),
    },
    null,
    2,
  ) + "\n",
);

// ------------------------------------------------------- 5. env + readme
copy(".env.production.example", ".env.example");
writeFileSync(
  join(OUT, "README.md"),
  `# Podium — deploy bundle

Everything here is already compiled. The host only has to install
dependencies and start it.

## Settings

Copy \`.env.example\` to \`.env\` in this folder (or paste the same keys into
the host's environment-variables panel) and fill in every \`<...>\`.

The only ones that must be right for it to boot:

    DATABASE_URL     the Supabase connection string
    DIRECT_URL       the same, without the connection limit
    JWT_ACCESS_SECRET    a long random value
    JWT_REFRESH_SECRET   a long random value
    WEB_BASE_URL     https://your-domain

Set \`PODIUM_INLINE_SCHEDULER=1\` to run the periodic sweeps (invoice overdue,
flow SLA, automation) inside this process. Leave it unset if something else
runs them — never both.

## Commands

    npm install     installs dependencies and generates the Prisma client
    npm start       starts Podium on $PORT (default 3000)

Database migrations are already applied to Supabase. If a future version adds
one, run \`npm run migrate\` once before starting.

## What this is

One Node process serving the website and the API on the same port, with
\`/api/*\` handled by NestJS and everything else by Next.js. There is no
Docker, no Redis and no separate worker. Built by
\`scripts/make-hostinger-bundle.mjs\` in the Podium repository — do not edit
files here by hand; they are overwritten on every build.
`,
);

step("Done");
console.log(`\nBundle: ${OUT}`);
console.log("Next: zip that folder and upload it, or point the host's Git import at it.");

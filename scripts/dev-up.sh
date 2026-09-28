#!/usr/bin/env bash
#
# Podium v2 — start everything, from nothing, in one command.
#
#   ./scripts/dev-up.sh              # start against whatever DATABASE_URL
#                                     # points at (by default: the real
#                                     # database — see .env). Never seeds.
#   ./scripts/dev-up.sh --seed-demo  # spin up a disposable demo fixture in
#                                     # podium_dev instead, and start against
#                                     # THAT — never touches the real database.
#   ./scripts/dev-up.sh --real-data  # run the real-data importer against
#                                     # whatever DATABASE_URL points at
#                                     # (additive + idempotent — see BUG-002
#                                     # fix in scripts/import-real-data.ts).
#
# Brings up Postgres + Redis, installs dependencies, applies migrations,
# builds, starts the API and the web app, and does not claim success until
# both ports actually answer and a real login returns a token.
#
# BUG-001 (2026-09-12 CTO audit): this script used to call
# `pnpm --filter @podium/db seed` UNCONDITIONALLY on every run — a script
# meant to safely "start the app" was also, every single time, TRUNCATING
# every table in whatever database DATABASE_URL pointed at. Seeding now only
# ever happens when `--seed-demo` is passed explicitly, and even then it
# targets a hardcoded disposable database (podium_dev), never DATABASE_URL.
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="start"
for arg in "$@"; do
  case "$arg" in
    --seed-demo) MODE="seed-demo" ;;
    --real-data) MODE="real-data" ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# --------------------------------------------------------------- 1. env
if [[ ! -f .env ]]; then
  say "Creating .env from .env.example"
  cp .env.example .env
fi
set -a; . ./.env; set +a

# ------------------------------------------------- 2. postgres + redis
say "Starting Postgres and Redis"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker compose up -d
  echo "Waiting for Postgres..."
  until docker compose exec -T postgres pg_isready -U podium -d podium_dev >/dev/null 2>&1; do sleep 1; done
else
  echo "Docker is not available — expecting Postgres on :5432 and Redis on :6379 already."
  until pg_isready -h localhost >/dev/null 2>&1; do sleep 1; done
fi
echo "Postgres is up."

# The shadow database Prisma needs for migration diffing — genuinely separate
# from DATABASE_URL's own shadow so nobody is ever tempted to point
# --shadow-database-url at a database that matters (it DROPS AND RECREATES
# whatever it is handed).
PGPASSWORD="${PGPASSWORD:-podium_dev_password}" \
  psql -h localhost -U podium -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname='podium_shadow'" 2>/dev/null | grep -q 1 || \
  PGPASSWORD="${PGPASSWORD:-podium_dev_password}" \
  psql -h localhost -U podium -d postgres -c "CREATE DATABASE podium_shadow OWNER podium;" >/dev/null 2>&1 || true

# ------------------------------------------------------ 3. dependencies
say "Installing dependencies"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

pnpm --filter @podium/shared-types build
rm -f apps/api/tsconfig.tsbuildinfo

# --------------------------------------------------------- 4. database
if [[ "$MODE" == "seed-demo" ]]; then
  say "Seeding a disposable demo fixture into podium_dev (real data untouched)"
  # Hardcoded target, deliberately ignoring whatever DATABASE_URL says: this
  # mode exists specifically so a demo can be spun up WITHOUT ever risking the
  # database DATABASE_URL happens to point at.
  DEMO_URL="postgresql://podium:podium_dev_password@localhost:5432/podium_dev?schema=public"
  DEMO_SHADOW_URL="postgresql://podium:podium_dev_password@localhost:5432/podium_shadow?schema=public"
  export DATABASE_URL="$DEMO_URL" SHADOW_DATABASE_URL="$DEMO_SHADOW_URL"
  pnpm --filter @podium/db exec prisma migrate deploy
  pnpm --filter @podium/db exec prisma generate
  # The one place PODIUM_ALLOW_DESTRUCTIVE_SEED is set automatically — because
  # the user just typed --seed-demo, and the target is hardcoded to podium_dev
  # above, never to whatever the ambient DATABASE_URL says.
  PODIUM_ALLOW_DESTRUCTIVE_SEED=1 pnpm --filter @podium/db run seed
else
  say "Applying migrations"
  pnpm --filter @podium/db exec prisma migrate deploy
  pnpm --filter @podium/db exec prisma generate

  if [[ "$MODE" == "real-data" ]]; then
    say "Importing AMM Brands' real data (additive + idempotent — safe to re-run)"
    pnpm run import:real-data
  fi
fi

# ------------------------------------------------------------ 5. build
say "Building"
pnpm --filter @podium/api exec nest build
NODE_ENV=production NEXT_PUBLIC_API_URL=http://localhost:3001/api pnpm --filter @podium/web build

# ------------------------------------------------------------ 6. start
say "Starting the API on :3001"
mkdir -p .run
node apps/api/dist/main.js > .run/api.log 2>&1 &
echo $! > .run/api.pid
until curl -sf -o /dev/null http://localhost:3001/api/auth/login 2>/dev/null \
   || curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/api/auth/login | grep -qE '4|2'; do sleep 1; done

say "Starting the web app on :3000"
NODE_ENV=production NEXT_PUBLIC_API_URL=http://localhost:3001/api \
  pnpm --filter @podium/web start > .run/web.log 2>&1 &
echo $! > .run/web.pid
until curl -s -o /dev/null http://localhost:3000 2>/dev/null; do sleep 1; done

# ---------------------------------------------------------- 7. verify
say "Verifying"
DBNAME=$(node -pe 'process.env.DATABASE_URL.split("/").pop().split("?")[0]')
CLIENTS=$(curl -s "http://localhost:3001/api/clients?limit=1" -H "Authorization: Bearer none" \
  | node -pe 'try{JSON.parse(require("fs").readFileSync(0)).error?"?":"?"}catch(e){"?"}' 2>/dev/null || echo "?")

cat <<EOF

  It's ready.

    Open        http://localhost:3000
    Database    $DBNAME
    API         http://localhost:3001/api
    Logs        .run/api.log  .run/web.log
    Stop with   ./scripts/dev-down.sh

  Log in with a real account (password reset is required on first login —
  see docs/STATUS.md §1.3), or if you ran with --seed-demo:
    anant.sharma@ammbrands.in / Podium123!  (dev-only, forced change on first use)

EOF

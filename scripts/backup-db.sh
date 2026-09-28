#!/usr/bin/env bash
#
# Podium v2 — database backup.
#
# The database now holds 65,000+ real, irreplaceable AMM Brands records
# (clients, vendors, staffing, the live pipeline). Those did not come from a
# seed script and cannot be regenerated: losing them means going back to the
# spreadsheets and re-importing, and losing anything created in Podium since.
#
# Writes a compressed custom-format dump (restorable with pg_restore, and
# selectively restorable table by table), verifies it is readable before
# declaring success, and prunes dumps older than the retention window.
#
# Usage:
#   scripts/backup-db.sh                     # uses DATABASE_URL from .env
#   PODIUM_BACKUP_DIR=/mnt/backups scripts/backup-db.sh
#   PODIUM_BACKUP_RETENTION_DAYS=30 scripts/backup-db.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${PODIUM_BACKUP_DIR:-$ROOT/backups}"
RETENTION_DAYS="${PODIUM_BACKUP_RETENTION_DAYS:-14}"

if [[ -z "${DATABASE_URL:-}" && -f "$ROOT/.env" ]]; then
  set -a; . "$ROOT/.env"; set +a
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set and no .env was found." >&2
  exit 1
fi

# Prisma's DATABASE_URL carries ?schema=public, which libpq rejects as an
# unknown URI parameter. Strip Prisma-only parameters before handing it to
# pg_dump rather than asking the operator to maintain a second URL.
PG_URL="$DATABASE_URL"
PG_URL="${PG_URL//\?schema=public/}"
PG_URL="${PG_URL//&schema=public/}"
PG_URL="$(printf '%s' "$PG_URL" | sed -E 's/[?&]schema=[^&]*//g')"

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/podium-$STAMP.dump"

# --format=custom is what makes selective restore possible; --no-owner keeps the
# dump restorable into a database owned by a different role.
echo "Dumping to $OUT ..."
pg_dump --dbname="$PG_URL" --format=custom --compress=9 --no-owner --file="$OUT"

# A dump that cannot be listed is not a backup. Verify before trusting it.
if ! pg_restore --list "$OUT" > /dev/null 2>&1; then
  echo "FAILED: the dump is not readable by pg_restore. Not keeping it." >&2
  rm -f "$OUT"
  exit 1
fi

TABLES=$(pg_restore --list "$OUT" | grep -c "TABLE DATA" || true)
SIZE=$(du -h "$OUT" | cut -f1)
echo "OK: $OUT ($SIZE, $TABLES tables with data)"

# Refuse to silently produce an empty backup.
if [[ "$TABLES" -lt 10 ]]; then
  echo "FAILED: only $TABLES tables carry data — that is not a whole-database backup." >&2
  exit 1
fi

DELETED=$(find "$BACKUP_DIR" -name 'podium-*.dump' -type f -mtime "+$RETENTION_DAYS" -print -delete | wc -l)
[[ "$DELETED" -gt 0 ]] && echo "Pruned $DELETED dump(s) older than $RETENTION_DAYS days."

echo "Restore with:  pg_restore --dbname=\"\$PG_URL\" --clean --if-exists --no-owner \"$OUT\""

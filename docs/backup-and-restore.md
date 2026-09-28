# Backup and restore

## Why this exists

Until 2026-09-11 every row in this database came from `pnpm --filter @podium/db
seed` and could be recreated in seconds. That is no longer true. The database
now holds **65,000+ real AMM Brands records** — 568 event clients, 51,456
Cocktail Shop customers, 163 vendors, 171 freelancers and 12,750 leads — plus
anything created in Podium since.

Those cannot be regenerated. Re-importing the spreadsheets would restore the
imported rows but lose every project, invoice, task, flow, movement and audit
entry created afterwards.

A real incident already happened during development: pointing Prisma's
`--shadow-database-url` at the live database wiped it. That was survivable only
because the data was still seed-generated. The same mistake today would be a
genuine loss, which is what this page is for.

## Taking a backup

```bash
./scripts/backup-db.sh                          # -> ./backups/podium-<UTC stamp>.dump
PODIUM_BACKUP_DIR=/var/backups/podium ./scripts/backup-db.sh
PODIUM_BACKUP_RETENTION_DAYS=30 ./scripts/backup-db.sh
```

The script:

- writes a **custom-format** dump (`pg_dump --format=custom --compress=9`), so a
  single table can be restored without replaying the whole database;
- strips Prisma's `?schema=public` from `DATABASE_URL`, which libpq rejects;
- **verifies the dump is readable** with `pg_restore --list` and deletes it if
  not — a corrupt file that looks like a backup is worse than no file;
- **fails if fewer than 10 tables carry data**, so a half-finished dump cannot
  pass as a whole-database backup;
- prunes dumps older than the retention window.

## Scheduling it

`scripts/podium-backup.cron` holds a ready crontab line (02:15 nightly, 30-day
retention). Install it with:

```bash
crontab -l | cat - scripts/podium-backup.cron | crontab -
```

**Point `PODIUM_BACKUP_DIR` at storage that is not the database's own disk.**
A backup that dies with the host has not protected anything. Copying the dumps
off-host (S3, a mounted NAS, restic/borg to a remote) is the operator's
decision; the script deliberately writes a plain file any of those can pick up
rather than baking in one provider.

## Restoring

```bash
# Full restore, replacing what is there:
pg_restore --dbname="$DATABASE_URL_WITHOUT_SCHEMA_PARAM" --clean --if-exists --no-owner backups/podium-<stamp>.dump

# One table only (custom format makes this possible):
pg_restore --dbname="$PG_URL" --data-only --table=clients backups/podium-<stamp>.dump
```

Note `DATABASE_URL` must have `?schema=public` stripped, exactly as the backup
script does it.

## Verified, not assumed

On 2026-09-11 a dump was taken and **restored into the `podium_shadow`
database**, and the row counts compared table by table:

```
  clients                real=8        restored=8        MATCH
  vendors                real=8        restored=8        MATCH
  freelancers            real=8        restored=8        MATCH
  leads                  real=13       restored=13       MATCH
  users                  real=15       restored=15       MATCH
  inventory_movements    real=125      restored=125      MATCH
  audit_logs             real=24       restored=24       MATCH
```

(The counts are small because that check ran against the seeded test fixture,
not the production import — what it proves is that the dump/restore cycle is
sound, which is the part that was never verified before.)

**Re-run this check whenever the backup script changes.** A backup nobody has
restored is a hypothesis.

## Still to do

- Off-host replication is not configured — dumps currently land on the same
  machine. This is the single biggest remaining gap.
- Point-in-time recovery (WAL archiving) is not set up; the recovery point is
  therefore "last nightly dump", i.e. up to 24 hours of loss.
- No automated restore drill. The check above was run by hand.

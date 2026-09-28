# Putting Podium live on Hostinger

Podium runs on **one Hostinger VPS** with Docker: the web app, the API, the
background workers, Redis, and Caddy for HTTPS. The database stays on
Supabase, exactly as today — everyone signs in to the same data.

> **It must be a VPS (KVM plan), not shared / web / "Node.js" hosting.**
> Podium keeps an API, workers and Redis running all the time, which shared
> hosting cannot do.

Files involved: `Dockerfile`, `docker-compose.prod.yml`, `deploy/Caddyfile`,
`.env.production.example`.

---

## 1. Get the server

In Hostinger: **VPS → KVM 2** (2 vCPU, 8 GB RAM) or larger.

- **Location:** India (Mumbai) — closest to the team.
- **Operating system:** *Ubuntu 24.04 with Docker* (Hostinger's Docker
  template). Plain Ubuntu 24.04 also works; install Docker in step 4.
- Set a strong root password (or add your SSH key). Note the server's **IP
  address** from the VPS dashboard.

## 2. Point your domain at it

AMM's domain is registered at **GoDaddy**. Leave it there and leave the
nameservers alone — moving the domain or repointing nameservers at Hostinger
buys nothing here and is a good way to break the company's e-mail. Caddy
proves the domain over plain HTTP, so all it needs is one A record.

GoDaddy → **My Products** → the domain → **DNS** → **Add New Record**:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `podium` | the server's IP | Custom → 600 |

This gives `podium.yourdomain.com`. Check it has taken effect before step 6 —
`nslookup podium.yourdomain.com` should answer with the server's IP. GoDaddy
usually publishes within minutes, occasionally up to an hour.

Three things that catch people out:

- **Use a subdomain, not the bare domain.** GoDaddy ships a parked `A` record
  on `@`. Using the bare name means *editing* that record, not adding a
  second one, or DNS returns two conflicting answers.
- **Turn off Domain Forwarding** for the name you are using (DNS page →
  *Forwarding*). It overrides the A record.
- **Leave `MX` and `TXT` alone.** Adding a subdomain A record does not affect
  e-mail; changing those would.

## 3. Get the code onto the server

**Option A — GitHub (recommended; updates are one command later).** The
project's repository is `github.com/nishantkumar098/Podium`. Commit and push
the current code from your computer first, then on the server clone it (for a
private repo GitHub asks for your username and a *personal access token* as
the password — create one at GitHub → Settings → Developer settings →
Personal access tokens, with read access to the repo).

**Option B — upload a zip.** Easiest once the code is committed: git builds
a clean zip containing only the project files (everything in `.gitignore` is
left out automatically):

```bash
git archive --format=zip -o podium.zip HEAD
scp podium.zip root@SERVER_IP:/root/
```

Making the zip by hand instead? **Leave these out:**

| Leave out | Why |
|---|---|
| `node_modules` (in the root *and* inside `apps/*`, `packages/*`, `workers`) | Installed fresh on the server; huge, and Windows builds don't run on Linux |
| `apps/web/.next`, `apps/web/.next-prod` | Build output — rebuilt on the server |
| `apps/api/dist`, `packages/*/dist` | Build output — rebuilt on the server |
| `.env`, `.env.test`, `.env.local`, `.env.production` | Your secrets (database password, keys) — the server gets its own `.env.production` |
| `.local-storage` | Uploaded documents — copied separately in step 7 |
| `.git` | Not needed to run (keep it only if you'll `git pull` on the server) |
| `.claude`, `.vscode`, `.idea` | Local tool settings |
| `backups`, `.local-verify`, `coverage`, `test-results`, `playwright-report`, `*.log`, `dump.rdb` | Local scratch output |
| any `*.zip` / `*.tgz` | Old archives |

Keep everything else — in particular `Dockerfile`, `docker-compose.prod.yml`,
`deploy/`, `.env.production.example`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
`package.json`, `apps/`, `packages/`, `workers/`, `scripts/`.

On the server, unzip it: `apt install -y unzip && unzip podium.zip -d podium && cd podium`.

## 4. On the server

Connect: `ssh root@SERVER_IP` (or Hostinger's browser terminal).

```bash
# Docker (skip if you chose the Docker template)
curl -fsSL https://get.docker.com | sh

# Firewall: SSH, HTTP, HTTPS only
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

# The code (option A)
git clone https://github.com/nishantkumar098/Podium.git podium && cd podium
# ...or (option B)
apt install -y unzip && unzip podium.zip -d podium && cd podium
```

## 5. Settings

```bash
cp .env.production.example .env.production
openssl rand -hex 48   # run twice: one for JWT_ACCESS_SECRET, one for JWT_REFRESH_SECRET
openssl rand -hex 32   # for GOOGLE_TOKEN_KEY
nano .env.production
```

Fill in every `<...>`: your domain (three times — `DOMAIN`, `WEB_BASE_URL`,
`GOOGLE_OAUTH_REDIRECT_URI`), the Supabase `DATABASE_URL` and `DIRECT_URL`
(copy both from the `.env` on your own computer), and the secrets you just
generated. Save with Ctrl+O, Enter, Ctrl+X.

## 6. Start it

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

The first build takes 5–10 minutes. It then applies any pending database
migrations, starts everything, and Caddy fetches the HTTPS certificate.
Open **https://podium.yourdomain.com** and sign in.

Check on it:

```bash
docker compose -f docker-compose.prod.yml ps          # everything "running"/"healthy"
docker compose -f docker-compose.prod.yml logs -f api  # API log (Ctrl+C to stop following)
```

## 7. Bring over the uploaded documents

Documents uploaded so far live in `.local-storage` on the computer that has
been running Podium. Copy them to the server once:

```bash
# on your computer, from the podium folder
scp -r .local-storage/local root@SERVER_IP:/root/podium-docs
# on the server, from ~/podium
docker compose -f docker-compose.prod.yml cp /root/podium-docs/. api:/data/storage/local/
```

## Updating later

```bash
cd ~/podium
git pull                                              # (option A) or upload a new archive (option B)
docker compose -f docker-compose.prod.yml up -d --build
```

Migrations run automatically on every start.

## Good to know

- **One database.** The live site and anyone running Podium on their own
  computer share the same Supabase data. Once live, stop running the local
  copy for day-to-day work, and keep scripts (imports, fixes) deliberate.
- **Database connections.** Supabase's pooler allows a limited number of
  connections. If the API logs "too many clients", lower `connection_limit`
  in `DATABASE_URL` (e.g. `connection_limit=3`) and make sure no local copy is
  also connected.
- **Speed.** The database is in Sydney. A Mumbai server is already much closer
  than an office in India, but moving the Supabase project to Mumbai
  (ap-south-1) would make every screen noticeably faster.
- **Backups.** Supabase backs up the database (check your plan's retention;
  see `docs/backup-and-restore.md`). Uploaded documents live in the `storage`
  Docker volume — back it up with
  `docker run --rm -v podium_storage:/d -v $PWD:/b alpine tar czf /b/documents-$(date +%F).tgz -C /d .`
- **Google & e-mail.** Both start disabled. To turn them on, fill in the
  Google / SMTP settings in `.env.production` (see `docs/integration-setup.md`;
  the Google redirect URI must be `https://<your domain>/mail/connect`), then
  run the start command again.

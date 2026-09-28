# Podium — one image for the web app, the API, the background workers and
# database migrations; docker-compose.prod.yml runs it with a different
# command per service.
#
# Node 22 is required, not just preferred: @podium/db is consumed as
# TypeScript source (packages/db/src/index.ts) and Node 22.18+ runs it
# natively (type stripping). Don't drop to Node 20.

FROM node:22-bookworm-slim

# Prisma's query engine needs OpenSSL; CA certificates for TLS to the
# database, Google and mail.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# pnpm at the version pinned in package.json ("packageManager").
RUN corepack enable

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile

# Where the web app forwards /api calls to. Next.js bakes rewrites into the
# build, so this is set at build time: the API service's name on the
# compose network.
ARG API_INTERNAL_URL=http://api:3001
ENV API_BASE_URL=$API_INTERNAL_URL

RUN pnpm --filter @podium/shared-types build \
 && pnpm --filter @podium/db generate \
 && pnpm --filter @podium/api build \
 && pnpm --filter @podium/web build

ENV NODE_ENV=production

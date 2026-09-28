import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { AppModule } from "@podium/api/src/app.module";
import cookieParser from "cookie-parser";
import express from "express";
import next from "next";
import { resolve } from "node:path";

/**
 * Podium as ONE process.
 *
 * WHY THIS EXISTS. Podium normally runs as six containers: web, api,
 * workers, redis, caddy and a migration job. That is the right shape on a
 * server you control, and `docker-compose.prod.yml` still runs it that way.
 *
 * It is the wrong shape for managed "run my Node app" hosting — Hostinger's
 * Web Apps, Render, Railway and the rest — which gives you exactly one
 * process, one port, and no Redis. This entry point collapses Podium into
 * that shape without forking a single line of business logic:
 *
 *   - Express is created first, and NestJS is mounted onto it through
 *     ExpressAdapter rather than creating its own server. Every controller,
 *     guard, interceptor and filter is the same code the container build
 *     runs; nothing about the API is re-implemented here.
 *   - Next.js is started in-process and handles everything Nest did not.
 *     Because both live behind one origin, the httpOnly session cookie works
 *     exactly as it does behind Caddy — no CORS, no cross-site cookie rules.
 *   - The scheduled sweeps move back in-process. See
 *     apps/api/src/common/scheduler — with one process there is no second
 *     instance to double-fire them, which was the only reason they were
 *     moved out to a Redis-backed worker.
 *
 * ORDER MATTERS, AND NOT IN THE OBVIOUS DIRECTION. The natural reading is
 * "register Nest first, then a catch-all for Next" — that does not work.
 * Nest installs its own not-found handler across the whole Express instance
 * when it owns the adapter, so every page request was answered with
 * `{"error":{"code":"NOT_FOUND"}}` and the website never loaded at all.
 *
 * So the Next handler goes on FIRST, as a middleware that steps aside for
 * `/api` and answers everything else. Nest then only ever sees its own
 * routes, and its not-found handler is correct rather than catastrophic.
 */

/** Requests Nest owns. Everything else belongs to the web app. */
function isApiRequest(url: string): boolean {
  return url === "/api" || url.startsWith("/api/");
}

const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 3000);

/**
 * Where the built web app lives. Two layouts are supported, because the
 * deploy bundle is flatter than the repository:
 *   repo    apps/server/dist/main.js  ->  ../../web
 *   bundle  dist/main.js              ->  ./web
 */
function webDir(): string {
  const fromRepo = resolve(__dirname, "../../web");
  const fromBundle = resolve(__dirname, "../web");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  return existsSync(resolve(fromRepo, "package.json")) ? fromRepo : fromBundle;
}

async function bootstrap() {
  const web = next({ dev: false, dir: webDir() });
  await web.prepare();
  const handle = web.getRequestHandler();

  const server = express();
  // Managed hosting always sits behind a proxy, so the visitor's real IP
  // (rate limiting, audit log) is in X-Forwarded-For rather than the socket.
  server.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1) || 1);
  server.use((req, res, forward) => {
    if (isApiRequest(req.url)) return forward();
    void handle(req, res);
  });

  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), {
    // Same origin, so there is no cross-site request to allow.
    cors: false,
  });
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  await app.init();

  await new Promise<void>((done) => server.listen(PORT, done));
  Logger.log(`Podium listening on http://localhost:${PORT} (API at /api)`, "Bootstrap");
}

bootstrap().catch((err) => {
  console.error("Podium failed to start:", err);
  process.exit(1);
});

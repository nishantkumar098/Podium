import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from "@nestjs/common";
import type { Request, Response } from "express";
import { finalize, from, Observable, tap } from "rxjs";
import type { RequestUser } from "../types";

/**
 * A short-lived, per-user cache of GET responses.
 *
 * Every database round trip crosses to Sydney (~320 ms measured), and a
 * typical screen's endpoint makes several, so an unchanged list cost 1–4 s
 * each time it was asked for again — on reload, when the same data backs
 * two components, or when the client prefetches a screen before it opens.
 *
 * Correctness rests on three rules:
 *  - The key is the user AND the full URL (query string included, which is
 *    where the city scope travels), so one person's permission-scoped view
 *    is never served to another.
 *  - ANY successful non-GET request clears the whole cache. All writes a
 *    user can make go through this API process, so the next read after a
 *    save is always fresh. A generation counter stops a read that began
 *    before a write from storing its now-stale result after the clear.
 *  - Data that changes outside this API's requests is never cached: Google
 *    mail/calendar, chat, notifications (written by background jobs), auth.
 *    Everything else ages out after TTL_MS regardless.
 */
const TTL_MS = 60_000;
const MAX_ENTRIES = 2_000;
const SKIP = ["/api/auth", "/api/health", "/api/notifications", "/api/chat", "/api/mail", "/api/calendar", "/api/me/calendar", "/api/google", "/api/meetings", "/api/channels", "/api/messages"];

const cache = new Map<string, { value: unknown; expiresAt: number }>();
const inflight = new Map<string, Promise<unknown>>();
let generation = 0;

/** Drops every cached response (called on each write, and available to jobs that write directly). */
export function clearReadCache(): void {
  generation += 1;
  cache.clear();
  inflight.clear();
}

@Injectable()
export class ReadCacheInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    const res = context.switchToHttp().getResponse<Response>();

    if (req.method !== "GET" && req.method !== "HEAD") {
      // Clear before (so no read started during the write is served from the
      // old state) and after (so nothing stored meanwhile survives it).
      clearReadCache();
      return next.handle().pipe(finalize(() => clearReadCache()));
    }

    const user = req.user;
    const url = req.originalUrl;
    if (!user || SKIP.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`))) return next.handle();

    const key = `${user.id}|${url}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      res.setHeader("X-Read-Cache", "hit");
      return from(Promise.resolve(hit.value));
    }
    // The same screen asked for twice at once (prefetch + open) shares one trip.
    const pending = inflight.get(key);
    if (pending) {
      res.setHeader("X-Read-Cache", "shared");
      return from(pending);
    }

    const startedAt = generation;
    let settle: (v: unknown) => void = () => undefined;
    let fail: (e: unknown) => void = () => undefined;
    const shared = new Promise<unknown>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    shared.catch(() => undefined);
    inflight.set(key, shared);

    res.setHeader("X-Read-Cache", "miss");
    return next.handle().pipe(
      tap({
        next: (value) => {
          settle(value);
          // Only plain JSON bodies: a handler that streamed via @Res() returns
          // undefined, and files are never worth holding in memory.
          const cacheable = value !== undefined && !(value instanceof StreamableFile) && !Buffer.isBuffer(value) && res.statusCode < 300;
          if (cacheable && startedAt === generation) {
            if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
            cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
          }
        },
        error: (e) => fail(e),
      }),
      finalize(() => {
        // A handler that completed without a value must not leave a waiter hanging.
        fail(new Error("Request completed without a response body."));
        if (inflight.get(key) === shared) inflight.delete(key);
      }),
    );
  }
}

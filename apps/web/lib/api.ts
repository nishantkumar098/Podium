"use client";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/**
 * An in-flight refresh, shared by every caller. Without this, a page that
 * fires six queries at once against an expired access token would send six
 * concurrent `/auth/refresh` calls — and since refresh *rotates* the token,
 * five of them would present an already-revoked one and fail, logging the
 * user out for being active. One refresh, awaited by everyone.
 */
let refreshInFlight: Promise<boolean> | null = null;

/**
 * When the session was last refreshed, persisted across page loads.
 *
 * A full page load remounts AuthProvider and resets its refs — so with
 * this held only in memory, the keep-alive's 10-minute clock restarted on
 * every hard navigation and, for anyone reloading more often than that,
 * never reached 10 minutes at all. A 17-minute soak caught exactly this:
 * the user stayed signed in, but only because the token lapsed and the
 * retry-on-401 below quietly rescued it — the proactive half was doing
 * nothing.
 *
 * The token's real age is the right thing to key on, but it's httpOnly
 * and unreadable by design, so this timestamp stands in for it. It is not
 * a credential: it grants nothing and reintroduces none of the XSS
 * exposure that moving tokens out of localStorage closed. Every access is
 * guarded — storage throws in some privacy modes, and a keep-alive is not
 * worth breaking the app over.
 */
const REFRESH_CLOCK_KEY = "podium.lastRefreshAt";

export function readRefreshClock(): number {
  try {
    const stored = Number(window.localStorage.getItem(REFRESH_CLOCK_KEY));
    // Absent or corrupt means "assume just refreshed" — retry-on-401
    // covers us if that assumption turns out to be wrong.
    return Number.isFinite(stored) && stored > 0 ? stored : Date.now();
  } catch {
    return Date.now();
  }
}

export function writeRefreshClock(at: number = Date.now()): void {
  try {
    window.localStorage.setItem(REFRESH_CLOCK_KEY, String(at));
  } catch {
    /* storage unavailable — the timer still works within this page's life */
  }
}

/**
 * Trades the httpOnly refresh cookie for a fresh access cookie. Sends an
 * empty body deliberately: the browser cannot read an httpOnly value back
 * out to put it in the body, which is exactly why the API accepts the
 * cookie as the fallback source (see AuthController.resolveRefreshToken).
 *
 * Returns whether the session is still alive, and never throws — callers
 * treat `false` as "this session is genuinely over".
 */
export async function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then((res) => {
        // Whoever triggered it — the timer or a 401 — the session is fresh
        // as of now, so the keep-alive clock restarts from here.
        if (res.ok) writeRefreshClock();
        return res.ok;
      })
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

/**
 * `/auth/*` calls are excluded from the retry-on-401 path below: a failed
 * login must surface its own 401 to the form, and retrying a failed refresh
 * by refreshing again is an infinite loop.
 */
function isAuthRoute(path: string): boolean {
  return path.startsWith("/auth/");
}

/**
 * Thin fetch wrapper. Phase H: auth rides in an httpOnly cookie the API sets
 * on login/refresh/accept-invite — the browser attaches it automatically to
 * every same-origin request, so there is no token for this code to read or
 * send by hand (and no way to: an httpOnly cookie is invisible to JS, which
 * is the whole point — an injected script can no longer steal a live
 * session the way it could out of localStorage). All requests go through
 * the Next.js rewrite at /api/* -> the NestJS API, so the cookie is same-
 * origin from the browser's perspective and fetch's default credentials
 * mode ("same-origin") already includes it with no extra option needed.
 *
 * A 401 is retried exactly once behind a refresh. This is the safety net
 * that makes the proactive timer in lib/auth.tsx sufficient rather than
 * load-bearing: browsers throttle timers hard in background tabs and stop
 * them entirely while a laptop sleeps, so the first request after waking
 * will find an expired access token no matter how well-tuned the timer is.
 * Refreshing and replaying turns that into something the user never sees.
 */
// ------------------------------------------------------------ city scope
//
// The topbar's city switcher. While a city is chosen, every list request to
// an endpoint that filters by city gets `cityId` added, so each screen shows
// that city's records — filtered by the server, not by hiding rows here.
// A request that already names its own cityId is left alone.

const CITY_SCOPE_KEY = "podium.cityScope";
const CITY_SCOPED_PATHS = new Set([
  "/dashboard",
  "/projects",
  "/projects/resources",
  "/tasks",
  "/risks",
  "/clients",
  "/leads",
  "/licences",
  "/invoices",
  "/vendors",
  "/inventory/balances",
  "/inventory/overview",
  "/reports/project-finance",
  "/me/calendar",
  "/purchase-requests",
  "/purchase-orders",
  "/search",
]);

let scopeCityId: string | null = (() => {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(CITY_SCOPE_KEY);
  } catch {
    return null;
  }
})();

export function getScopeCityId(): string | null {
  return scopeCityId;
}

export function setScopeCityId(cityId: string | null): void {
  scopeCityId = cityId;
  try {
    if (cityId) window.localStorage.setItem(CITY_SCOPE_KEY, cityId);
    else window.localStorage.removeItem(CITY_SCOPE_KEY);
  } catch {
    // Private mode / blocked storage: the scope still applies for this tab.
  }
}

function withCityScope(path: string, method: string | undefined): string {
  if (!scopeCityId || (method && method !== "GET")) return path;
  const [base, query = ""] = path.split("?");
  if (!CITY_SCOPED_PATHS.has(base) || /(^|&)cityId=/.test(query)) return path;
  return `${base}?${query ? `${query}&` : ""}cityId=${encodeURIComponent(scopeCityId)}`;
}

export async function apiFetch<T>(rawPath: string, init: RequestInit = {}): Promise<T> {
  const path = withCityScope(rawPath, init.method);
  const send = () =>
    fetch(`/api${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
      },
    });

  let res = await send();
  if (res.status === 401 && !isAuthRoute(path) && (await refreshSession())) {
    res = await send();
  }

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    const err = body?.error;
    throw new ApiError(res.status, err?.code ?? "UNKNOWN", err?.message ?? res.statusText, err?.details);
  }
  return body as T;
}

/**
 * Downloads a binary response (currently: invoice PDFs) and hands the
 * browser a file. The httpOnly session cookie is sent automatically, same
 * as any other same-origin fetch — nothing to attach by hand.
 */
export async function apiDownload(path: string, fallbackFilename: string, body?: unknown): Promise<void> {
  // A body makes it a POST — for files generated from submitted values.
  const init: RequestInit =
    body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  let res = await fetch(`/api${path}`, init);
  if (res.status === 401 && (await refreshSession())) {
    res = await fetch(`/api${path}`, init);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new ApiError(res.status, body?.error?.code ?? "UNKNOWN", body?.error?.message ?? res.statusText);
  }

  // Prefer the server's own filename — it knows the real invoice number.
  const disposition = res.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename="([^"]+)"/.exec(disposition);
  const filename = encoded ? decodeURIComponent(encoded[1]!) : plain?.[1] ?? fallbackFilename;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Multipart upload — deliberately NOT apiFetch(), which forces
 * `Content-Type: application/json` unconditionally. FormData needs the
 * browser to set its own `multipart/form-data; boundary=...` header itself;
 * forcing JSON there would silently corrupt every upload.
 */
export async function apiUpload<T>(path: string, formData: FormData, method: "POST" = "POST"): Promise<T> {
  let res = await fetch(`/api${path}`, { method, body: formData });
  if (res.status === 401 && (await refreshSession())) {
    res = await fetch(`/api${path}`, { method, body: formData });
  }
  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    const err = body?.error;
    throw new ApiError(res.status, err?.code ?? "UNKNOWN", err?.message ?? res.statusText, err?.details);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, data?: unknown) => apiFetch<T>(path, { method: "POST", body: data ? JSON.stringify(data) : undefined }),
  patch: <T>(path: string, data?: unknown) => apiFetch<T>(path, { method: "PATCH", body: data ? JSON.stringify(data) : undefined }),
  put: <T>(path: string, data?: unknown) => apiFetch<T>(path, { method: "PUT", body: data ? JSON.stringify(data) : undefined }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: "DELETE" }),
};

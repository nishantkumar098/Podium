"use client";

import type { AuthTokens } from "@podium/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api, readRefreshClock, refreshSession, writeRefreshClock } from "./api";

type CurrentUser = AuthTokens["user"];

/** Where the last-seen screen data is persisted (see app/providers.tsx). */
export const QUERY_CACHE_KEY = "podium.cache.v1";
/**
 * The signed-in person's profile as last confirmed by the server, so a
 * reload can draw the app at once instead of a blank "Loading…" while
 * /users/me crosses to Sydney. It is only a display hint: the session cookie
 * still decides access on every request, and the background /users/me check
 * signs the person out if the session is gone.
 */
const ME_KEY = "podium.me";
/** Cleared on sign-out so the opening animation plays again on the next sign-in. */
export const INTRO_KEY = "podium.intro.played";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function readCachedMe(): CurrentUser | null {
  try {
    const raw = window.localStorage.getItem(ME_KEY);
    return raw ? (JSON.parse(raw) as CurrentUser) : null;
  } catch {
    return null;
  }
}
function writeCachedMe(me: CurrentUser | null): void {
  try {
    if (me) window.localStorage.setItem(ME_KEY, JSON.stringify(me));
    else window.localStorage.removeItem(ME_KEY);
  } catch {
    // storage unavailable — the app just waits for /users/me
  }
}

/**
 * Session keep-alive (see also the retry-on-401 path in lib/api.ts).
 *
 * The access cookie's TTL is JWT_ACCESS_TTL, 15 minutes by default. Before
 * this, nothing ever called /auth/refresh, so a user who had the app open
 * and was actively working was thrown back to the login screen every 15
 * minutes mid-task.
 *
 * Refreshing every 10 minutes leaves 5 minutes of headroom against that
 * default — enough that a slow request or a briefly-throttled timer can't
 * let the token lapse. The interval is deliberately *not* derived from the
 * token: it's httpOnly, so this code cannot read its expiry, and guessing
 * from a hardcoded TTL that someone later lowers in .env would be worse
 * than useless. api.ts's retry-on-401 is what makes any mismatch safe.
 *
 * The activity gate is what preserves "an inactive session still expires".
 * A tab left open overnight sees no pointer or key events, so the tick
 * below stops refreshing and the session lapses exactly as designed —
 * this keeps sessions alive for people, not for idle browser tabs.
 */
const REFRESH_EVERY_MS = 10 * 60 * 1000;
const ACTIVE_WITHIN_MS = 10 * 60 * 1000;
const TICK_MS = 60 * 1000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "scroll", "focus"] as const;


interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  /**
   * Sign in by username. On an account's first sign-in the server answers 428
   * and the login screen resubmits with `confirmPassword`, which then becomes
   * the permanent password.
   */
  login: (username: string, password: string, confirmPassword?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const queryClient = useQueryClient();

  /** Forget everything this browser holds for the session — the person, their data. */
  const forgetLocal = useCallback(() => {
    writeCachedMe(null);
    queryClient.clear();
    try {
      window.localStorage.removeItem(QUERY_CACHE_KEY);
      window.sessionStorage.removeItem(INTRO_KEY);
    } catch {
      // storage unavailable
    }
  }, [queryClient]);

  // Before the first paint: draw with the last confirmed profile, if any.
  useIsoLayoutEffect(() => {
    const cached = readCachedMe();
    if (cached) {
      setUser(cached);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Phase H: the access token lives in an httpOnly cookie this code can't
    // read, so there's no client-side way to tell "logged in" from "not"
    // without asking the server — just call /users/me and let a 401 answer
    // the question.
    api
      .get<{
        id: string;
        name: string;
        username: string | null;
        email: string | null;
        roles: string[];
        cityAccess: CurrentUser["cityAccess"];
        mustChangePassword: boolean;
      }>("/users/me")
      .then((me) => {
        // A different person than last time in this browser: their data
        // must not be shown from the previous person's cache.
        const cached = readCachedMe();
        if (cached && cached.id !== me.id) forgetLocal();
        writeCachedMe(me as CurrentUser);
        setUser(me);
      })
      .catch((e: { status?: number }) => {
        // Only a definite "not signed in" drops the session; a network blip
        // keeps the cached profile and the next request tries again.
        if (e?.status === 401 || e?.status === 403 || !readCachedMe()) {
          forgetLocal();
          setUser(null);
        }
      })
      .finally(() => setLoading(false));
  }, [forgetLocal]);

  const lastActivityAt = useRef(Date.now());
  const lastRefreshAt = useRef(Date.now());

  useEffect(() => {
    if (!user) return;

    // Continue the clock from wherever the last page load left it rather
    // than restarting it: a full navigation remounts this provider, and
    // resetting here meant the 10-minute countdown never completed for
    // anyone reloading more often than that (see lib/api.ts's
    // REFRESH_CLOCK_KEY for the soak that caught it).
    lastRefreshAt.current = readRefreshClock();

    const noteActivity = () => {
      lastActivityAt.current = Date.now();
    };
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, noteActivity, { passive: true });

    const tick = window.setInterval(() => {
      const now = Date.now();
      if (now - lastRefreshAt.current < REFRESH_EVERY_MS) return;
      if (now - lastActivityAt.current > ACTIVE_WITHIN_MS) return; // idle — let it expire
      // Marked before the await so a slow refresh can't queue a second tick.
      lastRefreshAt.current = now;
      void refreshSession().then((alive) => {
        // A dead refresh token means the session is genuinely over (revoked,
        // password changed, or 30 days elapsed). Drop the user here rather
        // than waiting for their next click to fail.
        if (!alive) {
          forgetLocal();
          setUser(null);
        }
      });
    }, TICK_MS);

    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, noteActivity);
      window.clearInterval(tick);
    };
  }, [user, forgetLocal]);

  const login = useCallback(
    async (username: string, password: string, confirmPassword?: string) => {
      // The response still carries accessToken/refreshToken in the body for
      // any non-browser caller, but the browser doesn't need them — the
      // API's Set-Cookie header on this same response already planted the
      // httpOnly session cookie.
      const res = await api.post<AuthTokens>("/auth/login", {
        username,
        password,
        ...(confirmPassword !== undefined ? { confirmPassword } : {}),
      });
      // Start the keep-alive clock from this login, not from whenever the
      // provider happened to mount — someone can sit on the login screen
      // for longer than a refresh interval before signing in.
      lastActivityAt.current = Date.now();
      lastRefreshAt.current = Date.now();
      writeRefreshClock();
      const cached = readCachedMe();
      if (cached && cached.id !== res.user.id) forgetLocal();
      writeCachedMe(res.user);
      setUser(res.user);
      router.push("/dashboard");
    },
    [router, forgetLocal],
  );

  const logout = useCallback(() => {
    // Only the server can clear an httpOnly cookie (JS can't touch it), and
    // logout must also revoke the refresh token server-side — so this is a
    // real request now, not just a local state reset. Fire-and-forget: the
    // UI moves on immediately either way.
    api.post("/auth/logout").catch(() => undefined);
    forgetLocal();
    setUser(null);
    router.push("/login");
  }, [router, forgetLocal]);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

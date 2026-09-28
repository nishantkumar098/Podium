"use client";

import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { MutationCache, QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider, removeOldestQuery } from "@tanstack/react-query-persist-client";
import { useState, type ReactNode } from "react";
import { OpeningIntro } from "../components/OpeningIntro";
import { AuthProvider, QUERY_CACHE_KEY } from "../lib/auth";
import { playSound, type SoundName } from "../lib/sounds";
/** Never written to the browser: third-party mail/calendar content and live feeds. */
const NOT_PERSISTED = new Set(["mail", "calendar", "google", "notifications", "chat", "meetings"]);

export function Providers({ children }: { children: ReactNode }) {
  // Every request crosses to a database in Sydney, so a refetch is never
  // cheap. Data is served from cache for 5 minutes — revisiting a screen is
  // instant — and not refetched merely because the tab regained focus.
  // Anything a user changes still refreshes at once: every mutation
  // invalidates the queries it affects.
  //
  // The cache is also persisted to localStorage, so a reload or a new visit
  // paints the last-seen data straight away and refreshes it quietly in the
  // background instead of showing "Loading…" for seconds.
  //
  // Home and the sidebar badges summarise every other screen, so any
  // successful save anywhere marks them stale.
  const [client] = useState(() => {
    const qc: QueryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: 1, staleTime: 5 * 60_000, gcTime: 24 * 60 * 60_000, refetchOnWindowFocus: false },
      },
      mutationCache: new MutationCache({
        onSuccess: (_data, _vars, _ctx, mutation) => {
          void qc.invalidateQueries({ queryKey: ["dashboard"], refetchType: "active" });
          void qc.invalidateQueries({ queryKey: ["nav-counts"] });
          // Every save confirms itself with a soft ding. A mutation can pick
          // its own sound, or opt out, with meta: { sound: "sent" | "silent" }.
          const sound = mutation.meta?.sound as SoundName | "silent" | undefined;
          if (sound !== "silent") playSound(sound ?? "success");
        },
        onError: (_err, _vars, _ctx, mutation) => {
          if (mutation.meta?.sound !== "silent") playSound("error");
        },
      }),
    });
    return qc;
  });
  const [persister] = useState(() =>
    createSyncStoragePersister({
      storage: typeof window === "undefined" ? undefined : safeStorage(),
      key: QUERY_CACHE_KEY,
      throttleTime: 1500,
      // Over the browser's quota, drop the oldest screens rather than fail.
      retry: removeOldestQuery,
    }),
  );
  return (
    <PersistQueryClientProvider
      client={client}
      persistOptions={{
        persister,
        maxAge: 24 * 60 * 60_000,
        // Bump when saved data must not be reused (e.g. records moved city).
        buster: "2026-09-21-city-fix",
        dehydrateOptions: {
          shouldDehydrateQuery: (q) => q.state.status === "success" && !NOT_PERSISTED.has(String(q.queryKey[0])),
        },
      }}
    >
      <AuthProvider>
        {children}
        <OpeningIntro />
      </AuthProvider>
    </PersistQueryClientProvider>
  );
}

/** localStorage when usable; blocked storage (private mode) just means no persistence. */
function safeStorage(): Storage | undefined {
  try {
    const s = window.localStorage;
    s.setItem("podium.probe", "1");
    s.removeItem("podium.probe");
    return s;
  } catch {
    return undefined;
  }
}

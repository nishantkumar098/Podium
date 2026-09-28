"use client";

import { fmtINR } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../lib/api";

/**
 * Asking the bartenders whether they are free for this event, over WhatsApp.
 *
 * What it replaces: somebody ringing round the crew before every event and
 * flipping a global "available" flag by hand — a flag that answers "is Ankit
 * around at all" when the question is "is Ankit free on the 12th".
 *
 * The answer lives per-event, so this panel belongs on the event, not on the
 * Bartenders list.
 */
interface CrewMember {
  id: string;
  name: string;
  category: string | null;
  phone: string | null;
  dayRate: number | null;
  dayRateOutstation: number | null;
  isAvailable: boolean;
}

interface CrewRequest {
  id: string;
  status: "SENT" | "AVAILABLE" | "UNAVAILABLE" | "FAILED";
  channel: string;
  replyText: string | null;
  sentAt: string;
  respondedAt: string | null;
  freelancer: { id: string; name: string; phone: string | null; category: string | null };
}

const PILL: Record<CrewRequest["status"], string> = {
  AVAILABLE: "green",
  UNAVAILABLE: "red",
  SENT: "amber",
  FAILED: "gray",
};
const LABEL: Record<CrewRequest["status"], string> = {
  AVAILABLE: "Available",
  UNAVAILABLE: "Not available",
  SENT: "Waiting",
  FAILED: "Couldn't send",
};

export function CrewPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: status } = useQuery({ queryKey: ["whatsapp-status"], queryFn: () => api.get<{ mode: string }>("/whatsapp/status"), retry: false });
  const { data: pool } = useQuery({ queryKey: ["freelancers"], queryFn: () => api.get<{ canEdit: boolean; crew: CrewMember[] }>("/freelancers") });
  const { data: asked, isLoading } = useQuery({
    queryKey: ["crew-requests", projectId],
    queryFn: () => api.get<{ mode: string; requests: CrewRequest[] }>(`/projects/${projectId}/crew-requests`),
  });

  const requests = asked?.requests ?? [];
  const askedIds = new Set(requests.map((r) => r.freelancer.id));
  const unasked = (pool?.crew ?? []).filter((c) => !askedIds.has(c.id));

  const ask = useMutation({
    mutationFn: (ids: string[]) => api.post<{ mode: string; asked: number }>(`/projects/${projectId}/crew-requests`, { freelancerIds: ids }),
    onSuccess: (r) => {
      setError(null);
      setPicked([]);
      setNotice(
        r.mode === "sandbox"
          ? `${r.asked} message(s) prepared — nothing was actually sent, WhatsApp is in sandbox mode.`
          : `Asked ${r.asked} bartender(s). Replies land here as they come in.`,
      );
      void qc.invalidateQueries({ queryKey: ["crew-requests", projectId] });
    },
    onError: (e: ApiError) => {
      setNotice(null);
      setError(e.message);
    },
  });

  const counts = {
    yes: requests.filter((r) => r.status === "AVAILABLE").length,
    no: requests.filter((r) => r.status === "UNAVAILABLE").length,
    waiting: requests.filter((r) => r.status === "SENT").length,
  };

  return (
    <div className="panel">
      <div className="panel-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <span>Crew for this event</span>
        {requests.length > 0 && (
          <span className="small muted">
            {counts.yes} available · {counts.no} not · {counts.waiting} waiting
          </span>
        )}
      </div>

      {status?.mode === "disabled" && (
        <div className="notice" style={{ marginBottom: 10 }}>
          WhatsApp isn&apos;t switched on yet, so nothing can be sent. You can still record answers by hand on the Bartenders screen.
        </div>
      )}
      {status?.mode === "sandbox" && (
        <div className="notice" style={{ marginBottom: 10 }}>
          <b>Sandbox.</b> Messages are prepared and logged but never delivered — safe for trying this out.
        </div>
      )}
      {error && <div className="notice red" style={{ marginBottom: 10 }}>{error}</div>}
      {notice && <div className="notice" style={{ marginBottom: 10 }}>{notice}</div>}

      {isLoading && <div className="muted small">Loading…</div>}

      {requests.length > 0 && (
        <table className="tbl" style={{ marginBottom: 14 }}>
          <thead>
            <tr>
              <th>Bartender</th>
              <th>Kind</th>
              <th>Answer</th>
              <th>They said</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td>
                  <b>{r.freelancer.name}</b>
                  {r.freelancer.phone && <div className="small muted mono">{r.freelancer.phone}</div>}
                </td>
                <td>{r.freelancer.category ?? "—"}</td>
                <td>
                  <span className={`pill ${PILL[r.status]}`}>{LABEL[r.status]}</span>
                </td>
                {/* The raw reply, not just the verdict: "yes but only till 11"
                    is a yes with a condition somebody needs to read. */}
                <td className="small">{r.replyText ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {unasked.length === 0 ? (
        <div className="small muted">{requests.length > 0 ? "Everyone in the pool has been asked." : "No bartenders in your cities yet."}</div>
      ) : (
        <>
          <div className="small muted" style={{ marginBottom: 8 }}>
            Pick who to ask — they get one WhatsApp each with the event name, date and city, and Yes/No to tap.
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            {unasked.map((c) => {
              const on = picked.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  className={on ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                  onClick={() => setPicked((prev) => (on ? prev.filter((x) => x !== c.id) : [...prev, c.id]))}
                  title={c.dayRate !== null ? `${fmtINR(c.dayRate)} in city` : "no rate on file"}
                >
                  {c.name}
                  {c.category ? ` · ${c.category}` : ""}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn-primary" disabled={picked.length === 0 || ask.isPending} onClick={() => ask.mutate(picked)}>
              {ask.isPending ? "Sending…" : `Ask ${picked.length || ""}`.trim()}
            </button>
            <button className="btn-ghost" disabled={unasked.length === 0} onClick={() => setPicked(unasked.map((c) => c.id))}>
              Select all {unasked.length}
            </button>
            {picked.length > 0 && (
              <button className="btn-ghost" onClick={() => setPicked([])}>
                Clear
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

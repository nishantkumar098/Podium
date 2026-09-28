"use client";

import { fmtDate, fmtINR } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { api } from "../../lib/api";

/**
 * The bartender pool, on its own screen.
 *
 * Operations books and tasks the freelance crew every day; the People screen
 * they used to do it from also carries employee records, attendance and
 * leave, which are not theirs to read. So the crew has its own endpoint
 * (`/freelancers`, gated on the `freelancers` resource) and its own page.
 *
 * The list is already scoped to the caller's cities by the API — a City Head
 * sees their city's crew and nobody else's — so there is no city selector
 * here to get wrong.
 */
interface CrewDto {
  canEdit: boolean;
  crew: Array<{
    id: string;
    name: string;
    category: string | null;
    phone: string | null;
    city: { id: string; name: string } | null;
    certExpiresAt: string | null;
    dayRate: number | null;
    dayRateOutstation: number | null;
    agreementSigned: boolean;
    eventsCount: number;
    rating: number | null;
    isAvailable: boolean;
  }>;
}

export default function BartendersPage() {
  const qc = useQueryClient();
  const [kind, setKind] = useState("");
  const [only, setOnly] = useState<"all" | "free" | "booked">("all");
  const [unsignedOnly, setUnsignedOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ["freelancers"], queryFn: () => api.get<CrewDto>("/freelancers") });
  const crew = data?.crew ?? [];

  const kinds = useMemo(() => [...new Set(crew.map((c) => c.category).filter((c): c is string => !!c))].sort(), [crew]);
  const shown = crew.filter(
    (c) =>
      (!kind || c.category === kind) &&
      (only === "all" || (only === "free" ? c.isAvailable : !c.isAvailable)) &&
      (!unsignedOnly || !c.agreementSigned),
  );

  const toggle = useMutation({
    mutationFn: (c: CrewDto["crew"][number]) => api.post(`/freelancers/${c.id}/availability`, { available: !c.isAvailable }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["freelancers"] });
      void qc.invalidateQueries({ queryKey: ["people"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const available = crew.filter((c) => c.isAvailable).length;
  const unsigned = crew.filter((c) => !c.agreementSigned).length;

  return (
    <AppShell crumb="Bartenders">
      <div className="page-head">
        <div>
          <div className="page-title">Bartenders</div>
          <div className="page-sub">
            {isLoading
              ? "Loading the crew pool…"
              : `${available} of ${crew.length} free right now${unsigned > 0 ? ` · ${unsigned} agreement${unsigned === 1 ? "" : "s"} pending` : ""}`}
          </div>
        </div>
      </div>

      {error && <div className="notice red" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="panel">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <select className="inp" style={{ maxWidth: 200 }} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Every kind of crew</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          {(["all", "free", "booked"] as const).map((v) => (
            <button key={v} className={only === v ? "btn-primary" : "btn-ghost"} onClick={() => setOnly(v)}>
              {v === "all" ? "All" : v === "free" ? "Free" : "Booked"}
            </button>
          ))}
          {/* Chasing unsigned agreements is a real recurring job, so it gets
              its own filter rather than being buried in a column to scan. */}
          <button className={unsignedOnly ? "btn-primary" : "btn-ghost"} onClick={() => setUnsignedOnly((v) => !v)}>
            Agreement pending{unsigned > 0 ? ` (${unsigned})` : ""}
          </button>
        </div>

        {shown.length === 0 ? (
          <div className="muted small" style={{ padding: "18px 2px" }}>
            {isLoading ? "…" : crew.length === 0 ? "No bartenders are recorded for your cities yet." : "Nobody matches this filter."}
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>City</th>
                <th className="num">Events</th>
                <th className="num">In city</th>
                <th className="num">Outstation</th>
                <th>Agreement</th>
                <th>Licence</th>
                <th>Status</th>
                {data?.canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id}>
                  <td>
                    <b>{c.name}</b>
                    {c.phone && <div className="small muted mono">{c.phone}</div>}
                  </td>
                  <td>{c.category ?? "—"}</td>
                  <td>{c.city?.name ?? "—"}</td>
                  <td className="num">{c.eventsCount}</td>
                  <td className="num">{c.dayRate !== null ? fmtINR(c.dayRate) : "—"}</td>
                  <td className="num">{c.dayRateOutstation !== null ? fmtINR(c.dayRateOutstation) : "—"}</td>
                  <td>
                    {c.agreementSigned ? (
                      <span className="pill green">Signed</span>
                    ) : (
                      <span className="small muted">Pending</span>
                    )}
                  </td>
                  <td className="small">{c.certExpiresAt ? fmtDate(c.certExpiresAt) : "—"}</td>
                  <td>
                    <span className={`pill ${c.isAvailable ? "green" : "amber"}`}>{c.isAvailable ? "Free" : "Booked"}</span>
                  </td>
                  {data?.canEdit && (
                    <td>
                      <button className="btn-ghost" disabled={toggle.isPending} onClick={() => toggle.mutate(c)}>
                        {c.isAvailable ? "Mark booked" : "Mark free"}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}

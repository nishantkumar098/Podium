"use client";

import { fmtDate, fmtINR } from "@podium/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppShell } from "../../components/AppShell";
import { StatusPill } from "../../components/StatusPill";
import { api } from "../../lib/api";
import type { CityOptionDto, LeadListResponse, LeadStage } from "../../lib/types";

const PAGE = 50;
const STAGES: LeadStage[] = ["LEAD", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "WON", "LOST"];
type Kind = "PIPELINE" | "COLD_PROSPECT";

/**
 * Phase F.5: the CRM/pipeline module (blueprint §5, leads + Deal-Won
 * automation au1) has had a real, tested backend since Phase 2 with no
 * frontend at all — leads, stage changes and the Deal-Won conversion were
 * only reachable via curl/tests. This is that missing surface.
 *
 * Defaults to the PIPELINE kind, mirroring LeadsService.list()'s own
 * default — the ~200 real, human-worked opportunities, not the thousands
 * of cold prospecting rows from the real-data import.
 */
export default function LeadsPage() {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("PIPELINE");
  const [stage, setStage] = useState("");
  const [cityId, setCityId] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: () => api.get<CityOptionDto[]>("/cities") });

  const { data, isLoading } = useQuery({
    queryKey: ["leads", kind, stage, cityId, search, offset],
    queryFn: () => {
      const params = new URLSearchParams({ kind, limit: String(PAGE), offset: String(offset) });
      if (stage) params.set("stage", stage);
      if (cityId) params.set("cityId", cityId);
      if (search) params.set("search", search);
      return api.get<LeadListResponse>(`/leads?${params.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  function pick(next: Kind) {
    setKind(next);
    setOffset(0);
  }

  const total = data?.total ?? 0;
  const shown = data?.rows.length ?? 0;

  return (
    <AppShell crumb="Leads">
      <div className="page-head">
        <div>
          <div className="page-title">Leads</div>
          <div className="page-sub">
            {total.toLocaleString("en-IN")} {kind === "PIPELINE" ? "pipeline opportunities" : "cold prospects"}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn-ghost" onClick={() => router.push("/pipeline")}>View as pipeline board</button>
        </div>
      </div>

      <div className="toolbar">
        <div className="chips">
          <button type="button" className={`chipbtn${kind === "PIPELINE" ? " on" : ""}`} onClick={() => pick("PIPELINE")}>
            Pipeline
          </button>
          <button type="button" className={`chipbtn${kind === "COLD_PROSPECT" ? " on" : ""}`} onClick={() => pick("COLD_PROSPECT")}>
            Cold prospects
          </button>
        </div>
        <select className="inp" value={stage} onChange={(e) => { setStage(e.target.value); setOffset(0); }}>
          <option value="">All stages</option>
          {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="inp" value={cityId} onChange={(e) => { setCityId(e.target.value); setOffset(0); }}>
          <option value="">All cities</option>
          {cities?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="field" style={{ maxWidth: 260 }}>
          <input
            value={search}
            placeholder="Search by name…"
            onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
          />
        </div>
      </div>

      {isLoading && <div className="empty">Loading…</div>}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Stage</th>
              <th>City</th>
              <th className="tright">Value</th>
              <th>Event date</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((l) => (
              <tr key={l.id} className="rowhover" style={{ cursor: "pointer" }} onClick={() => router.push(`/leads/${l.id}`)}>
                <td>{l.name}</td>
                <td><StatusPill status={l.stage} /></td>
                <td>{cities?.find((c) => c.id === l.cityId)?.name ?? "—"}</td>
                <td className="tright mono">{l.value !== null ? fmtINR(Number(l.value)) : "—"}</td>
                <td className="mono small">
                  {l.eventDate ? fmtDate(l.eventDate) : l.eventDateText ?? "—"}
                </td>
                <td className="small">{l.source ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!isLoading && shown === 0 && <div className="empty">No leads match these filters.</div>}
      </div>

      {total > PAGE && (
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button type="button" className="btn-ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            ← Previous
          </button>
          <span className="mono" style={{ fontSize: 12 }}>
            {shown === 0 ? 0 : offset + 1}–{offset + shown} of {total.toLocaleString("en-IN")}
          </span>
          <button type="button" className="btn-ghost" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            Next →
          </button>
        </div>
      )}
    </AppShell>
  );
}

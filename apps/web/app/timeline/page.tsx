"use client";

import { fmtDate } from "@podium/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppShell } from "../../components/AppShell";
import { CityChips } from "../../components/GovernanceUi";
import { HealthDot, StageStrip, daysLabel, stageFor, upcomingOnly, useProjects } from "../../components/OpsUi";

export default function TimelinePage() {
  const router = useRouter();
  const { data, isLoading } = useProjects();
  const [cityId, setCityId] = useState<string | null>(null);
  const live = upcomingOnly(data).filter((p) => !cityId || p.city.id === cityId);
  const counts: Record<string, number> = {};
  for (const p of live) counts[stageFor(p.eventDate)] = (counts[stageFor(p.eventDate)] ?? 0) + 1;

  return (
    <AppShell crumb="Timeline">
      <div className="page-head">
        <div>
          <div className="page-title">Master Event Timeline</div>
          <div className="page-sub">Standard staging applied across all active events · {live.length} upcoming</div>
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <CityChips value={cityId} onChange={setCityId} />
      </div>
      <div className="panel section-block">
        <StageStrip counts={counts} />
      </div>
      {isLoading && <div className="empty">Loading…</div>}
      {!isLoading && live.length === 0 && <div className="empty">No upcoming events{cityId ? " in this city" : ""}.</div>}
      <div className="grid g3">
        {live.map((p) => (
          <div key={p.id} className="panel" onClick={() => router.push(`/projects/${p.id}?tab=timeline`)} style={{ cursor: "pointer" }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, display: "flex", gap: 6, alignItems: "center" }}>
              <HealthDot health={p.health} /> {p.name}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 8 }}>
              {p.eventDateText || fmtDate(p.eventDate)} · {daysLabel(p.eventDate)} · {p.city.name}
            </div>
            <span className="pill amber">Currently: {stageFor(p.eventDate)}</span>
          </div>
        ))}
      </div>
    </AppShell>
  );
}

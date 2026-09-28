"use client";

import { fmtDate } from "@podium/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { AppShell } from "../../components/AppShell";
import { Avatar, CityChips } from "../../components/GovernanceUi";
import { api } from "../../lib/api";

interface Resource {
  id: string;
  name: string;
  role: string | null;
  dept: string | null;
  city: string | null;
  activeProjects: number;
  openTasks: number;
  nextProject: { id: string; name: string; eventDate: string } | null;
}

export default function ResourcesPage() {
  const [cityId, setCityId] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["resources", cityId],
    queryFn: () => api.get<Resource[]>(`/projects/resources${cityId ? `?cityId=${cityId}` : ""}`),
  });
  const rows = (data ?? []).slice().sort((a, b) => b.activeProjects + b.openTasks - (a.activeProjects + a.openTasks) || a.name.localeCompare(b.name));
  // Load is relative to the busiest person: Podium records who is on what,
  // not contracted hours, so there is no absolute capacity to divide by.
  const max = Math.max(1, ...rows.map((r) => r.activeProjects * 3 + r.openTasks));
  const busy = rows.filter((r) => r.activeProjects + r.openTasks > 0).length;

  return (
    <AppShell crumb="Resources">
      <div className="page-head">
        <div>
          <div className="page-title">Resources</div>
          <div className="page-sub">
            Team capacity &amp; allocation across live projects · {busy} of {rows.length} people allocated
          </div>
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <CityChips value={cityId} onChange={setCityId} />
      </div>
      <div className="panel section-block">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Dept</th>
              <th>Base</th>
              <th>Active Projects</th>
              <th>Open Tasks</th>
              <th>Next event</th>
              <th>Relative load</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={8} className="empty">
                  Loading…
                </td>
              </tr>
            )}
            {rows.map((u) => {
              const pct = Math.round(((u.activeProjects * 3 + u.openTasks) / max) * 100);
              return (
                <tr key={u.id}>
                  <td>
                    <Avatar name={u.name} /> &nbsp;{u.name}
                  </td>
                  <td>{u.role ?? "—"}</td>
                  <td>{u.dept ?? "—"}</td>
                  <td>{u.city ?? "—"}</td>
                  <td className="mono">{u.activeProjects}</td>
                  <td className="mono">{u.openTasks}</td>
                  <td>
                    {u.nextProject ? (
                      <Link href={`/projects/${u.nextProject.id}`}>
                        {u.nextProject.name} <span className="small muted">· {fmtDate(u.nextProject.eventDate)}</span>
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <div className="progress" style={{ width: 90, display: "inline-block" }}>
                      <div style={{ width: `${pct}%`, background: pct > 85 ? "var(--red)" : pct > 60 ? "var(--brass)" : "var(--green)" }} />
                    </div>{" "}
                    <span className="mono" style={{ fontSize: 10.5 }}>
                      {pct}%
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="small muted" style={{ marginTop: 10 }}>
          Load compares people with each other (an event counts as three tasks). Add crew on a project&apos;s Team tab to allocate them.
        </div>
      </div>
    </AppShell>
  );
}

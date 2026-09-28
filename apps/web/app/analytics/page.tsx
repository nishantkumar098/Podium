"use client";

import { fmtINR } from "@podium/ui";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "../../components/AppShell";
import { api, ApiError } from "../../lib/api";

interface AnalyticsDto {
  projects: number;
  revenueByType: Array<{ type: string; revenue: number; count: number }>;
  projectsByCity: Array<{ city: string; count: number }>;
  margin: { pct: number; revenue: number; cost: number } | null;
  taskCompletion: { pct: number; done: number; total: number } | null;
  vendorRating: { avg: number; rated: number } | null;
  salesConversion: { pct: number; won: number; total: number } | null;
}

export default function AnalyticsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["reports-analytics"], queryFn: () => api.get<AnalyticsDto>("/reports/analytics") });

  // No revenue recorded yet (imported events carry none) — show how the
  // events divide by type instead of a column of zero-width bars.
  const byRevenue = (data?.revenueByType ?? []).some((t) => t.revenue > 0);
  const bars = (data?.revenueByType ?? []).map((t) => ({ label: t.type, value: byRevenue ? t.revenue : t.count }));
  const max = Math.max(1, ...bars.map((b) => b.value));

  return (
    <AppShell crumb="Reports">
      <div className="page-head">
        <div>
          <div className="page-title">Reports &amp; Analytics</div>
          <div className="page-sub">Profitability, productivity &amp; performance across the business</div>
        </div>
      </div>

      {isLoading && <div className="empty">Loading…</div>}
      {error && <div className="empty">{(error as ApiError).message}</div>}

      {data && (
        <>
          <div className="grid g2 section-block">
            <div className="panel">
              <div className="panel-title">
                {byRevenue ? "Revenue by Event Type" : "Events by Type"}
                {!byRevenue && data.projects > 0 && (
                  <span className="small muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>
                    no project revenue recorded yet
                  </span>
                )}
              </div>
              {bars.length === 0 && <div className="empty">No projects yet.</div>}
              {bars.map((b) => (
                <div key={b.label} style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                    <span>{b.label}</span>
                    <span className="mono">{byRevenue ? fmtINR(b.value) : `${b.value} event${b.value === 1 ? "" : "s"}`}</span>
                  </div>
                  <div className="progress" style={{ width: "100%" }}>
                    <div style={{ width: `${(b.value / max) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <div className="panel">
              <div className="panel-title">Project Distribution by City</div>
              {data.projectsByCity.length === 0 && <div className="empty">No projects yet.</div>}
              {data.projectsByCity.map((c) => (
                <div
                  key={c.city}
                  style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #F1EEE5", fontSize: 12.5 }}
                >
                  <span>{c.city}</span>
                  <span className="mono">
                    {c.count} project{c.count === 1 ? "" : "s"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="grid g4">
            <div className="stat">
              <div className="k">Overall Margin</div>
              <div className="v">{data.margin ? `${data.margin.pct.toFixed(1)}%` : "—"}</div>
              <div className="d">{data.margin ? `${fmtINR(data.margin.revenue - data.margin.cost)} on ${fmtINR(data.margin.revenue)}` : "no revenue recorded yet"}</div>
            </div>
            <div className="stat">
              <div className="k">Task Completion Rate</div>
              <div className="v">{data.taskCompletion ? `${data.taskCompletion.pct}%` : "—"}</div>
              <div className="d">{data.taskCompletion ? `${data.taskCompletion.done} of ${data.taskCompletion.total} tasks` : "no tasks yet"}</div>
            </div>
            <div className="stat">
              <div className="k">Vendor Avg Rating</div>
              <div className="v">{data.vendorRating ? data.vendorRating.avg.toFixed(2) : "—"}</div>
              <div className="d">{data.vendorRating ? `${data.vendorRating.rated} rated vendors` : "no vendors rated yet"}</div>
            </div>
            <div className="stat">
              <div className="k">Sales Conversion</div>
              <div className="v">{data.salesConversion ? `${data.salesConversion.pct}%` : "—"}</div>
              <div className="d">
                {data.salesConversion ? `${data.salesConversion.won} won of ${data.salesConversion.total.toLocaleString("en-IN")} pipeline leads` : "no pipeline leads yet"}
              </div>
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}

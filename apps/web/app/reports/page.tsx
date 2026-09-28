"use client";

import { fmtINR } from "@podium/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { PnlEditor, PnlStatementList } from "../../components/PnlStatements";
import { api, getScopeCityId } from "../../lib/api";
import type { CashFlowDto, CityOptionDto, ForecastDto, PnlActualsDto, PnlByCityDto } from "../../lib/types";

/**
 * P&L — six cities.
 *
 * Every figure is ACTUALS, computed by the server from real issued invoices,
 * payments, approved expenses and received purchase orders. The forecast is
 * a separate, labelled model output and is never added to an actual.
 *
 * The reference design also shows budget, EBITDA and tax lines; Podium holds
 * no operating-expense ledger or city budgets to compute those from, so they
 * are not shown rather than invented.
 */

type PeriodKey = "month" | "lastMonth" | "quarter" | "fytd" | "lastFy";

/** Indian financial year: April → March. */
function periods(now = new Date()): Record<PeriodKey, { label: string; from: Date; to: Date }> {
  const y = now.getFullYear();
  const m = now.getMonth();
  const fyStartYear = m >= 3 ? y : y - 1;
  const qStartMonth = m - ((m - 3 + 12) % 3);
  const fy = (s: number) => `FY ${s}–${String((s + 1) % 100).padStart(2, "0")}`;
  return {
    month: { label: now.toLocaleDateString("en-IN", { month: "long", year: "numeric" }), from: new Date(y, m, 1), to: now },
    lastMonth: { label: new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" }), from: new Date(y, m - 1, 1), to: new Date(y, m, 0, 23, 59, 59) },
    quarter: { label: "This quarter", from: new Date(y, qStartMonth, 1), to: now },
    fytd: { label: `${fy(fyStartYear)} to date`, from: new Date(fyStartYear, 3, 1), to: now },
    lastFy: { label: fy(fyStartYear - 1), from: new Date(fyStartYear - 1, 3, 1), to: new Date(fyStartYear, 2, 31, 23, 59, 59) },
  };
}

const pct = (v: number, of: number) => (of ? `${((v / of) * 100).toFixed(1)}%` : "—");
const signed = (n: number) => `${n < 0 ? "−" : ""}${fmtINR(Math.abs(Math.round(n)))}`;

export default function PnlPage() {
  const P = useMemo(() => periods(), []);
  const [period, setPeriod] = useState<PeriodKey>("fytd");
  const [cityId, setCityId] = useState<string>(() => getScopeCityId() ?? "");
  const [baseline, setBaseline] = useState("");
  /** The hand-built statement open in the editor ("new" for Add P&L). */
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const { data: shell } = useQuery({ queryKey: ["shell"], queryFn: () => api.get<{ permissions: string[] }>("/users/me/shell"), staleTime: 30 * 60_000 });
  const canEditPnl = !!shell?.permissions.includes("invoices:edit");
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const range = `from=${encodeURIComponent(P[period].from.toISOString())}&to=${encodeURIComponent(P[period].to.toISOString())}`;

  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: () => api.get<CityOptionDto[]>("/cities") });
  const pnlQ = useQuery({
    queryKey: ["reports-pnl", period, cityId],
    queryFn: () => api.get<PnlActualsDto>(`/reports/pnl?scope=${cityId ? `city&cityId=${cityId}` : "company"}&${range}`),
  });
  const byCityQ = useQuery({ queryKey: ["reports-pnl-by-city", period], queryFn: () => api.get<PnlByCityDto>(`/reports/pnl/by-city?${range}`) });
  const cashQ = useQuery({
    queryKey: ["reports-cash-flow", cityId],
    queryFn: () => {
      // Trend always covers the last twelve months, whatever the period.
      const from = new Date(new Date().getFullYear(), new Date().getMonth() - 11, 1).toISOString();
      return api.get<CashFlowDto>(`/reports/cash-flow?from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date().toISOString())}${cityId ? `&cityId=${cityId}` : ""}`);
    },
  });
  const forecastQ = useQuery({
    queryKey: ["reports-forecast", cityId, baseline],
    queryFn: () => api.get<ForecastDto>(`/reports/forecast?${cityId ? `cityId=${cityId}&` : ""}${baseline ? `baseline=${Number(baseline)}` : ""}`),
  });

  const A = pnlQ.data;
  const cityLabel = cityId ? (cities?.find((c) => c.id === cityId)?.name ?? "") : `all ${cities?.length ?? 6} cities`;
  const comp = byCityQ.data?.cities ?? [];
  const ranked = comp.filter((c) => c.margin.grossMarginPct !== null).sort((a, b) => (b.margin.grossMarginPct ?? 0) - (a.margin.grossMarginPct ?? 0));
  const best = ranked.length > 1 ? ranked[0].city.id : null;
  const worst = ranked.length > 1 ? ranked[ranked.length - 1].city.id : null;

  const exportCsv = () => {
    const rows = [
      ["City", "Net revenue", "GST collected", "Invoices", "Expense claims", "Purchase orders received", "Total direct costs", "Gross margin", "Gross margin %", "Collected", "Outstanding"],
      ...comp.map((c) => [
        c.city.name,
        c.revenue.netRevenue,
        c.revenue.gstCollected,
        c.revenue.invoiceCount,
        c.costs.expenses,
        c.costs.purchaseOrders,
        c.costs.total,
        c.margin.grossMargin,
        c.margin.grossMarginPct ?? "",
        c.collections.received,
        c.collections.outstanding,
      ]),
    ];
    const blob = new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `podium-pnl-${period}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <AppShell crumb="P&L">
      <div className="page-head">
        <div>
          <div className="page-title">P&amp;L — {cityLabel}</div>
          <div className="page-sub">{P[period].label} · actuals from issued invoices, payments, approved expenses and received purchase orders</div>
        </div>
        <div className="page-actions">
          <select className="inp" value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)} aria-label="Period">
            {(Object.keys(P) as PeriodKey[]).map((k) => (
              <option key={k} value={k}>
                {P[k].label}
              </option>
            ))}
          </select>
          <button className="btn-ghost" disabled={comp.length === 0} onClick={exportCsv}>
            Export CSV
          </button>
          {canEditPnl && (
            <button className="btn-primary" onClick={() => setEditing("new")}>
              + Add P&amp;L
            </button>
          )}
        </div>
      </div>

      <div className="chips" style={{ marginBottom: 12 }}>
        <button className={`chipbtn ${!cityId ? "on" : ""}`} onClick={() => setCityId("")}>
          Consolidated
        </button>
        {cities?.map((c) => (
          <button key={c.id} className={`chipbtn ${cityId === c.id ? "on" : ""}`} onClick={() => setCityId(c.id)}>
            {c.name}
          </button>
        ))}
      </div>

      {editing && (
        <PnlEditor
          key={editing}
          id={editing}
          canEdit={canEditPnl}
          defaultFrom={ymd(P[period].from)}
          defaultTo={ymd(P[period].to)}
          onClose={() => setEditing(null)}
        />
      )}
      <PnlStatementList onOpen={(id) => setEditing(id)} />

      {A && !A.hasData && A.explanation && <div className="notice" style={{ marginBottom: 12 }}>{A.explanation}</div>}
      {pnlQ.error && <div className="notice red">{(pnlQ.error as Error).message}</div>}

      <div className="grid g4 section-block">
        <div className="stat">
          <div className="k">Revenue</div>
          <div className="v">{A ? fmtINR(A.revenue.netRevenue) : "—"}</div>
          <div className="d">{A ? `${A.revenue.invoiceCount} invoices · excl. GST` : ""}</div>
        </div>
        <div className="stat" style={{ borderLeftColor: "var(--green)" }}>
          <div className="k">Gross margin</div>
          <div className="v">{A?.margin.grossMarginPct != null ? `${A.margin.grossMarginPct.toFixed(1)}%` : "—"}</div>
          <div className="d">{A ? `${signed(A.margin.grossMargin)} gross profit` : ""}</div>
        </div>
        <div className="stat" style={{ borderLeftColor: "var(--blue)" }}>
          <div className="k">Direct costs</div>
          <div className="v">{A ? fmtINR(A.costs.total) : "—"}</div>
          <div className="d">{A ? `${pct(A.costs.total, A.revenue.netRevenue)} of revenue` : ""}</div>
        </div>
        <div className="stat" style={{ borderLeftColor: A && A.collections.outstanding > 0 ? "var(--red)" : "var(--green)" }}>
          <div className="k">Cash collected</div>
          <div className="v">{A ? fmtINR(A.collections.received) : "—"}</div>
          <div className="d">{A ? `${fmtINR(A.collections.outstanding)} still to collect` : ""}</div>
        </div>
      </div>

      <div className="grid g2e section-block">
        <div className="panel">
          <div className="panel-title">Profit &amp; loss statement</div>
          <table className="pnl-table">
            <thead>
              <tr>
                <th>Line</th>
                <th className="num">Actual</th>
                <th className="num">% rev</th>
              </tr>
            </thead>
            <tbody>
              {A && (
                <>
                  <Line label="Revenue from events (net of GST)" v={A.revenue.netRevenue} of={A.revenue.netRevenue} />
                  <Line label="Expense claims" v={A.costs.expenses} of={A.revenue.netRevenue} indent />
                  <Line label="Purchase orders received" v={A.costs.purchaseOrders} of={A.revenue.netRevenue} indent />
                  <Line label="Total direct costs" v={A.costs.total} of={A.revenue.netRevenue} sub />
                  <Line label="Gross profit" v={A.margin.grossMargin} of={A.revenue.netRevenue} grand />
                  <tr>
                    <td colSpan={3} className="small faint" style={{ paddingTop: 12 }}>
                      Memo — GST collected {fmtINR(A.revenue.gstCollected)} (a liability, not revenue) · Gross invoiced {fmtINR(A.revenue.grossInvoiced)}
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
          <div className="small muted" style={{ marginTop: 8 }}>
            Operating expenses, depreciation and tax aren&apos;t recorded in Podium, so the statement stops at gross profit.
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="panel">
            <div className="panel-title">City comparison · {P[period].label}</div>
            <CityBars rows={comp.map((c) => ({ name: c.city.name, revenue: c.revenue.netRevenue, margin: c.margin.grossMargin }))} />
            <div className="chart-legend">
              <span>
                <i style={{ background: "var(--brass)" }} />
                Revenue
              </span>
              <span>
                <i style={{ background: "var(--green)" }} />
                Gross profit
              </span>
              <span>
                <i style={{ background: "var(--red)" }} />
                Loss
              </span>
            </div>
          </div>
          <div className="panel">
            <div className="panel-title">Monthly cash — last 12 months</div>
            <Trend series={cashQ.data?.series ?? []} />
            <div className="chart-legend">
              <span>
                <i style={{ background: "var(--green)" }} />
                Received
              </span>
              <span>
                <i style={{ background: "var(--red)" }} />
                Paid out
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="panel section-block">
        <div className="panel-title">City scorecard</div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>City</th>
                <th className="num">Revenue</th>
                <th className="num">Direct costs</th>
                <th className="num">Gross profit</th>
                <th className="num">Margin</th>
                <th className="num">Collected</th>
                <th className="num">Outstanding</th>
                <th className="num">Invoices</th>
              </tr>
            </thead>
            <tbody>
              {byCityQ.isLoading && (
                <tr>
                  <td colSpan={8} className="empty">
                    Loading…
                  </td>
                </tr>
              )}
              {comp.map((c) => (
                <tr key={c.city.id} className="rowhover" tabIndex={0} onClick={() => setCityId(c.city.id)}>
                  <td>
                    <b style={{ fontWeight: 600 }}>{c.city.name}</b> {c.city.id === best && <span className="pill green">Best margin</span>}
                    {c.city.id === worst && <span className="pill red">Needs attention</span>}
                  </td>
                  <td className="num">{fmtINR(c.revenue.netRevenue)}</td>
                  <td className="num">{fmtINR(c.costs.total)}</td>
                  <td className={`num ${c.margin.grossMargin < 0 ? "negative" : ""}`}>{signed(c.margin.grossMargin)}</td>
                  <td className="num">{c.margin.grossMarginPct != null ? `${c.margin.grossMarginPct.toFixed(1)}%` : "—"}</td>
                  <td className="num">{fmtINR(c.collections.received)}</td>
                  <td className={`num ${c.collections.outstanding > 0 ? "negative" : ""}`}>{c.collections.outstanding ? fmtINR(c.collections.outstanding) : "—"}</td>
                  <td className="num">{c.revenue.invoiceCount || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel" style={{ borderLeft: "3px solid var(--brass)" }}>
        <div className="panel-title">
          Forecast <span className="pill amber">Projection — not actuals</span>
        </div>
        <div className="row" style={{ gap: 8, marginBottom: 8 }}>
          <span className="small muted">Monthly baseline override (₹, optional):</span>
          <input className="inp mono" style={{ width: 140 }} type="number" min={0} value={baseline} onChange={(e) => setBaseline(e.target.value)} />
        </div>
        {forecastQ.data && <div className="small muted" style={{ marginBottom: 8 }}>{forecastQ.data.explanation}</div>}
        {forecastQ.data?.hasData && (
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th className="num">Seasonality</th>
                <th className="num">Projected net revenue</th>
              </tr>
            </thead>
            <tbody>
              {forecastQ.data.series.map((m) => (
                <tr key={m.month}>
                  <td className="mono">{m.month}</td>
                  <td className="num">{m.seasonalityIndex.toFixed(2)}×</td>
                  <td className="num">{fmtINR(m.projectedNetRevenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}

function Line({ label, v, of, indent, sub, grand }: { label: string; v: number; of: number; indent?: boolean; sub?: boolean; grand?: boolean }) {
  return (
    <tr style={{ fontWeight: sub || grand ? 600 : 400, borderTop: grand ? "2px solid var(--ink)" : sub ? "1px solid var(--line)" : undefined }}>
      <td style={{ paddingLeft: indent ? 24 : 10 }}>{label}</td>
      <td className={`num ${v < 0 ? "negative" : ""}`}>{signed(v)}</td>
      <td className="num faint">{pct(v, of)}</td>
    </tr>
  );
}

/** Revenue and gross profit per city as paired bars (SVG, no chart library). */
function CityBars({ rows }: { rows: Array<{ name: string; revenue: number; margin: number }> }) {
  if (rows.length === 0) return <div className="empty">Loading…</div>;
  const max = Math.max(1, ...rows.map((r) => Math.max(r.revenue, Math.abs(r.margin))));
  if (rows.every((r) => r.revenue === 0 && r.margin === 0)) return <div className="empty">No revenue or costs recorded in this period.</div>;
  const W = 560;
  const H = 190;
  const bw = W / rows.length;
  const h = (v: number) => (Math.abs(v) / max) * (H - 40);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Revenue and gross profit by city">
      {rows.map((r, i) => {
        const x = i * bw + bw * 0.18;
        const w = bw * 0.3;
        return (
          <g key={r.name}>
            <rect x={x} y={H - 22 - h(r.revenue)} width={w} height={h(r.revenue)} fill="var(--brass)" rx={2}>
              <title>{`${r.name} revenue ${fmtINR(r.revenue)}`}</title>
            </rect>
            <rect x={x + w + 3} y={H - 22 - h(r.margin)} width={w} height={h(r.margin)} fill={r.margin < 0 ? "var(--red)" : "var(--green)"} rx={2}>
              <title>{`${r.name} gross profit ${signed(r.margin)}`}</title>
            </rect>
            <text x={i * bw + bw / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--text-dim)">
              {r.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function Trend({ series }: { series: Array<{ month: string; inflow: number; outflow: number }> }) {
  if (series.length === 0) return <div className="empty">No payments received or expenses paid in the last 12 months.</div>;
  const W = 560;
  const H = 170;
  const max = Math.max(1, ...series.map((s) => Math.max(s.inflow, s.outflow)));
  const bw = W / series.length;
  const h = (v: number) => (v / max) * (H - 36);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Cash received and paid out by month">
      {series.map((s, i) => (
        <g key={s.month}>
          <rect x={i * bw + bw * 0.15} y={H - 20 - h(s.inflow)} width={bw * 0.33} height={h(s.inflow)} fill="var(--green)" rx={2}>
            <title>{`${s.month} received ${fmtINR(s.inflow)}`}</title>
          </rect>
          <rect x={i * bw + bw * 0.52} y={H - 20 - h(s.outflow)} width={bw * 0.33} height={h(s.outflow)} fill="var(--red)" rx={2}>
            <title>{`${s.month} paid out ${fmtINR(s.outflow)}`}</title>
          </rect>
          <text x={i * bw + bw / 2} y={H - 5} textAnchor="middle" fontSize="10" fill="var(--text-dim)">
            {new Date(`${s.month}-01`).toLocaleDateString("en-IN", { month: "short" })}
          </text>
        </g>
      ))}
    </svg>
  );
}

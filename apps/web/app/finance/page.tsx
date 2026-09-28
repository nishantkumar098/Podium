"use client";

import { fmtDate, fmtINR } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { CityChips } from "../../components/GovernanceUi";
import { api } from "../../lib/api";

interface Row {
  id: string;
  name: string;
  client: string;
  city: string;
  status: string;
  eventDate: string;
  booked: number;
  budget: number;
  invoiced: number;
  collected: number;
  receivable: number;
  invoices: number;
  cost: number;
  committed: number;
  profit: number;
  marginPct: number | null;
  hasMoney: boolean;
}

interface Finance {
  totals: { booked: number; invoiced: number; collected: number; receivable: number; cost: number; committed: number; profit: number; marginPct: number | null };
  projects: Row[];
  projectsWithMoney: number;
}

export default function ProjectFinancePage() {
  const router = useRouter();
  const [cityId, setCityId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [q, setQ] = useState("");
  const { data, isLoading, error } = useQuery({
    queryKey: ["project-finance", cityId],
    queryFn: () => api.get<Finance>(`/reports/project-finance${cityId ? `?cityId=${cityId}` : ""}`),
    staleTime: 60_000,
  });

  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (data?.projects ?? []).filter((r) => (showAll || r.hasMoney) && (!n || `${r.name} ${r.client}`.toLowerCase().includes(n)));
  }, [data, showAll, q]);
  const t = data?.totals;
  const revenueBasis = t && t.invoiced > 0 ? "invoiced" : "booked";

  return (
    <AppShell crumb="Project finance">
      <div className="page-head">
        <div>
          <div className="page-title">Project finance</div>
          <div className="page-sub">
            Consolidated across {data ? `${data.projectsWithMoney} project${data.projectsWithMoney === 1 ? "" : "s"} with figures` : "projects"} · invoices, collections and costs from real records
          </div>
        </div>
        <div className="page-actions">
          <input className="inp" placeholder="Search project or client" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 220 }} />
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <CityChips value={cityId} onChange={setCityId} />
      </div>
      {error && <div className="notice red">{(error as Error).message}</div>}
      {isLoading && <div className="empty">Loading…</div>}

      {t && (
        <div className="grid g4 section-block">
          <div className="stat">
            <div className="k">Total revenue</div>
            <div className="v">{fmtINR(revenueBasis === "invoiced" ? t.invoiced : t.booked)}</div>
            <div className="d">{revenueBasis === "invoiced" ? `invoiced · ${fmtINR(t.booked)} booked` : "booked — nothing invoiced yet"}</div>
          </div>
          <div className="stat">
            <div className="k">Total cost</div>
            <div className="v">{fmtINR(t.cost)}</div>
            <div className="d">expenses + goods received</div>
          </div>
          <div className="stat" style={{ borderLeftColor: "var(--green)" }}>
            <div className="k">Gross profit</div>
            <div className={`v ${t.profit < 0 ? "negative" : ""}`}>{fmtINR(t.profit)}</div>
            <div className={`d ${t.marginPct !== null && t.marginPct >= 0 ? "up" : "down"}`}>{t.marginPct === null ? "no revenue yet" : `${t.marginPct.toFixed(1)}% margin`}</div>
          </div>
          <div className="stat" style={{ borderLeftColor: "var(--red)" }}>
            <div className="k">Receivable · Vendor commitments</div>
            <div className="v">{fmtINR(t.receivable)}</div>
            <div className="d">{fmtINR(t.committed)} in open purchase orders</div>
          </div>
        </div>
      )}

      {data && (
        <div className="panel">
          <div className="panel-title">
            Project-wise P&amp;L
            <label className="small" style={{ fontWeight: 400, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              Show all {data.projects.length} projects (enter revenue &amp; budget)
            </label>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th className="num">Booked</th>
                  <th className="num">Budget</th>
                  <th className="num">Invoiced</th>
                  <th className="num">Collected</th>
                  <th className="num">Cost</th>
                  <th className="num">Profit</th>
                  <th className="num">Margin</th>
                  <th className="num">Receivable</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="empty">
                      {data.projectsWithMoney === 0 && !showAll
                        ? "No project has revenue, a budget, invoices or costs recorded yet. Tick “Show all projects” to enter booked revenue and budgets."
                        : "No projects match."}
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <FinanceRow key={r.id} r={r} editable={showAll} onOpen={() => router.push(`/projects/${r.id}?tab=budget`)} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>
            Margin is on invoiced revenue once a project is invoiced, and on its booked value before that. Cost = approved expense claims + purchase orders
            whose goods arrived + any actual cost entered on the project.
          </div>
        </div>
      )}
    </AppShell>
  );
}

function FinanceRow({ r, editable, onOpen }: { r: Row; editable: boolean; onOpen: () => void }) {
  const qc = useQueryClient();
  const [booked, setBooked] = useState(String(r.booked || ""));
  const [budget, setBudget] = useState(String(r.budget || ""));
  const dirty = Number(booked || 0) !== r.booked || Number(budget || 0) !== r.budget;
  const save = useMutation({
    mutationFn: () => api.patch(`/projects/${r.id}`, { revenue: Number(booked || 0), estCost: Number(budget || 0) }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ["project-finance"] }), qc.invalidateQueries({ queryKey: ["projects"] })]),
  });
  const money = (n: number) => (n ? fmtINR(n) : "—");

  return (
    <tr className="rowhover" onClick={editable ? undefined : onOpen}>
      <td>
        <span className="linkish" onClick={onOpen} style={{ cursor: "pointer" }}>
          {r.name}
        </span>
        <div className="small faint">
          {r.client} · {r.city} · {fmtDate(r.eventDate)}
        </div>
        {save.error && <div className="small negative">{(save.error as Error).message}</div>}
      </td>
      {editable ? (
        <>
          <td className="num" onClick={(e) => e.stopPropagation()}>
            <input className="inp mono" style={{ width: 110, textAlign: "right" }} type="number" min={0} value={booked} onChange={(e) => setBooked(e.target.value)} />
          </td>
          <td className="num" onClick={(e) => e.stopPropagation()}>
            <input className="inp mono" style={{ width: 110, textAlign: "right" }} type="number" min={0} value={budget} onChange={(e) => setBudget(e.target.value)} />
            {dirty && (
              <button className="btn-primary btn-sm" style={{ marginLeft: 6 }} disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? "…" : "Save"}
              </button>
            )}
          </td>
        </>
      ) : (
        <>
          <td className="num">{money(r.booked)}</td>
          <td className="num">{money(r.budget)}</td>
        </>
      )}
      <td className="num">{money(r.invoiced)}</td>
      <td className="num">{money(r.collected)}</td>
      <td className="num">{money(r.cost)}</td>
      <td className={`num ${r.profit < 0 ? "negative" : r.profit > 0 ? "positive" : ""}`}>{r.booked || r.invoiced || r.cost ? fmtINR(r.profit) : "—"}</td>
      <td className="num">{r.marginPct === null ? "—" : `${r.marginPct.toFixed(0)}%`}</td>
      <td className={`num ${r.receivable > 0 ? "negative" : ""}`}>{money(r.receivable)}</td>
    </tr>
  );
}

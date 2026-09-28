"use client";

import { fmtDate, fmtINR } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { CityOptionDto, PnlActualsDto } from "../lib/types";
import { ProjectSelect } from "./OpsUi";

type Section = "REVENUE" | "DIRECT_COST" | "OPEX" | "OTHER_INCOME" | "TAX";

interface Totals {
  revenue: number;
  directCosts: number;
  grossProfit: number;
  opex: number;
  operatingProfit: number;
  otherIncome: number;
  profitBeforeTax: number;
  tax: number;
  netProfit: number;
  grossMarginPct: number | null;
  operatingMarginPct: number | null;
  netMarginPct: number | null;
}

export interface PnlStatementDto {
  id: string;
  title: string;
  cityId: string | null;
  projectId: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  notes: string | null;
  cityName: string | null;
  projectName: string | null;
  createdByName: string | null;
  updatedAt: string;
  lineCount?: number;
  lines?: Array<{ id: string; section: Section; label: string; amount: string | number; position: number }>;
  totals: Totals;
}

const SECTIONS: Array<{ key: Section; title: string; hint: string; sign: 1 | -1 }> = [
  { key: "REVENUE", title: "Revenue", hint: "Event billing, bar sales, other operating income", sign: 1 },
  { key: "DIRECT_COST", title: "Direct costs", hint: "Liquor, consumables, bar staff, logistics — costs of delivering events", sign: -1 },
  { key: "OPEX", title: "Operating expenses", hint: "Salaries, rent, marketing, utilities, admin", sign: -1 },
  { key: "OTHER_INCOME", title: "Other income", hint: "Interest, rebates, one-off income", sign: 1 },
  { key: "TAX", title: "Tax", hint: "Income tax for the period", sign: -1 },
];

/** A fresh statement starts with the usual lines, amounts blank. */
const TEMPLATE: Array<{ section: Section; label: string }> = [
  { section: "REVENUE", label: "Event revenue (net of GST)" },
  { section: "DIRECT_COST", label: "Liquor & consumables" },
  { section: "DIRECT_COST", label: "Bar staff & manpower" },
  { section: "DIRECT_COST", label: "Logistics & transport" },
  { section: "OPEX", label: "Salaries" },
  { section: "OPEX", label: "Rent & utilities" },
  { section: "OPEX", label: "Marketing" },
  { section: "TAX", label: "Income tax" },
];

interface DraftLine {
  key: number;
  section: Section;
  label: string;
  amount: string;
}

let nextKey = 1;
const draft = (section: Section, label = "", amount = ""): DraftLine => ({ key: nextKey++, section, label, amount });
const round2 = (n: number) => Math.round(n * 100) / 100;
const signed = (n: number) => `${n < 0 ? "−" : ""}${fmtINR(Math.abs(n))}`;
const pctText = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);

/** Same arithmetic as the server (pnl-statements.service → pnlTotals), for the live preview. */
function totalsOf(lines: DraftLine[]): Totals {
  const sum = (s: Section) => round2(lines.filter((l) => l.section === s && l.label.trim()).reduce((t, l) => t + (Number(l.amount) || 0), 0));
  const revenue = sum("REVENUE");
  const directCosts = sum("DIRECT_COST");
  const opex = sum("OPEX");
  const otherIncome = sum("OTHER_INCOME");
  const tax = sum("TAX");
  const grossProfit = round2(revenue - directCosts);
  const operatingProfit = round2(grossProfit - opex);
  const profitBeforeTax = round2(operatingProfit + otherIncome);
  const netProfit = round2(profitBeforeTax - tax);
  const pctOf = (v: number) => (revenue > 0 ? Math.round((v / revenue) * 1000) / 10 : null);
  return { revenue, directCosts, grossProfit, opex, operatingProfit, otherIncome, profitBeforeTax, tax, netProfit, grossMarginPct: pctOf(grossProfit), operatingMarginPct: pctOf(operatingProfit), netMarginPct: pctOf(netProfit) };
}

const scopeLabel = (s: Pick<PnlStatementDto, "cityName" | "projectName">) => (s.projectName ? `Project · ${s.projectName}` : s.cityName ? s.cityName : "Company-wide");
const periodLabel = (s: Pick<PnlStatementDto, "periodFrom" | "periodTo">) =>
  s.periodFrom || s.periodTo ? `${s.periodFrom ? fmtDate(s.periodFrom) : "…"} – ${s.periodTo ? fmtDate(s.periodTo) : "…"}` : "—";

function csvFor(s: PnlStatementDto) {
  const cell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const t = s.totals;
  const rows: Array<Array<string | number>> = [[s.title], [scopeLabel(s), periodLabel(s)], [], ["Section", "Line", "Amount"]];
  for (const sec of SECTIONS) for (const l of (s.lines ?? []).filter((x) => x.section === sec.key)) rows.push([sec.title, l.label, Number(l.amount)]);
  rows.push(
    [],
    ["Revenue", "", t.revenue],
    ["Direct costs", "", -t.directCosts],
    ["Gross profit", "", t.grossProfit],
    ["Operating expenses", "", -t.opex],
    ["Operating profit (EBITDA)", "", t.operatingProfit],
    ["Other income", "", t.otherIncome],
    ["Profit before tax", "", t.profitBeforeTax],
    ["Tax", "", -t.tax],
    ["Net profit", "", t.netProfit],
    ["Net margin %", "", t.netMarginPct ?? ""],
  );
  const blob = new Blob([rows.map((r) => r.map(cell).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pnl-${s.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** The saved statements, listed on the P&L page. */
export function PnlStatementList({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, isLoading, error } = useQuery({ queryKey: ["pnl-statements"], queryFn: () => api.get<PnlStatementDto[]>("/pnl-statements") });
  const exportOne = async (id: string) => csvFor(await api.get<PnlStatementDto>(`/pnl-statements/${id}`));
  if (!isLoading && !error && (data?.length ?? 0) === 0) return null;
  return (
    <div className="panel section-block">
      <div className="panel-title">
        Your P&amp;L statements <span className="faint">· {data?.length ?? 0}</span>
      </div>
      {error && <div className="notice red">{(error as Error).message}</div>}
      {isLoading ? (
        <div className="empty">Loading…</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Statement</th>
                <th>For</th>
                <th>Period</th>
                <th className="num">Revenue</th>
                <th className="num">Gross profit</th>
                <th className="num">Net profit</th>
                <th className="num">Net margin</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data!.map((s) => (
                <tr key={s.id} className="rowhover" tabIndex={0} onClick={() => onOpen(s.id)} onKeyDown={(e) => e.key === "Enter" && onOpen(s.id)}>
                  <td>
                    <b style={{ fontWeight: 600 }}>{s.title}</b>
                    <div className="small faint">
                      {s.createdByName ?? ""} · updated {fmtDate(s.updatedAt)}
                    </div>
                  </td>
                  <td className="small">{scopeLabel(s)}</td>
                  <td className="small mono">{periodLabel(s)}</td>
                  <td className="num">{fmtINR(s.totals.revenue)}</td>
                  <td className={`num ${s.totals.grossProfit < 0 ? "negative" : ""}`}>{signed(s.totals.grossProfit)}</td>
                  <td className={`num ${s.totals.netProfit < 0 ? "negative" : "positive"}`}>
                    <b style={{ fontWeight: 600 }}>{signed(s.totals.netProfit)}</b>
                  </td>
                  <td className="num">{pctText(s.totals.netMarginPct)}</td>
                  <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                    <button className="btn-ghost btn-sm" onClick={() => onOpen(s.id)}>
                      Open
                    </button>{" "}
                    <button className="btn-ghost btn-sm" onClick={() => void exportOne(s.id)}>
                      CSV
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Build or edit a P&L statement: scope, period, lines by section, live
 * totals down to net profit. "Pre-fill from actuals" pulls the computed
 * revenue and direct costs for the chosen scope and period as a starting point.
 */
export function PnlEditor({
  id,
  canEdit,
  defaultFrom,
  defaultTo,
  onClose,
}: {
  id: string | "new";
  canEdit: boolean;
  defaultFrom: string;
  defaultTo: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isNew = id === "new";
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: () => api.get<CityOptionDto[]>("/cities") });
  const existing = useQuery({ queryKey: ["pnl-statement", id], queryFn: () => api.get<PnlStatementDto>(`/pnl-statements/${id}`), enabled: !isNew });
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [f, setF] = useState({ title: "", cityId: "", projectId: "", periodFrom: defaultFrom, periodTo: defaultTo, notes: "" });
  const [lines, setLines] = useState<DraftLine[]>(() => (isNew ? TEMPLATE.map((t) => draft(t.section, t.label)) : []));
  const [notice, setNotice] = useState<string | null>(null);

  // Load an existing statement into the form once.
  if (!isNew && existing.data && loadedFor !== existing.data.id) {
    const s = existing.data;
    setLoadedFor(s.id);
    setF({ title: s.title, cityId: s.cityId ?? "", projectId: s.projectId ?? "", periodFrom: s.periodFrom?.slice(0, 10) ?? "", periodTo: s.periodTo?.slice(0, 10) ?? "", notes: s.notes ?? "" });
    setLines((s.lines ?? []).map((l) => draft(l.section, l.label, String(Number(l.amount)))));
  }

  const totals = useMemo(() => totalsOf(lines), [lines]);
  const patch = (key: number, p: Partial<DraftLine>) => setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...p } : l)));

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["pnl-statements"] });
    await qc.invalidateQueries({ queryKey: ["pnl-statement", id] });
  };
  const payload = () => ({
    title: f.title.trim(),
    cityId: f.projectId ? null : f.cityId || null,
    projectId: f.projectId || null,
    periodFrom: f.periodFrom || null,
    periodTo: f.periodTo || null,
    notes: f.notes.trim() || null,
    lines: lines.filter((l) => l.label.trim()).map((l) => ({ section: l.section, label: l.label.trim(), amount: Number(l.amount) || 0 })),
  });
  const save = useMutation({
    mutationFn: () => (isNew ? api.post<PnlStatementDto>("/pnl-statements", payload()) : api.patch<PnlStatementDto>(`/pnl-statements/${id}`, payload())),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/pnl-statements/${id}`),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });

  const prefill = useMutation({
    mutationFn: () => {
      const from = f.periodFrom ? new Date(`${f.periodFrom}T00:00:00`).toISOString() : "";
      const to = f.periodTo ? new Date(`${f.periodTo}T23:59:59`).toISOString() : "";
      const scope = f.projectId ? `project&projectId=${f.projectId}` : f.cityId ? `city&cityId=${f.cityId}` : "company";
      return api.get<PnlActualsDto>(`/reports/pnl?scope=${scope}${from ? `&from=${encodeURIComponent(from)}` : ""}${to ? `&to=${encodeURIComponent(to)}` : ""}`);
    },
    onSuccess: (a) => {
      const auto = new Set(["Revenue from events (net of GST) — actuals", "Expense claims — actuals", "Purchase orders received — actuals"]);
      setLines((cur) => {
        const kept = cur.filter((l) => !auto.has(l.label) && !(l.section === "REVENUE" && l.label === "Event revenue (net of GST)" && !l.amount));
        return [
          draft("REVENUE", "Revenue from events (net of GST) — actuals", String(a.revenue.netRevenue)),
          draft("DIRECT_COST", "Expense claims — actuals", String(a.costs.expenses)),
          draft("DIRECT_COST", "Purchase orders received — actuals", String(a.costs.purchaseOrders)),
          ...kept,
        ];
      });
      setNotice(a.hasData ? `Filled from actuals: ${a.revenue.invoiceCount} invoices, ${fmtINR(a.costs.total)} of recorded costs. Add operating expenses and tax yourself — Podium doesn't record them.` : a.explanation ?? "No recorded actuals for that scope and period.");
    },
  });

  const ro = !canEdit;
  const valid = f.title.trim() && lines.some((l) => l.label.trim());

  if (!isNew && existing.isLoading) return <div className="panel section-block"><div className="empty">Loading statement…</div></div>;
  if (!isNew && existing.error) return <div className="panel section-block"><div className="notice red">{(existing.error as Error).message}</div></div>;

  return (
    <div className="panel section-block" style={{ borderLeft: "3px solid var(--brass)" }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div className="panel-title" style={{ margin: 0 }}>
          {isNew ? "New P&L statement" : ro ? f.title : `Edit — ${f.title}`}
        </div>
        <button className="btn-ghost btn-sm" onClick={onClose}>
          Close
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 12, marginBottom: 12 }}>
        <label className="small" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Title
          <input className="inp" disabled={ro} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Delhi — Q2 FY26-27" autoFocus={isNew} />
        </label>
        <label className="small" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          City
          <select className="inp" disabled={ro || !!f.projectId} value={f.cityId} onChange={(e) => setF({ ...f, cityId: e.target.value })}>
            <option value="">Company-wide (all cities)</option>
            {cities?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="small" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Project (optional)
          {ro ? <input className="inp" disabled value={existing.data?.projectName ?? "—"} /> : <ProjectSelect value={f.projectId} onChange={(v) => setF({ ...f, projectId: v })} />}
        </label>
        <label className="small" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Period from
          <input className="inp" type="date" disabled={ro} value={f.periodFrom} onChange={(e) => setF({ ...f, periodFrom: e.target.value })} />
        </label>
        <label className="small" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Period to
          <input className="inp" type="date" disabled={ro} value={f.periodTo} onChange={(e) => setF({ ...f, periodTo: e.target.value })} />
        </label>
      </div>
      {f.projectId && <div className="small muted" style={{ marginBottom: 10 }}>A project statement takes the project&apos;s city.</div>}

      {!ro && (
        <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <button className="btn-ghost btn-sm" disabled={prefill.isPending} onClick={() => prefill.mutate()}>
            {prefill.isPending ? "Fetching actuals…" : "Pre-fill from actuals"}
          </button>
          <span className="small muted">Pulls recorded revenue and direct costs for this {f.projectId ? "project" : f.cityId ? "city" : "company"} and period.</span>
        </div>
      )}
      {notice && <div className="notice" style={{ marginBottom: 12 }}>{notice}</div>}
      {prefill.error && <div className="notice red" style={{ marginBottom: 12 }}>{(prefill.error as Error).message}</div>}

      <div className="grid g-side-r" style={{ alignItems: "start" }}>
        <div>
          {SECTIONS.map((sec) => {
            const rows = lines.filter((l) => l.section === sec.key);
            const subtotal = rows.filter((l) => l.label.trim()).reduce((t, l) => t + (Number(l.amount) || 0), 0);
            return (
              <div key={sec.key} style={{ marginBottom: 14 }}>
                <div className="row" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--line)", paddingBottom: 4, marginBottom: 6 }}>
                  <span>
                    <b style={{ fontWeight: 600 }}>{sec.title}</b> <span className="small faint">{sec.hint}</span>
                  </span>
                  <span className="mono small">{fmtINR(round2(subtotal))}</span>
                </div>
                {rows.map((l) => (
                  <div key={l.key} className="row" style={{ gap: 6, marginBottom: 5, flexWrap: "nowrap" }}>
                    <input className="inp" style={{ flex: 1, minWidth: 0 }} disabled={ro} value={l.label} onChange={(e) => patch(l.key, { label: e.target.value })} placeholder="Line" />
                    <input
                      className="inp mono tright"
                      style={{ width: 130 }}
                      type="number"
                      min={0}
                      step="0.01"
                      disabled={ro}
                      value={l.amount}
                      onChange={(e) => patch(l.key, { amount: e.target.value })}
                      placeholder="0"
                    />
                    {!ro && (
                      <button className="btn-ghost btn-sm" title="Remove line" onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))}>
                        ×
                      </button>
                    )}
                  </div>
                ))}
                {!ro && (
                  <button className="linkish small" onClick={() => setLines((cur) => [...cur, draft(sec.key)])}>
                    + Add {sec.title.toLowerCase()} line
                  </button>
                )}
              </div>
            );
          })}
          <label className="small" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            Notes
            <textarea className="inp" rows={2} disabled={ro} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </label>
        </div>

        <div className="panel" style={{ background: "var(--paper)", position: "sticky", top: 12 }}>
          <div className="panel-title">Statement</div>
          <table className="pnl-table">
            <tbody>
              <Row k="Revenue" v={totals.revenue} />
              <Row k="Direct costs" v={-totals.directCosts} indent />
              <Row k="Gross profit" v={totals.grossProfit} pct={totals.grossMarginPct} sub />
              <Row k="Operating expenses" v={-totals.opex} indent />
              <Row k="Operating profit (EBITDA)" v={totals.operatingProfit} pct={totals.operatingMarginPct} sub />
              <Row k="Other income" v={totals.otherIncome} indent />
              <Row k="Profit before tax" v={totals.profitBeforeTax} sub />
              <Row k="Tax" v={-totals.tax} indent />
              <Row k="Net profit" v={totals.netProfit} pct={totals.netMarginPct} grand />
            </tbody>
          </table>
          <div className="small muted" style={{ marginTop: 8 }}>
            Hand-built statement — kept separate from the computed actuals above.
          </div>
        </div>
      </div>

      {(save.error || remove.error) && <div className="notice red" style={{ marginTop: 10 }}>{((save.error || remove.error) as ApiError).message}</div>}
      <div className="page-actions" style={{ marginTop: 14 }}>
        {!ro && (
          <button className="btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : isNew ? "Save P&L" : "Save changes"}
          </button>
        )}
        {!isNew && existing.data && (
          <button className="btn-ghost" onClick={() => csvFor({ ...existing.data!, totals })}>
            Export CSV
          </button>
        )}
        {!isNew && !ro && (
          <button className="btn-ghost" disabled={remove.isPending} onClick={() => window.confirm(`Delete "${f.title}"?`) && remove.mutate()}>
            Delete
          </button>
        )}
        <button className="btn-ghost" onClick={onClose}>
          {ro ? "Close" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

function Row({ k, v, pct, indent, sub, grand }: { k: string; v: number; pct?: number | null; indent?: boolean; sub?: boolean; grand?: boolean }) {
  return (
    <tr style={{ fontWeight: sub || grand ? 600 : 400, borderTop: grand ? "2px solid var(--ink)" : sub ? "1px solid var(--line)" : undefined }}>
      <td style={{ paddingLeft: indent ? 22 : 8 }}>{k}</td>
      <td className={`num ${v < 0 && (sub || grand) ? "negative" : ""}`}>{signed(v)}</td>
      <td className="num faint small">{pct !== undefined ? pctText(pct ?? null) : ""}</td>
    </tr>
  );
}

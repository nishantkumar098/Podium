"use client";

import { daysTo, fmtDate, fmtINR } from "@podium/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { CityChips } from "../../components/GovernanceUi";
import { api, apiDownload } from "../../lib/api";

interface InvoiceRow {
  id: string;
  invoiceNo: string;
  docType: "TAX_INVOICE" | "ESTIMATE";
  status: "DRAFT" | "ISSUED" | "PARTIALLY_PAID" | "PAID" | "OVERDUE" | "CANCELLED";
  issueDate: string | null;
  dueDate: string;
  taxableAmount: string;
  total: string;
  paid: number;
  balance: number;
  overdue: boolean;
  client: { id: string; name: string; email: string | null };
  project: { id: string; name: string };
  city: { id: string; name: string };
}

const FILTERS = ["All", "Draft", "Sent", "Part-paid", "Overdue", "Paid", "Estimates", "Cancelled"] as const;
type Filter = (typeof FILTERS)[number];

function matches(i: InvoiceRow, f: Filter): boolean {
  switch (f) {
    case "Draft":
      return i.status === "DRAFT";
    case "Sent":
      return i.docType === "TAX_INVOICE" && (i.status === "ISSUED" || i.status === "OVERDUE") && !i.overdue;
    case "Part-paid":
      return i.status === "PARTIALLY_PAID";
    case "Overdue":
      return i.overdue;
    case "Paid":
      return i.status === "PAID";
    case "Estimates":
      return i.docType === "ESTIMATE";
    case "Cancelled":
      return i.status === "CANCELLED";
    default:
      return true;
  }
}

/** What the table calls each invoice — the money position, not just the stored status. */
function statusPill(i: InvoiceRow) {
  if (i.docType === "ESTIMATE") return <span className="pill gray">Estimate</span>;
  if (i.status === "DRAFT") return <span className="pill gray">Draft</span>;
  if (i.status === "CANCELLED") return <span className="pill gray">Cancelled</span>;
  if (i.status === "PAID") return <span className="pill green">Paid</span>;
  if (i.overdue) return <span className="pill red">Overdue {-daysTo(i.dueDate)}d</span>;
  if (i.status === "PARTIALLY_PAID") return <span className="pill amber">Part-paid</span>;
  return <span className="pill blue">Sent</span>;
}

const BUCKETS: Array<{ label: string; color: string; test: (d: number) => boolean }> = [
  { label: "Not due", color: "var(--blue)", test: (d) => d >= 0 },
  { label: "1–30 days", color: "var(--brass)", test: (d) => d < 0 && d >= -30 },
  { label: "31–60 days", color: "var(--amber)", test: (d) => d < -30 && d >= -60 },
  { label: "60+ days", color: "var(--red)", test: (d) => d < -60 },
];

function csvCell(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function InvoicesPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("All");
  const [cityId, setCityId] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey: ["invoices"], queryFn: () => api.get<InvoiceRow[]>("/invoices") });

  const scoped = useMemo(() => (data ?? []).filter((i) => !cityId || i.city.id === cityId), [data, cityId]);
  const taxInvoices = scoped.filter((i) => i.docType === "TAX_INVOICE" && i.status !== "DRAFT" && i.status !== "CANCELLED");
  const billed = taxInvoices.reduce((s, i) => s + Number(i.total), 0);
  const collected = taxInvoices.reduce((s, i) => s + i.paid, 0);
  const outstanding = taxInvoices.reduce((s, i) => s + i.balance, 0);
  const overdue = taxInvoices.filter((i) => i.overdue).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const buckets = BUCKETS.map((b) => ({ ...b, value: taxInvoices.filter((i) => i.balance > 0 && b.test(daysTo(i.dueDate))).reduce((s, i) => s + i.balance, 0) }));
  const bucketTotal = buckets.reduce((s, b) => s + b.value, 0) || 1;
  const list = scoped.filter((i) => matches(i, filter));

  const exportCsv = () => {
    const header = ["Invoice", "Type", "Status", "Client", "Project", "City", "Issued", "Due", "Taxable", "Total", "Paid", "Balance"];
    const lines = scoped.map((i) =>
      [
        i.status === "DRAFT" ? "Draft" : i.invoiceNo,
        i.docType === "ESTIMATE" ? "Estimate" : "Tax invoice",
        i.overdue ? "OVERDUE" : i.status,
        i.client.name,
        i.project.name,
        i.city.name,
        i.issueDate ? i.issueDate.slice(0, 10) : "",
        i.dueDate.slice(0, 10),
        Number(i.taxableAmount),
        Number(i.total),
        i.paid,
        i.balance,
      ]
        .map(csvCell)
        .join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `podium-invoices-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const reminder = (i: InvoiceRow) => {
    const q = new URLSearchParams({
      view: "cm",
      fs: "1",
      to: i.client.email ?? "",
      su: `Payment reminder — invoice ${i.invoiceNo}`,
      body: `Dear ${i.client.name},\n\nThis is a gentle reminder that invoice ${i.invoiceNo} for ${fmtINR(i.balance)} was due on ${fmtDate(i.dueDate)}. We'd be grateful if you could arrange payment at the earliest.\n\nThank you,\nAMM Brands LLP`,
    });
    window.open(`https://mail.google.com/mail/?${q.toString()}`, "_blank");
  };

  return (
    <AppShell crumb="Invoices">
      <div className="page-head">
        <div>
          <div className="page-title">Invoices</div>
          <div className="page-sub">GST invoices by city branch · CGST + SGST within the state, IGST across states</div>
        </div>
        <div className="page-actions">
          <button className="btn-ghost" disabled={scoped.length === 0} onClick={exportCsv}>
            Export CSV
          </button>
          <Link className="btn-primary" href="/invoices/new">
            + New invoice
          </Link>
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <CityChips value={cityId} onChange={setCityId} />
      </div>
      {error && <div className="notice red">{(error as Error).message}</div>}

      <div className="grid g4 section-block">
        <div className="stat">
          <div className="k">Billed</div>
          <div className="v">{fmtINR(billed)}</div>
          <div className="d">{taxInvoices.length} issued invoices incl. GST</div>
        </div>
        <div className="stat" style={{ borderLeftColor: "var(--green)" }}>
          <div className="k">Collected</div>
          <div className="v">{fmtINR(collected)}</div>
          <div className="d up">{billed ? `${Math.round((collected / billed) * 100)}% of billed` : "—"}</div>
        </div>
        <div className="stat" style={{ borderLeftColor: "var(--blue)" }}>
          <div className="k">Outstanding</div>
          <div className="v">{fmtINR(outstanding)}</div>
          <div className="d">sent, not yet paid</div>
        </div>
        <div className="stat" style={{ borderLeftColor: "var(--red)" }}>
          <div className="k">Overdue</div>
          <div className="v">{fmtINR(overdue.reduce((s, i) => s + i.balance, 0))}</div>
          <div className="d down">
            {overdue.length} invoice{overdue.length === 1 ? "" : "s"} past due
          </div>
        </div>
      </div>

      <div className="grid g-side-r">
        <div className="panel">
          <div className="chips" style={{ marginBottom: 10 }}>
            {FILTERS.map((f) => (
              <button key={f} className={`chipbtn ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
                {f}
              </button>
            ))}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Client · project</th>
                  <th>City</th>
                  <th>Due</th>
                  <th className="num">Total</th>
                  <th className="num">Balance</th>
                  <th>Status</th>
                  <th />
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
                {!isLoading && list.length === 0 && (
                  <tr>
                    <td colSpan={8} className="empty">
                      {scoped.length === 0 ? "No invoices yet — create the first with + New invoice." : "No invoices match this filter."}
                    </td>
                  </tr>
                )}
                {list.map((i) => (
                  <tr key={i.id} className="rowhover" tabIndex={0} onClick={() => router.push(`/invoices/${i.id}`)}>
                    <td className="mono small">{i.status === "DRAFT" ? "Draft" : i.invoiceNo}</td>
                    <td>
                      {i.client.name}
                      <div className="small faint">{i.project.name}</div>
                    </td>
                    <td>{i.city.name}</td>
                    <td className={`mono small ${i.overdue ? "negative" : ""}`}>{fmtDate(i.dueDate)}</td>
                    <td className="num">{fmtINR(Number(i.total))}</td>
                    <td className="num">{i.balance > 0 ? fmtINR(i.balance) : "—"}</td>
                    <td>{statusPill(i)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        className="btn-ghost btn-sm"
                        title="Download PDF"
                        onClick={() =>
                          apiDownload(`/invoices/${i.id}/pdf`, i.status === "DRAFT" ? `DRAFT - ${i.client.name}.pdf` : `${i.invoiceNo.split("/").join("-")}.pdf`).catch(() => undefined)
                        }
                      >
                        PDF
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="panel">
            <div className="panel-title">Receivables ageing</div>
            <div className="aging">
              {buckets.map((b) => (
                <div key={b.label} style={{ width: `${(b.value / bucketTotal) * 100}%`, background: b.color }} title={`${b.label}: ${fmtINR(b.value)}`} />
              ))}
            </div>
            {buckets.map((b) => (
              <div key={b.label} className="row small" style={{ justifyContent: "space-between", padding: "3px 0" }}>
                <span>
                  <i style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: b.color, marginRight: 6 }} />
                  {b.label}
                </span>
                <span className="mono">{fmtINR(b.value)}</span>
              </div>
            ))}
          </div>
          <div className="panel">
            <div className="panel-title">Chase today</div>
            {overdue.length === 0 && <div className="empty">Nothing overdue.</div>}
            {overdue.slice(0, 8).map((i) => (
              <div key={i.id} style={{ padding: "7px 0", borderBottom: "1px solid #F1EEE5", fontSize: 12 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <b style={{ fontWeight: 500 }}>{i.client.name}</b>
                  <span className="mono negative">{-daysTo(i.dueDate)}d late</span>
                </div>
                <div className="small muted">
                  {i.invoiceNo} · {fmtINR(i.balance)}
                </div>
                <div className="row" style={{ marginTop: 5, gap: 6 }}>
                  <button className="btn-ghost btn-sm" onClick={() => reminder(i)} title={i.client.email ? `To ${i.client.email}` : "No e-mail on file — add the address in Gmail"}>
                    Remind via Gmail
                  </button>
                  <button className="btn-ghost btn-sm" onClick={() => router.push(`/invoices/${i.id}`)}>
                    Record payment
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

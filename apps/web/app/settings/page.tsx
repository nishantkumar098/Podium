"use client";

import { fmtINR } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { AppShell } from "../../components/AppShell";
import { FormField } from "../../components/GovernanceUi";
import { title } from "../../components/OpsUi";
import { api } from "../../lib/api";

interface Settings {
  canEdit: boolean;
  workspace: {
    name: string;
    gstin: string | null;
    address: string | null;
    website: string | null;
    bankName: string | null;
    bankAccountName: string | null;
    bankAccountNo: string | null;
    bankIfsc: string | null;
    invoiceTerms: string[];
    invoiceDeclaration: string | null;
    procurementApprovalThreshold: number;
  };
  brands: Array<{ id: string; name: string; code: string; tagline: string | null }>;
  cities: Array<{ id: string; name: string; code: string; state: string; gstStateCode: string; isHq: boolean }>;
  roles: Array<{ id: string; name: string; description: string | null; people: number; permissions: string[] }>;
  people: number;
  integrations: { google: { mode: "disabled" | "sandbox" | "live"; credentialsPresent: boolean; scopes: string[] } };
}

/** Task statuses the board runs on (TaskStatus in the schema). */
const TASK_STATUSES = ["BACKLOG", "PLANNED", "IN_PROGRESS", "CLIENT_REVIEW", "APPROVED", "COMPLETED"];
const PROJECT_STATUSES = ["PLANNING", "PLANNED", "IN_PROGRESS", "CLIENT_REVIEW", "ON_HOLD", "COMPLETED", "CANCELLED"];

export default function SettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/settings") });

  return (
    <AppShell crumb="Settings">
      <div className="page-head">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-sub">Workspace details used on every invoice and letter, roles &amp; permissions, cities and integrations</div>
        </div>
      </div>
      {error && <div className="notice red">{(error as Error).message}</div>}
      {isLoading && <div className="empty">Loading…</div>}

      {data && (
        <>
          <WorkspaceForm data={data} onSaved={() => qc.invalidateQueries({ queryKey: ["settings"] })} />

          <div className="panel section-block">
            <div className="panel-title">Integrations</div>
            <table>
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Status</th>
                  <th>What it needs</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ fontWeight: 600 }}>Gmail · Google Calendar · Meet</td>
                  <td>
                    {data.integrations.google.mode === "live" ? (
                      <span className="pill green">Live</span>
                    ) : data.integrations.google.mode === "sandbox" ? (
                      <span className="pill amber">Sandbox (test data)</span>
                    ) : (
                      <span className="pill gray">Not configured</span>
                    )}
                  </td>
                  <td className="small muted">
                    {data.integrations.google.credentialsPresent
                      ? "Credentials are configured. Connect your own account on the Mail screen."
                      : "A Google Cloud OAuth client (Gmail + Calendar APIs enabled), its client ID and secret in the server's .env, and GOOGLE_INTEGRATION_MODE=live."}
                    <div className="mono faint" style={{ marginTop: 4 }}>{data.integrations.google.scopes.join(" ")}</div>
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="small muted" style={{ marginTop: 8 }}>
              Only integrations that are actually wired up are listed. <Link href="/mail">Mail</Link> shows the connection steps.
            </div>
          </div>

          <div className="panel section-block">
            <div className="panel-title">
              Roles &amp; permissions <Link href="/team">Team &amp; logins →</Link>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Role</th>
                  <th className="num">People</th>
                  <th>Can do</th>
                </tr>
              </thead>
              <tbody>
                {data.roles.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>
                      {r.name}
                      {r.description && <div className="small muted" style={{ fontWeight: 400 }}>{r.description}</div>}
                    </td>
                    <td className="num">{r.people || "—"}</td>
                    <td>
                      {r.permissions.length === 0 ? (
                        <span className="small muted">No permissions granted</span>
                      ) : (
                        r.permissions.map((p) => (
                          <span key={p} className="perm-chip">
                            {p}
                          </span>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="small muted" style={{ marginTop: 8 }}>
              {data.people} active {data.people === 1 ? "person" : "people"}. Roles are fixed in this build; who holds which role is managed in Team &amp; logins.
            </div>
          </div>

          <div className="grid g2">
            <div className="panel">
              <div className="panel-title">Cities of operation</div>
              <table>
                <thead>
                  <tr>
                    <th>City</th>
                    <th>State</th>
                    <th className="mono">GST code</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cities.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.name} {c.isHq && <span className="pill gray">HQ</span>}
                      </td>
                      <td className="small">{c.state}</td>
                      <td className="mono">{c.gstStateCode}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="small muted" style={{ marginTop: 8 }}>
                The GST state code decides CGST+SGST within the state vs IGST across states on each city branch&apos;s invoices.
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="panel">
                <div className="panel-title">Brands</div>
                {data.brands.map((b) => (
                  <div key={b.id} className="row" style={{ padding: "6px 0", borderBottom: "1px solid #F1EEE5", justifyContent: "space-between" }}>
                    <span>
                      {b.name}
                      {b.tagline && <div className="small muted">{b.tagline}</div>}
                    </span>
                    <span className="mono small faint">{b.code}</span>
                  </div>
                ))}
              </div>
              <div className="panel">
                <div className="panel-title">Status engine</div>
                <div className="small muted">Tasks</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "4px 0 10px" }}>
                  {TASK_STATUSES.map((s) => (
                    <span key={s} className="pill gray">
                      {title(s)}
                    </span>
                  ))}
                </div>
                <div className="small muted">Projects</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                  {PROJECT_STATUSES.map((s) => (
                    <span key={s} className="pill gray">
                      {title(s)}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}

function WorkspaceForm({ data, onSaved }: { data: Settings; onSaved: () => void }) {
  const w = data.workspace;
  const [f, setF] = useState({
    name: w.name,
    gstin: w.gstin ?? "",
    address: w.address ?? "",
    website: w.website ?? "",
    bankName: w.bankName ?? "",
    bankAccountName: w.bankAccountName ?? "",
    bankAccountNo: w.bankAccountNo ?? "",
    bankIfsc: w.bankIfsc ?? "",
    invoiceDeclaration: w.invoiceDeclaration ?? "",
    terms: w.invoiceTerms.join("\n"),
    threshold: String(w.procurementApprovalThreshold),
  });
  const save = useMutation({
    mutationFn: () =>
      api.patch("/settings", {
        name: f.name,
        gstin: f.gstin || null,
        address: f.address || null,
        website: f.website || null,
        bankName: f.bankName || null,
        bankAccountName: f.bankAccountName || null,
        bankAccountNo: f.bankAccountNo || null,
        bankIfsc: f.bankIfsc || null,
        invoiceDeclaration: f.invoiceDeclaration || null,
        invoiceTerms: f.terms.split("\n").map((t) => t.trim()).filter(Boolean),
        procurementApprovalThreshold: Number(f.threshold || 0),
      }),
    onSuccess: onSaved,
  });
  const ro = !data.canEdit;

  return (
    <div className="grid g2 section-block">
      <div className="panel">
        <div className="panel-title">Workspace</div>
        <FormField label="Registered name (appears on invoices and letters)">
          <input className="inp" value={f.name} disabled={ro} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </FormField>
        <div className="grid g2" style={{ gap: 10 }}>
          <FormField label="GSTIN">
            <input className="inp mono" value={f.gstin} disabled={ro} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} />
          </FormField>
          <FormField label="Website">
            <input className="inp" value={f.website} disabled={ro} onChange={(e) => setF({ ...f, website: e.target.value })} />
          </FormField>
        </div>
        <FormField label="Registered address">
          <textarea className="inp" rows={3} value={f.address} disabled={ro} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </FormField>
        <FormField label="Purchase approval threshold (₹)">
          <input className="inp mono" type="number" min={0} value={f.threshold} disabled={ro} onChange={(e) => setF({ ...f, threshold: e.target.value })} />
        </FormField>
        <div className="small muted">Purchase requests above {fmtINR(Number(f.threshold || 0))} need an approval before a purchase order can be raised.</div>
      </div>

      <div className="panel">
        <div className="panel-title">Invoice footer</div>
        <div className="grid g2" style={{ gap: 10 }}>
          <FormField label="Bank">
            <input className="inp" value={f.bankName} disabled={ro} onChange={(e) => setF({ ...f, bankName: e.target.value })} />
          </FormField>
          <FormField label="Account name">
            <input className="inp" value={f.bankAccountName} disabled={ro} onChange={(e) => setF({ ...f, bankAccountName: e.target.value })} />
          </FormField>
          <FormField label="Account number">
            <input className="inp mono" value={f.bankAccountNo} disabled={ro} onChange={(e) => setF({ ...f, bankAccountNo: e.target.value })} />
          </FormField>
          <FormField label="IFSC">
            <input className="inp mono" value={f.bankIfsc} disabled={ro} onChange={(e) => setF({ ...f, bankIfsc: e.target.value.toUpperCase() })} />
          </FormField>
        </div>
        <FormField label="Payment terms (one per line)">
          <textarea className="inp" rows={4} value={f.terms} disabled={ro} onChange={(e) => setF({ ...f, terms: e.target.value })} />
        </FormField>
        <FormField label="Declaration">
          <textarea className="inp" rows={2} value={f.invoiceDeclaration} disabled={ro} onChange={(e) => setF({ ...f, invoiceDeclaration: e.target.value })} />
        </FormField>
        {!ro && (
          <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
            {save.isSuccess && <span className="small muted">Saved.</span>}
            <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save settings"}
            </button>
          </div>
        )}
        {ro && <div className="small muted">Only the Founder or an Admin can change these.</div>}
        {save.error && <div className="notice red">{(save.error as Error).message}</div>}
      </div>
    </div>
  );
}

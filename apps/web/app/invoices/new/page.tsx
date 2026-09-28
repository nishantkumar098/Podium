"use client";

import { fmtINR } from "@podium/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "../../../components/AppShell";
import { NewClientModal } from "../../../components/NewClientModal";
import { useAuth } from "../../../lib/auth";
import { api, apiDownload, ApiError } from "../../../lib/api";
import type { CityOptionDto, ProjectDto } from "../../../lib/types";

type Scope = "FIXED" | "VARIABLE";
type DocType = "TAX_INVOICE" | "ESTIMATE";

/** The GST slabs a line may carry (the server refuses anything else). */
const GST_SLABS = [0, 0.05, 0.12, 0.18, 0.28];

interface DraftItem {
  description: string;
  detail: string;
  hsnSac: string;
  qty: string;
  unit: string;
  rate: string;
  discountPct: string;
  gstRate: number;
  scope: Scope;
  /** The catalogue product this line came from, so + raises its quantity instead of duplicating it. */
  productId?: string;
}

interface BrandOption {
  id: string;
  code: string;
  name: string;
  productCount?: number;
}

interface Product {
  id: string;
  name: string;
  sku: string | null;
  category: string | null;
  shortDesc: string | null;
  unit: string | null;
  price: string;
  pricingMode: "PER_GUEST" | "PER_QUANTITY" | "FIXED";
  gstRate: string | null;
  hsnSac: string | null;
  brandId: string;
  brand: { code: string; name: string };
}

interface ClientTax {
  gstStateCode: string | null;
  gstin: string | null;
}

const emptyItem = (scope: Scope = "FIXED"): DraftItem => ({
  description: "",
  detail: "",
  hsnSac: "",
  qty: "1",
  unit: "",
  rate: "",
  discountPct: "",
  gstRate: 0.18,
  scope,
});

const isBlank = (i: DraftItem) => !i.description.trim() && i.rate === "" && !i.detail.trim();

/** Same arithmetic as the server's lineTaxable — so the preview reconciles with the issued figure. */
const lineTaxable = (i: DraftItem) => {
  const gross = (Number(i.qty) || 0) * (Number(i.rate) || 0);
  return gross - gross * ((Number(i.discountPct) || 0) / 100);
};

const isComplete = (i: DraftItem) => i.description.trim() !== "" && i.rate !== "" && Number(i.qty) > 0;
const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (f: number) => `${Number((f * 100).toFixed(2))}%`;

/** A catalogue unit for the line: the product's own, else what its pricing is per. */
function unitFor(p: Product): string {
  if (p.unit) return p.unit.toLowerCase() === "pc" ? "pc" : p.unit.toLowerCase();
  return p.pricingMode === "PER_GUEST" ? "guest" : p.pricingMode === "FIXED" ? "lot" : "unit";
}

/**
 * The server's totals rule, mirrored for the live preview: tax per GST rate,
 * rounded to whole rupees per rate, CGST+SGST within the state and IGST
 * across, grand total rounded to whole rupees. The server recomputes on save
 * and issue; this only shows what it will get.
 */
function previewTotals(items: DraftItem[], intra: boolean) {
  const lines = items.filter(isComplete);
  const gross = lines.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);
  const taxable = round2(lines.reduce((s, i) => s + lineTaxable(i), 0));
  const byRate = new Map<number, number>();
  for (const i of lines) byRate.set(i.gstRate, (byRate.get(i.gstRate) ?? 0) + lineTaxable(i));
  const bands = [...byRate.entries()]
    .sort(([a], [b]) => b - a)
    .map(([rate, t]) => ({ rate, taxable: round2(t), tax: Math.round(round2(t) * rate) }));
  const tax = bands.reduce((s, b) => s + b.tax, 0);
  const beforeRounding = taxable + tax;
  const total = Math.round(beforeRounding);
  return { gross: round2(gross), discount: round2(gross - taxable), taxable, bands, tax, roundOff: round2(total - beforeRounding), total, intra };
}

/** The invoice as the edit form needs it back. */
interface LoadedInvoice {
  id: string;
  status: string;
  docType: DocType;
  clientId: string;
  projectId: string;
  cityId: string;
  brandId: string | null;
  dueDate: string;
  paymentTerms: string | null;
  quotationRef: string | null;
  serviceLocation: string | null;
  client: { id: string; name: string; cityId: string | null };
  items: Array<{
    description: string;
    detail: string | null;
    qty: string;
    unit: string | null;
    rate: string;
    discountPct: string;
    hsnSac: string | null;
    gstRate: string;
    scope: "FIXED" | "VARIABLE";
  }>;
}

/**
 * Raises a new invoice — or corrects a DRAFT one, when `?edit=<id>` is in
 * the URL.
 *
 * One form for both, rather than a second screen: an edit form that drifts
 * from the create form is how an invoice ends up with a field the other
 * cannot set. Only the submit differs — POST to create, PATCH to correct —
 * and the server refuses a PATCH against anything that is no longer a draft.
 */
function NewInvoiceForm() {
  const router = useRouter();
  const search = useSearchParams();
  const editId = search.get("edit");
  const [docType, setDocType] = useState<DocType>("TAX_INVOICE");
  const [clientId, setClientId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [cityId, setCityId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [dueDate, setDueDate] = useState(() => new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10));
  const [paymentTerms, setPaymentTerms] = useState("");
  const [quotationRef, setQuotationRef] = useState("");
  const [serviceLocation, setServiceLocation] = useState("");
  const [items, setItems] = useState<DraftItem[]>([emptyItem()]);
  const [error, setError] = useState<string | null>(null);

  const { data: editing, isLoading: loadingEdit } = useQuery({
    queryKey: ["invoice", editId],
    queryFn: () => api.get<LoadedInvoice>(`/invoices/${editId}`),
    enabled: !!editId,
  });

  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectDto[]>("/projects") });
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: () => api.get<CityOptionDto[]>("/cities") });
  // Gated on products:view, which not every invoicing role holds — a 403 just
  // hides the catalogue rather than blocking the form.
  const { data: brands } = useQuery({ queryKey: ["brands"], queryFn: () => api.get<BrandOption[]>("/products/brands"), retry: false });
  // The client's state decides CGST+SGST vs IGST in the preview.
  const { data: clientTax } = useQuery({
    queryKey: ["client-tax", clientId],
    queryFn: () => api.get<ClientTax>(`/clients/${clientId}`),
    enabled: !!clientId,
    retry: false,
  });

  /**
   * Client and project stay a consistent pair (the server rejects a mismatch):
   * picking a client narrows the projects to theirs, picking a project sets
   * its client.
   */
  const selectedProject = useMemo(() => (projects ?? []).find((p) => p.id === projectId), [projects, projectId]);
  const [client, setClient] = useState<PickedClient | null>(null);
  const clientProjects = useMemo(() => (projects ?? []).filter((p) => p.client.id === clientId), [projects, clientId]);
  const city = cities?.find((c) => c.id === cityId);
  const clientState = clientTax?.gstStateCode && /^\d{2}$/.test(clientTax.gstStateCode) ? clientTax.gstStateCode : clientTax?.gstin?.slice(0, 2) ?? null;
  // Unregistered client with no state on record: place of supply is the billing branch (intra-state).
  const intra = !city || !clientState || clientState === city.gstStateCode;
  const totals = useMemo(() => previewTotals(items, intra), [items, intra]);
  const incomplete = items.filter((i) => !isComplete(i) && (i.description.trim() || i.rate !== "")).length;

  const payload = () => ({
    docType,
    clientId,
    projectId,
    cityId,
    ...(brandId ? { brandId } : {}),
    dueDate: new Date(dueDate).toISOString(),
    ...(paymentTerms.trim() ? { paymentTerms: paymentTerms.trim() } : {}),
    ...(quotationRef.trim() ? { quotationRef: quotationRef.trim() } : {}),
    ...(serviceLocation.trim() ? { serviceLocation: serviceLocation.trim() } : {}),
    items: items.filter(isComplete).map((i) => ({
      description: i.description.trim(),
      ...(i.detail.trim() ? { detail: i.detail.trim() } : {}),
      qty: Number(i.qty),
      ...(i.unit.trim() ? { unit: i.unit.trim() } : {}),
      rate: Number(i.rate),
      discountPct: Number(i.discountPct) || 0,
      ...(i.hsnSac.trim() ? { hsnSac: i.hsnSac.trim() } : {}),
      gstRate: i.gstRate,
      scope: i.scope,
    })),
  });

  const create = useMutation({
    mutationFn: async (andDownload: boolean) => {
      const body = payload();
      const inv = editId
        ? // The client and project are fixed once a draft exists: moving it
          // would change its GST treatment and numbering series, which makes
          // it a different document. The server rejects them too.
          await api.patch<{ id: string }>(`/invoices/${editId}`, {
            cityId: body.cityId,
            ...(body.brandId ? { brandId: body.brandId } : {}),
            docType: body.docType,
            dueDate: body.dueDate,
            paymentTerms: body.paymentTerms ?? null,
            quotationRef: body.quotationRef ?? null,
            serviceLocation: body.serviceLocation ?? null,
            items: body.items,
          })
        : await api.post<{ id: string }>("/invoices", payload());
      if (andDownload) {
        const who = selectedProject?.client.name ?? "invoice";
        await apiDownload(`/invoices/${inv.id}/pdf`, `DRAFT - ${who}.pdf`).catch(() => undefined);
      }
      return inv;
    },
    onSuccess: (inv) => router.push(`/invoices/${inv.id}`),
    onError: (e: ApiError) => setError(e.message),
  });

  /**
   * Fill the form from the invoice being edited — once, when it arrives.
   * Guarded on `prefilled` rather than on the data, because every keystroke
   * afterwards re-runs this effect and would otherwise throw away what the
   * person just typed.
   */
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (!editing || prefilled) return;
    setDocType(editing.docType);
    setClientId(editing.clientId);
    setProjectId(editing.projectId);
    setCityId(editing.cityId);
    setBrandId(editing.brandId ?? "");
    setDueDate(String(editing.dueDate).slice(0, 10));
    setPaymentTerms(editing.paymentTerms ?? "");
    setQuotationRef(editing.quotationRef ?? "");
    setServiceLocation(editing.serviceLocation ?? "");
    setClient({ id: editing.client.id, name: editing.client.name, cityId: editing.client.cityId ?? editing.cityId });
    setItems(
      editing.items.length
        ? editing.items.map((i) => ({
            description: i.description,
            detail: i.detail ?? "",
            qty: String(Number(i.qty)),
            unit: i.unit ?? "",
            rate: String(Number(i.rate)),
            discountPct: String(Number(i.discountPct)),
            hsnSac: i.hsnSac ?? "",
            gstRate: Number(i.gstRate),
            scope: i.scope,
          }))
        : [emptyItem()],
    );
    setPrefilled(true);
  }, [editing, prefilled]);

  const patchItem = (idx: number, patch: Partial<DraftItem>) => setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  /** + on a catalogue product: add it as a line, or raise its quantity if it is already on the invoice. */
  const addProduct = (p: Product) => {
    setItems((prev) => {
      const existing = prev.findIndex((i) => i.productId === p.id);
      if (existing >= 0) return prev.map((it, i) => (i === existing ? { ...it, qty: String((Number(it.qty) || 0) + 1) } : it));
      const line: DraftItem = {
        description: p.name,
        detail: (p.shortDesc && p.shortDesc !== p.name ? p.shortDesc : "").slice(0, 140),
        hsnSac: p.hsnSac ?? "",
        qty: "1",
        unit: unitFor(p),
        rate: String(Number(p.price)),
        discountPct: "",
        gstRate: p.gstRate !== null && GST_SLABS.includes(Number(p.gstRate)) ? Number(p.gstRate) : 0.18,
        scope: "FIXED",
        productId: p.id,
      };
      // Replace an untouched empty first row rather than leaving it dangling.
      const kept = prev.filter((i) => !isBlank(i));
      return [...kept, line];
    });
    if (!brandId) setBrandId(p.brandId);
  };

  const discountOutOfRange = items.some((i) => i.discountPct !== "" && (Number(i.discountPct) < 0 || Number(i.discountPct) > 100));
  const valid = clientId && projectId && cityId && dueDate && items.some(isComplete) && incomplete === 0 && !discountOutOfRange;
  const label = docType === "ESTIMATE" ? "estimate" : "invoice";

  return (
    <AppShell crumb={`Invoices / New ${label}`}>
      <div className="page-head">
        <div>
          <div className="page-title">New {label}</div>
          <div className="page-sub">
            Creates a DRAFT. The {label} number is minted by the server when you issue it
            {docType === "ESTIMATE" ? " — estimates run on their own EST- series, separate from tax invoices." : "."}
          </div>
        </div>
      </div>

      {error && <div className="notice red" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-title">Details</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 14 }}>
          <Field label="Document type" hint={docType === "ESTIMATE" ? "Pre-event quotation — not a tax document" : "GST tax invoice"}>
            <select className="inp" value={docType} onChange={(e) => setDocType(e.target.value as DocType)}>
              <option value="TAX_INVOICE">Tax invoice</option>
              <option value="ESTIMATE">Estimate</option>
            </select>
          </Field>

          <ClientPicker
            client={client}
            onPick={(c) => {
              setClient(c);
              setClientId(c?.id ?? "");
              // Keep the project only if it belongs to the newly picked client.
              const p = (projects ?? []).find((x) => x.id === projectId);
              if (!c || p?.client.id !== c.id) setProjectId("");
              if (c) {
                const own = (projects ?? []).filter((x) => x.client.id === c.id);
                if (own.length === 1) {
                  setProjectId(own[0]!.id);
                  if (!cityId) setCityId(own[0]!.city.id);
                }
                if (!cityId && c.cityId) setCityId(c.cityId);
              }
            }}
          />

          <Field label="Project" hint={clientId && clientProjects.length === 0 ? "This client has no project yet — create one below" : undefined}>
            <select
              className="inp"
              value={projectId}
              onChange={(e) => {
                const p = (projects ?? []).find((x) => x.id === e.target.value);
                setProjectId(e.target.value);
                if (p) {
                  setClientId(p.client.id);
                  setClient({ id: p.client.id, name: p.client.name, cityId: p.city.id });
                  if (!cityId) setCityId(p.city.id);
                }
              }}
            >
              <option value="">{clientId ? (clientProjects.length ? "Select the client's project…" : "No projects for this client") : "Select a project…"}</option>
              {(clientId ? clientProjects : projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.client.name} — {p.name}
                </option>
              ))}
            </select>
          </Field>

          {clientId && clientProjects.length === 0 && client && (
            <QuickProject
              client={client}
              cityId={cityId || client.cityId}
              onCreated={(p) => {
                setProjectId(p.id);
                if (!cityId) setCityId(p.cityId);
              }}
            />
          )}

          <Field label="Billing city (branch)" hint="Decides CGST+SGST vs IGST against the client's state">
            <select className="inp" value={cityId} onChange={(e) => setCityId(e.target.value)}>
              <option value="">Select a city…</option>
              {cities?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.gstStateCode})
                </option>
              ))}
            </select>
          </Field>

          {brands && brands.length > 0 && (
            <Field label="Trading brand" hint="Printed under the letterhead — set automatically from the first catalogue item">
              <select className="inp" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                <option value="">AMM Brands LLP (no brand)</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label={docType === "ESTIMATE" ? "Valid until" : "Due date"}>
            <input className="inp" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>

          <Field label="Payment terms">
            <input className="inp" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="50% advance, balance on event date" />
          </Field>

          <Field label="Quotation ref.">
            <input className="inp" value={quotationRef} onChange={(e) => setQuotationRef(e.target.value)} placeholder="43 dated 17 May 2026" />
          </Field>

          <Field label="Service location" hint="Where the work happens, if not the billing city">
            <input className="inp" value={serviceLocation} onChange={(e) => setServiceLocation(e.target.value)} placeholder="Event venue, New Delhi" />
          </Field>
        </div>
      </div>

      {brands && brands.length > 0 && <Catalogue brands={brands} items={items} onAdd={addProduct} />}

      <div className="panel">
        <div className="panel-title">Line items</div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: "28%" }}>Description</th>
                <th style={{ width: 92 }}>Scope</th>
                <th style={{ width: 86 }}>HSN/SAC</th>
                <th style={{ width: 66 }} className="tright">
                  Qty
                </th>
                <th style={{ width: 72 }}>Unit</th>
                <th style={{ width: 104 }} className="tright">
                  Rate
                </th>
                <th style={{ width: 64 }} className="tright">
                  Disc. %
                </th>
                <th style={{ width: 76 }}>GST</th>
                <th style={{ width: 110 }} className="tright">
                  Taxable
                </th>
                <th style={{ width: 36 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={idx}>
                  <td>
                    <input className="inp" style={{ width: "100%" }} placeholder="Event management & production services" value={it.description} onChange={(e) => patchItem(idx, { description: e.target.value })} />
                    <input className="inp small" style={{ width: "100%", marginTop: 4 }} placeholder="Detail line (optional)" value={it.detail} onChange={(e) => patchItem(idx, { detail: e.target.value })} />
                  </td>
                  <td>
                    <select className="inp" value={it.scope} onChange={(e) => patchItem(idx, { scope: e.target.value as Scope })}>
                      <option value="FIXED">Fixed</option>
                      <option value="VARIABLE">Variable</option>
                    </select>
                  </td>
                  <td>
                    <input className="inp" style={{ width: "100%" }} placeholder="9963" value={it.hsnSac} onChange={(e) => patchItem(idx, { hsnSac: e.target.value })} />
                  </td>
                  <td>
                    <input className="inp tright" style={{ width: "100%" }} type="number" min="0" step="0.01" value={it.qty} onChange={(e) => patchItem(idx, { qty: e.target.value })} />
                  </td>
                  <td>
                    <input className="inp" style={{ width: "100%" }} placeholder="person" value={it.unit} onChange={(e) => patchItem(idx, { unit: e.target.value })} />
                  </td>
                  <td>
                    <input className="inp tright" style={{ width: "100%" }} type="number" min="0" step="0.01" value={it.rate} onChange={(e) => patchItem(idx, { rate: e.target.value })} />
                  </td>
                  <td>
                    <input className="inp tright" style={{ width: "100%" }} type="number" min="0" max="100" step="0.1" value={it.discountPct} onChange={(e) => patchItem(idx, { discountPct: e.target.value })} />
                  </td>
                  <td>
                    <select className="inp" value={it.gstRate} onChange={(e) => patchItem(idx, { gstRate: Number(e.target.value) })}>
                      {GST_SLABS.map((r) => (
                        <option key={r} value={r}>
                          {pct(r)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="tright mono small">{fmtINR(lineTaxable(it))}</td>
                  <td>
                    {items.length > 1 && (
                      <button className="btn-ghost btn-sm" onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))} aria-label="Remove line">
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginTop: 12, gap: 16, flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn-ghost btn-sm" onClick={() => setItems((prev) => [...prev, emptyItem("FIXED")])}>
                + Fixed line
              </button>
              <button className="btn-ghost btn-sm" onClick={() => setItems((prev) => [...prev, emptyItem("VARIABLE")])}>
                + Variable (actuals) line
              </button>
            </div>
            {incomplete > 0 && (
              <div className="small negative" style={{ marginTop: 8 }}>
                {incomplete} line{incomplete > 1 ? "s are" : " is"} missing a description, rate or a quantity above 0.
              </div>
            )}
            {discountOutOfRange && <div className="small negative" style={{ marginTop: 8 }}>Discount must be between 0 and 100%.</div>}
          </div>

          <SummaryBox t={totals} docType={docType} />
        </div>
      </div>

      <div className="page-actions" style={{ marginTop: 16 }}>
        <button className="btn-primary" disabled={!valid || create.isPending} onClick={() => create.mutate(false)}>
          {create.isPending ? "Creating…" : `Create draft ${label}`}
        </button>
        <button className="btn-ghost" disabled={!valid || create.isPending} onClick={() => create.mutate(true)}>
          Create &amp; download PDF
        </button>
        <button className="btn-ghost" onClick={() => router.push("/invoices")}>
          Cancel
        </button>
      </div>
    </AppShell>
  );
}

/** The invoice's summary block, live — same lines, same order as the printed PDF. */
function SummaryBox({ t, docType }: { t: ReturnType<typeof previewTotals>; docType: DocType }) {
  const row = (k: string, v: string, strong = false) => (
    <div className="row" style={{ justifyContent: "space-between", padding: strong ? "8px 0 2px" : "3px 0", fontWeight: strong ? 600 : 400, fontSize: strong ? 15 : 12.5, borderTop: strong ? "2px solid var(--ink)" : undefined }}>
      <span className={strong ? "" : "muted"}>{k}</span>
      <span className="mono">{v}</span>
    </div>
  );
  const single = t.bands.length === 1 ? t.bands[0]!.rate : null;
  return (
    <div style={{ minWidth: "min(320px, 100%)", border: "1px solid var(--line)", borderRadius: "var(--radius-m)", padding: "10px 14px", background: "var(--paper)" }}>
      <div className="small muted" style={{ textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>
        Summary {t.intra ? "· within the state" : "· inter-state (IGST)"}
      </div>
      {row("Gross amount", fmtINR(t.gross))}
      {t.discount > 0 && row("Less: discount", `− ${fmtINR(t.discount)}`)}
      {row("Taxable value", fmtINR(t.taxable))}
      {t.bands.map((b) =>
        t.intra ? (
          <div key={b.rate}>
            {row(single !== null ? `CGST @ ${pct(b.rate / 2)}` : `CGST @ ${pct(b.rate / 2)} (on ${fmtINR(b.taxable)})`, fmtINR(b.tax / 2))}
            {row(single !== null ? `SGST @ ${pct(b.rate / 2)}` : `SGST @ ${pct(b.rate / 2)} (on ${fmtINR(b.taxable)})`, fmtINR(b.tax / 2))}
          </div>
        ) : (
          <div key={b.rate}>{row(single !== null ? `IGST @ ${pct(b.rate)}` : `IGST @ ${pct(b.rate)} (on ${fmtINR(b.taxable)})`, fmtINR(b.tax))}</div>
        ),
      )}
      {row("Round off", `${t.roundOff < 0 ? "−" : "+"} ${fmtINR(Math.abs(t.roundOff))}`)}
      {row(docType === "ESTIMATE" ? "ESTIMATED TOTAL" : "GRAND TOTAL", fmtINR(t.total), true)}
      <div className="small faint" style={{ marginTop: 6 }}>
        The server recomputes these exact figures when it saves and issues.
      </div>
    </div>
  );
}

/** Pick items from the Elixir Coterie / The Cocktail Shop catalogues. */
function Catalogue({ brands, items, onAdd }: { brands: BrandOption[]; items: DraftItem[]; onAdd: (p: Product) => void }) {
  const ordered = [...brands].sort((a, b) => (a.code === "ELIXIR" ? -1 : b.code === "ELIXIR" ? 1 : a.name.localeCompare(b.name)));
  const [brand, setBrand] = useState(ordered[0]?.code ?? "");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [open, setOpen] = useState(true);

  const { data: categories } = useQuery({
    queryKey: ["product-categories", brand],
    queryFn: () => api.get<Array<{ category: string; count: number }>>(`/products/categories?brand=${brand}`),
    enabled: !!brand,
  });
  const { data, isFetching } = useQuery({
    queryKey: ["product-picker", brand, category, q],
    queryFn: () =>
      api.get<{ total: number; rows: Product[] }>(
        `/products?brand=${brand}&limit=40${category ? `&category=${encodeURIComponent(category)}` : ""}${q.trim() ? `&search=${encodeURIComponent(q.trim())}` : ""}`,
      ),
    enabled: !!brand,
    placeholderData: keepPreviousData,
  });
  const qtyOnInvoice = (id: string) => Number(items.find((i) => i.productId === id)?.qty ?? 0);

  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-title">
        Add items from the catalogue
        <button className="btn-ghost btn-sm" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open && (
        <>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <div className="chips">
              {ordered.map((b) => (
                <button
                  key={b.code}
                  className={`chipbtn ${brand === b.code ? "on" : ""}`}
                  onClick={() => {
                    setBrand(b.code);
                    setCategory("");
                  }}
                >
                  {b.name}
                  {b.productCount ? ` (${b.productCount})` : ""}
                </button>
              ))}
            </div>
            <select className="inp" value={category} onChange={(e) => setCategory(e.target.value)} style={{ maxWidth: 240 }}>
              <option value="">All categories</option>
              {categories?.map((c) => (
                <option key={c.category} value={c.category}>
                  {c.category} ({c.count})
                </option>
              ))}
            </select>
            <input className="inp" style={{ flex: "1 1 220px", maxWidth: 320 }} placeholder="Search by name or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
            {isFetching && <span className="small muted">Loading…</span>}
          </div>
          <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--line)", borderRadius: "var(--radius-s)" }}>
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th>HSN</th>
                  <th className="num">GST</th>
                  <th className="num">Price</th>
                  <th style={{ width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {data?.rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty">
                      No products match.
                    </td>
                  </tr>
                )}
                {data?.rows.map((p) => {
                  const onInvoice = qtyOnInvoice(p.id);
                  const priced = Number(p.price) > 0;
                  return (
                    <tr key={p.id}>
                      <td>
                        {p.name}
                        {p.shortDesc && p.shortDesc !== p.name && <div className="small faint">{p.shortDesc.slice(0, 90)}</div>}
                      </td>
                      <td className="small">{p.category ?? "—"}</td>
                      <td className="mono small">{p.hsnSac ?? "—"}</td>
                      <td className="num">{p.gstRate !== null ? pct(Number(p.gstRate)) : <span className="faint" title="Not on record — added at 18%, change it on the line if needed">18%*</span>}</td>
                      <td className="num">
                        {priced ? fmtINR(Number(p.price)) : <span className="faint">on request</span>}
                        {p.pricingMode === "PER_GUEST" && priced && <div className="small faint">per guest</div>}
                      </td>
                      <td className="tright" style={{ whiteSpace: "nowrap" }}>
                        {onInvoice > 0 && <span className="small muted">×{onInvoice} </span>}
                        <button className="btn-primary btn-sm" onClick={() => onAdd(p)} aria-label={`Add ${p.name}`} title={onInvoice ? "Add one more" : "Add to invoice"}>
                          +
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>
            {data ? `${data.rows.length} of ${data.total.toLocaleString("en-IN")} shown — search or pick a category to narrow. ` : ""}
            Click + to add an item; click again to add one more. Price, HSN, unit and GST fill in from the catalogue and stay editable on the line.
            {" "}* no GST rate on record: added at 18%.
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span className="small" style={{ color: "var(--text-dim)", fontWeight: 500 }}>
        {label}
      </span>
      {children}
      {hint && (
        <span className="small" style={{ color: "var(--text-faint)" }}>
          {hint}
        </span>
      )}
    </label>
  );
}

interface PickedClient {
  id: string;
  name: string;
  cityId: string;
}

/** Search the client book by name, or add a new client without leaving the invoice. */
function ClientPicker({ client, onPick }: { client: PickedClient | null; onPick: (c: PickedClient | null) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const term = q.trim();
  const { data, isFetching } = useQuery({
    queryKey: ["clients", "picker", term],
    queryFn: () => api.get<{ rows: Array<{ id: string; name: string; cityId: string; city: { name: string } | null; gstin: string | null }> }>(`/clients?limit=12${term ? `&search=${encodeURIComponent(term)}` : ""}`),
    enabled: open,
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span className="small" style={{ color: "var(--text-dim)", fontWeight: 500 }}>
        Client
      </span>
      <div className="row" style={{ gap: 6 }}>
        <div ref={box} style={{ position: "relative", flex: 1 }}>
          <input
            className="inp"
            style={{ width: "100%" }}
            value={open ? q : client?.name ?? ""}
            placeholder="Search clients…"
            onFocus={() => {
              setQ("");
              setOpen(true);
            }}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
            }}
          />
          {open && (
            <div
              style={{
                position: "absolute",
                zIndex: 30,
                top: "calc(100% + 4px)",
                left: 0,
                right: 0,
                maxHeight: 280,
                overflowY: "auto",
                background: "var(--surface, #fff)",
                border: "1px solid var(--line, #e5e1d8)",
                borderRadius: 8,
                boxShadow: "0 8px 24px rgba(0,0,0,.08)",
              }}
            >
              {(data?.rows ?? []).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="rowhover"
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: 0, background: "transparent", cursor: "pointer" }}
                  onClick={() => {
                    onPick({ id: c.id, name: c.name, cityId: c.cityId });
                    setOpen(false);
                  }}
                >
                  <div style={{ fontSize: 13 }}>{c.name}</div>
                  <div className="small faint">
                    {c.city?.name ?? ""}
                    {c.gstin ? ` · ${c.gstin}` : ""}
                  </div>
                </button>
              ))}
              {!isFetching && (data?.rows ?? []).length === 0 && <div className="small muted" style={{ padding: 10 }}>No client matches “{term}”.</div>}
              {isFetching && !data && <div className="small muted" style={{ padding: 10 }}>Searching…</div>}
              <button
                type="button"
                className="rowhover"
                style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: 0, borderTop: "1px solid var(--line, #e5e1d8)", background: "transparent", cursor: "pointer", color: "var(--brass)" }}
                onClick={() => {
                  setOpen(false);
                  setAdding(true);
                }}
              >
                + Add {term ? `“${term}” as a new client` : "a new client"}
              </button>
            </div>
          )}
        </div>
        <button type="button" className="btn-ghost" title="Search clients" onClick={() => box.current?.querySelector("input")?.focus()}>
          Search
        </button>
        <button type="button" className="btn-ghost" onClick={() => setAdding(true)}>
          + Add client
        </button>
      </div>
      {adding && <NewClientModal initialName={term} onClose={() => setAdding(false)} onCreated={(c) => onPick({ id: c.id, name: c.name, cityId: c.cityId })} />}
    </div>
  );
}

/** A new client has no project yet, and every invoice belongs to one — create it inline. */
function QuickProject({ client, cityId, onCreated }: { client: PickedClient; cityId: string; onCreated: (p: { id: string; cityId: string }) => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [name, setName] = useState(client.name);
  const [eventDate, setEventDate] = useState(() => new Date().toISOString().slice(0, 10));
  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string; cityId: string }>("/projects", {
        name: name.trim(),
        clientId: client.id,
        type: "Event",
        cityId,
        eventDate: new Date(eventDate).toISOString(),
        pmId: user!.id,
      }),
    onSuccess: async (p) => {
      await qc.invalidateQueries({ queryKey: ["projects"] });
      onCreated(p);
    },
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span className="small" style={{ color: "var(--text-dim)", fontWeight: 500 }}>
        New project for {client.name}
      </span>
      <div className="row" style={{ gap: 6 }}>
        <input className="inp" style={{ flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" />
        <input className="inp" type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} title="Event date" />
        <button type="button" className="btn-primary" disabled={!name.trim() || !eventDate || !cityId || !user || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "…" : "Create"}
        </button>
      </div>
      {save.error && <span className="small negative">{(save.error as Error).message}</span>}
    </div>
  );
}

/**
 * useSearchParams() reads the URL, which does not exist while Next is
 * prerendering — so the form has to sit behind a Suspense boundary or the
 * build fails on this page. The fallback is the empty app frame rather than
 * a spinner: the form appears in the same place a moment later, and a
 * spinner that flashes for 50ms is worse than nothing.
 */
export default function NewInvoicePage() {
  return (
    <Suspense fallback={null}>
      <NewInvoiceForm />
    </Suspense>
  );
}

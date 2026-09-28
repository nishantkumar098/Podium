"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fmtDate, fmtINR } from "@podium/ui";
import { Fragment, useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { api, ApiError } from "../../lib/api";
import type { CityOptionDto, VendorDto } from "../../lib/types";

/**
 * Phase I: the vendor master (blueprint screen 17) has had a real, tested
 * CRUD backend since the procurement build — every purchase request already
 * picks a vendor from it — but nothing ever rendered the master list or
 * detail on its own. Procurement's own dropdown only ever showed a name.
 */
const PAGE = 100;
const VENDOR_PILL: Record<string, string> = { PREFERRED: "green", APPROVED: "blue", BLACKLISTED: "red" };

type VendorRow = VendorDto & { projects: number; openOrders: number };

export default function VendorsPage() {
  const qc = useQueryClient();
  const [cityId, setCityId] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<VendorDto | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: () => api.get<CityOptionDto[]>("/cities") });
  const { data: vendors, isLoading } = useQuery({
    queryKey: ["vendors", cityId],
    queryFn: () => api.get<VendorRow[]>(`/vendors${cityId ? `?cityId=${cityId}` : ""}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["vendors"] });

  const all = vendors ?? [];
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of all) if (v.category) counts.set(v.category.trim(), (counts.get(v.category.trim()) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [all]);
  const brands = useMemo(() => [...new Set(all.map((v) => v.brand).filter((b): b is string => !!b))].sort(), [all]);
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return all.filter(
      (v) =>
        (!category || v.category?.trim() === category) &&
        (!status || v.status === status) &&
        (!brand || v.brand === brand) &&
        (!n ||
          `${v.name} ${v.category ?? ""} ${v.contactName ?? ""} ${v.phone ?? ""} ${v.gstin ?? ""} ${v.email ?? ""}`
            .toLowerCase()
            .includes(n)),
    );
  }, [all, category, status, brand, q]);
  const outstanding = all.reduce((s, v) => s + (v.openOrders ?? 0), 0);
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
  const reset = () => setPage(0);

  return (
    <AppShell crumb="Vendors">
      <div className="page-head">
        <div>
          <div className="page-title">Vendors</div>
          <div className="page-sub">
            {all.length.toLocaleString("en-IN")} vendors · {fmtINR(outstanding)} in open purchase orders
          </div>
        </div>
        <div className="page-actions">
          <button className="btn-primary" onClick={() => setEditing("new")}>
            + New Vendor
          </button>
        </div>
      </div>

      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <input className="inp" style={{ flex: "1 1 220px", maxWidth: 300 }} placeholder="Search name, category, contact, phone" value={q} onChange={(e) => { setQ(e.target.value); reset(); }} />
        <select className="inp" value={cityId} onChange={(e) => { setCityId(e.target.value); reset(); }}>
          <option value="">All cities</option>
          {cities?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select className="inp" value={category} onChange={(e) => { setCategory(e.target.value); reset(); }} style={{ maxWidth: 220 }}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select className="inp" value={status} onChange={(e) => { setStatus(e.target.value); reset(); }}>
          <option value="">Any status</option>
          <option value="PREFERRED">Preferred</option>
          <option value="APPROVED">Approved</option>
          <option value="BLACKLISTED">Blacklisted</option>
        </select>
      </div>

      {error && (
        <div className="notice red" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between" }}>
          <span>{error}</span>
          <button className="btn-ghost btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {editing && (
        <VendorEditor
          vendor={editing === "new" ? null : editing}
          cities={cities ?? []}
          onDone={() => {
            setEditing(null);
            setError(null);
            void refresh();
          }}
          onCancel={() => setEditing(null)}
          onError={(e) => setError(e.message)}
        />
      )}

      <div className="panel">
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Supplies</th>
                <th>City</th>
                <th>Contact</th>
                <th>Terms</th>
                <th className="num">Projects</th>
                <th className="num">Outstanding</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={9} className="empty">
                    Loading…
                  </td>
                </tr>
              )}
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="empty">
                    No vendors match.
                  </td>
                </tr>
              )}
              {shown.map((v) => (
                <Fragment key={v.id}>
                  <tr className="rowhover" tabIndex={0} onClick={() => setOpen(open === v.id ? null : v.id)} onKeyDown={(e) => e.key === "Enter" && setOpen(open === v.id ? null : v.id)}>
                    <td>
                      {v.name}
                      {v.brand && <div className="small faint">{v.brand}</div>}
                    </td>
                    <td className="small">{v.category ?? "—"}</td>
                    <td>{cities?.find((c) => c.id === v.cityId)?.name ?? <span className="faint">—</span>}</td>
                    <td className="small">
                      {v.contactName && <div>{v.contactName}</div>}
                      {v.phone && <div className="mono muted">{v.phone}</div>}
                      {!v.contactName && !v.phone && (v.email ?? "—")}
                    </td>
                    <td className="small">
                      {v.paymentTerms ?? "—"}
                      {v.creditDays ? <div className="faint">{v.creditDays} days</div> : null}
                    </td>
                    <td className="num">{v.projects || "—"}</td>
                    <td className="num">{v.openOrders ? fmtINR(v.openOrders) : "—"}</td>
                    <td>
                      <span className={`pill ${VENDOR_PILL[v.status] ?? "gray"}`}>{v.status.charAt(0) + v.status.slice(1).toLowerCase()}</span>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button className="btn-ghost btn-sm" onClick={() => setEditing(v)}>
                        Edit
                      </button>
                    </td>
                  </tr>
                  {open === v.id && (
                    <tr>
                      <td colSpan={9} style={{ background: "var(--paper)" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: "6px 18px", padding: "4px 2px" }}>
                          <Detail k="GSTIN" v={v.gstin} mono />
                          <Detail k="PAN" v={v.pan} mono />
                          <Detail k="Bank" v={v.bankName} />
                          <Detail k="Account no." v={v.bankAccountNo} mono />
                          <Detail k="IFSC" v={v.bankIfsc} mono />
                          <Detail k="UPI" v={v.upiId} mono />
                          <Detail k="E-mail" v={v.email} />
                          <Detail k="Website" v={v.website} />
                          <Detail k="Address" v={v.address} />
                          <Detail k="Balance on sheet" v={v.openingBalance ? fmtINR(Number(v.openingBalance)) : null} />
                          <Detail k="Last payment" v={v.lastPaymentAt ? fmtDate(v.lastPaymentAt) : null} />
                          <Detail k="Next payment due" v={v.nextPaymentDueAt ? fmtDate(v.nextPaymentDueAt) : null} />
                          <Detail k="Rating" v={v.rating !== null ? `★ ${Number(v.rating).toFixed(1)}` : null} />
                          <Detail k="Remarks" v={v.remarks} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > PAGE && (
          <div className="row" style={{ marginTop: 12, gap: 10 }}>
            <button className="btn-ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
              ← Previous
            </button>
            <span className="mono small">
              {page * PAGE + 1}–{Math.min(rows.length, page * PAGE + PAGE)} of {rows.length.toLocaleString("en-IN")}
            </span>
            <button className="btn-ghost" disabled={(page + 1) * PAGE >= rows.length} onClick={() => setPage(page + 1)}>
              Next →
            </button>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function VendorEditor({
  vendor,
  cities,
  onDone,
  onCancel,
  onError,
}: {
  vendor: VendorDto | null;
  cities: CityOptionDto[];
  onDone: () => void;
  onCancel: () => void;
  onError: (e: ApiError) => void;
}) {
  const [name, setName] = useState(vendor?.name ?? "");
  const [category, setCategory] = useState(vendor?.category ?? "");
  const [cityId, setCityId] = useState(vendor?.cityId ?? "");
  const [contactName, setContactName] = useState(vendor?.contactName ?? "");
  const [phone, setPhone] = useState(vendor?.phone ?? "");
  const [email, setEmail] = useState(vendor?.email ?? "");
  const [address, setAddress] = useState(vendor?.address ?? "");
  const [gstin, setGstin] = useState(vendor?.gstin ?? "");
  const [brand, setBrand] = useState(vendor?.brand ?? "");
  const [website, setWebsite] = useState(vendor?.website ?? "");
  const [pan, setPan] = useState(vendor?.pan ?? "");
  const [bankName, setBankName] = useState(vendor?.bankName ?? "");
  const [bankAccountNo, setBankAccountNo] = useState(vendor?.bankAccountNo ?? "");
  const [bankIfsc, setBankIfsc] = useState(vendor?.bankIfsc ?? "");
  const [upiId, setUpiId] = useState(vendor?.upiId ?? "");
  const [paymentTerms, setPaymentTerms] = useState(vendor?.paymentTerms ?? "");
  const [creditDays, setCreditDays] = useState(vendor?.creditDays != null ? String(vendor.creditDays) : "");
  const [remarks, setRemarks] = useState(vendor?.remarks ?? "");
  const [rating, setRating] = useState(vendor?.rating !== null && vendor?.rating !== undefined ? String(Number(vendor.rating)) : "");
  const [status, setStatus] = useState<VendorDto["status"]>(vendor?.status ?? "APPROVED");

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        category: category.trim() || null,
        cityId: cityId || null,
        contactName: contactName.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        address: address.trim() || null,
        rating: rating ? Number(rating) : null,
        gstin: gstin.trim() || null,
        status,
        brand: brand.trim() || null,
        website: website.trim() || null,
        pan: pan.trim() || null,
        bankName: bankName.trim() || null,
        bankAccountNo: bankAccountNo.trim() || null,
        bankIfsc: bankIfsc.trim() || null,
        upiId: upiId.trim() || null,
        paymentTerms: paymentTerms.trim() || null,
        creditDays: creditDays === "" ? null : Number(creditDays),
        remarks: remarks.trim() || null,
      };
      return vendor ? api.patch(`/vendors/${vendor.id}`, payload) : api.post("/vendors", payload);
    },
    onSuccess: onDone,
    onError: (e: ApiError) => onError(e),
  });

  const valid = !!name.trim();

  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-title">{vendor ? "Edit vendor" : "New vendor"}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 14, marginBottom: 14 }}>
        <Field label="Name">
          <input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="Rajwada Caterers" />
        </Field>
        <Field label="Category">
          <input className="inp" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Catering, Production…" />
        </Field>
        <Field label="City">
          <select className="inp" value={cityId} onChange={(e) => setCityId(e.target.value)}>
            <option value="">No branch city</option>
            {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select className="inp" value={status} onChange={(e) => setStatus(e.target.value as VendorDto["status"])}>
            <option value="APPROVED">Approved</option>
            <option value="PREFERRED">Preferred</option>
            <option value="BLACKLISTED">Blacklisted</option>
          </select>
        </Field>
        <Field label="Contact name">
          <input className="inp" value={contactName} onChange={(e) => setContactName(e.target.value)} />
        </Field>
        <Field label="Phone">
          <input className="inp" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Email">
          <input className="inp" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Address">
          <input className="inp" value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field label="GSTIN">
          <input className="inp" value={gstin} onChange={(e) => setGstin(e.target.value)} />
        </Field>
        <Field label="Rating (0–5)">
          <input className="inp tright mono" type="number" min="0" max="5" step="0.1" value={rating} onChange={(e) => setRating(e.target.value)} />
        </Field>
        <Field label="Brand buying from them">
          <input className="inp" value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="TCS, ELIXIR, CORPORATE" />
        </Field>
        <Field label="Website">
          <input className="inp" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </Field>
        <Field label="PAN">
          <input className="inp mono" value={pan} onChange={(e) => setPan(e.target.value)} />
        </Field>
        <Field label="Bank name">
          <input className="inp" value={bankName} onChange={(e) => setBankName(e.target.value)} />
        </Field>
        <Field label="Account number">
          <input className="inp mono" value={bankAccountNo} onChange={(e) => setBankAccountNo(e.target.value)} />
        </Field>
        <Field label="IFSC">
          <input className="inp mono" value={bankIfsc} onChange={(e) => setBankIfsc(e.target.value)} />
        </Field>
        <Field label="UPI ID">
          <input className="inp mono" value={upiId} onChange={(e) => setUpiId(e.target.value)} />
        </Field>
        <Field label="Payment terms">
          <input className="inp" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="ADVANCE, CREDIT, IMMEDIATE" />
        </Field>
        <Field label="Credit days">
          <input className="inp tright mono" type="number" min="0" value={creditDays} onChange={(e) => setCreditDays(e.target.value)} />
        </Field>
        <Field label="Remarks">
          <input className="inp" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </Field>
      </div>
      <div className="page-actions">
        <button className="btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save vendor"}
        </button>
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** One label/value pair in the expanded vendor details. */
function Detail({ k, v, mono }: { k: string; v: string | null; mono?: boolean }) {
  if (!v) return null;
  return (
    <div className="small">
      <span className="faint">{k}: </span>
      <span className={mono ? "mono" : undefined}>{v}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span className="small" style={{ color: "var(--text-dim)", fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  );
}

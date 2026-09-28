"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppShell } from "../../../../components/AppShell";
import { api, ApiError } from "../../../../lib/api";
import type { CityOptionDto, ProjectDto, VendorOptionDto } from "../../../../lib/types";

export default function NewPurchaseRequestPage() {
  const router = useRouter();
  const [item, setItem] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [amount, setAmount] = useState("");
  const [projectId, setProjectId] = useState("");
  const [cityId, setCityId] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: vendors } = useQuery({ queryKey: ["vendors"], queryFn: () => api.get<VendorOptionDto[]>("/vendors") });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectDto[]>("/projects") });
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: () => api.get<CityOptionDto[]>("/cities") });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>("/purchase-requests", {
        item: item.trim(),
        vendorId,
        amount: Number(amount),
        ...(projectId ? { projectId } : { cityId }),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    onSuccess: (pr) => router.push(`/procurement/requests/${pr.id}`),
    onError: (e: ApiError) => setError(e.message),
  });

  const activeVendors = (vendors ?? []).filter((v) => v.status !== "BLACKLISTED");
  const valid = item.trim() && vendorId && Number(amount) > 0 && (projectId || cityId);

  return (
    <AppShell crumb="Procurement / New request">
      <div className="page-head">
        <div>
          <div className="page-title">New purchase request</div>
          <div className="page-sub">
            Requests at or above the workspace threshold need approval before a purchase order can be raised.
          </div>
        </div>
      </div>

      {error && (
        <div className="panel" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 14 }}>
          {error}
        </div>
      )}

      <div className="panel">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 14 }}>
          <Field label="Item / description">
            <input className="inp" value={item} onChange={(e) => setItem(e.target.value)} placeholder="Stage rigging rental" />
          </Field>

          <Field label="Vendor" hint="Blacklisted vendors are excluded">
            <select className="inp" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Select a vendor…</option>
              {activeVendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} — {v.category}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Estimated amount (INR)">
            <input className="inp tright mono" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>

          <Field label="Project" hint="Or pick a city below for store replenishment">
            <select
              className="inp"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                if (e.target.value) setCityId("");
              }}
            >
              <option value="">No project — store replenishment</option>
              {projects?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          {!projectId && (
            <Field label="City">
              <select className="inp" value={cityId} onChange={(e) => setCityId(e.target.value)}>
                <option value="">Select a city…</option>
                {cities?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Notes (optional)">
            <input className="inp" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="page-actions" style={{ marginTop: 16 }}>
        <button className="btn-primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Creating…" : "Create request"}
        </button>
        <button className="btn-ghost" onClick={() => router.push("/procurement")}>
          Cancel
        </button>
      </div>
    </AppShell>
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

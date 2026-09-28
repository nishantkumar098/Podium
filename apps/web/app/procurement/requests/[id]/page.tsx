"use client";

import { fmtDate, fmtINR } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { AppShell } from "../../../../components/AppShell";
import { StatusPill } from "../../../../components/StatusPill";
import { api, ApiError } from "../../../../lib/api";
import { useAuth } from "../../../../lib/auth";
import type { InventoryBalanceDto, PurchaseRequestDto } from "../../../../lib/types";

export default function PurchaseRequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [showPoForm, setShowPoForm] = useState(false);

  const { data: pr, isLoading } = useQuery({
    queryKey: ["purchase-request", id],
    queryFn: () => api.get<PurchaseRequestDto>(`/purchase-requests/${id}`),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["purchase-request", id] });
  const onError = (e: ApiError) => setError(e.message);

  const decide = useMutation({
    mutationFn: (approve: boolean) => api.post(`/purchase-requests/${id}/decision`, { approve }),
    onSuccess: () => { setError(null); refresh(); },
    onError,
  });

  if (isLoading || !pr) {
    return (
      <AppShell crumb="Procurement">
        <div className="empty">Loading…</div>
      </AppShell>
    );
  }

  const pendingApproval = pr.approvals.find((a) => a.status === "PENDING");
  const isRequester = pr.requestedById === user?.id;
  const canRaisePo = pr.status === "QUOTE_COMPARISON" && pr.purchaseOrders.filter((po) => po.status !== "CANCELLED").length === 0;
  const alreadyApproved = pr.approvals.some((a) => a.status === "APPROVED");

  return (
    <AppShell crumb={`Procurement / ${pr.item}`}>
      <div className="page-head">
        <div>
          <div className="page-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {pr.item}
            <StatusPill status={pr.status} />
          </div>
          <div className="page-sub">
            {pr.vendor.name} · {pr.project?.name ?? "Store replenishment"} · {fmtINR(Number(pr.amount))}
            {alreadyApproved && ` · approval ceiling ${fmtINR(Number(pr.amount))}`}
          </div>
        </div>
        <div className="page-actions">
          {canRaisePo && (
            <button className="btn-primary" onClick={() => setShowPoForm((s) => !s)}>
              {showPoForm ? "Close" : "Raise purchase order"}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="panel" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
          <span className="small">{error}</span>
          <button className="btn-ghost btn-sm" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {pendingApproval && (
        <div className="panel" style={{ marginBottom: 14, borderColor: "var(--brass)" }}>
          <div className="panel-title">Approval pending</div>
          {isRequester ? (
            <div className="small" style={{ color: "var(--text-dim)" }}>
              You raised this request, so you cannot approve it yourself — someone else holding inventory:approve must decide it.
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn-ok" disabled={decide.isPending} onClick={() => decide.mutate(true)}>
                Approve
              </button>
              <button className="btn-warn" disabled={decide.isPending} onClick={() => decide.mutate(false)}>
                Reject
              </button>
            </div>
          )}
        </div>
      )}

      {showPoForm && canRaisePo && (
        <RaisePoForm
          prId={pr.id}
          approvedAmount={alreadyApproved ? Number(pr.amount) : null}
          onDone={() => router.push("/procurement")}
          onError={onError}
        />
      )}

      <div className="grid g2">
        <div className="panel">
          <div className="panel-title">Details</div>
          <Row label="Vendor" value={pr.vendor.name} />
          <Row label="Estimated amount" value={fmtINR(Number(pr.amount))} />
          <Row label="Notes" value={pr.notes ?? "—"} />
          <Row label="Raised" value={fmtDate(pr.createdAt)} />
        </div>
        <div className="panel">
          <div className="panel-title">Purchase orders raised</div>
          {pr.purchaseOrders.length === 0 && <div className="empty">None yet.</div>}
          {pr.purchaseOrders.map((po) => (
            <div key={po.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--line)" }}
              className="rowhover" onClick={() => router.push(`/procurement/orders/${po.id}`)}>
              <span className="mono small">{fmtINR(Number(po.total))}</span>
              <StatusPill status={po.status} />
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 12.3 }}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

interface DraftLine { skuId: string; qty: string; price: string }

function RaisePoForm({
  prId,
  approvedAmount,
  onDone,
  onError,
}: {
  prId: string;
  approvedAmount: number | null;
  onDone: () => void;
  onError: (e: ApiError) => void;
}) {
  const [lines, setLines] = useState<DraftLine[]>([{ skuId: "", qty: "1", price: "" }]);
  const { data: balances } = useQuery({
    queryKey: ["inventory-balances-for-po"],
    queryFn: () => api.get<InventoryBalanceDto[]>("/inventory/balances"),
  });
  const skus = Array.from(new Map((balances ?? []).map((b) => [b.item.id, b.item])).values());

  const create = useMutation({
    mutationFn: () =>
      api.post("/purchase-orders", {
        prId,
        items: lines
          .filter((l) => l.skuId && l.price !== "")
          .map((l) => ({ skuId: l.skuId, qtyOrdered: Number(l.qty) || 1, unitPrice: Number(l.price) })),
      }),
    onSuccess: onDone,
    onError: (e: ApiError) => onError(e),
  });

  const patch = (i: number, p: Partial<DraftLine>) => setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...p } : l)));
  const total = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
  const overBudget = approvedAmount !== null && total > approvedAmount;
  const valid = lines.some((l) => l.skuId && l.price !== "") && !overBudget;

  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-title">Raise purchase order</div>
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th className="tright" style={{ width: 90 }}>Qty</th>
            <th className="tright" style={{ width: 130 }}>Unit price</th>
            <th className="tright" style={{ width: 130 }}>Amount</th>
            <th style={{ width: 40 }} />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <select className="inp" style={{ width: "100%" }} value={l.skuId} onChange={(e) => patch(i, { skuId: e.target.value })}>
                  <option value="">Select a SKU…</option>
                  {skus.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.sku})
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input className="inp tright" style={{ width: "100%" }} type="number" min="1" value={l.qty} onChange={(e) => patch(i, { qty: e.target.value })} />
              </td>
              <td>
                <input className="inp tright" style={{ width: "100%" }} type="number" min="0" step="0.01" value={l.price} onChange={(e) => patch(i, { price: e.target.value })} />
              </td>
              <td className="tright mono small">{fmtINR((Number(l.qty) || 0) * (Number(l.price) || 0))}</td>
              <td>
                {lines.length > 1 && (
                  <button className="btn-ghost btn-sm" onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}>×</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
        <button className="btn-ghost btn-sm" onClick={() => setLines((prev) => [...prev, { skuId: "", qty: "1", price: "" }])}>
          + Add line
        </button>
        <span className="small mono" style={{ color: overBudget ? "var(--red)" : "var(--text-dim)" }}>
          Total {fmtINR(total)}
          {approvedAmount !== null && ` (approved ceiling ${fmtINR(approvedAmount)})`}
        </span>
      </div>
      {overBudget && (
        <div className="small" style={{ color: "var(--red)", marginTop: 6 }}>
          This exceeds the approved amount — the server will refuse it. Raise a new request for the higher figure instead.
        </div>
      )}
      <div className="page-actions" style={{ marginTop: 12 }}>
        <button className="btn-primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Raising…" : "Raise order"}
        </button>
      </div>
    </div>
  );
}

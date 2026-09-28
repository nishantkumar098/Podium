"use client";

import { fmtDate, fmtINR } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { AppShell } from "../../../../components/AppShell";
import { StatusPill } from "../../../../components/StatusPill";
import { api, ApiError } from "../../../../lib/api";
import type { InventoryBalanceDto, PurchaseOrderDto } from "../../../../lib/types";

export default function PurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [showReceive, setShowReceive] = useState(false);

  const { data: po, isLoading } = useQuery({
    queryKey: ["purchase-order", id],
    queryFn: () => api.get<PurchaseOrderDto>(`/purchase-orders/${id}`),
  });
  const { data: balances } = useQuery({
    queryKey: ["inventory-balances-for-receive"],
    queryFn: () => api.get<InventoryBalanceDto[]>("/inventory/balances"),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["purchase-order", id] });
  const onError = (e: ApiError) => setError(e.message);

  const send = useMutation({
    mutationFn: () => api.post(`/purchase-orders/${id}/send`),
    onSuccess: () => { setError(null); refresh(); },
    onError,
  });
  const close = useMutation({
    mutationFn: (reason: string) => api.post(`/purchase-orders/${id}/close`, { reason: reason || undefined }),
    onSuccess: () => { setError(null); refresh(); },
    onError,
  });
  const cancel = useMutation({
    mutationFn: (reason: string) => api.post(`/purchase-orders/${id}/cancel`, { reason: reason || undefined }),
    onSuccess: () => { setError(null); refresh(); },
    onError,
  });

  const outstanding = useMemo(() => {
    if (!po) return new Map<string, number>();
    const left = new Map(po.items.map((i) => [i.skuId, i.qtyOrdered]));
    for (const r of po.goodsReceipts) {
      for (const [skuId, qty] of Object.entries(r.receivedQty)) {
        if (left.has(skuId)) left.set(skuId, left.get(skuId)! - Number(qty));
      }
    }
    return left;
  }, [po]);

  if (isLoading || !po) {
    return (
      <AppShell crumb="Procurement">
        <div className="empty">Loading…</div>
      </AppShell>
    );
  }

  const canReceive = po.status === "SENT" || po.status === "PARTIALLY_RECEIVED";
  const locations = Array.from(new Map((balances ?? []).map((b) => [b.location.id, b.location])).values());

  return (
    <AppShell crumb={`Procurement / PO / ${po.vendor.name}`}>
      <div className="page-head">
        <div>
          <div className="page-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {po.vendor.name}
            <StatusPill status={po.status} />
          </div>
          <div className="page-sub">
            From request: {po.purchaseRequest.item} · {fmtDate(po.createdAt)}
          </div>
        </div>
        <div className="page-actions">
          {po.status === "DRAFT" && (
            <button className="btn-primary" disabled={send.isPending} onClick={() => send.mutate()}>
              {send.isPending ? "Sending…" : "Send to vendor"}
            </button>
          )}
          {canReceive && (
            <button className="btn-primary" onClick={() => setShowReceive((s) => !s)}>
              {showReceive ? "Close" : "Receive goods"}
            </button>
          )}
          {po.status !== "CANCELLED" && po.status !== "CLOSED" && (
            <>
              <ReasonButton label="Close" tone="btn-ghost" onConfirm={(r) => close.mutate(r)} />
              {po.goodsReceipts.length === 0 && (
                <ReasonButton label="Cancel" tone="btn-warn" onConfirm={(r) => cancel.mutate(r)} />
              )}
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="panel" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
          <span className="small">{error}</span>
          <button className="btn-ghost btn-sm" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {showReceive && canReceive && (
        <ReceiveGoodsForm
          po={po}
          outstanding={outstanding}
          locations={locations}
          onDone={() => { setShowReceive(false); setError(null); refresh(); }}
          onError={onError}
        />
      )}

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-title">Line items</div>
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th className="tright">Ordered</th>
              <th className="tright">Outstanding</th>
              <th className="tright">Unit price</th>
              <th className="tright">Amount</th>
            </tr>
          </thead>
          <tbody>
            {po.items.map((it) => (
              <tr key={it.id}>
                <td>{it.sku.name} <span className="small" style={{ color: "var(--text-faint)" }}>({it.sku.sku})</span></td>
                <td className="tright mono">{it.qtyOrdered} {it.sku.unit}</td>
                <td className="tright mono">{outstanding.get(it.skuId) ?? 0} {it.sku.unit}</td>
                <td className="tright mono">{fmtINR(Number(it.unitPrice))}</td>
                <td className="tright mono">{fmtINR(it.qtyOrdered * Number(it.unitPrice))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ textAlign: "right", marginTop: 10, fontWeight: 600 }} className="mono">
          Total {fmtINR(Number(po.total))}
        </div>
      </div>

      {po.goodsReceipts.length > 0 && (
        <div className="panel">
          <div className="panel-title">Goods receipts</div>
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>Lines</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {po.goodsReceipts.map((r) => (
                <tr key={r.id}>
                  <td className="mono small">{fmtDate(r.receivedAt)}</td>
                  <td className="small">
                    {Object.entries(r.receivedQty).map(([skuId, qty]) => {
                      const item = po.items.find((i) => i.skuId === skuId);
                      return <div key={skuId}>{item?.sku.name ?? skuId}: {qty}</div>;
                    })}
                  </td>
                  <td className="small">{r.note ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}

function ReasonButton({ label, tone, onConfirm }: { label: string; tone: "btn-ghost" | "btn-warn"; onConfirm: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) return <button className={tone} onClick={() => setOpen(true)}>{label}</button>;
  return (
    <span style={{ display: "inline-flex", gap: 6 }}>
      <input className="inp" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className={tone} onClick={() => onConfirm(reason)}>Confirm</button>
      <button className="btn-ghost btn-sm" onClick={() => setOpen(false)}>×</button>
    </span>
  );
}

function ReceiveGoodsForm({
  po,
  outstanding,
  locations,
  onDone,
  onError,
}: {
  po: PurchaseOrderDto;
  outstanding: Map<string, number>;
  locations: Array<{ id: string; name: string; city: { name: string } }>;
  onDone: () => void;
  onError: (e: ApiError) => void;
}) {
  const [locationId, setLocationId] = useState("");
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");

  const receive = useMutation({
    mutationFn: () =>
      api.post(`/purchase-orders/${po.id}/receipts`, {
        locationId,
        lines: Object.entries(qtys)
          .filter(([, v]) => Number(v) > 0)
          .map(([skuId, v]) => ({ skuId, qty: Number(v) })),
        note: note.trim() || undefined,
      }),
    onSuccess: onDone,
    onError: (e: ApiError) => onError(e),
  });

  const valid = locationId && Object.values(qtys).some((v) => Number(v) > 0);

  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-title">Receive goods</div>
      <div style={{ marginBottom: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 320 }}>
          <span className="small" style={{ color: "var(--text-dim)" }}>Location</span>
          <select className="inp" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Select a location…</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.city.name})
              </option>
            ))}
          </select>
        </label>
      </div>
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th className="tright">Outstanding</th>
            <th className="tright" style={{ width: 120 }}>Receive qty</th>
          </tr>
        </thead>
        <tbody>
          {po.items.map((it) => {
            const left = outstanding.get(it.skuId) ?? 0;
            return (
              <tr key={it.id}>
                <td>{it.sku.name}</td>
                <td className="tright mono">{left} {it.sku.unit}</td>
                <td>
                  <input
                    className="inp tright"
                    style={{ width: "100%" }}
                    type="number"
                    min="0"
                    max={left}
                    disabled={left === 0}
                    value={qtys[it.skuId] ?? ""}
                    onChange={(e) => setQtys((prev) => ({ ...prev, [it.skuId]: e.target.value }))}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <label style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 10 }}>
        <span className="small" style={{ color: "var(--text-dim)" }}>Note (optional)</span>
        <input className="inp" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="page-actions" style={{ marginTop: 12 }}>
        <button className="btn-primary" disabled={!valid || receive.isPending} onClick={() => receive.mutate()}>
          {receive.isPending ? "Recording…" : "Record receipt"}
        </button>
      </div>
    </div>
  );
}

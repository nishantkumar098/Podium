"use client";

import { fmtDate, fmtINR } from "@podium/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppShell } from "../../components/AppShell";
import { title } from "../../components/OpsUi";
import { api } from "../../lib/api";
import type { CityOptionDto, PurchaseOrderDto, PurchaseRequestDto } from "../../lib/types";

type Tab = "requests" | "orders";

const PR_PILL: Record<string, string> = {
  QUOTE_COMPARISON: "gray",
  RFQ_SENT: "blue",
  APPROVAL_PENDING: "amber",
  PO_RAISED: "blue",
  GOODS_RECEIVED: "green",
  REJECTED: "red",
};
const PO_PILL: Record<string, string> = { DRAFT: "gray", SENT: "blue", PARTIALLY_RECEIVED: "amber", RECEIVED: "green", CLOSED: "green", CANCELLED: "gray" };

/**
 * Procurement: purchase request → approval → purchase order → goods receipt,
 * which books the stock straight into the city store's ledger.
 */
export default function ProcurementPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("requests");
  const { data: requests, isLoading: loadingRequests } = useQuery({ queryKey: ["purchase-requests"], queryFn: () => api.get<PurchaseRequestDto[]>("/purchase-requests") });
  const { data: orders, isLoading: loadingOrders } = useQuery({ queryKey: ["purchase-orders"], queryFn: () => api.get<PurchaseOrderDto[]>("/purchase-orders") });
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: () => api.get<CityOptionDto[]>("/cities") });
  const cityName = (id: string | null) => cities?.find((c) => c.id === id)?.name ?? "";

  const prs = requests ?? [];
  const pos = orders ?? [];
  const sum = (xs: Array<{ amount?: string | number; total?: string | number }>) => xs.reduce((s, x) => s + Number(x.amount ?? x.total ?? 0), 0);
  const pending = prs.filter((p) => p.status === "APPROVAL_PENDING");
  const open = pos.filter((p) => p.status === "SENT" || p.status === "PARTIALLY_RECEIVED");
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const receivedThisMonth = pos.filter((p) => ["RECEIVED", "PARTIALLY_RECEIVED", "CLOSED"].includes(p.status) && p.goodsReceipts.some((g) => new Date(g.receivedAt) >= monthStart));

  return (
    <AppShell crumb="Procurement">
      <div className="page-head">
        <div>
          <div className="page-title">Procurement</div>
          <div className="page-sub">Purchase requests → approval → purchase order → goods received → stock in the city store</div>
        </div>
        <div className="page-actions">
          <Link className="btn-primary" href="/procurement/requests/new">
            + Purchase Request
          </Link>
        </div>
      </div>

      <div className="grid g4 section-block">
        <div className="stat" style={{ borderLeftColor: "var(--amber)" }}>
          <div className="k">Awaiting approval</div>
          <div className="v">{fmtINR(sum(pending))}</div>
          <div className="d">{pending.length} requests</div>
        </div>
        <div className="stat" style={{ borderLeftColor: "var(--blue)" }}>
          <div className="k">Open purchase orders</div>
          <div className="v">{fmtINR(sum(open))}</div>
          <div className="d">{open.length} sent, awaiting goods</div>
        </div>
        <div className="stat" style={{ borderLeftColor: "var(--green)" }}>
          <div className="k">Goods received this month</div>
          <div className="v">{receivedThisMonth.length}</div>
          <div className="d">orders with a receipt</div>
        </div>
        <div className="stat">
          <div className="k">Requests</div>
          <div className="v">{prs.length}</div>
          <div className="d">{prs.filter((p) => p.status === "REJECTED").length} rejected</div>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === "requests" ? "active" : ""}`} onClick={() => setTab("requests")}>
          Requests ({prs.length})
        </button>
        <button className={`tab ${tab === "orders" ? "active" : ""}`} onClick={() => setTab("orders")}>
          Orders ({pos.length})
        </button>
      </div>

      {tab === "requests" && (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Project</th>
                <th>Vendor</th>
                <th className="num">Amount</th>
                <th>Stage</th>
                <th>Raised</th>
              </tr>
            </thead>
            <tbody>
              {loadingRequests && (
                <tr>
                  <td colSpan={6} className="empty">
                    Loading…
                  </td>
                </tr>
              )}
              {!loadingRequests && prs.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No purchase requests yet. Raise one for an event&apos;s shortfall or to replenish a city store.
                  </td>
                </tr>
              )}
              {prs.map((pr) => (
                <tr key={pr.id} className="rowhover" onClick={() => router.push(`/procurement/requests/${pr.id}`)}>
                  <td>{pr.item}</td>
                  <td className="small">{pr.project?.name ?? `Store replenishment${pr.cityId ? ` — ${cityName(pr.cityId)}` : ""}`}</td>
                  <td className="small">{pr.vendor.name}</td>
                  <td className="num">{fmtINR(Number(pr.amount))}</td>
                  <td>
                    <span className={`pill ${PR_PILL[pr.status] ?? "gray"}`}>{title(pr.status)}</span>
                  </td>
                  <td className="mono small">{fmtDate(pr.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "orders" && (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>Vendor</th>
                <th>For</th>
                <th className="num">Total</th>
                <th className="num">Lines</th>
                <th>Status</th>
                <th>Raised</th>
              </tr>
            </thead>
            <tbody>
              {loadingOrders && (
                <tr>
                  <td colSpan={6} className="empty">
                    Loading…
                  </td>
                </tr>
              )}
              {!loadingOrders && pos.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No purchase orders yet — they are raised from an approved request.
                  </td>
                </tr>
              )}
              {pos.map((po) => (
                <tr key={po.id} className="rowhover" onClick={() => router.push(`/procurement/orders/${po.id}`)}>
                  <td>{po.vendor.name}</td>
                  <td className="small">
                    {po.purchaseRequest.item}
                    {po.purchaseRequest.cityId && <div className="faint">{cityName(po.purchaseRequest.cityId)}</div>}
                  </td>
                  <td className="num">{fmtINR(Number(po.total))}</td>
                  <td className="num">{po.items.length}</td>
                  <td>
                    <span className={`pill ${PO_PILL[po.status] ?? "gray"}`}>{title(po.status)}</span>
                  </td>
                  <td className="mono small">{fmtDate(po.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}

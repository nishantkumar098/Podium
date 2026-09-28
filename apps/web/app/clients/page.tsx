"use client";

import { fmtDate, fmtINR } from "@podium/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "../../components/AppShell";
import { NewClientModal, type EditableClient } from "../../components/NewClientModal";
import { title } from "../../components/OpsUi";
import { api, ApiError } from "../../lib/api";

interface ClientDto {
  id: string;
  name: string;
  type: string;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  /** Printed on this client's invoices — see NewClientModal. */
  address: string | null;
  cityId: string | null;
  ltv: string;
  since: string | null;
  /** Null for imported clients whose source sheet carried no city. */
  city: { name: string } | null;
  _count: { projects: number };
}

interface ShellDto {
  permissions: string[];
}

interface ClientPage {
  total: number;
  limit: number;
  offset: number;
  rows: ClientDto[];
}

type Segment = "EVENT_CLIENT" | "RETAIL_CUSTOMER";

const PAGE = 50;
const TYPE_PILL: Record<string, string> = { CORPORATE: "blue", BRAND: "amber", INDIVIDUAL: "gray" };

/**
 * Two segments live in `clients`: the B2B event accounts and the Cocktail
 * Shop retail customers, which outnumber them many times over. The screen
 * opens on event clients and shows retail only when asked.
 */
export default function ClientsPage() {
  const [segment, setSegment] = useState<Segment>("EVENT_CLIENT");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  /**
   * Deleting is a two-tap action: the first click arms the row, the second
   * confirms. No modal — a modal for a list row is heavier than the decision
   * deserves, and the server refuses anything dangerous anyway.
   */
  const [editing, setEditing] = useState<EditableClient | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const { data: shell } = useQuery({ queryKey: ["shell"], queryFn: () => api.get<ShellDto>("/users/me/shell"), staleTime: 30 * 60_000 });
  const canDelete = !!shell?.permissions.includes("clients:delete");
  const canEdit = !!shell?.permissions.includes("clients:edit");
  const showActions = canEdit || canDelete;

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true; name: string }>(`/clients/${id}`),
    onSuccess: (r) => {
      setError(null);
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ["clients"] });
      void qc.invalidateQueries({ queryKey: ["clients-count"] });
      setNotice(`${r.name} removed.`);
    },
    onError: (e: ApiError) => {
      setConfirming(null);
      // The server explains exactly what is in the way — live projects or
      // invoices — so show that rather than a generic failure.
      setError(e.message);
    },
  });
  const [notice, setNotice] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["clients", segment, search, offset],
    queryFn: () =>
      api.get<ClientPage>(`/clients?segment=${segment}&limit=${PAGE}&offset=${offset}` + (search ? `&search=${encodeURIComponent(search)}` : "")),
    placeholderData: keepPreviousData,
  });

  const pick = (next: Segment) => {
    setSegment(next);
    setOffset(0);
  };
  const total = data?.total ?? 0;
  const shown = data?.rows.length ?? 0;

  return (
    <AppShell crumb="Clients">
      <div className="page-head">
        <div>
          <div className="page-title">Clients</div>
          <div className="page-sub">
            {total.toLocaleString("en-IN")} {segment === "EVENT_CLIENT" ? "client accounts" : "Cocktail Shop retail customers"}
            {search ? ` matching “${search}”` : ""}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn-primary" onClick={() => setCreating(true)}>
            + New Client
          </button>
        </div>
      </div>

      <div className="row" style={{ gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div className="chips">
          <button className={`chipbtn ${segment === "EVENT_CLIENT" ? "on" : ""}`} onClick={() => pick("EVENT_CLIENT")}>
            Event clients
          </button>
          <button className={`chipbtn ${segment === "RETAIL_CUSTOMER" ? "on" : ""}`} onClick={() => pick("RETAIL_CUSTOMER")}>
            Cocktail Shop retail
          </button>
        </div>
        <input
          className="inp"
          style={{ flex: "1 1 220px", maxWidth: 320 }}
          value={search}
          placeholder="Search by name"
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
      </div>

      {error && <div className="notice red" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="notice" style={{ marginBottom: 12 }}>{notice}</div>}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Type</th>
              <th>City</th>
              <th>Contact</th>
              <th className="tright">Lifetime Value</th>
              <th>Client Since</th>
              <th className="tright">Projects</th>
              {showActions && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={showActions ? 8 : 7} className="empty">
                  Loading…
                </td>
              </tr>
            )}
            {!isLoading && shown === 0 && (
              <tr>
                <td colSpan={showActions ? 8 : 7} className="empty">
                  No clients match.
                </td>
              </tr>
            )}
            {data?.rows.map((c) => (
              <tr key={c.id} className="rowhover">
                <td>
                  {c.name}
                  {c.gstin && <div className="small faint mono">GSTIN {c.gstin}</div>}
                  {/* Shown because it prints on their invoices: a client with
                      no address produces an invoice with a placeholder where
                      the billing address should be. */}
                  {c.address ? (
                    <div className="small muted">{c.address}</div>
                  ) : (
                    <div className="small" style={{ color: "var(--warn, #b26b00)" }}>No billing address</div>
                  )}
                </td>
                <td>
                  <span className={`pill ${TYPE_PILL[c.type] ?? "gray"}`}>{title(c.type)}</span>
                </td>
                <td>{c.city?.name ?? "—"}</td>
                <td className="small">
                  {c.phone && <div className="mono">{c.phone}</div>}
                  {c.email && <div className="muted">{c.email}</div>}
                  {!c.phone && !c.email && "—"}
                </td>
                <td className="tright mono">{Number(c.ltv) > 0 ? fmtINR(Number(c.ltv)) : "—"}</td>
                <td className="mono">{c.since ? fmtDate(c.since) : "—"}</td>
                <td className="tright mono">{c._count.projects || "—"}</td>
                {showActions && (
                  <td className="tright" style={{ whiteSpace: "nowrap" }}>
                    {canEdit && confirming !== c.id && (
                      <button
                        className="btn-ghost btn-sm"
                        style={{ marginRight: 6 }}
                        onClick={() => {
                          setError(null);
                          setNotice(null);
                          setEditing({
                            id: c.id,
                            name: c.name,
                            type: c.type,
                            cityId: c.cityId,
                            gstin: c.gstin,
                            address: c.address,
                            phone: c.phone,
                            email: c.email,
                            since: c.since,
                          });
                        }}
                      >
                        Edit
                      </button>
                    )}
                    {!canDelete ? null : confirming === c.id ? (
                      <span style={{ display: "inline-flex", gap: 6 }}>
                        <button className="btn-warn btn-sm" disabled={remove.isPending} onClick={() => remove.mutate(c.id)}>
                          {remove.isPending ? "Removing…" : "Confirm"}
                        </button>
                        <button className="btn-ghost btn-sm" onClick={() => setConfirming(null)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        className="btn-ghost btn-sm"
                        onClick={() => {
                          setError(null);
                          setNotice(null);
                          setConfirming(c.id);
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > PAGE && (
        <div className="row" style={{ marginTop: 12, gap: 10 }}>
          <button className="btn-ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            ← Previous
          </button>
          <span className="mono small">
            {shown === 0 ? 0 : offset + 1}–{offset + shown} of {total.toLocaleString("en-IN")}
          </span>
          <button className="btn-ghost" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            Next →
          </button>
        </div>
      )}
      {creating && <NewClientModal onClose={() => setCreating(false)} />}
      {editing && <NewClientModal client={editing} onClose={() => setEditing(null)} />}
    </AppShell>
  );
}

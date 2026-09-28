"use client";

import { fmtINR } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { FormField, Modal } from "../../components/GovernanceUi";
import { title } from "../../components/OpsUi";
import { api } from "../../lib/api";

interface StoreQty {
  locationId: string;
  onHand: number;
  reserved: number;
  available: number;
  reorderLevel: number;
  low: boolean;
}

interface Item {
  id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  sizeMl: number | null;
  cost: number;
  vendor: { id: string; name: string } | null;
  stores: StoreQty[];
  total: number;
}

interface Overview {
  locations: Array<{ id: string; name: string; cityId: string; city: string; state: string }>;
  items: Item[];
  categories: string[];
  stats: { stockValue: number; belowReorder: number; reservedValue: number; reservations: number; movementsThisWeek: number };
  reservations: Array<{ id: string; skuId: string; locationId: string; qty: number; location: string; project: { id: string; name: string; eventDate: string } }>;
  movements: Array<{ id: string; type: string; qty: number; note: string | null; at: string; item: string; unit: string; from: string | null; to: string | null; by: string }>;
}

const MOVE_LABEL: Record<string, string> = {
  RECEIVE: "Received",
  PURCHASE: "Purchased",
  CONSUME: "Used",
  DAMAGE: "Damaged",
  ADJUSTMENT: "Count correction",
  TRANSFER_OUT: "Transfer",
  TRANSFER_IN: "Transfer in",
  RETURN: "Returned",
};

function ago(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 60) return `${Math.max(m, 1)} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

export default function InventoryPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["inventory-overview"], queryFn: () => api.get<Overview>("/inventory/overview"), staleTime: 30_000 });
  const { data: shell } = useQuery({ queryKey: ["shell"], queryFn: () => api.get<{ permissions: string[] }>("/users/me/shell"), staleTime: 30 * 60_000 });
  const can = (p: string) => !!shell?.permissions.includes(p);

  const [storeId, setStoreId] = useState<string | null>(null);
  const [cat, setCat] = useState("All");
  const [q, setQ] = useState("");
  const [modal, setModal] = useState<null | { kind: "add" } | { kind: "import" } | { kind: "adjust"; item: Item } | { kind: "transfer"; item?: Item } | { kind: "edit"; item: Item }>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["inventory-overview"] }), qc.invalidateQueries({ queryKey: ["nav-counts"] }), qc.invalidateQueries({ queryKey: ["inventory-items"] })]);

  const setup = useMutation({ mutationFn: () => api.post<{ created: string[] }>("/inventory/stores/setup"), onSuccess: refresh });
  const release = useMutation({ mutationFn: (id: string) => api.delete(`/inventory/reservations/${id}`), onSuccess: refresh });

  const locations = data?.locations ?? [];
  const store = locations.find((l) => l.id === storeId) ?? null;
  const idx = store ? locations.indexOf(store) : -1;
  const items = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (data?.items ?? []).filter((i) => (cat === "All" || i.category === cat) && (!n || `${i.name} ${i.sku}`.toLowerCase().includes(n)));
  }, [data, cat, q]);

  const stats = data?.stats;
  const storeValue = store ? (data?.items ?? []).reduce((s, i) => s + i.stores[idx].onHand * i.cost, 0) : stats?.stockValue ?? 0;
  const storeLow = store ? (data?.items ?? []).filter((i) => i.stores[idx].low).length : stats?.belowReorder ?? 0;

  const exportCsv = () => {
    const header = ["SKU", "Item", "Category", "Unit", "Unit cost", ...locations.flatMap((l) => [`${l.city} on hand`, `${l.city} available`])];
    const rows = (data?.items ?? []).map((i) => [i.sku, i.name, i.category, i.unit, i.cost, ...i.stores.flatMap((s) => [s.onHand, s.available])]);
    const csv = [header, ...rows].map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "podium-inventory.csv";
    a.click();
  };

  return (
    <AppShell crumb="Inventory">
      <div className="page-head">
        <div>
          <div className="page-title">Inventory</div>
          <div className="page-sub">Spirits, mixers, glassware and bar equipment across {locations.length || "the"} city stores</div>
        </div>
        <div className="page-actions">
          <button className="btn-ghost" disabled={!data?.items.length} onClick={exportCsv}>
            Export CSV
          </button>
          <Link className="btn-ghost" href="/menu#planner">
            Plan stock for an event
          </Link>
          {can("inventory:create") && (
            <button className="btn-ghost" onClick={() => setModal({ kind: "add" })}>
              + Add item
            </button>
          )}
          {can("inventory:edit") && locations.length > 1 && (
            <button className="btn-primary" onClick={() => setModal({ kind: "transfer" })}>
              Transfer stock
            </button>
          )}
        </div>
      </div>
      {error && <div className="notice red">{(error as Error).message}</div>}
      {isLoading && <div className="empty">Loading…</div>}

      {data && locations.length === 0 && (
        <div className="panel section-block" style={{ maxWidth: 640 }}>
          <div className="panel-title">No city stores yet</div>
          <p className="small" style={{ marginBottom: 12 }}>Stock is held per city store. Create one store for each city you operate in, then add items and receive stock into them.</p>
          {can("inventory:edit") ? (
            <button className="btn-primary" disabled={setup.isPending} onClick={() => setup.mutate()}>
              {setup.isPending ? "Creating…" : "Create a store in each city"}
            </button>
          ) : (
            <span className="small muted">Ask Operations or Admin to set up the stores.</span>
          )}
          {setup.error && <div className="notice red" style={{ marginTop: 8 }}>{(setup.error as Error).message}</div>}
        </div>
      )}

      {data && locations.length > 0 && data.items.length === 0 && (
        <div className="panel section-block" style={{ maxWidth: 640 }}>
          <div className="panel-title">No stock items yet</div>
          <p className="small" style={{ marginBottom: 12 }}>
            Add the spirits, mixers, glassware and equipment you hold — or pick them from the Elixir Coterie / The Cocktail Shop product catalogue. Then use <b>Adjust → Received</b> to book stock into a store.
          </p>
          <div className="row" style={{ gap: 8 }}>
            {can("inventory:create") && (
              <>
                <button className="btn-primary" onClick={() => setModal({ kind: "add" })}>
                  + Add item
                </button>
                <button className="btn-ghost" onClick={() => setModal({ kind: "import" })}>
                  Import from product catalogue
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {data && locations.length > 0 && (
        <>
          <div className="chips" style={{ marginBottom: 12 }}>
            <button className={`chipbtn ${!store ? "on" : ""}`} onClick={() => setStoreId(null)}>
              All stores
            </button>
            {locations.map((l) => (
              <button key={l.id} className={`chipbtn ${storeId === l.id ? "on" : ""}`} onClick={() => setStoreId(l.id)}>
                {l.city}
              </button>
            ))}
          </div>

          <div className="grid g4 section-block">
            <div className="stat">
              <div className="k">Stock value</div>
              <div className="v">{fmtINR(storeValue)}</div>
              <div className="d">{store ? `${store.city} store` : `all ${locations.length} stores`} · at unit cost</div>
            </div>
            <div className="stat" style={{ borderLeftColor: "var(--red)" }}>
              <div className="k">Below reorder</div>
              <div className="v">{storeLow}</div>
              <div className="d down">item-store pairs to replenish</div>
            </div>
            <div className="stat" style={{ borderLeftColor: "var(--blue)" }}>
              <div className="k">Reserved for events</div>
              <div className="v">{fmtINR(stats?.reservedValue ?? 0)}</div>
              <div className="d">{stats?.reservations ?? 0} reservations</div>
            </div>
            <div className="stat" style={{ borderLeftColor: "var(--green)" }}>
              <div className="k">Movements (7 days)</div>
              <div className="v">{stats?.movementsThisWeek ?? 0}</div>
              <div className="d">receipts, transfers, usage</div>
            </div>
          </div>

          <div className="grid g-side-r">
            <div className="panel">
              <div className="row" style={{ gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                <div className="chips">
                  {["All", ...(data.categories ?? [])].map((c) => (
                    <button key={c} className={`chipbtn ${cat === c ? "on" : ""}`} onClick={() => setCat(c)}>
                      {c}
                    </button>
                  ))}
                </div>
                <input className="inp" style={{ marginLeft: "auto", maxWidth: 220 }} placeholder="Search item or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
                {can("inventory:create") && data.items.length > 0 && (
                  <button className="btn-ghost btn-sm" onClick={() => setModal({ kind: "import" })}>
                    Import from catalogue
                  </button>
                )}
              </div>
              <div style={{ overflowX: "auto" }}>
                {!store ? (
                  <table>
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th>Category</th>
                        {locations.map((l) => (
                          <th key={l.id} className="num">
                            {l.city}
                          </th>
                        ))}
                        <th className="num">Total</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {items.length === 0 && (
                        <tr>
                          <td colSpan={locations.length + 4} className="empty">
                            No items match.
                          </td>
                        </tr>
                      )}
                      {items.map((i) => (
                        <tr key={i.id}>
                          <td>
                            <b style={{ fontWeight: 500 }}>{i.name}</b>
                            <div className="small faint mono">{i.sku}</div>
                          </td>
                          <td className="small">{i.category}</td>
                          {i.stores.map((s) => (
                            <td key={s.locationId} className="num">
                              <span className={s.low ? "negative" : ""} title={`${s.available} available · ${s.reserved} reserved · reorder at ${s.reorderLevel || "—"}`}>
                                {s.available}
                              </span>
                            </td>
                          ))}
                          <td className="num">{i.total}</td>
                          <td>
                            {can("inventory:edit") && locations.length > 1 && (
                              <button className="btn-ghost btn-sm" onClick={() => setModal({ kind: "transfer", item: i })}>
                                Transfer
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className="num">On hand</th>
                        <th className="num">Reserved</th>
                        <th className="num">Available</th>
                        <th className="num">Reorder at</th>
                        <th className="num">Value</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((i) => {
                        const s = i.stores[idx];
                        return (
                          <tr key={i.id}>
                            <td>
                              <b style={{ fontWeight: 500 }}>{i.name}</b>
                              <div className="small faint mono">
                                {i.sku} · {i.unit} · {i.cost ? fmtINR(i.cost) : <span className="negative">no unit cost</span>}
                              </div>
                            </td>
                            <td className="num">{s.onHand}</td>
                            <td className="num">{s.reserved || "—"}</td>
                            <td className="num">
                              <span className={s.low ? "negative" : ""}>{s.available}</span>
                            </td>
                            <td className="num">
                              <ReorderCell skuId={i.id} locationId={store.id} value={s.reorderLevel} editable={can("inventory:edit")} onSaved={refresh} />
                            </td>
                            <td className="num">{fmtINR(s.onHand * i.cost)}</td>
                            <td style={{ whiteSpace: "nowrap" }}>
                              {can("inventory:edit") && (
                                <button className="btn-ghost btn-sm" onClick={() => setModal({ kind: "adjust", item: i })}>
                                  Adjust
                                </button>
                              )}{" "}
                              {can("inventory:edit") && (
                                <button className="btn-ghost btn-sm" onClick={() => setModal({ kind: "edit", item: i })}>
                                  Edit
                                </button>
                              )}{" "}
                              {s.low && can("inventory:create") && (
                                <button className="btn-warn btn-sm" onClick={() => router.push("/procurement/requests/new")}>
                                  Reorder
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="small muted" style={{ marginTop: 8 }}>
                {store
                  ? "Available = on hand minus stock reserved for events. Set a reorder level to get low-stock alerts on Home and in the sidebar."
                  : "Numbers show available stock (on hand minus reserved for events). Red means at or below the reorder level. Pick a city to adjust stock and set reorder levels."}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="panel">
                <div className="panel-title">Stock movements</div>
                {data.movements.length === 0 && <div className="empty">No movements yet.</div>}
                {data.movements.map((m) => (
                  <div key={m.id} className="activity-item">
                    <div className="dot2" style={{ background: m.type === "DAMAGE" ? "var(--red)" : m.type === "RECEIVE" || m.type === "PURCHASE" ? "var(--green)" : "var(--brass)" }} />
                    <div>
                      <div>
                        <b>{MOVE_LABEL[m.type] ?? title(m.type)}</b> · {m.qty} × {m.item}
                      </div>
                      <div className="small muted">
                        {m.from ?? ""}
                        {m.from && m.to ? " → " : ""}
                        {m.to ?? ""} · {m.by}
                        {m.note ? ` · ${m.note}` : ""}
                      </div>
                      <div className="when">{ago(m.at)}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="panel">
                <div className="panel-title">Reserved for events</div>
                {data.reservations.length === 0 && <div className="empty">Nothing reserved. Reserve stock for an event from the menu planner.</div>}
                {data.reservations.map((r) => (
                  <div key={r.id} className="row small" style={{ padding: "6px 0", borderBottom: "1px solid #F1EEE5" }}>
                    <span style={{ flex: 1 }}>
                      {r.qty} × {data.items.find((i) => i.id === r.skuId)?.name ?? "item"}
                      <div className="muted">
                        {r.project.name} · {r.location}
                      </div>
                    </span>
                    {can("inventory:edit") && (
                      <button className="btn-ghost btn-sm" disabled={release.isPending} onClick={() => release.mutate(r.id)}>
                        Release
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {modal?.kind === "add" && <ItemModal onClose={() => setModal(null)} onSaved={refresh} />}
      {modal?.kind === "edit" && <ItemModal item={modal.item} onClose={() => setModal(null)} onSaved={refresh} />}
      {modal?.kind === "import" && <ImportModal onClose={() => setModal(null)} onSaved={refresh} />}
      {modal?.kind === "adjust" && store && <AdjustModal item={modal.item} store={store} onHand={modal.item.stores[idx].onHand} onClose={() => setModal(null)} onSaved={refresh} />}
      {modal?.kind === "transfer" && data && <TransferModal data={data} initial={modal.item} fromId={storeId} onClose={() => setModal(null)} onSaved={refresh} />}
    </AppShell>
  );
}

function ReorderCell({ skuId, locationId, value, editable, onSaved }: { skuId: string; locationId: string; value: number; editable: boolean; onSaved: () => void }) {
  const [v, setV] = useState(String(value || ""));
  const save = useMutation({ mutationFn: () => api.put("/inventory/reorder-level", { skuId, locationId, reorderLevel: Number(v || 0) }), onSuccess: onSaved });
  if (!editable) return <>{value || "—"}</>;
  return (
    <input
      className="inp mono"
      style={{ width: 64, textAlign: "right", padding: "2px 6px" }}
      type="number"
      min={0}
      value={v}
      title={save.error ? (save.error as Error).message : "Reorder level — press Enter to save"}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => Number(v || 0) !== value && save.mutate()}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function ItemModal({ item, onClose, onSaved }: { item?: Item; onClose: () => void; onSaved: () => void }) {
  const { data: vendors } = useQuery({ queryKey: ["vendors"], queryFn: () => api.get<Array<{ id: string; name: string; category: string | null }>>("/vendors"), staleTime: 5 * 60_000 });
  const [f, setF] = useState({
    sku: item?.sku ?? "",
    name: item?.name ?? "",
    category: item?.category ?? "Spirits",
    unit: item?.unit ?? "bottle",
    sizeMl: item?.sizeMl ? String(item.sizeMl) : "750",
    cost: item ? String(item.cost || "") : "",
    vendorId: item?.vendor?.id ?? "",
  });
  const [vq, setVq] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...(item ? {} : { sku: f.sku }),
        name: f.name,
        category: f.category,
        unit: f.unit,
        sizeMl: f.sizeMl ? Number(f.sizeMl) : null,
        standardCost: Number(f.cost || 0),
        preferredVendorId: f.vendorId || null,
      };
      return item ? api.patch(`/inventory/items/${item.id}`, body) : api.post("/inventory/items", body);
    },
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
  });
  const vendorMatches = (vendors ?? []).filter((v) => vq.trim().length >= 2 && `${v.name} ${v.category ?? ""}`.toLowerCase().includes(vq.toLowerCase())).slice(0, 6);
  const chosen = vendors?.find((v) => v.id === f.vendorId);
  const ok = (item || f.sku.trim()) && f.name.trim() && f.category.trim() && f.unit.trim();
  return (
    <Modal
      title={item ? `Edit ${item.name}` : "Add stock item"}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!ok || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : item ? "Save" : "Add item"}
          </button>
        </>
      }
    >
      <div className="grid g2" style={{ gap: 10 }}>
        {!item && (
          <FormField label="SKU">
            <input className="inp mono" autoFocus value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} placeholder="e.g. SPR-GIN-750" />
          </FormField>
        )}
        <FormField label="Name">
          <input className="inp" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Tanqueray London Dry 750ml" />
        </FormField>
        <FormField label="Category">
          <input className="inp" list="inv-cats" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
          <datalist id="inv-cats">
            {["Spirits", "Liqueurs", "Wine", "Beer", "Mixers", "Syrups", "Garnish", "Glassware", "Bar equipment", "Consumables"].map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </FormField>
        <FormField label="Unit">
          <input className="inp" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="bottle, case, piece" />
        </FormField>
        <FormField label="Size (ml, for drinks)">
          <input className="inp mono" type="number" min={1} value={f.sizeMl} onChange={(e) => setF({ ...f, sizeMl: e.target.value })} placeholder="blank for non-liquids" />
        </FormField>
        <FormField label="Unit cost (₹, what you pay)">
          <input className="inp mono" type="number" min={0} step="0.01" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} />
        </FormField>
      </div>
      <FormField label="Preferred vendor (optional)">
        {chosen ? (
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b>{chosen.name}</b>
            <button className="btn-ghost btn-sm" onClick={() => setF({ ...f, vendorId: "" })}>
              Change
            </button>
          </div>
        ) : (
          <>
            <input className="inp" value={vq} onChange={(e) => setVq(e.target.value)} placeholder="Type 2+ letters of a vendor or category" />
            {vendorMatches.map((v) => (
              <button key={v.id} className="btn-ghost btn-sm" style={{ textAlign: "left" }} onClick={() => setF({ ...f, vendorId: v.id })}>
                {v.name} <span className="muted">{v.category ?? ""}</span>
              </button>
            ))}
          </>
        )}
      </FormField>
      <div className="small muted">Size and unit cost drive recipe costing: a 60 ml pour of a ₹2,400 750 ml bottle costs ₹192.</div>
      {save.error && <div className="notice red">{(save.error as Error).message}</div>}
    </Modal>
  );
}

function ImportModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { data } = useQuery({
    queryKey: ["product-search", q],
    queryFn: () => api.get<{ rows: Array<{ id: string; name: string; sku: string | null; category: string | null; brand: { name: string } }> }>(`/products?search=${encodeURIComponent(q)}&limit=40`),
    enabled: q.trim().length >= 2,
  });
  const run = useMutation({
    mutationFn: () => api.post<{ created: number; skipped: string[] }>("/inventory/items/from-products", { productIds: [...picked] }),
    onSuccess: async () => {
      await onSaved();
    },
  });
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <Modal
      title="Import from product catalogue"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            {run.isSuccess ? "Done" : "Cancel"}
          </button>
          {!run.isSuccess && (
            <button className="btn-primary" disabled={picked.size === 0 || run.isPending} onClick={() => run.mutate()}>
              {run.isPending ? "Importing…" : `Add ${picked.size} item${picked.size === 1 ? "" : "s"}`}
            </button>
          )}
        </>
      }
    >
      {run.isSuccess ? (
        <div className="notice">
          Added {run.data.created} item{run.data.created === 1 ? "" : "s"}.{run.data.skipped.length ? ` ${run.data.skipped.length} already existed.` : ""} Set each one&apos;s unit cost (Edit) — the catalogue holds selling prices, not what you pay.
        </div>
      ) : (
        <>
          <input className="inp" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Elixir Coterie / The Cocktail Shop products" />
          <div style={{ maxHeight: 300, overflowY: "auto" }}>
            {(data?.rows ?? []).map((p) => (
              <label key={p.id} className="checkitem" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
                <span style={{ flex: 1 }}>
                  {p.name}
                  <div className="small muted">
                    {p.brand?.name}
                    {p.category ? ` · ${p.category}` : ""}
                    {p.sku ? ` · ${p.sku}` : ""}
                  </div>
                </span>
              </label>
            ))}
            {q.trim().length >= 2 && data?.rows.length === 0 && <div className="small muted">No products match.</div>}
          </div>
          {picked.size > 0 && <div className="small muted">{picked.size} selected</div>}
        </>
      )}
      {run.error && <div className="notice red">{(run.error as Error).message}</div>}
    </Modal>
  );
}

const ADJUST_TYPES = [
  { key: "RECEIVE", label: "Received (GRN, delivery)" },
  { key: "CONSUME", label: "Used at an event" },
  { key: "DAMAGE", label: "Damaged / broken" },
  { key: "COUNT", label: "Count correction (set exact count)" },
] as const;

function AdjustModal({ item, store, onHand, onClose, onSaved }: { item: Item; store: Overview["locations"][number]; onHand: number; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState<(typeof ADJUST_TYPES)[number]["key"]>("RECEIVE");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const n = Number(qty || 0);
  const delta = type === "COUNT" ? n - onHand : type === "RECEIVE" ? n : -n;
  const save = useMutation({
    mutationFn: () => {
      const base = { skuId: item.id, note: note.trim() || undefined };
      if (type === "RECEIVE") return api.post("/inventory/movements", { ...base, type: "RECEIVE", toLocationId: store.id, qty: n });
      if (type === "CONSUME" || type === "DAMAGE") return api.post("/inventory/movements", { ...base, type, fromLocationId: store.id, qty: n });
      return api.post("/inventory/movements", {
        ...base,
        type: "ADJUSTMENT",
        qty: Math.abs(delta),
        ...(delta > 0 ? { toLocationId: store.id } : { fromLocationId: store.id }),
        note: note.trim() || `Count correction: ${onHand} → ${n}`,
      });
    },
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
  });
  const ok = type === "COUNT" ? qty !== "" && n >= 0 && delta !== 0 : n > 0 && (type === "RECEIVE" || n <= onHand);
  return (
    <Modal
      title={`Adjust stock — ${item.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!ok || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save adjustment"}
          </button>
        </>
      }
    >
      <div className="small muted">
        {store.name} · {onHand} {item.unit} on hand
      </div>
      <div className="grid g2" style={{ gap: 10 }}>
        <FormField label="Type">
          <select className="inp" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            {ADJUST_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={type === "COUNT" ? "Counted on shelf" : "Quantity"}>
          <input className="inp mono" type="number" min={0} autoFocus value={qty} onChange={(e) => setQty(e.target.value)} />
        </FormField>
      </div>
      <FormField label="Note">
        <input className="inp" value={note} onChange={(e) => setNote(e.target.value)} placeholder="GRN number, event, reason" />
      </FormField>
      {type !== "RECEIVE" && type !== "COUNT" && n > onHand && <div className="small negative">Only {onHand} on hand.</div>}
      {type === "COUNT" && qty !== "" && <div className="small muted">{delta === 0 ? "Matches the system count." : `${delta > 0 ? "+" : ""}${delta} ${item.unit}`}</div>}
      {save.error && <div className="notice red">{(save.error as Error).message}</div>}
    </Modal>
  );
}

function TransferModal({ data, initial, fromId, onClose, onSaved }: { data: Overview; initial?: Item; fromId: string | null; onClose: () => void; onSaved: () => void }) {
  const locs = data.locations;
  const [skuId, setSkuId] = useState(initial?.id ?? data.items[0]?.id ?? "");
  const [from, setFrom] = useState(fromId ?? locs[0]?.id ?? "");
  const [to, setTo] = useState(locs.find((l) => l.id !== (fromId ?? locs[0]?.id))?.id ?? "");
  const [qty, setQty] = useState("");
  const [permit, setPermit] = useState("");
  const item = data.items.find((i) => i.id === skuId);
  const fromIdx = locs.findIndex((l) => l.id === from);
  const available = item && fromIdx >= 0 ? item.stores[fromIdx].available : 0;
  const fromLoc = locs.find((l) => l.id === from);
  const toLoc = locs.find((l) => l.id === to);
  // Liquor crossing a state line needs an excise transport permit.
  const isLiquor = !!item && /spirit|liqueur|wine|beer|liquor|alcohol/i.test(item.category);
  const interState = isLiquor && !!fromLoc && !!toLoc && fromLoc.state !== toLoc.state;
  const n = Number(qty || 0);
  const save = useMutation({
    mutationFn: () =>
      api.post("/inventory/movements", {
        skuId,
        type: "TRANSFER_OUT",
        fromLocationId: from,
        toLocationId: to,
        qty: n,
        ...(interState ? { note: `Excise transport permit ${permit.trim()}` } : {}),
      }),
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
  });
  const ok = skuId && from && to && from !== to && n > 0 && n <= available && (!interState || permit.trim());
  return (
    <Modal
      title="Transfer stock between cities"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!ok || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Moving…" : "Transfer"}
          </button>
        </>
      }
    >
      <FormField label="Item">
        <select className="inp" value={skuId} onChange={(e) => setSkuId(e.target.value)}>
          {data.items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} ({i.category})
            </option>
          ))}
        </select>
      </FormField>
      <div className="grid g3" style={{ gap: 10 }}>
        <FormField label="From">
          <select className="inp" value={from} onChange={(e) => setFrom(e.target.value)}>
            {locs.map((l) => (
              <option key={l.id} value={l.id}>
                {l.city}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="To">
          <select className="inp" value={to} onChange={(e) => setTo(e.target.value)}>
            {locs.map((l) => (
              <option key={l.id} value={l.id}>
                {l.city}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Quantity">
          <input className="inp mono" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        </FormField>
      </div>
      {item && fromLoc && (
        <div className="small muted">
          {fromLoc.city} has <b>{available}</b> {item.unit} available ({item.stores[fromIdx].reserved} reserved for events).
        </div>
      )}
      {from === to && <div className="notice red">Pick two different cities.</div>}
      {n > available && <div className="notice red">Only {available} available — lower the quantity or release a reservation first.</div>}
      {interState && (
        <>
          <div className="notice">
            Liquor moving {fromLoc?.state} → {toLoc?.state} crosses a state line and needs an excise transport permit.
          </div>
          <FormField label="Excise transport permit number">
            <input className="inp mono" value={permit} onChange={(e) => setPermit(e.target.value)} />
          </FormField>
        </>
      )}
      {save.error && <div className="notice red">{(save.error as Error).message}</div>}
    </Modal>
  );
}

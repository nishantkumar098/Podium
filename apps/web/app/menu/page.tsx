"use client";

import { fmtINR } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { ProjectSelect } from "../../components/OpsUi";
import { api, apiDownload, ApiError } from "../../lib/api";
import type { InventoryItemOptionDto, RecipeDto, RecipeItemDto } from "../../lib/types";

interface StockOverview {
  locations: Array<{ id: string; city: string }>;
  items: Array<{ id: string; name: string; unit: string; sizeMl: number | null; stores: Array<{ locationId: string; available: number }> }>;
}

/** Planning buffer on top of the exact amounts. */
const BUFFER = 1.1;
/** Bottle size assumed for unlinked spirits and mixers when working out "buy as". */
const STD_BOTTLE_ML = 750;
const UNITS = ["ml", "dash", "cube", "leaves", "pc", "tsp", "oz", "splash", "as needed"];

const n = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? null : Number(v));
const fmtQty = (v: number) => (Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toLocaleString("en-IN", { maximumFractionDigits: 1 }));
const lineLabel = (i: RecipeItemDto) => {
  const q = n(i.qty);
  const name = i.ingredient || i.item?.name || "";
  if (q === null) return `${name}${i.unit && i.unit !== "ml" ? ` (${i.unit})` : ""}`;
  const max = n(i.qtyMax);
  return `${fmtQty(q)}${max ? `–${fmtQty(max)}` : ""} ${i.unit} ${name}`;
};

/**
 * Requirements: the recipe book, and exactly what an event needs. Pick the
 * cocktails on the menu, the guests and drinks per guest, and every
 * ingredient is totalled across the menu with a 10% buffer — spirits and
 * mixers rounded up to bottles, and lines linked to stock checked against the
 * chosen city store (reserve what's there, raise a purchase request for the
 * rest). Amounts are the recipes' own; ranges use the lower figure.
 */
export default function RequirementsPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<RecipeDto | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: recipes, isLoading } = useQuery({ queryKey: ["recipes"], queryFn: () => api.get<RecipeDto[]>("/recipes") });
  const { data: skus } = useQuery({ queryKey: ["inventory-items"], queryFn: () => api.get<InventoryItemOptionDto[]>("/inventory/items") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["recipes"] });

  return (
    <AppShell crumb="Requirements">
      <div className="page-head">
        <div>
          <div className="page-title">Requirements</div>
          <div className="page-sub">The recipe book, and exactly what an event needs — every ingredient, bottle and stock gap</div>
        </div>
        <div className="page-actions">
          <button className="btn-primary" onClick={() => setEditing("new")}>
            + New recipe
          </button>
        </div>
      </div>
      {error && <div className="notice red" style={{ marginBottom: 12 }}>{error}</div>}
      {editing && (
        <RecipeEditor
          recipe={editing === "new" ? null : editing}
          skus={skus ?? []}
          spirits={[...new Set((recipes ?? []).map((r) => r.spirit).filter((s): s is string => !!s))]}
          onDone={() => {
            setEditing(null);
            setError(null);
            void refresh();
          }}
          onCancel={() => setEditing(null)}
          onError={(e) => setError(e.message)}
        />
      )}

      <Calculator recipes={recipes ?? []} loading={isLoading} />
      <RecipeBook recipes={recipes ?? []} loading={isLoading} onEdit={setEditing} onError={setError} />
    </AppShell>
  );
}

// ------------------------------------------------------------ calculator

interface Need {
  key: string;
  name: string;
  unit: string;
  exact: number;
  /** Total using each range's upper amount; shown only when a range is involved. */
  most: number;
  ranged: boolean;
  usedIn: string[];
  skuId: string | null;
}

function Calculator({ recipes, loading }: { recipes: RecipeDto[]; loading: boolean }) {
  const qc = useQueryClient();
  const { data: stock } = useQuery({ queryKey: ["inventory-overview"], queryFn: () => api.get<StockOverview>("/inventory/overview"), staleTime: 30_000 });
  const [guests, setGuests] = useState("200");
  const [dpg, setDpg] = useState("3");
  const [storeId, setStoreId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  // The challan's own header fields (blank ones fall back to the project).
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheet, setSheet] = useState({ eventName: "", address: "", to: "", from: "", hookah: "", staffing: "", inclusions: "" });
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [spirit, setSpirit] = useState("All");

  const total = Math.max(0, Math.round(Number(guests || 0) * Number(dpg || 0)));
  const menu = recipes.filter((r) => picked.includes(r.id));
  // Drinks not set by hand are shared evenly across the rest of the menu.
  const manual = menu.reduce((s, r) => s + (overrides[r.id] !== undefined && overrides[r.id] !== "" ? Number(overrides[r.id]) || 0 : 0), 0);
  const autoCount = menu.filter((r) => overrides[r.id] === undefined || overrides[r.id] === "").length;
  const autoEach = autoCount ? Math.max(0, total - manual) / autoCount : 0;
  const servesOf = (id: string) => (overrides[id] !== undefined && overrides[id] !== "" ? Number(overrides[id]) || 0 : Math.round(autoEach));
  const planned = menu.reduce((s, r) => s + servesOf(r.id), 0);
  const store = stock?.locations.find((l) => l.id === storeId) ?? null;

  const { needs, unquantified, liquidMl } = useMemo(() => {
    const map = new Map<string, Need>();
    const loose = new Map<string, Set<string>>();
    let liquid = 0;
    for (const r of menu) {
      const serves = servesOf(r.id);
      if (!serves) continue;
      for (const i of r.items) {
        const name = i.ingredient || i.item?.name || "Ingredient";
        const q = n(i.qty);
        if (q === null) {
          const set = loose.get(name) ?? new Set<string>();
          set.add(r.name);
          loose.set(name, set);
          continue;
        }
        const key = `${i.skuId ?? name.toLowerCase()}|${i.unit.toLowerCase()}`;
        const cur = map.get(key) ?? { key, name, unit: i.unit, exact: 0, most: 0, ranged: false, usedIn: [], skuId: i.skuId };
        const max = n(i.qtyMax);
        cur.exact += q * serves;
        cur.most += (max ?? q) * serves;
        if (max) cur.ranged = true;
        if (!cur.usedIn.includes(r.name)) cur.usedIn.push(r.name);
        map.set(key, cur);
        if (i.unit.toLowerCase() === "ml") liquid += q * serves;
      }
    }
    const list = [...map.values()].sort((a, b) => (a.unit === "ml" ? 0 : 1) - (b.unit === "ml" ? 0 : 1) || b.exact - a.exact);
    return { needs: list, unquantified: [...loose.entries()].map(([name, set]) => ({ name, usedIn: [...set] })), liquidMl: liquid };
    // servesOf depends on overrides/autoEach, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, overrides, autoEach]);

  const storeIdx = stock && store ? stock.locations.findIndex((l) => l.id === store.id) : -1;
  const rows = needs.map((nd) => {
    const buffered = nd.exact * BUFFER;
    const sku = nd.skuId ? stock?.items.find((x) => x.id === nd.skuId) : undefined;
    const isMl = nd.unit.toLowerCase() === "ml";
    const size = sku?.sizeMl ?? (isMl ? STD_BOTTLE_ML : null);
    const units = size && isMl ? Math.ceil(buffered / size) : null;
    const available = sku && storeIdx >= 0 ? sku.stores[storeIdx]?.available ?? 0 : null;
    return { ...nd, buffered, sku, size, units, available, short: units !== null && available !== null ? Math.max(0, units - available) : 0 };
  });
  const linked = rows.filter((r) => r.sku && r.units !== null && r.available !== null);
  const shortRows = linked.filter((r) => r.short > 0);
  const canReserve = !!projectId && !!store && linked.some((r) => Math.min(r.units!, r.available!) > 0);

  const reserve = useMutation({
    mutationFn: () =>
      api.post<{ reserved: number }>("/inventory/reservations", {
        projectId,
        locationId: store!.id,
        lines: linked.filter((r) => Math.min(r.units!, r.available!) > 0).map((r) => ({ skuId: r.skuId!, qty: Math.min(r.units!, r.available!) })),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory-overview"] }),
  });

  const spirits = ["All", ...new Set(recipes.map((r) => r.spirit || "Other"))];
  const shown = recipes.filter((r) => spirit === "All" || (r.spirit || "Other") === spirit);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  /** The requirement sheet as AMM's Excel challan. */
  const sheetDownload = useMutation({
    mutationFn: () =>
      apiDownload("/recipes/requirement-sheet", "requirement-sheet.xlsx", {
        projectId: projectId || null,
        eventName: sheet.eventName.trim() || null,
        address: sheet.address.trim() || null,
        to: sheet.to.trim() || null,
        from: sheet.from.trim() || null,
        hookah: sheet.hookah.trim() || null,
        staffing: sheet.staffing.trim() || null,
        inclusions: sheet.inclusions.trim() || null,
        pax: Math.max(0, Math.round(Number(guests) || 0)),
        menu: menu.map((r) => ({ recipeId: r.id, serves: servesOf(r.id) })),
      }),
    meta: { sound: "silent" },
  });

  const exportCsv = () => {
    const cell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = [
      ["Ingredient", "Unit", "Exact", "With 10% buffer", "Buy as", "Used in"].join(","),
      ...rows.map((r) =>
        [r.name, r.unit, Math.round(r.exact * 10) / 10, Math.ceil(r.buffered), r.units !== null ? `${r.units} × ${r.size} ml` : "", r.usedIn.join(" / ")].map(cell).join(","),
      ),
      ...unquantified.map((u) => [u.name, "as needed", "", "", "", u.usedIn.join(" / ")].map(cell).join(",")),
      "",
      ["Cocktail", "Drinks"].join(","),
      ...menu.map((r) => [r.name, servesOf(r.id)].map(cell).join(",")),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `requirements-${guests}-guests-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="grid g-side-r section-block" id="planner">
      <div className="panel">
        <div className="panel-title">Event requirements</div>
        {loading ? (
          <div className="empty">Loading…</div>
        ) : recipes.length === 0 ? (
          <div className="empty">No recipes yet — add one with + New recipe.</div>
        ) : (
          <>
            <div className="grid g3" style={{ gap: 10, marginBottom: 12 }}>
              <label className="small">
                Guests
                <input className="inp mono" type="number" min={0} value={guests} onChange={(e) => setGuests(e.target.value)} />
              </label>
              <label className="small">
                Drinks per guest
                <input className="inp mono" type="number" min={0} step={0.5} value={dpg} onChange={(e) => setDpg(e.target.value)} />
              </label>
              <label className="small">
                Check against store
                <select className="inp" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                  <option value="">No stock check</option>
                  {stock?.locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.city}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="row" style={{ justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 6 }}>
              <span className="small">
                <b style={{ fontWeight: 600 }}>Pick the menu</b> — {picked.length} cocktail{picked.length === 1 ? "" : "s"} · {total.toLocaleString("en-IN")} drinks
              </span>
              <div className="chips">
                {spirits.map((s) => (
                  <button key={s} className={`chipbtn ${spirit === s ? "on" : ""}`} onClick={() => setSpirit(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div className="chips" style={{ marginBottom: 12, flexWrap: "wrap" }}>
              {shown.map((r) => (
                <button key={r.id} className={`chipbtn ${picked.includes(r.id) ? "on" : ""}`} onClick={() => toggle(r.id)} title={r.items.map(lineLabel).join(" · ")}>
                  {picked.includes(r.id) ? "✓ " : "+ "}
                  {r.name}
                </button>
              ))}
            </div>

            {menu.length === 0 ? (
              <div className="empty">Pick the cocktails on the event&apos;s menu to see what it needs.</div>
            ) : (
              <>
                <div className="row" style={{ flexWrap: "wrap", gap: 10, marginBottom: 6 }}>
                  {menu.map((r) => (
                    <label key={r.id} className="small row" style={{ gap: 5 }}>
                      {r.name}
                      <input
                        className="inp mono"
                        style={{ width: 72 }}
                        type="number"
                        min={0}
                        value={overrides[r.id] ?? String(Math.round(autoEach))}
                        onChange={(e) => setOverrides({ ...overrides, [r.id]: e.target.value })}
                      />
                    </label>
                  ))}
                </div>
                <div className="small muted" style={{ marginBottom: 12 }}>
                  Drinks per cocktail — shared evenly unless you set a number.{" "}
                  {planned !== total && <span className="negative">Planned {planned.toLocaleString("en-IN")} of {total.toLocaleString("en-IN")}.</span>}{" "}
                  {Object.keys(overrides).length > 0 && (
                    <button className="linkish" onClick={() => setOverrides({})}>
                      Reset to even split
                    </button>
                  )}
                </div>

                <div style={{ overflowX: "auto" }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Ingredient</th>
                        <th className="num">Exact</th>
                        <th className="num">+10% buffer</th>
                        <th className="num">Buy as</th>
                        {store && <th className="num">In {store.city}</th>}
                        {store && <th className="num">Short</th>}
                        <th>Used in</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key}>
                          <td>
                            {r.name}
                            {r.sku && <div className="small faint">stock: {r.sku.name}</div>}
                          </td>
                          <td className="num">
                            {fmtQty(Math.round(r.exact * 10) / 10)} {r.unit}
                            {r.ranged && <div className="small faint">up to {fmtQty(Math.round(r.most))}</div>}
                          </td>
                          <td className="num">
                            <b style={{ fontWeight: 600 }}>
                              {fmtQty(Math.ceil(r.buffered))} {r.unit}
                            </b>
                          </td>
                          <td className="num">{r.units !== null ? `${r.units} × ${(r.size ?? 0) >= 1000 ? `${(r.size ?? 0) / 1000} L` : `${r.size} ml`}` : "—"}</td>
                          {store && <td className="num">{r.available ?? <span className="faint">not linked</span>}</td>}
                          {store && <td className="num">{r.short ? <span className="negative">{r.short}</span> : "—"}</td>}
                          <td className="small muted">{r.usedIn.join(", ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {unquantified.length > 0 && (
                  <div className="notice" style={{ marginTop: 10 }}>
                    <b style={{ fontWeight: 600 }}>Also needed — no quantity in the recipe:</b>{" "}
                    {unquantified.map((u) => `${u.name} (${u.usedIn.join(", ")})`).join(" · ")}
                  </div>
                )}
                <div className="row" style={{ marginTop: 12, flexWrap: "wrap", gap: 8 }}>
                  <button className="btn-primary" disabled={sheetDownload.isPending} onClick={() => sheetDownload.mutate()}>
                    {sheetDownload.isPending ? "Building…" : "Requirement sheet (Excel)"}
                  </button>
                  <button className="btn-ghost" onClick={() => setSheetOpen((o) => !o)}>
                    {sheetOpen ? "Hide sheet details" : "Sheet details"}
                  </button>
                  <button className="btn-ghost" onClick={exportCsv}>
                    Download requirements (CSV)
                  </button>
                  {store && linked.length > 0 && (
                    <>
                      <div style={{ minWidth: 220 }}>
                        <ProjectSelect value={projectId} onChange={setProjectId} />
                      </div>
                      <button className="btn-primary" disabled={!canReserve || reserve.isPending} onClick={() => reserve.mutate()}>
                        {reserve.isPending ? "Reserving…" : "Reserve available stock"}
                      </button>
                    </>
                  )}
                  {shortRows.length > 0 && (
                    <a className="btn-warn" href="/procurement/requests/new">
                      Raise purchase request for {shortRows.length} short item{shortRows.length > 1 ? "s" : ""}
                    </a>
                  )}
                </div>
                {sheetDownload.error && <div className="notice red" style={{ marginTop: 8 }}>{(sheetDownload.error as Error).message}</div>}
                {sheetOpen && (
                  <div className="panel" style={{ marginTop: 10, background: "var(--paper)" }}>
                    <div className="panel-title">Requirement sheet header</div>
                    <div className="small muted" style={{ marginBottom: 8 }}>
                      Printed at the top of the challan. Left blank, the event name, address and city come from the chosen project.
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10 }}>
                      {(
                        [
                          ["eventName", "Event name"],
                          ["address", "Address"],
                          ["to", "To (city)"],
                          ["from", "From (store)"],
                          ["hookah", "Hookah"],
                          ["staffing", "Staffing"],
                        ] as Array<[keyof typeof sheet, string]>
                      ).map(([k, label]) => (
                        <label key={k} className="small" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {label}
                          <input className="inp" value={sheet[k]} onChange={(e) => setSheet({ ...sheet, [k]: e.target.value })} placeholder={k === "hookah" ? "10 nos." : ""} />
                        </label>
                      ))}
                    </div>
                    <label className="small" style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 10 }}>
                      Inclusions note (printed across the bottom)
                      <textarea className="inp" rows={2} value={sheet.inclusions} onChange={(e) => setSheet({ ...sheet, inclusions: e.target.value })} />
                    </label>
                  </div>
                )}
                {store && linked.length === 0 && (
                  <div className="small muted" style={{ marginTop: 8 }}>
                    None of these ingredients is linked to a stock item yet, so there&apos;s nothing to check in {store.city}. Link them from a recipe&apos;s Edit.
                  </div>
                )}
                {reserve.isSuccess && <div className="notice" style={{ marginTop: 8 }}>Reserved {reserve.data.reserved} item{reserve.data.reserved === 1 ? "" : "s"} in {store?.city}.</div>}
                {reserve.error && <div className="notice red" style={{ marginTop: 8 }}>{(reserve.error as Error).message}</div>}
              </>
            )}
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-title">Summary</div>
        <div className="v mono" style={{ fontSize: 24, fontWeight: 600 }}>
          {(Math.ceil(liquidMl * BUFFER) / 1000).toLocaleString("en-IN", { maximumFractionDigits: 1 })} L
        </div>
        <div className="small muted">liquid to carry (with 10% buffer) for {planned.toLocaleString("en-IN")} drinks</div>
        <div className="small" style={{ marginTop: 14 }}>
          {menu.map((r) => (
            <div key={r.id} className="row" style={{ justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #F1EEE5" }}>
              <span>
                {r.name} <span className="faint">· {r.glass}</span>
              </span>
              <span className="mono">{servesOf(r.id).toLocaleString("en-IN")}</span>
            </div>
          ))}
          {menu.length > 0 && (
            <div className="small muted" style={{ marginTop: 10 }}>
              Glassware: {[...new Set(menu.map((r) => r.glass))].join(" · ")}
            </div>
          )}
        </div>
        <div className="notice" style={{ marginTop: 12 }}>
          Spirits and mixers are rounded up to {STD_BOTTLE_ML} ml bottles unless the ingredient is linked to a stock item with its own size. Ranges (e.g. 8–10 mint leaves) use the lower amount.
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------- recipe book

function RecipeBook({ recipes, loading, onEdit, onError }: { recipes: RecipeDto[]; loading: boolean; onEdit: (r: RecipeDto) => void; onError: (m: string | null) => void }) {
  const qc = useQueryClient();
  const [spirit, setSpirit] = useState("All");
  const [q, setQ] = useState("");
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/recipes/${id}`),
    onSuccess: () => {
      onError(null);
      return qc.invalidateQueries({ queryKey: ["recipes"] });
    },
    onError: (e: ApiError) => onError(e.message),
  });
  const spirits = ["All", ...new Set(recipes.map((r) => r.spirit || "Other"))];
  const term = q.trim().toLowerCase();
  const list = recipes
    .filter((r) => spirit === "All" || (r.spirit || "Other") === spirit)
    .filter((r) => !term || r.name.toLowerCase().includes(term) || r.items.some((i) => (i.ingredient || i.item?.name || "").toLowerCase().includes(term)));

  return (
    <div className="panel section-block">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <div className="panel-title" style={{ margin: 0 }}>
          Recipe book <span className="faint">· {recipes.length}</span>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <div className="chips">
            {spirits.map((s) => (
              <button key={s} className={`chipbtn ${spirit === s ? "on" : ""}`} onClick={() => setSpirit(s)}>
                {s}
                {s !== "All" && <span className="faint"> {recipes.filter((r) => (r.spirit || "Other") === s).length}</span>}
              </button>
            ))}
          </div>
          <input className="inp" style={{ width: 200 }} placeholder="Search cocktail or ingredient" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {loading && <div className="empty">Loading…</div>}
      {!loading && list.length === 0 && <div className="empty">{recipes.length ? "No recipe matches." : "No recipes yet — add one with + New recipe."}</div>}
      {list.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Cocktail</th>
                <th>Ingredients</th>
                <th>Method</th>
                <th>Glass</th>
                <th>Garnish</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const price = Number(r.price);
                return (
                  <tr key={r.id}>
                    <td style={{ minWidth: 140 }}>
                      <b style={{ fontWeight: 600 }}>{r.name}</b>
                      {r.spirit && (
                        <div>
                          <span className="pill gray">{r.spirit}</span>
                        </div>
                      )}
                      {price > 0 && (
                        <div className="small faint">
                          {fmtINR(price)}
                          {r.costing.allCostable && r.costing.totalCost !== null ? ` · cost ${fmtINR(r.costing.totalCost)}` : ""}
                        </div>
                      )}
                    </td>
                    <td className="small" style={{ minWidth: 220 }}>
                      {r.items.map((i) => (
                        <div key={i.id}>
                          • {lineLabel(i)}
                          {i.note && <span className="faint"> — {i.note}</span>}
                        </div>
                      ))}
                      {r.notes && <div className="small" style={{ color: "var(--amber, #b7791f)", marginTop: 4 }}>⚠ {r.notes}</div>}
                    </td>
                    <td className="small">{r.method ?? "—"}</td>
                    <td className="small">{r.glass}</td>
                    <td className="small">{r.garnish ?? "—"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button className="btn-ghost btn-sm" onClick={() => onEdit(r)}>
                        Edit
                      </button>{" "}
                      <button className="btn-ghost btn-sm" onClick={() => window.confirm(`Delete ${r.name}?`) && remove.mutate(r.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- editor

interface DraftLine {
  ingredient: string;
  qty: string;
  qtyMax: string;
  unit: string;
  note: string;
  skuId: string;
}
const blankLine = (): DraftLine => ({ ingredient: "", qty: "", qtyMax: "", unit: "ml", note: "", skuId: "" });

function RecipeEditor({
  recipe,
  skus,
  spirits,
  onDone,
  onCancel,
  onError,
}: {
  recipe: RecipeDto | null;
  skus: InventoryItemOptionDto[];
  spirits: string[];
  onDone: () => void;
  onCancel: () => void;
  onError: (e: ApiError) => void;
}) {
  const [f, setF] = useState({
    name: recipe?.name ?? "",
    spirit: recipe?.spirit ?? "",
    glass: recipe?.glass ?? "",
    method: recipe?.method ?? "",
    garnish: recipe?.garnish ?? "",
    notes: recipe?.notes ?? "",
    price: recipe && Number(recipe.price) > 0 ? String(Number(recipe.price)) : "",
    garnishCost: recipe && Number(recipe.garnishCost) > 0 ? String(Number(recipe.garnishCost)) : "",
  });
  const [lines, setLines] = useState<DraftLine[]>(
    recipe?.items.length
      ? recipe.items.map((i) => ({
          ingredient: i.ingredient || i.item?.name || "",
          qty: n(i.qty) === null ? "" : String(n(i.qty)),
          qtyMax: n(i.qtyMax) === null ? "" : String(n(i.qtyMax)),
          unit: i.unit || "ml",
          note: i.note ?? "",
          skuId: i.skuId ?? "",
        }))
      : [blankLine()],
  );
  const patch = (idx: number, p: Partial<DraftLine>) => setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...p } : l)));
  const usable = lines.filter((l) => l.ingredient.trim() || l.skuId);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: f.name.trim(),
        glass: f.glass.trim(),
        ...(f.spirit.trim() ? { spirit: f.spirit.trim() } : {}),
        ...(f.method.trim() ? { method: f.method.trim() } : {}),
        ...(f.garnish.trim() ? { garnish: f.garnish.trim() } : {}),
        ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
        price: Number(f.price) || 0,
        garnishCost: Number(f.garnishCost) || 0,
        items: usable.map((l) => ({
          ...(l.ingredient.trim() ? { ingredient: l.ingredient.trim() } : {}),
          ...(l.skuId ? { skuId: l.skuId } : {}),
          qty: l.unit === "as needed" || l.qty === "" ? null : Number(l.qty),
          qtyMax: l.qtyMax === "" ? null : Number(l.qtyMax),
          unit: l.unit || "ml",
          ...(l.note.trim() ? { note: l.note.trim() } : {}),
        })),
      };
      return recipe ? api.patch(`/recipes/${recipe.id}`, payload) : api.post("/recipes", payload);
    },
    onSuccess: onDone,
    onError: (e: ApiError) => onError(e),
  });
  const valid = f.name.trim() && f.glass.trim() && usable.length > 0;

  return (
    <div className="panel section-block">
      <div className="panel-title">{recipe ? `Edit ${recipe.name}` : "New recipe"}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12, marginBottom: 12 }}>
        <Field label="Cocktail">
          <input className="inp" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Negroni" />
        </Field>
        <Field label="Spirit">
          <input className="inp" list="spirit-list" value={f.spirit} onChange={(e) => setF({ ...f, spirit: e.target.value })} placeholder="Gin" />
          <datalist id="spirit-list">
            {spirits.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
        <Field label="Glass">
          <input className="inp" value={f.glass} onChange={(e) => setF({ ...f, glass: e.target.value })} placeholder="Rocks" />
        </Field>
        <Field label="Method">
          <input className="inp" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} placeholder="Stir" />
        </Field>
        <Field label="Garnish">
          <input className="inp" value={f.garnish} onChange={(e) => setF({ ...f, garnish: e.target.value })} placeholder="Orange peel" />
        </Field>
        <Field label="Menu price (INR, optional)">
          <input className="inp tright mono" type="number" min="0" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
        </Field>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Ingredient</th>
              <th className="tright" style={{ width: 80 }}>Qty</th>
              <th className="tright" style={{ width: 80 }}>Up to</th>
              <th style={{ width: 110 }}>Unit</th>
              <th>Stock item (optional)</th>
              <th>Note</th>
              <th style={{ width: 36 }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <input className="inp" style={{ width: "100%" }} value={l.ingredient} onChange={(e) => patch(i, { ingredient: e.target.value })} placeholder="Bourbon whiskey" />
                </td>
                <td>
                  <input className="inp tright" style={{ width: "100%" }} type="number" min="0" step="any" disabled={l.unit === "as needed"} value={l.qty} onChange={(e) => patch(i, { qty: e.target.value })} />
                </td>
                <td>
                  <input className="inp tright" style={{ width: "100%" }} type="number" min="0" step="any" disabled={l.unit === "as needed"} value={l.qtyMax} onChange={(e) => patch(i, { qtyMax: e.target.value })} placeholder="—" />
                </td>
                <td>
                  <select className="inp" style={{ width: "100%" }} value={UNITS.includes(l.unit) ? l.unit : "__other"} onChange={(e) => patch(i, { unit: e.target.value === "__other" ? l.unit : e.target.value })}>
                    {!UNITS.includes(l.unit) && <option value="__other">{l.unit}</option>}
                    {UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select className="inp" style={{ width: "100%" }} value={l.skuId} onChange={(e) => patch(i, { skuId: e.target.value })}>
                    <option value="">Not linked</option>
                    {skus.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.sizeMl ? ` (${s.sizeMl} ml)` : ""}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input className="inp" style={{ width: "100%" }} value={l.note} onChange={(e) => patch(i, { note: e.target.value })} />
                </td>
                <td>
                  {lines.length > 1 && (
                    <button className="btn-ghost btn-sm" onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}>
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={() => setLines((prev) => [...prev, blankLine()])}>
        + Add ingredient
      </button>

      <div style={{ marginTop: 12 }}>
        <Field label="Notes / to verify">
          <input className="inp" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
      <div className="small muted" style={{ marginTop: 8 }}>
        Linking an ingredient to a stock item lets Requirements check it against a city store and reserve it.
      </div>

      <div className="page-actions" style={{ marginTop: 14 }}>
        <button className="btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save recipe"}
        </button>
        <button className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
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

"use client";

import { fmtINR } from "@podium/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "../../components/AppShell";
import { Lightbox, Thumb } from "../../components/Lightbox";
import { api } from "../../lib/api";

interface ProductDto {
  id: string;
  sku: string | null;
  name: string;
  serviceLine: string | null;
  category: string | null;
  shortDesc: string | null;
  unit: string | null;
  price: string;
  pricingMode: "PER_QUANTITY" | "PER_GUEST" | "FIXED";
  gstRate: string | null;
  hsnSac: string | null;
  isActive: boolean;
  stockQty: string | null;
  vendorName: string | null;
  sourceFlag: string | null;
  /** Site-relative path to the product photo, or null where the shop's export had none. */
  imageUrl: string | null;
  brand: { code: string; name: string };
}

interface ProductPage {
  total: number;
  limit: number;
  offset: number;
  rows: ProductDto[];
}

interface BrandDto {
  id: string;
  code: string;
  name: string;
  tagline: string | null;
  productCount: number;
}

const PAGE = 50;

const PRICING_LABEL: Record<ProductDto["pricingMode"], string> = {
  PER_QUANTITY: "per unit",
  PER_GUEST: "per guest",
  FIXED: "fixed",
};

/**
 * The sellable catalogue across both trading brands — Elixir Coterie's
 * service-led menu and The Cocktail Shop's retail product list.
 *
 * Paginated rather than scrollable: the two catalogues together are ~1,900
 * rows, and a screen that renders all of them is a screen nobody can use.
 */
export default function ProductsPage() {
  const [brand, setBrand] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  /** The photo being viewed full size, if any. */
  const [viewing, setViewing] = useState<ProductDto | null>(null);

  const { data: brands } = useQuery({
    queryKey: ["product-brands"],
    queryFn: () => api.get<BrandDto[]>("/products/brands"),
  });

  const { data: categories } = useQuery({
    queryKey: ["product-categories", brand],
    queryFn: () => api.get<Array<{ category: string; count: number }>>(`/products/categories${brand ? `?brand=${brand}` : ""}`),
  });

  const { data, isLoading } = useQuery({
    queryKey: ["products", brand, category, search, offset],
    queryFn: () => {
      const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (brand) q.set("brand", brand);
      if (category) q.set("category", category);
      if (search) q.set("search", search);
      return api.get<ProductPage>(`/products?${q.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  function pickBrand(code: string | null) {
    setBrand(code);
    setCategory(null);
    setOffset(0);
  }

  const total = data?.total ?? 0;
  const shown = data?.rows.length ?? 0;

  return (
    <AppShell crumb="Products">
      <div className="page-head">
        <div>
          <div className="page-title">Products</div>
          <div className="page-sub">
            {total.toLocaleString("en-IN")} {brand ? brands?.find((b) => b.code === brand)?.name ?? "" : "catalogue"} item
            {total === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      <div className="toolbar">
        <div className="chips">
          <button type="button" className={`chipbtn${brand === null ? " on" : ""}`} onClick={() => pickBrand(null)}>
            All brands
          </button>
          {brands?.map((b) => (
            <button key={b.code} type="button" className={`chipbtn${brand === b.code ? " on" : ""}`} onClick={() => pickBrand(b.code)}>
              {b.name} ({b.productCount.toLocaleString("en-IN")})
            </button>
          ))}
        </div>
        <div className="field" style={{ maxWidth: 260 }}>
          <input
            value={search}
            placeholder="Search name or SKU…"
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
        </div>
      </div>

      {categories && categories.length > 0 && (
        <div className="chips" style={{ marginBottom: 12, flexWrap: "wrap" }}>
          <button type="button" className={`chipbtn${category === null ? " on" : ""}`} onClick={() => { setCategory(null); setOffset(0); }}>
            All categories
          </button>
          {categories.slice(0, 14).map((c) => (
            <button
              key={c.category}
              type="button"
              className={`chipbtn${category === c.category ? " on" : ""}`}
              onClick={() => {
                setCategory(c.category);
                setOffset(0);
              }}
            >
              {c.category} ({c.count})
            </button>
          ))}
        </div>
      )}

      {isLoading && <div className="empty">Loading…</div>}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th aria-label="Photo" style={{ width: 56 }} />
              <th>SKU</th>
              <th>Product</th>
              <th>Brand</th>
              <th>Category</th>
              <th className="tright">Price</th>
              <th>Unit</th>
              <th>HSN/SAC</th>
              <th className="tright">GST</th>
              <th>Supplier</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((p) => (
              <tr key={p.id} className="rowhover">
                <td>
                  <Thumb src={p.imageUrl} alt={p.name} onOpen={() => setViewing(p)} />
                </td>
                <td className="mono">{p.sku ?? "—"}</td>
                <td>
                  {p.name}
                  {p.shortDesc && (
                    <div style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{p.shortDesc}</div>
                  )}
                  {/* The source workbook flags its own bad rows — duplicate
                      codes, missing pricing. Surfacing that is more useful
                      than hiding it behind a clean-looking table. */}
                  {p.sourceFlag && (
                    <div style={{ fontSize: 10, color: "var(--warn, #b26b00)" }}>{p.sourceFlag}</div>
                  )}
                </td>
                <td>
                  <span className="pill blue">{p.brand.code}</span>
                </td>
                <td>{p.category ?? "—"}</td>
                <td className="tright mono">{fmtINR(Number(p.price))}</td>
                <td>
                  {p.unit ?? "—"}
                  <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{PRICING_LABEL[p.pricingMode]}</div>
                </td>
                <td className="mono">{p.hsnSac ?? "—"}</td>
                <td className="tright mono">{p.gstRate ? `${(Number(p.gstRate) * 100).toFixed(0)}%` : "—"}</td>
                <td>{p.vendorName ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!isLoading && shown === 0 && <div className="empty">No products match those filters.</div>}
      </div>

      {viewing?.imageUrl && (
        <Lightbox
          src={viewing.imageUrl}
          alt={viewing.name}
          caption={[viewing.sku, viewing.name].filter(Boolean).join(" · ")}
          onClose={() => setViewing(null)}
        />
      )}

      {total > PAGE && (
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button type="button" className="btn-ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            ← Previous
          </button>
          <span className="mono" style={{ fontSize: 12 }}>
            {shown === 0 ? 0 : offset + 1}–{offset + shown} of {total.toLocaleString("en-IN")}
          </span>
          <button type="button" className="btn-ghost" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            Next →
          </button>
        </div>
      )}
    </AppShell>
  );
}

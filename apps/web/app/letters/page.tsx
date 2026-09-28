"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { api, apiDownload, ApiError } from "../../lib/api";

type FieldType = "text" | "textarea" | "date" | "number" | "select" | "list" | "table";

interface LetterField {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  placeholder?: string;
  default?: string | number | string[];
  columns?: Array<{ name: string; label: string; placeholder?: string }>;
  hint?: string;
}

interface LetterDefinition {
  key: string;
  title: string;
  category: "HR" | "Client" | "Freelancer";
  description: string;
  fields: LetterField[];
}

type Row = Record<string, string>;
type Values = Record<string, string | string[] | Row[]>;

const CATEGORIES: Array<LetterDefinition["category"]> = ["HR", "Client", "Freelancer"];

/** Today as YYYY-MM-DD in the browser's own timezone (not UTC, which is a day behind before 05:30 IST). */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function initialValues(def: LetterDefinition): Values {
  const v: Values = {};
  for (const f of def.fields) {
    if (f.type === "list") v[f.name] = Array.isArray(f.default) ? [...f.default] : [""];
    else if (f.type === "table") v[f.name] = [Object.fromEntries((f.columns ?? []).map((c) => [c.name, ""]))];
    else if (f.default === "today") v[f.name] = today();
    else v[f.name] = f.default === undefined ? "" : String(f.default);
  }
  return v;
}

export default function LettersPage() {
  const { data: letters, isLoading, error: loadError } = useQuery({
    queryKey: ["letters"],
    queryFn: () => api.get<LetterDefinition[]>("/letters"),
  });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Other screens link straight to a document (People → "Onboard someone"
  // opens the Joining Letter). Read once on mount rather than via
  // useSearchParams, which would force a Suspense boundary on this page.
  useEffect(() => {
    const key = new URLSearchParams(window.location.search).get("key");
    if (key) setSelectedKey(key);
  }, []);
  const selected = useMemo(() => letters?.find((l) => l.key === selectedKey) ?? null, [letters, selectedKey]);

  return (
    <AppShell crumb="Letters & agreements">
      <div className="page-head">
        <div>
          <div className="page-title">Letters & agreements</div>
          <div className="page-sub">
            Pick a document, fill in only the details that change, and download it as a print-ready PDF on AMM&apos;s own
            letterhead and wording.
          </div>
        </div>
      </div>

      {isLoading && <div className="empty">Loading…</div>}
      {loadError && <div className="empty">{(loadError as ApiError).message}</div>}

      {letters && !selected && (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {CATEGORIES.map((cat) => {
            const items = letters.filter((l) => l.category === cat);
            if (!items.length) return null;
            return (
              <div key={cat}>
                <div className="panel-title" style={{ marginBottom: 8 }}>
                  {cat === "HR" ? "HR letters" : cat === "Client" ? "Client documents" : "Freelancer documents"}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(250px,1fr))", gap: 12 }}>
                  {items.map((l) => (
                    <button
                      key={l.key}
                      className="panel"
                      style={{ textAlign: "left", cursor: "pointer", margin: 0 }}
                      onClick={() => setSelectedKey(l.key)}
                    >
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>{l.title}</div>
                      <div className="small" style={{ color: "var(--text-dim)" }}>
                        {l.description}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selected && <LetterForm key={selected.key} def={selected} onBack={() => setSelectedKey(null)} />}
    </AppShell>
  );
}

function LetterForm({ def, onBack }: { def: LetterDefinition; onBack: () => void }) {
  const [values, setValues] = useState<Values>(() => initialValues(def));
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const set = (name: string, v: Values[string]) => setValues((prev) => ({ ...prev, [name]: v }));

  async function generate() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiDownload(`/letters/${def.key}/generate`, `${def.title}.pdf`, { values, saveToDocuments: save });
      setNotice(save ? "Downloaded — and a copy is saved in Documents." : "Downloaded.");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not generate the document.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <button className="btn-ghost btn-sm" onClick={onBack}>
          ← All documents
        </button>
        <div style={{ fontWeight: 600 }}>{def.title}</div>
      </div>

      {error && (
        <div className="panel" style={{ marginBottom: 14, borderColor: "var(--red)", color: "var(--red)" }}>
          <span className="small">{error}</span>
        </div>
      )}
      {notice && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <span className="small">{notice}</span>
        </div>
      )}

      <div className="panel">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 14 }}>
          {def.fields
            .filter((f) => f.type !== "list" && f.type !== "table")
            .map((f) => (
              <Field key={f.name} field={f}>
                <ScalarInput field={f} value={values[f.name] as string} onChange={(v) => set(f.name, v)} />
              </Field>
            ))}
        </div>

        {def.fields
          .filter((f) => f.type === "list")
          .map((f) => (
            <div key={f.name} style={{ marginTop: 18 }}>
              <Field field={f}>
                <ListInput field={f} value={values[f.name] as string[]} onChange={(v) => set(f.name, v)} />
              </Field>
            </div>
          ))}

        {def.fields
          .filter((f) => f.type === "table")
          .map((f) => (
            <div key={f.name} style={{ marginTop: 18 }}>
              <Field field={f}>
                <TableInput field={f} value={values[f.name] as Row[]} onChange={(v) => set(f.name, v)} />
              </Field>
            </div>
          ))}
      </div>

      <div className="page-actions" style={{ marginTop: 16, alignItems: "center" }}>
        <button className="btn-primary" disabled={busy} onClick={generate}>
          {busy ? "Generating…" : "Generate & download PDF"}
        </button>
        <label className="small" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
          Save a copy in Documents
        </label>
        <button
          className="btn-ghost"
          onClick={() => {
            setValues(initialValues(def));
            setNotice(null);
            setError(null);
          }}
        >
          Clear form
        </button>
      </div>
    </div>
  );
}

function Field({ field, children }: { field: LetterField; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span className="small" style={{ color: "var(--text-dim)", fontWeight: 500 }}>
        {field.label}
        {field.required ? " *" : ""}
      </span>
      {children}
      {field.hint && (
        <span className="small" style={{ color: "var(--text-faint)" }}>
          {field.hint}
        </span>
      )}
    </label>
  );
}

function ScalarInput({ field, value, onChange }: { field: LetterField; value: string; onChange: (v: string) => void }) {
  if (field.type === "textarea") {
    return <textarea className="inp" rows={3} value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
  if (field.type === "select") {
    return (
      <select className="inp" value={value} onChange={(e) => onChange(e.target.value)}>
        {(field.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      className="inp"
      type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}
      min={field.type === "number" ? 0 : undefined}
      value={value}
      placeholder={field.placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ListInput({ field, value, onChange }: { field: LetterField; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {value.map((item, i) => (
        <div key={i} style={{ display: "flex", gap: 6 }}>
          <input
            className="inp"
            style={{ flex: 1 }}
            value={item}
            placeholder={field.placeholder}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button type="button" className="btn-ghost btn-sm" aria-label="Remove item" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button type="button" className="btn-ghost btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => onChange([...value, ""])}>
        + Add item
      </button>
    </div>
  );
}

function TableInput({ field, value, onChange }: { field: LetterField; value: Row[]; onChange: (v: Row[]) => void }) {
  const cols = field.columns ?? [];
  const blank = () => Object.fromEntries(cols.map((c) => [c.name, ""]));
  return (
    <div>
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.name}>{c.label}</th>
            ))}
            <th style={{ width: 36 }} />
          </tr>
        </thead>
        <tbody>
          {value.map((row, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c.name}>
                  <input
                    className="inp"
                    style={{ width: "100%" }}
                    value={row[c.name] ?? ""}
                    placeholder={c.placeholder}
                    onChange={(e) => onChange(value.map((r, j) => (j === i ? { ...r, [c.name]: e.target.value } : r)))}
                  />
                </td>
              ))}
              <td>
                <button type="button" className="btn-ghost btn-sm" aria-label="Remove row" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => onChange([...value, blank()])}>
        + Add row
      </button>
    </div>
  );
}

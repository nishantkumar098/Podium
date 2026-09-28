"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";

export interface PaletteCommand {
  id: string;
  icon: string;
  label: string;
  group: "Go to" | "Create";
  run: () => void;
}

interface SearchHit {
  kind: string;
  id: string;
  title: string;
  sub: string;
  href: string;
}

const KIND_ICON: Record<string, string> = {
  project: "◧",
  client: "☺",
  lead: "◎",
  invoice: "₹",
  vendor: "⚙",
  stock: "▣",
  person: "☷",
  flow: "⇢",
  document: "▤",
};

const KIND_LABEL: Record<string, string> = {
  project: "Project",
  client: "Client",
  lead: "Lead",
  invoice: "Invoice",
  vendor: "Vendor",
  stock: "Stock",
  person: "Person",
  flow: "Flow",
  document: "Document",
};

/** Waits until typing pauses, so each keystroke doesn't cost a round trip. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * ⌘K: jump to any screen, start any create action, or find a record. Pages
 * and actions are matched instantly; records come from GET /search, which
 * only returns what this person is allowed to see.
 */
export function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const term = useDebounced(q.trim(), 250);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const { data: hits, isFetching } = useQuery({
    queryKey: ["search", term],
    queryFn: () => api.get<SearchHit[]>(`/search?q=${encodeURIComponent(term)}`),
    enabled: term.length >= 2,
    staleTime: 30_000,
  });

  const items = useMemo(() => {
    const n = q.trim().toLowerCase();
    const cmds = n ? commands.filter((c) => c.label.toLowerCase().includes(n)) : commands;
    const records = n.length >= 2 && term.length >= 2
      ? (hits ?? []).map((h) => ({
          id: `${h.kind}:${h.id}`,
          icon: KIND_ICON[h.kind] ?? "•",
          label: h.title,
          sub: h.sub,
          group: KIND_LABEL[h.kind] ?? h.kind,
          run: () => router.push(h.href),
        }))
      : [];
    return [...records, ...cmds.map((c) => ({ ...c, sub: "" as string }))];
  }, [q, term, hits, commands, router]);

  useEffect(() => {
    setSel(0);
  }, [q, hits]);
  useEffect(() => {
    listRef.current?.querySelector(".cmdk-item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (i: number) => {
    const item = items[i];
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <div className="overlay open" id="cmdk-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Search and commands">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="cmdk-input"
          placeholder="Type a command or search…"
          autoComplete="off"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(sel);
            }
          }}
        />
        <div className="cmdk-list" ref={listRef}>
          {items.length === 0 && (
            <div className="small muted" style={{ padding: "12px 11px" }}>
              {q.trim().length >= 2 && (isFetching || term !== q.trim()) ? "Searching…" : "No matches."}
            </div>
          )}
          {items.map((it, i) => (
            <div key={it.id} className={`cmdk-item ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => choose(i)}>
              <span className="ic">{it.icon}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div>{it.label}</div>
                {it.sub && <div className="sub">{it.sub}</div>}
              </div>
              <span className="grp">{it.group}</span>
            </div>
          ))}
          {q.trim().length >= 2 && isFetching && items.length > 0 && <div className="cmdk-head">Searching records…</div>}
        </div>
        <div className="cmdk-foot">
          <span>↑↓ to move</span>
          <span>↵ to open</span>
          <span>esc to close</span>
        </div>
      </div>
    </div>
  );
}

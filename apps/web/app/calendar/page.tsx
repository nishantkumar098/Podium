"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { api } from "../../lib/api";

interface Item {
  id: string;
  kind: "event" | "meeting" | "task" | "licence" | "invoice" | "leave";
  title: string;
  sub: string;
  start: string;
  end: string | null;
  allDay: boolean;
  href: string;
  late?: boolean;
}

const KINDS: Array<{ kind: Item["kind"]; label: string }> = [
  { kind: "event", label: "Events" },
  { kind: "meeting", label: "Meetings" },
  { kind: "task", label: "Task deadlines" },
  { kind: "licence", label: "Licence deadlines" },
  { kind: "invoice", label: "Invoices due" },
  { kind: "leave", label: "Leave" },
];

/** Calendar day key in India time — the day a record belongs to. */
function dayKey(d: Date): string {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export default function CalendarPage() {
  const router = useRouter();
  const today = new Date();
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>(dayKey(today));

  // Six-week grid starting on the Sunday on or before the 1st.
  const gridStart = addDays(month, -month.getDay());
  const gridEnd = addDays(gridStart, 42);
  const { data, isLoading, error } = useQuery({
    queryKey: ["calendar", gridStart.toISOString()],
    queryFn: () => api.get<Item[]>(`/calendar?from=${encodeURIComponent(gridStart.toISOString())}&to=${encodeURIComponent(gridEnd.toISOString())}`),
    staleTime: 60_000,
  });

  // Multi-day items (leave) appear on every day they cover.
  const byDay = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const it of data ?? []) {
      if (hidden.has(it.kind)) continue;
      const start = new Date(it.start);
      const last = it.end && it.allDay ? new Date(it.end) : start;
      for (let d = start, n = 0; dayKey(d) <= dayKey(last) && n < 62; d = addDays(d, 1), n++) {
        const k = dayKey(d);
        map.set(k, [...(map.get(k) ?? []), it]);
      }
    }
    return map;
  }, [data, hidden]);

  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const monthLabel = month.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  const inMonth = (data ?? []).filter((i) => new Date(i.start).getMonth() === month.getMonth() && !hidden.has(i.kind));
  const agenda = byDay.get(selected) ?? [];

  return (
    <AppShell crumb="Calendar">
      <div className="page-head">
        <div>
          <div className="page-title">Calendar</div>
          <div className="page-sub">
            {monthLabel} — event dates, deadlines, meetings &amp; leave · {inMonth.length} item{inMonth.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn-ghost" onClick={() => shift(-1)}>
            ‹ {new Date(month.getFullYear(), month.getMonth() - 1, 1).toLocaleDateString("en-IN", { month: "short" })}
          </button>
          <button
            className="btn-ghost"
            onClick={() => {
              setMonth(new Date(today.getFullYear(), today.getMonth(), 1));
              setSelected(dayKey(today));
            }}
          >
            Today
          </button>
          <button className="btn-ghost" onClick={() => shift(1)}>
            {new Date(month.getFullYear(), month.getMonth() + 1, 1).toLocaleDateString("en-IN", { month: "short" })} ›
          </button>
        </div>
      </div>

      <div className="chips" style={{ marginBottom: 12 }}>
        {KINDS.map((k) => (
          <button
            key={k.kind}
            className={`chipbtn ${hidden.has(k.kind) ? "" : "on"}`}
            onClick={() =>
              setHidden((h) => {
                const n = new Set(h);
                if (n.has(k.kind)) n.delete(k.kind);
                else n.add(k.kind);
                return n;
              })
            }
          >
            <span className={`cal-it ${k.kind}`} style={{ display: "inline-block", marginTop: 0, width: 10, height: 10, padding: 0, marginRight: 5, verticalAlign: "middle" }} />
            {k.label}
          </button>
        ))}
      </div>

      {error && <div className="notice red">{(error as Error).message}</div>}
      <div className="grid g-side-r">
        <div className="panel">
          <div className="cal-grid" style={{ fontSize: 10.5, textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 8 }}>
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
          <div className="cal-grid">
            {days.map((d) => {
              const k = dayKey(d);
              const items = byDay.get(k) ?? [];
              const isToday = k === dayKey(today);
              return (
                <div
                  key={k}
                  className={`cal-day ${d.getMonth() !== month.getMonth() ? "other" : ""} ${isToday ? "today" : ""}`}
                  style={{ outline: k === selected ? "2px solid var(--brass)" : undefined, cursor: "pointer" }}
                  onClick={() => setSelected(k)}
                >
                  <div className="dn">{d.getDate()}</div>
                  {items.slice(0, 3).map((it) => (
                    <span
                      key={it.id}
                      className={`cal-it ${it.kind} ${it.late ? "late" : ""}`}
                      title={`${it.title} — ${it.sub}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        router.push(it.href);
                      }}
                    >
                      {!it.allDay && `${new Date(it.start).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })} `}
                      {it.title}
                    </span>
                  ))}
                  {items.length > 3 && <span className="small muted">+{items.length - 3} more</span>}
                </div>
              );
            })}
          </div>
          {isLoading && <div className="small muted" style={{ marginTop: 8 }}>Loading…</div>}
        </div>

        <div className="panel">
          <div className="panel-title">{new Date(`${selected}T00:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}</div>
          {agenda.length === 0 && <div className="empty">Nothing on this day.</div>}
          {agenda.map((it) => (
            <div key={it.id} className="activity-item" style={{ cursor: "pointer" }} onClick={() => router.push(it.href)}>
              <span className={`cal-it ${it.kind}`} style={{ width: 8, height: 8, padding: 0, marginTop: 5, borderRadius: "50%", flexShrink: 0 }} />
              <div style={{ minWidth: 0 }}>
                <div>
                  {!it.allDay && <b className="mono">{new Date(it.start).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })} </b>}
                  {it.title} {it.late && <span className="pill red">Overdue</span>}
                </div>
                <div className="when">{it.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}

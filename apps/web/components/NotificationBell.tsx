"use client";

import { fmtDate } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { playSound } from "../lib/sounds";
import type { NotificationDto } from "../lib/types";

/**
 * Notifications bell (Phase G, blueprint §12). Every notification here was
 * created by some other module (flows, event day, automation rules,
 * chat @mentions, ...) — this component only reads and marks-read.
 */
export function NotificationBell() {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data: unread } = useQuery({
    queryKey: ["notifications-unread-count"],
    queryFn: () => api.get<{ count: number }>("/notifications/unread-count"),
    refetchInterval: 60_000,
  });
  const { data: notifications } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<NotificationDto[]>("/notifications"),
    enabled: open,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["notifications"] });
    qc.invalidateQueries({ queryKey: ["notifications-unread-count"] });
  };
  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: refresh,
    meta: { sound: "silent" },
  });
  const markAllRead = useMutation({
    mutationFn: () => api.post("/notifications/read-all"),
    onSuccess: refresh,
    meta: { sound: "silent" },
  });

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const handleClick = (n: NotificationDto) => {
    if (!n.readAt) markRead.mutate(n.id);
    if (n.sourceType === "project" && n.sourceId) {
      router.push(`/projects/${n.sourceId}`);
      setOpen(false);
    }
  };

  const count = unread?.count ?? 0;
  // A rise in unread count means something new arrived: chime, and pop the
  // badge. The first reading after load only sets the baseline.
  const lastCount = useRef<number | null>(null);
  const [popKey, setPopKey] = useState(0);
  useEffect(() => {
    if (unread === undefined) return;
    if (lastCount.current !== null && count > lastCount.current) {
      playSound("notify");
      setPopKey((k) => k + 1);
    }
    lastCount.current = count;
  }, [unread, count]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="topbar-avatar"
        style={{ position: "relative", fontSize: 15 }}
        title="Notifications"
        onClick={() => setOpen((o) => !o)}
      >
        <span key={`b${popKey}`} className={popKey ? "bell-ring" : undefined} style={{ display: "inline-block" }}>
          🔔
        </span>
        {count > 0 && (
          <span
            key={popKey}
            className="badge-pop"
            style={{
              position: "absolute", top: -2, right: -2, background: "var(--red)", color: "#fff",
              borderRadius: 999, fontSize: 9.5, fontWeight: 700, minWidth: 15, height: 15,
              display: "flex", alignItems: "center", justifyContent: "center", padding: "0 3px",
            }}
          >
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          className="panel notif-pop"
          style={{
            position: "absolute", top: "calc(100% + 8px)", right: 0, width: 360, maxHeight: 420,
            overflowY: "auto", zIndex: 50, boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div className="panel-title" style={{ marginBottom: 0 }}>Notifications</div>
            {count > 0 && (
              <button className="btn-ghost btn-sm" onClick={() => markAllRead.mutate()}>
                Mark all read
              </button>
            )}
          </div>
          {(notifications?.length ?? 0) === 0 && <div className="empty">No notifications.</div>}
          {notifications?.map((n) => (
            <div
              key={n.id}
              onClick={() => handleClick(n)}
              className="rowhover"
              style={{
                display: "flex", gap: 10, padding: "9px 4px", borderBottom: "1px solid var(--line)",
                cursor: "pointer", opacity: n.readAt ? 0.6 : 1,
              }}
            >
              <span style={{ fontSize: 14 }}>{n.icon ?? "•"}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.3, lineHeight: 1.4 }}>{n.text}</div>
                <div className="small mono" style={{ color: "var(--text-faint)", marginTop: 2 }}>{fmtDate(n.createdAt)}</div>
              </div>
              {!n.readAt && <span style={{ width: 7, height: 7, borderRadius: 999, background: "var(--blue)", marginTop: 5, flexShrink: 0 }} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

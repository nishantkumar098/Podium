"use client";

import { initials } from "@podium/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { api } from "../lib/api";
import type { CityOptionDto } from "../lib/types";

/** Initials avatar, as in the reference design (`av-s`). */
export function Avatar({ name, large }: { name: string; large?: boolean }) {
  return (
    <span className={`av-s${large ? " lg" : ""}`} title={name}>
      {initials(name)}
    </span>
  );
}

/** "All cities" + one chip per operating city. `null` means all. */
export function CityChips({ value, onChange }: { value: string | null; onChange: (cityId: string | null) => void }) {
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: () => api.get<CityOptionDto[]>("/cities") });
  return (
    <div className="chips">
      <button className={`chipbtn ${value === null ? "on" : ""}`} onClick={() => onChange(null)}>
        All cities
      </button>
      {cities?.map((c) => (
        <button key={c.id} className={`chipbtn ${value === c.id ? "on" : ""}`} onClick={() => onChange(c.id)}>
          {c.name}
        </button>
      ))}
    </div>
  );
}

/** Title-cases an API enum for display: "NOT_APPLIED" -> "Not applied". */
export function label(value: string): string {
  const s = value.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(20,18,14,.38)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16 }}
    >
      <div className="panel" onClick={(e) => e.stopPropagation()} style={{ width: "min(460px, 100%)", margin: 0 }}>
        <div className="panel-title">{title}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>{footer}</div>
      </div>
    </div>
  );
}

export function FormField({ label: text, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span className="small muted" style={{ fontWeight: 500 }}>
        {text}
      </span>
      {children}
    </label>
  );
}

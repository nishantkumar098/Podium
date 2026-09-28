"use client";

import { fmtINR, initials } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { FormField, Modal } from "../../components/GovernanceUi";
import { PersonSelect, title, useDirectory } from "../../components/OpsUi";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import type { CityOptionDto, LeadDto, LeadListResponse, LeadStage } from "../../lib/types";

const STAGES: LeadStage[] = ["LEAD", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "WON", "LOST"];
const OPEN: LeadStage[] = ["LEAD", "QUALIFIED", "PROPOSAL", "NEGOTIATION"];

const value = (l: LeadDto) => (l.value !== null ? Number(l.value) : 0);

/**
 * CRM / Pipeline: every real PIPELINE opportunity as a board by stage.
 * Cards drag between stages; Won is reached through conversion (it needs the
 * project details the automation can't infer), so dropping on Won opens it.
 */
export default function PipelinePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["leads", "pipeline-board"],
    queryFn: () => api.get<LeadListResponse>("/leads?kind=PIPELINE&limit=500"),
  });
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: () => api.get<CityOptionDto[]>("/cities") });
  const { data: people } = useDirectory();
  const [q, setQ] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<LeadStage | null>(null);
  const [moved, setMoved] = useState<Record<string, LeadStage>>({});
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const move = useMutation({
    mutationFn: (v: { id: string; stage: LeadStage }) => api.patch(`/leads/${v.id}/stage`, { stage: v.stage }),
    onSuccess: () => setError(null),
    onError: (e: ApiError) => setError(e.message),
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: ["leads"] });
      setMoved({});
    },
  });

  const cityName = (id: string | null) => cities?.find((c) => c.id === id)?.name ?? "No city";
  const ownerName = (id: string | null) => people?.find((p) => p.id === id)?.name ?? null;
  const stageOf = (l: LeadDto) => moved[l.id] ?? l.stage;

  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (data?.rows ?? []).filter((l) => !n || `${l.name} ${l.company ?? ""} ${l.contactName ?? ""}`.toLowerCase().includes(n));
  }, [data, q]);
  const open = rows.filter((l) => OPEN.includes(stageOf(l)));

  const drop = (stage: LeadStage) => {
    setOver(null);
    const lead = rows.find((l) => l.id === dragId);
    setDragId(null);
    if (!lead || stageOf(lead) === stage) return;
    if (stage === "WON") {
      router.push(`/leads/${lead.id}`); // conversion lives on the lead page
      return;
    }
    setMoved((m) => ({ ...m, [lead.id]: stage }));
    move.mutate({ id: lead.id, stage });
  };

  return (
    <AppShell crumb="CRM / Pipeline">
      <div className="page-head">
        <div>
          <div className="page-title">CRM / Sales Pipeline</div>
          <div className="page-sub">
            {rows.length.toLocaleString("en-IN")} deals · {fmtINR(open.reduce((s, l) => s + value(l), 0))} open pipeline
            {open.some((l) => l.value === null) ? ` · ${open.filter((l) => l.value === null).length} not yet valued` : ""}
          </div>
        </div>
        <div className="page-actions">
          <input className="inp" placeholder="Search deals" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 200 }} />
          <button className="btn-ghost" onClick={() => router.push("/leads")}>
            List view
          </button>
          <button className="btn-primary" onClick={() => setCreating(true)}>
            + New Lead
          </button>
        </div>
      </div>
      {error && <div className="notice red" style={{ marginBottom: 10 }}>{error}</div>}
      {isLoading && <div className="empty">Loading…</div>}
      {!isLoading && (
        <div className="kanban">
          {STAGES.map((stage) => {
            const items = rows.filter((l) => stageOf(l) === stage);
            return (
              <div
                key={stage}
                className={`kcol ${over === stage ? "dragover" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(stage);
                }}
                onDragLeave={() => setOver((o) => (o === stage ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(stage);
                }}
              >
                <div className="kcol-head">
                  <span>{title(stage)}</span>
                  <span className="n">{items.length}</span>
                </div>
                <div className="small mono" style={{ color: "var(--text-faint)", margin: "-4px 5px 8px" }}>
                  {fmtINR(items.reduce((s, l) => s + value(l), 0))}
                </div>
                {items.slice(0, 150).map((l) => {
                  const owner = ownerName(l.ownerId);
                  return (
                    <div
                      key={l.id}
                      className={`kcard ${dragId === l.id ? "dragging" : ""}`}
                      draggable={stage !== "WON"}
                      onDragStart={() => setDragId(l.id)}
                      onDragEnd={() => setDragId(null)}
                      onClick={() => router.push(`/leads/${l.id}`)}
                      style={{ cursor: "pointer" }}
                    >
                      <div className="t">{l.name}</div>
                      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 6 }}>
                        {cityName(l.cityId)}
                        {l.eventType ? ` · ${l.eventType}` : ""}
                      </div>
                      <div className="foot">
                        <span className="mono" style={{ fontWeight: 600 }}>
                          {l.value !== null ? fmtINR(Number(l.value)) : <span className="faint">Not valued</span>}
                        </span>
                        {owner && (
                          <div className="who" title={owner}>
                            {initials(owner)}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {items.length > 150 && <div className="small muted" style={{ padding: 6 }}>+{items.length - 150} more — search or use list view</div>}
              </div>
            );
          })}
        </div>
      )}
      {creating && <NewLead onClose={() => setCreating(false)} />}
    </AppShell>
  );
}

function NewLead({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: people } = useDirectory();
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: () => api.get<CityOptionDto[]>("/cities") });
  const [f, setF] = useState({ name: "", value: "", cityId: "", ownerId: user?.id ?? "" });
  const save = useMutation({
    mutationFn: () => api.post("/leads", { name: f.name.trim(), value: Number(f.value || 0), cityId: f.cityId, ownerId: f.ownerId }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["leads"] });
      onClose();
    },
  });
  const ok = f.name.trim() && f.cityId && f.ownerId;
  return (
    <Modal
      title="New lead"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!ok || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Add lead"}
          </button>
        </>
      }
    >
      <FormField label="Deal name">
        <input className="inp" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Sharma wedding — Taj Lake Palace" />
      </FormField>
      <div className="grid g2" style={{ gap: 10 }}>
        <FormField label="Estimated value (₹)">
          <input className="inp" type="number" min={0} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
        </FormField>
        <FormField label="City">
          <select className="inp" value={f.cityId} onChange={(e) => setF({ ...f, cityId: e.target.value })}>
            <option value="">Choose a city</option>
            {cities?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <FormField label="Owner">
        <PersonSelect value={f.ownerId} onChange={(v) => setF({ ...f, ownerId: v })} people={people} />
      </FormField>
      <div className="small muted">Contact details, event date and notes can be added on the lead&apos;s page after saving.</div>
      {save.error && <div className="notice red">{(save.error as Error).message}</div>}
    </Modal>
  );
}

"use client";

import { fmtDate, fmtINR } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { AppShell } from "../../../components/AppShell";
import { StatusPill } from "../../../components/StatusPill";
import { api, ApiError } from "../../../lib/api";
import type { CityOptionDto, LeadDto, LeadStage, PlaybookDto, UserSummaryDto } from "../../../lib/types";

const STAGES: LeadStage[] = ["LEAD", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "LOST"];

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);

  const { data: lead, isLoading } = useQuery({ queryKey: ["lead", id], queryFn: () => api.get<LeadDto>(`/leads/${id}`) });
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: () => api.get<CityOptionDto[]>("/cities") });
  // Only Founder/Admin/Operations can reach GET /users (people:view) — every
  // other role sees a 403 here, which is fine: they can view a lead's owner
  // as a raw id, and only Founder/Admin ever reach the convert form anyway.
  const { data: users } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<UserSummaryDto[]>("/users"),
    retry: false,
    throwOnError: false,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["lead", id] });
    qc.invalidateQueries({ queryKey: ["leads"] });
  };

  const changeStage = useMutation({
    mutationFn: (stage: LeadStage) => api.patch(`/leads/${id}/stage`, { stage }),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e: ApiError) => setError(e.message),
  });

  if (isLoading || !lead) {
    return (
      <AppShell crumb="Leads">
        <div className="empty">Loading…</div>
      </AppShell>
    );
  }

  const ownerName = users?.find((u) => u.id === lead.ownerId)?.name ?? (lead.ownerId ? lead.ownerId : "Unassigned");
  const cityName = cities?.find((c) => c.id === lead.cityId)?.name ?? (lead.cityId ? "—" : "No city assigned");
  const isTerminal = lead.stage === "WON";

  return (
    <AppShell crumb={`Leads / ${lead.name}`}>
      <div className="page-head">
        <div>
          <div className="page-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {lead.name}
            <StatusPill status={lead.stage} />
          </div>
          <div className="page-sub">
            {lead.company ?? "No company on file"} · {cityName} · owner {ownerName}
          </div>
        </div>
        {!isTerminal && (
          <div className="page-actions">
            <select
              className="inp"
              value=""
              disabled={changeStage.isPending}
              onChange={(e) => e.target.value && changeStage.mutate(e.target.value as LeadStage)}
            >
              <option value="">Change stage…</option>
              {STAGES.filter((s) => s !== lead.stage).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button className="btn-primary" onClick={() => setConverting(true)}>Convert — mark Won</button>
          </div>
        )}
      </div>

      {error && (
        <div className="panel" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
          <span className="small">{error}</span>
          <button className="btn-ghost btn-sm" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      {notice && (
        <div className="panel" style={{ marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
          <span className="small">{notice}</span>
          <button className="btn-ghost btn-sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {isTerminal && lead.convertedProjectId && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <span className="small">
            Converted — <a onClick={() => router.push(`/projects/${lead.convertedProjectId}`)} style={{ cursor: "pointer", color: "var(--blue, #3b82f6)" }}>open the project</a>
          </span>
        </div>
      )}

      {converting && (
        <ConvertPanel
          lead={lead}
          cities={cities ?? []}
          users={users ?? []}
          onDone={() => { setConverting(false); setError(null); setNotice("Lead converted — project created."); refresh(); }}
          onCancel={() => setConverting(false)}
          onError={(e) => setError(e.message)}
        />
      )}

      <div className="grid rs-stack" style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14, alignItems: "start" }}>
        <div className="panel">
          <div className="panel-title">Contact</div>
          <Row label="Contact name" value={lead.contactName ?? "—"} />
          <Row label="Phone" value={lead.phone ?? "—"} />
          <Row label="Email" value={lead.email ?? "—"} />
          <Row label="Designation" value={lead.designation ?? "—"} />
          <Row label="Address" value={lead.address ?? "—"} />
        </div>
        <div className="panel">
          <div className="panel-title">Deal</div>
          <Row label="Value" value={lead.value !== null ? fmtINR(Number(lead.value)) : "Unestimated"} />
          <Row label="Event type" value={lead.eventType ?? "—"} />
          <Row label="Pax" value={lead.pax !== null ? String(lead.pax) : "—"} />
          <Row label="Event date" value={lead.eventDate ? fmtDate(lead.eventDate) : lead.eventDateText ?? "—"} />
          <Row label="Source" value={lead.source ?? "—"} />
        </div>
      </div>

      {lead.remarks && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="panel-title">Remarks</div>
          <div className="small">{lead.remarks}</div>
        </div>
      )}
    </AppShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 12.3 }}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

function ConvertPanel({
  lead,
  cities,
  users,
  onDone,
  onCancel,
  onError,
}: {
  lead: LeadDto;
  cities: CityOptionDto[];
  users: UserSummaryDto[];
  onDone: () => void;
  onCancel: () => void;
  onError: (e: ApiError) => void;
}) {
  const [clientMode, setClientMode] = useState<"existing" | "new">("new");
  const [clientSearch, setClientSearch] = useState("");
  const [selectedClient, setSelectedClient] = useState<{ id: string; name: string } | null>(null);
  const [clientName, setClientName] = useState("");
  const [clientType, setClientType] = useState<"INDIVIDUAL" | "CORPORATE" | "BRAND">("CORPORATE");
  const [projectName, setProjectName] = useState(lead.name);
  const [projectType, setProjectType] = useState(lead.eventType ?? "");
  const [eventDate, setEventDate] = useState(lead.eventDate ? lead.eventDate.slice(0, 10) : "");
  const [pmId, setPmId] = useState("");
  const [playbookId, setPlaybookId] = useState("");
  const [cityId, setCityId] = useState(lead.cityId ?? "");
  const [value, setValue] = useState(lead.value !== null ? String(Number(lead.value)) : "");

  const { data: clientMatches } = useQuery({
    queryKey: ["client-search", clientSearch],
    queryFn: () => api.get<{ rows: Array<{ id: string; name: string }> }>(`/clients?search=${encodeURIComponent(clientSearch)}&limit=8`),
    enabled: clientMode === "existing" && clientSearch.length >= 2,
  });
  const { data: playbooks } = useQuery({ queryKey: ["playbooks"], queryFn: () => api.get<PlaybookDto[]>("/playbooks") });

  const convert = useMutation({
    mutationFn: () =>
      api.post(`/leads/${lead.id}/convert`, {
        ...(clientMode === "existing" ? { clientId: selectedClient!.id } : { clientName: clientName.trim(), clientType }),
        projectName: projectName.trim(),
        projectType: projectType.trim(),
        eventDate,
        pmId,
        ...(playbookId ? { playbookId } : {}),
        ...(lead.cityId ? {} : { cityId }),
        ...(lead.value !== null ? {} : { value: Number(value) }),
      }),
    onSuccess: onDone,
    onError,
  });

  const validClient = clientMode === "existing" ? !!selectedClient : clientName.trim().length > 0;
  const valid =
    validClient &&
    projectName.trim().length > 0 &&
    projectType.trim().length > 0 &&
    !!eventDate &&
    !!pmId &&
    (lead.cityId || cityId) &&
    (lead.value !== null || Number(value) >= 0);

  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-title">Convert to Won — create the project</div>
      <div className="small" style={{ color: "var(--text-faint)", marginBottom: 12 }}>
        Deal-Won automation (au1) creates the client (if new), the project, and its chat channel atomically. Choosing a
        playbook applies its default tasks and flows to the new project, all owned by the PM below.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14, marginBottom: 14 }}>
        <Field label="Client">
          <div className="chips" style={{ marginBottom: 6 }}>
            <button type="button" className={`chipbtn${clientMode === "new" ? " on" : ""}`} onClick={() => setClientMode("new")}>New</button>
            <button type="button" className={`chipbtn${clientMode === "existing" ? " on" : ""}`} onClick={() => setClientMode("existing")}>Existing</button>
          </div>
          {clientMode === "new" ? (
            <input className="inp" value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Client name" />
          ) : selectedClient ? (
            <div className="small">
              {selectedClient.name} <button className="btn-ghost btn-sm" onClick={() => setSelectedClient(null)}>×</button>
            </div>
          ) : (
            <div>
              <input className="inp" value={clientSearch} onChange={(e) => setClientSearch(e.target.value)} placeholder="Search clients…" />
              {clientMatches && clientMatches.rows.length > 0 && (
                <div className="panel" style={{ marginTop: 6, padding: 6 }}>
                  {clientMatches.rows.map((c) => (
                    <div key={c.id} className="small rowhover" style={{ padding: 4, cursor: "pointer" }} onClick={() => setSelectedClient(c)}>
                      {c.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Field>
        {clientMode === "new" && (
          <Field label="Client type">
            <select className="inp" value={clientType} onChange={(e) => setClientType(e.target.value as typeof clientType)}>
              <option value="CORPORATE">Corporate</option>
              <option value="INDIVIDUAL">Individual</option>
              <option value="BRAND">Brand</option>
            </select>
          </Field>
        )}
        <Field label="Project name">
          <input className="inp" value={projectName} onChange={(e) => setProjectName(e.target.value)} />
        </Field>
        <Field label="Project type">
          <input className="inp" value={projectType} onChange={(e) => setProjectType(e.target.value)} placeholder="Wedding, Corporate…" />
        </Field>
        <Field label="Event date">
          <input className="inp" type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
        </Field>
        <Field label="Project Manager">
          <select className="inp" value={pmId} onChange={(e) => setPmId(e.target.value)}>
            <option value="">Select a PM…</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.roles.join(", ")})</option>)}
          </select>
        </Field>
        <Field label="Playbook (optional)">
          <select className="inp" value={playbookId} onChange={(e) => setPlaybookId(e.target.value)}>
            <option value="">No playbook</option>
            {playbooks?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        {!lead.cityId && (
          <Field label="City (this lead has none)">
            <select className="inp" value={cityId} onChange={(e) => setCityId(e.target.value)}>
              <option value="">Select a city…</option>
              {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        )}
        {lead.value === null && (
          <Field label="Value (this lead has none)">
            <input className="inp tright mono" type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
        )}
      </div>

      <div className="page-actions">
        <button className="btn-primary" disabled={!valid || convert.isPending} onClick={() => convert.mutate()}>
          {convert.isPending ? "Converting…" : "Convert to project"}
        </button>
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
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

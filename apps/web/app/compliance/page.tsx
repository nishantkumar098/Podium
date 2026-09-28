"use client";

import { daysTo, fmtDate } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { Avatar, CityChips, FormField, label, Modal } from "../../components/GovernanceUi";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import type { CityOptionDto } from "../../lib/types";

interface LicenceDto {
  id: string;
  type: string;
  authority: string;
  status: "NOT_APPLIED" | "APPLIED" | "APPROVED" | "REJECTED";
  refNo: string | null;
  dueDate: string;
  city: { id: string; name: string };
  project: { id: string; name: string } | null;
  owner: { id: string; name: string };
}

/** Same thresholds as the reference: red inside a week, amber inside three. */
function alertColour(l: LicenceDto): "green" | "red" | "amber" | "gray" {
  if (l.status === "APPROVED") return "green";
  if (l.status === "REJECTED") return "red";
  const d = daysTo(l.dueDate);
  return d <= 7 ? "red" : d <= 21 ? "amber" : "gray";
}

export default function CompliancePage() {
  const qc = useQueryClient();
  const [city, setCity] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [applying, setApplying] = useState<LicenceDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ["licences"], queryFn: () => api.get<LicenceDto[]>("/licences") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["licences"] });
  const advance = useMutation({
    mutationFn: ({ id, status, refNo }: { id: string; status: string; refNo?: string }) =>
      api.post(`/licences/${id}/advance`, { status, ...(refNo ? { refNo } : {}) }),
    onSuccess: () => {
      setApplying(null);
      refresh();
    },
    onError: (e: ApiError) => setError(e.message),
  });

  const list = useMemo(() => (data ?? []).filter((l) => !city || l.city.id === city), [data, city]);
  const red = list.filter((l) => l.status !== "APPROVED" && alertColour(l) === "red");

  return (
    <AppShell crumb="Compliance">
      <div className="page-head">
        <div>
          <div className="page-title">Compliance &amp; licences</div>
          <div className="page-sub">Liquor licences, police and fire permits, music licences — tracked against every event date</div>
        </div>
        <div className="page-actions">
          <button className="btn-primary" onClick={() => setAdding(true)}>
            + Add permit
          </button>
        </div>
      </div>

      <div className="toolbar">
        <CityChips value={city} onChange={setCity} />
      </div>

      {error && <div className="notice red section-block">{error}</div>}
      {red.length > 0 && (
        <div className="notice red section-block">
          <b>
            {red.length} permit{red.length > 1 ? "s" : ""} due within 7 days and not approved.
          </b>{" "}
          No bar opens without its licence on display — escalate today.
        </div>
      )}

      {isLoading && <div className="empty">Loading…</div>}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Permit</th>
              <th>Event</th>
              <th>Authority</th>
              <th>Reference</th>
              <th>Needed by</th>
              <th>Owner</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data && list.length === 0 && (
              <tr>
                <td colSpan={8} className="empty">
                  No permits tracked{city ? " in this city" : ""} yet. Add each licence an event needs — liquor, fire, police, music — with the date
                  it is needed by.
                </td>
              </tr>
            )}
            {list.map((l) => {
              const colour = alertColour(l);
              const d = daysTo(l.dueDate);
              return (
                <tr key={l.id}>
                  <td>
                    <b style={{ fontWeight: 500 }}>{l.type}</b>
                    <div className="small faint">{l.city.name}</div>
                  </td>
                  <td className="small">{l.project?.name ?? "Company-wide"}</td>
                  <td className="small">{l.authority}</td>
                  <td className="mono small">{l.refNo || "—"}</td>
                  <td className="mono small">
                    {fmtDate(l.dueDate)}
                    <div className={colour === "red" ? "negative" : "faint"}>
                      {l.status === "APPROVED" ? "" : d < 0 ? `${-d} days overdue` : `${d} days`}
                    </div>
                  </td>
                  <td>
                    <Avatar name={l.owner.name} />
                  </td>
                  <td>
                    <span className={`pill ${colour}`}>{label(l.status)}</span>
                  </td>
                  <td>
                    {l.status === "NOT_APPLIED" && (
                      <button className="btn-ghost btn-sm" onClick={() => setApplying(l)}>
                        Mark applied
                      </button>
                    )}
                    {l.status === "APPLIED" && (
                      <button className="btn-ghost btn-sm" onClick={() => advance.mutate({ id: l.id, status: "APPROVED" })}>
                        Mark approved
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {applying && (
        <ApplyModal
          licence={applying}
          busy={advance.isPending}
          onClose={() => setApplying(null)}
          onSubmit={(refNo) => advance.mutate({ id: applying.id, status: "APPLIED", refNo })}
        />
      )}
      {adding && <AddPermitModal onClose={() => setAdding(false)} onDone={refresh} />}
    </AppShell>
  );
}

function ApplyModal({ licence, busy, onClose, onSubmit }: { licence: LicenceDto; busy: boolean; onClose: () => void; onSubmit: (refNo: string) => void }) {
  const [refNo, setRefNo] = useState(licence.refNo ?? "");
  return (
    <Modal
      title={`Mark applied — ${licence.type}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={busy} onClick={() => onSubmit(refNo.trim())}>
            {busy ? "Saving…" : "Mark applied"}
          </button>
        </>
      }
    >
      <FormField label="Application reference (optional)">
        <input className="inp" value={refNo} onChange={(e) => setRefNo(e.target.value)} placeholder="As printed on the acknowledgement" />
      </FormField>
    </Modal>
  );
}

interface ProjectOption {
  id: string;
  name: string;
  city: { id: string } | null;
  status: string;
}

function AddPermitModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { user } = useAuth();
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: () => api.get<CityOptionDto[]>("/cities") });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectOption[]>("/projects") });
  // Owner picker needs people:view; without it the permit is owned by whoever adds it.
  const { data: users } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<Array<{ id: string; name: string }>>("/users"),
    retry: false,
  });

  const [type, setType] = useState("");
  const [authority, setAuthority] = useState("");
  const [cityId, setCityId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [ownerId, setOwnerId] = useState(user?.id ?? "");
  const [error, setError] = useState<string | null>(null);

  const cityProjects = (projects ?? []).filter((p) => (!cityId || p.city?.id === cityId) && p.status !== "COMPLETED");
  const save = useMutation({
    mutationFn: () =>
      api.post("/licences", {
        type: type.trim(),
        authority: authority.trim(),
        cityId,
        dueDate,
        ownerId,
        ...(projectId ? { projectId } : {}),
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (e: ApiError) => setError(e.message),
  });
  const valid = type.trim() && authority.trim() && cityId && dueDate && ownerId;

  return (
    <Modal
      title="Add a permit"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Add permit"}
          </button>
        </>
      }
    >
      {error && <div className="notice red">{error}</div>}
      <FormField label="Permit">
        <input className="inp" value={type} onChange={(e) => setType(e.target.value)} placeholder="e.g. Occasional liquor licence (one-day)" />
      </FormField>
      <FormField label="Issuing authority">
        <input className="inp" value={authority} onChange={(e) => setAuthority(e.target.value)} placeholder="e.g. Excise Department, Delhi" />
      </FormField>
      <div className="row">
        <FormField label="City">
          <select className="inp" value={cityId} onChange={(e) => { setCityId(e.target.value); setProjectId(""); }}>
            <option value="">Choose…</option>
            {cities?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Needed by">
          <input className="inp" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </FormField>
      </div>
      <FormField label="Event">
        <select className="inp" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">Company-wide (not tied to one event)</option>
          {cityProjects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label="Owner">
        <select className="inp" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
          {(users ?? (user ? [{ id: user.id, name: user.name }] : [])).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </FormField>
    </Modal>
  );
}

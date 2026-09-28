"use client";

import { daysTo, fmtDate, fmtINR } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { Avatar, CityChips, FormField, label, Modal } from "../../components/GovernanceUi";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";

type Attendance = "PRESENT" | "ON_SITE" | "REMOTE" | "ON_LEAVE";

interface PeopleDto {
  today: string;
  canApproveLeave: boolean;
  canEdit: boolean;
  staff: Array<{ id: string; name: string; role: string | null; dept: string | null; city: { id: string; name: string } | null; status: Attendance | null }>;
  leaves: Array<{ id: string; user: { id: string; name: string }; type: string; status: string; fromDate: string; toDate: string; note: string | null }>;
  freelancers: Array<{
    id: string;
    name: string;
    category: string | null;
    phone: string | null;
    city: { id: string; name: string } | null;
    certExpiresAt: string | null;
    dayRate: number | null;
    eventsCount: number;
    rating: number | null;
    isAvailable: boolean;
  }>;
}

interface ProjectOption {
  id: string;
  name: string;
  eventDate: string | null;
  status: string;
}

const ATTENDANCE: Record<Attendance, { label: string; pill: string }> = {
  PRESENT: { label: "Present", pill: "green" },
  ON_SITE: { label: "On site", pill: "blue" },
  REMOTE: { label: "Remote", pill: "gray" },
  ON_LEAVE: { label: "On leave", pill: "red" },
};
const LEAVE_PILL: Record<string, string> = { PENDING: "amber", APPROVED: "green", REJECTED: "red" };

export default function PeoplePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [city, setCity] = useState<string | null>(null);
  const [crewKind, setCrewKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [booking, setBooking] = useState<PeopleDto["freelancers"][number] | null>(null);

  const { data, isLoading, error: loadError } = useQuery({ queryKey: ["people"], queryFn: () => api.get<PeopleDto>("/people") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["people"] });
  const onError = (e: ApiError) => setError(e.message);

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Attendance }) => api.put(`/people/attendance/${id}`, { status }),
    onSuccess: refresh,
    onError,
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "APPROVED" | "REJECTED" }) => api.post(`/people/leaves/${id}/decide`, { decision }),
    onSuccess: refresh,
    onError,
  });
  const release = useMutation({
    mutationFn: (id: string) => api.post(`/people/freelancers/${id}/availability`, { available: true }),
    onSuccess: refresh,
    onError,
  });

  const staff = useMemo(() => (data?.staff ?? []).filter((s) => !city || s.city?.id === city), [data, city]);
  const crewKinds = useMemo(
    () => [...new Set((data?.freelancers ?? []).map((f) => f.category).filter((c): c is string => !!c))].sort(),
    [data],
  );
  const pool = useMemo(
    () => (data?.freelancers ?? []).filter((f) => (!city || f.city?.id === city) && (!crewKind || f.category === crewKind)),
    [data, city, crewKind],
  );
  const count = (s: Attendance) => staff.filter((p) => p.status === s).length;
  const notMarked = staff.filter((p) => p.status === null).length;

  return (
    <AppShell crumb="People">
      <div className="page-head">
        <div>
          <div className="page-title">People</div>
          <div className="page-sub">Who’s in today, leave requests, and the freelance crew pool across cities</div>
        </div>
        <div className="page-actions">
          <button className="btn-ghost" onClick={() => router.push("/letters?key=joining-letter")}>
            Onboard someone
          </button>
        </div>
      </div>

      <div className="toolbar">
        <CityChips value={city} onChange={setCity} />
      </div>

      {error && (
        <div className="notice red section-block">
          {error}{" "}
          <button className="btn-ghost btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {isLoading && <div className="empty">Loading…</div>}
      {loadError && <div className="empty">{(loadError as ApiError).message}</div>}

      {data && (
        <>
          <div className="grid g4 section-block">
            <div className="stat" style={{ borderLeftColor: "var(--green)" }}>
              <div className="k">Present</div>
              <div className="v">{count("PRESENT")}</div>
              <div className="d">in office</div>
            </div>
            <div className="stat" style={{ borderLeftColor: "var(--blue)" }}>
              <div className="k">On site</div>
              <div className="v">{count("ON_SITE")}</div>
              <div className="d">at events or venues</div>
            </div>
            <div className="stat">
              <div className="k">Remote</div>
              <div className="v">{count("REMOTE")}</div>
              {notMarked > 0 && <div className="d">{notMarked} not marked yet today</div>}
            </div>
            <div className="stat" style={{ borderLeftColor: "var(--red)" }}>
              <div className="k">On leave</div>
              <div className="v">{count("ON_LEAVE")}</div>
            </div>
          </div>

          <div className="grid g2e section-block">
            <div className="panel">
              <div className="panel-title">Today</div>
              {staff.length === 0 ? (
                <div className="empty">No staff in this city.</div>
              ) : (
                <table>
                  <tbody>
                    {staff.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <Avatar name={p.name} large /> &nbsp;{p.name}
                          <div className="small faint">{[p.role, p.dept].filter(Boolean).join(" · ")}</div>
                        </td>
                        <td className="small">{p.city?.name ?? "—"}</td>
                        <td>
                          {data.canEdit ? (
                            <select
                              className={`pill ${p.status ? ATTENDANCE[p.status].pill : "gray"}`}
                              style={{ border: "none", cursor: "pointer" }}
                              value={p.status ?? ""}
                              aria-label={`Status for ${p.name}`}
                              onChange={(e) => e.target.value && setStatus.mutate({ id: p.id, status: e.target.value as Attendance })}
                            >
                              {!p.status && <option value="">Not marked</option>}
                              {(Object.keys(ATTENDANCE) as Attendance[]).map((s) => (
                                <option key={s} value={s}>
                                  {ATTENDANCE[s].label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className={`pill ${p.status ? ATTENDANCE[p.status].pill : "gray"}`}>{p.status ? ATTENDANCE[p.status].label : "Not marked"}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="panel">
              <div className="panel-title">
                Leave requests
                {data.canEdit && (
                  <button className="btn-ghost btn-sm" onClick={() => setLeaveOpen(true)}>
                    + Log leave
                  </button>
                )}
              </div>
              {data.leaves.length === 0 && <div className="empty">No leave requests yet.</div>}
              {data.leaves.map((l) => (
                <div key={l.id} style={{ padding: "8px 0", borderBottom: "1px solid #F1EEE5", fontSize: 12 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span>
                      <Avatar name={l.user.name} /> <b style={{ fontWeight: 500 }}>{l.user.name}</b> · {label(l.type)}
                    </span>
                    <span className={`pill ${LEAVE_PILL[l.status] ?? "gray"}`}>{label(l.status)}</span>
                  </div>
                  <div className="small muted" style={{ marginTop: 3 }}>
                    {fmtDate(l.fromDate)} → {fmtDate(l.toDate)}
                    {l.note ? ` · ${l.note}` : ""}
                  </div>
                  {l.status === "PENDING" && data.canApproveLeave && l.user.id !== user?.id && (
                    <div className="row" style={{ marginTop: 6 }}>
                      <button className="btn-ok btn-sm" onClick={() => decide.mutate({ id: l.id, decision: "APPROVED" })}>
                        Approve
                      </button>
                      <button className="btn-ghost btn-sm" onClick={() => decide.mutate({ id: l.id, decision: "REJECTED" })}>
                        Decline
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {!data.canApproveLeave && (
                <div className="small muted" style={{ marginTop: 8 }}>
                  Only the Founder, Admin and Operations can approve leave.
                </div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">
              Freelance crew pool
              <span className="small muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>
                {pool.filter((f) => f.isAvailable).length} available of {pool.length}
              </span>
            </div>
            {crewKinds.length > 1 && (
              <div className="toolbar">
                <div className="chips">
                  <button className={`chipbtn ${crewKind === null ? "on" : ""}`} onClick={() => setCrewKind(null)}>
                    All crew
                  </button>
                  {crewKinds.map((k) => (
                    <button key={k} className={`chipbtn ${crewKind === k ? "on" : ""}`} onClick={() => setCrewKind(k)}>
                      {label(k)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {pool.length === 0 ? (
              <div className="empty">
                {city && !(data.freelancers ?? []).some((f) => f.city)
                  ? "No city is recorded for any freelancer yet — choose All cities to see the whole pool."
                  : "No freelancers match this filter."}
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>City</th>
                    <th>IBG certificate</th>
                    <th className="num">Day rate</th>
                    <th className="num">Events</th>
                    <th className="num">Rating</th>
                    <th>Availability</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pool.map((f) => {
                    const d = f.certExpiresAt ? daysTo(f.certExpiresAt) : null;
                    return (
                      <tr key={f.id}>
                        <td>
                          {f.name}
                          <div className="small faint">{[f.category && label(f.category), f.phone].filter(Boolean).join(" · ")}</div>
                        </td>
                        <td>{f.city?.name ?? "—"}</td>
                        <td className={`mono small ${d !== null && d < 60 ? "negative" : ""}`}>
                          {f.certExpiresAt ? fmtDate(f.certExpiresAt) : "—"}
                          {d !== null && d < 60 && <div>{d < 0 ? "expired" : `expires in ${d}d`}</div>}
                        </td>
                        <td className="num">{f.dayRate !== null ? fmtINR(f.dayRate) : "—"}</td>
                        <td className="num">{f.eventsCount}</td>
                        <td className="num">{f.rating !== null ? `★ ${f.rating}` : "—"}</td>
                        <td>
                          <span className={`pill ${f.isAvailable ? "green" : "amber"}`}>{f.isAvailable ? "Available" : "Booked"}</span>
                        </td>
                        <td>
                          {data.canEdit &&
                            (f.isAvailable ? (
                              <button className="btn-ghost btn-sm" onClick={() => setBooking(f)}>
                                Book
                              </button>
                            ) : (
                              <button className="btn-ghost btn-sm" onClick={() => release.mutate(f.id)}>
                                Release
                              </button>
                            ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {leaveOpen && <LeaveModal staff={data.staff} onClose={() => setLeaveOpen(false)} onDone={refresh} />}
          {booking && <BookModal freelancer={booking} onClose={() => setBooking(null)} onDone={refresh} />}
        </>
      )}
    </AppShell>
  );
}

function LeaveModal({ staff, onClose, onDone }: { staff: PeopleDto["staff"]; onClose: () => void; onDone: () => void }) {
  const [userId, setUserId] = useState(staff[0]?.id ?? "");
  const [type, setType] = useState("CASUAL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.post("/people/leaves", { userId, type, fromDate: from, toDate: to, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (e: ApiError) => setError(e.message),
  });
  return (
    <Modal
      title="Log a leave request"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!userId || !from || !to || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Log leave"}
          </button>
        </>
      }
    >
      {error && <div className="notice red">{error}</div>}
      <FormField label="Person">
        <select className="inp" value={userId} onChange={(e) => setUserId(e.target.value)}>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label="Type">
        <select className="inp" value={type} onChange={(e) => setType(e.target.value)}>
          {["CASUAL", "EARNED", "SICK", "OTHER"].map((t) => (
            <option key={t} value={t}>
              {label(t)}
            </option>
          ))}
        </select>
      </FormField>
      <div className="row">
        <FormField label="From">
          <input className="inp" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField label="To">
          <input className="inp" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </FormField>
      </div>
      <FormField label="Note (optional)">
        <input className="inp" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Family function" />
      </FormField>
    </Modal>
  );
}

function BookModal({ freelancer, onClose, onDone }: { freelancer: PeopleDto["freelancers"][number]; onClose: () => void; onDone: () => void }) {
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectOption[]>("/projects") });
  const upcoming = useMemo(
    () =>
      (projects ?? [])
        .filter((p) => p.status !== "COMPLETED" && p.status !== "CANCELLED")
        .sort((a, b) => (a.eventDate ?? "").localeCompare(b.eventDate ?? "")),
    [projects],
  );
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const book = useMutation({
    mutationFn: () => api.post(`/people/freelancers/${freelancer.id}/availability`, { available: false, projectId }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (e: ApiError) => setError(e.message),
  });
  return (
    <Modal
      title={`Book ${freelancer.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!projectId || book.isPending} onClick={() => book.mutate()}>
            {book.isPending ? "Booking…" : "Book"}
          </button>
        </>
      }
    >
      {error && <div className="notice red">{error}</div>}
      <FormField label="Event">
        <select className="inp" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">Choose an event…</option>
          {upcoming.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.eventDate ? ` · ${fmtDate(p.eventDate)}` : ""}
            </option>
          ))}
        </select>
      </FormField>
      <div className="small muted">
        {[freelancer.category && label(freelancer.category), freelancer.dayRate !== null && `${fmtINR(freelancer.dayRate)} per day`].filter(Boolean).join(" · ") ||
          "No day rate recorded yet."}
      </div>
    </Modal>
  );
}

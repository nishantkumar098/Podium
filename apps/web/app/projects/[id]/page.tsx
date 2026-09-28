"use client";

import { daysTo, fmtDate, fmtINR } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { AppShell } from "../../../components/AppShell";
import { CrewPanel } from "../../../components/CrewPanel";
import { BudgetPanel } from "../../../components/BudgetPanel";
import { DocumentsPanel } from "../../../components/DocumentsPanel";
import { EventDayPanel } from "../../../components/EventDayPanel";
import { FlowCanvas } from "../../../components/FlowCanvas";
import { Avatar } from "../../../components/GovernanceUi";
import {
  HealthDot,
  NewRiskModal,
  NewTaskModal,
  Pill,
  PersonSelect,
  StageStrip,
  TaskKanban,
  stageFor,
  title,
  useDirectory,
  type OpsTask,
} from "../../../components/OpsUi";
import { api } from "../../../lib/api";

interface Named {
  id: string;
  name: string;
}

interface ProjectDetail {
  id: string;
  name: string;
  type: string;
  status: string;
  health: string;
  revenue: string;
  estCost: string;
  actCost: string;
  paid: number;
  eventDate: string;
  eventDateText: string | null;
  city: { name: string };
  client: { id: string; name: string; type: string; phone: string | null; email: string | null; address: string | null; gstin: string | null; ltv: string; segment: string };
  pm: Named & { dept: string | null };
  members: Array<{ roleOnProject: string; user: Named & { dept: string | null; primaryRole: { name: string } | null } }>;
  vendors: Array<{ vendor: { id: string; name: string; category: string | null; status: string; rating: string | null; phone: string | null } }>;
  tasks: OpsTask[];
  risks: Array<{ id: string; title: string; severity: string; status: string; impact: string | null; owner: Named }>;
  approvals: Array<{ id: string; title: string; type: string; status: string; approverRef: string; requesterName: string | null; createdAt: string }>;
  meetings: Array<{ id: string; title: string; startsAt: string; durationMinutes: number; meetLink: string | null; notes: string | null; _count: { actionItems: number } }>;
  activity: Array<{ id: string; who: string; action: string; entityType: string; after: Record<string, unknown> | null; at: string }>;
  flowInstances: Array<{ id: string; name: string; status: string; steps: Array<{ id: string; key: string; name: string; status: string; ownerId: string; role: string }> }>;
}

const TABS = ["overview", "tasks", "timeline", "budget", "team", "crew", "vendors", "client", "documents", "approvals", "risks", "meetings", "flows", "event day", "activity"] as const;
type Tab = (typeof TABS)[number];

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const initial = (search.get("tab") as Tab) ?? "overview";
  const [tab, setTab] = useState<Tab>(TABS.includes(initial) ? initial : "overview");
  const { data: p, isLoading, error } = useQuery({
    queryKey: ["project", params.id],
    queryFn: () => api.get<ProjectDetail>(`/projects/${params.id}`),
  });

  if (error) {
    return (
      <AppShell crumb="Projects">
        <div className="empty">{(error as Error).message}</div>
      </AppShell>
    );
  }
  if (isLoading || !p) {
    return (
      <AppShell crumb="Projects">
        <div className="empty">Loading…</div>
      </AppShell>
    );
  }

  const d = daysTo(p.eventDate);
  const revenue = Number(p.revenue);
  const actCost = Number(p.actCost);

  return (
    <AppShell crumb={`Projects / ${p.name}`}>
      <div className="proj-header">
        <div>
          <h1>{p.name}</h1>
          <div className="proj-meta-row">
            <Meta label="Client" value={p.client.name} />
            <Meta label="Event Date" value={`${p.eventDateText || fmtDate(p.eventDate)} (${d}d)`} />
            <Meta label="City" value={p.city.name} />
            <Meta label="Project Manager" value={p.pm.name} />
            <Meta
              label="Health"
              value={
                <>
                  <HealthDot health={p.health} /> {p.health}
                </>
              }
            />
            <Meta label="Budget" value={Number(p.estCost) > 0 ? fmtINR(Number(p.estCost)) : "—"} />
            <Meta label="Revenue" value={revenue > 0 ? fmtINR(revenue) : "—"} />
            <Meta label="Profit" value={revenue > 0 ? fmtINR(revenue - actCost) : "—"} />
            <Meta label="Status" value={<StatusEditor project={p} />} />
          </div>
        </div>
        <button className="btn-ghost" onClick={() => router.push("/projects")}>
          ← All Projects
        </button>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview p={p} onTab={setTab} />}
      {tab === "tasks" && <TasksTab p={p} />}
      {tab === "timeline" && <TimelineTab p={p} />}
      {tab === "budget" && <BudgetPanel projectId={p.id} />}
      {tab === "team" && <TeamTab p={p} />}
      {/* The freelance crew, asked per event — see CrewPanel. Separate from
          "team", which is AMM's own staff on the project. */}
      {tab === "crew" && <CrewPanel projectId={p.id} />}
      {tab === "vendors" && <VendorsTab p={p} />}
      {tab === "client" && <ClientTab p={p} />}
      {tab === "documents" && <DocumentsPanel projectId={p.id} />}
      {tab === "approvals" && <ApprovalsTab p={p} />}
      {tab === "risks" && <RisksTab p={p} />}
      {tab === "meetings" && <MeetingsTab p={p} />}
      {tab === "flows" && (
        <div>
          {p.flowInstances.length === 0 && <div className="panel"><div className="empty">No flows launched on this project yet — start one from Flows.</div></div>}
          {p.flowInstances.map((f) => (
            <div key={f.id} className="panel" style={{ marginBottom: 14 }}>
              <div className="panel-title">
                {f.name} <Pill value={f.status} />
              </div>
              <FlowCanvas steps={f.steps} />
            </div>
          ))}
        </div>
      )}
      {tab === "event day" && <EventDayPanel projectId={p.id} people={crew(p)} />}
      {tab === "activity" && <ActivityTab p={p} />}
    </AppShell>
  );
}

function crew(p: ProjectDetail): Named[] {
  return [p.pm, ...p.members.map((m) => m.user)].filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i).map((x) => ({ id: x.id, name: x.name }));
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="item">
      {label}
      <b>{value}</b>
    </div>
  );
}

const STATUSES = ["PLANNING", "PLANNED", "IN_PROGRESS", "CLIENT_REVIEW", "ON_HOLD", "COMPLETED", "CANCELLED"];

function StatusEditor({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (status: string) => api.patch(`/projects/${project.id}`, { status }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ["project", project.id] }), qc.invalidateQueries({ queryKey: ["projects"] })]),
  });
  return (
    <select
      className="inp btn-sm"
      style={{ padding: "2px 6px", fontWeight: 600 }}
      value={project.status}
      disabled={save.isPending}
      onChange={(e) => save.mutate(e.target.value)}
      title={save.error ? (save.error as Error).message : "Change status"}
    >
      {STATUSES.map((s) => (
        <option key={s} value={s}>
          {title(s)}
        </option>
      ))}
    </select>
  );
}

// ------------------------------------------------------------------ overview

function Overview({ p, onTab }: { p: ProjectDetail; onTab: (t: Tab) => void }) {
  const done = p.tasks.filter((t) => t.status === "COMPLETED").length;
  const openRisks = p.risks.filter((r) => r.status !== "CLOSED").length;
  const pendingApprovals = p.approvals.filter((a) => a.status === "PENDING").length;
  const revenue = Number(p.revenue);
  const checklist = p.tasks.filter((t) => t.status !== "COMPLETED").slice(0, 6);
  return (
    <>
      <div className="grid g4 section-block">
        <div className="stat">
          <div className="k">Progress</div>
          <div className="v">{p.tasks.length ? `${Math.round((done / p.tasks.length) * 100)}%` : "—"}</div>
          <div className="d">
            {done}/{p.tasks.length} tasks done
          </div>
        </div>
        <div className="stat">
          <div className="k">Paid vs Revenue</div>
          <div className="v">{fmtINR(p.paid)}</div>
          <div className="d">of {revenue > 0 ? fmtINR(revenue) : "— (no revenue set)"}</div>
        </div>
        <div className="stat">
          <div className="k">Cost Spent</div>
          <div className="v">{fmtINR(Number(p.actCost))}</div>
          <div className="d">budget {Number(p.estCost) > 0 ? fmtINR(Number(p.estCost)) : "—"}</div>
        </div>
        <div className="stat">
          <div className="k">Open Risks</div>
          <div className="v">{openRisks}</div>
          <div className="d">{pendingApprovals} approvals pending</div>
        </div>
      </div>
      <div className="grid g2">
        <div className="panel">
          <div className="panel-title">
            Checklist — Current Stage <span className="pill amber">{stageFor(p.eventDate)}</span>
          </div>
          {checklist.length === 0 && (
            <div className="empty">
              {p.tasks.length ? "Every task is done." : "No tasks yet."}{" "}
              <button className="btn-ghost btn-sm" onClick={() => onTab("tasks")}>
                Open tasks
              </button>
            </div>
          )}
          {checklist.map((t) => (
            <div key={t.id} className="checkitem">
              <input type="checkbox" disabled />
              <span style={{ flex: 1 }}>{t.name}</span>
              <span className="small faint">{t.owner.name}</span>
            </div>
          ))}
        </div>
        <div className="panel">
          <div className="panel-title">Team &amp; Vendors</div>
          <div style={{ marginBottom: 10 }}>
            <b style={{ fontSize: 11.5 }}>Team</b>
            <div style={{ marginTop: 6 }}>
              <span className="badge-vendor" style={{ margin: "2px 4px 2px 0" }}>
                {p.pm.name} · Project Manager
              </span>
              {p.members
                .filter((m) => m.user.id !== p.pm.id)
                .map((m) => (
                  <span key={m.user.id} className="badge-vendor" style={{ margin: "2px 4px 2px 0" }}>
                    {m.user.name} · {m.user.primaryRole?.name ?? title(m.roleOnProject)}
                  </span>
                ))}
            </div>
          </div>
          <div>
            <b style={{ fontSize: 11.5 }}>Vendors</b>
            <div style={{ marginTop: 6 }}>
              {p.vendors.length === 0 && <span className="small muted">None assigned yet.</span>}
              {p.vendors.map((v) => (
                <span key={v.vendor.id} className="badge-vendor" style={{ margin: "2px 4px 2px 0" }}>
                  {v.vendor.name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ tabs

function TasksTab({ p }: { p: ProjectDetail }) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button className="btn-primary" onClick={() => setAdding(true)}>
          + Task
        </button>
      </div>
      {p.tasks.length === 0 && <div className="small muted" style={{ marginBottom: 8 }}>No tasks yet. Add one, then drag cards between columns as work moves.</div>}
      <TaskKanban tasks={p.tasks} queryKeys={[["project", p.id], ["tasks"]]} />
      {adding && <NewTaskModal projectId={p.id} onClose={() => setAdding(false)} />}
    </>
  );
}

function TimelineTab({ p }: { p: ProjectDetail }) {
  const d = daysTo(p.eventDate);
  return (
    <div className="panel">
      <div className="panel-title">
        {d > 0 ? `${d} days to the event` : d === 0 ? "Event day" : `${-d} days since the event`} · {fmtDate(p.eventDate)}
      </div>
      <StageStrip current={stageFor(p.eventDate)} />
    </div>
  );
}

function TeamTab({ p }: { p: ProjectDetail }) {
  const qc = useQueryClient();
  const { data: people } = useDirectory();
  const [userId, setUserId] = useState("");
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["project", p.id] }), qc.invalidateQueries({ queryKey: ["projects"] }), qc.invalidateQueries({ queryKey: ["resources"] })]);
  const add = useMutation({ mutationFn: () => api.post(`/projects/${p.id}/members`, { userId, roleOnProject: "TEAM_MEMBER" }), onSuccess: () => { setUserId(""); return refresh(); } });
  const remove = useMutation({ mutationFn: (uid: string) => api.delete(`/projects/${p.id}/members/${uid}`), onSuccess: refresh });
  const onTeam = new Set([p.pm.id, ...p.members.map((m) => m.user.id)]);
  return (
    <div className="panel">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Department</th>
            <th>On this project</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <Avatar name={p.pm.name} /> {p.pm.name}
            </td>
            <td>{people?.find((x) => x.id === p.pm.id)?.role ?? "—"}</td>
            <td>{p.pm.dept ?? "—"}</td>
            <td>
              <span className="pill blue">Project Manager</span>
            </td>
            <td />
          </tr>
          {p.members
            .filter((m) => m.user.id !== p.pm.id)
            .map((m) => (
              <tr key={m.user.id}>
                <td>
                  <Avatar name={m.user.name} /> {m.user.name}
                </td>
                <td>{m.user.primaryRole?.name ?? "—"}</td>
                <td>{m.user.dept ?? "—"}</td>
                <td>
                  <span className="pill gray">{title(m.roleOnProject)}</span>
                </td>
                <td className="tright">
                  <button className="btn-ghost btn-sm" disabled={remove.isPending} onClick={() => remove.mutate(m.user.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <PersonSelect value={userId} onChange={setUserId} people={people?.filter((x) => !onTeam.has(x.id))} placeholder="Add someone to the crew" />
        <button className="btn-primary btn-sm" disabled={!userId || add.isPending} onClick={() => add.mutate()}>
          Add
        </button>
      </div>
      {(add.error || remove.error) && <div className="notice red" style={{ marginTop: 8 }}>{((add.error || remove.error) as Error).message}</div>}
    </div>
  );
}

function VendorsTab({ p }: { p: ProjectDetail }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const { data: vendors } = useQuery({
    queryKey: ["vendors"],
    queryFn: () => api.get<Array<{ id: string; name: string; category: string | null; city?: { name: string } | null }>>("/vendors"),
    enabled: q.trim().length >= 2,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["project", p.id] });
  const add = useMutation({ mutationFn: (vendorId: string) => api.post(`/projects/${p.id}/vendors`, { vendorId }), onSuccess: () => { setQ(""); return refresh(); } });
  const remove = useMutation({ mutationFn: (vendorId: string) => api.delete(`/projects/${p.id}/vendors/${vendorId}`), onSuccess: refresh });
  const assigned = new Set(p.vendors.map((v) => v.vendor.id));
  const matches = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (n.length < 2) return [];
    return (vendors ?? []).filter((v) => !assigned.has(v.id) && `${v.name} ${v.category ?? ""}`.toLowerCase().includes(n)).slice(0, 8);
  }, [q, vendors, assigned]);
  return (
    <div className="panel">
      <table>
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Category</th>
            <th>Status</th>
            <th>Phone</th>
            <th>Rating</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {p.vendors.length === 0 && (
            <tr>
              <td colSpan={6} className="empty">
                No vendors assigned yet.
              </td>
            </tr>
          )}
          {p.vendors.map(({ vendor: v }) => (
            <tr key={v.id} className="rowhover">
              <td>{v.name}</td>
              <td>{v.category ?? "—"}</td>
              <td>
                <span className={`pill ${v.status === "PREFERRED" ? "green" : "blue"}`}>{title(v.status)}</span>
              </td>
              <td className="mono">{v.phone ?? "—"}</td>
              <td className="mono">{v.rating ? `★ ${Number(v.rating).toFixed(1)}` : "—"}</td>
              <td className="tright">
                <button className="btn-ghost btn-sm" onClick={() => remove.mutate(v.id)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 12 }}>
        <input className="inp" style={{ width: "100%", maxWidth: 360 }} placeholder="Add a vendor — type 2+ letters of name or category" value={q} onChange={(e) => setQ(e.target.value)} />
        {matches.map((v) => (
          <div key={v.id} className="row" style={{ padding: "6px 0", borderBottom: "1px solid #F1EEE5", justifyContent: "space-between", maxWidth: 520 }}>
            <span>
              {v.name} <span className="small muted">{v.category ?? ""}</span>
            </span>
            <button className="btn-primary btn-sm" disabled={add.isPending} onClick={() => add.mutate(v.id)}>
              Add
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ClientTab({ p }: { p: ProjectDetail }) {
  const c = p.client;
  const field = (k: string, v: React.ReactNode) => (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{k}</div>
      <div style={{ fontWeight: 600 }}>{v || "—"}</div>
    </div>
  );
  return (
    <div className="panel">
      <div className="panel-title">
        Client Profile{" "}
        <Link className="btn-ghost btn-sm" href="/clients">
          All clients →
        </Link>
      </div>
      <div className="grid g4" style={{ rowGap: 14 }}>
        {field("Name", c.name)}
        {field("Type", title(c.type))}
        {field("Phone", c.phone)}
        {field("Email", c.email)}
        {field("Lifetime Value", Number(c.ltv) > 0 ? fmtINR(Number(c.ltv)) : null)}
        {field("GSTIN", c.gstin)}
        {field("Address", c.address)}
      </div>
    </div>
  );
}

function ApprovalsTab({ p }: { p: ProjectDetail }) {
  return (
    <div className="panel">
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Type</th>
            <th>Requester</th>
            <th>Approver</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {p.approvals.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                No approvals on this project. Raise one from <Link href="/approvals">Approvals</Link>.
              </td>
            </tr>
          )}
          {p.approvals.map((a) => (
            <tr key={a.id}>
              <td>{a.title}</td>
              <td>
                <span className="pill gray">{title(a.type)}</span>
              </td>
              <td>{a.requesterName ?? "—"}</td>
              <td>{a.approverRef}</td>
              <td>
                <Pill value={a.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RisksTab({ p }: { p: ProjectDetail }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="panel">
      <div className="panel-title">
        Risks{" "}
        <button className="btn-primary btn-sm" onClick={() => setAdding(true)}>
          + Risk
        </button>
      </div>
      {p.risks.length === 0 && <div className="empty">No open risks</div>}
      {p.risks.map((r) => (
        <div key={r.id} style={{ padding: "10px 0", borderBottom: "1px solid #F1EEE5" }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <b>{r.title}</b>
            <Pill value={r.severity} />
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 3 }}>
            Owner: {r.owner.name}
            {r.impact ? ` · Impact: ${r.impact}` : ""} · <Pill value={r.status} />
          </div>
        </div>
      ))}
      {adding && <NewRiskModal projectId={p.id} onClose={() => setAdding(false)} />}
    </div>
  );
}

function MeetingsTab({ p }: { p: ProjectDetail }) {
  return (
    <div className="panel">
      {p.meetings.length === 0 && <div className="empty">No meetings logged</div>}
      {p.meetings.map((m) => (
        <div key={m.id} style={{ padding: "10px 0", borderBottom: "1px solid #F1EEE5" }}>
          <b>{m.title}</b>
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 3 }}>
            {new Date(m.startsAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} · {m.durationMinutes} min · {m._count.actionItems} action items
            {m.meetLink && (
              <>
                {" · "}
                <a href={m.meetLink} target="_blank" rel="noreferrer">
                  Join
                </a>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ActivityTab({ p }: { p: ProjectDetail }) {
  return (
    <div className="panel">
      {p.activity.length === 0 && <div className="empty">Nothing recorded on this project yet.</div>}
      {p.activity.map((a) => (
        <div key={a.id} className="activity-item">
          <div className="dot2" />
          <div>
            <div>
              <b>{a.who}</b> {describe(a, p)}
            </div>
            <div className="when">{new Date(a.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** A readable line from an audit entry, using only what the entry recorded. */
function describe(a: ProjectDetail["activity"][number], p: ProjectDetail): string {
  const x = a.after ?? {};
  const s = (k: string) => (typeof x[k] === "string" ? (x[k] as string) : "");
  const person = (id: string) => [p.pm, ...p.members.map((m) => m.user)].find((u) => u.id === id)?.name;
  switch (a.action) {
    case "project.create":
      return "created the project";
    case "project.update":
      return s("status") ? `updated the project (status ${title(s("status"))})` : "updated the project";
    case "project.member_added":
      return `added ${person(s("userId")) ?? "someone"} to the crew`;
    case "project.member_removed":
      return "removed someone from the crew";
    case "project.vendor_added":
      return `assigned ${p.vendors.find((v) => v.vendor.id === s("vendorId"))?.vendor.name ?? "a vendor"}`;
    case "project.vendor_removed":
      return "removed a vendor";
    case "task.create":
      return `added task “${s("name")}”`;
    case "task.update":
      return `updated task “${s("name")}”${s("status") ? ` → ${title(s("status"))}` : ""}`;
    case "risk.create":
      return `raised risk “${s("title")}”`;
    case "risk.update":
      return `updated risk “${s("title")}”${s("status") ? ` → ${title(s("status"))}` : ""}`;
    case "approval.create":
      return `requested approval “${s("title")}”`;
    case "event_day.checkin":
      return `checked in ${person(s("userId")) ?? "a crew member"}`;
    case "event_day.incident_logged":
      return `logged a ${title(s("severity"))} incident`;
    case "runsheet.create":
      return "created the run-of-show";
    default:
      return a.action.replace(/[._]/g, " ");
  }
}

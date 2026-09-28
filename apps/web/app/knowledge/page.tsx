"use client";

import { fmtDate } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { FormField, Modal } from "../../components/GovernanceUi";
import { PersonSelect, useDirectory } from "../../components/OpsUi";
import { api } from "../../lib/api";

interface SopVersion {
  id: string;
  versionNo: number;
  body: string;
  stepsCount: number;
  createdAt: string;
}

interface Sop {
  id: string;
  title: string;
  department: string;
  ownerId: string | null;
  owner: { id: string; name: string } | null;
  updatedAt: string;
  current: { versionNo: number; stepsCount: number; body: string; createdAt: string } | null;
}

interface Playbook {
  id: string;
  name: string;
  eventType: string;
}

/**
 * Knowledge / SOPs. Each save writes a new numbered version rather than
 * overwriting, so it stays answerable which procedure was in force when an
 * event ran.
 */
export default function KnowledgePage() {
  const qc = useQueryClient();
  const { data: sops, isLoading } = useQuery({ queryKey: ["sops"], queryFn: () => api.get<Sop[]>("/sops") });
  const { data: playbooks } = useQuery({ queryKey: ["playbooks"], queryFn: () => api.get<Playbook[]>("/playbooks"), retry: false });
  const { data: shell } = useQuery({ queryKey: ["shell"], queryFn: () => api.get<{ permissions: string[] }>("/users/me/shell"), staleTime: 30 * 60_000 });
  const canWrite = !!shell?.permissions.some((p) => p === "playbooks:create" || p === "playbooks:edit");

  const [dept, setDept] = useState("All");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Sop | null>(null);
  const [editing, setEditing] = useState<Sop | "new" | null>(null);

  const departments = useMemo(() => [...new Set((sops ?? []).map((s) => s.department))].sort(), [sops]);
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (sops ?? []).filter((s) => (dept === "All" || s.department === dept) && (!n || `${s.title} ${s.department}`.toLowerCase().includes(n)));
  }, [sops, dept, q]);

  const archive = useMutation({
    mutationFn: (id: string) => api.delete(`/sops/${id}`),
    onSuccess: () => {
      setOpen(null);
      return qc.invalidateQueries({ queryKey: ["sops"] });
    },
  });

  return (
    <AppShell crumb="Knowledge / SOPs">
      <div className="page-head">
        <div>
          <div className="page-title">Knowledge / SOPs</div>
          <div className="page-sub">Standard operating procedures, versioned — and the playbooks that generate projects</div>
        </div>
        <div className="page-actions">
          <input className="inp" placeholder="Search SOPs" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 200 }} />
          {canWrite && (
            <button className="btn-primary" onClick={() => setEditing("new")}>
              + New SOP
            </button>
          )}
        </div>
      </div>

      {departments.length > 0 && (
        <div className="chips" style={{ marginBottom: 12 }}>
          {["All", ...departments].map((d) => (
            <button key={d} className={`chipbtn ${dept === d ? "on" : ""}`} onClick={() => setDept(d)}>
              {d}
            </button>
          ))}
        </div>
      )}

      {isLoading && <div className="empty">Loading…</div>}
      {!isLoading && (sops?.length ?? 0) === 0 && (
        <div className="panel section-block" style={{ maxWidth: 640 }}>
          <div className="panel-title">No SOPs yet</div>
          <p className="small" style={{ marginBottom: 12 }}>
            Write down how the team does a thing once — bar setup, guest-list handling, cash handover — and everyone follows the same steps. Number the lines and
            Podium counts them as steps.
          </p>
          {canWrite ? (
            <button className="btn-primary" onClick={() => setEditing("new")}>
              Write the first SOP
            </button>
          ) : (
            <span className="small muted">Ask Operations or Admin to add one.</span>
          )}
        </div>
      )}

      <div className="grid g3">
        {rows.map((s) => (
          <div key={s.id} className="sop-card" onClick={() => setOpen(s)}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{s.title}</div>
            <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 8 }}>
              {s.department}
              {s.owner ? ` · ${s.owner.name}` : ""}
            </div>
            <span className="pill gray">{s.current ? `${s.current.stepsCount} steps` : "no content"}</span>{" "}
            {s.current && s.current.versionNo > 1 && <span className="pill blue">v{s.current.versionNo}</span>}
          </div>
        ))}
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel-title">
          Event playbooks (auto-generate projects) <Link href="/playbooks">Manage →</Link>
        </div>
        {(playbooks?.length ?? 0) === 0 ? (
          <div className="empty">No playbooks yet — a playbook turns a won deal into a project with its stages and tasks already in place.</div>
        ) : (
          <div className="grid g4">
            {playbooks!.map((p) => (
              <Link key={p.id} href="/playbooks" className="badge-vendor" style={{ justifyContent: "center", padding: 10, textAlign: "center" }}>
                {p.name} · {p.eventType}
              </Link>
            ))}
          </div>
        )}
      </div>

      {open && (
        <SopReader
          sop={open}
          canWrite={canWrite}
          onClose={() => setOpen(null)}
          onEdit={() => {
            setEditing(open);
            setOpen(null);
          }}
          onArchive={() => window.confirm(`Archive "${open.title}"? Past versions stay readable.`) && archive.mutate(open.id)}
        />
      )}
      {editing && <SopEditor sop={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </AppShell>
  );
}

function SopReader({ sop, canWrite, onClose, onEdit, onArchive }: { sop: Sop; canWrite: boolean; onClose: () => void; onEdit: () => void; onArchive: () => void }) {
  const { data } = useQuery({ queryKey: ["sop", sop.id], queryFn: () => api.get<Sop & { versions: SopVersion[] }>(`/sops/${sop.id}`) });
  const [versionNo, setVersionNo] = useState<number | null>(null);
  const versions = data?.versions ?? [];
  const shown = versions.find((v) => v.versionNo === versionNo) ?? versions[0];
  return (
    <Modal
      title={sop.title}
      onClose={onClose}
      footer={
        <>
          {canWrite && (
            <button className="btn-ghost" style={{ marginRight: "auto", color: "var(--red)" }} onClick={onArchive}>
              Archive
            </button>
          )}
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
          {canWrite && (
            <button className="btn-primary" onClick={onEdit}>
              New version
            </button>
          )}
        </>
      }
    >
      <div className="small muted">
        {sop.department}
        {sop.owner ? ` · owner ${sop.owner.name}` : ""}
        {shown ? ` · v${shown.versionNo} of ${fmtDate(shown.createdAt)} · ${shown.stepsCount} steps` : ""}
      </div>
      {versions.length > 1 && (
        <div className="chips">
          {versions.map((v) => (
            <button key={v.id} className={`chipbtn ${shown?.versionNo === v.versionNo ? "on" : ""}`} onClick={() => setVersionNo(v.versionNo)}>
              v{v.versionNo}
            </button>
          ))}
        </div>
      )}
      <div className="sop-body">{shown?.body ?? "Loading…"}</div>
    </Modal>
  );
}

function SopEditor({ sop, onClose }: { sop: Sop | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: people } = useDirectory();
  const { data: full } = useQuery({ queryKey: ["sop", sop?.id], queryFn: () => api.get<Sop & { versions: SopVersion[] }>(`/sops/${sop!.id}`), enabled: !!sop });
  const [f, setF] = useState({ title: sop?.title ?? "", department: sop?.department ?? "", ownerId: sop?.ownerId ?? "", body: "" });
  const [loaded, setLoaded] = useState(!sop);
  if (sop && full && !loaded) {
    setF((prev) => ({ ...prev, body: full.versions[0]?.body ?? "" }));
    setLoaded(true);
  }
  const save = useMutation({
    mutationFn: async () => {
      if (!sop) return api.post("/sops", { title: f.title, department: f.department, body: f.body, ownerId: f.ownerId || null });
      // Title/department/owner are properties of the SOP; the text becomes a new version.
      await api.patch(`/sops/${sop.id}`, { title: f.title, department: f.department, ownerId: f.ownerId || null });
      if (f.body !== (full?.versions[0]?.body ?? "")) await api.post(`/sops/${sop.id}/versions`, { body: f.body });
      return { ok: true };
    },
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ["sops"] }), qc.invalidateQueries({ queryKey: ["sop", sop?.id] })]);
      onClose();
    },
  });
  const steps = f.body.split("\n").filter((l) => /^\s*(\d+[.)]|[-*•])\s+\S/.test(l)).length;
  const ok = f.title.trim() && f.department.trim() && f.body.trim();
  return (
    <Modal
      title={sop ? `New version — ${sop.title}` : "New SOP"}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!ok || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : sop ? "Save new version" : "Create SOP"}
          </button>
        </>
      }
    >
      <div className="grid g2" style={{ gap: 10 }}>
        <FormField label="Title">
          <input className="inp" autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Bar setup — 5-station wedding lounge" />
        </FormField>
        <FormField label="Department">
          <input className="inp" list="sop-depts" value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} placeholder="Operations" />
          <datalist id="sop-depts">
            {["Operations", "Bar", "Creative", "Finance", "Sales", "People", "Compliance"].map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </FormField>
      </div>
      <FormField label="Owner">
        <PersonSelect value={f.ownerId} onChange={(v) => setF({ ...f, ownerId: v })} people={people} placeholder="Who keeps this up to date" />
      </FormField>
      <FormField label="Procedure">
        <textarea className="inp" rows={12} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder={"1. Check the venue's power points\n2. Lay the back bar\n3. …"} />
      </FormField>
      <div className="small muted">{steps} numbered or bulleted step{steps === 1 ? "" : "s"} detected.{sop ? " Saving keeps the previous version." : ""}</div>
      {save.error && <div className="notice red">{(save.error as Error).message}</div>}
    </Modal>
  );
}

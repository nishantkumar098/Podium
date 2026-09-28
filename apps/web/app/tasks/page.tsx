"use client";

import { daysTo } from "@podium/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { NewTaskModal, TaskKanban, useDirectory, type OpsTask } from "../../components/OpsUi";
import { useAuth } from "../../lib/auth";
import { api } from "../../lib/api";

export default function TasksPage() {
  const { user } = useAuth();
  const { data: tasks, isLoading } = useQuery({ queryKey: ["tasks"], queryFn: () => api.get<OpsTask[]>("/tasks") });
  const { data: people } = useDirectory();
  const [owner, setOwner] = useState<"all" | "mine" | string>("all");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);

  const all = tasks ?? [];
  const projects = new Set(all.map((t) => t.projectId)).size;
  const overdue = all.filter((t) => t.dueAt && daysTo(t.dueAt) < 0 && t.status !== "COMPLETED").length;
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return all.filter(
      (t) =>
        (owner === "all" || t.owner.id === (owner === "mine" ? user?.id : owner)) &&
        (!n || `${t.name} ${t.project?.name ?? ""}`.toLowerCase().includes(n)),
    );
  }, [all, owner, q, user?.id]);

  return (
    <AppShell crumb="Tasks">
      <div className="page-head">
        <div>
          <div className="page-title">Tasks</div>
          <div className="page-sub">
            {all.length} tasks across {projects} project{projects === 1 ? "" : "s"}
            {overdue ? ` · ${overdue} overdue` : ""}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn-primary" onClick={() => setAdding(true)}>
            + Task
          </button>
        </div>
      </div>

      <div className="row" style={{ gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div className="chips">
          <button className={`chipbtn ${owner === "all" ? "on" : ""}`} onClick={() => setOwner("all")}>
            Everyone
          </button>
          <button className={`chipbtn ${owner === "mine" ? "on" : ""}`} onClick={() => setOwner("mine")}>
            Mine
          </button>
        </div>
        <select className="inp" value={owner === "all" || owner === "mine" ? "" : owner} onChange={(e) => setOwner(e.target.value || "all")}>
          <option value="">Filter by owner…</option>
          {people?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input className="inp" style={{ flex: "1 1 200px", maxWidth: 300 }} placeholder="Search task or project" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {isLoading && <div className="empty">Loading…</div>}
      {!isLoading && all.length === 0 && (
        <div className="notice" style={{ marginBottom: 12 }}>
          No tasks yet. Use <b>+ Task</b> to add the first one to a project; drag cards between columns as work moves.
        </div>
      )}
      <TaskKanban tasks={shown} queryKeys={[["tasks"]]} showProject />
      {adding && <NewTaskModal onClose={() => setAdding(false)} />}
    </AppShell>
  );
}

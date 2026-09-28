"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "../../components/AppShell";
import { StatusPill } from "../../components/StatusPill";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import type { FlowInstanceDto } from "../../lib/types";

export default function FlowsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: instances, isLoading } = useQuery({
    queryKey: ["flow-instances"],
    queryFn: () => api.get<FlowInstanceDto[]>("/flow-instances"),
  });

  const selected = instances?.find((f) => f.id === selectedId) ?? instances?.[0];

  const start = useMutation({
    mutationFn: (stepId: string) => api.post(`/flow-steps/${stepId}/start`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flow-instances"] }),
  });
  const complete = useMutation({
    mutationFn: (stepId: string) => api.post(`/flow-steps/${stepId}/complete`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flow-instances"] }),
  });

  const myQueueCount = (instances ?? []).reduce(
    (n, f) => n + f.steps.filter((s) => s.ownerId === user?.id && (s.status === "READY" || s.status === "ACTIVE")).length,
    0,
  );

  return (
    <AppShell crumb="Flows">
      <div className="page-head">
        <div>
          <div className="page-title">Flows</div>
          <div className="page-sub">Chained work that moves itself — finish your step and the next person gets it.</div>
        </div>
      </div>

      <div className="baton-hero">
        <div className="bh-count">
          {myQueueCount}
          <small>up next for you</small>
        </div>
        <div className="bh-text">
          <div className="bh-title">{myQueueCount ? "The baton is with you." : "Nothing waiting on you right now."}</div>
          <div className="bh-sub">Every step you complete instantly notifies the next owner — in-app and via Podium Bot in the project channel.</div>
        </div>
      </div>

      {isLoading && <div className="empty">Loading…</div>}

      <div className="grid g-side rs-stack" style={{ gridTemplateColumns: "300px 1fr" }}>
        <div className="plist">
          {instances?.map((f) => {
            const done = f.steps.filter((s) => s.status === "COMPLETED").length;
            return (
              <div key={f.id} className={`flow-card ${selected?.id === f.id ? "on" : ""}`} onClick={() => setSelectedId(f.id)}>
                <div className="fc-name">{f.name}</div>
                <div className="fc-meta">{f.project.name}</div>
                <div className="row" style={{ justifyContent: "space-between", marginTop: 7 }}>
                  <StatusPill status={f.status} />
                  <span className="small faint mono">
                    {done}/{f.steps.length}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div>
          {selected && (
            <div className="panel">
              <div className="panel-title">{selected.name}</div>
              <div className="flow-canvas" style={{ flexWrap: "wrap" }}>
                {[...selected.steps]
                  .sort((a, b) => a.key.localeCompare(b.key))
                  .map((s) => {
                    const mine = s.ownerId === user?.id;
                    return (
                      <div className="flow-col" style={{ flex: "0 0 214px" }} key={s.id}>
                        <div className={`fnode ${s.status} ${mine && s.status !== "COMPLETED" ? "mine" : ""}`}>
                          <span className="fn-state">
                            <span className={`pill ${s.status === "COMPLETED" ? "green" : s.status === "READY" ? "amber" : s.status === "ACTIVE" ? "blue" : "gray"}`}>
                              {s.status}
                            </span>
                          </span>
                          <div className="fn-name">{s.name}</div>
                          <div className="fn-who">
                            <b>{s.role}</b>
                          </div>
                          {mine && s.status === "READY" && (
                            <div className="fn-act">
                              <button className="btn-ghost btn-sm" onClick={() => start.mutate(s.id)}>
                                Start
                              </button>
                              <button className="btn-ok btn-sm" onClick={() => complete.mutate(s.id)}>
                                Mark done
                              </button>
                            </div>
                          )}
                          {mine && s.status === "ACTIVE" && (
                            <div className="fn-act">
                              <button className="btn-ok btn-sm" onClick={() => complete.mutate(s.id)}>
                                Mark done
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

"use client";

import { fmtDate } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "../../components/AppShell";
import { Avatar, label } from "../../components/GovernanceUi";
import { api, ApiError } from "../../lib/api";

interface ApprovalRow {
  id: string;
  title: string;
  type: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  approverRef: string;
  createdAt: string;
  decidedAt: string | null;
  project: { id: string; name: string } | null;
  requester: { id: string; name: string };
}

const PILL: Record<string, string> = { PENDING: "amber", APPROVED: "green", REJECTED: "red" };

export default function ApprovalsPage() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ["approvals"], queryFn: () => api.get<ApprovalRow[]>("/approvals") });
  // approverRef holds a user id for internal approvers, free text for a client contact.
  const { data: users } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<Array<{ id: string; name: string }>>("/users"),
    retry: false,
  });
  const approverName = (ref: string) => users?.find((u) => u.id === ref)?.name ?? ref;

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "APPROVED" | "REJECTED" }) => api.post(`/approvals/${id}/decide`, { decision }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (e: ApiError) => setError(e.message),
  });

  const pending = data?.filter((a) => a.status === "PENDING").length ?? 0;

  return (
    <AppShell crumb="Approvals">
      <div className="page-head">
        <div>
          <div className="page-title">Approvals</div>
          <div className="page-sub">{pending} pending across projects</div>
        </div>
      </div>
      {error && <div className="notice red section-block">{error}</div>}
      {isLoading && <div className="empty">Loading…</div>}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Project</th>
              <th>Type</th>
              <th>Requester</th>
              <th>Approver</th>
              <th>Date</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data && data.length === 0 && (
              <tr>
                <td colSpan={8} className="empty">
                  Nothing waiting for a decision. Creative sign-offs, budget increases, purchase requests and vendor contracts that need approval
                  appear here.
                </td>
              </tr>
            )}
            {data?.map((a) => (
              <tr key={a.id}>
                <td>{a.title}</td>
                <td>{a.project?.name ?? "—"}</td>
                <td>
                  <span className="pill gray">{label(a.type)}</span>
                </td>
                <td>
                  <Avatar name={a.requester.name} /> &nbsp;{a.requester.name}
                </td>
                <td>{approverName(a.approverRef)}</td>
                <td className="mono">{fmtDate(a.createdAt)}</td>
                <td>
                  <span className={`pill ${PILL[a.status] ?? "gray"}`}>{label(a.status)}</span>
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {a.status === "PENDING" && (
                    <>
                      <button className="btn-ok btn-sm" onClick={() => decide.mutate({ id: a.id, decision: "APPROVED" })}>
                        Approve
                      </button>{" "}
                      <button className="btn-ghost btn-sm" onClick={() => decide.mutate({ id: a.id, decision: "REJECTED" })}>
                        Decline
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}

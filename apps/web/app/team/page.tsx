"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "../../components/AppShell";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";

interface TeamMember {
  id: string;
  name: string;
  username: string | null;
  dept: string | null;
  city: string | null;
  roles: string[];
  passwordSet: boolean;
  locked: boolean;
}

/**
 * Resetting a password is Superadmin's alone — it blanks the password, so
 * whoever signs in next with that username sets a new one. Mirrors
 * PASSWORD_RESET_ROLES in apps/api/src/auth/auth.service.ts, which is what
 * actually enforces it; this only decides what to draw.
 */
const RESET_ROLES = ["Superadmin"];
/** Accounts that only a Superadmin may reset — which, here, is all of them. */
const TOP_ROLES = ["Founder", "Superadmin"];

export default function TeamPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canReset = !!user?.roles.some((r) => RESET_ROLES.includes(r));
  const isTop = !!user?.roles.some((r) => TOP_ROLES.includes(r));

  const { data, isLoading } = useQuery({
    queryKey: ["team"],
    queryFn: () => api.get<TeamMember[]>("/users"),
    enabled: canReset,
  });

  const reset = useMutation({
    mutationFn: (id: string) => api.post<{ ok: true; username: string | null }>(`/users/${id}/reset-password`),
    onSuccess: (r) => {
      setError(null);
      setConfirming(null);
      setNotice(`Password reset. ${r.username ?? "They"} will choose a new password the next time they sign in.`);
      qc.invalidateQueries({ queryKey: ["team"] });
    },
    onError: (e: ApiError) => {
      setConfirming(null);
      setError(e.message);
    },
  });

  if (!canReset) {
    return (
      <AppShell crumb="Team & logins">
        <div className="empty">Only a Superadmin can manage logins.</div>
      </AppShell>
    );
  }

  const waiting = (data ?? []).filter((m) => !m.passwordSet).length;

  return (
    <AppShell crumb="Team & logins">
      <div className="page-head">
        <div>
          <div className="page-title">Team & logins</div>
          <div className="page-sub">
            Everyone signs in with their username. A person&apos;s first password becomes permanent; only a Founder or
            Admin can reset it.
          </div>
        </div>
      </div>

      {waiting > 0 && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <span className="small">
            <b>{waiting}</b> account{waiting > 1 ? "s have" : " has"} no password yet. Until they sign in, whoever
            signs in first with that username sets the password — ask them to sign in soon.
          </span>
        </div>
      )}
      {error && (
        <div className="panel" style={{ marginBottom: 14, borderColor: "var(--red)", color: "var(--red)" }}>
          <span className="small">{error}</span>
        </div>
      )}
      {notice && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <span className="small">{notice}</span>
        </div>
      )}

      {isLoading && <div className="empty">Loading…</div>}
      {data && (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Username</th>
                <th>Role</th>
                <th>Department</th>
                <th>City</th>
                <th>Login</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((m) => {
                const targetIsTop = m.roles.some((r) => TOP_ROLES.includes(r));
                const blocked = m.id === user?.id || (targetIsTop && !isTop);
                return (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td className="mono small">{m.username ?? "—"}</td>
                    <td className="small">{m.roles.join(", ") || "—"}</td>
                    <td className="small">{m.dept ?? "—"}</td>
                    <td className="small">{m.city ?? "—"}</td>
                    <td className="small">
                      {m.locked ? (
                        <span style={{ color: "var(--red)" }}>Locked (too many attempts)</span>
                      ) : m.passwordSet ? (
                        "Password set"
                      ) : (
                        <span style={{ color: "var(--amber, #b7791f)" }}>Waiting for first sign-in</span>
                      )}
                    </td>
                    <td className="tright">
                      {blocked || !m.passwordSet ? null : confirming === m.id ? (
                        <span style={{ display: "inline-flex", gap: 6 }}>
                          <button className="btn-warn btn-sm" disabled={reset.isPending} onClick={() => reset.mutate(m.id)}>
                            {reset.isPending ? "Resetting…" : "Confirm reset"}
                          </button>
                          <button className="btn-ghost btn-sm" onClick={() => setConfirming(null)}>
                            Keep
                          </button>
                        </span>
                      ) : (
                        <button className="btn-ghost btn-sm" onClick={() => { setNotice(null); setConfirming(m.id); }}>
                          Reset password
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}

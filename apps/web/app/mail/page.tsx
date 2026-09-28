"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { FormField, Modal } from "../../components/GovernanceUi";
import { NewTaskModal } from "../../components/OpsUi";
import { api } from "../../lib/api";

interface GoogleStatus {
  mode: "disabled" | "sandbox" | "live";
  credentialsPresent: boolean;
  connected: boolean;
  account: { googleEmail: string; lastSyncedAt: string | null } | null;
  blockedReason: string | null;
}

interface Email {
  id: string;
  threadId: string;
  fromAddress: string;
  subject: string;
  snippet: string | null;
  receivedAt: string;
  isUnread: boolean;
  isSandbox: boolean;
  linkedTo: { kind: "client" | "vendor" | "lead"; id: string; name: string } | null;
}

const FOLDERS = ["Inbox", "Unread", "Clients", "Vendors", "Leads", "Not linked"] as const;
type Folder = (typeof FOLDERS)[number];

function inFolder(e: Email, f: Folder): boolean {
  switch (f) {
    case "Unread":
      return e.isUnread;
    case "Clients":
      return e.linkedTo?.kind === "client";
    case "Vendors":
      return e.linkedTo?.kind === "vendor";
    case "Leads":
      return e.linkedTo?.kind === "lead";
    case "Not linked":
      return !e.linkedTo;
    default:
      return true;
  }
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(mins, 1)} min`;
  if (mins < 1440) return `${Math.round(mins / 60)} h`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** A Gmail compose window — works without any API connection. */
function gmailCompose(to: string, subject: string, body: string): string {
  const q = new URLSearchParams({ view: "cm", fs: "1", to, su: subject, body });
  return `https://mail.google.com/mail/?${q.toString()}`;
}

export default function MailPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const [folder, setFolder] = useState<Folder>("Inbox");
  const [selId, setSelId] = useState<string | null>(null);
  const [compose, setCompose] = useState<{ to: string; subject: string; body: string } | null>(null);
  const [taskFrom, setTaskFrom] = useState<Email | null>(null);

  const status = useQuery({ queryKey: ["google-status"], queryFn: () => api.get<GoogleStatus>("/integrations/google/status"), staleTime: 60_000 });
  const s = status.data;
  const usable = !!s && (s.mode === "sandbox" || (s.mode === "live" && s.connected));
  const emails = useQuery({
    queryKey: ["emails"],
    queryFn: () => api.get<Email[]>("/integrations/google/emails?limit=200"),
    enabled: usable,
    refetchInterval: 120_000,
  });

  const sync = useMutation({
    mutationFn: () => api.post<{ fetched: number; created: number }>("/integrations/google/sync"),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ["emails"] }), qc.invalidateQueries({ queryKey: ["google-status"] }), qc.invalidateQueries({ queryKey: ["nav-counts"] })]),
  });
  const connect = useMutation({
    mutationFn: () => api.get<{ url: string }>("/integrations/google/auth-url?state=mail"),
    onSuccess: (r) => {
      window.location.href = r.url;
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api.delete("/integrations/google/connection"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["google-status"] }),
  });
  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/integrations/google/emails/${id}/read`),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ["emails"] }), qc.invalidateQueries({ queryKey: ["nav-counts"] })]),
  });

  const all = emails.data ?? [];
  const list = useMemo(() => all.filter((e) => inFolder(e, folder)), [all, folder]);
  const sel = all.find((e) => e.id === selId) ?? null;
  const open = (e: Email) => {
    setSelId(e.id);
    if (e.isUnread) markRead.mutate(e.id);
  };
  const canSend = s?.mode === "live" && s.connected;

  return (
    <AppShell crumb="Mail">
      <div className="page-head">
        <div>
          <div className="page-title">Mail</div>
          <div className="page-sub">
            {s?.connected && s.account
              ? `Gmail · ${s.account.googleEmail} · emails are matched to clients, vendors and leads automatically`
              : "Gmail inside Podium — every email matched to its client, vendor or lead"}
          </div>
        </div>
        <div className="page-actions">
          {usable && (
            <button className="btn-ghost" disabled={sync.isPending} onClick={() => sync.mutate()}>
              {sync.isPending ? "Syncing…" : "Sync now"}
            </button>
          )}
          <a className="btn-ghost" href="https://mail.google.com/mail/u/0/#inbox" target="_blank" rel="noreferrer">
            Open Gmail
          </a>
          <button className="btn-primary" onClick={() => setCompose({ to: "", subject: "", body: "" })}>
            Compose
          </button>
        </div>
      </div>

      {(sync.error || connect.error || disconnect.error) && <div className="notice red">{((sync.error || connect.error || disconnect.error) as Error).message}</div>}
      {s?.mode === "sandbox" && <div className="notice" style={{ marginBottom: 10 }}>Sandbox mode — the messages below are test fixtures from example.invalid, not real mail.</div>}

      {status.isLoading && <div className="empty">Checking the Google connection…</div>}

      {s && s.mode === "disabled" && (
        <div className="panel" style={{ maxWidth: 720 }}>
          <div className="panel-title">
            Gmail isn&apos;t connected yet <span className="pill gray">Not configured</span>
          </div>
          <p className="small" style={{ marginBottom: 10 }}>
            Podium reads the inbox and sends mail through Google&apos;s official Gmail API, which needs AMM Brands&apos; own Google Cloud credentials.
            None are configured on this server yet, so there is no inbox to show — Podium won&apos;t display sample mail in its place.
          </p>
          <div className="small muted" style={{ marginBottom: 6, fontWeight: 600 }}>
            What your admin needs to do (once):
          </div>
          <ol className="small" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
            <li>In Google Cloud Console, create an OAuth client (type: Web application) for the ammbrands Google Workspace.</li>
            <li>Enable the Gmail API and the Google Calendar API on that project.</li>
            <li>
              Add the redirect URI <code className="mono">{typeof window !== "undefined" ? `${window.location.origin}/mail/connect` : "/mail/connect"}</code>.
            </li>
            <li>
              Put the Client ID and Secret in the server&apos;s <code className="mono">.env</code> and set <code className="mono">GOOGLE_INTEGRATION_MODE=live</code>, then restart the API.
            </li>
          </ol>
          <p className="small muted" style={{ marginTop: 10 }}>
            Until then, <b>Compose</b> opens a Gmail draft in a new tab, and Meetings can still use Meet links you paste in.
          </p>
        </div>
      )}

      {s && s.mode === "live" && !s.connected && (
        <div className="panel" style={{ maxWidth: 620 }}>
          <div className="panel-title">Connect your Google account</div>
          <p className="small" style={{ marginBottom: 12 }}>
            Podium will read your inbox (read-only), send mail you write here, and create Google Meet links for meetings you schedule. You can disconnect at any time.
          </p>
          <button className="btn-primary" disabled={connect.isPending} onClick={() => connect.mutate()}>
            {connect.isPending ? "Opening Google…" : "Connect Google"}
          </button>
        </div>
      )}

      {usable && (
        <div className={`mail ${sel ? "reading" : ""}`}>
          <nav className="mail-folders" aria-label="Folders">
            {FOLDERS.map((f) => {
              const n = all.filter((e) => inFolder(e, f) && e.isUnread).length;
              return (
                <div
                  key={f}
                  className={`chrow ${f === folder ? "on" : ""}`}
                  tabIndex={0}
                  onClick={() => {
                    setFolder(f);
                    setSelId(null);
                  }}
                >
                  {f}
                  {n > 0 && <span className="unr">{n}</span>}
                </div>
              );
            })}
            {s?.connected && (
              <div className="small muted" style={{ padding: "14px 8px 0" }}>
                {s.account?.lastSyncedAt ? `Synced ${ago(s.account.lastSyncedAt)} ago` : "Not synced yet"}
                <br />
                <button className="linkish small" onClick={() => window.confirm("Disconnect Google from Podium?") && disconnect.mutate()}>
                  Disconnect
                </button>
              </div>
            )}
          </nav>
          <div className="mail-list">
            {emails.isLoading && <div className="empty">Loading…</div>}
            {!emails.isLoading && list.length === 0 && <div className="empty">{all.length === 0 ? "No mail synced yet — press Sync now." : "No emails in this folder."}</div>}
            {list.map((e) => (
              <div key={e.id} className={`mrow ${e.isUnread ? "unread" : ""} ${sel?.id === e.id ? "on" : ""}`} tabIndex={0} onClick={() => open(e)}>
                <div className="mtop">
                  <span className="mfrom">{e.fromAddress}</span>
                  <span className="faint small">{ago(e.receivedAt)}</span>
                </div>
                <div className="msub">{e.subject}</div>
                <div className="msnip">{e.snippet}</div>
                <div className="mtag">
                  {e.linkedTo ? (
                    <span className="small muted">
                      ↳ {e.linkedTo.name} ({e.linkedTo.kind})
                    </span>
                  ) : (
                    <span className="small" style={{ color: "var(--brass-deep)" }}>
                      Not linked — new sender
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="mail-read">
            {sel ? (
              <>
                <button className="linkish mobile-only" onClick={() => setSelId(null)} style={{ marginBottom: 10 }}>
                  ‹ Back to {folder}
                </button>
                <h2>{sel.subject}</h2>
                <div>
                  <b>{sel.fromAddress}</b>
                  <div className="small faint">{new Date(sel.receivedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</div>
                </div>
                {sel.linkedTo && (
                  <div style={{ marginTop: 10 }}>
                    <span className="badge-vendor">
                      {sel.linkedTo.kind}: {sel.linkedTo.name}
                    </span>
                  </div>
                )}
                <div className="mail-body">{sel.snippet}</div>
                <div className="small faint" style={{ marginTop: 6 }}>
                  Podium stores the preview; open the full message in Gmail.
                </div>
                <div className="mail-actions">
                  <a className="btn-ghost" href={`https://mail.google.com/mail/u/0/#all/${sel.threadId}`} target="_blank" rel="noreferrer">
                    Open in Gmail
                  </a>
                  <button className="btn-primary" onClick={() => setCompose({ to: sel.fromAddress, subject: sel.subject.startsWith("Re:") ? sel.subject : `Re: ${sel.subject}`, body: "" })}>
                    Reply
                  </button>
                  <button className="btn-ghost" onClick={() => setTaskFrom(sel)}>
                    Create task
                  </button>
                  {sel.linkedTo?.kind === "lead" && (
                    <button className="btn-ghost" onClick={() => router.push(`/leads/${sel.linkedTo!.id}`)}>
                      Open lead
                    </button>
                  )}
                </div>
                {!sel.linkedTo && (
                  <div className="linkbox">
                    Podium couldn&apos;t match this sender to a client, vendor or lead. Add their e-mail to the client or vendor record and future mail from them links automatically.
                  </div>
                )}
              </>
            ) : (
              <div className="empty" style={{ marginTop: 60 }}>
                Pick an email to read it. Each one can become a task or a reply.
              </div>
            )}
          </div>
        </div>
      )}

      {compose && <Compose initial={compose} canSend={!!canSend} onClose={() => setCompose(null)} />}
      {taskFrom && <NewTaskModal onClose={() => setTaskFrom(null)} />}
    </AppShell>
  );
}

function Compose({ initial, canSend, onClose }: { initial: { to: string; subject: string; body: string }; canSend: boolean; onClose: () => void }) {
  const [f, setF] = useState(initial);
  const send = useMutation({ mutationFn: () => api.post("/integrations/google/send", f), onSuccess: onClose });
  const ok = /.+@.+\..+/.test(f.to.trim()) && f.subject.trim() && f.body.trim();
  return (
    <Modal
      title={initial.to ? "Reply" : "New email"}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          {canSend ? (
            <button className="btn-primary" disabled={!ok || send.isPending} onClick={() => send.mutate()}>
              {send.isPending ? "Sending…" : "Send"}
            </button>
          ) : (
            <a className="btn-primary" href={gmailCompose(f.to, f.subject, f.body)} target="_blank" rel="noreferrer" onClick={onClose}>
              Open in Gmail to send
            </a>
          )}
        </>
      }
    >
      <FormField label="To">
        <input className="inp" type="email" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} autoFocus={!initial.to} />
      </FormField>
      <FormField label="Subject">
        <input className="inp" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
      </FormField>
      <FormField label="Message">
        <textarea className="inp" rows={8} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} autoFocus={!!initial.to} />
      </FormField>
      {!canSend && <div className="small muted">Gmail isn&apos;t connected to Podium yet, so this opens a ready-filled draft in Gmail for you to send.</div>}
      {send.error && <div className="notice red">{(send.error as Error).message}</div>}
    </Modal>
  );
}

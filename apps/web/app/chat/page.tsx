"use client";

import { initials } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { FormField, Modal } from "../../components/GovernanceUi";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { playSound } from "../../lib/sounds";
import type { CityOptionDto } from "../../lib/types";

interface ChannelDto {
  id: string;
  name: string;
  kind: "COMPANY" | "CITY" | "PROJECT" | "DM" | "GROUP";
  description: string | null;
  createdById?: string | null;
  /** DM and GROUP only. */
  members?: Array<{ id: string; name: string }>;
  /** DM only: the other person. */
  displayName?: string;
  withUserId?: string | null;
  unread: number;
  lastMessageAt: string | null;
  project: { id: string; name: string } | null;
  city: { id: string; name: string } | null;
}

interface MessageDto {
  id: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  createdAt: string;
}

const MANAGERS = ["Founder", "Superadmin", "Admin", "Operations"];

interface PersonDto {
  id: string;
  name: string;
  username: string | null;
  role: string | null;
  city: string | null;
}

/** How a conversation is named: a person for a DM, the group name, or #channel. */
const labelOf = (c: ChannelDto) => (c.kind === "DM" ? c.displayName ?? "Private message" : c.kind === "GROUP" ? c.name : `#${c.name}`);
const iconOf = (c: ChannelDto) => (c.kind === "DM" ? "●" : c.kind === "GROUP" ? "◎" : "#");
const byRecent = (a: ChannelDto, b: ChannelDto) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "");

function clock(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? time : `${d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} · ${time}`;
}

/** Highlights @mentions the way the reference does. */
function MessageText({ body }: { body: string }) {
  const parts = body.split(/(@[\w.]+(?:\s[A-Z][a-z]+)?)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("@") ? (
          <span key={i} className="mention">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export default function ChatPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const { user } = useAuth();
  const [activeId, setActiveId] = useState<string | null>(null);
  // Deep link (?c=<channel id>), read once rather than via useSearchParams,
  // which would force a Suspense boundary on this page.
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("c");
    if (c) setActiveId(c);
  }, []);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<"dm" | "group" | "members" | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const isManager = !!user?.roles.some((r) => MANAGERS.includes(r));

  const { data: channels, isLoading } = useQuery({
    queryKey: ["channels"],
    queryFn: () => api.get<ChannelDto[]>("/channels"),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
  const active = activeId ?? channels?.find((c) => c.name === "general")?.id ?? channels?.[0]?.id ?? null;
  const channel = channels?.find((c) => c.id === active);

  const { data: messages } = useQuery({
    queryKey: ["messages", active],
    queryFn: () => api.get<MessageDto[]>(`/channels/${active}/messages`),
    enabled: !!active,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  // Opening a channel marks it read on the server; reflect that in the list and badge.
  useEffect(() => {
    if (!messages || !active) return;
    qc.setQueryData<ChannelDto[]>(["channels"], (old) => old?.map((c) => (c.id === active ? { ...c, unread: 0 } : c)));
    void qc.invalidateQueries({ queryKey: ["nav-counts"] });
  }, [messages, active, qc]);

  // A message from someone else arriving in the open channel pops. The first
  // load of a channel only records where it stands (messages are newest first).
  const seen = useRef<{ channel: string | null; top: string | null }>({ channel: null, top: null });
  useEffect(() => {
    if (!messages || !active) return;
    const top = messages[0]?.id ?? null;
    const prev = seen.current;
    if (prev.channel === active && prev.top !== top && prev.top !== null) {
      const cut = messages.findIndex((m) => m.id === prev.top);
      const fresh = cut === -1 ? messages.slice(0, 1) : messages.slice(0, cut);
      if (fresh.some((m) => m.authorId !== user?.id)) playSound("message");
    }
    seen.current = { channel: active, top };
  }, [messages, active, user?.id]);

  // Block body, not a one-line arrow: an effect that RETURNS a value makes
  // React treat it as the cleanup function and crash on unmount
  // ("destroy is not a function").
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, active]);

  const post = useMutation({
    mutationFn: (body: string) => api.post(`/channels/${active}/messages`, { body }),
    meta: { sound: "sent" },
    onSuccess: () => {
      setDraft("");
      void qc.invalidateQueries({ queryKey: ["messages", active] });
      void qc.invalidateQueries({ queryKey: ["channels"] });
    },
  });

  const groups = useMemo(
    () => [
      { label: "Company", items: (channels ?? []).filter((c) => c.kind === "COMPANY") },
      { label: "Cities", items: (channels ?? []).filter((c) => c.kind === "CITY") },
      { label: "Direct messages", items: (channels ?? []).filter((c) => c.kind === "DM").sort(byRecent) },
      { label: "Groups", items: (channels ?? []).filter((c) => c.kind === "GROUP").sort(byRecent) },
      {
        label: "Projects",
        items: (channels ?? []).filter((c) => c.kind === "PROJECT").sort(byRecent),
      },
    ],
    [channels],
  );

  const ordered = [...(messages ?? [])].reverse();
  const send = () => draft.trim() && active && post.mutate(draft.trim());

  return (
    <AppShell crumb="Chat">
      {!isLoading && channels?.length === 0 && !activeId ? (
        <NoChannels isManager={isManager} onCreate={() => setCreating(true)} />
      ) : (
        <div className="chat">
          <nav className="chat-side" aria-label="Conversations">
            {groups.map(
              (g) =>
                g.items.length > 0 && (
                  <div key={g.label}>
                    <div className="grp">{g.label}</div>
                    {g.items.map((c) => (
                      <div
                        key={c.id}
                        className={`chrow ${active === c.id ? "on" : ""} ${c.unread && active !== c.id ? "bold" : ""}`}
                        tabIndex={0}
                        onClick={() => setActiveId(c.id)}
                        onKeyDown={(e) => e.key === "Enter" && setActiveId(c.id)}
                      >
                        <span className="hash">{iconOf(c)}</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.kind === "DM" ? c.displayName : c.name}</span>
                        {c.unread > 0 && active !== c.id && <span className="unr">{c.unread}</span>}
                      </div>
                    ))}
                  </div>
                ),
            )}
            <div className="chrow" style={{ marginTop: 10, color: "var(--text-dim)" }} onClick={() => setDialog("dm")}>
              <span className="hash">+</span> New message
            </div>
            <div className="chrow" style={{ color: "var(--text-dim)" }} onClick={() => setDialog("group")}>
              <span className="hash">+</span> New group
            </div>
            {isManager && (
              <div className="chrow" style={{ color: "var(--text-dim)" }} onClick={() => setCreating(true)}>
                <span className="hash">+</span> New channel
              </div>
            )}
          </nav>
          <section className="chat-main">
            <div className="chat-head">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="nm">{channel ? labelOf(channel) : "Chat"}</div>
                <div className="ds">
                  {channel?.kind === "DM"
                    ? "Private conversation — only the two of you can see it"
                    : channel?.kind === "GROUP"
                      ? `Private group · ${channel.members?.length ?? 0} member${channel.members?.length === 1 ? "" : "s"}${channel.description ? ` · ${channel.description}` : ""}`
                      : channel?.description ?? (channel?.project ? `Project channel · ${channel.project.name}` : channel?.city ? `${channel.city.name} team` : "")}
                </div>
                <select className="inp mobile-only" style={{ marginTop: 6, width: "100%" }} value={active ?? ""} onChange={(e) => setActiveId(e.target.value)} aria-label="Switch channel">
                  {(channels ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {labelOf(c)}
                      {c.unread ? ` (${c.unread})` : ""}
                    </option>
                  ))}
                </select>
                <div className="row mobile-only" style={{ gap: 6, marginTop: 6 }}>
                  <button className="btn-ghost btn-sm" onClick={() => setDialog("dm")}>
                    + New message
                  </button>
                  <button className="btn-ghost btn-sm" onClick={() => setDialog("group")}>
                    + New group
                  </button>
                </div>
              </div>
              {channel?.project && (
                <button className="btn-ghost btn-sm" onClick={() => router.push(`/projects/${channel.project!.id}`)}>
                  Open project
                </button>
              )}
              {channel?.kind === "GROUP" && (
                <button className="btn-ghost btn-sm" onClick={() => setDialog("members")}>
                  Members · {channel.members?.length ?? 0}
                </button>
              )}
              <a className="btn-ghost btn-sm" href="https://meet.google.com/new" target="_blank" rel="noreferrer">
                Start Google Meet
              </a>
            </div>
            <div className="msgs">
              {ordered.map((m, i) => {
                const prev = ordered[i - 1];
                const grouped = !!prev && prev.authorId === m.authorId && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
                const name = m.authorId ? (m.authorName ?? "Someone") : "Podium Bot";
                return (
                  <div key={m.id} className={`msg ${!m.authorId ? "botmsg" : ""} ${grouped ? "" : "first"}`}>
                    {grouped ? (
                      <span className="av-s" style={{ visibility: "hidden" }} />
                    ) : (
                      <span className={`av-s ${m.authorId ? "" : "bot"}`} title={name}>
                        {m.authorId ? initials(name) : "P"}
                      </span>
                    )}
                    <div className="body">
                      {!grouped && (
                        <div className="who">
                          {name}
                          <span className="tm">{clock(m.createdAt)}</span>
                        </div>
                      )}
                      <div className="tx">
                        <MessageText body={m.body} />
                      </div>
                    </div>
                  </div>
                );
              })}
              {messages?.length === 0 && <div className="empty">No messages yet. Say hello{channel ? ` to ${labelOf(channel)}` : ""}.</div>}
              <div ref={bottom} />
            </div>
            <div className="composer">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={channel ? (channel.kind === "DM" ? `Message ${channel.displayName ?? ""}` : `Message ${labelOf(channel)} — use @Name to mention someone`) : "Message"}
                aria-label="Message"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button className="btn-primary" disabled={!draft.trim() || post.isPending} onClick={send}>
                Send
              </button>
            </div>
            {post.error && <div className="notice red" style={{ margin: "0 12px 10px" }}>{(post.error as Error).message}</div>}
          </section>
        </div>
      )}
      {creating && <NewChannel onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setActiveId(id); }} />}
      {dialog === "dm" && (
        <NewDm
          onClose={() => setDialog(null)}
          onOpened={(id) => {
            setDialog(null);
            setActiveId(id);
          }}
        />
      )}
      {dialog === "group" && (
        <NewGroup
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setDialog(null);
            setActiveId(id);
          }}
        />
      )}
      {dialog === "members" && channel?.kind === "GROUP" && (
        <GroupMembers
          channel={channel}
          meId={user?.id ?? ""}
          onClose={() => setDialog(null)}
          onLeft={() => {
            setDialog(null);
            setActiveId(null);
          }}
        />
      )}
    </AppShell>
  );
}

/** Empty workspace: managers can create the standard channels in one step. */
function NoChannels({ isManager, onCreate }: { isManager: boolean; onCreate: () => void }) {
  const qc = useQueryClient();
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: () => api.get<CityOptionDto[]>("/cities") });
  const setup = useMutation({
    mutationFn: async () => {
      const wanted: Array<{ name: string; kind: "COMPANY" | "CITY"; cityId?: string; description: string }> = [
        { name: "general", kind: "COMPANY", description: "Company-wide conversation" },
        { name: "announcements", kind: "COMPANY", description: "Company-wide announcements, shown on Home" },
        ...(cities ?? []).map((c) => ({ name: c.name.toLowerCase(), kind: "CITY" as const, cityId: c.id, description: `${c.name} team` })),
      ];
      let created = 0;
      const problems: string[] = [];
      for (const ch of wanted) {
        try {
          await api.post("/channels", ch);
          created++;
        } catch (e) {
          // "already exists" is fine; anything else the person needs to see,
          // otherwise the screen just stays empty and looks broken.
          const message = (e as Error).message;
          if (!/already exists/i.test(message)) problems.push(`#${ch.name}: ${message}`);
        }
      }
      if (created === 0 && problems.length > 0) throw new Error(problems.join(" · "));
      return { created, problems };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["channels"] }),
  });
  return (
    <div className="panel" style={{ maxWidth: 560 }}>
      <div className="panel-title">No channels yet</div>
      {isManager ? (
        <>
          <p className="small muted" style={{ marginBottom: 12 }}>
            Create the standard set — #general, #announcements and one channel per city ({(cities ?? []).map((c) => c.name).join(", ")}) — or make your own.
            Every new project gets its own channel automatically.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn-primary" disabled={setup.isPending || !cities} onClick={() => setup.mutate()}>
              {setup.isPending ? "Creating…" : "Create standard channels"}
            </button>
            <button className="btn-ghost" onClick={onCreate}>
              New channel
            </button>
          </div>
          {setup.error && <div className="notice red" style={{ marginTop: 10 }}>{(setup.error as Error).message}</div>}
          {setup.data && setup.data.problems.length > 0 && (
            <div className="notice" style={{ marginTop: 10 }}>
              Created {setup.data.created}. Not created — {setup.data.problems.join(" · ")}
            </div>
          )}
        </>
      ) : (
        <p className="small muted">Your Founder, Admin or Operations lead can create channels. New projects get their own channel automatically.</p>
      )}
    </div>
  );
}

function NewChannel({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: () => api.get<CityOptionDto[]>("/cities") });
  const [f, setF] = useState({ name: "", kind: "COMPANY" as "COMPANY" | "CITY", cityId: "", description: "" });
  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>("/channels", {
        name: f.name,
        kind: f.kind,
        ...(f.kind === "CITY" ? { cityId: f.cityId } : {}),
        ...(f.description.trim() ? { description: f.description.trim() } : {}),
      }),
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: ["channels"] });
      onCreated(c.id);
    },
  });
  const ok = f.name.trim() && (f.kind === "COMPANY" || f.cityId);
  return (
    <Modal
      title="New channel"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!ok || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Creating…" : "Create channel"}
          </button>
        </>
      }
    >
      <FormField label="Name">
        <input className="inp" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. bar-ops" />
      </FormField>
      <FormField label="Who it's for">
        <select className="inp" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "COMPANY" | "CITY" })}>
          <option value="COMPANY">Everyone in the company</option>
          <option value="CITY">One city&apos;s team</option>
        </select>
      </FormField>
      {f.kind === "CITY" && (
        <FormField label="City">
          <select className="inp" value={f.cityId} onChange={(e) => setF({ ...f, cityId: e.target.value })}>
            <option value="">Choose a city</option>
            {cities?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </FormField>
      )}
      <FormField label="Description (optional)">
        <input className="inp" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </FormField>
      {save.error && <div className="notice red">{(save.error as Error).message}</div>}
    </Modal>
  );
}

// ------------------------------------------------------------ private messages + groups

function usePeople() {
  return useQuery({ queryKey: ["chat-people"], queryFn: () => api.get<PersonDto[]>("/channels/people"), staleTime: 5 * 60_000 });
}

/**
 * Everyone in every city, grouped by city, searchable by name, role or city.
 * Single-select (tap to choose) or multi-select (checkboxes).
 */
function PeoplePicker({ multiple, selected, onToggle, exclude = [] }: { multiple: boolean; selected: string[]; onToggle: (p: PersonDto) => void; exclude?: string[] }) {
  const { data: people, isLoading } = usePeople();
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const list = (people ?? []).filter((p) => !exclude.includes(p.id)).filter((p) => !term || [p.name, p.username, p.role, p.city].some((v) => v?.toLowerCase().includes(term)));
  const byCity = new Map<string, PersonDto[]>();
  for (const p of list) byCity.set(p.city ?? "No city", [...(byCity.get(p.city ?? "No city") ?? []), p]);
  const cities = [...byCity.keys()].sort((a, b) => (a === "No city" ? 1 : b === "No city" ? -1 : a.localeCompare(b)));
  return (
    <div>
      <input className="inp" style={{ width: "100%", marginBottom: 8 }} autoFocus placeholder="Search by name, role or city" value={q} onChange={(e) => setQ(e.target.value)} />
      <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--line)", borderRadius: "var(--radius-m)" }}>
        {isLoading && <div className="empty">Loading people…</div>}
        {!isLoading && list.length === 0 && <div className="empty">No one matches.</div>}
        {cities.map((city) => (
          <div key={city}>
            <div className="small" style={{ padding: "6px 10px", background: "var(--paper)", color: "var(--text-dim)", fontWeight: 600, position: "sticky", top: 0 }}>
              {city} <span className="faint">· {byCity.get(city)!.length}</span>
            </div>
            {byCity.get(city)!.map((p) => {
              const on = selected.includes(p.id);
              return (
                <div
                  key={p.id}
                  className="rowhover"
                  role="button"
                  tabIndex={0}
                  onClick={() => onToggle(p)}
                  onKeyDown={(e) => e.key === "Enter" && onToggle(p)}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", cursor: "pointer", background: on ? "var(--brass-tint, #f6efe0)" : undefined }}
                >
                  {multiple && <input type="checkbox" readOnly checked={on} style={{ width: 15, height: 15 }} />}
                  <span className="av-s">{initials(p.name)}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13 }}>{p.name}</span>
                    <span className="small faint">{[p.role, p.username ? `@${p.username}` : null].filter(Boolean).join(" · ")}</span>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function NewDm({ onClose, onOpened }: { onClose: () => void; onOpened: (id: string) => void }) {
  const qc = useQueryClient();
  const open = useMutation({
    mutationFn: (userId: string) => api.post<{ id: string }>("/channels/dm", { userId }),
    meta: { sound: "silent" },
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: ["channels"] });
      onOpened(c.id);
    },
  });
  return (
    <Modal
      title="New message"
      onClose={onClose}
      footer={
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <div className="small muted">Send a private message to anyone, in any city. Only the two of you can see it.</div>
      <PeoplePicker multiple={false} selected={[]} onToggle={(p) => !open.isPending && open.mutate(p.id)} />
      {open.isPending && <div className="small muted">Opening…</div>}
      {open.error && <div className="notice red">{(open.error as Error).message}</div>}
    </Modal>
  );
}

function NewGroup({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<PersonDto[]>([]);
  const toggle = (p: PersonDto) => setPicked((cur) => (cur.some((x) => x.id === p.id) ? cur.filter((x) => x.id !== p.id) : [...cur, p]));
  const save = useMutation({
    mutationFn: () => api.post<{ id: string }>("/channels/groups", { name: name.trim(), memberIds: picked.map((p) => p.id) }),
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: ["channels"] });
      onCreated(c.id);
    },
  });
  return (
    <Modal
      title="New group"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!name.trim() || picked.length === 0 || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Creating…" : `Create group${picked.length ? ` (${picked.length + 1})` : ""}`}
          </button>
        </>
      }
    >
      <FormField label="Group name">
        <input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Delhi–Jaipur wedding crew" />
      </FormField>
      {picked.length > 0 && (
        <div className="chips">
          {picked.map((p) => (
            <button key={p.id} className="chipbtn on" onClick={() => toggle(p)} title="Remove">
              {p.name} ×
            </button>
          ))}
        </div>
      )}
      <PeoplePicker multiple selected={picked.map((p) => p.id)} onToggle={toggle} />
      <div className="small muted">Only the people in the group can see it. Anyone in the group can add more people later.</div>
      {save.error && <div className="notice red">{(save.error as Error).message}</div>}
    </Modal>
  );
}

interface MembersDto {
  createdById: string | null;
  members: Array<{ id: string; name: string; role: string | null; city: string | null }>;
}

function GroupMembers({ channel, meId, onClose, onLeft }: { channel: ChannelDto; meId: string; onClose: () => void; onLeft: () => void }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const { data } = useQuery({ queryKey: ["channel-members", channel.id], queryFn: () => api.get<MembersDto>(`/channels/${channel.id}/members`) });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["channel-members", channel.id] });
    await qc.invalidateQueries({ queryKey: ["channels"] });
    await qc.invalidateQueries({ queryKey: ["messages", channel.id] });
  };
  const add = useMutation({
    mutationFn: () => api.post(`/channels/${channel.id}/members`, { userIds: picked }),
    onSuccess: async () => {
      setPicked([]);
      setAdding(false);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.delete(`/channels/${channel.id}/members/${userId}`),
    onSuccess: async (_d, userId) => {
      if (userId === meId) {
        await qc.invalidateQueries({ queryKey: ["channels"] });
        onLeft();
      } else await refresh();
    },
  });
  const isOwner = data?.createdById === meId;
  const memberIds = (data?.members ?? []).map((m) => m.id);
  return (
    <Modal
      title={`${channel.name} — members`}
      onClose={onClose}
      footer={
        adding ? (
          <>
            <button className="btn-ghost" onClick={() => setAdding(false)}>
              Back
            </button>
            <button className="btn-primary" disabled={picked.length === 0 || add.isPending} onClick={() => add.mutate()}>
              {add.isPending ? "Adding…" : `Add ${picked.length || ""} ${picked.length === 1 ? "person" : "people"}`}
            </button>
          </>
        ) : (
          <>
            <button className="btn-ghost" onClick={() => window.confirm("Leave this group? You'll stop seeing its messages.") && remove.mutate(meId)}>
              Leave group
            </button>
            <button className="btn-primary" onClick={() => setAdding(true)}>
              + Add people
            </button>
          </>
        )
      }
    >
      {adding ? (
        <PeoplePicker multiple exclude={memberIds} selected={picked} onToggle={(p) => setPicked((cur) => (cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id]))} />
      ) : (
        <div style={{ maxHeight: 360, overflowY: "auto" }}>
          {(data?.members ?? []).map((m) => (
            <div key={m.id} className="row" style={{ padding: "7px 0", borderBottom: "1px solid #F1EEE5", gap: 10 }}>
              <span className="av-s">{initials(m.name)}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13 }}>
                  {m.name}
                  {m.id === meId && <span className="faint"> (you)</span>}
                  {m.id === data?.createdById && <span className="pill gray" style={{ marginLeft: 6 }}>creator</span>}
                </span>
                <span className="small faint">{[m.role, m.city].filter(Boolean).join(" · ")}</span>
              </span>
              {isOwner && m.id !== meId && (
                <button className="btn-ghost btn-sm" disabled={remove.isPending} onClick={() => window.confirm(`Remove ${m.name} from the group?`) && remove.mutate(m.id)}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {(add.error || remove.error) && <div className="notice red">{((add.error || remove.error) as Error).message}</div>}
    </Modal>
  );
}

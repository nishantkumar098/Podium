"use client";

import { initials } from "@podium/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, getScopeCityId, setScopeCityId } from "../lib/api";
import { useAuth } from "../lib/auth";
import { playSound, setSoundsEnabled, soundsEnabled } from "../lib/sounds";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { DeskBuddy } from "./DeskBuddy";
import { NotificationBell } from "./NotificationBell";
import { NewProjectModal, NewRiskModal, NewTaskModal } from "./OpsUi";
const SIDEBAR_SCROLL_KEY = "podium.sidebarScroll";

/**
 * Screens' main data, fetched quietly once the app is up so opening them is
 * instant. Keys and URLs mirror each page's own useQuery exactly (a mismatch
 * would only waste the prefetch, never show wrong data). Screens the person
 * lacks permission for answer 403, which prefetchQuery ignores.
 */
const WARM: Array<[readonly unknown[], string]> = [
  [["dashboard"], "/dashboard"],
  [["my-work"], "/me/work"],
  [["projects"], "/projects"],
  [["invoices"], "/invoices"],
  [["tasks"], "/tasks"],
  [["approvals"], "/approvals"],
  [["inventory-overview"], "/inventory/overview"],
  [["vendors"], "/vendors"],
  [["expenses"], "/expenses"],
  [["purchase-orders"], "/purchase-orders"],
  [["purchase-requests"], "/purchase-requests"],
  [["people"], "/people"],
  [["risks"], "/risks"],
  [["playbooks"], "/playbooks"],
  [["recipes"], "/recipes"],
  [["documents", "all"], "/documents"],
  [["reports-analytics"], "/reports/analytics"],
];
let warmed = false;

interface Shell {
  workspaceName: string | null;
  permissions: string[];
  allCities: boolean;
  cities: Array<{ id: string; name: string; isHq: boolean }>;
}

interface NavCounts {
  myQueue: number;
  approvals: number;
  overdueInvoices: number;
  lowStock: number;
  myWork: number;
  chatUnread: number;
  mailUnread: number;
}

type CountKey = keyof NavCounts;

type NavItem = {
  href: string;
  icon: string;
  label: string | ((s: Shell) => string);
  /** Shown only to people holding this permission (the one its screen requires). */
  perm?: string;
  /** Or, where a screen is role-gated rather than permission-gated. */
  roles?: string[];
  count?: CountKey;
  /** Red badge — something is wrong, not merely waiting. */
  hot?: boolean;
};

/**
 * The reference design's navigation, mapped onto the screens Podium has.
 * Reference entries with no backing data yet (Knowledge, Audit log,
 * Settings…) are left out rather than shown empty.
 */
/** The three roles whose remit is the whole organisation (mirrors apps/api/src/common/rbac/model.ts). */
const ORG_WIDE_ROLES = ["Superadmin", "Admin", "Founder"];

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "",
    items: [
      { href: "/dashboard", icon: "⌂", label: "Home" },
      { href: "/my-work", icon: "◔", label: "My Work", count: "myWork" },
      { href: "/flows", icon: "⇢", label: "Flows", perm: "flows:view", count: "myQueue", hot: true },
      { href: "/chat", icon: "✎", label: "Chat", count: "chatUnread", hot: true },
      { href: "/mail", icon: "✉", label: "Mail", count: "mailUnread", hot: true },
      { href: "/calendar", icon: "▤", label: "Calendar" },
      { href: "/meetings", icon: "☰", label: "Meetings · Meet", perm: "tasks:view" },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/projects", icon: "◧", label: "Projects", perm: "projects:view" },
      { href: "/tasks", icon: "☑", label: "Tasks", perm: "tasks:view" },
      { href: "/timeline", icon: "≋", label: "Timeline", perm: "projects:view" },
      { href: "/event-day", icon: "◉", label: "Event day", perm: "tasks:view" },
      { href: "/resources", icon: "◫", label: "Resources", perm: "people:view" },
      { href: "/risks", icon: "⚠", label: "Risks & Issues", perm: "risks:view" },
    ],
  },
  {
    label: "Bar & stock",
    items: [
      { href: "/inventory", icon: "▣", label: "Inventory", perm: "inventory:view", count: "lowStock", hot: true },
      { href: "/menu", icon: "◇", label: "Requirements", perm: "recipes:view" },
      { href: "/procurement", icon: "▧", label: "Procurement", perm: "inventory:view" },
      { href: "/vendors", icon: "⚙", label: "Vendors", perm: "vendors:view" },
      { href: "/products", icon: "◈", label: "Products", perm: "products:view" },
    ],
  },
  {
    label: "Revenue & money",
    items: [
      { href: "/pipeline", icon: "◎", label: "CRM / Pipeline", perm: "leads:view" },
      { href: "/leads", icon: "☍", label: "Leads", perm: "leads:view" },
      { href: "/clients", icon: "☺", label: "Clients", perm: "clients:view" },
      { href: "/invoices", icon: "₹", label: "Invoices", perm: "invoices:view", count: "overdueInvoices", hot: true },
      // Company money. Gated on reports:*, which only Finance and the three
      // organisation-wide roles hold — projects:view, which every Project
      // Manager holds, used to be enough to open the company P&L.
      { href: "/reports", icon: "▥", label: (s) => `P&L · ${s.cities.length} cities`, perm: "reports:view" },
      { href: "/finance", icon: "≡", label: "Project finance", perm: "reports:view" },
      { href: "/expenses", icon: "▭", label: "Expenses", perm: "expenses:view" },
    ],
  },
  {
    label: "People & governance",
    items: [
      { href: "/people", icon: "☷", label: "People", perm: "people:view" },
      // The freelance crew has its own resource, so Operations can book and
      // task bartenders without being handed every employee record.
      { href: "/bartenders", icon: "♟", label: "Bartenders", perm: "freelancers:view" },
      { href: "/compliance", icon: "§", label: "Compliance", perm: "licences:view" },
      { href: "/approvals", icon: "✓", label: "Approvals", perm: "approvals:view", count: "approvals" },
      { href: "/documents", icon: "▤", label: "Documents", perm: "documents:view" },
      { href: "/letters", icon: "✉", label: "Letters & agreements", perm: "documents:create" },
      { href: "/analytics", icon: "▥", label: "Reports", perm: "reports:view" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/knowledge", icon: "▦", label: "Knowledge / SOPs" },
      { href: "/playbooks", icon: "❧", label: "Playbooks", perm: "playbooks:view" },
      { href: "/automation", icon: "⌁", label: "Automation", perm: "automation:view" },
      // The log spans every city and person, so it follows the same two roles
      // that may reset passwords.
      { href: "/audit", icon: "◷", label: "Audit log", roles: ORG_WIDE_ROLES },
      { href: "/settings", icon: "⚒", label: "Settings" },
      // This screen exists to reset passwords, and only a Superadmin may do
      // that — so only a Superadmin is offered the screen.
      { href: "/team", icon: "☷", label: "Team & logins", roles: ["Superadmin"] },
    ],
  },
];

/**
 * Every gated screen, by route — derived from the navigation above, so the
 * sidebar and the guard can never disagree. The longest matching prefix
 * wins, so /projects/<id> inherits /projects.
 */
const ROUTE_RULES: NavItem[] = NAV_GROUPS.flatMap((g) => g.items).filter((i) => i.perm || i.roles);

function ruleFor(pathname: string | null): NavItem | undefined {
  if (!pathname) return undefined;
  return ROUTE_RULES.filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`)).sort((a, b) => b.href.length - a.href.length)[0];
}

/** Shown in place of a screen this person has no permission for. */
function NoAccess() {
  return (
    <div className="panel" style={{ maxWidth: 560, margin: "48px auto", textAlign: "center" }}>
      <div className="panel-title">This screen is not yours</div>
      <p className="muted" style={{ marginTop: 8 }}>
        Your role does not include this part of Podium. If you need it for your work, ask an administrator to change your
        role — the sidebar always shows everything you can open.
      </p>
    </div>
  );
}

type Creating = "task" | "project" | "risk" | null;

/** Data about the person or workspace, not any one city — kept when the city switcher changes. */
const CITY_INDEPENDENT = new Set(["shell", "directory", "cities", "nav-counts"]);

export function AppShell({ children, crumb }: { children: ReactNode; crumb: string }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();

  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menu, setMenu] = useState<"new" | "user" | null>(null);
  const [creating, setCreating] = useState<Creating>(null);
  const [cityId, setCityId] = useState<string | null>(() => getScopeCityId());

  const shell = useQuery({ queryKey: ["shell"], queryFn: () => api.get<Shell>("/users/me/shell"), enabled: !!user, staleTime: 30 * 60_000 });

  // Once per page load, when the browser is idle: fetch every screen's code
  // (so a click never waits on it) and warm the main screens' data two at a
  // time — gently, so it never competes with what the person is doing.
  useEffect(() => {
    if (!shell.data || warmed) return;
    warmed = true;
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    const idle = (fn: () => void) => (w.requestIdleCallback ? w.requestIdleCallback(fn) : window.setTimeout(fn, 800));
    idle(() => {
      for (const g of NAV_GROUPS) for (const item of g.items) router.prefetch(item.href);
      const queue = [...WARM];
      const worker = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const [queryKey, url] = next;
          await qc.prefetchQuery({ queryKey, queryFn: () => api.get(url) }).catch(() => undefined);
        }
      };
      void Promise.all([worker(), worker()]);
    });
  }, [shell.data, qc, router]);

  // Every page renders its own AppShell, so the sidebar remounts on each
  // navigation and would jump back to the top. Keep its scroll position for
  // the tab; losing it (storage blocked) only means starting at the top.
  const sidebarRef = useRef<HTMLElement>(null);
  const hasNav = !!shell.data;
  useLayoutEffect(() => {
    if (!hasNav || !sidebarRef.current) return;
    try {
      const saved = Number(sessionStorage.getItem(SIDEBAR_SCROLL_KEY));
      if (saved > 0) sidebarRef.current.scrollTop = saved;
    } catch {
      // storage unavailable
    }
  }, [hasNav]);
  const rememberSidebarScroll = useCallback((e: React.UIEvent<HTMLElement>) => {
    try {
      sessionStorage.setItem(SIDEBAR_SCROLL_KEY, String(e.currentTarget.scrollTop));
    } catch {
      // storage unavailable
    }
  }, []);
  const counts = useQuery({
    queryKey: ["nav-counts"],
    queryFn: () => api.get<NavCounts>("/dashboard/nav-counts"),
    enabled: !!user,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  // Something new landed while working elsewhere: a chat message (unless the
  // chat is open — it pops there itself), or a new approval, flow step, work
  // item or e-mail. The first reading only sets the baseline.
  const lastCounts = useRef<NavCounts | null>(null);
  useEffect(() => {
    const c = counts.data;
    if (!c) return;
    const p = lastCounts.current;
    if (p) {
      if (c.chatUnread > p.chatUnread && !pathname?.startsWith("/chat")) playSound("message");
      else if (c.approvals > p.approvals || c.myQueue > p.myQueue || c.myWork > p.myWork || c.mailUnread > p.mailUnread) playSound("notify");
    }
    lastCounts.current = c;
  }, [counts.data, pathname]);

  const [soundOn, setSoundOn] = useState(true);
  useEffect(() => {
    const sync = () => setSoundOn(soundsEnabled());
    sync();
    window.addEventListener("podium-sounds", sync);
    return () => window.removeEventListener("podium-sounds", sync);
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace("/login");
  }, [loading, user, router]);

  // Close the drawer / menus whenever the page changes.
  useEffect(() => {
    setNavOpen(false);
    setMenu(null);
  }, [pathname]);

  // ⌘K / Ctrl+K opens search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const changeCity = useCallback(
    (next: string | null) => {
      setScopeCityId(next);
      setCityId(next);
      // Every cached list was fetched for the old scope — drop them all so
      // nothing from the previous city is shown even for a moment.
      void qc.resetQueries({ predicate: (q) => !CITY_INDEPENDENT.has(String(q.queryKey[0])) });
    },
    [qc],
  );

  // A remembered city this person can no longer access is forgotten.
  const cities = shell.data?.cities;
  useEffect(() => {
    if (cities && cityId && !cities.some((c) => c.id === cityId)) changeCity(null);
  }, [cities, cityId, changeCity]);

  const perms = useMemo(() => new Set(shell.data?.permissions ?? []), [shell.data]);
  const can = useCallback((p?: string) => !p || perms.has(p), [perms]);
  const visible = useCallback(
    (item: NavItem) => !!user && (item.roles ? item.roles.some((r) => user.roles.includes(r)) : can(item.perm)),
    [user, can],
  );

  const newOptions = useMemo(() => {
    const opts: Array<{ icon: string; label: string; hint: string; perm: string; run: () => void }> = [
      { icon: "☑", label: "Task", hint: "Assign a one-off task on a project", perm: "tasks:create", run: () => setCreating("task") },
      { icon: "◧", label: "Project", hint: "A new event for a client", perm: "projects:create", run: () => setCreating("project") },
      { icon: "⚠", label: "Risk", hint: "Flag something that could go wrong", perm: "risks:create", run: () => setCreating("risk") },
      { icon: "⇢", label: "Flow", hint: "Chain of steps that hand off automatically", perm: "flows:create", run: () => router.push("/flows") },
      { icon: "₹", label: "Invoice", hint: "GST invoice for any city", perm: "invoices:create", run: () => router.push("/invoices/new") },
      { icon: "▧", label: "Purchase request", hint: "Ask for stock or equipment", perm: "inventory:create", run: () => router.push("/procurement/requests/new") },
      { icon: "▭", label: "Expense claim", hint: "Submit a reimbursement", perm: "expenses:create", run: () => router.push("/expenses") },
      { icon: "✉", label: "Letter or agreement", hint: "Offer letter, NDA, agreement — as PDF", perm: "documents:create", run: () => router.push("/letters") },
    ];
    return opts.filter((o) => perms.has(o.perm));
  }, [perms, router]);

  const commands: PaletteCommand[] = useMemo(() => {
    if (!shell.data) return [];
    const go: PaletteCommand[] = NAV_GROUPS.flatMap((g) =>
      g.items.filter(visible).map((item) => {
        const label = typeof item.label === "function" ? item.label(shell.data) : item.label;
        return { id: `go:${item.href}`, icon: item.icon, label, group: "Go to" as const, run: () => router.push(item.href) };
      }),
    );
    const make: PaletteCommand[] = newOptions.map((o) => ({ id: `new:${o.label}`, icon: o.icon, label: `New ${o.label.toLowerCase()}`, group: "Create" as const, run: o.run }));
    return [...make, ...go];
  }, [shell.data, visible, newOptions, router]);

  if (loading || !user) {
    // The empty frame of the app rather than a "Loading…" message: on a
    // first visit this shows for the one /users/me round trip; afterwards the
    // cached profile draws the real shell before the first paint.
    return (
      <div id="app" aria-busy="true">
        <aside className="sidebar" />
        <header className="topbar" />
        <main className="main" />
      </div>
    );
  }

  const s = shell.data;
  const hq = s?.cities.find((c) => c.isHq);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const isActive = (href: string) => pathname === href || !!pathname?.startsWith(`${href}/`);
  /**
   * Whether this person may be on this screen at all.
   *
   * The API refuses the data either way — this is not the control, it is the
   * explanation. Without it, typing the URL of a screen you lack access to
   * gives you a half-drawn page full of failed requests instead of a plain
   * statement that the screen is not yours.
   *
   * Decided only once the shell has loaded: until permissions are known,
   * nothing is assumed forbidden.
   */
  const rule = ruleFor(pathname);
  const allowedHere = !s || !rule || (rule.roles ? rule.roles.some((r) => user.roles.includes(r)) : can(rule.perm));

  return (
    <div id="app">
      <aside ref={sidebarRef} onScroll={rememberSidebarScroll} className={`sidebar ${navOpen ? "open" : ""}`}>
        <div className="brandmark">
          <div className="mark">P</div>
          <div className="names">
            <div className="company">Podium</div>
            <div className="sub">{s?.workspaceName ?? " "}</div>
          </div>
        </div>
        {s?.workspaceName && (
          <div className="workspace-switch" title="The workspace you are signed in to">
            <span>
              Workspace: <b>{s.workspaceName}</b>
            </span>
          </div>
        )}

        {s &&
          NAV_GROUPS.map((group, i) => {
            const items = group.items.filter(visible);
            if (items.length === 0) return null;
            return (
              <div className="navgroup" key={i}>
                {group.label && <div className="label">{group.label}</div>}
                {items.map((item) => {
                  const n = item.count ? counts.data?.[item.count] ?? 0 : 0;
                  return (
                    <div key={item.href} className={`navitem ${isActive(item.href) ? "active" : ""}`} onMouseEnter={() => router.prefetch(item.href)} onClick={() => router.push(item.href)}>
                      <span className="ic">{item.icon}</span>
                      {typeof item.label === "function" ? item.label(s) : item.label}
                      {n > 0 && (
                        <span key={n} className={`count ${item.hot ? "hot" : ""}`}>
                          {n}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}

        <div className="navfooter">
          <div className="user">
            <div className="avatar">{initials(user.name)}</div> {user.name.split(" ")[0]} · {user.roles[0] ?? "—"}
          </div>
          {s && (
            <div>
              {s.allCities ? `${hq ? `${hq.name} HQ · ` : ""}${s.cities.length} cities` : s.cities.map((c) => c.name).join(" · ")}
            </div>
          )}
          <span className="linkish" onClick={logout} style={{ color: "#9CA0A5" }}>
            Sign out
          </span>
        </div>
      </aside>
      <div className={`nav-backdrop ${navOpen ? "open" : ""}`} onClick={() => setNavOpen(false)} />

      <header className="topbar">
        <button className="tbtn" id="hamburger" onClick={() => setNavOpen((o) => !o)} aria-label="Menu">
          ☰
        </button>
        <div className="crumb">
          <b>{crumb}</b>
        </div>
        <div className="searchbtn" role="button" tabIndex={0} onClick={() => setPaletteOpen(true)} onKeyDown={(e) => e.key === "Enter" && setPaletteOpen(true)}>
          <span>⌕</span>
          <span>Search projects, flows, people, invoices, stock…</span>
          <kbd>{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </div>
        <DeskBuddy name={user.name.split(" ")[0] ?? ""} />
        <div className="topbar-right">
          {s && s.cities.length > 1 && (
            <select className="cityscope" value={cityId ?? ""} onChange={(e) => changeCity(e.target.value || null)} aria-label="City scope" title="Show every screen for one city">
              <option value="">{s.allCities ? "All cities" : "All my cities"}</option>
              {s.cities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {newOptions.length > 0 && (
            <button className="btn-primary" onClick={() => setMenu((m) => (m === "new" ? null : "new"))}>
              + New
            </button>
          )}
          <button className="tbtn" title="Chat" aria-label="Chat" onClick={() => router.push("/chat")}>
            ✎
          </button>
          <NotificationBell />
          <button className="topbar-avatar" onClick={() => setMenu((m) => (m === "user" ? null : "user"))} title={user.name} aria-label="Your account">
            {initials(user.name)}
          </button>
        </div>
      </header>

      {menu && <div style={{ position: "fixed", inset: 0, zIndex: 94 }} onClick={() => setMenu(null)} />}
      {menu === "new" && (
        <div id="new-menu" role="menu">
          <div className="cmdk-head">Create new</div>
          {newOptions.map((o) => (
            <button
              key={o.label}
              className="pcard"
              style={{ textAlign: "left" }}
              onClick={() => {
                setMenu(null);
                o.run();
              }}
            >
              <span style={{ width: 22, textAlign: "center", fontSize: 15 }}>{o.icon}</span>
              <div className="pbar">
                <div className="pname">{o.label}</div>
                <div className="pmeta">{o.hint}</div>
              </div>
            </button>
          ))}
        </div>
      )}
      {menu === "user" && (
        <div id="user-menu" className="open" role="menu">
          <div style={{ padding: "11px 12px", borderBottom: "1px solid var(--line)" }}>
            <div style={{ fontWeight: 600, fontSize: 12.5 }}>{user.name}</div>
            <div className="small muted">
              {user.username ? `@${user.username} · ` : ""}
              {user.roles.join(", ")}
            </div>
            {s && <div className="small muted">{s.allCities ? "All cities" : s.cities.map((c) => c.name).join(", ")}</div>}
          </div>
          {(counts.data?.myQueue ?? 0) > 0 && can("flows:view") && (
            <div className="um-item" onClick={() => router.push("/flows")}>
              ⇢ <span style={{ flex: 1 }}>Your flow steps</span>
              <span className="pill amber">{counts.data!.myQueue} up next</span>
            </div>
          )}
          {can("tasks:view") && (
            <div className="um-item" onClick={() => router.push("/tasks")}>
              ☑ <span>Tasks</span>
            </div>
          )}
          {user.roles.some((r) => r === "Founder" || r === "Superadmin" || r === "Admin") && (
            <div className="um-item" onClick={() => router.push("/team")}>
              ⚒ <span>Team &amp; logins</span>
            </div>
          )}
          <div className="um-item" onClick={() => setSoundsEnabled(!soundOn)}>
            {soundOn ? "🔊" : "🔈"} <span style={{ flex: 1 }}>Sounds</span>
            <span className={`pill ${soundOn ? "green" : "gray"}`}>{soundOn ? "On" : "Off"}</span>
          </div>
          <div className="um-item" onClick={logout}>
            ⎋ <span>Sign out</span>
          </div>
        </div>
      )}

      <main className="main">
        {/* Keyed on the route so each screen plays its entrance. */}
        <div key={pathname} className="page-enter">
          {allowedHere ? children : <NoAccess />}
        </div>
      </main>

      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
      {creating === "task" && <NewTaskModal onClose={() => setCreating(null)} />}
      {creating === "risk" && <NewRiskModal onClose={() => setCreating(null)} />}
      {creating === "project" && <NewProjectModal onClose={() => setCreating(null)} onCreated={(id) => { setCreating(null); router.push(`/projects/${id}`); }} />}
    </div>
  );
}

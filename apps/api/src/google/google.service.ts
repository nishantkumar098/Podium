import { randomUUID } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";
import { GoogleConfigService } from "./google-config.service";
import { GmailProvider, type FetchedMessage } from "./gmail.provider";

@Injectable()
export class GoogleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: GoogleConfigService,
    private readonly gmail: GmailProvider,
  ) {}

  /** What the UI needs to decide whether to show the integration at all. */
  async status(user: RequestUser) {
    const account = await this.prisma.client.googleAccount.findFirst({
      where: { userId: user.id, revokedAt: null },
      select: { googleEmail: true, scopes: true, lastSyncedAt: true, gmailHistoryId: true, createdAt: true },
    });
    return {
      mode: this.config.mode,
      credentialsPresent: this.config.hasCredentials(),
      connected: Boolean(account),
      account,
      scopes: this.config.scopes,
      /** Non-null whenever the integration cannot actually reach Google. */
      blockedReason:
        this.config.mode === "disabled"
          ? "No Google OAuth credentials are configured for this deployment. See docs/integration-setup.md."
          : this.config.mode === "sandbox"
            ? "Sandbox mode: fixture data only. No Google account is contacted and no mail is sent."
            : null,
    };
  }

  /**
   * Builds the Google consent URL. In `disabled` mode this refuses rather than
   * returning a URL that would fail at Google; in `sandbox` it refuses too,
   * because a sandbox that appears to complete an OAuth flow is exactly the
   * fake this module must not be.
   */
  async authUrl(user: RequestUser, state: string) {
    this.config.assertLive();
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: this.config.scopes.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      // Staff sign in by username and usually have no e-mail on file.
      ...(user.email ? { login_hint: user.email } : {}),
      state,
    });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` };
  }

  /**
   * Exchanges an authorization code for tokens. Only reachable in live mode —
   * there is no code path anywhere that writes a GoogleAccount without a real
   * token exchange having succeeded.
   */
  async handleCallback(user: RequestUser, code: string) {
    this.config.assertLive();
    if (!code) throw new BadRequestException("Missing authorization code.");

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) {
      throw new BadRequestException(`Google rejected the authorization code (${res.status}).`);
    }
    const token = (await res.json()) as {
      access_token: string; refresh_token?: string; expires_in: number; scope: string;
    };

    const profile = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const googleEmail = profile.ok ? ((await profile.json()) as { email: string }).email : user.email;
    // The linked Google address is only knowable from Google once the user
    // has no Podium e-mail to fall back on.
    if (!googleEmail) throw new BadRequestException("Google did not return an e-mail address for this account.");

    const account = await this.prisma.client.googleAccount.upsert({
      where: { userId: user.id },
      create: {
        workspaceId: user.workspaceId,
        userId: user.id,
        googleEmail,
        accessTokenEnc: this.config.encryptToken(token.access_token),
        refreshTokenEnc: token.refresh_token ? this.config.encryptToken(token.refresh_token) : null,
        expiresAt: new Date(Date.now() + token.expires_in * 1000),
        scopes: token.scope,
      },
      update: {
        googleEmail,
        accessTokenEnc: this.config.encryptToken(token.access_token),
        ...(token.refresh_token ? { refreshTokenEnc: this.config.encryptToken(token.refresh_token) } : {}),
        expiresAt: new Date(Date.now() + token.expires_in * 1000),
        scopes: token.scope,
        revokedAt: null,
      },
    });

    await this.prisma.client.auditLog.create({
      data: {
        workspaceId: user.workspaceId, actorId: user.id, action: "google.connected",
        entityType: "google_account", entityId: account.id,
        // The e-mail address, never a token.
        after: { googleEmail, scopes: token.scope },
      },
    });
    return { connected: true, googleEmail };
  }

  async disconnect(user: RequestUser) {
    const account = await this.prisma.client.googleAccount.findFirst({ where: { userId: user.id, revokedAt: null } });
    if (!account) throw new NotFoundException("No Google account is connected.");
    await this.prisma.client.googleAccount.update({
      where: { id: account.id },
      data: { revokedAt: new Date(), accessTokenEnc: "", refreshTokenEnc: null },
    });
    await this.prisma.client.auditLog.create({
      data: {
        workspaceId: user.workspaceId, actorId: user.id, action: "google.disconnected",
        entityType: "google_account", entityId: account.id, after: { googleEmail: account.googleEmail },
      },
    });
    return { connected: false };
  }

  /**
   * Incremental sync. The linking logic below is the part worth having now: it
   * matches a message's sender against real clients, vendors and leads by
   * e-mail, and it runs identically in sandbox and live mode.
   */
  async sync(user: RequestUser) {
    this.config.assertEnabled();

    let accessToken = "";
    let historyId: string | null = null;
    let accountId: string | null = null;

    if (this.config.mode === "live") {
      const account = await this.prisma.client.googleAccount.findFirst({ where: { userId: user.id, revokedAt: null } });
      if (!account) throw new BadRequestException("Connect a Google account before syncing.");
      accessToken = await this.accessTokenFor(account);
      historyId = account.gmailHistoryId;
      accountId = account.id;
    } else {
      // Sandbox keeps its cursor on the account row if one exists, else starts
      // from zero. It never needs a token.
      const account = await this.prisma.client.googleAccount.findFirst({ where: { userId: user.id, revokedAt: null } });
      historyId = account?.gmailHistoryId ?? null;
      accountId = account?.id ?? null;
    }

    const { messages, historyId: nextHistoryId } = await this.gmail.fetchSince(accessToken, historyId);
    const linked = await this.linkAndStore(user, messages);

    if (accountId) {
      await this.prisma.client.googleAccount.update({
        where: { id: accountId },
        data: { gmailHistoryId: nextHistoryId, lastSyncedAt: new Date() },
      });
    }

    return { mode: this.config.mode, fetched: messages.length, ...linked, nextHistoryId };
  }

  /**
   * Stores messages and links each to whatever real record owns the sender's
   * address. Matching is exact and case-insensitive on the e-mail — a fuzzy
   * match here would silently file a stranger's mail under a real client.
   */
  private async linkAndStore(user: RequestUser, messages: FetchedMessage[]) {
    let created = 0;
    let alreadyPresent = 0;
    const links = { client: 0, vendor: 0, lead: 0, unlinked: 0 };

    for (const m of messages) {
      const existing = await this.prisma.client.email.findUnique({ where: { gmailMessageId: m.gmailMessageId } });
      if (existing) {
        alreadyPresent++; // incremental sync replays are normal, not an error
        continue;
      }
      const from = m.fromAddress.toLowerCase();
      const [client, vendor, lead] = await Promise.all([
        this.prisma.client.client.findFirst({ where: { workspaceId: user.workspaceId, email: { equals: from, mode: "insensitive" } }, select: { id: true } }),
        this.prisma.client.vendor.findFirst({ where: { workspaceId: user.workspaceId, email: { equals: from, mode: "insensitive" } }, select: { id: true } }),
        this.prisma.client.lead.findFirst({ where: { workspaceId: user.workspaceId, email: { equals: from, mode: "insensitive" } }, select: { id: true } }),
      ]);
      if (client) links.client++;
      else if (vendor) links.vendor++;
      else if (lead) links.lead++;
      else links.unlinked++;

      await this.prisma.client.email.create({
        data: {
          workspaceId: user.workspaceId,
          isSandbox: this.config.mode === "sandbox",
          gmailMessageId: m.gmailMessageId,
          threadId: m.threadId,
          fromAddress: m.fromAddress,
          subject: m.subject,
          snippet: m.snippet,
          receivedAt: m.receivedAt,
          isUnread: m.isUnread,
          linkedClientId: client?.id ?? null,
          linkedVendorId: vendor?.id ?? null,
          linkedLeadId: lead?.id ?? null,
        },
      });
      created++;
    }
    return { created, alreadyPresent, links };
  }

  /**
   * The shared inbox, newest first. Each message carries the name of the
   * client, vendor or lead its sender was matched to, so the list reads
   * "Taj Lake Palace · Re: bar menu" rather than a bare address.
   */
  async listEmails(user: RequestUser, limit = 50) {
    this.config.assertEnabled();
    const db = this.prisma.client;
    const rows = await db.email.findMany({
      where: { workspaceId: user.workspaceId, isSandbox: this.config.mode === "sandbox" },
      orderBy: { receivedAt: "desc" },
      take: Math.min(limit, 200),
    });
    const ids = (k: "linkedClientId" | "linkedVendorId" | "linkedLeadId") => [...new Set(rows.map((r) => r[k]).filter((x): x is string => !!x))];
    const [clients, vendors, leads] = await Promise.all([
      db.client.findMany({ where: { id: { in: ids("linkedClientId") } }, select: { id: true, name: true } }),
      db.vendor.findMany({ where: { id: { in: ids("linkedVendorId") } }, select: { id: true, name: true } }),
      db.lead.findMany({ where: { id: { in: ids("linkedLeadId") } }, select: { id: true, name: true } }),
    ]);
    const name = new Map([...clients, ...vendors, ...leads].map((x) => [x.id, x.name]));
    return rows.map((r) => ({
      ...r,
      linkedTo: r.linkedClientId
        ? { kind: "client", id: r.linkedClientId, name: name.get(r.linkedClientId) ?? "" }
        : r.linkedVendorId
          ? { kind: "vendor", id: r.linkedVendorId, name: name.get(r.linkedVendorId) ?? "" }
          : r.linkedLeadId
            ? { kind: "lead", id: r.linkedLeadId, name: name.get(r.linkedLeadId) ?? "" }
            : null,
    }));
  }

  /** Marks a message read in Podium (the Gmail scopes are read-only, so Gmail itself is untouched). */
  async markRead(user: RequestUser, id: string) {
    this.config.assertEnabled();
    const res = await this.prisma.client.email.updateMany({ where: { id, workspaceId: user.workspaceId }, data: { isUnread: false } });
    if (res.count === 0) throw new NotFoundException("Message not found.");
    return { ok: true };
  }

  /** Unread count for the sidebar — 0 whenever the integration is off, never an error. */
  async unreadCount(user: RequestUser): Promise<number> {
    if (this.config.mode === "disabled") return 0;
    return this.prisma.client.email.count({ where: { workspaceId: user.workspaceId, isUnread: true, isSandbox: this.config.mode === "sandbox" } });
  }

  /** Sends from the caller's own connected Google account. */
  async sendEmail(user: RequestUser, to: string, subject: string, body: string) {
    this.config.assertLive();
    const account = await this.requireAccount(user);
    const accessToken = await this.accessTokenFor(account);
    const sent = await this.gmail.send(accessToken, to, subject, body);
    await this.prisma.client.auditLog.create({
      data: {
        workspaceId: user.workspaceId,
        actorId: user.id,
        action: "email.sent",
        entityType: "email",
        entityId: sent.id,
        // Recipient and subject only — never the message body.
        after: { to, subject: subject.slice(0, 140), from: account.googleEmail },
      },
    });
    return { sent: true, id: sent.id };
  }

  /**
   * Creates a Google Calendar event on the caller's calendar with a Meet
   * conference attached, and returns the real Meet link Google issued
   * (Calendar API v3 events.insert, conferenceDataVersion=1).
   */
  async createMeetEvent(user: RequestUser, input: { title: string; startsAt: Date; durationMinutes: number; description?: string }): Promise<string> {
    this.config.assertLive();
    const account = await this.requireAccount(user);
    const accessToken = await this.accessTokenFor(account);
    const end = new Date(input.startsAt.getTime() + input.durationMinutes * 60_000);
    const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: input.title,
        description: input.description,
        start: { dateTime: input.startsAt.toISOString(), timeZone: "Asia/Kolkata" },
        end: { dateTime: end.toISOString(), timeZone: "Asia/Kolkata" },
        conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
      }),
    });
    const event = (await res.json().catch(() => null)) as { hangoutLink?: string; error?: { message?: string } } | null;
    if (!res.ok) throw new ServiceUnavailableException(`Google Calendar refused the event (${res.status}): ${event?.error?.message ?? res.statusText}`);
    if (!event?.hangoutLink) throw new ServiceUnavailableException("Google created the event but returned no Meet link.");
    return event.hangoutLink;
  }

  // ---------------------------------------------------------------- tokens

  private async requireAccount(user: RequestUser) {
    const account = await this.prisma.client.googleAccount.findFirst({ where: { userId: user.id, revokedAt: null } });
    if (!account) throw new BadRequestException("Connect your Google account first (Mail → Connect Google).");
    return account;
  }

  /**
   * A usable access token for the account. Google access tokens last an
   * hour; a stale one is renewed with the stored refresh token (OAuth 2.0
   * refresh_token grant) and the new one saved, encrypted, before use.
   */
  private async accessTokenFor(account: { id: string; accessTokenEnc: string; refreshTokenEnc: string | null; expiresAt: Date }): Promise<string> {
    if (account.expiresAt.getTime() - Date.now() > 60_000) return this.config.decryptToken(account.accessTokenEnc);
    if (!account.refreshTokenEnc) {
      throw new BadRequestException("Your Google session has expired. Reconnect Google from the Mail screen.");
    }
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.decryptToken(account.refreshTokenEnc),
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new BadRequestException("Google did not renew access (the connection may have been revoked). Reconnect Google from the Mail screen.");
    const token = (await res.json()) as { access_token: string; expires_in: number };
    await this.prisma.client.googleAccount.update({
      where: { id: account.id },
      data: { accessTokenEnc: this.config.encryptToken(token.access_token), expiresAt: new Date(Date.now() + token.expires_in * 1000) },
    });
    return token.access_token;
  }
}

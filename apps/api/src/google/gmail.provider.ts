import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { GoogleConfigService } from "./google-config.service";

/**
 * One normalized message shape, whatever the source. The real Gmail provider
 * and the sandbox provider both produce this, so the sync logic that links
 * messages to clients/projects/vendors is identical in both modes and is
 * therefore actually exercised by the sandbox tests.
 */
export interface FetchedMessage {
  gmailMessageId: string;
  threadId: string;
  fromAddress: string;
  subject: string;
  snippet: string;
  receivedAt: Date;
  isUnread: boolean;
}

export interface FetchResult {
  messages: FetchedMessage[];
  /** Gmail's cursor for the next incremental call. */
  historyId: string | null;
}

export abstract class GmailProvider {
  abstract fetchSince(accessToken: string, historyId: string | null): Promise<FetchResult>;
  abstract send(accessToken: string, to: string, subject: string, body: string): Promise<{ id: string }>;
}

/**
 * Sandbox: a small, fixed set of obviously-synthetic messages, addressed from
 * example.invalid so they can never be confused with real correspondence.
 * Makes no network call and needs no credentials. Every row it produces is
 * written with `isSandbox = true`.
 */
@Injectable()
export class SandboxGmailProvider extends GmailProvider {
  async fetchSince(_accessToken: string, historyId: string | null): Promise<FetchResult> {
    const base = Number(historyId ?? 0);
    const now = Date.now();
    const messages: FetchedMessage[] = [
      {
        gmailMessageId: `sandbox-${base + 1}`,
        threadId: `sandbox-thread-${base + 1}`,
        fromAddress: "sandbox.sender@example.invalid",
        subject: "[SANDBOX] Enquiry about bar setup",
        snippet: "This is sandbox fixture data, not a real e-mail.",
        receivedAt: new Date(now - 3_600_000),
        isUnread: true,
      },
      {
        gmailMessageId: `sandbox-${base + 2}`,
        threadId: `sandbox-thread-${base + 2}`,
        fromAddress: "sandbox.vendor@example.invalid",
        subject: "[SANDBOX] Quotation attached",
        snippet: "This is sandbox fixture data, not a real e-mail.",
        receivedAt: new Date(now - 1_800_000),
        isUnread: true,
      },
    ];
    return { messages, historyId: String(base + 2) };
  }

  async send(): Promise<{ id: string }> {
    throw new ServiceUnavailableException(
      "Sandbox mode never sends mail. Configure real credentials and GOOGLE_INTEGRATION_MODE=live to send.",
    );
  }
}

/**
 * Live: real calls to the Gmail REST API (v1), per Google's published
 * reference. Written to that reference but — until AMM Brands supplies OAuth
 * credentials — never yet run against a real mailbox; GOOGLE_INTEGRATION_MODE
 * stays `disabled` until it can be, so nothing here runs by accident.
 *
 *   first sync     GET users/me/messages?q=newer_than:30d   (ids)
 *   incremental    GET users/me/history?startHistoryId=…&historyTypes=messageAdded
 *                  (404 = cursor expired -> fall back to the first-sync path)
 *   each message   GET users/me/messages/{id}?format=metadata
 *   cursor         GET users/me/profile -> historyId
 *   send           POST users/me/messages/send { raw: base64url(RFC 2822) }
 */
@Injectable()
export class LiveGmailProvider extends GmailProvider {
  private static readonly BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
  private static readonly MAX_PER_SYNC = 50;

  constructor(private readonly config: GoogleConfigService) {
    super();
  }

  private async call<T>(accessToken: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: T | null }> {
    const res = await fetch(`${LiveGmailProvider.BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const body = res.status === 204 ? null : ((await res.json().catch(() => null)) as T | null);
    if (!res.ok && res.status !== 404) {
      const message = (body as { error?: { message?: string } } | null)?.error?.message ?? res.statusText;
      throw new ServiceUnavailableException(`Gmail refused the request (${res.status}): ${message}`);
    }
    return { status: res.status, body };
  }

  async fetchSince(accessToken: string, historyId: string | null): Promise<FetchResult> {
    this.config.assertLive();
    let ids: string[] | null = null;

    if (historyId) {
      const { status, body } = await this.call<{ history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }> }>(
        accessToken,
        `/history?startHistoryId=${encodeURIComponent(historyId)}&historyTypes=messageAdded&labelId=INBOX&maxResults=${LiveGmailProvider.MAX_PER_SYNC}`,
      );
      if (status !== 404) {
        ids = [...new Set((body?.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((m) => m.message.id)))];
      }
    }
    if (ids === null) {
      const { body } = await this.call<{ messages?: Array<{ id: string }> }>(
        accessToken,
        `/messages?q=${encodeURIComponent("newer_than:30d in:inbox")}&maxResults=${LiveGmailProvider.MAX_PER_SYNC}`,
      );
      ids = (body?.messages ?? []).map((m) => m.id);
    }

    const messages: FetchedMessage[] = [];
    for (const id of ids.slice(0, LiveGmailProvider.MAX_PER_SYNC)) {
      const { status, body } = await this.call<{
        id: string;
        threadId: string;
        snippet?: string;
        internalDate?: string;
        labelIds?: string[];
        payload?: { headers?: Array<{ name: string; value: string }> };
      }>(accessToken, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
      if (status === 404 || !body) continue; // deleted between listing and fetching
      const header = (n: string) => body.payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? "";
      const from = header("from");
      messages.push({
        gmailMessageId: body.id,
        threadId: body.threadId,
        // "Name <addr@x>" -> addr@x, so sender linking matches on the address.
        fromAddress: (/<([^>]+)>/.exec(from)?.[1] ?? from).trim(),
        subject: header("subject") || "(no subject)",
        snippet: decodeEntities(body.snippet ?? ""),
        receivedAt: new Date(Number(body.internalDate ?? Date.now())),
        isUnread: (body.labelIds ?? []).includes("UNREAD"),
      });
    }

    const { body: profile } = await this.call<{ historyId?: string }>(accessToken, "/profile");
    return { messages, historyId: profile?.historyId ?? historyId };
  }

  async send(accessToken: string, to: string, subject: string, body: string): Promise<{ id: string }> {
    this.config.assertLive();
    const mime = [
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(body, "utf8").toString("base64"),
    ].join("\r\n");
    const raw = Buffer.from(mime, "utf8").toString("base64url");
    const { body: sent } = await this.call<{ id: string }>(accessToken, "/messages/send", { method: "POST", body: JSON.stringify({ raw }) });
    if (!sent?.id) throw new ServiceUnavailableException("Gmail did not confirm the message was sent.");
    return { id: sent.id };
  }
}

/** Gmail snippets arrive HTML-escaped ("&#39;", "&amp;"). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

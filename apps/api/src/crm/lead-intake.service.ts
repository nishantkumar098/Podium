import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@podium/db";
import { createHash, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../common/prisma/prisma.service";

/**
 * Where leads from outside Podium arrive.
 *
 * ONE DOOR, MANY SOURCES. The website form, Meta lead ads, Google Ads lead
 * forms, IndiaMART, a Zapier bridge — all of them POST the same shape to the
 * same endpoint with their own key. Adding a source is then a key and a
 * mapping, not a deployment.
 *
 * THE PART THAT MATTERS IS NOT RECEIVING, IT IS DEDUPE.
 *
 * `leads` has a unique index on (workspace, phone). This database holds
 * 12,381 cold prospects scraped from bar, hotel and trade-show lists. The
 * single most valuable enquiry AMM can receive is someone who is ALREADY on
 * one of those lists deciding, on their own, to fill in the form — and a
 * naive `create()` would fail on that exact person with a constraint error
 * and drop them.
 *
 * So an arriving lead is an upsert:
 *
 *   matches a COLD_PROSPECT  -> promote it to PIPELINE, keep its history,
 *                               stamp the new source. The scraped row becomes
 *                               a live opportunity.
 *   matches a PIPELINE lead  -> record the new enquiry on it and leave the
 *                               stage alone. Somebody is already working
 *                               this; a second form fill is a signal, not a
 *                               new deal.
 *   matches nothing          -> a new PIPELINE lead at stage LEAD.
 *
 * Every arrival, including the duplicates, is appended to `intakeDetail.
 * enquiries` so the raw payload is never lost — if a mapping is wrong, the
 * original is still there to re-read.
 */

export interface IntakePayload {
  name?: string | null;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
  eventType?: string | null;
  eventDate?: string | null;
  pax?: number | null;
  location?: string | null;
  message?: string | null;
  /** Anything the form sends that Podium has no column for. */
  extra?: Record<string, unknown>;
  /** The sending system's own id, so a retry cannot create a second lead. */
  externalRef?: string | null;
}

export type IntakeOutcome = "created" | "promoted" | "merged" | "duplicate";

@Injectable()
export class LeadIntakeService {
  private readonly log = new Logger("LeadIntake");

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Source keys, read from LEAD_INTAKE_KEYS as `source:key` pairs separated
   * by commas — for example
   *   LEAD_INTAKE_KEYS=hospitality-plus:abc123,meta-ads:def456
   *
   * One key per source rather than one shared key, so a key that leaks with
   * a website template can be revoked without silencing every other channel.
   */
  private keys(): Map<string, string> {
    /**
     * Quotes are stripped, from the whole value and from each part.
     *
     * A `.env` file loader removes them; a hosting panel's environment-
     * variable box does not — whatever you type is the literal value. Typing
     * `"hospitality-plus:abc123"` there produced a source whose key was
     * `abc123"`, which parsed fine, counted as configured, and then failed
     * every comparison. The symptom was "Unrecognised intake key", which
     * points at the caller rather than at the trailing quote that actually
     * caused it.
     */
    const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "").trim();
    const raw = unquote(process.env.LEAD_INTAKE_KEYS ?? "");
    const out = new Map<string, string>();
    for (const pair of raw.split(",")) {
      const [source, key] = pair.split(":").map(unquote);
      if (source && key) out.set(source, key);
    }
    return out;
  }

  /**
   * Which source this key belongs to, or a refusal.
   *
   * Compared with `timingSafeEqual` over hashes: a plain `===` on secrets
   * leaks their length and, over enough requests, their content. Hashing
   * first keeps both sides the same length so the comparison is defined.
   */
  sourceForKey(key: string | undefined): string {
    if (!key) throw new ForbiddenException("Missing intake key.");
    const configured = this.keys();

    /**
     * "No sources configured" and "that key is wrong" are completely
     * different problems — one is a server that was never set up, the other
     * is a caller with the wrong secret — and they used to produce the same
     * message, which cost an afternoon of guessing. They are now told apart.
     *
     * Saying "not configured" to an unauthenticated caller reveals nothing
     * worth having: it says a feature is switched off, not how to switch it
     * on. The key itself, and even how many exist, stay unsaid.
     */
    if (configured.size === 0) {
      this.log.error("LEAD_INTAKE_KEYS is unset or malformed — every intake request will be refused.");
      throw new ForbiddenException("Lead intake is not configured on this server.");
    }

    const digest = (v: string) => createHash("sha256").update(v).digest();
    const given = digest(key);
    for (const [source, expected] of configured) {
      if (timingSafeEqual(given, digest(expected))) return source;
    }
    throw new ForbiddenException("Unrecognised intake key.");
  }

  /** Last ten digits — how every phone in this database is already stored. */
  private normalisePhone(raw: string | null | undefined): string | null {
    const digits = (raw ?? "").replace(/\D/g, "");
    return digits.length >= 10 ? digits.slice(-10) : null;
  }

  private parseDate(raw: string | null | undefined): { date: Date | null; text: string | null } {
    const text = (raw ?? "").trim();
    if (!text) return { date: null, text: null };
    const parsed = new Date(text);
    // An unparseable date is kept as written rather than guessed at — the
    // same rule the spreadsheet importers follow.
    return Number.isNaN(parsed.getTime()) ? { date: null, text } : { date: parsed, text: null };
  }

  async receive(source: string, payload: IntakePayload): Promise<{ outcome: IntakeOutcome; leadId: string }> {
    const workspace = await this.prisma.client.workspace.findFirst({ where: { deletedAt: null }, select: { id: true } });
    if (!workspace) throw new ForbiddenException("No workspace.");
    const db = this.prisma.client;

    const phone = this.normalisePhone(payload.phone);
    const email = payload.email?.trim().toLowerCase() || null;
    const name = (payload.name || payload.company || payload.contactName || "Website enquiry").trim();
    const { date: eventDate, text: eventDateText } = this.parseDate(payload.eventDate);
    const externalRef = payload.externalRef ? `${source}:${payload.externalRef}` : null;

    const enquiry = {
      at: new Date().toISOString(),
      source,
      ...(payload.message ? { message: payload.message } : {}),
      ...(payload.eventType ? { eventType: payload.eventType } : {}),
      ...(payload.pax ? { pax: payload.pax } : {}),
      ...(payload.location ? { location: payload.location } : {}),
      ...(payload.extra && Object.keys(payload.extra).length ? { extra: payload.extra } : {}),
    };

    // An idempotency hit is answered without doing any work — the sending
    // system retried, it did not send a second enquiry.
    if (externalRef) {
      const seen = await db.lead.findFirst({ where: { workspaceId: workspace.id, externalRef }, select: { id: true } });
      if (seen) return { outcome: "duplicate", leadId: seen.id };
    }

    const existing = phone
      ? await db.lead.findFirst({ where: { workspaceId: workspace.id, phone }, select: { id: true, kind: true, stage: true, intakeDetail: true, name: true } })
      : null;

    if (existing) {
      const detail = (existing.intakeDetail as { enquiries?: unknown[] } | null) ?? {};
      const enquiries = [...((detail.enquiries as unknown[]) ?? []), enquiry];
      const wasCold = existing.kind === "COLD_PROSPECT";

      await db.lead.update({
        where: { id: existing.id },
        data: {
          // A cold prospect who fills in the form is no longer cold.
          ...(wasCold ? { kind: "PIPELINE" as const, stage: "LEAD" as const, source: `Inbound: ${source}` } : {}),
          // A generic scraped name loses to a real one the person typed.
          ...(name && name.length > (existing.name ?? "").length ? { name } : {}),
          ...(email ? { email } : {}),
          ...(payload.eventType ? { eventType: payload.eventType } : {}),
          ...(payload.pax ? { pax: payload.pax } : {}),
          ...(eventDate ? { eventDate } : {}),
          ...(eventDateText ? { eventDateText } : {}),
          ...(payload.location ? { locationText: payload.location } : {}),
          ...(externalRef ? { externalRef } : {}),
          intakeDetail: { ...detail, enquiries } as Prisma.InputJsonValue,
        },
      });
      await this.announce(workspace.id, existing.id, name, source, wasCold ? "promoted" : "merged");
      this.log.log(`${wasCold ? "promoted" : "merged"} ${name} from ${source}`);
      return { outcome: wasCold ? "promoted" : "merged", leadId: existing.id };
    }

    const created = await db.lead.create({
      data: {
        workspaceId: workspace.id,
        name,
        kind: "PIPELINE",
        stage: "LEAD",
        contactName: payload.contactName?.trim() || null,
        phone,
        phoneRaw: payload.phone?.trim() || null,
        email,
        company: payload.company?.trim() || null,
        eventType: payload.eventType?.trim() || null,
        pax: payload.pax ?? null,
        eventDate,
        eventDateText,
        locationText: payload.location?.trim() || null,
        remarks: payload.message?.trim() || null,
        source: `Inbound: ${source}`,
        sourceSheet: source,
        externalRef,
        intakeDetail: { enquiries: [enquiry] } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    await this.announce(workspace.id, created.id, name, source, "created");
    this.log.log(`created ${name} from ${source}`);
    return { outcome: "created", leadId: created.id };
  }

  /**
   * Tells the people who work the pipeline. Notifies by DEPARTMENT rather
   * than by permission: Superadmins hold `leads:view` too, and nobody wants
   * every website enquiry pinging the founder.
   */
  private async announce(workspaceId: string, leadId: string, name: string, source: string, outcome: IntakeOutcome) {
    const watchers = await this.prisma.client.user.findMany({
      where: {
        workspaceId,
        isActive: true,
        deletedAt: null,
        isExternal: false,
        department: { key: { in: ["SALES", "MARKETING"] } },
      },
      select: { id: true },
    });
    if (watchers.length === 0) return;
    const verb = outcome === "promoted" ? "came back" : "enquired";
    await this.prisma.client.notification.createMany({
      data: watchers.map((w) => ({
        workspaceId,
        userId: w.id,
        icon: "☍",
        text: `${name} ${verb} via ${source}.`,
        sourceType: "lead",
        sourceId: leadId,
      })),
    });
  }
}

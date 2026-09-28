import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { AccessScopeService } from "../common/rbac/access-scope.service";
import type { RequestUser } from "../common/types";
import { WhatsAppConfigService } from "./whatsapp-config.service";
import { WhatsAppProvider } from "./whatsapp.provider";

/**
 * "Are you free for this event?", asked of the bartenders, on WhatsApp.
 *
 * WHAT THIS REPLACES. Somebody rings round the crew before every event and
 * flips `isAvailable` by hand. That flag is global, so it answers "is Ankit
 * around at all" when the question is "is Ankit free on the 12th" — and the
 * answer to the second question was never written down anywhere.
 *
 * Each ask is a CrewRequest row: who, which event, what they said, when, and
 * through which channel. Replies arrive on the webhook and update the row.
 *
 * THE ONE THING WORTH BEING CAREFUL ABOUT is not sending twice. A bartender
 * who gets the same question two days running stops reading them, and a
 * second reply silently overwriting the first is how somebody gets booked
 * for a shift they declined. So an existing request is left alone unless the
 * caller explicitly asks to re-send, and the database enforces one row per
 * person per event regardless.
 */
@Injectable()
export class CrewAvailabilityService {
  private readonly log = new Logger("CrewAvailability");

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WhatsAppConfigService,
    private readonly provider: WhatsAppProvider,
    private readonly accessScope: AccessScopeService,
  ) {}

  /** Who has been asked about this event, and what they said. */
  async forProject(user: RequestUser, projectId: string) {
    await this.accessScope.assertProject(user, projectId, this.prisma.client);
    const rows = await this.prisma.client.crewRequest.findMany({
      where: { projectId },
      include: { freelancer: { select: { id: true, name: true, phone: true, category: true } } },
      orderBy: [{ status: "asc" }, { sentAt: "desc" }],
    });
    return {
      mode: this.config.mode,
      requests: rows.map((r) => ({
        id: r.id,
        status: r.status,
        channel: r.channel,
        replyText: r.replyText,
        sentAt: r.sentAt,
        respondedAt: r.respondedAt,
        freelancer: r.freelancer,
      })),
    };
  }

  /**
   * Asks the given bartenders about one event.
   *
   * Every send is independent: one bad number must not stop the other
   * nineteen going out. A failure is recorded as FAILED on its own row
   * rather than thrown, so the screen can show exactly who was not reached.
   */
  async ask(user: RequestUser, projectId: string, freelancerIds: string[], resend = false) {
    this.config.assertUsable();
    if (freelancerIds.length === 0) throw new BadRequestException("Pick at least one bartender.");

    const db = this.prisma.client;
    const project = await db.project.findFirst({
      where: { id: projectId, workspaceId: user.workspaceId, deletedAt: null },
      include: { city: { select: { name: true } } },
    });
    if (!project) throw new NotFoundException("Event not found.");
    await this.accessScope.assertProject(user, projectId, db);

    const crew = await db.freelancer.findMany({
      where: { id: { in: freelancerIds }, workspaceId: user.workspaceId, deletedAt: null },
      select: { id: true, name: true, phone: true },
    });

    const when = project.eventDateText?.trim() || project.eventDate.toISOString().slice(0, 10);
    const existing = new Map(
      (await db.crewRequest.findMany({ where: { projectId, freelancerId: { in: freelancerIds } } })).map((r) => [r.freelancerId, r]),
    );

    const results: Array<{ freelancerId: string; name: string; outcome: "sent" | "skipped" | "failed"; reason?: string }> = [];

    for (const person of crew) {
      const already = existing.get(person.id);
      if (already && !resend) {
        results.push({ freelancerId: person.id, name: person.name, outcome: "skipped", reason: `already asked (${already.status.toLowerCase()})` });
        continue;
      }

      const to = this.config.toWhatsAppNumber(person.phone);
      if (!to) {
        results.push({ freelancerId: person.id, name: person.name, outcome: "failed", reason: "no usable phone number" });
        await this.record(user, projectId, person.id, "FAILED", null);
        continue;
      }

      try {
        const sent = await this.provider.send({
          to,
          name: person.name,
          template: this.config.crewTemplate,
          // Order matters: these fill {{1}}…{{4}} in the approved template.
          params: [person.name, project.name, when, project.city?.name ?? ""],
        });
        await this.record(user, projectId, person.id, "SENT", sent.ref);
        results.push({ freelancerId: person.id, name: person.name, outcome: "sent" });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.record(user, projectId, person.id, "FAILED", null);
        results.push({ freelancerId: person.id, name: person.name, outcome: "failed", reason });
      }
    }

    const sent = results.filter((r) => r.outcome === "sent").length;
    this.log.log(`${project.name}: asked ${sent} of ${crew.length} (${this.config.mode})`);
    return { mode: this.config.mode, asked: sent, results };
  }

  private async record(user: RequestUser, projectId: string, freelancerId: string, status: "SENT" | "FAILED", providerRef: string | null) {
    await this.prisma.client.crewRequest.upsert({
      where: { projectId_freelancerId: { projectId, freelancerId } },
      create: { workspaceId: user.workspaceId, projectId, freelancerId, status, providerRef, createdById: user.id },
      // A re-send resets the answer: the question was asked again, so last
      // time's yes is no longer the current answer.
      update: { status, providerRef, sentAt: new Date(), replyText: null, respondedAt: null },
    });
  }

  /**
   * A reply, arriving from the provider's webhook.
   *
   * Matched on the phone number rather than on a request id, because that is
   * all a WhatsApp reply carries — the person, not the question. Where
   * somebody has been asked about several events, the most recent unanswered
   * ask is the one they are replying to; anything else would need them to
   * quote the event, which nobody does.
   */
  async recordReply(fromNumber: string, text: string): Promise<{ matched: boolean; requestId?: string; status?: string }> {
    const digits = fromNumber.replace(/\D/g, "").slice(-10);
    if (digits.length !== 10) return { matched: false };

    const person = await this.prisma.client.freelancer.findFirst({
      where: { phone: digits, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!person) return { matched: false };

    const pending = await this.prisma.client.crewRequest.findFirst({
      where: { freelancerId: person.id, status: "SENT" },
      orderBy: { sentAt: "desc" },
    });
    if (!pending) return { matched: false };

    const status = this.readAnswer(text);
    await this.prisma.client.crewRequest.update({
      where: { id: pending.id },
      // The raw text is kept whatever the verdict: "yes but only till 11" is
      // a yes with a condition somebody needs to read, not a boolean.
      data: { status, replyText: text.slice(0, 500), respondedAt: new Date() },
    });
    this.log.log(`${person.name} -> ${status}`);
    return { matched: true, requestId: pending.id, status };
  }

  /**
   * Yes, no, or neither.
   *
   * Unrecognised replies stay SENT rather than being guessed at. A bartender
   * who writes "kya rate hai?" has not agreed to anything, and recording
   * that as available is how somebody does not turn up.
   */
  private readAnswer(text: string): "AVAILABLE" | "UNAVAILABLE" | "SENT" {
    const t = text.trim().toLowerCase();
    if (/^(no|not available|nahi|nhi|na|busy|can'?t|cannot|unavailable)\b/.test(t) || /not available/.test(t)) return "UNAVAILABLE";
    if (/^(yes|y|available|haan|han|ha|ok|okay|sure|yep|yup|done|confirm)/.test(t) || /\bavailable\b/.test(t)) return "AVAILABLE";
    return "SENT";
  }
}

import { Body, Controller, ForbiddenException, Get, Headers, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Public } from "../common/decorators/public.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { CrewAvailabilityService } from "./crew-availability.service";
import { WhatsAppConfigService } from "./whatsapp-config.service";

const askSchema = z.object({
  freelancerIds: z.array(z.string().uuid()).min(1).max(200),
  /** Ask again somebody who has already been asked, resetting their answer. */
  resend: z.boolean().optional().default(false),
});

/**
 * Replies, as the provider posts them.
 *
 * Deliberately loose. Every WhatsApp provider shapes its webhook differently
 * and white-label resellers differ again; a strict schema here would reject
 * real replies over a field nobody cares about. What is actually needed is
 * a number and some text, and those are dug out of whatever arrives.
 */
const replySchema = z.record(z.unknown());

@Controller()
export class WhatsAppController {
  constructor(
    private readonly crew: CrewAvailabilityService,
    private readonly config: WhatsAppConfigService,
  ) {}

  /** Whether WhatsApp is configured, for the screen to show the right thing. */
  @Get("whatsapp/status")
  @RequirePermissions("freelancers:view")
  status() {
    return { mode: this.config.mode, template: this.config.crewTemplate };
  }

  @Get("projects/:projectId/crew-requests")
  @RequirePermissions("freelancers:view")
  list(@CurrentUser() user: RequestUser, @Param("projectId", ParseUUIDPipe) projectId: string) {
    return this.crew.forProject(user, projectId);
  }

  @Post("projects/:projectId/crew-requests")
  @RequirePermissions("freelancers:edit")
  ask(
    @CurrentUser() user: RequestUser,
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Body(new ZodValidationPipe(askSchema)) body: z.infer<typeof askSchema>,
  ) {
    return this.crew.ask(user, projectId, body.freelancerIds, body.resend);
  }

  /**
   * Where the provider posts a bartender's reply.
   *
   * PUBLIC, SO THE SECRET IS THE WHOLE BOUNDARY. A provider cannot hold a
   * session, so this route carries no JWT — what it carries is a shared
   * secret in the URL, checked before anything is read. Without it, anyone
   * who knows a bartender's number could mark them available for a shift
   * they never agreed to, and the first anyone would know is when nobody
   * turned up.
   *
   * It always answers 200. A provider that receives an error retries, often
   * for hours; a reply we could not match is not worth a retry storm, and
   * the outcome is in the body for anyone reading their logs.
   */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post("whatsapp/reply")
  async reply(@Query("secret") secret: string | undefined, @Headers("x-webhook-secret") header: string | undefined, @Body(new ZodValidationPipe(replySchema)) body: Record<string, unknown>) {
    const expected = this.config.webhookSecret;
    if (!expected) throw new ForbiddenException("WhatsApp replies are not configured on this server.");
    if (secret !== expected && header !== expected) throw new ForbiddenException("Bad webhook secret.");

    const from = pick(body, ["from", "waId", "wa_id", "mobile", "phone", "sender", "destination"]);
    const text = pick(body, ["text", "message", "body", "buttonText", "button_text", "reply", "content"]);
    if (!from || !text) return { ok: true, matched: false, reason: "no phone number or text in the payload" };

    const result = await this.crew.recordReply(from, text);
    return { ok: true, ...result };
  }
}

/**
 * The first of these keys that holds a usable string, looked for one level
 * deep as well — providers habitually nest the interesting part inside
 * `data`, `payload` or `message`.
 */
function pick(body: Record<string, unknown>, keys: string[]): string | null {
  const scan = (obj: Record<string, unknown>): string | null => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
    return null;
  };
  const direct = scan(body);
  if (direct) return direct;
  for (const nested of ["data", "payload", "message", "entry"]) {
    const child = body[nested];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const found = scan(child as Record<string, unknown>);
      if (found) return found;
    }
  }
  return null;
}

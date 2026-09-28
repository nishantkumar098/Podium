import { Body, Controller, Headers, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { Public } from "../common/decorators/public.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { LeadIntakeService } from "./lead-intake.service";

/**
 * The door every outside lead comes through — the website form, Meta lead
 * ads, Google Ads, IndiaMART, a Zapier bridge.
 *
 * PUBLIC BY NECESSITY, KEYED BY DESIGN. A website form cannot hold a user
 * session, so this route carries no JWT. What it carries instead is a
 * per-source key in `x-podium-key`, checked against LEAD_INTAKE_KEYS. One
 * key per source means a key baked into a public web page can be revoked on
 * its own without silencing Meta, Google and everything else with it.
 *
 * Rate-limited hard. This is the only unauthenticated write in Podium, so it
 * is also the only one somebody can hammer; 60 a minute is far above a real
 * enquiry rate and far below a useful flood.
 *
 * The response deliberately says almost nothing — an outcome and an id. An
 * endpoint that answers "that phone number is already a lead of ours" is an
 * endpoint that will be used to find out who AMM's clients are.
 */

const intakeSchema = z.object({
  name: z.string().trim().max(200).optional().nullable(),
  contactName: z.string().trim().max(200).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().max(200).optional().nullable(),
  company: z.string().trim().max(200).optional().nullable(),
  eventType: z.string().trim().max(120).optional().nullable(),
  /** Any format; unparseable values are kept verbatim rather than guessed at. */
  eventDate: z.string().trim().max(120).optional().nullable(),
  pax: z.coerce.number().int().min(0).max(1_000_000).optional().nullable(),
  location: z.string().trim().max(200).optional().nullable(),
  message: z.string().trim().max(5000).optional().nullable(),
  /** Whatever else the form sends; kept whole on the lead. */
  extra: z.record(z.unknown()).optional(),
  /** The sending system's own id, so a retry cannot create a second lead. */
  externalRef: z.string().trim().max(200).optional().nullable(),
});

type IntakeBody = z.infer<typeof intakeSchema>;

@Controller("leads")
export class LeadIntakeController {
  constructor(private readonly intake: LeadIntakeService) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post("intake")
  async receive(@Headers("x-podium-key") key: string | undefined, @Body(new ZodValidationPipe(intakeSchema)) body: IntakeBody) {
    const source = this.intake.sourceForKey(key);
    const { outcome, leadId } = await this.intake.receive(source, body);
    return { ok: true, outcome, leadId };
  }
}

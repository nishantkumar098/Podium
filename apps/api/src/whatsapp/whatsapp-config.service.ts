import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";

/**
 * Whether Podium may send WhatsApp messages, and through what.
 *
 * THREE MODES, exactly as the Google integration has, and for the same
 * reason: an integration that is half-configured must fail loudly at the
 * boundary rather than quietly at the first message.
 *
 *   disabled  every send refuses with the setup steps. The default.
 *   sandbox   messages are rendered and logged, never sent. The whole flow —
 *             picking crew, recording who was asked, matching replies — is
 *             exercised without a provider, an API key, or a real bartender's
 *             phone buzzing at 11pm during a test.
 *   live      requires all three settings below. If any is missing this logs
 *             an error and falls back to `disabled`, rather than booting
 *             happily and failing at the first send.
 *
 * THE PROVIDER IS AiSensy, white-labelled as "Let's Build Brands". Its base
 * URL is configuration rather than a constant because a white-label reseller
 * can and does host its own endpoint, and hardcoding AiSensy's would work
 * right up until it didn't.
 */
export type WhatsAppMode = "disabled" | "sandbox" | "live";

@Injectable()
export class WhatsAppConfigService {
  private readonly log = new Logger("WhatsApp");

  readonly apiUrl = (process.env.WHATSAPP_API_URL ?? "").trim().replace(/\/$/, "");
  readonly apiKey = (process.env.WHATSAPP_API_KEY ?? "").trim();
  /** The approved template used to ask a bartender about one event. */
  readonly crewTemplate = (process.env.WHATSAPP_CREW_TEMPLATE ?? "crew_availability_request").trim();
  /**
   * Shared secret the provider must send back on its webhook. Without it the
   * reply endpoint is an open door: anyone who guesses a request id could
   * mark a bartender available for an event they never agreed to.
   */
  readonly webhookSecret = (process.env.WHATSAPP_WEBHOOK_SECRET ?? "").trim();

  readonly mode: WhatsAppMode = this.resolveMode();

  private resolveMode(): WhatsAppMode {
    const requested = (process.env.WHATSAPP_MODE ?? "disabled").toLowerCase() as WhatsAppMode;
    if (requested !== "live") return requested === "sandbox" ? "sandbox" : "disabled";
    if (!this.apiUrl || !this.apiKey) {
      this.log.error(
        "WHATSAPP_MODE=live but WHATSAPP_API_URL / WHATSAPP_API_KEY are not both set. Falling back to disabled — " +
          "no message will be sent, rather than failing at the first one.",
      );
      return "disabled";
    }
    if (!this.webhookSecret) {
      this.log.warn("WHATSAPP_WEBHOOK_SECRET is not set: replies cannot be accepted, so crew answers will not come back.");
    }
    return "live";
  }

  /** Throws the setup steps when sending is not configured at all. */
  assertUsable(): void {
    if (this.mode !== "disabled") return;
    throw new ServiceUnavailableException(
      "WhatsApp is not configured. Set WHATSAPP_API_URL, WHATSAPP_API_KEY and WHATSAPP_MODE=live, " +
        "or WHATSAPP_MODE=sandbox to exercise the flow without sending anything.",
    );
  }

  /**
   * A number as WhatsApp wants it: country code, no plus, no spaces.
   *
   * Every number in this database is stored as ten digits, because that is
   * how AMM's own sheets write them. A ten-digit Indian number without a
   * country code is not deliverable, so 91 is prefixed here rather than at
   * each call site — where it would eventually be forgotten once.
   */
  toWhatsAppNumber(raw: string | null | undefined): string | null {
    const digits = (raw ?? "").replace(/\D/g, "");
    if (digits.length === 10) return `91${digits}`;
    if (digits.length === 12 && digits.startsWith("91")) return digits;
    if (digits.length === 13 && digits.startsWith("091")) return digits.slice(1);
    return null;
  }
}

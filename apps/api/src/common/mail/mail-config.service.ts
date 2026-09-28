import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";

export type MailMode = "disabled" | "sandbox" | "live";

/**
 * Mail configuration, and the one place that decides whether e-mail is real.
 *
 * This deliberately mirrors GoogleConfigService's three-mode discipline,
 * because it guards against exactly the same failure: a system that looks
 * like it is sending mail to real customers when it is not, or — far worse —
 * one that genuinely sends mail to real AMM clients from a developer's
 * laptop during a test run.
 *
 *  - `disabled` (the default): every send refuses with a 503 naming the
 *    missing configuration. Nothing pretends to have been sent.
 *  - `sandbox`: the message is rendered in full and recorded (so a test can
 *    assert on its real subject/body/recipient) but no SMTP connection is
 *    ever opened. Every recorded message is flagged `sandbox: true`.
 *  - `live`: requires a real host, user and password. If any is missing the
 *    mode refuses to activate rather than silently degrading to a no-op and
 *    leaving invoices apparently "sent".
 *
 * AMM Brands have not supplied SMTP credentials, so the shipped default is
 * `disabled`. See docs/integration-setup.md.
 */
@Injectable()
export class MailConfigService {
  private readonly logger = new Logger(MailConfigService.name);

  readonly mode: MailMode;
  readonly host = process.env.SMTP_HOST ?? "";
  readonly port = Number(process.env.SMTP_PORT ?? 587);
  readonly user = process.env.SMTP_USER ?? "";
  readonly password = process.env.SMTP_PASSWORD ?? "";
  readonly fromAddress = process.env.MAIL_FROM ?? "no-reply@ammbrands.com";
  readonly fromName = process.env.MAIL_FROM_NAME ?? "AMM Brands LLP";

  constructor() {
    const requested = (process.env.MAIL_MODE ?? "disabled").toLowerCase() as MailMode;
    if (requested === "live" && !this.hasCredentials()) {
      this.logger.error(
        "MAIL_MODE=live but SMTP_HOST / SMTP_USER / SMTP_PASSWORD are not all set. Falling back to disabled — " +
          "see docs/integration-setup.md. No mail will be sent.",
      );
      this.mode = "disabled";
    } else if (requested === "sandbox" || requested === "live") {
      this.mode = requested;
    } else {
      this.mode = "disabled";
    }
  }

  hasCredentials(): boolean {
    return Boolean(this.host && this.user && this.password);
  }

  assertEnabled(): void {
    if (this.mode === "disabled") {
      throw new ServiceUnavailableException(
        "E-mail is not configured. Supply SMTP_HOST, SMTP_USER and SMTP_PASSWORD and set MAIL_MODE=live, or set " +
          "MAIL_MODE=sandbox to render messages without sending them. See docs/integration-setup.md.",
      );
    }
  }
}

import { Injectable, Logger } from "@nestjs/common";
import * as nodemailer from "nodemailer";
import { MailConfigService } from "./mail-config.service";

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendMailInput {
  to: string;
  subject: string;
  /** Plain text is always required; HTML is optional and purely presentational. */
  text: string;
  html?: string;
  attachments?: MailAttachment[];
}

export interface SentMail extends SendMailInput {
  mode: "sandbox" | "live";
  sentAt: Date;
  /** The provider's message id in live mode; a synthetic one in sandbox. */
  messageId: string;
}

/**
 * The single mail sender for the whole system. Both invoice delivery and
 * password-invite links go through this — deliberately one service rather
 * than two ad hoc senders, so there is exactly one place where "did this
 * actually leave the building?" is decided (see docs/STATUS.md §1.3, where
 * the absence of any mail capability was blocking invite delivery).
 *
 * In `sandbox` mode the message is fully rendered and retained in memory so
 * a test (or a developer) can assert on what WOULD have been sent, without
 * a single packet leaving the process. `recentSandboxMail()` exposes that
 * buffer; it is intentionally capped and non-durable, because it is a
 * debugging aid, not an outbox.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter?: nodemailer.Transporter;
  private readonly sandboxOutbox: SentMail[] = [];
  private static readonly SANDBOX_OUTBOX_LIMIT = 50;

  constructor(private readonly config: MailConfigService) {}

  async send(input: SendMailInput): Promise<SentMail> {
    this.config.assertEnabled();

    if (this.config.mode === "sandbox") {
      const record: SentMail = {
        ...input,
        mode: "sandbox",
        sentAt: new Date(),
        messageId: `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      };
      this.sandboxOutbox.unshift(record);
      if (this.sandboxOutbox.length > MailService.SANDBOX_OUTBOX_LIMIT) this.sandboxOutbox.length = MailService.SANDBOX_OUTBOX_LIMIT;
      this.logger.log(`[sandbox] would send "${input.subject}" to ${input.to} (nothing was actually sent)`);
      return record;
    }

    const info = await this.liveTransporter().sendMail({
      from: `"${this.config.fromName}" <${this.config.fromAddress}>`,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    return { ...input, mode: "live", sentAt: new Date(), messageId: info.messageId };
  }

  /** Sandbox-mode inspection only — always empty in live mode, by design. */
  recentSandboxMail(): readonly SentMail[] {
    return this.sandboxOutbox;
  }

  private liveTransporter(): nodemailer.Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.config.host,
        port: this.config.port,
        // 465 is implicit TLS; everything else (typically 587) upgrades via
        // STARTTLS, which nodemailer does automatically when secure=false.
        secure: this.config.port === 465,
        auth: { user: this.config.user, pass: this.config.password },
      });
    }
    return this.transporter;
  }
}

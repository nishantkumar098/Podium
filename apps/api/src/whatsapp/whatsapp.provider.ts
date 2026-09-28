import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { WhatsAppConfigService } from "./whatsapp-config.service";

/**
 * Sending one approved template to one number.
 *
 * WHY ONLY TEMPLATES. WhatsApp does not let a business message someone
 * freely. Outside a 24-hour window from that person's last message to you,
 * the only thing that can be sent is a template Meta has approved in
 * advance. So there is no `sendText` here, and adding one would produce a
 * method that works in testing (where you have just messaged yourself) and
 * fails in production.
 */
export interface TemplateMessage {
  /** Destination in WhatsApp form — country code, no plus. */
  to: string;
  /** The approved template's name, exactly as the provider has it. */
  template: string;
  /** Values for {{1}}, {{2}}… in order. */
  params: string[];
  /** Shown as the recipient's name in the provider's own inbox. */
  name?: string;
}

export interface SendResult {
  /** The provider's message id, so a later webhook can be matched to this send. */
  ref: string | null;
  sent: boolean;
}

export abstract class WhatsAppProvider {
  abstract send(message: TemplateMessage): Promise<SendResult>;
}

/**
 * Renders the message and logs it. Never touches the network.
 *
 * This is what makes the whole crew-availability flow testable — picking
 * bartenders, recording who was asked, matching replies — without an API
 * key, and without a real bartender's phone buzzing during a test.
 */
@Injectable()
export class SandboxWhatsAppProvider extends WhatsAppProvider {
  private readonly log = new Logger("WhatsApp:sandbox");

  async send(message: TemplateMessage): Promise<SendResult> {
    this.log.log(`[not sent] ${message.template} -> ${message.to} :: ${message.params.join(" | ")}`);
    return { ref: `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, sent: false };
  }
}

/**
 * AiSensy, white-labelled here as "Let's Build Brands".
 *
 * The request shape is AiSensy's documented campaign API: an API key in the
 * body (not a header — their choice, not ours), the campaign/template name,
 * the destination, and the template's parameters in order.
 *
 * The base URL is configuration. A white-label reseller can host its own
 * endpoint, and a hardcoded `backend.aisensy.com` would work right up until
 * the day it didn't, failing in a way that looks like a credentials problem.
 */
@Injectable()
export class LiveWhatsAppProvider extends WhatsAppProvider {
  private readonly log = new Logger("WhatsApp");

  constructor(private readonly config: WhatsAppConfigService) {
    super();
  }

  async send(message: TemplateMessage): Promise<SendResult> {
    const res = await fetch(this.config.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: this.config.apiKey,
        campaignName: message.template,
        destination: message.to,
        userName: message.name ?? "",
        templateParams: message.params,
      }),
    });

    const body = await res.text();
    if (!res.ok) {
      // The provider's own words, truncated. A generic "send failed" would
      // hide "template not approved", which is the answer most of the time.
      this.log.error(`send to ${message.to} failed (${res.status}): ${body.slice(0, 200)}`);
      throw new ServiceUnavailableException(`WhatsApp refused the message (${res.status}). ${body.slice(0, 160)}`);
    }

    let ref: string | null = null;
    try {
      const json = JSON.parse(body) as { messageId?: string; id?: string; data?: { id?: string } };
      ref = json.messageId ?? json.id ?? json.data?.id ?? null;
    } catch {
      // A 200 with a non-JSON body still means it went; we just cannot
      // correlate a later delivery receipt to it.
    }
    return { ref, sent: true };
  }
}

import { ForbiddenException, Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A link to one invoice's PDF that a client can open without signing in.
 *
 * WHY THIS HAS TO EXIST. `GET /invoices/:id/pdf` is behind `invoices:view`,
 * which is right — it is AMM's document. But a client has no Podium account,
 * so the moment an invoice is sent over WhatsApp or e-mail, something has to
 * be openable by a stranger holding a URL.
 *
 * WHAT MAKES IT SAFE. The URL carries an HMAC over the invoice id and an
 * expiry, signed with a server-side secret. That gives three properties
 * worth stating:
 *
 *   - It cannot be guessed. Without the secret there is no way to produce a
 *     valid signature, so an id alone is useless.
 *   - It cannot be edited. Changing the id or pushing out the expiry breaks
 *     the signature, because both are inside what was signed.
 *   - It cannot be reused for another invoice. The id is part of the
 *     signature, so a link to one invoice is a link to exactly that invoice.
 *
 * It is still a bearer token: whoever holds the URL can open the invoice.
 * That is the same bargain as e-mailing a PDF, and the expiry bounds it.
 *
 * DRAFTS ARE NEVER LINKABLE. A draft has a placeholder number and no final
 * GST split; a client opening one would be reading a document that does not
 * correspond to anything in AMM's books. The caller enforces that.
 */
@Injectable()
export class InvoiceLinkService {
  /**
   * Its own secret where one is set, otherwise the access-token secret.
   *
   * Sharing the JWT secret is acceptable but not ideal — rotating it to
   * force a sign-out would also silently break every invoice link already
   * sent to a client. Setting INVOICE_LINK_SECRET separates the two.
   */
  private secret(): string {
    return process.env.INVOICE_LINK_SECRET || process.env.JWT_ACCESS_SECRET || "";
  }

  /** How long a sent invoice stays openable. Long, because clients pay late. */
  private readonly ttlDays = Number(process.env.INVOICE_LINK_TTL_DAYS ?? 90);

  private sign(invoiceId: string, expiresAt: number): string {
    return createHmac("sha256", this.secret()).update(`${invoiceId}.${expiresAt}`).digest("base64url");
  }

  /** `<expiry>.<signature>` — everything a reader needs, nothing they can forge. */
  tokenFor(invoiceId: string): string {
    const expiresAt = Math.floor(Date.now() / 1000) + this.ttlDays * 86400;
    return `${expiresAt}.${this.sign(invoiceId, expiresAt)}`;
  }

  /**
   * The full URL to hand a client.
   *
   * Refuses rather than returning a relative path when WEB_BASE_URL is
   * unset. A half-built link is the worst outcome here: it would be sent to
   * a customer, look like a link, and open nothing — and nobody would find
   * out until they said so. Failing here names the missing setting instead.
   */
  urlFor(invoiceId: string): string {
    const base = (process.env.WEB_BASE_URL ?? "").trim().replace(/\/$/, "");
    if (!/^https?:\/\//.test(base)) {
      throw new ForbiddenException(
        "WEB_BASE_URL is not set on this server, so an invoice link cannot be built. " +
          "Set it to the site's address (https://podiumammbrands.com) and restart.",
      );
    }
    return `${base}/api/invoices/${invoiceId}/pdf/public?token=${this.tokenFor(invoiceId)}`;
  }

  /**
   * Throws unless the token really was issued for this invoice and has not
   * expired. Compared with `timingSafeEqual`, so a caller cannot learn the
   * signature one byte at a time from how long the comparison took.
   */
  assertValid(invoiceId: string, token: string | undefined): void {
    if (!this.secret()) throw new ForbiddenException("Invoice links are not configured on this server.");
    const [rawExpiry, signature] = (token ?? "").split(".");
    const expiresAt = Number(rawExpiry);
    if (!signature || !Number.isFinite(expiresAt)) throw new ForbiddenException("This invoice link is not valid.");
    if (expiresAt * 1000 < Date.now()) throw new ForbiddenException("This invoice link has expired. Ask AMM Brands for a new one.");

    const expected = Buffer.from(this.sign(invoiceId, expiresAt));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new ForbiddenException("This invoice link is not valid.");
    }
  }
}

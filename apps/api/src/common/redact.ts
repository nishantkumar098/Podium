/**
 * Redacts personal data from text that is about to be written to application
 * logs or returned in an error body.
 *
 * This is not theoretical. Prisma embeds the offending row in its error
 * messages — a failed `client.create` renders the whole `data` object,
 * including `phone` and `email`. With 52,024 real customer records in this
 * database, an unhandled insert error would otherwise write real phone numbers
 * and addresses into plaintext logs.
 *
 * Deliberately conservative: it over-redacts (a long invoice number may be
 * masked) rather than risk letting a real number through. Logs are for
 * diagnosis, and the entity id — which is never redacted — is what actually
 * identifies the row to investigate.
 */

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
/** 10+ consecutive digits, optionally punctuated — phone-number shaped. */
const LONG_NUMBER = /\b(?:\+?\d[\d\s().-]{8,}\d)\b/g;

export function redactPii(input: string): string {
  return input
    .replace(EMAIL, (m) => {
      const [local, domain] = m.split("@");
      return `${local.slice(0, 2)}***@${domain}`;
    })
    .replace(LONG_NUMBER, (m) => {
      const digits = m.replace(/\D/g, "");
      if (digits.length < 10) return m; // not phone-shaped after all
      return `***${digits.slice(-2)}`;
    });
}

/** Same treatment for a whole error, message and stack. */
export function redactError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: redactPii(err.message), stack: err.stack ? redactPii(err.stack) : undefined };
  }
  return { message: redactPii(String(err)) };
}

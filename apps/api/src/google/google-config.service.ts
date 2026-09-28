import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type IntegrationMode = "disabled" | "sandbox" | "live";

/**
 * Google integration configuration, and the one place that decides whether the
 * integration is real.
 *
 * Three explicit modes, because the failure this guards against is a demo that
 * looks live:
 *
 *  - `disabled` (the default): every endpoint refuses with 503 and points at
 *    docs/integration-setup.md. Nothing pretends to work.
 *  - `sandbox`: local fixture data only, every row written with
 *    `isSandbox = true` and every response carrying `mode: "sandbox"`. No
 *    network call is made and no OAuth flow is simulated as successful.
 *  - `live`: requires a real client id, secret and redirect URI. If any are
 *    missing the mode refuses to activate rather than silently degrading.
 *
 * AMM Brands' real Google Workspace credentials are NOT present in this
 * environment, so the shipped default is `disabled`.
 */
@Injectable()
export class GoogleConfigService {
  private readonly logger = new Logger(GoogleConfigService.name);

  readonly mode: IntegrationMode;
  readonly clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
  readonly clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "";
  readonly redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "";
  readonly scopes = (process.env.GOOGLE_OAUTH_SCOPES ?? "").split(/\s+/).filter(Boolean);

  constructor() {
    const requested = (process.env.GOOGLE_INTEGRATION_MODE ?? "disabled").toLowerCase() as IntegrationMode;
    if (requested === "live" && !this.hasCredentials()) {
      // Refusing to downgrade quietly: a "live" integration running on absent
      // credentials would fail at the first API call, far from the cause.
      this.logger.error(
        "GOOGLE_INTEGRATION_MODE=live but GOOGLE_OAUTH_CLIENT_ID / _SECRET / _REDIRECT_URI are not all set. " +
          "Falling back to disabled — see docs/integration-setup.md.",
      );
      this.mode = "disabled";
    } else if (requested === "sandbox" || requested === "live") {
      this.mode = requested;
    } else {
      this.mode = "disabled";
    }
  }

  hasCredentials(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  /** Throws the same clear, actionable 503 everywhere the integration is off. */
  assertEnabled(): void {
    if (this.mode === "disabled") {
      throw new ServiceUnavailableException(
        "The Google integration is not configured. Supply GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and " +
          "GOOGLE_OAUTH_REDIRECT_URI and set GOOGLE_INTEGRATION_MODE=live, or set GOOGLE_INTEGRATION_MODE=sandbox " +
          "for clearly-labelled fixture data. See docs/integration-setup.md.",
      );
    }
  }

  assertLive(): void {
    this.assertEnabled();
    if (this.mode !== "live") {
      throw new ServiceUnavailableException(
        "This action needs a real Google connection. The integration is currently in sandbox mode, which never " +
          "contacts Google. See docs/integration-setup.md.",
      );
    }
  }

  // ------------------------------------------------------------ token crypto

  /**
   * OAuth tokens are long-lived credentials for a real mailbox, so they are
   * encrypted at rest rather than stored as text. The key is derived from
   * JWT_ACCESS_SECRET only so this works in development without extra setup;
   * production should set GOOGLE_TOKEN_KEY to its own 32-byte secret.
   */
  private key(): Buffer {
    const material = process.env.GOOGLE_TOKEN_KEY ?? process.env.JWT_ACCESS_SECRET ?? "";
    if (!material) throw new Error("No key material available to encrypt Google tokens.");
    return createHash("sha256").update(material).digest();
  }

  encryptToken(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
  }

  decryptToken(stored: string): string {
    const [iv, tag, payload] = stored.split(".");
    const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(payload, "base64")), decipher.final()]).toString("utf8");
  }
}

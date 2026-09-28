import { z } from "zod";

/**
 * "Shweta Singh", " shweta singh ", "SHWETA.SINGH" all name the same account.
 * Shared by the API (lookup, provisioning) and the web app (display), so the
 * two can never disagree about what a username is.
 */
export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, ".");
}

// A password strong enough to matter, but no stricter than that — this is an
// internal ops tool, not a bank.
export const PASSWORD_MIN_LENGTH = 10;
const passwordField = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);

/**
 * Sign-in is the ONLY way into Podium — there is no sign-up.
 *
 * `username` is the person's name. On an account's first sign-in (no password
 * set yet) the server answers 428 and the caller resubmits with
 * `confirmPassword`; the password then becomes permanent. After that only a
 * Founder or Admin can reset it.
 */
export const loginSchema = z.object({
  username: z.string().trim().min(1, "Enter your username."),
  password: z.string().min(1, "Enter your password."),
  confirmPassword: z.string().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** Checked only when a first-login password is being set. */
export const firstPasswordSchema = passwordField;

// The refresh token also rides in an httpOnly cookie, so a browser caller has
// nothing to put in the body — the controller falls back to the cookie.
export const refreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

export const authTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: z.object({
    id: z.string().uuid(),
    name: z.string(),
    username: z.string().nullable(),
    email: z.string().nullable(),
    roles: z.array(z.string()),
    cityAccess: z.array(
      z.object({ cityId: z.string().uuid().nullable(), scope: z.enum(["READ", "WRITE", "ALL"]) }),
    ),
    mustChangePassword: z.boolean(),
  }),
});
export type AuthTokens = z.infer<typeof authTokensSchema>;

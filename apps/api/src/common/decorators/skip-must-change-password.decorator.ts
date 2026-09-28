import { SetMetadata } from "@nestjs/common";

export const SKIP_MUST_CHANGE_PASSWORD_KEY = "podium:skipMustChangePassword";

/**
 * BUG-003: opts a route out of MustChangePasswordGuard. Only routes a user
 * with a forced password change still needs to reach belong here —
 * change-password itself, and enough of /users/me and logout to render a
 * "you must change your password" screen and back out of it.
 */
export const SkipMustChangePassword = () => SetMetadata(SKIP_MUST_CHANGE_PASSWORD_KEY, true);

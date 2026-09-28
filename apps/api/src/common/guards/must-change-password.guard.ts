import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { SKIP_MUST_CHANGE_PASSWORD_KEY } from "../decorators/skip-must-change-password.decorator";
import type { RequestUser } from "../types";

/**
 * BUG-003 (2026-09-12 CTO audit): a user flagged mustChangePassword can
 * authenticate, but every route except the ones explicitly opted out via
 * @SkipMustChangePassword() is closed to them until they actually change it.
 * This is the real enforcement — the `mustChangePassword` flag on the login
 * response is only a hint for the frontend to route straight to that screen.
 *
 * Runs after JwtAuthGuard (which attaches req.user) and does nothing on
 * public/unauthenticated routes, where there is no user to check.
 */
@Injectable()
export class MustChangePasswordGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user as RequestUser | undefined;
    if (!user || !user.mustChangePassword) return true;

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_MUST_CHANGE_PASSWORD_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    throw new ForbiddenException("You must change your password before continuing.");
  }
}

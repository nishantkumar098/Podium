import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { isReadOnly } from "../rbac/model";
import type { RequestUser } from "../types";

/** Methods that cannot change anything. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The few writes a read-only person must still be able to make. None of them
 * changes a business record: they sign in, they talk to people, and they mark
 * their own notifications as read.
 *
 * Matched against the path with the global `/api` prefix already stripped.
 */
const ALLOWED_WRITES: RegExp[] = [
  /^\/auth\//,
  // Chat: the policy is explicit that the Founder communicates with everyone.
  /^\/channels\/[^/]+\/messages$/,
  /^\/channels\/dm$/,
  /^\/channels\/groups$/,
  // Their own unread markers.
  /^\/notifications\/(read-all|[^/]+\/read)$/,
];

/**
 * Central read-only enforcement.
 *
 * A read-only role already holds no write permissions, so `PermissionsGuard`
 * refuses most of this on its own. This guard exists because that is not
 * sufficient: a route with no `@RequirePermissions()` is authenticated-only
 * by design (chat, notifications, Google sync, SOPs, settings…), and several
 * of those routes write. Without a central rule, "the Founder can edit
 * nothing" would depend on nobody ever adding an undecorated POST.
 *
 * So the rule is stated once, here, as a default-deny on every unsafe method
 * with a named allow-list — rather than distributed across every controller,
 * where an omission is invisible.
 */
@Injectable()
export class ReadOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (SAFE_METHODS.has(req.method)) return true;

    const user = req.user as RequestUser | undefined;
    // Unauthenticated requests are JwtAuthGuard's business, not this guard's.
    if (!user || !isReadOnly(user.roleNames)) return true;

    const path = String(req.path ?? "").replace(/^\/api/, "");
    if (ALLOWED_WRITES.some((rx) => rx.test(path))) return true;

    throw new ForbiddenException("Your access is read-only: you can view everything, but not change it.");
  }
}

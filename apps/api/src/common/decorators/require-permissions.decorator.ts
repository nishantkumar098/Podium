import { SetMetadata } from "@nestjs/common";

export const PERMISSIONS_KEY = "podium:permissions";

/**
 * Server-side RBAC gate for a route — "resource:action" strings checked
 * against the caller's resolved permission set (blueprint §11). Never rely
 * on the frontend hiding a button; every mutating/financial/PII endpoint
 * must carry this decorator (or an explicit, commented reason it doesn't).
 */
export const RequirePermissions = (...permissions: string[]) => SetMetadata(PERMISSIONS_KEY, permissions);

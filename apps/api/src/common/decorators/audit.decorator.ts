import { SetMetadata } from "@nestjs/common";

export const AUDIT_KEY = "podium:audit";

export interface AuditMeta {
  entityType: string;
  action: string;
}

/**
 * Marks a mutating endpoint for automatic audit_logs writes via
 * AuditInterceptor (blueprint §7: every financial/inventory mutation must
 * produce an audit row, enforced centrally rather than left to each
 * handler to remember). "before" is best-effort — it is only captured when
 * the handler's return value or a preceding read exposes it; the immutable
 * fact recorded for certain on every call is: who, what action, on what
 * entity, when, and the response body as "after".
 */
export const Audit = (entityType: string, action: string) => SetMetadata(AUDIT_KEY, { entityType, action } satisfies AuditMeta);

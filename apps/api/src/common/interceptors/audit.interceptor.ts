import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable, tap } from "rxjs";
import { AUDIT_KEY, AuditMeta } from "../decorators/audit.decorator";
import { PrismaService } from "../prisma/prisma.service";
import type { RequestUser } from "../types";

/**
 * Writes an audit_logs row for every endpoint decorated with @Audit(),
 * centrally — so a mutation can never silently skip the audit trail because
 * one handler forgot to call `audit()` itself (blueprint §7/§30). Fire-and
 * -forget from the request's perspective (does not block or fail the
 * response if the audit write itself fails, but does log loudly if so —
 * an audit-log outage should page someone, not silently swallow forever).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AuditMeta | undefined>(AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!meta) return next.handle();

    const req = context.switchToHttp().getRequest();
    const user = req.user as RequestUser | undefined;

    return next.handle().pipe(
      tap((responseBody: Record<string, unknown> | undefined) => {
        const entityId = responseBody?.id ?? req.params?.id;
        if (!user || !entityId) return;
        this.prisma.client.auditLog
          .create({
            data: {
              workspaceId: user.workspaceId,
              actorId: user.id,
              action: meta.action,
              entityType: meta.entityType,
              entityId,
              after: safeJson(responseBody),
              ip: req.ip,
            },
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error("[audit] failed to write audit_logs row", { action: meta.action, entityId, err });
          });
      }),
    );
  }
}

function safeJson(value: unknown) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { Public } from "../common/decorators/public.decorator";
import { PrismaService } from "../common/prisma/prisma.service";

/**
 * Unauthenticated liveness/readiness probe.
 *
 * Deliberately checks the database rather than just returning 200: an API
 * process that has booted but cannot reach Postgres is up in no sense that
 * matters to a caller, and reporting it healthy is how a deploy goes green
 * while every request 500s. A failed check is a 503, not a 200 with a sad
 * field in the body, so anything watching it (a container platform, or an
 * engineer running `curl` during local setup) sees the failure without
 * having to parse the response.
 *
 * Public by design — a probe that needs credentials cannot be used by the
 * things that probe. It exposes no data beyond "reachable or not".
 */
@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async check() {
    try {
      await this.prisma.client.$queryRaw`SELECT 1`;
    } catch {
      // The underlying error can carry connection strings — log-worthy, not
      // response-worthy.
      throw new ServiceUnavailableException("Database is not reachable.");
    }
    return { status: "ok", database: "up", uptimeSeconds: Math.round(process.uptime()) };
  }
}

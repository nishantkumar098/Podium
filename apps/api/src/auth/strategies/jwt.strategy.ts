import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import type { Request } from "express";
import { ExtractJwt, Strategy } from "passport-jwt";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { RequestUser } from "../../common/types";

interface AccessTokenPayload {
  sub: string;
  workspaceId: string;
}

/**
 * Phase H: the web frontend no longer keeps the access token in
 * localStorage (readable by any injected script) — it rides in an httpOnly
 * cookie the browser sends automatically and JS can never read. The
 * Authorization header stays supported too: every existing e2e test
 * authenticates that way, and it remains the right shape for a non-browser
 * API caller that has nowhere to keep a cookie. Cookie is tried first only
 * because the browser is the case an attacker actually targets.
 */
const USER_CACHE_TTL_MS = 60_000;
const userCache = new Map<string, { user: RequestUser; expiresAt: number }>();

/** Drops a cached identity so the next request re-reads it (all users when no id is given). */
export function invalidateUserCache(userId?: string): void {
  if (userId) userCache.delete(userId);
  else userCache.clear();
}

function cookieExtractor(req: Request): string | null {
  return req?.cookies?.accessToken ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([cookieExtractor, ExtractJwt.fromAuthHeaderAsBearerToken()]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>("JWT_ACCESS_SECRET"),
    });
  }

  /**
   * Resolves permissions and city access from the database rather than
   * trusting stale JWT claims, but caches the result for USER_CACHE_TTL_MS.
   *
   * Uncached this ran on EVERY request and cost ~4.8 s against the Sydney
   * database (several sequential round trips) before the endpoint's own
   * work even began. A role, city-access or deactivation change now takes
   * effect within a minute instead of on the very next request; a password
   * reset clears the entry immediately (see invalidateUserCache).
   */
  async validate(payload: AccessTokenPayload): Promise<RequestUser> {
    const cached = userCache.get(payload.sub);
    if (cached && cached.expiresAt > Date.now()) return cached.user;
    const user = await this.load(payload);
    userCache.set(payload.sub, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
    return user;
  }

  private async load(payload: AccessTokenPayload): Promise<RequestUser> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: payload.sub },
      include: {
        userRoles: { include: { role: { include: { rolePermissions: { include: { permission: true } } } } } },
        cityAccess: true,
        department: { select: { id: true, key: true } },
      },
    });
    if (!user || !user.isActive || user.deletedAt) {
      throw new UnauthorizedException("Account is no longer active.");
    }
    const permissions = new Set<string>();
    const roleNames: string[] = [];
    // The primary role first: it is the label shown for the person (sidebar,
    // menus), while permissions are the union of every role they hold — e.g.
    // someone shown as "Employee" who also holds Superadmin access.
    const ordered = [...user.userRoles].sort((x, y) => Number(y.roleId === user.primaryRoleId) - Number(x.roleId === user.primaryRoleId));
    for (const ur of ordered) {
      roleNames.push(ur.role.name);
      for (const rp of ur.role.rolePermissions) {
        permissions.add(`${rp.permission.resource}:${rp.permission.action}`);
      }
    }
    return {
      id: user.id,
      workspaceId: user.workspaceId,
      name: user.name,
      username: user.username,
      email: user.email,
      permissions,
      roleNames,
      departmentId: user.department?.id ?? null,
      departmentKey: user.department?.key ?? null,
      cityAccess: user.cityAccess.map((c) => ({ cityId: c.cityId, scope: c.scope })),
      mustChangePassword: user.mustChangePassword,
    };
  }
}

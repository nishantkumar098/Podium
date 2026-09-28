import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { createHash, randomBytes } from "crypto";
import { firstPasswordSchema, normalizeUsername, type LoginInput } from "@podium/shared-types";
import { PrismaService } from "../common/prisma/prisma.service";
import { TOP_ROLE_NAMES } from "../common/rbac/model";
import type { RequestUser } from "../common/types";
import { invalidateUserCache } from "./strategies/jwt.strategy";

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60_000;
const BCRYPT_ROUNDS = 12;

/**
 * The top roles. Superadmin carries the Founder's permissions and powers;
 * the two differ only in label (see scripts/set-top-roles.ts).
 */
export const TOP_ROLES = TOP_ROLE_NAMES;

/**
 * Roles allowed to reset another person's password: Superadmin, and nobody
 * else.
 *
 * Narrower than it used to be, on instruction. A reset is the one action in
 * Podium that hands somebody else's account to whoever asks next — it blanks
 * the password, so the next person to reach the sign-in screen with that
 * username sets a new one and is in. That is worth concentrating in the
 * smallest possible group rather than spreading across every senior role.
 *
 * ORG_WIDE_ROLES is deliberately NOT used here: Admin and Founder are
 * organisation-wide for reading, which is a different question.
 */
export const PASSWORD_RESET_ROLES: readonly string[] = ["Superadmin"];

const INVALID = "Invalid username or password.";

/**
 * Sign-in is the only way into Podium: accounts are created by an
 * administrator, never by the person themselves, and there is no sign-up,
 * invite link or self-service password change.
 *
 * A new (or reset) account has no password. The first password typed at
 * sign-in becomes permanent — confirmed by typing it twice, because a typo
 * here could only be undone by an administrator. From then on only a
 * Superadmin can reset it, which returns the account to the no-password state.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(input: LoginInput) {
    const identifier = input.username.trim();
    // A username is the normal identifier. E-mail still resolves for accounts
    // that have one (the test fixtures), but no screen asks for it.
    const user = await this.prisma.client.user.findFirst({
      where: {
        OR: [{ username: normalizeUsername(identifier) }, { email: identifier.toLowerCase() }],
        deletedAt: null,
      },
      include: { userRoles: { include: { role: true } }, cityAccess: true },
    });
    if (!user || !user.isActive) throw new UnauthorizedException(INVALID);
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new UnauthorizedException(INVALID);

    if (!user.passwordHash) {
      await this.setFirstPassword(user.id, user.workspaceId, input);
    } else {
      const ok = await bcrypt.compare(input.password, user.passwordHash);
      if (!ok) {
        await this.registerFailedLogin(user.id, user.failedLoginAttempts);
        throw new UnauthorizedException(INVALID);
      }
      if (user.failedLoginAttempts > 0 || user.lockedUntil) {
        await this.prisma.client.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
      }
    }

    return {
      accessToken: this.signAccessToken(user.id, user.workspaceId),
      refreshToken: await this.issueRefreshToken(user.id),
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        // Primary role first — it is the label the app shows (see JwtStrategy.load).
        roles: [...user.userRoles]
          .sort((x, y) => Number(y.roleId === user.primaryRoleId) - Number(x.roleId === user.primaryRoleId))
          .map((ur) => ur.role.name),
        cityAccess: user.cityAccess.map((c) => ({ cityId: c.cityId, scope: c.scope })),
        mustChangePassword: false,
      },
    };
  }

  /**
   * First sign-in. Without `confirmPassword` this answers 428 so the screen can
   * ask for the password a second time; with it, the password is validated
   * and stored. The update is conditional on the hash still being NULL, so two
   * simultaneous first sign-ins cannot both set a password — the loser is
   * refused and must sign in with the winner's password like anyone else.
   */
  private async setFirstPassword(userId: string, workspaceId: string, input: LoginInput): Promise<void> {
    if (input.confirmPassword === undefined) {
      throw new HttpException(
        "First sign-in: choose your password and type it again to confirm. It becomes your permanent password.",
        HttpStatus.PRECONDITION_REQUIRED,
      );
    }
    const policy = firstPasswordSchema.safeParse(input.password);
    if (!policy.success) throw new BadRequestException(policy.error.issues[0]?.message ?? "Password is too weak.");
    if (input.password !== input.confirmPassword) throw new BadRequestException("The two passwords don't match.");

    const hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const claimed = await this.prisma.client.user.updateMany({
      where: { id: userId, passwordHash: null },
      data: { passwordHash: hash, passwordChangedAt: new Date(), mustChangePassword: false, failedLoginAttempts: 0, lockedUntil: null },
    });
    if (claimed.count === 0) throw new UnauthorizedException(INVALID);

    await this.prisma.client.auditLog.create({
      data: { workspaceId, actorId: userId, action: "auth.password_set_first_login", entityType: "user", entityId: userId },
    });
  }

  private async registerFailedLogin(userId: string, currentAttempts: number): Promise<void> {
    const attempts = currentAttempts + 1;
    const lockingOut = attempts >= MAX_FAILED_LOGIN_ATTEMPTS;
    await this.prisma.client.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: lockingOut ? 0 : attempts,
        lockedUntil: lockingOut ? new Date(Date.now() + LOCKOUT_DURATION_MS) : undefined,
      },
    });
  }

  /**
   * Superadmin only. Clears the password so the person sets a new one at
   * their next sign-in, ends every session they have open, and lifts any
   * lockout. Nobody resets themselves — that would log them out into an
   * account anyone could then claim.
   */
  async resetPassword(actor: RequestUser, targetUserId: string): Promise<{ ok: true; username: string | null }> {
    if (!actor.roleNames.some((r) => (PASSWORD_RESET_ROLES as readonly string[]).includes(r))) {
      throw new ForbiddenException("Only a Superadmin can reset passwords.");
    }
    if (targetUserId === actor.id) throw new BadRequestException("You can't reset your own password — ask another Superadmin.");

    const target = await this.prisma.client.user.findFirst({
      where: { id: targetUserId, workspaceId: actor.workspaceId, deletedAt: null },
      include: { userRoles: { include: { role: true } } },
    });
    if (!target) throw new NotFoundException("User not found.");
    const isTop = (name: string) => (TOP_ROLES as readonly string[]).includes(name);
    const targetIsTop = target.userRoles.some((ur) => isTop(ur.role.name));
    if (targetIsTop && !actor.roleNames.some(isTop)) {
      throw new ForbiddenException("Only a Founder or Superadmin can reset a Founder's or Superadmin's password.");
    }

    await this.prisma.client.$transaction([
      this.prisma.client.user.update({
        where: { id: target.id },
        data: { passwordHash: null, passwordChangedAt: null, mustChangePassword: false, failedLoginAttempts: 0, lockedUntil: null },
      }),
      this.prisma.client.refreshToken.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.prisma.client.auditLog.create({
        data: { workspaceId: actor.workspaceId, actorId: actor.id, action: "auth.password_reset", entityType: "user", entityId: target.id },
      }),
    ]);
    invalidateUserCache(target.id);
    return { ok: true, username: target.username };
  }

  async refresh(refreshToken: string) {
    const tokenHash = hashToken(refreshToken);
    const stored = await this.prisma.client.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Refresh token is invalid or expired.");
    }
    // Rotate: revoke the old token, issue a new pair (mitigates replay of a stolen refresh token).
    await this.prisma.client.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    const user = await this.prisma.client.user.findUniqueOrThrow({ where: { id: stored.userId } });
    const accessToken = this.signAccessToken(user.id, user.workspaceId);
    const newRefreshToken = await this.issueRefreshToken(user.id);
    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(refreshToken: string) {
    const tokenHash = hashToken(refreshToken);
    await this.prisma.client.refreshToken.updateMany({ where: { tokenHash }, data: { revokedAt: new Date() } });
  }

  private signAccessToken(userId: string, workspaceId: string): string {
    return this.jwt.sign(
      { sub: userId, workspaceId },
      { secret: this.config.getOrThrow("JWT_ACCESS_SECRET"), expiresIn: this.config.get("JWT_ACCESS_TTL") ?? "15m" },
    );
  }

  private async issueRefreshToken(userId: string): Promise<string> {
    const raw = randomBytes(48).toString("hex");
    const ttl = this.config.get<string>("JWT_REFRESH_TTL") ?? "30d";
    await this.prisma.client.refreshToken.create({
      data: { userId, tokenHash: hashToken(raw), expiresAt: addDuration(new Date(), ttl) },
    });
    return raw;
  }

  /** Lets the controller size the httpOnly cookie's maxAge to match the token it actually issued. */
  getAccessTokenTtlMs(): number {
    return parseDurationMs(this.config.get<string>("JWT_ACCESS_TTL") ?? "15m");
  }

  getRefreshTokenTtlMs(): number {
    return parseDurationMs(this.config.get<string>("JWT_REFRESH_TTL") ?? "30d");
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseDurationMs(spec: string): number {
  const match = /^(\d+)([smhd])$/.exec(spec.trim());
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const value = Number(match[1]);
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
  return value * unitMs;
}

function addDuration(base: Date, spec: string): Date {
  return new Date(base.getTime() + parseDurationMs(spec));
}

import { Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { AuthService } from "../auth/auth.service";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { PrismaService } from "../common/prisma/prisma.service";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { SkipMustChangePassword } from "../common/decorators/skip-must-change-password.decorator";
import { allowedCityIds, type RequestUser } from "../common/types";

@Controller("users")
export class UsersController {
  constructor(
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Active users, for pickers (PM, owner) and the Team screen. `passwordSet`
   * tells an administrator which accounts are still waiting for their first
   * sign-in — never the hash itself.
   */
  @RequirePermissions("people:view")
  @Get()
  async list(@CurrentUser() user: RequestUser) {
    const rows = await this.prisma.client.user.findMany({
      where: { workspaceId: user.workspaceId, isActive: true, deletedAt: null },
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        dept: true,
        passwordHash: true,
        lockedUntil: true,
        primaryCity: { select: { name: true } },
        userRoles: { select: { role: { select: { name: true } } } },
      },
      orderBy: { name: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      username: r.username,
      email: r.email,
      dept: r.dept,
      city: r.primaryCity?.name ?? null,
      roles: r.userRoles.map((ur) => ur.role.name),
      passwordSet: r.passwordHash !== null,
      locked: !!r.lockedUntil && r.lockedUntil > new Date(),
    }));
  }

  /**
   * Names only — for the owner/crew pickers on Projects, Tasks, Risks and
   * Event day, which every operational role uses. Deliberately carries none
   * of the account detail `GET /users` gives administrators.
   */
  @Get("directory")
  async directory(@CurrentUser() user: RequestUser) {
    const rows = await this.prisma.client.user.findMany({
      where: { workspaceId: user.workspaceId, isActive: true, deletedAt: null, isExternal: false },
      select: { id: true, name: true, dept: true, primaryRole: { select: { name: true } } },
      orderBy: { name: "asc" },
    });
    return rows.map((r) => ({ id: r.id, name: r.name, dept: r.dept, role: r.primaryRole?.name ?? null }));
  }

  /**
   * What the app frame needs about the signed-in person: the workspace name
   * (sidebar), their permissions (which navigation and "+ New" actions to
   * offer) and the cities they may work in (city switcher, footer).
   */
  @Get("me/shell")
  async shell(@CurrentUser() user: RequestUser) {
    const allowed = allowedCityIds(user);
    const [workspace, cities] = await Promise.all([
      this.prisma.client.workspace.findUnique({ where: { id: user.workspaceId }, select: { name: true } }),
      this.prisma.client.city.findMany({
        where: { workspaceId: user.workspaceId, deletedAt: null, ...(allowed === "ALL" ? {} : { id: { in: allowed } }) },
        select: { id: true, name: true, isHq: true },
        orderBy: [{ isHq: "desc" }, { name: "asc" }],
      }),
    ]);
    return {
      workspaceName: workspace?.name ?? null,
      permissions: [...user.permissions].sort(),
      allCities: allowed === "ALL",
      cities,
    };
  }

  @SkipMustChangePassword()
  @Get("me")
  me(@CurrentUser() user: RequestUser) {
    return {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      roles: user.roleNames,
      cityAccess: user.cityAccess,
      mustChangePassword: false,
    };
  }

  /**
   * Superadmin only — the role check lives in AuthService.resetPassword,
   * which is the single place that decides it. The person sets a new
   * password at their next sign-in.
   *
   * Gated on settings:edit rather than people:edit deliberately: resetting a
   * password is an account-security action, not an edit to an employee
   * record. The permission is the coarse gate; the role check is the real
   * one, and it is stricter.
   */
  @RequirePermissions("settings:edit")
  @Audit("user", "user.password_reset_requested")
  @Post(":id/reset-password")
  resetPassword(@CurrentUser() actor: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.authService.resetPassword(actor, id);
  }
}

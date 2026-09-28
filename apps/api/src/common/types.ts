export interface RequestUser {
  id: string;
  workspaceId: string;
  name: string;
  username: string | null;
  email: string | null;
  /** resource:action strings resolved from all roles the user holds */
  permissions: Set<string>;
  roleNames: string[];
  /**
   * The department this person belongs to. Record-level scoping (events,
   * tasks, department chat) reads these; a null department means they reach
   * only what they are personally attached to, unless their role is
   * org-wide. See common/rbac/access-scope.service.ts.
   */
  departmentId: string | null;
  departmentKey: string | null;
  /** null cityId + scope ALL means "every city in the workspace" (blueprint §10) */
  cityAccess: Array<{ cityId: string | null; scope: "READ" | "WRITE" | "ALL" }>;
  /** BUG-003: read by MustChangePasswordGuard, which blocks every other route while true. */
  mustChangePassword: boolean;
}

export function hasAllCityAccess(user: RequestUser): boolean {
  return user.cityAccess.some((g) => g.scope === "ALL");
}

/** City IDs this user may act in, or null meaning "all cities" (an explicit grant, never an absence of one). */
export function allowedCityIds(user: RequestUser): string[] | "ALL" {
  if (hasAllCityAccess(user)) return "ALL";
  return user.cityAccess.filter((g) => g.cityId).map((g) => g.cityId as string);
}

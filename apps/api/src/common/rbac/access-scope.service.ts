import { ForbiddenException, Injectable } from "@nestjs/common";
import type { Prisma } from "@podium/db";
import { CityScopeService } from "../city-scope/city-scope.service";
import { isOrgWide } from "./model";
import type { RequestUser } from "../types";

/**
 * Record-level access for events and tasks: who reaches which rows, beyond
 * "may you open the screen" (PermissionsGuard) and "which cities are yours"
 * (CityScopeService).
 *
 * THE RULE, STATED ONCE
 *
 * An event is reachable when the person is org-wide, or is attached to it —
 * as its PM, as a crew member, as the owner of one of its tasks — or when
 * their department owns it or has been named as supporting it. A task is
 * reachable on the same grounds, plus its own department fields.
 *
 * That last clause is the cross-department dependency the business actually
 * runs on. Operations owns an event and raises "prepare the client
 * proposal", a Sales task. Sales does not become a member of the event and
 * does not gain the event's vendor, finance or internal sections; Sales
 * reaches that one task, and — because you cannot work a task without
 * knowing what it belongs to — the event's general information. The money
 * and HR sections of the same rows are stripped separately, by
 * field-policy.ts, which is what keeps "reaches the event" from meaning
 * "reads everything on the event".
 *
 * Everything below returns a Prisma `where` fragment rather than filtering in
 * memory: the restriction has to be in the query, or a paged list quietly
 * leaks the count even when it hides the rows.
 */
@Injectable()
export class AccessScopeService {
  constructor(private readonly cityScope: CityScopeService) {}

  /**
   * Does the caller see every event in their cities, or only the ones they
   * are attached to?
   *
   * `projects:view` is the line. The roles that run events — Operations,
   * Project Manager, Finance, and the three organisation-wide roles — hold
   * it and get the whole list for their cities; what they may read OF each
   * event is then decided by field-policy.ts, which is where revenue and
   * margin are taken away.
   *
   * The roles that do not hold it — Sales, Marketing, Social Media,
   * Creative, HR, Employee — never open the event list at all. They reach an
   * event only through a task raised for them on it, which is exactly the
   * dependency rule: the event name and client name they need to do the
   * work, and nothing else.
   *
   * An earlier version applied department scoping to EVERYONE. That was
   * wrong in a way worth recording: no existing event has an owning
   * department, so the department clause matched nothing and every Project
   * Manager and the whole Finance team saw an empty Projects screen.
   */
  private unrestricted(user: RequestUser): boolean {
    return isOrgWide(user.roleNames) || user.permissions.has("projects:view");
  }

  /**
   * Events this person may reach, as a `where` fragment. Always intersected
   * with city access, which stays the outer boundary: a department grant
   * never reaches into a city the person has no access to.
   */
  projectWhere(user: RequestUser, cityId?: string): Prisma.ProjectWhereInput {
    const base: Prisma.ProjectWhereInput = {
      workspaceId: user.workspaceId,
      deletedAt: null,
      ...(this.cityScope.scopeFilter(user, cityId) as Prisma.ProjectWhereInput),
    };
    if (this.unrestricted(user)) return base;

    const reach: Prisma.ProjectWhereInput[] = [
      { pmId: user.id },
      { members: { some: { userId: user.id, deletedAt: null } } },
      { tasks: { some: { ownerId: user.id, deletedAt: null } } },
    ];
    if (user.departmentId) {
      reach.push({ primaryDeptId: user.departmentId });
      reach.push({ supportingDepts: { some: { departmentId: user.departmentId } } });
      // The dependency case: a task of theirs, or of their department, on
      // somebody else's event.
      reach.push({ tasks: { some: { deletedAt: null, primaryDeptId: user.departmentId } } });
      reach.push({ tasks: { some: { deletedAt: null, supportingDepts: { some: { departmentId: user.departmentId } } } } });
    }
    return { ...base, OR: reach };
  }

  /** Tasks this person may reach. Same shape, same reasoning. */
  taskWhere(user: RequestUser, cityId?: string): Prisma.TaskWhereInput {
    const base: Prisma.TaskWhereInput = {
      deletedAt: null,
      project: { workspaceId: user.workspaceId, ...(this.cityScope.scopeFilter(user, cityId) as Prisma.ProjectWhereInput) },
    };
    if (this.unrestricted(user)) return base;

    const reach: Prisma.TaskWhereInput[] = [
      { ownerId: user.id },
      { project: { pmId: user.id } },
      { project: { members: { some: { userId: user.id, deletedAt: null } } } },
    ];
    if (user.departmentId) {
      reach.push({ primaryDeptId: user.departmentId });
      reach.push({ supportingDepts: { some: { departmentId: user.departmentId } } });
      // A task with no department of its own belongs to whoever owns the event.
      reach.push({ primaryDeptId: null, project: { primaryDeptId: user.departmentId } });
    }
    return { ...base, OR: reach };
  }

  /**
   * Throws unless this person may reach the given event. Used by detail and
   * write paths, which must agree with the list query exactly — a record
   * hidden from a list and openable by its id is not access control.
   */
  async assertProject(user: RequestUser, projectId: string, db: Prisma.TransactionClient | { project: { findFirst: (a: unknown) => Promise<unknown> } }): Promise<void> {
    const client = db as unknown as { project: { findFirst: (args: unknown) => Promise<{ id: string } | null> } };
    const found = await client.project.findFirst({ where: { AND: [{ id: projectId }, this.projectWhere(user)] }, select: { id: true } });
    if (!found) throw new ForbiddenException("You do not have access to this event.");
  }
}

/**
 * The departments whose work a person can see without being named on the
 * record: their own, and — for an org-wide role — every one of them.
 */
export function visibleDepartmentIds(user: RequestUser): string[] | "ALL" {
  if (isOrgWide(user.roleNames)) return "ALL";
  return user.departmentId ? [user.departmentId] : [];
}

/**
 * The only shape a User may take when it travels out of the API as somebody
 * else's relation — a project's PM, a flow step's owner, a task's assignee.
 *
 * WHY THIS EXISTS (BUG-004). Prisma's `include: { pm: true }` returns *every*
 * scalar on the related row, and `User` carries `passwordHash`. So
 * `GET /api/projects` was handing each project manager's bcrypt hash to any
 * caller holding `projects:view`. Confirmed against production on 2026-09-16
 * by replaying the query: `passwordHash present: true`, and not null.
 *
 * A hash is not a password, but it is offline-crackable material tied to a
 * named account, and it has no business leaving the server at all.
 *
 * The fix is deliberately a shared constant rather than four hand-written
 * `select` blocks. Hand-written ones are how this happened: each site looked
 * reasonable on its own, and nothing connected them. Anyone adding a fifth
 * relation now has one obvious thing to reach for, and the e2e test in
 * security.e2e-spec.ts asserts on the API response rather than on this file,
 * so a future `include: { user: true }` written in ignorance still fails.
 *
 * Fields are listed positively. Never switch this to an exclusion list: a
 * `select` that names what to omit silently re-exposes every column added to
 * User afterwards.
 */
export const SAFE_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  dept: true,
  isActive: true,
} as const;

/**
 * The same shape for a nested membership row — `{ include: { user: true } }`
 * becomes `{ include: { user: { select: SAFE_USER_SELECT } } }`.
 */
export const SAFE_USER_INCLUDE = { select: SAFE_USER_SELECT } as const;

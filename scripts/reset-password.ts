/**
 * Break-glass password reset, for when no Founder/Admin can sign in to do it
 * from Team & logins (e.g. the only Founder has forgotten their password).
 *
 * Does exactly what AuthService.resetPassword does in the app:
 *   - clears the password, so the next sign-in sets a new permanent one
 *     (typed twice), exactly like a first sign-in;
 *   - revokes every open session (refresh token) for the account;
 *   - clears failed attempts and any lockout;
 *   - writes an audit_logs row (actor: none — this was run from the server).
 *
 * Usage:  pnpm reset:password <username>
 * Needs shell access to the server and its .env — which is the point: it is
 * not reachable from the web.
 */
import { prisma } from "@podium/db";

async function main() {
  const username = (process.argv[2] ?? "").trim().toLowerCase();
  if (!username) {
    console.error("Usage: pnpm reset:password <username>");
    process.exit(1);
  }
  const user = await prisma.user.findFirst({ where: { username, deletedAt: null }, select: { id: true, name: true, workspaceId: true } });
  if (!user) {
    console.error(`No account with username "${username}".`);
    process.exit(1);
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: null, passwordChangedAt: null, mustChangePassword: false, failedLoginAttempts: 0, lockedUntil: null },
    }),
    prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.auditLog.create({
      data: {
        workspaceId: user.workspaceId,
        actorId: null,
        action: "auth.password_reset",
        entityType: "user",
        entityId: user.id,
        after: { via: "scripts/reset-password.ts" },
      },
    }),
  ]);

  console.log(`Password cleared for ${user.name} (${username}).`);
  console.log("Next sign-in: enter a new password, then type it again to confirm — it becomes the permanent password.");
  console.log("Note: the API caches signed-in users for up to 60 s; sign in after a minute if the old session still appears.");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

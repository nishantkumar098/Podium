import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __podiumPrisma: PrismaClient | undefined;
}

export const prisma =
  global.__podiumPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    // Prisma aborts an interactive transaction after 5 s by default. With the
    // database in Sydney each statement is a ~0.3 s round trip, so a
    // multi-step save (document upload, letter + Documents copy, invoice
    // issue, payment) routinely ran past 5 s and failed with a 500
    // ("Transaction already closed"). These limits leave ample headroom
    // while still bounding a genuinely stuck transaction.
    transactionOptions: { maxWait: 15_000, timeout: 60_000 },
  });

if (process.env.NODE_ENV !== "production") {
  global.__podiumPrisma = prisma;
}

export * from "@prisma/client";

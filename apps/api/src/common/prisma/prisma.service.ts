import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { prisma, PrismaClient } from "@podium/db";

/**
 * Thin wrapper around the shared @podium/db Prisma client so Nest's DI
 * container can inject it like any other provider. There is exactly one
 * PrismaClient instance per process (see @podium/db/src/index.ts).
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient = prisma;

  async onModuleInit() {
    await this.client.$connect();
  }

  async onModuleDestroy() {
    await this.client.$disconnect();
  }
}

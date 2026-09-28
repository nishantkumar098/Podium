import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";

const LIST_LIMIT = 50;

/**
 * Notifications (Phase G, blueprint §12). Every notification row here is
 * created by some other service (flows, event day, automation handlers,
 * chat mentions, ...) — this module only ever reads/marks-read a caller's
 * own rows. There is no permission gate beyond authentication: "your own
 * notifications" needs no RBAC check, same standing as GET /users/me.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: RequestUser, unreadOnly = false) {
    return this.prisma.client.notification.findMany({
      where: { workspaceId: user.workspaceId, userId: user.id, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
    });
  }

  async unreadCount(user: RequestUser) {
    const count = await this.prisma.client.notification.count({
      where: { workspaceId: user.workspaceId, userId: user.id, readAt: null },
    });
    return { count };
  }

  async markRead(user: RequestUser, id: string) {
    const existing = await this.prisma.client.notification.findFirst({ where: { id, userId: user.id } });
    if (!existing) throw new NotFoundException("Notification not found.");
    if (existing.readAt) return existing;
    return this.prisma.client.notification.update({ where: { id }, data: { readAt: new Date() } });
  }

  async markAllRead(user: RequestUser) {
    const result = await this.prisma.client.notification.updateMany({
      where: { workspaceId: user.workspaceId, userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }
}

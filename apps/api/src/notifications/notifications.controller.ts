import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { RequestUser } from "../common/types";
import { NotificationsService } from "./notifications.service";

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Query("unreadOnly") unreadOnly?: string) {
    return this.notifications.list(user, unreadOnly === "true");
  }

  @Get("unread-count")
  unreadCount(@CurrentUser() user: RequestUser) {
    return this.notifications.unreadCount(user);
  }

  @Post(":id/read")
  markRead(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user, id);
  }

  @Post("read-all")
  markAllRead(@CurrentUser() user: RequestUser) {
    return this.notifications.markAllRead(user);
  }
}

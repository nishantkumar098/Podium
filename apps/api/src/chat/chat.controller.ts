import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { postMessageSchema, promoteMessageSchema } from "@podium/shared-types";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { z } from "zod";
import { ChatService } from "./chat.service";

const createChannelSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["COMPANY", "CITY"]),
  cityId: z.string().uuid().optional(),
  description: z.string().max(300).optional(),
});

const openDmSchema = z.object({ userId: z.string().uuid() });
const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  memberIds: z.array(z.string().uuid()).min(1).max(200),
  description: z.string().max(300).optional(),
});
const addMembersSchema = z.object({ userIds: z.array(z.string().uuid()).min(1).max(200) });

@Controller()
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get("channels")
  listChannels(@CurrentUser() user: RequestUser) {
    return this.chat.listChannels(user);
  }

  @Post("channels")
  createChannel(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createChannelSchema)) body: z.infer<typeof createChannelSchema>) {
    return this.chat.createChannel(user, body);
  }

  /** Everyone, in every city, you can message or add to a group. */
  @Get("channels/people")
  people(@CurrentUser() user: RequestUser) {
    return this.chat.people(user);
  }

  /** Open (or reuse) a private conversation with one person. */
  @Post("channels/dm")
  openDm(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(openDmSchema)) body: z.infer<typeof openDmSchema>) {
    return this.chat.openDm(user, body.userId);
  }

  @Post("channels/groups")
  createGroup(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createGroupSchema)) body: z.infer<typeof createGroupSchema>) {
    return this.chat.createGroup(user, body);
  }

  @Get("channels/:id/members")
  members(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.chat.members(user, id);
  }

  @Post("channels/:id/members")
  @Audit("channel", "chat.group_members_added")
  addMembers(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(addMembersSchema)) body: z.infer<typeof addMembersSchema>) {
    return this.chat.addMembers(user, id, body.userIds);
  }

  @Delete("channels/:id/members/:userId")
  @Audit("channel", "chat.group_member_removed")
  removeMember(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string, @Param("userId", ParseUUIDPipe) userId: string) {
    return this.chat.removeMember(user, id, userId);
  }

  @Get("channels/:id/messages")
  messages(@CurrentUser() user: RequestUser, @Param("id") id: string, @Query("cursor") cursor?: string) {
    return this.chat.messages(user, id, cursor);
  }

  /**
   * What the promote-to-task confirm dialog needs. Gated on tasks:view rather
   * than tasks:create so a project member can open the dialog; the actual
   * promotion re-checks role-or-membership properly.
   */
  @Get("messages/:messageId/promotion-preview")
  @RequirePermissions("tasks:view")
  promotionPreview(@CurrentUser() user: RequestUser, @Param("messageId") messageId: string) {
    return this.chat.promotionPreview(user, messageId);
  }

  @Post("messages/:messageId/promote-task")
  @RequirePermissions("tasks:view")
  @Audit("task", "task.promoted_from_message")
  promoteTask(
    @CurrentUser() user: RequestUser,
    @Param("messageId") messageId: string,
    @Body(new ZodValidationPipe(promoteMessageSchema)) body: ReturnType<typeof promoteMessageSchema.parse>,
  ) {
    return this.chat.promoteMessageToTask(user, messageId, body);
  }

  @Post("channels/:id/messages")
  @Audit("message", "chat.post_message")
  postMessage(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(postMessageSchema)) body: ReturnType<typeof postMessageSchema.parse>) {
    return this.chat.postMessage(user, id, body);
  }
}

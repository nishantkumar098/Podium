import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PostMessageInput, PromoteMessageInput } from "@podium/shared-types";
import { AutomationService } from "../automation/automation.service";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";
import { resolveMentions, suggestTaskName } from "./mentions";
import { unreadByChannel, visibleChannelsWhere } from "./unread";
import { ORG_WIDE_ROLES } from "../common/rbac/model";

/**
 * Chat (blueprint §23): company/city/project/DM channels, plus @mention ->
 * task promotion (the prototype's worked "@Rohit please confirm sound vendor"
 * example).
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
    private readonly automation: AutomationService,
  ) {}

  /**
   * Channels the person can read, each with its unread count and when it
   * last had a message, plus the project or city it belongs to.
   */
  async listChannels(user: RequestUser) {
    const db = this.prisma.client;
    const channels = await db.channel.findMany({
      where: visibleChannelsWhere(user),
      include: { project: { select: { id: true, name: true } }, city: { select: { id: true, name: true } } },
      orderBy: { name: "asc" },
    });
    const ids = channels.map((c) => c.id);
    const [unread, latest] = await Promise.all([
      unreadByChannel(db, user.id, ids),
      ids.length
        ? db.message.groupBy({ by: ["channelId"], where: { channelId: { in: ids }, deletedAt: null }, _max: { createdAt: true } })
        : Promise.resolve([] as Array<{ channelId: string; _max: { createdAt: Date | null } }>),
    ]);
    const lastAt = new Map(latest.map((l) => [l.channelId, l._max.createdAt]));
    // Private conversations carry their members, so a DM can be shown under
    // the other person's name and a group can show who's in it.
    const privateIds = channels.filter((c) => c.kind === "DM" || c.kind === "GROUP").map((c) => c.id);
    const memberRows = privateIds.length
      ? await db.channelMember.findMany({ where: { channelId: { in: privateIds } }, select: { channelId: true, user: { select: { id: true, name: true } } } })
      : [];
    const membersOf = new Map<string, Array<{ id: string; name: string }>>();
    for (const m of memberRows) membersOf.set(m.channelId, [...(membersOf.get(m.channelId) ?? []), m.user]);
    return channels.map((c) => {
      const members = membersOf.get(c.id);
      const other = c.kind === "DM" ? members?.find((m) => m.id !== user.id) : undefined;
      return {
        ...c,
        ...(members ? { members } : {}),
        ...(c.kind === "DM" ? { displayName: other?.name ?? "Private message", withUserId: other?.id ?? null } : {}),
        unread: unread.get(c.id) ?? 0,
        lastMessageAt: lastAt.get(c.id) ?? null,
      };
    });
  }

  /**
   * A page of messages, newest first, with each author's name. Opening the
   * newest page marks the channel read for this person.
   */
  async messages(user: RequestUser, channelId: string, cursor?: string, limit = 50) {
    await this.assertChannelAccess(user, channelId);
    const db = this.prisma.client;
    const rows = await db.message.findMany({
      where: { channelId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { author: { select: { id: true, name: true } } },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!cursor) {
      const now = new Date();
      await db.channelMember.upsert({
        where: { channelId_userId: { channelId, userId: user.id } },
        create: { channelId, userId: user.id, lastReadAt: now },
        update: { lastReadAt: now },
      });
    }
    return rows.map(({ author, ...m }) => ({ ...m, authorName: author?.name ?? null }));
  }

  /**
   * New company-wide or city channel. Project channels are made with their
   * project; DMs are not offered. Founder/Admin/Operations only.
   */
  async createChannel(user: RequestUser, input: { name: string; kind: "COMPANY" | "CITY"; cityId?: string; description?: string }) {
    if (!user.roleNames.some((r) => [...ORG_WIDE_ROLES, "Operations"].includes(r))) {
      throw new ForbiddenException("Only the Founder, Admin or Operations can create channels.");
    }
    const name = input.name.toLowerCase().trim().replace(/^#/, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    if (!name) throw new BadRequestException("Give the channel a name.");
    if (input.kind === "CITY") {
      if (!input.cityId) throw new BadRequestException("Choose the city for a city channel.");
      this.cityScope.assertCanAccessCity(user, input.cityId);
    }
    const clash = await this.prisma.client.channel.findFirst({ where: { workspaceId: user.workspaceId, name, deletedAt: null } });
    if (clash) throw new BadRequestException(`#${name} already exists.`);
    const channel = await this.prisma.client.channel.create({
      data: {
        workspaceId: user.workspaceId,
        name,
        kind: input.kind,
        cityId: input.kind === "CITY" ? input.cityId : null,
        description: input.description?.trim() || null,
      },
    });
    await this.prisma.client.auditLog.create({
      data: { workspaceId: user.workspaceId, actorId: user.id, action: "chat.channel_created", entityType: "channel", entityId: channel.id, after: { name, kind: input.kind } },
    });
    return channel;
  }

  /**
   * Everyone you can message or add to a group: every active staff member of
   * the workspace, in every city (portal users excluded), with their home
   * city and role so the picker can group and label them.
   */
  async people(user: RequestUser) {
    const rows = await this.prisma.client.user.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null, isActive: true, isExternal: false, id: { not: user.id } },
      select: { id: true, name: true, username: true, primaryRole: { select: { name: true } }, primaryCity: { select: { name: true } } },
      orderBy: { name: "asc" },
    });
    return rows.map((r) => ({ id: r.id, name: r.name, username: r.username, role: r.primaryRole?.name ?? null, city: r.primaryCity?.name ?? null }));
  }

  /** Opens (or reuses) the private conversation between you and one person. */
  async openDm(user: RequestUser, otherId: string) {
    if (otherId === user.id) throw new BadRequestException("Pick someone other than yourself.");
    await this.assertPeople(user, [otherId]);
    // One conversation per pair: a stable name from the two ids finds it again.
    const name = "dm-" + [user.id, otherId].sort().join("-");
    const db = this.prisma.client;
    const existing = await db.channel.findFirst({ where: { workspaceId: user.workspaceId, kind: "DM", name, deletedAt: null } });
    if (existing) return existing;
    return db.channel.create({
      data: {
        workspaceId: user.workspaceId,
        name,
        kind: "DM",
        createdById: user.id,
        members: { create: [{ userId: user.id, lastReadAt: new Date() }, { userId: otherId }] },
      },
    });
  }

  /** A custom group anyone can make, with anyone from any city in it. */
  async createGroup(user: RequestUser, input: { name: string; memberIds: string[]; description?: string }) {
    const name = input.name.trim().replace(/\s+/g, " ");
    if (!name) throw new BadRequestException("Give the group a name.");
    const ids = [...new Set(input.memberIds.filter((id) => id !== user.id))];
    if (ids.length === 0) throw new BadRequestException("Add at least one person to the group.");
    await this.assertPeople(user, ids);
    const channel = await this.prisma.client.channel.create({
      data: {
        workspaceId: user.workspaceId,
        name,
        kind: "GROUP",
        description: input.description?.trim() || null,
        createdById: user.id,
        members: { create: [{ userId: user.id, lastReadAt: new Date() }, ...ids.map((userId) => ({ userId }))] },
      },
    });
    await this.prisma.client.message.create({ data: { channelId: channel.id, authorId: null, body: user.name + " created the group \u201c" + name + "\u201d." } });
    await this.prisma.client.auditLog.create({
      data: { workspaceId: user.workspaceId, actorId: user.id, action: "chat.group_created", entityType: "channel", entityId: channel.id, after: { name, members: ids.length + 1 } },
    });
    return channel;
  }

  /** Who is in a private conversation or group. */
  async members(user: RequestUser, channelId: string) {
    const channel = await this.assertChannelAccess(user, channelId);
    const rows = await this.prisma.client.channelMember.findMany({
      where: { channelId },
      select: { joinedAt: true, user: { select: { id: true, name: true, primaryRole: { select: { name: true } }, primaryCity: { select: { name: true } } } } },
      orderBy: { joinedAt: "asc" },
    });
    return {
      createdById: channel.createdById,
      members: rows.map((r) => ({ id: r.user.id, name: r.user.name, role: r.user.primaryRole?.name ?? null, city: r.user.primaryCity?.name ?? null, joinedAt: r.joinedAt })),
    };
  }

  /** Any member of a group can add people to it. */
  async addMembers(user: RequestUser, channelId: string, userIds: string[]) {
    const channel = await this.assertChannelAccess(user, channelId);
    if (channel.kind !== "GROUP") throw new BadRequestException("People can only be added to groups.");
    const db = this.prisma.client;
    const current = new Set((await db.channelMember.findMany({ where: { channelId }, select: { userId: true } })).map((m) => m.userId));
    const fresh = [...new Set(userIds)].filter((id) => !current.has(id));
    if (fresh.length === 0) return { added: 0 };
    await this.assertPeople(user, fresh);
    await db.channelMember.createMany({ data: fresh.map((userId) => ({ channelId, userId })), skipDuplicates: true });
    const names = (await db.user.findMany({ where: { id: { in: fresh } }, select: { name: true } })).map((u) => u.name);
    await db.message.create({ data: { channelId, authorId: null, body: user.name + " added " + names.join(", ") + "." } });
    return { added: fresh.length };
  }

  /**
   * Leave a group yourself, or, as the person who created it, remove
   * someone. Direct messages have no membership to change.
   */
  async removeMember(user: RequestUser, channelId: string, userId: string) {
    const channel = await this.assertChannelAccess(user, channelId);
    if (channel.kind !== "GROUP") throw new BadRequestException("Only group membership can be changed.");
    const self = userId === user.id;
    if (!self && channel.createdById !== user.id) throw new ForbiddenException("Only the person who created this group can remove members.");
    const db = this.prisma.client;
    const gone = await db.user.findFirst({ where: { id: userId }, select: { name: true } });
    await db.channelMember.deleteMany({ where: { channelId, userId } });
    await db.message.create({ data: { channelId, authorId: null, body: self ? user.name + " left the group." : user.name + " removed " + (gone?.name ?? "a member") + "." } });
    return { removed: true };
  }

  /** Everyone named must be an active staff member of this workspace. */
  private async assertPeople(user: RequestUser, ids: string[]) {
    const found = await this.prisma.client.user.count({ where: { id: { in: ids }, workspaceId: user.workspaceId, deletedAt: null, isActive: true, isExternal: false } });
    if (found !== new Set(ids).size) throw new BadRequestException("One or more of those people could not be found.");
  }

  async postMessage(user: RequestUser, channelId: string, input: PostMessageInput) {
    await this.assertChannelAccess(user, channelId);
    const message = await this.prisma.client.message.create({ data: { channelId, authorId: user.id, body: input.body } });

    // Rule au11 ("Chat @mention -> notification"). Fired after the write has
    // committed, same convention as every other automation.emit() call in
    // this codebase — a notification failing must never roll back the
    // message that already posted. Real, resolved mentions only: an
    // unresolved or ambiguous handle notifies nobody rather than guessing.
    const roster = await this.prisma.client.user.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null },
      select: { id: true, name: true, username: true, email: true },
    });
    const mentioned = resolveMentions(message.body, roster)
      .map((m) => m.user)
      .filter((u): u is NonNullable<typeof u> => u !== null && u.id !== user.id);
    for (const target of mentioned) {
      await this.automation.emit({
        trigger: "chat.mentioned",
        workspaceId: user.workspaceId,
        entityType: "chat_mention",
        entityId: `${message.id}:${target.id}`,
        payload: { mentionedUserId: target.id, senderName: user.name, snippet: message.body.slice(0, 140), messageId: message.id, channelId },
      });
    }

    return message;
  }


  /**
   * What the confirm dialog needs before anything is written: who the message
   * mentions, which project the task would land in, and a suggested title.
   * The due date is deliberately NOT suggested — blueprint §23 has the sender
   * confirm it, and a guessed deadline is a guessed commitment.
   */
  async promotionPreview(user: RequestUser, messageId: string) {
    const { message, channel } = await this.loadPromotableMessage(user, messageId);
    const roster = await this.prisma.client.user.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null },
      select: { id: true, name: true, username: true, email: true },
    });
    const mentions = resolveMentions(message.body, roster);
    const assignee = mentions.find((m) => m.user)?.user ?? null;

    return {
      messageId: message.id,
      channelId: channel.id,
      project: channel.project ? { id: channel.project.id, name: channel.project.name } : null,
      suggestedName: suggestTaskName(message.body),
      suggestedOwner: assignee,
      mentions: mentions.map((m) => ({
        handle: m.handle,
        resolved: m.user ? { id: m.user.id, name: m.user.name } : null,
        ambiguousWith: m.ambiguousWith ?? null,
      })),
      /** The sender must supply this; there is nothing to infer it from. */
      dueAtRequired: true,
    };
  }

  /**
   * Promotes a chat message into a real task, links the task back to the
   * message it came from, and posts a Podium Bot confirmation into the same
   * channel so the thread shows what happened. All three writes plus the audit
   * row happen in one transaction — a task whose channel never acknowledged it
   * is exactly the kind of silent half-success this module must not produce.
   */
  async promoteMessageToTask(user: RequestUser, messageId: string, input: PromoteMessageInput) {
    const { message, channel } = await this.loadPromotableMessage(user, messageId);

    const project = channel.project;
    if (!project) {
      throw new BadRequestException(
        "This message is not in a project channel, so there is no project to attach a task to. Promote a message from a project channel instead.",
      );
    }
    this.cityScope.assertCanAccessCity(user, project.cityId);

    // Role grant OR membership of this specific project — blueprint §23 lets a
    // project member promote a message even when their role alone could not
    // create tasks anywhere else.
    const canByRole = user.permissions.has("tasks:create");
    const isMember =
      project.pmId === user.id ||
      (await this.prisma.client.projectMember.count({ where: { projectId: project.id, userId: user.id } })) > 0;
    if (!canByRole && !isMember) {
      throw new ForbiddenException("Only members of this project, or Ops/PM/Admin/Founder, can promote a message to a task.");
    }

    const existing = await this.prisma.client.task.findFirst({ where: { sourceMessageId: message.id, deletedAt: null } });
    if (existing) {
      throw new BadRequestException(`This message was already promoted to the task "${existing.name}".`);
    }

    const owner = await this.prisma.client.user.findFirst({
      where: { id: input.ownerId, workspaceId: user.workspaceId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!owner) throw new BadRequestException("The assignee is not a user in this workspace.");

    return this.prisma.client.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          projectId: project.id,
          name: input.name,
          ownerId: owner.id,
          dueAt: input.dueAt,
          priority: input.priority ?? "MEDIUM",
          status: "PLANNED",
          sourceMessageId: message.id,
          createdById: user.id,
          updatedById: user.id,
        },
      });

      // authorId null => "Podium Bot", the same convention the flow engine uses.
      await tx.message.create({
        data: {
          channelId: channel.id,
          authorId: null,
          body: `Task created from ${user.name}'s message: "${task.name}" — assigned to ${owner.name}, due ${input.dueAt.toISOString().slice(0, 10)}.`,
        },
      });

      await tx.notification.create({
        data: {
          workspaceId: user.workspaceId,
          userId: owner.id,
          icon: "☑",
          text: `${user.name} assigned you a task from chat: ${task.name}`,
          sourceType: "task",
          sourceId: task.id,
        },
      });

      await tx.auditLog.create({
        data: {
          workspaceId: user.workspaceId,
          actorId: user.id,
          action: "task.promoted_from_message",
          entityType: "task",
          entityId: task.id,
          after: { messageId: message.id, channelId: channel.id, projectId: project.id, ownerId: owner.id, name: task.name },
        },
      });

      return task;
    });
  }

  private async loadPromotableMessage(user: RequestUser, messageId: string) {
    const message = await this.prisma.client.message.findFirst({
      where: { id: messageId, deletedAt: null, channel: { workspaceId: user.workspaceId } },
    });
    if (!message) throw new NotFoundException("Message not found.");
    if (message.authorId === null) {
      throw new BadRequestException("Podium Bot messages cannot be promoted to tasks.");
    }
    const channel = await this.assertChannelAccess(user, message.channelId);
    return { message, channel };
  }

  private async assertChannelAccess(user: RequestUser, channelId: string) {
    const channel = await this.prisma.client.channel.findFirst({ where: { id: channelId, workspaceId: user.workspaceId, deletedAt: null }, include: { project: true } });
    if (!channel) throw new NotFoundException("Channel not found.");
    if (channel.kind === "CITY" && channel.cityId) this.cityScope.assertCanAccessCity(user, channel.cityId);
    if (channel.kind === "PROJECT" && channel.project) this.cityScope.assertCanAccessCity(user, channel.project.cityId);
    // A department group is exactly its department's people — derived from
    // the profile, the same rule listChannels uses.
    if (channel.kind === "DEPARTMENT" && channel.departmentId !== user.departmentId) {
      throw new NotFoundException("Channel not found.");
    }
    // Private messages and groups: members only; city access doesn't open them.
    if (channel.kind === "DM" || channel.kind === "GROUP") {
      const member = await this.prisma.client.channelMember.count({ where: { channelId, userId: user.id } });
      if (!member) throw new NotFoundException("Channel not found.");
    }
    return channel;
  }
}

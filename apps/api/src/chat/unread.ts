import { Prisma, type PrismaClient } from "@podium/db";
import { allowedCityIds, type RequestUser } from "../common/types";

/**
 * How far back counts as unread in a channel the person has never opened.
 * Without a cap, joining Podium would greet everyone with every message ever
 * posted in #general as "unread".
 */
const NEVER_OPENED_WINDOW = "14 days";

/**
 * The channels a person can read — the same rule as ChatService.listChannels.
 *
 * Company, city and department channels are DERIVED from the person's
 * profile rather than from ChannelMember rows: a city group follows their
 * city access and a department group follows User.departmentId, so moving
 * somebody from Delhi to Jaipur, or from Sales to Marketing, moves their
 * groups with them and nobody has to remember to add or remove them.
 * ChannelMember rows still exist for these channels, but they carry only
 * lastReadAt — never the right to read.
 *
 * Project channels follow city access. Private messages (DM) and custom
 * groups (GROUP) are the exception: those are readable by their members
 * only, and city or department access never opens them.
 */
export function visibleChannelsWhere(user: RequestUser): Prisma.ChannelWhereInput {
  const allowed = allowedCityIds(user);
  const or: Prisma.ChannelWhereInput[] = [
    { kind: "COMPANY" },
    { kind: "CITY", cityId: allowed === "ALL" ? undefined : { in: allowed } },
    { kind: "PROJECT", project: { ...(allowed === "ALL" ? {} : { cityId: { in: allowed } }) } },
    { kind: { in: ["DM", "GROUP"] }, members: { some: { userId: user.id } } },
  ];
  // Someone with no department belongs to no department group. Spelt out
  // rather than left to `departmentId: undefined`, which Prisma reads as
  // "no filter" and would show every department's channel.
  if (user.departmentId) or.push({ kind: "DEPARTMENT", departmentId: user.departmentId });
  return { workspaceId: user.workspaceId, deletedAt: null, OR: or };
}

/**
 * Unread messages per channel: messages by other people (or Podium Bot)
 * posted after the person last opened that channel.
 */
export async function unreadByChannel(db: PrismaClient, userId: string, channelIds: string[]): Promise<Map<string, number>> {
  if (channelIds.length === 0) return new Map();
  const rows = await db.$queryRaw<Array<{ channel_id: string; n: number }>>`
    SELECT m.channel_id, count(*)::int AS n
    FROM messages m
    LEFT JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ${userId}::uuid
    WHERE m.channel_id IN (${Prisma.join(channelIds.map((id) => Prisma.sql`${id}::uuid`))})
      AND m.deleted_at IS NULL
      AND (m.author_id IS NULL OR m.author_id <> ${userId}::uuid)
      AND m.created_at > COALESCE(cm.last_read_at, now() - ${NEVER_OPENED_WINDOW}::interval)
    GROUP BY m.channel_id`;
  return new Map(rows.map((r) => [r.channel_id, Number(r.n)]));
}

export async function totalUnread(db: PrismaClient, user: RequestUser): Promise<number> {
  const channels = await db.channel.findMany({ where: visibleChannelsWhere(user), select: { id: true } });
  const counts = await unreadByChannel(db, user.id, channels.map((c) => c.id));
  return [...counts.values()].reduce((s, n) => s + n, 0);
}

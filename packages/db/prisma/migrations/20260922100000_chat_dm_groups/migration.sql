-- Private messages and custom groups: DM and GROUP channels are readable by
-- their members only (channel_members). A group records who created it.
ALTER TYPE "ChannelKind" ADD VALUE IF NOT EXISTS 'GROUP';
ALTER TABLE "channels" ADD COLUMN "created_by_id" UUID;

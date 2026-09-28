-- "Are you free for this event?", asked of one bartender.
--
-- Freelancer.is_available is a single global flag; availability is per-event.
-- This is the per-event answer and the audit trail behind it.

CREATE TYPE "CrewRequestStatus" AS ENUM ('SENT', 'AVAILABLE', 'UNAVAILABLE', 'FAILED');

CREATE TABLE "crew_requests" (
  "id"            UUID NOT NULL,
  "workspace_id"  UUID NOT NULL,
  "project_id"    UUID NOT NULL,
  "freelancer_id" UUID NOT NULL,
  "status"        "CrewRequestStatus" NOT NULL DEFAULT 'SENT',
  "channel"       TEXT NOT NULL DEFAULT 'whatsapp',
  "provider_ref"  TEXT,
  "reply_text"    TEXT,
  "sent_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "responded_at"  TIMESTAMP(3),
  "created_by"    UUID,
  CONSTRAINT "crew_requests_pkey" PRIMARY KEY ("id")
);

-- One live ask per person per event: asking twice means two messages and a
-- second answer that silently overwrites the first.
CREATE UNIQUE INDEX "crew_requests_project_id_freelancer_id_key" ON "crew_requests" ("project_id", "freelancer_id");
CREATE INDEX "crew_requests_workspace_id_status_idx" ON "crew_requests" ("workspace_id", "status");

ALTER TABLE "crew_requests" ADD CONSTRAINT "crew_requests_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crew_requests" ADD CONSTRAINT "crew_requests_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crew_requests" ADD CONSTRAINT "crew_requests_freelancer_id_fkey"
  FOREIGN KEY ("freelancer_id") REFERENCES "freelancers" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

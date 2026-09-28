-- Departments, and the department ownership that project/task access is
-- scoped by. See apps/api/src/common/rbac/model.ts for the roles that sit on
-- top of this, and access-scope.service.ts for how the columns are read.

ALTER TYPE "ChannelKind" ADD VALUE IF NOT EXISTS 'DEPARTMENT';

CREATE TABLE "departments" (
  "id"           UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "key"          TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,
  "deleted_at"   TIMESTAMP(3),
  CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "departments_workspace_id_key_key" ON "departments" ("workspace_id", "key");

ALTER TABLE "departments"
  ADD CONSTRAINT "departments_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- who belongs to a department ------------------------------------------
ALTER TABLE "users" ADD COLUMN "department_id" UUID;
ALTER TABLE "users"
  ADD CONSTRAINT "users_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "users_department_id_idx" ON "users" ("department_id");

-- --- which department owns an event, and which ones support it ------------
ALTER TABLE "projects" ADD COLUMN "primary_dept_id" UUID;
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_primary_dept_id_fkey"
  FOREIGN KEY ("primary_dept_id") REFERENCES "departments" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "project_departments" (
  "project_id"    UUID NOT NULL,
  "department_id" UUID NOT NULL,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_departments_pkey" PRIMARY KEY ("project_id", "department_id")
);
ALTER TABLE "project_departments"
  ADD CONSTRAINT "project_departments_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_departments"
  ADD CONSTRAINT "project_departments_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --- the same, per task: this is the cross-department dependency ----------
ALTER TABLE "tasks" ADD COLUMN "primary_dept_id" UUID;
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_primary_dept_id_fkey"
  FOREIGN KEY ("primary_dept_id") REFERENCES "departments" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "task_departments" (
  "task_id"       UUID NOT NULL,
  "department_id" UUID NOT NULL,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_departments_pkey" PRIMARY KEY ("task_id", "department_id")
);
ALTER TABLE "task_departments"
  ADD CONSTRAINT "task_departments_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_departments"
  ADD CONSTRAINT "task_departments_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --- department chat channels ---------------------------------------------
ALTER TABLE "channels" ADD COLUMN "department_id" UUID;
ALTER TABLE "channels"
  ADD CONSTRAINT "channels_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

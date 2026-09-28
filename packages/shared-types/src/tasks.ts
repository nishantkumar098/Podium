import { z } from "zod";

export const taskStatusEnum = z.enum([
  "BACKLOG", "PLANNED", "IN_PROGRESS", "CLIENT_REVIEW", "APPROVED", "COMPLETED",
]);
export const taskPriorityEnum = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export const createTaskSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1),
  ownerId: z.string().uuid(),
  dueAt: z.coerce.date().optional(),
  priority: taskPriorityEnum.default("MEDIUM"),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z.object({
  name: z.string().min(1).optional(),
  ownerId: z.string().uuid().optional(),
  dueAt: z.coerce.date().nullable().optional(),
  status: taskStatusEnum.optional(),
  priority: taskPriorityEnum.optional(),
  /** optimistic-concurrency guard — must match the row's current updatedAt */
  expectedUpdatedAt: z.coerce.date().optional(),
});
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

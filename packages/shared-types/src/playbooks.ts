import { z } from "zod";

/**
 * Playbooks (blueprint §19, Phase E): a reusable event-type template applied
 * when a Won deal is converted into a project. `defaultStages` is
 * informational only — an ordered description of the playbook's lifecycle
 * shown in the editor — it does not drive any automated Project.status
 * transition; Project.status is its own independently-managed field.
 * `defaultTasks` and `defaultFlowTemplateIds` ARE wired: converting a lead
 * with a playbookId creates one Task per entry and instantiates one flow per
 * template id, against the newly created project (see LeadsService.convert).
 */
export const playbookTaskSchema = z.object({
  name: z.string().min(1).max(200),
  /** Days before the project's eventDate this task should be due; omit for no due date. */
  dueOffsetDays: z.number().int().nonnegative().optional(),
});
export type PlaybookTaskInput = z.infer<typeof playbookTaskSchema>;

export const createPlaybookSchema = z.object({
  name: z.string().min(1).max(200),
  eventType: z.string().min(1).max(120),
  defaultStages: z.array(z.string().min(1)).default([]),
  defaultTasks: z.array(playbookTaskSchema).default([]),
  defaultFlowTemplateIds: z.array(z.string().uuid()).default([]),
});
export type CreatePlaybookInput = z.infer<typeof createPlaybookSchema>;

export const updatePlaybookSchema = createPlaybookSchema.partial();
export type UpdatePlaybookInput = z.infer<typeof updatePlaybookSchema>;

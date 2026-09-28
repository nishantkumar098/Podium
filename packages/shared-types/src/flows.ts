import { z } from "zod";

export const flowStepStatusEnum = z.enum([
  "LOCKED", "READY", "ACTIVE", "COMPLETED", "BLOCKED", "ESCALATED", "CANCELLED", "FAILED",
]);

export const instantiateFlowSchema = z.object({
  templateId: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string().min(1).optional(),
  /** override the template's default owner per step key, e.g. { a: userId } */
  ownerOverrides: z.record(z.string(), z.string().uuid()).optional(),
});
export type InstantiateFlowInput = z.infer<typeof instantiateFlowSchema>;

export const completeStepSchema = z.object({
  note: z.string().max(2000).optional(),
});
export type CompleteStepInput = z.infer<typeof completeStepSchema>;

export const reassignStepSchema = z.object({
  newOwnerId: z.string().uuid(),
});
export type ReassignStepInput = z.infer<typeof reassignStepSchema>;

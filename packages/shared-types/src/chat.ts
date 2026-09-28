import { z } from "zod";

export const postMessageSchema = z.object({
  body: z.string().min(1).max(4000),
});
export type PostMessageInput = z.infer<typeof postMessageSchema>;

/**
 * Chat -> task promotion (blueprint §23). `dueAt` is required, not optional:
 * the sender confirms the deadline, because nothing in the message body can
 * be trusted to imply one and a guessed date is a guessed commitment.
 */
export const promoteMessageSchema = z.object({
  name: z.string().min(1).max(200),
  ownerId: z.string().uuid(),
  dueAt: z.coerce.date(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
});
export type PromoteMessageInput = z.infer<typeof promoteMessageSchema>;

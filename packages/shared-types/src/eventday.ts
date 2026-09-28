import { z } from "zod";

/** Event Day (blueprint §20). */
const cueTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Cue times are event-day-local HH:MM.");

export const runsheetItemSchema = z.object({
  scheduledTime: cueTime,
  text: z.string().min(1).max(500),
  ownerId: z.string().uuid(),
  sortOrder: z.number().int().nonnegative().optional(),
});

export const createRunsheetSchema = z.object({ items: z.array(runsheetItemSchema).min(1) });
export type CreateRunsheetInput = z.infer<typeof createRunsheetSchema>;

export const addRunsheetItemSchema = runsheetItemSchema;
export type AddRunsheetItemInput = z.infer<typeof addRunsheetItemSchema>;

export const setRunsheetItemDoneSchema = z.object({ done: z.boolean() });
export type SetRunsheetItemDoneInput = z.infer<typeof setRunsheetItemDoneSchema>;

/** Omit userId to check yourself in; supplying one needs projects:edit. */
export const checkInSchema = z.object({ userId: z.string().uuid().optional() });
export type CheckInInput = z.infer<typeof checkInSchema>;

export const createIncidentSchema = z.object({
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  text: z.string().min(1).max(2000),
});
export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;

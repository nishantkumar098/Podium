import { z } from "zod";

export const leadStageEnum = z.enum(["LEAD", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "WON", "LOST"]);

export const createLeadSchema = z.object({
  name: z.string().min(1),
  value: z.number().nonnegative(),
  cityId: z.string().uuid(),
  ownerId: z.string().uuid(),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

export const updateLeadStageSchema = z.object({ stage: leadStageEnum });
export type UpdateLeadStageInput = z.infer<typeof updateLeadStageSchema>;

/**
 * Deal-Won -> Project auto-creation (blueprint §5A, automation au1). The
 * prototype's own au1 description ("Create project from playbook, assign
 * PM, generate tasks, create client folder, notify Ops") implies these
 * inputs; it does not specify UI for them, so this is the point where a
 * human (Sales/PM) supplies what the automation can't infer — matching
 * blueprint §12's "actions" vocabulary for this rule.
 */
export const convertLeadSchema = z.object({
  /** existing client, or omit + provide clientName to create one */
  clientId: z.string().uuid().optional(),
  clientName: z.string().min(1).optional(),
  clientType: z.enum(["INDIVIDUAL", "CORPORATE", "BRAND"]).optional(),
  projectName: z.string().min(1),
  projectType: z.string().min(1),
  eventDate: z.coerce.date(),
  pmId: z.string().uuid(),
  playbookId: z.string().uuid().optional(),
  /**
   * Required only when the lead itself has no city — true for most rows
   * imported from the real spreadsheets, whose `Location` was free text that
   * didn't unambiguously match one of the six Podium cities. A project must
   * have a city (it drives GST treatment and scoping), so the human doing the
   * conversion supplies it rather than the importer having guessed one.
   */
  cityId: z.string().uuid().optional(),
  /** Same story for deal value: cold/imported leads carry no estimate. */
  value: z.number().nonnegative().optional(),
});
export type ConvertLeadInput = z.infer<typeof convertLeadSchema>;

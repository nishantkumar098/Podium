import { z } from "zod";

export const toggleAutomationRuleSchema = z.object({ isEnabled: z.boolean() });
export type ToggleAutomationRuleInput = z.infer<typeof toggleAutomationRuleSchema>;

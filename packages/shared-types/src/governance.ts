import { z } from "zod";

export const riskSeverityEnum = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const riskStatusEnum = z.enum(["OPEN", "MITIGATING", "MONITORING", "CLOSED"]);

export const createRiskSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1),
  severity: riskSeverityEnum,
  ownerId: z.string().uuid(),
  impact: z.string().optional(),
});
export type CreateRiskInput = z.infer<typeof createRiskSchema>;

export const updateRiskSchema = z.object({
  status: riskStatusEnum.optional(),
  severity: riskSeverityEnum.optional(),
  ownerId: z.string().uuid().optional(),
  impact: z.string().optional(),
});
export type UpdateRiskInput = z.infer<typeof updateRiskSchema>;

export const approvalTypeEnum = z.enum(["CREATIVE", "BUDGET", "PURCHASE", "CLIENT", "VENDOR", "PAYMENT"]);

export const createApprovalSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1),
  type: approvalTypeEnum,
  approverRef: z.string().min(1),
  approvalLevel: z.number().int().min(1).default(1),
});
export type CreateApprovalInput = z.infer<typeof createApprovalSchema>;

export const decideApprovalSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().optional(),
});
export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;

export const licenceStatusEnum = z.enum(["NOT_APPLIED", "APPLIED", "APPROVED", "REJECTED"]);

export const createLicenceSchema = z.object({
  projectId: z.string().uuid().optional(),
  type: z.string().min(1),
  authority: z.string().min(1),
  cityId: z.string().uuid(),
  dueDate: z.coerce.date(),
  ownerId: z.string().uuid(),
  escalationOffsetDays: z.number().int().min(0).default(7),
});
export type CreateLicenceInput = z.infer<typeof createLicenceSchema>;

export const advanceLicenceSchema = z.object({
  status: licenceStatusEnum,
  refNo: z.string().optional(),
});
export type AdvanceLicenceInput = z.infer<typeof advanceLicenceSchema>;

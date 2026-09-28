import { z } from "zod";

export const attendanceStatusEnum = z.enum(["PRESENT", "ON_SITE", "REMOTE", "ON_LEAVE"]);
export const leaveTypeEnum = z.enum(["CASUAL", "EARNED", "SICK", "OTHER"]);

export const setAttendanceSchema = z.object({ status: attendanceStatusEnum });
export type SetAttendanceInput = z.infer<typeof setAttendanceSchema>;

export const createLeaveSchema = z
  .object({
    userId: z.string().uuid(),
    type: leaveTypeEnum,
    fromDate: z.coerce.date(),
    toDate: z.coerce.date(),
    note: z.string().max(500).optional(),
  })
  .refine((v) => v.toDate >= v.fromDate, { message: "The leave ends before it starts.", path: ["toDate"] });
export type CreateLeaveInput = z.infer<typeof createLeaveSchema>;

export const decideLeaveSchema = z.object({ decision: z.enum(["APPROVED", "REJECTED"]) });
export type DecideLeaveInput = z.infer<typeof decideLeaveSchema>;

export const freelancerAvailabilitySchema = z.object({
  available: z.boolean(),
  /** The event a freelancer is being booked for (required when marking them booked). */
  projectId: z.string().uuid().optional(),
});
export type FreelancerAvailabilityInput = z.infer<typeof freelancerAvailabilitySchema>;

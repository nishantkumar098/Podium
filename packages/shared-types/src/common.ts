import { z } from "zod";

/** Standard error envelope (blueprint §40): { error: { code, message, details } } */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export const cursorPaginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type CursorPaginationQuery = z.infer<typeof cursorPaginationQuerySchema>;

export function cursorPage<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export const idParamSchema = z.object({ id: z.string().uuid() });

export const cityScopeQuerySchema = z.object({
  cityId: z.string().uuid().optional(), // omit = every city the caller can see
});

import { z } from "zod";

/**
 * Documents (Phase F, blueprint §26): file metadata rides in as JSON
 * alongside a multipart file, not as the whole request body — the upload
 * itself is validated by DocumentsController's own size/presence checks,
 * not Zod, since Zod has no multipart file type.
 */
export const documentTypeEnum = z.enum([
  "CONTRACT", "DESIGN", "CREATIVE", "PURCHASE_ORDER", "GOVERNMENT_PERMIT", "GUEST_LIST", "OTHER",
]);

export const createDocumentMetaSchema = z.object({
  name: z.string().min(1).max(300),
  type: documentTypeEnum,
  projectId: z.string().uuid().optional(),
});
export type CreateDocumentMetaInput = z.infer<typeof createDocumentMetaSchema>;

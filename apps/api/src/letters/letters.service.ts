import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { DocumentsService } from "../documents/documents.service";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";
import { LETTERS, LETTERS_BY_KEY } from "./letter-definitions";
import { LetterValidationError, letterFileName, renderLetter, validateLetterValues, type LetterValues } from "./letter-render";

const PDF_MIME = "application/pdf";

@Injectable()
export class LettersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
  ) {}

  list() {
    return LETTERS;
  }

  /**
   * Fills a letter and returns the finished PDF. When `saveToDocuments`
   * is set the same file is also stored as a workspace Document, so there is
   * a copy on record. The audit trail names the letter and who it is for —
   * never the rest of what was typed.
   */
  async generate(user: RequestUser, key: string, rawValues: LetterValues, saveToDocuments: boolean) {
    const def = LETTERS_BY_KEY.get(key);
    if (!def) throw new NotFoundException("No such letter template.");

    let values: LetterValues;
    try {
      values = validateLetterValues(def, rawValues ?? {});
    } catch (err) {
      if (err instanceof LetterValidationError) throw new BadRequestException(err.message);
      throw err;
    }

    const buffer = await renderLetter(def, values);
    const fileName = letterFileName(def, values);

    let documentId: string | null = null;
    if (saveToDocuments) {
      const doc = await this.documents.create(
        user,
        { name: fileName, type: def.documentType },
        { originalname: fileName, mimetype: PDF_MIME, size: buffer.length, buffer },
      );
      documentId = doc.id;
    }

    await this.prisma.client.auditLog.create({
      data: {
        workspaceId: user.workspaceId,
        actorId: user.id,
        action: "letter.generated",
        // A saved letter is audited against its Document; an unsaved one gets its own id.
        entityType: documentId ? "document" : "letter",
        entityId: documentId ?? randomUUID(),
        after: { template: def.key, subject: String(values[def.subjectField] ?? ""), savedToDocuments: saveToDocuments },
      },
    });

    return { buffer, fileName, mimeType: PDF_MIME, documentId };
  }
}

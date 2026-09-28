import { Body, Controller, Get, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { LettersService } from "./letters.service";

const generateSchema = z.object({
  values: z.record(z.unknown()),
  saveToDocuments: z.boolean().default(true),
});

/** Letters & agreements generated from AMM's own templates. Producing one creates a document, so it is gated like one. */
@Controller("letters")
export class LettersController {
  constructor(private readonly letters: LettersService) {}

  @Get()
  @RequirePermissions("documents:create")
  list() {
    return this.letters.list();
  }

  @Post(":key/generate")
  @RequirePermissions("documents:create")
  async generate(
    @CurrentUser() user: RequestUser,
    @Param("key") key: string,
    @Body(new ZodValidationPipe(generateSchema)) body: z.infer<typeof generateSchema>,
    @Res() res: Response,
  ) {
    const out = await this.letters.generate(user, key, body.values, body.saveToDocuments);
    res.setHeader("Content-Type", out.mimeType);
    // RFC 5987 so names with spaces or non-ASCII characters survive the download.
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(out.fileName)}`);
    res.setHeader("Content-Length", String(out.buffer.length));
    if (out.documentId) res.setHeader("X-Document-Id", out.documentId);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Document-Id");
    res.end(out.buffer);
  }
}

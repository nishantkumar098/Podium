import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { createDocumentMetaSchema } from "@podium/shared-types";
import type { Response } from "express";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import type { RequestUser } from "../common/types";
import { DocumentsService } from "./documents.service";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get("documents")
  @RequirePermissions("documents:view")
  list(@CurrentUser() user: RequestUser, @Query("projectId") projectId?: string) {
    return this.documents.list(user, projectId);
  }

  @Get("documents/:id")
  @RequirePermissions("documents:view")
  get(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.documents.get(user, id);
  }

  @Post("documents")
  @RequirePermissions("documents:create")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  create(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
    @Body("meta") metaJson: string,
  ) {
    if (!file) throw new BadRequestException("A file is required.");
    const meta = createDocumentMetaSchema.parse(JSON.parse(metaJson ?? "{}"));
    return this.documents.create(user, meta, file);
  }

  @Post("documents/:id/versions")
  @RequirePermissions("documents:edit")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  addVersion(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException("A file is required.");
    return this.documents.addVersion(user, id, file);
  }

  @Get("document-versions/:versionId/download")
  @RequirePermissions("documents:view")
  async download(@CurrentUser() user: RequestUser, @Param("versionId", ParseUUIDPipe) versionId: string, @Res() res: Response) {
    const { buffer, fileName, mimeType } = await this.documents.download(user, versionId);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length", String(buffer.length));
    res.end(buffer);
  }

  @Delete("documents/:id")
  @RequirePermissions("documents:delete")
  remove(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.documents.remove(user, id);
  }
}

import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { AuditService } from "./audit.service";
import { SettingsService } from "./settings.service";
import { SopsService } from "./sops.service";

const sopSchema = z.object({
  title: z.string().trim().min(1).max(200),
  department: z.string().trim().min(1).max(80),
  body: z.string().min(1).max(100_000),
  ownerId: z.string().uuid().nullish(),
});
const versionSchema = z.object({ body: z.string().min(1).max(100_000) });
const sopPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  department: z.string().trim().min(1).max(80).optional(),
  ownerId: z.string().uuid().nullish(),
});
const settingsSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  gstin: z.string().trim().max(20).nullish(),
  address: z.string().max(500).nullish(),
  website: z.string().max(200).nullish(),
  bankName: z.string().max(120).nullish(),
  bankAccountName: z.string().max(160).nullish(),
  bankAccountNo: z.string().max(40).nullish(),
  bankIfsc: z.string().max(20).nullish(),
  invoiceTerms: z.array(z.string().max(300)).max(12).optional(),
  invoiceDeclaration: z.string().max(1000).nullish(),
  procurementApprovalThreshold: z.number().nonnegative().optional(),
});

/** System: Knowledge/SOPs, the audit log and workspace settings. */
@Controller()
export class SystemController {
  constructor(
    private readonly sops: SopsService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  // --------------------------------------------------------------- SOPs
  // Readable by everyone signed in — procedures are written to be followed;
  // writing them needs the playbooks permissions (see SopsService).

  @Get("sops")
  listSops(@CurrentUser() user: RequestUser) {
    return this.sops.list(user);
  }

  @Get("sops/:id")
  getSop(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.sops.get(user, id);
  }

  @Post("sops")
  createSop(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(sopSchema)) body: z.infer<typeof sopSchema>) {
    return this.sops.create(user, body);
  }

  @Post("sops/:id/versions")
  addSopVersion(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(versionSchema)) body: z.infer<typeof versionSchema>) {
    return this.sops.addVersion(user, id, body.body);
  }

  @Patch("sops/:id")
  updateSop(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(sopPatchSchema)) body: z.infer<typeof sopPatchSchema>) {
    return this.sops.update(user, id, body);
  }

  @Delete("sops/:id")
  archiveSop(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.sops.archive(user, id);
  }

  // ---------------------------------------------------------- audit log

  @Get("audit")
  auditLog(
    @CurrentUser() user: RequestUser,
    @Query("actorId") actorId?: string,
    @Query("action") action?: string,
    @Query("entityType") entityType?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("search") search?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.audit.list(user, { actorId, action, entityType, from, to, search, cursor, limit: limit ? Number(limit) : undefined });
  }

  @Get("audit/filters")
  auditFilters(@CurrentUser() user: RequestUser) {
    return this.audit.filters(user);
  }

  // ----------------------------------------------------------- settings

  @Get("settings")
  getSettings(@CurrentUser() user: RequestUser) {
    return this.settings.get(user);
  }

  @Patch("settings")
  updateSettings(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(settingsSchema)) body: z.infer<typeof settingsSchema>) {
    return this.settings.update(user, body);
  }
}

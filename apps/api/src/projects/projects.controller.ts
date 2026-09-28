import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { createProjectSchema, projectMemberSchema, projectVendorSchema, updateProjectSchema } from "@podium/shared-types";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { ProjectsService } from "./projects.service";

@Controller("projects")
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @RequirePermissions("projects:view")
  list(@CurrentUser() user: RequestUser, @Query("cityId") cityId?: string) {
    return this.projects.list(user, cityId);
  }

  /** Team load across live projects (Operations → Resources). Declared before :id. */
  /**
   * Who is carrying how much work. This is a resourcing screen about people,
   * so it follows people:view rather than projects:view — otherwise every
   * role that can see an event could also see the whole team's workload.
   */
  @Get("resources")
  @RequirePermissions("people:view")
  resources(@CurrentUser() user: RequestUser, @Query("cityId") cityId?: string) {
    return this.projects.resources(user, cityId || undefined);
  }

  @Post(":id/members")
  @RequirePermissions("projects:edit")
  @Audit("project", "project.member_added")
  addMember(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(projectMemberSchema)) body: ReturnType<typeof projectMemberSchema.parse>,
  ) {
    return this.projects.addMember(user, id, body.userId, body.roleOnProject);
  }

  @Delete(":id/members/:userId")
  @RequirePermissions("projects:edit")
  @Audit("project", "project.member_removed")
  removeMember(@CurrentUser() user: RequestUser, @Param("id") id: string, @Param("userId") userId: string) {
    return this.projects.removeMember(user, id, userId);
  }

  @Post(":id/vendors")
  @RequirePermissions("projects:edit")
  @Audit("project", "project.vendor_added")
  addVendor(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(projectVendorSchema)) body: ReturnType<typeof projectVendorSchema.parse>,
  ) {
    return this.projects.addVendor(user, id, body.vendorId);
  }

  @Delete(":id/vendors/:vendorId")
  @RequirePermissions("projects:edit")
  @Audit("project", "project.vendor_removed")
  removeVendor(@CurrentUser() user: RequestUser, @Param("id") id: string, @Param("vendorId") vendorId: string) {
    return this.projects.removeVendor(user, id, vendorId);
  }

  @Get(":id")
  @RequirePermissions("projects:view")
  get(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.projects.get(user, id);
  }

  @Post()
  @RequirePermissions("projects:create")
  @Audit("project", "project.create")
  create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createProjectSchema)) body: ReturnType<typeof createProjectSchema.parse>) {
    return this.projects.create(user, body);
  }

  @Patch(":id")
  @RequirePermissions("projects:edit")
  @Audit("project", "project.update")
  update(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(updateProjectSchema)) body: ReturnType<typeof updateProjectSchema.parse>) {
    return this.projects.update(user, id, body);
  }

  /** Archive (soft delete). Nothing is destroyed — see ProjectsService.archive. */
  @Delete(":id")
  @RequirePermissions("projects:delete")
  @Audit("project", "project.archived")
  archive(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.projects.archive(user, id);
  }

  /**
   * Un-archive. Returns 409, never a raw constraint error, when the project's
   * lead has been converted again in the meantime — see
   * ProjectsService.restore.
   */
  @Post(":id/restore")
  @RequirePermissions("projects:delete")
  @Audit("project", "project.restored")
  restore(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.projects.restore(user, id);
  }
}

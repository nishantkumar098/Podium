import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { createPlaybookSchema, updatePlaybookSchema } from "@podium/shared-types";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { PlaybooksService } from "./playbooks.service";

@Controller("playbooks")
export class PlaybooksController {
  constructor(private readonly playbooks: PlaybooksService) {}

  @Get()
  @RequirePermissions("playbooks:view")
  list(@CurrentUser() user: RequestUser) {
    return this.playbooks.list(user);
  }

  @Get(":id")
  @RequirePermissions("playbooks:view")
  get(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.playbooks.get(user, id);
  }

  @Post()
  @RequirePermissions("playbooks:create")
  @Audit("playbook", "playbook.create")
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createPlaybookSchema)) body: ReturnType<typeof createPlaybookSchema.parse>,
  ) {
    return this.playbooks.create(user, body);
  }

  @Patch(":id")
  @RequirePermissions("playbooks:edit")
  @Audit("playbook", "playbook.update")
  update(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updatePlaybookSchema)) body: ReturnType<typeof updatePlaybookSchema.parse>,
  ) {
    return this.playbooks.update(user, id, body);
  }

  @Delete(":id")
  @RequirePermissions("playbooks:delete")
  @Audit("playbook", "playbook.delete")
  remove(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.playbooks.remove(user, id);
  }
}

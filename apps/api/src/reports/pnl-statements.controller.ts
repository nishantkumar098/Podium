import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { createPnlStatementSchema, updatePnlStatementSchema, type CreatePnlStatementInput } from "@podium/shared-types";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { PnlStatementsService } from "./pnl-statements.service";

/**
 * Hand-built P&L statements. Reading follows the P&L page (projects:view);
 * creating, editing and deleting need the finance permission invoices:edit.
 */
@Controller("pnl-statements")
export class PnlStatementsController {
  constructor(private readonly pnl: PnlStatementsService) {}

  @Get()
  @RequirePermissions("reports:view")
  list(@CurrentUser() user: RequestUser) {
    return this.pnl.list(user);
  }

  @Get(":id")
  @RequirePermissions("reports:view")
  get(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.pnl.get(user, id);
  }

  @Post()
  @RequirePermissions("reports:create")
  @Audit("pnl_statement", "pnl.statement_created")
  create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createPnlStatementSchema)) body: CreatePnlStatementInput) {
    return this.pnl.create(user, body);
  }

  @Patch(":id")
  @RequirePermissions("reports:edit")
  @Audit("pnl_statement", "pnl.statement_updated")
  update(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(updatePnlStatementSchema)) body: CreatePnlStatementInput) {
    return this.pnl.update(user, id, body);
  }

  @Delete(":id")
  @RequirePermissions("reports:delete")
  @Audit("pnl_statement", "pnl.statement_deleted")
  remove(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.pnl.remove(user, id);
  }
}

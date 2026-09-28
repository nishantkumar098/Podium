import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Res } from "@nestjs/common";
import { createRecipeSchema, updateRecipeSchema } from "@podium/shared-types";
import type { Response } from "express";
import { z } from "zod";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { RecipesService } from "./recipes.service";
import { RequirementSheetService } from "./requirement-sheet.service";

const requirementSheetSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  eventName: z.string().max(200).optional().nullable(),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  address: z.string().max(300).optional().nullable(),
  pax: z.number().int().min(0).max(100000),
  to: z.string().max(120).optional().nullable(),
  from: z.string().max(120).optional().nullable(),
  hookah: z.string().max(120).optional().nullable(),
  staffing: z.string().max(600).optional().nullable(),
  inclusions: z.string().max(3000).optional().nullable(),
  menu: z.array(z.object({ recipeId: z.string().uuid(), serves: z.number().int().min(0).max(100000) })).max(200),
});

@Controller("recipes")
export class RecipesController {
  constructor(
    private readonly recipes: RecipesService,
    private readonly requirementSheet: RequirementSheetService,
  ) {}

  /**
   * The requirement sheet as an Excel challan — AMM's own layout, with the
   * drinks filled in from Requirements and the standard kit on the right.
   */
  @Post("requirement-sheet")
  @RequirePermissions("recipes:view")
  async sheet(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(requirementSheetSchema)) body: z.infer<typeof requirementSheetSchema>,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.requirementSheet.build(user, body);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Content-Length", String(buffer.length));
    res.end(buffer);
  }

  @Get()
  @RequirePermissions("recipes:view")
  list(@CurrentUser() user: RequestUser) {
    return this.recipes.list(user);
  }

  @Get(":id")
  @RequirePermissions("recipes:view")
  get(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.recipes.get(user, id);
  }

  @Post()
  @RequirePermissions("recipes:create")
  @Audit("recipe", "recipe.create")
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createRecipeSchema)) body: ReturnType<typeof createRecipeSchema.parse>,
  ) {
    return this.recipes.create(user, body);
  }

  @Patch(":id")
  @RequirePermissions("recipes:edit")
  @Audit("recipe", "recipe.update")
  update(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateRecipeSchema)) body: ReturnType<typeof updateRecipeSchema.parse>,
  ) {
    return this.recipes.update(user, id, body);
  }

  @Delete(":id")
  @RequirePermissions("recipes:delete")
  @Audit("recipe", "recipe.delete")
  remove(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.recipes.remove(user, id);
  }
}

import { Module } from "@nestjs/common";
import { RecipesController } from "./recipes.controller";
import { RecipesService } from "./recipes.service";
import { RequirementSheetService } from "./requirement-sheet.service";

@Module({
  controllers: [RecipesController],
  providers: [RecipesService, RequirementSheetService],
  exports: [RecipesService],
})
export class RecipesModule {}

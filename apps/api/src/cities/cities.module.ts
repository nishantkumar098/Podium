import { Module } from "@nestjs/common";
import { CitiesController } from "./cities.controller";

@Module({
  controllers: [CitiesController],
})
export class CitiesModule {}

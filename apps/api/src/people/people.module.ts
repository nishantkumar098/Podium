import { Module } from "@nestjs/common";
import { FreelancersController } from "./freelancers.controller";
import { PeopleController } from "./people.controller";
import { PeopleService } from "./people.service";

@Module({ controllers: [PeopleController, FreelancersController], providers: [PeopleService] })
export class PeopleModule {}

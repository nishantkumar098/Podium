import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import {
  createLeaveSchema,
  decideLeaveSchema,
  freelancerAvailabilitySchema,
  setAttendanceSchema,
  type CreateLeaveInput,
  type DecideLeaveInput,
  type FreelancerAvailabilityInput,
  type SetAttendanceInput,
} from "@podium/shared-types";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { PeopleService } from "./people.service";

@Controller("people")
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @Get()
  @RequirePermissions("people:view")
  overview(@CurrentUser() user: RequestUser) {
    return this.people.overview(user);
  }

  @Put("attendance/:userId")
  @RequirePermissions("people:edit")
  setAttendance(
    @CurrentUser() user: RequestUser,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Body(new ZodValidationPipe(setAttendanceSchema)) body: SetAttendanceInput,
  ) {
    return this.people.setAttendance(user, userId, body);
  }

  @Post("leaves")
  @RequirePermissions("people:create")
  createLeave(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createLeaveSchema)) body: CreateLeaveInput) {
    return this.people.createLeave(user, body);
  }

  @Post("leaves/:id/decide")
  @RequirePermissions("people:approve")
  decideLeave(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(decideLeaveSchema)) body: DecideLeaveInput,
  ) {
    return this.people.decideLeave(user, id, body);
  }

  /** Kept so the People screen's own toggle still works; the canonical route is /freelancers/:id/availability. */
  @Post("freelancers/:id/availability")
  @RequirePermissions("freelancers:edit")
  setFreelancerAvailability(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(freelancerAvailabilitySchema)) body: FreelancerAvailabilityInput,
  ) {
    return this.people.setFreelancerAvailability(user, id, body);
  }
}

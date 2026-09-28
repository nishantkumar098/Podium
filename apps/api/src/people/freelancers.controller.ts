import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { freelancerAvailabilitySchema, type FreelancerAvailabilityInput } from "@podium/shared-types";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { PeopleService } from "./people.service";

/**
 * The bartender pool.
 *
 * WHY THIS IS NOT PART OF /people. Booking and tasking the freelance crew is
 * Operations' daily work; an employee's HR record is not theirs to read.
 * While both lived behind `people:view`, giving Operations the bartenders
 * meant handing them every employee's file as well — which is exactly what
 * the access policy forbids. So the crew pool has its own resource,
 * `freelancers`, and its own endpoints.
 *
 * `/people` still returns the pool for whoever may see both (People &
 * Resources, City Heads, Superadmin), because that screen is built around
 * having them together.
 *
 * City scoping is the same rule as everywhere else: the pool is filtered by
 * the caller's city access, so a Mumbai City Head asking for Goa gets
 * nothing rather than everything.
 */
@Controller("freelancers")
export class FreelancersController {
  constructor(private readonly people: PeopleService) {}

  @Get()
  @RequirePermissions("freelancers:view")
  list(@CurrentUser() user: RequestUser, @Query("cityId") cityId?: string) {
    return this.people.freelancers(user, cityId);
  }

  @Post(":id/availability")
  @RequirePermissions("freelancers:edit")
  setAvailability(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(freelancerAvailabilitySchema)) body: FreelancerAvailabilityInput,
  ) {
    return this.people.setFreelancerAvailability(user, id, body);
  }
}

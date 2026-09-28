import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { CreateLeaveInput, DecideLeaveInput, FreelancerAvailabilityInput, SetAttendanceInput } from "@podium/shared-types";
import { businessDateString } from "../common/business-time";
import { PrismaService } from "../common/prisma/prisma.service";
import { allowedCityIds, type RequestUser } from "../common/types";

/**
 * People (the "People" screen under People & governance): who is in today,
 * leave requests, and the freelance crew pool.
 *
 * Attendance is one row per person holding their latest status. A status set
 * on an earlier day is not today's, so it is reported as not marked rather
 * than carried forward as if it were still true.
 */
@Injectable()
export class PeopleService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(user: RequestUser) {
    const allowed = allowedCityIds(user);
    const inCities = allowed === "ALL" ? {} : { primaryCityId: { in: allowed } };
    const today = businessDateString(new Date());

    const [staff, leaves, freelancers] = await Promise.all([
      this.prisma.client.user.findMany({
        where: { workspaceId: user.workspaceId, isActive: true, deletedAt: null, isExternal: false, ...inCities },
        select: {
          id: true,
          name: true,
          dept: true,
          primaryRole: { select: { name: true } },
          primaryCity: { select: { id: true, name: true } },
          attendance: { select: { status: true, updatedAt: true } },
        },
        orderBy: { name: "asc" },
      }),
      this.prisma.client.leave.findMany({
        where: { user: { workspaceId: user.workspaceId, ...inCities } },
        include: { user: { select: { id: true, name: true } } },
        orderBy: [{ status: "asc" }, { fromDate: "desc" }],
        take: 100,
      }),
      // The crew pool is its own resource now; someone who may read
      // employee records does not automatically get it.
      user.permissions.has("freelancers:view")
        ? this.prisma.client.freelancer.findMany({
            where: { workspaceId: user.workspaceId, deletedAt: null, ...(allowed === "ALL" ? {} : { cityId: { in: allowed } }) },
            include: { city: { select: { id: true, name: true } } },
            orderBy: [{ isAvailable: "desc" }, { name: "asc" }],
          })
        : Promise.resolve([]),
    ]);

    return {
      today,
      canApproveLeave: user.permissions.has("people:approve"),
      canEdit: user.permissions.has("people:edit"),
      staff: staff.map((s) => ({
        id: s.id,
        name: s.name,
        role: s.primaryRole?.name ?? null,
        dept: s.dept,
        city: s.primaryCity,
        status: s.attendance && businessDateString(s.attendance.updatedAt) === today ? s.attendance.status : null,
      })),
      leaves: leaves.map((l) => ({
        id: l.id,
        user: l.user,
        type: l.type,
        status: l.status,
        fromDate: l.fromDate,
        toDate: l.toDate,
        note: l.note,
      })),
      freelancers: freelancers.map((f) => ({
        id: f.id,
        name: f.name,
        category: f.category,
        phone: f.phone,
        city: f.city,
        certExpiresAt: f.certExpiresAt,
        dayRate: f.dayRate?.toNumber() ?? null,
        eventsCount: f.eventsCount,
        rating: f.rating?.toNumber() ?? null,
        isAvailable: f.isAvailable,
      })),
    };
  }

  /**
   * The bartender pool, filtered to the caller's cities.
   *
   * `cityId` narrows further, and is checked rather than trusted: asking
   * for a city you do not hold is refused, and omitting it falls back to
   * your own cities — never to every city. That second half is the one that
   * matters, because "no filter supplied" is how scoped data usually leaks.
   */
  async freelancers(user: RequestUser, cityId?: string) {
    const allowed = allowedCityIds(user);
    if (cityId) {
      if (allowed !== "ALL" && !allowed.includes(cityId)) {
        throw new ForbiddenException("You do not have access to this city.");
      }
    }
    const where = cityId ? { cityId } : allowed === "ALL" ? {} : { cityId: { in: allowed } };
    const rows = await this.prisma.client.freelancer.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null, ...where },
      include: { city: { select: { id: true, name: true } } },
      orderBy: [{ isAvailable: "desc" }, { name: "asc" }],
    });
    return {
      canEdit: user.permissions.has("freelancers:edit"),
      crew: rows.map((f) => ({
        id: f.id,
        name: f.name,
        category: f.category,
        phone: f.phone,
        city: f.city,
        certExpiresAt: f.certExpiresAt,
        // Two rates: what they cost in their own city, and what they cost
        // away from it. Either can be null — several of the roster's
        // bartenders have no figure on the sheet, and a rate invented here
        // would be quoted to a client and paid to a person.
        dayRate: f.dayRate?.toNumber() ?? null,
        dayRateOutstation: f.dayRateOutstation?.toNumber() ?? null,
        agreementSigned: f.agreementSigned,
        eventsCount: f.eventsCount,
        rating: f.rating?.toNumber() ?? null,
        isAvailable: f.isAvailable,
      })),
    };
  }

  private async staffInWorkspace(user: RequestUser, userId: string) {
    const target = await this.prisma.client.user.findFirst({
      where: { id: userId, workspaceId: user.workspaceId, deletedAt: null },
      select: { id: true, name: true, primaryCityId: true },
    });
    if (!target) throw new NotFoundException("Person not found.");
    const allowed = allowedCityIds(user);
    if (allowed !== "ALL" && (!target.primaryCityId || !allowed.includes(target.primaryCityId))) {
      throw new ForbiddenException("That person is outside your cities.");
    }
    return target;
  }

  async setAttendance(user: RequestUser, userId: string, input: SetAttendanceInput) {
    const target = await this.staffInWorkspace(user, userId);
    const row = await this.prisma.client.attendance.upsert({
      where: { userId: target.id },
      create: { userId: target.id, status: input.status },
      update: { status: input.status },
    });
    await this.audit(user, "attendance.set", "user", target.id, { status: input.status });
    return row;
  }

  async createLeave(user: RequestUser, input: CreateLeaveInput) {
    const target = await this.staffInWorkspace(user, input.userId);
    const leave = await this.prisma.client.leave.create({
      data: { userId: target.id, type: input.type, fromDate: input.fromDate, toDate: input.toDate, note: input.note, status: "PENDING" },
    });
    await this.audit(user, "leave.requested", "leave", leave.id, { for: target.name, type: input.type });
    return leave;
  }

  /** PENDING to APPROVED or REJECTED, once, and never for your own leave. */
  async decideLeave(user: RequestUser, id: string, input: DecideLeaveInput) {
    const leave = await this.prisma.client.leave.findFirst({
      where: { id, user: { workspaceId: user.workspaceId } },
      include: { user: { select: { id: true, name: true } } },
    });
    if (!leave) throw new NotFoundException("Leave request not found.");
    await this.staffInWorkspace(user, leave.userId);
    if (leave.userId === user.id) throw new ForbiddenException("You cannot decide your own leave.");

    const updated = await this.prisma.client.leave.updateMany({
      where: { id, status: "PENDING" },
      data: { status: input.decision, decidedById: user.id },
    });
    if (updated.count === 0) throw new ConflictException(`This leave was already ${leave.status.toLowerCase()}.`);

    await this.prisma.client.notification.create({
      data: {
        workspaceId: user.workspaceId,
        userId: leave.userId,
        icon: "◷",
        text: `Your leave (${businessDateString(leave.fromDate)} to ${businessDateString(leave.toDate)}) was ${input.decision.toLowerCase()} by ${user.name}.`,
        sourceType: "leave",
        sourceId: leave.id,
      },
    });
    await this.audit(user, `leave.${input.decision.toLowerCase()}`, "leave", leave.id, { for: leave.user.name });
    return { ok: true };
  }

  /** Booking a freelancer names the event and counts it; releasing makes them available again. */
  async setFreelancerAvailability(user: RequestUser, id: string, input: FreelancerAvailabilityInput) {
    const f = await this.prisma.client.freelancer.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
    if (!f) throw new NotFoundException("Freelancer not found.");
    let eventName: string | null = null;
    if (!input.available) {
      if (!input.projectId) throw new BadRequestException("Choose the event this freelancer is booked for.");
      const project = await this.prisma.client.project.findFirst({ where: { id: input.projectId, workspaceId: user.workspaceId } });
      if (!project) throw new NotFoundException("Event not found.");
      eventName = project.name;
    }
    await this.prisma.client.freelancer.update({
      where: { id: f.id },
      data: { isAvailable: input.available, ...(input.available ? {} : { eventsCount: { increment: 1 } }) },
    });
    await this.audit(user, input.available ? "freelancer.released" : "freelancer.booked", "freelancer", f.id, {
      name: f.name,
      ...(eventName ? { event: eventName } : {}),
    });
    return { ok: true };
  }

  private audit(user: RequestUser, action: string, entityType: string, entityId: string, after: Record<string, string>) {
    return this.prisma.client.auditLog.create({
      data: { workspaceId: user.workspaceId, actorId: user.id, action, entityType, entityId, after },
    });
  }
}

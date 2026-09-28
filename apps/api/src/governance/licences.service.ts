import { Injectable, NotFoundException } from "@nestjs/common";
import type { AdvanceLicenceInput, CreateLicenceInput } from "@podium/shared-types";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";

@Injectable()
export class LicencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
  ) {}

  async list(user: RequestUser, cityId?: string) {
    const scope = this.cityScope.scopeFilter(user, cityId);
    // The screen prints the city, event and owner of every permit; without
    // these the page threw on the first row (`l.city.name` of undefined).
    return this.prisma.client.licence.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null, ...scope },
      include: {
        city: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
      },
      orderBy: { dueDate: "asc" },
    });
  }

  async create(user: RequestUser, input: CreateLicenceInput) {
    this.cityScope.assertCanAccessCity(user, input.cityId);
    return this.prisma.client.licence.create({
      data: { ...input, workspaceId: user.workspaceId, status: "NOT_APPLIED" },
    });
  }

  /** Mirrors the prototype's advanceLicence: not_applied -> applied -> approved (blueprint §21). */
  async advance(user: RequestUser, id: string, input: AdvanceLicenceInput) {
    const licence = await this.prisma.client.licence.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
    if (!licence) throw new NotFoundException("Licence not found.");
    this.cityScope.assertCanAccessCity(user, licence.cityId);
    return this.prisma.client.licence.update({
      where: { id: licence.id },
      data: { status: input.status, refNo: input.refNo ?? licence.refNo },
    });
  }
}

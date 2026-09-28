import { ForbiddenException, Injectable } from "@nestjs/common";
import { allowedCityIds } from "../types";
import type { RequestUser } from "../types";

/**
 * The single reusable query-scoping helper blueprint §10 calls for — every
 * scoped table's queries go through this, never a hand-rolled per-endpoint
 * filter. "All cities" for Founder/Admin is the explicit ALL grant recorded
 * on user_city_access, never the absence of a cityId filter.
 */
@Injectable()
export class CityScopeService {
  /**
   * Builds a Prisma `where` fragment (`{ cityId: { in: [...] } }` or `{}`
   * for ALL-scope callers) intersecting the caller's grants with an
   * optional explicitly-requested cityId.
   */
  scopeFilter(user: RequestUser, requestedCityId?: string): Record<string, unknown> {
    const allowed = allowedCityIds(user);

    if (requestedCityId) {
      this.assertCanAccessCity(user, requestedCityId);
      return { cityId: requestedCityId };
    }
    if (allowed === "ALL") return {};
    if (allowed.length === 0) {
      // No grants at all -> the query must return nothing, not everything.
      return { cityId: { in: [] } };
    }
    return { cityId: { in: allowed } };
  }

  /**
   * `cityId` is nullable because real imported records (clients, leads,
   * vendors, freelancers) often carry no city — see Client.cityId in the
   * schema. An unassigned record is treated as reachable only by an ALL-scope
   * caller, which is deliberately the *stricter* reading: it hides rows from
   * city-scoped users rather than exposing them to everyone. This mirrors
   * scopeFilter() exactly, where a `cityId IN (...)` predicate already
   * excludes NULL, so list and detail views can never disagree.
   */
  assertCanAccessCity(user: RequestUser, cityId: string | null): void {
    const allowed = allowedCityIds(user);
    if (allowed === "ALL") return;
    if (cityId === null) {
      throw new ForbiddenException("This record has no city assigned; only all-cities users can open it.");
    }
    if (!allowed.includes(cityId)) {
      throw new ForbiddenException("You do not have access to this city.");
    }
  }
}

/**
 * The 10 roles carried forward verbatim from the prototype's ROLES array
 * (blueprint §11). Kept here as a const, not a Zod-validated enum of DB
 * truth, since the actual grants live in the roles/permissions tables —
 * this is for compile-time convenience in guards/UI, not authorization
 * itself (never gate access on this list alone; always resolve the
 * caller's real permissions server-side).
 */
export const ROLE_NAMES = [
  "Founder",
  "Admin",
  "Project Manager",
  "Operations",
  "Finance",
  "Sales",
  "Creative",
  "Employee",
  "Client",
  "Vendor",
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const CITY_ACCESS_SCOPES = ["READ", "WRITE", "ALL"] as const;
export type CityAccessScope = (typeof CITY_ACCESS_SCOPES)[number];

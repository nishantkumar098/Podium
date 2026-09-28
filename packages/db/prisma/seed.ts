/**
 * Development/demo seed script — mirrors the prototype's own seed arrays
 * (CLIENTS, PROJECTS, VENDORS, TEAM, CITIES, TASKS, INV, INVOICES,
 * FLOW_TEMPLATES, LICENCES, RISKS, APPROVALS, AUTOMATIONS, SOPS, etc. from
 * docs/prototype/podium-v2-amm-brands.html) so the built app is immediately
 * comparable screen-for-screen against the prototype.
 *
 * This is a FIXTURE ONLY. Per blueprint §37 it must never be pointed at a
 * staging or production database — there is no production-data path through
 * this file. `pnpm --filter @podium/db seed` targets whatever DATABASE_URL
 * is in your local `.env`; make sure that's your dev database.
 *
 * BUG-001 (2026-09-12 CTO audit): this script TRUNCATEs every table,
 * `audit_logs` included, and `scripts/dev-up.sh` used to call it
 * unconditionally on every fresh-start. That is safe only for a throwaway
 * dev/CI/test database and catastrophic against anything holding real rows —
 * exactly the database this build now holds (52,000+ real AMM Brands
 * records). `assertSafeToSeed()` below is a hard, three-part gate checked
 * BEFORE the TRUNCATE runs, not a warning:
 *
 *   1. PODIUM_ALLOW_DESTRUCTIVE_SEED=1 must be set explicitly — no default,
 *      no implicit "yes" from being in a script.
 *   2. The resolved database name must match /_dev|_ci|_test/ — a database
 *      named "podium_prod" (or anything else) is refused regardless of the
 *      env var, because a name typo in someone's .env must not become a
 *      truncated production database.
 *   3. `clients` must currently hold fewer than 1,000 rows — the real import
 *      landed 52,024. A database that already looks like production data
 *      is refused even if its name and the env var both say "go ahead",
 *      because by the time row count and name disagree, something is
 *      already wrong and guessing is not an option.
 *
 * All three must hold. Any one failing refuses with a clear, actionable
 * message rather than truncating and finding out.
 */
import { PrismaClient, Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { DEPARTMENTS, ROLES, allPermissions } from "../../../apps/api/src/common/rbac/model";

const db = new PrismaClient();

/**
 * Every seeded user gets this password in dev/demo environments only —
 * printed at the end of the seed run. Never used for anything but local
 * development; production onboarding goes through real invites (Phase 1).
 */
const DEV_PASSWORD = "Podium123!";

// ---------------------------------------------------------------------------
// GST state codes — full 36 Indian states/UTs (blueprint §10), not just the
// 5 the prototype happened to seed.
// ---------------------------------------------------------------------------
const GST_STATE_CODES: Array<[string, string]> = [
  ["01", "Jammu and Kashmir"], ["02", "Himachal Pradesh"], ["03", "Punjab"],
  ["04", "Chandigarh"], ["05", "Uttarakhand"], ["06", "Haryana"],
  ["07", "Delhi"], ["08", "Rajasthan"], ["09", "Uttar Pradesh"],
  ["10", "Bihar"], ["11", "Sikkim"], ["12", "Arunachal Pradesh"],
  ["13", "Nagaland"], ["14", "Manipur"], ["15", "Mizoram"],
  ["16", "Tripura"], ["17", "Meghalaya"], ["18", "Assam"],
  ["19", "West Bengal"], ["20", "Jharkhand"], ["21", "Odisha"],
  ["22", "Chhattisgarh"], ["23", "Madhya Pradesh"], ["24", "Gujarat"],
  ["25", "Daman and Diu"], ["26", "Dadra and Nagar Haveli"], ["27", "Maharashtra"],
  ["28", "Andhra Pradesh (old)"], ["29", "Karnataka"], ["30", "Goa"],
  ["31", "Lakshadweep"], ["32", "Kerala"], ["33", "Tamil Nadu"],
  ["34", "Puducherry"], ["35", "Andaman and Nicobar Islands"], ["36", "Telangana"],
  ["37", "Andhra Pradesh"], ["38", "Ladakh"],
];

// ---------------------------------------------------------------------------
// Reference data straight from the prototype's TEAM / CITIES / CLIENTS / etc.
// ---------------------------------------------------------------------------
const CITIES = [
  { key: "Jaipur", code: "JPR", state: "Rajasthan", st: "08", hq: true },
  { key: "Dehradun", code: "DDN", state: "Uttarakhand", st: "05", hq: false },
  { key: "Delhi", code: "DEL", state: "Delhi", st: "07", hq: false },
  { key: "Mumbai", code: "BOM", state: "Maharashtra", st: "27", hq: false },
  { key: "Chennai", code: "MAA", state: "Tamil Nadu", st: "33", hq: false },
  { key: "Goa", code: "GOA", state: "Goa", st: "30", hq: false },
];

// Roles, departments and grants come from the one place that declares
// them — apps/api/src/common/rbac/model.ts — so the fixture cannot drift
// away from what the API actually enforces. It used to carry its own copy
// of the matrix, which is how the seeded Founder ended up with every write
// permission while the real Founder role is read-only.

const TEAM = [
  { key: "u1", name: "Anant Sharma", role: "Founder", dept: "Leadership", city: "Jaipur" },
  { key: "u2", name: "Kritika Bansal", role: "Head of Operations", dept: "Operations", city: "Jaipur" },
  { key: "u3", name: "Rohit Meena", role: "Event Producer", dept: "Production", city: "Dehradun" },
  { key: "u4", name: "Simran Kaur", role: "Client Servicing Lead", dept: "Client Servicing", city: "Jaipur" },
  { key: "u5", name: "Devansh Jain", role: "Bar Operations Head", dept: "Bar Ops", city: "Jaipur" },
  { key: "u6", name: "Priya Rathore", role: "Creative Director", dept: "Creative", city: "Mumbai" },
  { key: "u7", name: "Vikram Solanki", role: "Procurement Manager", dept: "Procurement", city: "Jaipur" },
  { key: "u8", name: "Neha Agarwal", role: "Finance Manager", dept: "Finance", city: "Jaipur" },
  { key: "u9", name: "Tushar Pareek", role: "Logistics Coordinator", dept: "Operations", city: "Goa" },
  { key: "u10", name: "Ananya Joshi", role: "Sales Manager", dept: "Sales", city: "Delhi" },
  { key: "u11", name: "Arjun Nair", role: "City Manager, Chennai", dept: "Operations", city: "Chennai" },
  { key: "u12", name: "Farah Qureshi", role: "City Manager, Mumbai", dept: "Operations", city: "Mumbai" },
  { key: "u13", name: "Karan Malhotra", role: "City Manager, Delhi", dept: "Operations", city: "Delhi" },
  { key: "u14", name: "Meera Deshpande", role: "City Lead, Goa", dept: "Operations", city: "Goa" },
  { key: "u15", name: "Lakshya Chouhan", role: "City Lead, Dehradun", dept: "Operations", city: "Dehradun" },
];
// Maps each team member's operational job title to a Podium RBAC role.
const USER_RBAC_ROLE: Record<string, string> = {
  // Superadmin, not Founder: Founder is read-only, and u1 is the fixture
  // every test uses when it needs an account that can do anything.
  u1: "Superadmin", u2: "Admin", u3: "Project Manager", u4: "Project Manager",
  u5: "Operations", u6: "Creative", u7: "Operations", u8: "Finance",
  u9: "Operations", u10: "Sales", u11: "Operations", u12: "Operations",
  u13: "Operations", u14: "Operations", u15: "Operations",
};

const CLIENTS = [
  { key: "c1", name: "Rathi Family (Ishaan & Meher)", type: "INDIVIDUAL" as const, city: "Dehradun", ltv: 4200000, since: "2026-03-11", st: "05" },
  { key: "c2", name: "Cognizant Technology Solutions", type: "CORPORATE" as const, city: "Jaipur", ltv: 1850000, since: "2025-11-02", st: "08" },
  { key: "c3", name: "Zomato — Brand Marketing", type: "CORPORATE" as const, city: "Mumbai", ltv: 3100000, since: "2026-01-20", st: "27" },
  { key: "c4", name: "Bansal Group Industries", type: "CORPORATE" as const, city: "Goa", ltv: 2650000, since: "2025-08-14", st: "30" },
  { key: "c5", name: "Mehta–Kapoor Family", type: "INDIVIDUAL" as const, city: "Jaipur", ltv: 5400000, since: "2026-02-05", st: "08" },
  { key: "c6", name: "Aravali Craft Beer Co.", type: "BRAND" as const, city: "Jaipur", ltv: 980000, since: "2026-04-18", st: "08" },
  { key: "c7", name: "Pernod Ricard India", type: "BRAND" as const, city: "Delhi", ltv: 2300000, since: "2025-12-10", st: "07" },
  { key: "c8", name: "Swiggy — Founders Office", type: "CORPORATE" as const, city: "Chennai", ltv: 1450000, since: "2026-05-02", st: "33" },
];

const VENDORS = [
  { key: "v1", name: "Rajwada Caterers", category: "Catering", city: "Jaipur", rating: 4.6, gstin: "08AACFR1234A1Z5", status: "PREFERRED" as const },
  { key: "v2", name: "Studio Lumen — Sound & Light", category: "Production", city: "Jaipur", rating: 4.8, gstin: "08AAJCS5567B1Z2", status: "PREFERRED" as const },
  { key: "v3", name: "Marigold Décor Co.", category: "Décor & Florals", city: "Dehradun", rating: 4.3, gstin: "08AABCM9081C1Z9", status: "APPROVED" as const },
  { key: "v4", name: "BarWorks Equipment Rentals", category: "Bar Equipment", city: "Jaipur", rating: 4.5, gstin: "08AAECB4432D1Z1", status: "PREFERRED" as const },
  { key: "v5", name: "Frame & Reel Films", category: "Photo / Video", city: "Mumbai", rating: 4.7, gstin: "27AAGCF7712E1Z4", status: "PREFERRED" as const },
  { key: "v6", name: "Coastal Transport Co.", category: "Transport & Logistics", city: "Goa", rating: 3.9, gstin: "30AACCC2214F1Z7", status: "APPROVED" as const },
  { key: "v7", name: "Ivory Linen House", category: "Furniture & Linen", city: "Jaipur", rating: 4.1, gstin: "08AAFCI3345G1Z3", status: "APPROVED" as const },
  { key: "v8", name: "Cellar Door Wines", category: "Beverage Supply", city: "Jaipur", rating: 4.4, gstin: "08AAHCC8871H1Z6", status: "PREFERRED" as const },
];

const PROJECTS = [
  { key: "p1", name: "Rathi–Sharma Sangeet & Wedding", client: "c1", type: "Wedding", city: "Dehradun", date: "2026-11-14", pm: "u3", health: "GREEN" as const, status: "IN_PROGRESS" as const, revenue: 4200000, estCost: 2850000, actCost: 1690000, team: ["u3", "u4", "u5", "u6"], vendors: ["v1", "v2", "v3", "v4"] },
  { key: "p2", name: "Cognizant Annual Day 2026", client: "c2", type: "Corporate", city: "Jaipur", date: "2026-10-02", pm: "u2", health: "AMBER" as const, status: "IN_PROGRESS" as const, revenue: 1850000, estCost: 1180000, actCost: 640000, team: ["u2", "u4", "u9"], vendors: ["v2", "v6", "v7"] },
  { key: "p3", name: "Zomato IPL Launch Activation", client: "c3", type: "Brand Activation", city: "Mumbai", date: "2026-09-27", pm: "u6", health: "RED" as const, status: "IN_PROGRESS" as const, revenue: 3100000, estCost: 2100000, actCost: 1450000, team: ["u6", "u5", "u10"], vendors: ["v5", "v8"] },
  { key: "p4", name: "Bansal Group Leadership Offsite", client: "c4", type: "Corporate", city: "Goa", date: "2026-12-05", pm: "u3", health: "GREEN" as const, status: "PLANNED" as const, revenue: 2650000, estCost: 1740000, actCost: 210000, team: ["u3", "u9"], vendors: ["v6"] },
  { key: "p5", name: "Mehta–Kapoor Destination Wedding", client: "c5", type: "Destination Wedding", city: "Jaipur", date: "2027-01-18", pm: "u4", health: "GREEN" as const, status: "PLANNED" as const, revenue: 5400000, estCost: 3600000, actCost: 280000, team: ["u4", "u6", "u5"], vendors: ["v1", "v3", "v4", "v7"] },
  { key: "p6", name: "Aravali Craft Beer — Taproom Launch", client: "c6", type: "Brand Activation", city: "Jaipur", date: "2026-09-20", pm: "u5", health: "AMBER" as const, status: "IN_PROGRESS" as const, revenue: 980000, estCost: 640000, actCost: 520000, team: ["u5", "u6"], vendors: ["v4", "v8"] },
  { key: "p7", name: "Rajasthan Tourism Conclave — Bar Ops", client: "c2", type: "Conference", city: "Jaipur", date: "2026-09-14", pm: "u2", health: "RED" as const, status: "IN_PROGRESS" as const, revenue: 1420000, estCost: 960000, actCost: 790000, team: ["u2", "u5"], vendors: ["v4", "v8", "v7"] },
  { key: "p8", name: "Kapoor 50th Anniversary Private Dinner", client: "c5", type: "Private Event", city: "Jaipur", date: "2026-09-30", pm: "u4", health: "GREEN" as const, status: "IN_PROGRESS" as const, revenue: 640000, estCost: 410000, actCost: 360000, team: ["u4", "u1"], vendors: ["v1", "v7"] },
  { key: "p9", name: "Bansal Group Q3 Vendor Awards Night", client: "c4", type: "Corporate", city: "Jaipur", date: "2026-09-25", pm: "u3", health: "GREEN" as const, status: "CLIENT_REVIEW" as const, revenue: 590000, estCost: 390000, actCost: 370000, team: ["u3", "u5"], vendors: ["v4", "v8"] },
  { key: "p10", name: "Pernod Ricard — Delhi Trade Night", client: "c7", type: "Brand Activation", city: "Delhi", date: "2026-08-22", pm: "u13", health: "GREEN" as const, status: "COMPLETED" as const, revenue: 2300000, estCost: 1500000, actCost: 1460000, team: ["u13", "u5", "u10"], vendors: ["v4", "v8"] },
  { key: "p11", name: "Swiggy Founders Mixer, Chennai", client: "c8", type: "Corporate", city: "Chennai", date: "2026-09-26", pm: "u11", health: "AMBER" as const, status: "IN_PROGRESS" as const, revenue: 1450000, estCost: 900000, actCost: 380000, team: ["u11", "u5"], vendors: ["v4"] },
];

const TASKS = [
  { proj: "p1", name: "Finalize bar menu — welcome cocktails", owner: "u5", due: "2026-09-18", status: "IN_PROGRESS" as const, priority: "HIGH" as const },
  { proj: "p1", name: "Confirm floral mandap design v3", owner: "u6", due: "2026-09-22", status: "CLIENT_REVIEW" as const, priority: "HIGH" as const },
  { proj: "p1", name: "Lock guest count with family — 420 pax", owner: "u4", due: "2026-09-12", status: "BACKLOG" as const, priority: "CRITICAL" as const },
  { proj: "p1", name: "Sound & light PO — Studio Lumen", owner: "u7", due: "2026-09-15", status: "APPROVED" as const, priority: "MEDIUM" as const },
  { proj: "p1", name: "Book 6 bartenders (IBG certified) for sangeet night", owner: "u5", due: "2026-09-10", status: "COMPLETED" as const, priority: "HIGH" as const },
  { proj: "p2", name: "Corporate branding on bar counters — approval", owner: "u2", due: "2026-09-16", status: "CLIENT_REVIEW" as const, priority: "MEDIUM" as const },
  { proj: "p2", name: "Transport routing for 300 employees", owner: "u9", due: "2026-09-20", status: "PLANNED" as const, priority: "HIGH" as const },
  { proj: "p2", name: "Linen & furniture PO — Ivory Linen House", owner: "u7", due: "2026-09-11", status: "IN_PROGRESS" as const, priority: "MEDIUM" as const },
  { proj: "p3", name: "Activation zone layout — final sign-off", owner: "u6", due: "2026-09-13", status: "BACKLOG" as const, priority: "CRITICAL" as const },
  { proj: "p3", name: "Beverage supply contract — Cellar Door Wines", owner: "u7", due: "2026-09-14", status: "IN_PROGRESS" as const, priority: "HIGH" as const },
  { proj: "p3", name: "Photography & content team briefing", owner: "u10", due: "2026-09-19", status: "PLANNED" as const, priority: "MEDIUM" as const },
  { proj: "p6", name: "Taproom bar build — final walkthrough", owner: "u5", due: "2026-09-17", status: "CLIENT_REVIEW" as const, priority: "HIGH" as const },
  { proj: "p7", name: "Escalate: sound vendor delay", owner: "u2", due: "2026-09-11", status: "BACKLOG" as const, priority: "CRITICAL" as const },
  { proj: "p9", name: "Final invoice — client sign-off", owner: "u8", due: "2026-09-13", status: "APPROVED" as const, priority: "MEDIUM" as const },
];

const INV_ITEMS = [
  { sku: "SP-GIN-BS", name: "Bombay Sapphire Gin", cat: "Spirits", unit: "btl", size: 750, cost: 2150, vendor: "v8", qty: [64, 18, 22, 30, 14, 6], reorder: [24, 16, 12, 18, 12, 10] },
  { sku: "SP-GIN-GT", name: "Greater Than London Dry Gin", cat: "Spirits", unit: "btl", size: 750, cost: 1250, vendor: "v8", qty: [40, 26, 15, 12, 20, 9], reorder: [18, 12, 10, 10, 10, 8] },
  { sku: "SP-VOD-AB", name: "Absolut Vodka", cat: "Spirits", unit: "btl", size: 750, cost: 1850, vendor: "v8", qty: [52, 20, 24, 28, 11, 14], reorder: [20, 12, 12, 14, 12, 8] },
  { sku: "SP-WHI-JM", name: "Jameson Irish Whiskey", cat: "Spirits", unit: "btl", size: 750, cost: 2600, vendor: "v8", qty: [36, 14, 18, 20, 9, 7], reorder: [16, 10, 10, 12, 8, 6] },
  { sku: "SP-RUM-OM", name: "Old Monk Rum", cat: "Spirits", unit: "btl", size: 750, cost: 650, vendor: "v8", qty: [48, 30, 20, 16, 18, 22], reorder: [20, 12, 10, 10, 10, 10] },
  { sku: "SP-CAM", name: "Campari", cat: "Spirits", unit: "btl", size: 750, cost: 2300, vendor: "v8", qty: [14, 4, 6, 9, 3, 2], reorder: [6, 4, 4, 4, 3, 2] },
  { sku: "SP-VER-MR", name: "Martini Rosso Vermouth", cat: "Spirits", unit: "btl", size: 750, cost: 1100, vendor: "v8", qty: [12, 5, 6, 8, 2, 3], reorder: [6, 4, 4, 4, 3, 2] },
  { sku: "MX-TON-SP", name: "Sepoy & Co Tonic Water", cat: "Mixers", unit: "btl", size: 200, cost: 65, vendor: "v8", qty: [480, 160, 210, 300, 90, 70], reorder: [240, 150, 120, 150, 120, 80] },
  { sku: "MX-GIN-SW", name: "Schweppes Ginger Ale", cat: "Mixers", unit: "can", size: 300, cost: 45, vendor: "v8", qty: [360, 120, 140, 180, 150, 60], reorder: [180, 100, 100, 120, 100, 60] },
  { sku: "MX-SODA", name: "Club Soda", cat: "Mixers", unit: "btl", size: 300, cost: 25, vendor: "v8", qty: [600, 240, 260, 320, 210, 180], reorder: [240, 120, 120, 150, 120, 100] },
  { sku: "MX-SYR", name: "House Sugar Syrup", cat: "Mixers", unit: "btl", size: 1000, cost: 180, vendor: "v1", qty: [30, 12, 10, 14, 8, 6], reorder: [12, 6, 6, 6, 6, 4] },
  { sku: "GL-HB", name: "Highball Glass 350 ml", cat: "Glassware", unit: "pc", size: null, cost: 85, vendor: "v4", qty: [1200, 600, 480, 520, 300, 260], reorder: [600, 400, 300, 300, 250, 200] },
  { sku: "GL-RK", name: "Rocks Glass 300 ml", cat: "Glassware", unit: "pc", size: null, cost: 95, vendor: "v4", qty: [800, 380, 300, 360, 220, 180], reorder: [400, 250, 200, 200, 150, 120] },
  { sku: "GL-CP", name: "Coupe Glass 180 ml", cat: "Glassware", unit: "pc", size: null, cost: 140, vendor: "v4", qty: [420, 150, 180, 200, 90, 60], reorder: [200, 120, 100, 100, 80, 60] },
  { sku: "EQ-SHK", name: "Boston Shaker Set", cat: "Bar equipment", unit: "set", size: null, cost: 950, vendor: "v4", qty: [48, 16, 14, 20, 10, 8], reorder: [20, 10, 8, 10, 8, 6] },
  { sku: "EQ-JIG", name: "Jigger 30/60 ml", cat: "Bar equipment", unit: "pc", size: null, cost: 320, vendor: "v4", qty: [60, 20, 18, 24, 12, 10], reorder: [24, 10, 10, 10, 8, 6] },
  { sku: "EQ-BAR", name: "Portable Bar Counter Module", cat: "Bar equipment", unit: "unit", size: null, cost: 38000, vendor: "v4", qty: [14, 4, 3, 5, 2, 2], reorder: [6, 2, 2, 2, 1, 1] },
  { sku: "CN-STR", name: "Paper Straws (box of 500)", cat: "Consumables", unit: "box", size: null, cost: 450, vendor: "v4", qty: [22, 6, 8, 10, 3, 4], reorder: [10, 4, 4, 4, 4, 3] },
  { sku: "CN-NAP", name: "Cocktail Napkins (pack of 250)", cat: "Consumables", unit: "pack", size: null, cost: 220, vendor: "v4", qty: [40, 12, 14, 16, 6, 8], reorder: [16, 8, 8, 8, 6, 5] },
  { sku: "CN-JUN", name: "Juniper Berries 100 g", cat: "Consumables", unit: "pack", size: null, cost: 380, vendor: "v1", qty: [9, 2, 2, 4, 1, 1], reorder: [4, 3, 2, 2, 2, 1] },
];

const RECIPES = [
  { name: "Gin & Tonic", glass: "Highball", ings: [["SP-GIN-BS", 60], ["MX-TON-SP", 150]], garnish: 14, price: 520 },
  { name: "Negroni", glass: "Rocks", ings: [["SP-GIN-GT", 30], ["SP-CAM", 30], ["SP-VER-MR", 30]], garnish: 10, price: 640 },
  { name: "Jaipur Mule", glass: "Highball", ings: [["SP-VOD-AB", 60], ["MX-GIN-SW", 120], ["MX-SYR", 10]], garnish: 12, price: 480 },
  { name: "Old Monk Spiced Sour", glass: "Coupe", ings: [["SP-RUM-OM", 60], ["MX-SYR", 20]], garnish: 18, price: 420 },
  { name: "Jameson Highball", glass: "Highball", ings: [["SP-WHI-JM", 60], ["MX-SODA", 150]], garnish: 6, price: 560 },
] as const;

const INVOICES = [
  { no: "AMM/UDR/26-27/0012", client: "c1", proj: "p1", city: "Dehradun", issue: "2026-08-05", due: "2026-08-20", items: [{ d: "Wedding production — advance (40%)", q: 1, r: 1680000 }], issued: true, paid: 1982400 },
  { no: "AMM/UDR/26-27/0019", client: "c1", proj: "p1", city: "Dehradun", issue: "2026-09-02", due: "2026-09-17", items: [{ d: "Sangeet bar service — 6 stations", q: 1, r: 420000 }, { d: "Mandap décor — milestone 2", q: 1, r: 300000 }], issued: true, paid: 0 },
  { no: "AMM/JPR/26-27/0041", client: "c2", proj: "p2", city: "Jaipur", issue: "2026-08-12", due: "2026-08-27", items: [{ d: "Annual Day — management fee (50%)", q: 1, r: 762000 }], issued: true, paid: 0 },
  { no: "AMM/BOM/26-27/0007", client: "c3", proj: "p3", city: "Mumbai", issue: "2026-08-18", due: "2026-09-02", items: [{ d: "IPL activation — mobilisation advance", q: 1, r: 932000 }], issued: true, paid: 500000 },
  { no: "AMM/GOA/26-27/0004", client: "c4", proj: "p4", city: "Goa", issue: "2026-09-01", due: "2026-09-30", items: [{ d: "Leadership offsite — booking advance (20%)", q: 1, r: 449000 }], issued: true, paid: 529820 },
  { no: "AMM/JPR/26-27/0044", client: "c6", proj: "p6", city: "Jaipur", issue: "2026-09-05", due: "2026-09-20", items: [{ d: "Taproom bar build", q: 1, r: 380000 }, { d: "Draught tower rental", q: 4, r: 9500 }], issued: true, paid: 0 },
  { no: "AMM/JPR/26-27/0045", client: "c4", proj: "p9", city: "Jaipur", issue: "2026-09-04", due: "2026-09-19", items: [{ d: "Vendor Awards Night — full & final", q: 1, r: 500000 }], issued: true, paid: 590000 },
  { no: "AMM/DEL/26-27/0009", client: "c7", proj: "p10", city: "Delhi", issue: "2026-08-24", due: "2026-09-08", items: [{ d: "Trade Night — bar & production, full & final", q: 1, r: 1949000 }], issued: true, paid: 1400000 },
  { no: "AMM/BLR/26-27/0006", client: "c8", proj: "p11", city: "Chennai", issue: "2026-09-09", due: "2026-09-24", items: [{ d: "Founders Mixer — advance (50%)", q: 1, r: 614000 }], issued: false, paid: 0 },
  { no: "AMM/JPR/26-27/0046", client: "c5", proj: "p8", city: "Jaipur", issue: "2026-09-09", due: "2026-09-24", items: [{ d: "Private dinner — bar & service", q: 1, r: 340000 }, { d: "Floral styling", q: 1, r: 120000 }], issued: false, paid: 0 },
];

const LICENCES = [
  { proj: "p7", type: "Occasional liquor licence (one-day)", auth: "Rajasthan Excise Dept.", city: "Jaipur", status: "APPLIED" as const, ref: "RJEX/2026/88213", by: "2026-09-12", owner: "u2" },
  { proj: "p7", type: "Fire NOC — temporary structure", auth: "Jaipur Greater Municipal Corp.", city: "Jaipur", status: "APPROVED" as const, ref: "JMC/FN/4410", by: "2026-09-11", owner: "u2" },
  { proj: "p3", type: "Event permission — public venue", auth: "BMC & Mumbai Police", city: "Mumbai", status: "APPLIED" as const, ref: "BMC/EVT/2231", by: "2026-09-18", owner: "u12" },
  { proj: "p3", type: "Temporary liquor serving licence", auth: "Maharashtra State Excise", city: "Mumbai", status: "NOT_APPLIED" as const, ref: "", by: "2026-09-17", owner: "u12" },
  { proj: "p6", type: "Music licence (PPL / IPRS)", auth: "PPL India", city: "Jaipur", status: "APPROVED" as const, ref: "PPL/JP/99812", by: "2026-09-15", owner: "u5" },
  { proj: "p11", type: "Temporary liquor licence", auth: "Karnataka Excise Dept.", city: "Chennai", status: "APPLIED" as const, ref: "KEX/BLR/5521", by: "2026-09-22", owner: "u11" },
  { proj: "p1", type: "Occasional liquor licence (one-day)", auth: "Rajasthan Excise Dept.", city: "Dehradun", status: "NOT_APPLIED" as const, ref: "", by: "2026-10-30", owner: "u15" },
  { proj: "p4", type: "Liquor event permit", auth: "Goa Excise Dept.", city: "Goa", status: "NOT_APPLIED" as const, ref: "", by: "2026-11-25", owner: "u14" },
  { proj: null, type: "FSSAI licence — central kitchen", auth: "FSSAI", city: "Jaipur", status: "APPROVED" as const, ref: "10826001000411", by: "2027-03-31", owner: "u8" },
];

const RISKS = [
  { proj: "p3", title: "Activation zone permit pending with BMC", severity: "CRITICAL" as const, owner: "u6", impact: "Event delay / relocation", status: "OPEN" as const },
  { proj: "p7", title: "Sound vendor (external) confirmed 2 weeks late", severity: "HIGH" as const, owner: "u2", impact: "Compressed setup window", status: "MITIGATING" as const },
  { proj: "p2", title: "Client budget freeze under internal review", severity: "MEDIUM" as const, owner: "u4", impact: "Payment delay risk", status: "OPEN" as const },
  { proj: "p5", title: "Peak wedding season — vendor availability tight", severity: "MEDIUM" as const, owner: "u4", impact: "Vendor cost escalation", status: "MONITORING" as const },
  { proj: "p1", title: "Weather risk — outdoor mandap, Nov monsoon tail", severity: "LOW" as const, owner: "u3", impact: "Backup tent required", status: "MITIGATING" as const },
];

const APPROVALS = [
  { proj: "p1", title: "Floral mandap design v3 — client sign-off", type: "CREATIVE" as const, requester: "u6", approver: "Rathi Family", status: "PENDING" as const },
  { proj: "p3", title: "Activation budget increase — ₹3.1L extra spend", type: "BUDGET" as const, requester: "u6", approver: "Zomato — Brand Marketing", status: "PENDING" as const },
  { proj: "p2", title: "PO — Ivory Linen House, ₹1.4L", type: "PURCHASE" as const, requester: "u7", approver: "Neha Agarwal", status: "APPROVED" as const },
  { proj: "p6", title: "Taproom build final walkthrough sign-off", type: "CLIENT" as const, requester: "u5", approver: "Aravali Craft Beer Co.", status: "PENDING" as const },
  { proj: "p7", title: "Emergency sound vendor swap — approval", type: "VENDOR" as const, requester: "u2", approver: "Kritika Bansal", status: "PENDING" as const },
  { proj: "p9", title: "Final client invoice ₹5.9L", type: "PAYMENT" as const, requester: "u8", approver: "Bansal Group Industries", status: "APPROVED" as const },
  { proj: "p5", title: "Vendor contract — Marigold Décor", type: "VENDOR" as const, requester: "u4", approver: "Kritika Bansal", status: "PENDING" as const },
];

const DOCUMENTS = [
  { proj: "p1", name: "Rathi–Sharma Master Services Agreement.pdf", type: "CONTRACT" as const, by: "u4" },
  { proj: "p1", name: "Sangeet Floor Plan v3.dwg", type: "DESIGN" as const, by: "u6" },
  { proj: "p3", name: "Zomato Activation — Brand Guidelines.pdf", type: "CREATIVE" as const, by: "u6" },
  { proj: "p2", name: "Cognizant PO #4471 — Ivory Linen.pdf", type: "PURCHASE_ORDER" as const, by: "u7" },
  { proj: "p7", name: "Tourism Conclave — Event Permit.pdf", type: "GOVERNMENT_PERMIT" as const, by: "u2" },
  { proj: "p1", name: "Guest List — Final 420 pax.xlsx", type: "GUEST_LIST" as const, by: "u4" },
  { proj: "p5", name: "Mehta–Kapoor Venue Contract — Fairmont.pdf", type: "CONTRACT" as const, by: "u4" },
];

const PURCHASE_REQUESTS = [
  { proj: "p1", item: "Premium spirits & mixers — sangeet bar", vendor: "v8", amount: 210000, status: "PO_RAISED" as const },
  { proj: "p2", item: "Branded bar counters x6", vendor: "v4", amount: 145000, status: "QUOTE_COMPARISON" as const },
  { proj: "p3", item: "Activation stage & rigging", vendor: "v2", amount: 480000, status: "APPROVAL_PENDING" as const },
  { proj: "p5", item: "Floral installations — mandap + entrance", vendor: "v3", amount: 390000, status: "RFQ_SENT" as const },
  { proj: "p6", item: "Draught beer towers x4", vendor: "v4", amount: 96000, status: "GOODS_RECEIVED" as const },
];

const EXPENSES = [
  { who: "u9", cat: "Travel", proj: "p4", amount: 8400, date: "2026-09-06", status: "PENDING" as const, note: "Goa recce — cab & fuel" },
  { who: "u5", cat: "Supplies", proj: "p1", amount: 3650, date: "2026-09-08", status: "PENDING" as const, note: "Cucumbers, juniper, citrus for tasting" },
  { who: "u12", cat: "Permits & fees", proj: "p3", amount: 12500, date: "2026-09-05", status: "APPROVED" as const, note: "BMC application fee" },
  { who: "u3", cat: "Meals", proj: "p1", amount: 2200, date: "2026-09-04", status: "REIMBURSED" as const, note: "Vendor walkthrough lunch" },
  { who: "u11", cat: "Travel", proj: "p11", amount: 5900, date: "2026-09-09", status: "PENDING" as const, note: "Venue recce, 2 visits" },
];

const SOPS = [
  { title: "New Event Onboarding", steps: 9, category: "Operations" },
  { title: "Vendor Onboarding & GST Verification", steps: 6, category: "Procurement" },
  { title: "Client Approval Workflow", steps: 5, category: "Client Servicing" },
  { title: "Purchase Request → PO → Payment", steps: 7, category: "Finance" },
  { title: "Event Closure & Vendor Settlement", steps: 8, category: "Finance" },
  { title: "Post-Event Review & Debrief", steps: 4, category: "Operations" },
  { title: "Bartender Deployment (IBG Certified Roster)", steps: 5, category: "Bar Ops" },
];

const AUTOMATIONS = [
  { id: "au1", name: "Deal Won → Project Auto-Creation", triggerType: "event", trigger: "lead.stage_changed:Won", actions: ["Create project from playbook", "Assign Project Manager", "Generate task list & timeline", "Create client folder", "Notify Ops team"], on: true },
  { id: "au2", name: "Task Overdue Escalation", triggerType: "event", trigger: "task.overdue", actions: ["Notify owner", "Notify PM after 24h", "Escalate to Founder after 48h", "Flag project risk"], on: true },
  { id: "au3", name: "Vendor Payment Reminder", triggerType: "time_relative", trigger: "purchase_order.due_in_days:3", actions: ["Notify Finance", "Notify Procurement Manager"], on: true },
  { id: "au4", name: "Client Approval Nudge", triggerType: "time_relative", trigger: "approval.pending_hours:48", actions: ["Send reminder to client contact", "Notify Client Servicing Lead"], on: false },
  { id: "au5", name: "Event Day Countdown Triggers", triggerType: "time_relative", trigger: "project.event_date_minus_days:30,7,1", actions: ["Auto-generate stage checklist", "Notify full project team"], on: true },
  { id: "au6", name: "Step done → hand off to next person", triggerType: "event", trigger: "flow_step.completed", actions: ["Unlock steps whose inputs are all done", "Notify next owner in Podium", "DM from Podium Bot", "Post in project channel"], on: true },
  { id: "au7", name: "Low stock → purchase request", triggerType: "threshold", trigger: "inventory_balance.available_lt_reorder_level", actions: ["Raise purchase request to preferred vendor", "Notify Procurement Manager"], on: true },
  { id: "au8", name: "Invoice overdue → Gmail reminder", triggerType: "time_relative", trigger: "invoice.overdue_days:7", actions: ["Draft reminder in Gmail", "Notify Client Servicing Lead", "Flag on city P&L"], on: true },
  { id: "au9", name: "Meet ends → action items to tasks", triggerType: "event", trigger: "meeting.ended", actions: ["Pull notes from Meet", "Create tasks for each action item", "Post summary to project channel"], on: false },
  { id: "au10", name: "Licence not approved T-7", triggerType: "time_relative", trigger: "licence.due_date_minus_days:7", actions: ["Escalate to Operations Manager", "Raise project risk"], on: true },
  { id: "au11", name: "Chat @mention → notification", triggerType: "event", trigger: "chat.mentioned", actions: ["Notify the mentioned person"], on: true },
];

const CHANNEL_MESSAGES: Array<[string, string, string]> = [
  ["general", "u1", "Morning team. 4 events in the next 16 days across Jaipur, Mumbai and Chennai. Keep your queue in Podium clean."],
  ["general", "u2", "Flows are live from today. When you finish a step, hit “Mark done” — the next person gets it automatically."],
  ["bar-ops", "u5", "Need 2 more IBG-certified bartenders for the Conclave on 14th. @Kritika can we pull from the Dehradun pool?"],
  ["bar-ops", "u2", "Yes — @Lakshya please release Rohan and Imran for 13–14 Sep."],
];

function financialYearFor(date: Date): string {
  // Indian FY: Apr(3, 0-indexed) - Mar. e.g. Sep 2026 -> "26-27".
  const y = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 3 ? y : y - 1;
  return `${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}`;
}

function gstSplit(taxableAmount: number, supplierSt: string, clientSt: string) {
  const intra = supplierSt === clientSt;
  const tax = Math.round(taxableAmount * 0.18);
  return {
    intra,
    cgst: intra ? tax / 2 : 0,
    sgst: intra ? tax / 2 : 0,
    igst: intra ? 0 : tax,
    total: taxableAmount + tax,
  };
}

/**
 * The three-part gate described above. Throws with a specific, actionable
 * reason rather than a generic refusal — whoever hits this needs to know
 * immediately which of the three conditions failed and what to do about it.
 */
async function assertSafeToSeed(): Promise<void> {
  if (process.env.PODIUM_ALLOW_DESTRUCTIVE_SEED !== "1") {
    throw new Error(
      "Refusing to seed: this TRUNCATEs every table in the target database. " +
        "Set PODIUM_ALLOW_DESTRUCTIVE_SEED=1 explicitly to confirm you mean to wipe " +
        `whatever DATABASE_URL currently points at (resolved database: "${resolvedDbName()}").`,
    );
  }

  const dbName = resolvedDbName();
  if (!/_dev$|_ci$|_test$/i.test(dbName)) {
    throw new Error(
      `Refusing to seed: database name "${dbName}" does not end in _dev, _ci, or _test. ` +
        "This script only ever runs against a disposable database by name, regardless of " +
        "PODIUM_ALLOW_DESTRUCTIVE_SEED. If this really is a throwaway database, rename it " +
        "or point DATABASE_URL at one whose name says so.",
    );
  }

  const clientCount = await db.client.count().catch(() => 0);
  if (clientCount >= 1000) {
    throw new Error(
      `Refusing to seed: database "${dbName}" already holds ${clientCount} client rows — ` +
        "that looks like real, imported data, not a fixture waiting to be created. " +
        "A database this large is refused even though its name and PODIUM_ALLOW_DESTRUCTIVE_SEED " +
        "both say to proceed, because by the time those disagree with the actual data, guessing " +
        "which one is right is not safe. If this is genuinely a disposable database with a lot of " +
        "test data in it, truncate it by hand first.",
    );
  }
}

function resolvedDbName(): string {
  const url = process.env.DATABASE_URL ?? "";
  return url.split("/").pop()?.split("?")[0] ?? "(unresolved)";
}

async function main() {
  await assertSafeToSeed();
  console.log(`Seeding Podium v2 development fixture into "${resolvedDbName()}" (from prototype seed data)…`);

  // --- wipe in reverse dependency order for idempotent re-seeding -----------
  const tableNames = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations')
  `;
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE ${tableNames.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );

  await db.gstStateCode.createMany({ data: GST_STATE_CODES.map(([code, state]) => ({ code, state })) });

  const workspace = await db.workspace.create({
    data: { name: process.env.SEED_WORKSPACE_NAME || "AMM Brands LLP", gstin: process.env.SEED_WORKSPACE_GSTIN || "08AACFA1234A1Z5" },
  });

  const cityByKey: Record<string, Awaited<ReturnType<typeof db.city.create>>> = {};
  for (const c of CITIES) {
    cityByKey[c.key] = await db.city.create({
      data: { workspaceId: workspace.id, name: c.key, code: c.code, state: c.state, gstStateCode: c.st, isHq: c.hq },
    });
  }

  // --- departments -------------------------------------------------------
  const deptByKey: Record<string, Awaited<ReturnType<typeof db.department.create>>> = {};
  for (const d of DEPARTMENTS) {
    deptByKey[d.key] = await db.department.create({ data: { workspaceId: workspace.id, key: d.key, name: d.name } });
  }

  // --- RBAC: roles, permissions, role_permissions -----------------------
  const roleByName: Record<string, Awaited<ReturnType<typeof db.role.create>>> = {};
  for (const spec of ROLES) {
    roleByName[spec.name] = await db.role.create({ data: { workspaceId: workspace.id, name: spec.name, description: spec.description } });
  }
  const permByKey: Record<string, Awaited<ReturnType<typeof db.permission.create>>> = {};
  for (const key of allPermissions()) {
    const [resource, action] = key.split(":");
    permByKey[key] = await db.permission.create({ data: { workspaceId: workspace.id, resource: resource!, action: action! } });
  }
  const ROLE_GRANTS: Record<string, readonly string[]> = Object.fromEntries(ROLES.map((r) => [r.name, r.permissions]));
  for (const [roleName, grants] of Object.entries(ROLE_GRANTS)) {
    for (const key of new Set(grants)) {
      const perm = permByKey[key];
      if (!perm) continue;
      await db.rolePermission.create({ data: { roleId: roleByName[roleName].id, permissionId: perm.id } });
    }
  }

  // --- users --------------------------------------------------------------
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
  const userByKey: Record<string, Awaited<ReturnType<typeof db.user.create>>> = {};
  for (const u of TEAM) {
    const email = u.name.toLowerCase().split(" ").join(".") + "@ammbrands.in";
    const rbacRole = roleByName[USER_RBAC_ROLE[u.key]];
    const user = await db.user.create({
      data: {
        workspaceId: workspace.id,
        name: u.name,
        email,
        passwordHash,
        dept: u.dept,
        primaryRoleId: rbacRole.id,
        primaryCityId: cityByKey[u.city].id,
      },
    });
    userByKey[u.key] = user;
    await db.userRole.create({ data: { userId: user.id, roleId: rbacRole.id } });
    const deptKey = ROLES.find((r) => r.name === USER_RBAC_ROLE[u.key])?.department;
    if (deptKey) await db.user.update({ where: { id: user.id }, data: { departmentId: deptByKey[deptKey].id } });
    // Founder + Head of Operations (Admin) get all-city access; everyone else, their home city.
    if (u.key === "u1" || u.key === "u2" || u.key === "u8") {
      await db.userCityAccess.create({ data: { userId: user.id, cityId: null, scope: "ALL" } });
    } else {
      await db.userCityAccess.create({ data: { userId: user.id, cityId: cityByKey[u.city].id, scope: "WRITE" } });
    }
    await db.attendance.create({ data: { userId: user.id, status: "PRESENT" } });
  }

  // --- clients / vendors ----------------------------------------------------
  const clientByKey: Record<string, Awaited<ReturnType<typeof db.client.create>>> = {};
  for (const c of CLIENTS) {
    clientByKey[c.key] = await db.client.create({
      data: {
        workspaceId: workspace.id,
        name: c.name,
        type: c.type,
        cityId: cityByKey[c.city].id,
        gstStateCode: c.st,
        gstin: c.type === "INDIVIDUAL" ? null : `${c.st}AA${c.key.toUpperCase()}X1234Z${c.key.slice(1)}`,
        ltv: c.ltv,
        since: new Date(c.since),
      },
    });
  }
  const vendorByKey: Record<string, Awaited<ReturnType<typeof db.vendor.create>>> = {};
  for (const v of VENDORS) {
    vendorByKey[v.key] = await db.vendor.create({
      data: { workspaceId: workspace.id, name: v.name, category: v.category, cityId: cityByKey[v.city].id, rating: v.rating, gstin: v.gstin, status: v.status },
    });
  }

  // --- leads ----------------------------------------------------------------
  const LEADS = [
    { name: "Aggarwal–Singh Wedding, Jaipur", stage: "PROPOSAL" as const, value: 3800000, city: "Jaipur" },
    { name: "HDFC Bank — Regional Sales Summit", stage: "NEGOTIATION" as const, value: 2200000, city: "Jaipur" },
    { name: "Nykaa — Store Launch Activation", stage: "QUALIFIED" as const, value: 1650000, city: "Mumbai" },
    { name: "Sharma Family — Anniversary Gala", stage: "LEAD" as const, value: 920000, city: "Dehradun" },
    { name: "InfoEdge — Leadership Retreat", stage: "WON" as const, value: 2750000, city: "Goa" },
    { name: "Toshniwal–Jain Wedding, Jaipur", stage: "NEGOTIATION" as const, value: 4500000, city: "Jaipur" },
    { name: "Bira 91 — Monsoon Brand Pop-up", stage: "LEAD" as const, value: 750000, city: "Jaipur" },
    { name: "Pearl Academy — Convocation", stage: "QUALIFIED" as const, value: 1100000, city: "Jaipur" },
  ];
  for (const l of LEADS) {
    await db.lead.create({ data: { workspaceId: workspace.id, name: l.name, stage: l.stage, value: l.value, ownerId: userByKey.u10.id, cityId: cityByKey[l.city].id } });
  }

  // --- projects ---------------------------------------------------------
  const projectByKey: Record<string, Awaited<ReturnType<typeof db.project.create>>> = {};
  for (const p of PROJECTS) {
    const project = await db.project.create({
      data: {
        workspaceId: workspace.id,
        name: p.name,
        clientId: clientByKey[p.client].id,
        type: p.type,
        cityId: cityByKey[p.city].id,
        eventDate: new Date(p.date),
        pmId: userByKey[p.pm].id,
        status: p.status,
        health: p.health,
        revenue: p.revenue,
        estCost: p.estCost,
        actCost: p.actCost,
      },
    });
    projectByKey[p.key] = project;
    for (const uKey of p.team) {
      await db.projectMember.create({ data: { projectId: project.id, userId: userByKey[uKey].id, roleOnProject: uKey === p.pm ? "PROJECT_MANAGER" : "TEAM_MEMBER" } });
    }
    for (const vKey of p.vendors) {
      await db.projectVendor.create({ data: { projectId: project.id, vendorId: vendorByKey[vKey].id } });
    }
    // A project channel per project, matching CHANNELS auto-creation.
    await db.channel.create({
      data: {
        workspaceId: workspace.id,
        name: p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
        kind: "PROJECT",
        projectId: project.id,
        description: `Project channel · ${p.city}`,
      },
    });
  }

  // --- tasks --------------------------------------------------------------
  for (const t of TASKS) {
    await db.task.create({
      data: { projectId: projectByKey[t.proj].id, name: t.name, ownerId: userByKey[t.owner].id, dueAt: new Date(t.due), status: t.status, priority: t.priority },
    });
  }

  // --- inventory: 6 city locations, items, balances, a few movements ------
  const locationByCity: Record<string, Awaited<ReturnType<typeof db.inventoryLocation.create>>> = {};
  for (const c of CITIES) {
    locationByCity[c.key] = await db.inventoryLocation.create({ data: { cityId: cityByKey[c.key].id, name: `${c.key} Store` } });
  }
  const itemBySku: Record<string, Awaited<ReturnType<typeof db.inventoryItem.create>>> = {};
  for (const it of INV_ITEMS) {
    const item = await db.inventoryItem.create({
      data: {
        workspaceId: workspace.id,
        sku: it.sku,
        name: it.name,
        category: it.cat,
        unit: it.unit,
        sizeMl: it.size,
        standardCost: it.cost,
        preferredVendorId: vendorByKey[it.vendor].id,
      },
    });
    itemBySku[it.sku] = item;
    for (let i = 0; i < CITIES.length; i++) {
      const location = locationByCity[CITIES[i].key];
      // Balances are never written with a nonzero opening quantity directly —
      // even seed data goes through the ledger, so `SUM(inventory_movements)`
      // reconstructs the true balance for every SKU/location, seeded or not.
      // (An earlier version of this seed set qtyOnHand directly here, which
      // technically violated the "balance is always derived from the
      // ledger" invariant for opening stock specifically — caught by a
      // production-readiness audit that cross-checked recorded balances
      // against summed movements and found seeded rows didn't reconcile.)
      await db.inventoryBalance.create({
        data: { skuId: item.id, locationId: location.id, qtyOnHand: 0, reorderLevel: it.reorder[i] },
      });
      if (it.qty[i] > 0) {
        await db.inventoryMovement.create({
          data: {
            skuId: item.id,
            type: "RECEIVE",
            toLocationId: location.id,
            qty: it.qty[i],
            actorId: userByKey.u7.id,
            refType: "opening_stock",
            note: "Opening stock (seed baseline)",
          },
        });
        await db.inventoryBalance.update({
          where: { skuId_locationId: { skuId: item.id, locationId: location.id } },
          data: { qtyOnHand: it.qty[i] },
        });
      }
    }
  }
  // Historical/demo movements layered on top of opening stock. Each one
  // actually adjusts inventory_balances too (mirroring exactly what
  // InventoryService.applyBalanceDelta does at runtime for real requests) --
  // an earlier version of this seed inserted these ledger rows without ever
  // touching the balance, which meant the "balance = SUM(movements)"
  // invariant silently didn't hold for the demo data. Same audit finding as
  // the opening-stock fix above, same fix: nothing in this seed script
  // writes qtyOnHand without a movement backing it, and no movement here is
  // left unapplied.
  async function applySeedBalanceDelta(skuId: string, locationId: string, delta: number) {
    await db.inventoryBalance.update({
      where: { skuId_locationId: { skuId, locationId } },
      data: { qtyOnHand: { increment: delta } },
    });
  }
  const seedMovements: Array<[string, "TRANSFER" | "DAMAGE" | "RECEIVE" | "CONSUME", string | null, string | null, number, string]> = [
    ["SP-GIN-BS", "TRANSFER", "Jaipur", "Dehradun", 12, "Rathi tasting + sangeet buffer"],
    ["GL-HB", "DAMAGE", "Goa", null, 40, "Chipped — monsoon audit"],
    ["MX-TON-SP", "RECEIVE", null, "Jaipur", 240, "Cellar Door GRN #7781"],
    ["SP-WHI-JM", "CONSUME", "Delhi", null, 22, "Pernod Trade Night closure"],
  ];
  for (const [sku, kind, from, to, qty, note] of seedMovements) {
    const skuId = itemBySku[sku].id;
    const fromLocationId = from ? locationByCity[from].id : undefined;
    const toLocationId = to ? locationByCity[to].id : undefined;
    if (kind === "TRANSFER") {
      // Mirrors InventoryService.transfer(): one TRANSFER_OUT row + one
      // TRANSFER_IN row, both carrying the same from/to/qty.
      await db.inventoryMovement.create({ data: { skuId, type: "TRANSFER_OUT", fromLocationId, toLocationId, qty, actorId: userByKey.u7.id, note } });
      await db.inventoryMovement.create({ data: { skuId, type: "TRANSFER_IN", fromLocationId, toLocationId, qty, actorId: userByKey.u7.id, note } });
      await applySeedBalanceDelta(skuId, fromLocationId!, -qty);
      await applySeedBalanceDelta(skuId, toLocationId!, qty);
    } else {
      await db.inventoryMovement.create({ data: { skuId, type: kind, fromLocationId, toLocationId, qty, actorId: userByKey.u7.id, note } });
      if (kind === "RECEIVE") await applySeedBalanceDelta(skuId, toLocationId!, qty);
      else await applySeedBalanceDelta(skuId, fromLocationId!, -qty); // DAMAGE, CONSUME
    }
  }
  // A handful of event reservations mirroring the prototype's ALLOC seed.
  const ALLOC: Array<[string, string, string, number]> = [
    ["SP-GIN-BS", "Dehradun", "p1", 10], ["MX-TON-SP", "Dehradun", "p1", 60], ["EQ-BAR", "Dehradun", "p1", 3],
    ["SP-WHI-JM", "Jaipur", "p7", 12], ["SP-VOD-AB", "Jaipur", "p7", 14], ["GL-HB", "Jaipur", "p7", 400], ["EQ-BAR", "Jaipur", "p7", 4],
    ["SP-GIN-GT", "Mumbai", "p3", 6], ["GL-CP", "Mumbai", "p3", 120],
    ["SP-RUM-OM", "Chennai", "p11", 10], ["MX-GIN-SW", "Chennai", "p11", 96],
  ];
  for (const [sku, city, proj, qty] of ALLOC) {
    await db.inventoryReservation.create({
      data: { skuId: itemBySku[sku].id, locationId: locationByCity[city].id, projectId: projectByKey[proj].id, qty, status: "RESERVED" },
    });
  }

  // --- recipes --------------------------------------------------------------
  for (const r of RECIPES) {
    const recipe = await db.recipe.create({ data: { workspaceId: workspace.id, name: r.name, glass: r.glass, garnishCost: r.garnish, price: r.price } });
    for (const [sku, ml] of r.ings) {
      await db.recipeItem.create({ data: { recipeId: recipe.id, skuId: itemBySku[sku as string].id, qtyMl: ml as number } });
    }
  }

  // --- procurement ------------------------------------------------------
  for (const pr of PURCHASE_REQUESTS) {
    await db.purchaseRequest.create({
      data: { projectId: projectByKey[pr.proj].id, item: pr.item, vendorId: vendorByKey[pr.vendor].id, amount: pr.amount, status: pr.status },
    });
  }

  // --- expenses ---------------------------------------------------------
  for (const e of EXPENSES) {
    await db.expense.create({
      data: { userId: userByKey[e.who].id, projectId: projectByKey[e.proj].id, category: e.cat, amount: e.amount, incurredAt: new Date(e.date), status: e.status, note: e.note },
    });
  }

  // --- invoices: real GST engine, sequential per-city-per-FY counters ------
  const counterByKey = new Map<string, number>();
  for (const inv of INVOICES) {
    const city = cityByKey[inv.city];
    const cityRow = CITIES.find((c) => c.key === inv.city)!;
    const client = CLIENTS.find((c) => c.key === inv.client)!;
    const taxable = inv.items.reduce((s, i) => s + i.q * i.r, 0);
    const split = gstSplit(taxable, cityRow.st, client.st);
    const fy = financialYearFor(new Date(inv.issue));
    const seq = Number(inv.no.split("/").pop());
    counterByKey.set(`${inv.city}:${fy}`, Math.max(counterByKey.get(`${inv.city}:${fy}`) ?? 0, seq));

    const invoice = await db.invoice.create({
      data: {
        workspaceId: workspace.id,
        invoiceNo: inv.no,
        clientId: clientByKey[inv.client].id,
        projectId: projectByKey[inv.proj].id,
        cityId: city.id,
        issueDate: inv.issued ? new Date(inv.issue) : null,
        dueDate: new Date(inv.due),
        status: inv.issued ? (Number(inv.paid) >= split.total ? "PAID" : Number(inv.paid) > 0 ? "PARTIALLY_PAID" : "ISSUED") : "DRAFT",
        placeOfSupply: client.st,
        taxableAmount: taxable,
        cgst: split.cgst,
        sgst: split.sgst,
        igst: split.igst,
        total: split.total,
      },
    });
    for (const item of inv.items) {
      await db.invoiceItem.create({ data: { invoiceId: invoice.id, description: item.d, qty: item.q, rate: item.r, hsnSac: "9983" } });
    }
    if (inv.paid > 0) {
      await db.payment.create({ data: { invoiceId: invoice.id, amount: inv.paid, method: "BANK_TRANSFER", createdById: userByKey.u8.id } });
    }
  }
  for (const [key, seq] of counterByKey.entries()) {
    const [cityKey, fy] = key.split(":");
    await db.invoiceCounter.create({ data: { workspaceId: workspace.id, cityId: cityByKey[cityKey].id, financialYear: fy, lastSequence: seq } });
  }

  // --- licences / risks / approvals / documents ----------------------------
  for (const l of LICENCES) {
    await db.licence.create({
      data: {
        workspaceId: workspace.id,
        projectId: l.proj ? projectByKey[l.proj].id : null,
        type: l.type,
        authority: l.auth,
        cityId: cityByKey[l.city].id,
        status: l.status,
        refNo: l.ref || null,
        dueDate: new Date(l.by),
        ownerId: userByKey[l.owner].id,
      },
    });
  }
  for (const r of RISKS) {
    await db.risk.create({ data: { projectId: projectByKey[r.proj].id, title: r.title, severity: r.severity, ownerId: userByKey[r.owner].id, impact: r.impact, status: r.status } });
  }
  for (const a of APPROVALS) {
    await db.approval.create({
      data: { projectId: projectByKey[a.proj].id, title: a.title, type: a.type, requesterId: userByKey[a.requester].id, approverRef: a.approver, status: a.status },
    });
  }
  // Demo metadata only -- no real file backs any of these on disk, so
  // sizeBytes is honestly 0 rather than a fabricated number (mirrors the
  // Phase F migration's backfill for the same pre-existing rows).
  const guessMimeType = (name: string): string => {
    if (name.endsWith(".pdf")) return "application/pdf";
    if (name.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (name.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    return "application/octet-stream";
  };
  for (const d of DOCUMENTS) {
    const doc = await db.document.create({ data: { workspaceId: workspace.id, projectId: projectByKey[d.proj].id, name: d.name, type: d.type, createdById: userByKey[d.by].id } });
    await db.documentVersion.create({
      data: {
        documentId: doc.id, versionNo: 1, storageKey: `local/${doc.id}/v1/${d.name}`,
        fileName: d.name, mimeType: guessMimeType(d.name), sizeBytes: 0,
        uploadedById: userByKey[d.by].id,
      },
    });
  }

  // --- SOPs -------------------------------------------------------------
  for (const s of SOPS) {
    const sop = await db.sop.create({ data: { workspaceId: workspace.id, title: s.title, department: s.category } });
    await db.sopVersion.create({ data: { sopId: sop.id, versionNo: 1, body: `${s.title} — ${s.steps} steps. (Body content to be authored by ${s.category}.)`, stepsCount: s.steps } });
  }

  // --- automation rules (au1–au10) ---------------------------------------
  for (const a of AUTOMATIONS) {
    await db.automationRule.create({
      data: { workspaceId: workspace.id, name: a.name, triggerType: a.triggerType, triggerConfig: { trigger: a.trigger } as Prisma.InputJsonValue, actions: a.actions as unknown as Prisma.InputJsonValue, isEnabled: a.on },
    });
  }

  // --- chat: company/city channels + a few seed messages ------------------
  const companyChannels = [
    { name: "general", desc: "Everyone at AMM Brands" },
    { name: "announcements", desc: "Company notices from leadership" },
    { name: "bar-ops", desc: "Crews, menus, stock calls" },
  ];
  const channelByName: Record<string, Awaited<ReturnType<typeof db.channel.create>>> = {};
  for (const ch of companyChannels) {
    channelByName[ch.name] = await db.channel.create({ data: { workspaceId: workspace.id, name: ch.name, kind: "COMPANY", description: ch.desc } });
  }
  for (const c of CITIES) {
    channelByName[c.key.toLowerCase()] = await db.channel.create({
      data: { workspaceId: workspace.id, name: c.key.toLowerCase(), kind: "CITY", cityId: cityByKey[c.key].id, description: `${c.key} team` },
    });
  }
  for (const [chName, uKey, body] of CHANNEL_MESSAGES) {
    const channel = channelByName[chName];
    if (!channel) continue;
    await db.message.create({ data: { channelId: channel.id, authorId: userByKey[uKey].id, body } });
  }

  // --- flow templates + one live instance (the Gin & Tonic serve) -------
  const FLOW_TEMPLATES = [
    {
      name: "Signature serve — Gin & Tonic", cat: "Bar Ops",
      desc: "Two mixologists, parallel prep, a join before garnish. The textbook handoff.",
      steps: [
        { k: "a", name: "Brief the serve & assign stations", role: "Operations Manager", owner: "u2", sla: 15, deps: [] },
        { k: "b", name: "Chill highballs & crack fresh ice", role: "Logistics", owner: "u9", sla: 20, deps: ["a"] },
        { k: "c", name: "Prep garnish — cucumber ribbon & juniper", role: "Creative", owner: "u6", sla: 20, deps: ["a"] },
        { k: "d", name: "Mix the gin — 60 ml over ice", role: "Mixologist (gin)", owner: "u1", sla: 10, deps: ["b"] },
        { k: "e", name: "Mix the tonic — 150 ml, slow pour", role: "Mixologist (tonic)", owner: "u5", sla: 10, deps: ["d"] },
        { k: "f", name: "Garnish & hand to server", role: "Creative", owner: "u6", sla: 5, deps: ["c", "e"] },
        { k: "g", name: "Taste check & sign off", role: "Operations Manager", owner: "u2", sla: 10, deps: ["f"] },
      ],
    },
    {
      name: "Event bar setup", cat: "Bar Ops",
      desc: "Menu lock to bar-ready, across store, logistics and the bar crew.",
      steps: [
        { k: "a", name: "Confirm menu & guest count", role: "Client Servicing", owner: "u4", sla: 1440, deps: [] },
        { k: "b", name: "Pick stock from city store", role: "Store", owner: "u7", sla: 480, deps: ["a"] },
        { k: "c", name: "Book bartender crew", role: "Bar Ops Head", owner: "u5", sla: 720, deps: ["a"] },
        { k: "d", name: "Dispatch stock & bar modules", role: "Logistics", owner: "u9", sla: 360, deps: ["b"] },
        { k: "e", name: "Build bars on site", role: "Bar Ops Head", owner: "u5", sla: 240, deps: ["c", "d"] },
        { k: "f", name: "Liquor licence on display", role: "Operations Manager", owner: "u2", sla: 60, deps: ["e"] },
        { k: "g", name: "Bar-ready walkthrough", role: "Event Producer", owner: "u3", sla: 60, deps: ["f"] },
      ],
    },
    {
      name: "Vendor payment release", cat: "Finance",
      desc: "Vendor invoice to payment with two approvals.",
      steps: [
        { k: "a", name: "Upload vendor invoice & GRN", role: "Procurement", owner: "u7", sla: 480, deps: [] },
        { k: "b", name: "Operations approval", role: "Operations Manager", owner: "u2", sla: 720, deps: ["a"] },
        { k: "c", name: "Finance check — GST & TDS", role: "Finance", owner: "u8", sla: 720, deps: ["b"] },
        { k: "d", name: "Release payment", role: "Finance", owner: "u8", sla: 480, deps: ["c"] },
        { k: "e", name: "Send remittance advice to vendor", role: "Procurement", owner: "u7", sla: 120, deps: ["d"] },
      ],
    },
    {
      name: "Invoice to cash", cat: "Finance",
      desc: "Raise, verify, send, chase, reconcile.",
      steps: [
        { k: "a", name: "Draft invoice from project budget", role: "Finance", owner: "u8", sla: 480, deps: [] },
        { k: "b", name: "PM verifies deliverables", role: "Project Manager", owner: "u2", sla: 480, deps: ["a"] },
        { k: "c", name: "Send invoice to client", role: "Client Servicing", owner: "u4", sla: 240, deps: ["b"] },
        { k: "d", name: "Payment follow-up", role: "Client Servicing", owner: "u4", sla: 10080, deps: ["c"] },
        { k: "e", name: "Reconcile in books", role: "Finance", owner: "u8", sla: 480, deps: ["d"] },
      ],
    },
    {
      name: "New employee onboarding", cat: "People",
      desc: "Offer accepted to first live shift.",
      steps: [
        { k: "a", name: "Collect documents & KYC", role: "HR", owner: "u8", sla: 1440, deps: [] },
        { k: "b", name: "Create Podium & Google accounts", role: "Admin", owner: "u1", sla: 240, deps: ["a"] },
        { k: "c", name: "Issue uniform & bar kit", role: "Store", owner: "u7", sla: 1440, deps: ["a"] },
        { k: "d", name: "SOP training — bar safety", role: "Bar Ops Head", owner: "u5", sla: 2880, deps: ["b", "c"] },
        { k: "e", name: "Shadow shift at a live event", role: "Operations Manager", owner: "u2", sla: 4320, deps: ["d"] },
      ],
    },
  ];
  const templateByName: Record<string, Awaited<ReturnType<typeof db.flowTemplate.create>>> = {};
  for (const t of FLOW_TEMPLATES) {
    templateByName[t.name] = await db.flowTemplate.create({
      data: { workspaceId: workspace.id, name: t.name, category: t.cat, description: t.desc, steps: t.steps as unknown as Prisma.InputJsonValue },
    });
  }

  // Instantiate the G&T flow on p1, seeded mid-flight: a,b,c,d done; e active; f,g locked.
  const gtTemplate = FLOW_TEMPLATES[0];
  const instance = await db.flowInstance.create({
    data: { templateId: templateByName[gtTemplate.name].id, projectId: projectByKey.p1.id, name: gtTemplate.name, status: "ACTIVE" },
  });
  const stepByKey: Record<string, Awaited<ReturnType<typeof db.flowStep.create>>> = {};
  const now = Date.now();
  const at = (minsAgo: number) => new Date(now - minsAgo * 60000);
  const stepState: Record<string, { status: "COMPLETED" | "ACTIVE" | "READY" | "LOCKED"; readyAgo?: number; startAgo?: number; doneAgo?: number }> = {
    a: { status: "COMPLETED", readyAgo: 60, startAgo: 58, doneAgo: 50 },
    b: { status: "COMPLETED", readyAgo: 50, startAgo: 48, doneAgo: 40 },
    c: { status: "COMPLETED", readyAgo: 50, startAgo: 45, doneAgo: 35 },
    d: { status: "COMPLETED", readyAgo: 40, startAgo: 38, doneAgo: 30 },
    // Step e's SLA is 10 minutes (see FLOW_TEMPLATES above) -- readyAgo/startAgo
    // here must stay under that, or this "nice mid-flight demo" step is
    // already SLA-breached the instant it's seeded and gets auto-escalated
    // by FlowSlaService's first cron tick, which isn't the intended demo
    // state. (Caught by the flow-sla e2e tests expecting exactly one fresh
    // breach when they backdate their own step — a stale, already-breached
    // seed step made that count nondeterministic.)
    e: { status: "ACTIVE", readyAgo: 3, startAgo: 1 },
    f: { status: "LOCKED" },
    g: { status: "LOCKED" },
  };
  for (const s of gtTemplate.steps) {
    const st = stepState[s.k];
    stepByKey[s.k] = await db.flowStep.create({
      data: {
        flowInstanceId: instance.id,
        key: s.k,
        name: s.name,
        role: s.role,
        ownerId: userByKey[s.owner].id,
        slaMinutes: s.sla,
        status: st.status,
        readyAt: st.readyAgo != null ? at(st.readyAgo) : null,
        startedAt: st.startAgo != null ? at(st.startAgo) : null,
        doneAt: st.doneAgo != null ? at(st.doneAgo) : null,
      },
    });
  }
  for (const s of gtTemplate.steps) {
    for (const dep of s.deps) {
      await db.flowStepDependency.create({ data: { stepId: stepByKey[s.k].id, dependsOnStepId: stepByKey[dep].id, joinType: "AND" } });
    }
    if (stepState[s.k].doneAgo != null || stepState[s.k].startAgo != null) {
      await db.flowStepRun.create({
        data: {
          stepId: stepByKey[s.k].id,
          fromStatus: "READY",
          toStatus: stepState[s.k].status === "COMPLETED" ? "COMPLETED" : "ACTIVE",
          actorId: userByKey[s.owner].id,
          at: stepState[s.k].doneAgo != null ? at(stepState[s.k].doneAgo!) : at(stepState[s.k].startAgo!),
        },
      });
    }
  }

  // --- event-day runsheet for the Tourism Conclave (p7) --------------------
  const runsheet = await db.runsheet.create({ data: { projectId: projectByKey.p7.id } });
  const RUNSHEET_ITEMS: Array<[string, string, string]> = [
    ["06:00", "Crew call at venue gate 2", "u2"], ["06:30", "New sound crew briefing", "u2"],
    ["07:00", "Bar modules unloaded (4 stations)", "u9"], ["08:30", "Stock count at bar vs pick list", "u5"],
    ["09:30", "Excise licence displayed at every bar", "u2"], ["10:00", "Bar-ready walkthrough", "u3"],
    ["11:00", "Delegates arrive — welcome drinks", "u5"], ["13:30", "Lunch service, bars on low pour", "u5"],
    ["18:00", "Evening networking — full bar", "u5"], ["21:30", "Last call", "u5"],
    ["22:00", "Closing stock count & breakage log", "u7"], ["23:00", "Load-out", "u9"],
  ];
  for (let i = 0; i < RUNSHEET_ITEMS.length; i++) {
    const [time, text, owner] = RUNSHEET_ITEMS[i];
    await db.runsheetItem.create({ data: { runsheetId: runsheet.id, scheduledTime: time, text, ownerId: userByKey[owner].id, sortOrder: i } });
  }
  await db.eventDayIncident.create({
    data: { projectId: projectByKey.p7.id, severity: "MEDIUM", text: "Generator backup not yet confirmed by venue.", reportedById: userByKey.u2.id },
  });

  // --- freelancers / leaves -------------------------------------------------
  const FREELANCERS = [
    { name: "Rohan Singh", city: "Dehradun", cert: "2027-02-14", rate: 3500, events: 41, rating: 4.8, free: false },
    { name: "Imran Sheikh", city: "Dehradun", cert: "2026-10-20", rate: 3200, events: 33, rating: 4.6, free: false },
    { name: "Tenzin Dorje", city: "Chennai", cert: "2027-06-01", rate: 4000, events: 28, rating: 4.9, free: true },
    { name: "Aditi Rao", city: "Mumbai", cert: "2026-09-30", rate: 4200, events: 52, rating: 4.7, free: true },
    { name: "Mohit Saini", city: "Jaipur", cert: "2027-01-09", rate: 3000, events: 64, rating: 4.5, free: true },
    { name: "Joel Fernandes", city: "Goa", cert: "2026-11-02", rate: 3300, events: 37, rating: 4.6, free: true },
    { name: "Sana Mirza", city: "Delhi", cert: "2027-04-22", rate: 3800, events: 45, rating: 4.8, free: true },
    { name: "Vivek Tanwar", city: "Jaipur", cert: "2026-09-25", rate: 2800, events: 19, rating: 4.2, free: true },
  ];
  for (const f of FREELANCERS) {
    await db.freelancer.create({
      data: { workspaceId: workspace.id, name: f.name, cityId: cityByKey[f.city].id, certExpiresAt: new Date(f.cert), dayRate: f.rate, eventsCount: f.events, rating: f.rating, isAvailable: f.free },
    });
  }
  const LEAVES: Array<[string, string, string, "CASUAL" | "EARNED", "PENDING" | "APPROVED", string]> = [
    ["u7", "2026-09-21", "2026-09-21", "CASUAL", "PENDING", "Personal work"],
    ["u6", "2026-09-29", "2026-10-03", "EARNED", "PENDING", "Family wedding"],
    ["u10", "2026-10-12", "2026-10-13", "CASUAL", "PENDING", ""],
    ["u14", "2026-09-08", "2026-09-12", "EARNED", "APPROVED", "Off-season break"],
  ];
  for (const [who, from, to, type, status, note] of LEAVES) {
    await db.leave.create({ data: { userId: userByKey[who].id, fromDate: new Date(from), toDate: new Date(to), type, status, note: note || null } });
  }

  console.log("Seed complete:", {
    workspace: workspace.name,
    cities: CITIES.length,
    users: TEAM.length,
    clients: CLIENTS.length,
    vendors: VENDORS.length,
    projects: PROJECTS.length,
    tasks: TASKS.length,
    inventoryItems: INV_ITEMS.length,
    invoices: INVOICES.length,
    flowTemplates: FLOW_TEMPLATES.length,
  });
  console.log(`\nAll seeded users share the dev-only password: ${DEV_PASSWORD}`);
  console.log("e.g. anant.sharma@ammbrands.in / " + DEV_PASSWORD + " (Founder, all-city access)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });

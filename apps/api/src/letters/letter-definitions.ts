/**
 * The letters and agreements Podium can generate. Each entry names the
 * template in ./templates and the fields a person fills in; everything else
 * in the document (letterhead, clauses, signatory) comes from AMM's own Word
 * files — see scripts/build-letter-templates.cjs.
 */
export type FieldType = "text" | "textarea" | "date" | "number" | "select" | "list" | "table";

export interface LetterField {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  placeholder?: string;
  /** Prefilled value (list defaults are the items AMM's own document carries). */
  default?: string | number | string[];
  /** For type "table": one row per item. */
  columns?: Array<{ name: string; label: string; placeholder?: string }>;
  hint?: string;
}

export interface LetterDefinition {
  key: string;
  title: string;
  category: "HR" | "Client" | "Freelancer";
  description: string;
  /** Stored in Documents under this type when saved. */
  documentType: "CONTRACT" | "OTHER";
  /** The field whose value names the person/client — used in the file name and the audit trail. */
  subjectField: string;
  fields: LetterField[];
}

const DATE = (label = "Letter date"): LetterField => ({ name: "date", label, type: "date", required: true, default: "today" });
const SALUTATION = (options = ["Ms.", "Mr."]): LetterField => ({ name: "salutation", label: "Title", type: "select", required: true, options, default: options[0] });

export const LETTERS: LetterDefinition[] = [
  {
    key: "offer-letter",
    title: "Offer Letter",
    category: "HR",
    description: "Offers a candidate a position — designation, joining date, pay breakdown and terms — signed by Archit Singhal.",
    documentType: "OTHER",
    subjectField: "candidateName",
    fields: [
      DATE(),
      { name: "candidateName", label: "Candidate name", type: "text", required: true },
      { name: "address", label: "Candidate address", type: "textarea", required: true },
      { name: "designation", label: "Designation", type: "text", required: true, placeholder: "Bar Operations Executive" },
      { name: "joiningDate", label: "Joining date", type: "date", required: true },
      {
        name: "joiningDocuments",
        label: "Documents to bring on joining",
        type: "list",
        required: true,
        default: [
          "Updated CV / Resume",
          "3 passport-size photographs",
          "Government-issued ID proof (Aadhaar / PAN / Passport)",
          "Educational documents and certificates",
          "Bank passbook copy or cancelled cheque",
          "A signed copy of this Offer Letter",
          "Experience and relieving letters from previous employment, if any",
          "Bartending academy certificate, if any",
        ],
        hint: "One document per line. Edit for this candidate if needed.",
      },
      // BASIC + H.R.A is what section 3 prints as the monthly figure, so the
      // annexure and the body can never disagree.
      { name: "basic", label: "Basic (monthly, INR)", type: "number", required: true, placeholder: "18000", hint: "Goes into Annexure I." },
      { name: "hra", label: "H.R.A (monthly, INR)", type: "number", required: true, placeholder: "4500", hint: "Basic + H.R.A is the monthly figure printed in section 3." },
      { name: "incentive", label: "Incentive per event", type: "text", required: true, default: "INR 1,500" },
      { name: "incentiveAfterEvents", label: "Incentive starts after", type: "text", required: true, default: "15" },
      { name: "insuranceCover", label: "Medical insurance cover", type: "text", required: true, default: "INR 10 Lakhs" },
      { name: "workingDays", label: "Working days", type: "text", required: true, default: "Monday to Saturday" },
      { name: "workingHours", label: "Working hours", type: "text", required: true, default: "10:30 AM to 6:30 PM" },
      { name: "probation", label: "Probationary period", type: "text", required: true, default: "one month" },
      { name: "noticePeriod", label: "Notice period", type: "text", required: true, default: "one month" },
      { name: "abscondingDays", label: "Absence treated as absconding", type: "text", required: true, default: "seven consecutive days" },
      { name: "acceptBy", label: "Sign and return by", type: "date", required: true, hint: "Within 3 working days of issue." },
      { name: "otherTerms", label: "Other compensation terms (optional)", type: "list", hint: "Added to section 3 — one term per line." },
    ],
  },
  {
    key: "joining-letter",
    title: "Joining Letter",
    category: "HR",
    description: "Confirms a new employee's joining — designation, department, location and reporting manager.",
    documentType: "OTHER",
    subjectField: "employeeName",
    fields: [
      DATE(),
      { name: "employeeName", label: "Employee name", type: "text", required: true },
      { name: "address", label: "Employee address", type: "textarea", required: true },
      { name: "designation", label: "Designation", type: "text", required: true, placeholder: "Marketing Executive" },
      { name: "department", label: "Department", type: "text", required: true, placeholder: "Marketing Department" },
      { name: "joiningDate", label: "Joining date", type: "date", required: true },
      { name: "location", label: "Work location", type: "text", required: true, placeholder: "H-12-B Green Park, New Delhi" },
      { name: "reportingManager", label: "Reporting manager", type: "text", required: true },
    ],
  },
  {
    key: "experience-letter",
    title: "Experience Letter",
    category: "HR",
    description: "Certifies an employee's tenure, designation and responsibilities.",
    documentType: "OTHER",
    subjectField: "employeeName",
    fields: [
      DATE(),
      SALUTATION(),
      { name: "employeeName", label: "Employee name", type: "text", required: true },
      { name: "designation", label: "Designation", type: "text", required: true, placeholder: "Social Media Manager" },
      { name: "fromDate", label: "Employed from", type: "date", required: true },
      { name: "toDate", label: "Employed until", type: "date", required: true },
      {
        name: "responsibilities",
        label: "Responsibilities",
        type: "list",
        required: true,
        hint: "One line per responsibility — each becomes a bullet.",
        placeholder: "Managing the company's social media platforms…",
      },
    ],
  },
  {
    key: "relieving-letter",
    title: "Relieving Letter",
    category: "HR",
    description: "Relieves an employee from service and restates their continuing obligations.",
    documentType: "OTHER",
    subjectField: "employeeName",
    fields: [
      DATE(),
      SALUTATION(),
      { name: "employeeName", label: "Employee name", type: "text", required: true },
      { name: "address", label: "Employee address", type: "textarea", required: true },
      { name: "joiningDate", label: "Joined on", type: "date", required: true },
      { name: "lastWorkingDate", label: "Last working day", type: "date", required: true },
      { name: "agreementDate", label: "Employment agreement dated", type: "date", required: true },
    ],
  },
  {
    key: "exit-undertaking",
    title: "Exit Undertaking",
    category: "HR",
    description: "Confidentiality and non-solicitation undertaking signed by a departing employee.",
    documentType: "CONTRACT",
    subjectField: "employeeName",
    fields: [
      DATE(),
      { name: "employeeName", label: "Employee name", type: "text", required: true },
      { name: "companyRepName", label: "Signing for AMM — name", type: "text", hint: "Leave blank to sign by hand." },
      { name: "companyRepDesignation", label: "Signing for AMM — designation", type: "text" },
      { name: "companyRepDate", label: "Signing for AMM — date", type: "date" },
    ],
  },
  {
    key: "asset-agreement",
    title: "Asset Issuance Agreement",
    category: "HR",
    description: "Records the company assets issued to an employee and their responsibility for them.",
    documentType: "CONTRACT",
    subjectField: "employeeName",
    fields: [
      DATE("Agreement date"),
      { name: "employeeName", label: "Employee name", type: "text", required: true },
      { name: "designation", label: "Designation", type: "text", required: true },
      { name: "contract", label: "Contract", type: "text", placeholder: "Full-time", hint: "Employment type or contract reference." },
      {
        name: "assets",
        label: "Assets issued",
        type: "table",
        required: true,
        columns: [
          { name: "assetType", label: "Asset type", placeholder: "Laptop" },
          { name: "brandModel", label: "Brand / model", placeholder: "Dell Latitude 5440" },
          { name: "serialNo", label: "Serial no.", placeholder: "5CD1234XYZ" },
          { name: "condition", label: "Condition", placeholder: "Good" },
        ],
      },
    ],
  },
  {
    key: "freelance-agreement",
    title: "Freelance Bartending Agreement",
    category: "Freelancer",
    description: "Engages a freelance bartender for a period, with the shift payout chart.",
    documentType: "CONTRACT",
    subjectField: "freelancerName",
    fields: [
      DATE("Agreement date"),
      { name: "freelancerName", label: "Freelancer name", type: "text", required: true },
      { name: "freelancerAddress", label: "Freelancer address", type: "textarea", required: true },
      { name: "periodFrom", label: "Engagement from", type: "date", required: true },
      { name: "periodTo", label: "Engagement until", type: "date", required: true },
      { name: "lunchDelhi", label: "Lunch shift — Delhi NCR (₹)", type: "number", required: true, default: 1200 },
      { name: "lunchOutside", label: "Lunch shift — outside Delhi NCR (₹)", type: "number", required: true, default: 1500 },
      { name: "dinnerDelhi", label: "Dinner shift — Delhi NCR (₹)", type: "number", required: true, default: 1200 },
      { name: "dinnerOutside", label: "Dinner shift — outside Delhi NCR (₹)", type: "number", required: true, default: 1500 },
    ],
  },
  {
    key: "engagement-letter",
    title: "Client Engagement Letter",
    category: "Client",
    description: "Wedding bar-services proposal: event details, manpower, deliverables, exclusions and fees.",
    documentType: "CONTRACT",
    subjectField: "clientName",
    fields: [
      DATE(),
      SALUTATION(["Mr.", "Ms.", "Mrs."]),
      { name: "clientName", label: "Client name", type: "text", required: true },
      { name: "clientPhone", label: "Contact number", type: "text", required: true },
      { name: "clientEmail", label: "E-mail", type: "text", required: true },
      { name: "clientAddress", label: "Address", type: "textarea", required: true },
      { name: "weddingDate", label: "Wedding date", type: "date", required: true },
      { name: "weddingLocation", label: "Wedding location", type: "text", required: true },
      { name: "pax", label: "No. of guests (pax)", type: "number", required: true },
      {
        name: "manpower",
        label: "Manpower",
        type: "list",
        required: true,
        default: ["1 Bar Manager", "8 Senior Bar Experts", "4 Butler", "1 Helper"],
      },
      {
        name: "deliverables",
        label: "Common deliverables",
        type: "list",
        required: true,
        default: [
          "Simple and Exotics Garnishes",
          "Premium and In House Syrups",
          "Customized Menu designed from Scratch (4 Bar Concept)",
          "All Classy Bar Props according to Theme",
          "Fresh lime juice and fancy Garnishes and condiments",
          "Liquor management",
          "Customized uniform according to Theme",
          "Travel included",
          "Fancy glassware as per menu",
        ],
      },
      {
        name: "exclusions",
        label: "Exclusions",
        type: "list",
        required: true,
        default: ["Premium glassware package, beverage ice to be provided by the Venue", "Façade by decorator", "Liquor by Client"],
      },
      { name: "totalFees", label: "Total fees (₹, before taxes)", type: "number", required: true },
    ],
  },
];

export const LETTERS_BY_KEY = new Map(LETTERS.map((l) => [l.key, l]));

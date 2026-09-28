import { amountInWords } from "../invoices/amount-in-words";
import { LETTER_CONTENT, type Block } from "./letter-content";
import type { LetterDefinition, LetterField } from "./letter-definitions";
import { renderLetterPdf } from "./letter-pdf";

export type LetterValues = Record<string, unknown>;

export class LetterValidationError extends Error {
  constructor(public readonly errors: Record<string, string>) {
    super(Object.values(errors).join(" "));
  }
}

const MAX_TEXT = 2000;
const MAX_ITEMS = 50;
/** What an optional field prints as when left empty — a line to sign on, not a blank gap. */
const BLANK_LINE = "____________________";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

function validDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Cleans and checks what the form sent. Unknown keys are dropped, never passed to the template. */
export function validateLetterValues(def: LetterDefinition, raw: LetterValues): LetterValues {
  const errors: Record<string, string> = {};
  const out: LetterValues = {};

  for (const f of def.fields) {
    const v = raw?.[f.name];
    switch (f.type) {
      case "list": {
        const items = (Array.isArray(v) ? v : []).map(str).filter(Boolean);
        if (f.required && items.length === 0) errors[f.name] = `${f.label}: add at least one item.`;
        if (items.length > MAX_ITEMS) errors[f.name] = `${f.label}: at most ${MAX_ITEMS} items.`;
        if (items.some((i) => i.length > MAX_TEXT)) errors[f.name] = `${f.label}: an item is too long.`;
        out[f.name] = items;
        break;
      }
      case "table": {
        const cols = f.columns ?? [];
        const rows = (Array.isArray(v) ? v : [])
          .map((r) => Object.fromEntries(cols.map((c) => [c.name, str((r as Record<string, unknown>)?.[c.name])])))
          .filter((r) => Object.values(r).some(Boolean));
        if (f.required && rows.length === 0) errors[f.name] = `${f.label}: add at least one row.`;
        if (rows.length > MAX_ITEMS) errors[f.name] = `${f.label}: at most ${MAX_ITEMS} rows.`;
        out[f.name] = rows;
        break;
      }
      case "number": {
        const s = str(v);
        const n = Number(s);
        if (!s) {
          if (f.required) errors[f.name] = `${f.label} is required.`;
        } else if (!Number.isFinite(n) || n < 0) errors[f.name] = `${f.label} must be a number of 0 or more.`;
        else out[f.name] = n;
        break;
      }
      case "date": {
        const s = str(v);
        if (!s) {
          if (f.required) errors[f.name] = `${f.label} is required.`;
        } else if (!validDate(s)) errors[f.name] = `${f.label} is not a valid date.`;
        else out[f.name] = s;
        break;
      }
      case "select": {
        const s = str(v);
        if (!s && f.required) errors[f.name] = `${f.label} is required.`;
        else if (s && !(f.options ?? []).includes(s)) errors[f.name] = `${f.label} must be one of ${(f.options ?? []).join(", ")}.`;
        else out[f.name] = s;
        break;
      }
      default: {
        const s = str(v);
        if (!s && f.required) errors[f.name] = `${f.label} is required.`;
        else if (s.length > MAX_TEXT) errors[f.name] = `${f.label} is too long.`;
        out[f.name] = s;
      }
    }
  }

  // Date ranges must run forwards.
  for (const [from, to] of [["fromDate", "toDate"], ["joiningDate", "lastWorkingDate"], ["periodFrom", "periodTo"]]) {
    const a = out[from];
    const b = out[to];
    if (typeof a === "string" && typeof b === "string" && a > b) errors[to] = "The end date is before the start date.";
  }

  if (Object.keys(errors).length) throw new LetterValidationError(errors);
  return out;
}

export function formatLetterDate(isoDay: string): string {
  return new Date(`${isoDay}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

const INR = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

const PRONOUNS: Record<string, { subject: string; possessive: string; object: string }> = {
  "Mr.": { subject: "he", possessive: "his", object: "him" },
  "Ms.": { subject: "she", possessive: "her", object: "her" },
  "Mrs.": { subject: "she", possessive: "her", object: "her" },
};

/** Turns validated form values into the exact strings the template prints. */
export function buildLetterData(def: LetterDefinition, values: LetterValues): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const byName = new Map<string, LetterField>(def.fields.map((f) => [f.name, f]));

  for (const [name, f] of byName) {
    const v = values[name];
    if (f.type === "date") data[name] = typeof v === "string" && v ? formatLetterDate(v) : BLANK_LINE;
    else if (f.type === "number") data[name] = typeof v === "number" ? INR.format(v) : BLANK_LINE;
    else if (f.type === "list" || f.type === "table") data[name] = v ?? [];
    else data[name] = typeof v === "string" && v ? v : BLANK_LINE;
  }

  const salutation = typeof values.salutation === "string" ? values.salutation : null;
  if (salutation) {
    const p = PRONOUNS[salutation] ?? PRONOUNS["Ms."]!;
    data.pronounSubject = p.subject;
    data.pronounSubjectCap = p.subject[0]!.toUpperCase() + p.subject.slice(1);
    data.pronounPossessive = p.possessive;
    data.pronounObject = p.object;
    data.dearTitle = salutation === "Mr." ? "Sir" : "Madam";
  }
  if (typeof values.designation === "string" && values.designation) {
    data.designationWithArticle = `${/^[aeiou]/i.test(values.designation) ? "an" : "a"} ${values.designation}`;
  }
  if (typeof values.totalFees === "number") data.totalFeesInWords = amountInWords(values.totalFees);
  if (typeof values.ctc === "number") data.ctcInWords = amountInWords(values.ctc);
  return data;
}

/** The laid-out content of a letter, before drawing — what tests assert against. */
export function buildLetterBlocks(def: LetterDefinition, values: LetterValues): Block[] {
  const content = LETTER_CONTENT[def.key];
  if (!content) throw new Error(`no content defined for letter "${def.key}"`);
  return content(buildLetterData(def, values));
}

export function renderLetter(def: LetterDefinition, values: LetterValues): Promise<Buffer> {
  return renderLetterPdf(def.title, buildLetterBlocks(def, values));
}

export function letterFileName(def: LetterDefinition, values: LetterValues): string {
  const subject = typeof values[def.subjectField] === "string" ? (values[def.subjectField] as string) : "";
  const safe = `${def.title}${subject ? ` - ${subject}` : ""}`.replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return `${safe}.pdf`;
}

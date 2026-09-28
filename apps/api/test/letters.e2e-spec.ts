import { blocksText } from "../src/letters/letter-content";
import { LETTERS, LETTERS_BY_KEY } from "../src/letters/letter-definitions";
import { pdfSafe } from "../src/letters/letter-pdf";
import {
  buildLetterBlocks,
  buildLetterData,
  LetterValidationError,
  letterFileName,
  renderLetter,
  validateLetterValues,
  type LetterValues,
} from "../src/letters/letter-render";

// Pure rendering — no database. Named .e2e-spec only because that is the suite's testRegex.

/** Minimal valid values for any definition, so every template gets rendered. */
function sampleValues(key: string): LetterValues {
  const def = LETTERS_BY_KEY.get(key)!;
  const v: LetterValues = {};
  for (const f of def.fields) {
    if (f.type === "date") v[f.name] = "2026-09-19";
    else if (f.type === "number") v[f.name] = 1500;
    else if (f.type === "select") v[f.name] = f.options![0];
    else if (f.type === "list") v[f.name] = ["First item", "Second item"];
    else if (f.type === "table") v[f.name] = [Object.fromEntries(f.columns!.map((c) => [c.name, `${c.label} 1`]))];
    else v[f.name] = `Sample ${f.label}`;
  }
  // Ranges must run forwards.
  for (const [from, to] of [["fromDate", "toDate"], ["joiningDate", "lastWorkingDate"], ["periodFrom", "periodTo"]]) {
    if (from in v) v[from] = "2026-01-01";
    if (to in v) v[to] = "2026-12-31";
  }
  return v;
}

const pageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
const textOf = (key: string, values: LetterValues) => {
  const def = LETTERS_BY_KEY.get(key)!;
  return blocksText(buildLetterBlocks(def, validateLetterValues(def, values)));
};

describe("letter PDFs", () => {
  it.each(LETTERS.map((l) => l.key))("%s renders a PDF with every value filled in", async (key) => {
    const def = LETTERS_BY_KEY.get(key)!;
    const values = validateLetterValues(def, sampleValues(key));
    const pdf = await renderLetter(def, values);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(1);

    const text = blocksText(buildLetterBlocks(def, values));
    expect(text).toContain(String(sampleValues(key)[def.subjectField]));
    expect(text).not.toMatch(/undefined|\[object Object\]|\{[a-zA-Z]+\}/);
  });

  it("flows a long agreement across pages instead of cutting it off", async () => {
    const def = LETTERS_BY_KEY.get("freelance-agreement")!;
    const pdf = await renderLetter(def, validateLetterValues(def, sampleValues("freelance-agreement")));
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(3);
  });

  it("repeats list items however many there are", () => {
    const text = textOf("experience-letter", { ...sampleValues("experience-letter"), responsibilities: ["Duty A", "Duty B", "Duty C", "Duty D"] });
    for (const d of ["Duty A", "Duty B", "Duty C", "Duty D"]) expect(text).toContain(d);
  });

  it("puts every issued asset in the table", () => {
    const text = textOf("asset-agreement", {
      ...sampleValues("asset-agreement"),
      assets: [
        { assetType: "Laptop", brandModel: "Dell", serialNo: "S1", condition: "New" },
        { assetType: "Phone", brandModel: "Apple", serialNo: "S2", condition: "Good" },
      ],
    });
    expect(text).toContain("Laptop | Dell | S1 | New");
    expect(text).toContain("Phone | Apple | S2 | Good");
  });

  it("prints the freelance payout chart with the rates entered", () => {
    const text = textOf("freelance-agreement", { ...sampleValues("freelance-agreement"), dinnerDelhi: 1300, dinnerOutside: 1600 });
    expect(text).toContain("DINNER SHIFT (8-10 HOUR) | INR 1,300 | INR 1,600");
  });

  it("never lets the PDF font print junk: the rupee sign becomes INR, unsupported script becomes ?", () => {
    expect(pdfSafe("Fee ₹2,85,000")).toBe("Fee INR 2,85,000");
    expect(pdfSafe("नमस्ते Riya")).toBe("?????? Riya");
    expect(pdfSafe("“Façade” – ok")).toBe("“Façade” – ok");
  });
});

describe("letter wording", () => {
  it("uses he/his/him for Mr. and she/her for Ms.", () => {
    const def = LETTERS_BY_KEY.get("experience-letter")!;
    const mr = buildLetterData(def, validateLetterValues(def, { ...sampleValues("experience-letter"), salutation: "Mr." }));
    const ms = buildLetterData(def, validateLetterValues(def, { ...sampleValues("experience-letter"), salutation: "Ms." }));
    expect([mr.pronounSubject, mr.pronounPossessive, mr.pronounObject]).toEqual(["he", "his", "him"]);
    expect([ms.pronounSubject, ms.pronounPossessive, ms.pronounObject]).toEqual(["she", "her", "her"]);
  });

  it("picks a/an for the designation", () => {
    const def = LETTERS_BY_KEY.get("experience-letter")!;
    const an = buildLetterData(def, validateLetterValues(def, { ...sampleValues("experience-letter"), designation: "Operations Manager" }));
    const a = buildLetterData(def, validateLetterValues(def, { ...sampleValues("experience-letter"), designation: "Graphic Designer" }));
    expect(an.designationWithArticle).toBe("an Operations Manager");
    expect(a.designationWithArticle).toBe("a Graphic Designer");
  });

  it("writes the engagement fee in Indian figures and in words, and addresses Mrs. as Madam", () => {
    const def = LETTERS_BY_KEY.get("engagement-letter")!;
    const d = buildLetterData(def, validateLetterValues(def, { ...sampleValues("engagement-letter"), salutation: "Mrs.", totalFees: 285000 }));
    expect(d.totalFees).toBe("2,85,000");
    expect(d.totalFeesInWords).toBe("Rupees Two Lakh Eighty Five Thousand Only");
    expect(d.dearTitle).toBe("Madam");
  });

  it("formats dates as 19 September 2026", () => {
    const def = LETTERS_BY_KEY.get("joining-letter")!;
    const d = buildLetterData(def, validateLetterValues(def, sampleValues("joining-letter")));
    expect(d.date).toBe("19 September 2026");
  });

  it("prints a signing line for an optional field left empty", () => {
    const def = LETTERS_BY_KEY.get("exit-undertaking")!;
    const d = buildLetterData(def, validateLetterValues(def, { date: "2026-09-19", employeeName: "A Person" }));
    expect(d.companyRepName).toMatch(/^_+$/);
  });

  it("names the file after the letter and the person", () => {
    const def = LETTERS_BY_KEY.get("relieving-letter")!;
    expect(letterFileName(def, { employeeName: "Kumkum Verma" })).toBe("Relieving Letter - Kumkum Verma.pdf");
    expect(letterFileName(def, { employeeName: 'a/b:c*"d' })).toBe("Relieving Letter - a b c d.pdf");
  });
});

describe("letter validation", () => {
  const def = LETTERS_BY_KEY.get("experience-letter")!;
  const errorsFor = (values: LetterValues) => {
    try {
      validateLetterValues(def, values);
      return {};
    } catch (e) {
      return (e as LetterValidationError).errors;
    }
  };

  it("requires required fields and at least one list item", () => {
    const errors = errorsFor({ salutation: "Ms." });
    expect(Object.keys(errors)).toEqual(expect.arrayContaining(["employeeName", "designation", "fromDate", "toDate", "responsibilities"]));
  });

  it("rejects a date range that runs backwards", () => {
    expect(errorsFor({ ...sampleValues("experience-letter"), fromDate: "2026-09-01", toDate: "2026-08-01" })).toHaveProperty("toDate");
  });

  it("rejects an impossible date and an unknown option", () => {
    const errors = errorsFor({ ...sampleValues("experience-letter"), date: "2026-02-31", salutation: "Dr." });
    expect(errors).toHaveProperty("date");
    expect(errors).toHaveProperty("salutation");
  });

  it("drops blank list items and ignores keys the letter does not define", () => {
    const out = validateLetterValues(def, { ...sampleValues("experience-letter"), responsibilities: ["  ", "Real duty", ""], injected: "{#evil}" });
    expect(out.responsibilities).toEqual(["Real duty"]);
    expect(out).not.toHaveProperty("injected");
  });
});

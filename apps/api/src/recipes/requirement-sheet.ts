import ExcelJS from "exceljs";

/**
 * The requirement sheet, laid out exactly like AMM's own challan
 * ("Challan YPO DLF Chattarpur 1st aug 2026.xlsx"):
 *
 *   A–E  CHALLAN title, event header, then S.No | Item | out | in | Remaks
 *        with the drinks sections (mixers, syrups, fresh ingredients),
 *        hookah, staffing and the inclusions note
 *   F–J  S.No | ICE | OUT | In | Remaks with the kit sections (ice, bar
 *        equipment, glass, bar furniture)
 *
 * "out" carries what leaves the store; "in" and "Remaks" are deliberately
 * left blank — they are filled in by hand when the kit comes back.
 */

export interface SheetLine {
  name: string;
  /** What goes in the "out" column, already rounded and with its unit. */
  out: string;
}
export interface SheetSection {
  title: string;
  lines: SheetLine[];
}
export interface RequirementSheetInput {
  eventName: string;
  eventDate: string;
  address: string;
  pax: number;
  to: string;
  from: string;
  /** Left column: drinks from Requirements. */
  drinks: SheetSection[];
  /** Right column: ice and kit. */
  kit: SheetSection[];
  hookah: string | null;
  staffing: string | null;
  inclusions: string | null;
}

const INK = "FF1A1A1A";
const HEAD_FILL = "FFEFEBE0";
const SECTION_FILL = "FFF7F3E8";

const thin = { style: "thin" as const, color: { argb: "FFB9B2A6" } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

/** Standard kit, as on AMM's challan; glass and ice scale with the guest count. */
export function standardKit(pax: number): SheetSection[] {
  const per100 = (n: number) => Math.max(1, Math.ceil((n * pax) / 100));
  return [
    {
      title: "ICE",
      lines: [
        { name: "Ice total", out: `${Math.round(pax * 1.5)}–${Math.round(pax * 2)} kg` },
        { name: "Service ice", out: "" },
        { name: "Cocktail shaking ice", out: "" },
        { name: "Backup ice", out: "" },
        { name: "Block Ice", out: "" },
        { name: "Round Ice", out: "" },
      ],
    },
    {
      title: "Bar Equipment",
      lines: [
        { name: "Cocktail shakers", out: "4" },
        { name: "Jiggers", out: "2" },
        { name: "Bar spoons", out: "2" },
        { name: "Strainers", out: "2" },
        { name: "Bottle openers", out: "2" },
        { name: "Wine openers", out: "2" },
        { name: "Ice scoops", out: "2" },
        { name: "Ice buckets", out: "4" },
        { name: "Speed pourers", out: "4" },
        { name: "Cutting boards", out: "1" },
        { name: "Paring knives", out: "1" },
        { name: "Napkins Holder", out: "4" },
        { name: "Garnish Tray", out: "2" },
        { name: "Strow/ Colour Strow", out: "5 pkt" },
        { name: "Wooden Stirer", out: "2 pkt" },
        { name: "Fancy Toothpick", out: "2 pkt" },
        { name: "knife", out: "1" },
        { name: "Trash bins", out: "2" },
        { name: "Cocktail Smoker", out: "0" },
        { name: "Hot Stamp", out: "1" },
        { name: "lemon squizer", out: "1" },
      ],
    },
    {
      title: "Glass",
      lines: [
        { name: "Rocks glasses", out: String(per100(100)) },
        { name: "Highball glasses", out: String(per100(100)) },
        { name: "White Wine Glass", out: String(per100(36)) },
        { name: "Red Wine Glass", out: String(per100(36)) },
        { name: "Champagne flutes", out: String(per100(24)) },
        { name: "Juice Glass", out: "0" },
        { name: "Beer Glass", out: String(per100(48)) },
        { name: "Martini Glass", out: String(per100(24)) },
        { name: "Margerita Glass", out: String(per100(24)) },
        { name: "Shot Glass", out: String(per100(48)) },
        { name: "Tom Collin", out: String(per100(36)) },
        { name: "Fancy Glass", out: String(per100(72)) },
      ],
    },
    {
      title: "Bar Furniture",
      lines: [
        { name: "Main bar counter (16ft)", out: "From Vendor" },
        { name: "Back bar display", out: "From Vendor" },
        { name: "Ice Box", out: "4" },
        { name: "Garnish station", out: "" },
        { name: "Glassware racks", out: "" },
        { name: "CART/TROLLY", out: "1" },
        { name: "Tod Box", out: "2" },
        { name: "Mocktail Dispenser", out: "2" },
        { name: "Glass Wiping machine", out: "1" },
        { name: "Bar Display/Props", out: "All Which We Have" },
        { name: "Uniform", out: "" },
      ],
    },
  ];
}

/** Rows for one column of the challan: section headings, then numbered lines. */
function columnRows(sections: SheetSection[]): Array<{ kind: "section" | "line"; a: string; b: string; c: string }> {
  const rows: Array<{ kind: "section" | "line"; a: string; b: string; c: string }> = [];
  for (const s of sections) {
    if (s.lines.length === 0) continue;
    rows.push({ kind: "section", a: s.title, b: "", c: "" });
    s.lines.forEach((l, i) => rows.push({ kind: "line", a: String(i + 1), b: l.name, c: l.out }));
  }
  return rows;
}

export async function buildRequirementSheet(input: RequirementSheetInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Podium — AMM Brands LLP";
  const ws = wb.addWorksheet("Challan", { pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } } });
  ws.columns = [
    { width: 6 },
    { width: 30 },
    { width: 10 },
    { width: 8 },
    { width: 12 },
    { width: 6 },
    { width: 28 },
    { width: 12 },
    { width: 8 },
    { width: 12 },
  ];

  const cell = (address: string, value: string, opts: { bold?: boolean; fill?: string; align?: "left" | "center"; wrap?: boolean; size?: number } = {}) => {
    const c = ws.getCell(address);
    c.value = value;
    c.font = { name: "Calibri", size: opts.size ?? 10, bold: opts.bold, color: { argb: INK } };
    c.alignment = { vertical: "middle", horizontal: opts.align ?? "left", wrapText: opts.wrap ?? false };
    if (opts.fill) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: opts.fill } };
    c.border = BORDER;
    return c;
  };
  const blank = (address: string) => cell(address, "");
  /**
   * Border-only. Writing a VALUE into a merged cell's neighbours clears the
   * merged text (ExcelJS forwards it to the master cell), so the rest of a
   * merged row is only given its border.
   */
  const edge = (address: string) => {
    ws.getCell(address).border = BORDER;
  };

  // ---- header (left) and the kit table's own header (right)
  ws.mergeCells("A1:E1");
  cell("A1", "CHALLAN", { bold: true, align: "center", size: 14 });
  ["B1", "C1", "D1", "E1"].forEach(edge);
  ["S.No", "ICE", "OUT", "In", "Remaks"].forEach((h, i) => cell(`${"FGHIJ"[i]}1`, h, { bold: true, fill: HEAD_FILL }));

  const headerPairs: Array<[string, string]> = [
    [`EVENT NAME - ${input.eventName}`, `DATE- ${input.eventDate}`],
    [`ADDRESS- ${input.address}`, `PAX- ${input.pax}`],
    [`TO- ${input.to}`, `FROM- ${input.from}`],
  ];
  headerPairs.forEach(([left, right], i) => {
    const r = i + 2;
    ws.mergeCells(`A${r}:B${r}`);
    ws.mergeCells(`C${r}:E${r}`);
    cell(`A${r}`, left, { bold: true });
    edge(`B${r}`);
    cell(`C${r}`, right, { bold: true });
    edge(`D${r}`);
    edge(`E${r}`);
  });

  ["S.No", "Item", "out", "in", "Remaks"].forEach((h, i) => cell(`${"ABCDE"[i]}5`, h, { bold: true, fill: HEAD_FILL }));

  // ---- the two columns, written side by side
  const left = columnRows(input.drinks);
  const right = columnRows(input.kit);
  const leftTop = 6; // first row under the left table's header
  const rightTop = 2; // first row under the right table's header

  const write = (rows: ReturnType<typeof columnRows>, top: number, cols: string) => {
    let r = top;
    for (const row of rows) {
      if (row.kind === "section") {
        ws.mergeCells(`${cols[0]}${r}:${cols[4]}${r}`);
        cell(`${cols[0]}${r}`, row.a.toUpperCase(), { bold: true, fill: SECTION_FILL });
        for (const c of cols.slice(1)) edge(`${c}${r}`);
      } else {
        cell(`${cols[0]}${r}`, row.a, { align: "center" });
        cell(`${cols[1]}${r}`, row.b, { wrap: true });
        cell(`${cols[2]}${r}`, row.c, { align: "center" });
        blank(`${cols[3]}${r}`);
        blank(`${cols[4]}${r}`);
      }
      r += 1;
    }
    return r;
  };
  const leftEnd = write(left, leftTop, "ABCDE");
  const rightEnd = write(right, rightTop, "FGHIJ");

  // ---- hookah, staffing and the inclusions note. They span the sheet, so
  // they go below BOTH columns — otherwise a long kit list would be covered.
  let r = Math.max(leftEnd, rightEnd) + 1;
  if (input.hookah) {
    ws.mergeCells(`A${r}:E${r}`);
    cell(`A${r}`, `Hookah - ${input.hookah}`, { bold: true });
    ["B", "C", "D", "E"].forEach((c) => edge(`${c}${r}`));
    r += 1;
  }
  if (input.staffing) {
    ws.mergeCells(`A${r}:E${r}`);
    cell(`A${r}`, "Staffing", { bold: true, fill: SECTION_FILL });
    ["B", "C", "D", "E"].forEach((c) => edge(`${c}${r}`));
    r += 1;
    ws.mergeCells(`A${r}:E${r}`);
    const s = cell(`A${r}`, input.staffing, { wrap: true });
    s.alignment = { vertical: "top", horizontal: "left", wrapText: true };
    ws.getRow(r).height = 34;
    ["B", "C", "D", "E"].forEach((c) => edge(`${c}${r}`));
    r += 1;
  }
  if (input.inclusions) {
    ws.mergeCells(`A${r}:J${r}`);
    const note = cell(`A${r}`, input.inclusions, { wrap: true });
    note.alignment = { vertical: "top", horizontal: "left", wrapText: true };
    ws.getRow(r).height = Math.min(160, 16 + Math.ceil(input.inclusions.length / 120) * 14);
    for (const c of "BCDEFGHIJ") edge(`${c}${r}`);
  }

  ws.getRow(1).height = 22;
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

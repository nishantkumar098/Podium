/**
 * Rupees in words, Indian numbering — the "TOTAL AMOUNT PAYABLE — IN WORDS"
 * block on AMM's invoice.
 *
 * Indian grouping is not thousands-based past a point: 6,21,742 reads as six
 * lakh twenty-one thousand seven hundred forty-two, so the usual
 * three-digit-group algorithm gives the wrong answer. This splits crore,
 * lakh, thousand, hundred explicitly instead.
 *
 * In its own module because it is pure arithmetic with a lot of edge cases
 * (the teens, the zero-paise case, the hundred/and rule) and deserves to be
 * unit-tested without constructing a PDF.
 */
const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

/** 0–99. The teens are irregular, so they are a lookup, not a composition. */
function underHundred(n: number): string {
  if (n < 20) return ONES[n]!;
  const tens = TENS[Math.floor(n / 10)]!;
  const ones = ONES[n % 10]!;
  return ones ? `${tens} ${ones}` : tens;
}

/** 0–999. */
function underThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (!hundreds) return underHundred(rest);
  const head = `${ONES[hundreds]} Hundred`;
  return rest ? `${head} ${underHundred(rest)}` : head;
}

/** A whole number of rupees, in Indian units. */
function integerInWords(n: number): string {
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1_000);
  const rest = n % 1_000;

  if (crore) parts.push(`${integerInWords(crore)} Crore`);
  if (lakh) parts.push(`${underHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${underHundred(thousand)} Thousand`);
  if (rest) parts.push(underThousand(rest));
  return parts.join(" ");
}

/**
 * "Rupees Six Lakh Twenty One Thousand Seven Hundred Forty Two Only", matching
 * the wording on AMM's supplied invoice. Paise are included only when
 * non-zero, because the supplied document omits them on a round amount.
 */
export function amountInWords(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.abs(amount) : 0;
  // Round to paise first: 0.005 arriving as 0.00499999 would otherwise drop a
  // paisa between the printed figure and the printed words.
  const paise = Math.round(safe * 100);
  const rupees = Math.floor(paise / 100);
  const fraction = paise % 100;

  const head = `Rupees ${integerInWords(rupees)}`;
  const withPaise = fraction ? `${head} and ${underHundred(fraction)} Paise` : head;
  const signed = amount < 0 ? `Minus ${withPaise}` : withPaise;
  return `${signed} Only`;
}

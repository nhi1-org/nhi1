// Zero personal data (4_ §12 item 2): the shapes of personal data a talk text may not carry. Checked when
// the root takes a talk (err 23) and by the reference skill before it sends one. Shapes, not a judgement:
// a talk that needs to say "write the address here" says it without a real one. Apache-2.0.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// George 11/12: an SSH address "git@host:path" is not an e-mail address
const SSH_GIT = /(?<![A-Za-z0-9._%+-])git@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}:(?=[^\s])/y;
const PHONES: RegExp[] = [
  /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?!\d)/, // international: +886 912 345 678, +1 (415) 555-0100
  /(?<!\d)09\d{2}[-\s]?\d{3}[-\s]?\d{3}(?!\d)/, //                 台灣手機 0912-345-678, 0912345678
  /(?<!\d)\(?0\d{1,2}\)?[-\s]\d{3,4}[-\s]?\d{4}(?!\d)/, //         台灣市話 (02) 2345-6789, 02-23456789
  /(?<![\d.])\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?![\d.])/, //       North America 415-555-0100
];
const SSN = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/; //                    US SSN shape
const TW_ID = /(?<![A-Za-z0-9])([A-Z])([1289])(\d{8})(?![A-Za-z0-9])/g; // 身分證／居留證 (checksum checked)
const LETTER = "ABCDEFGHJKLMNPQRSTUVXYWZIO"; // 10..35 in the national-ID order

function twIdOk(l: string, d1: string, rest: string): boolean {
  const n = LETTER.indexOf(l) + 10;
  const ds = [Math.floor(n / 10), n % 10, Number(d1), ...rest.split("").map(Number)];
  const w = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
  return ds.reduce((s, x, i) => s + x * w[i], 0) % 10 === 0;
}

/** null = no personal-data shape; else which: "email" | "phone" | "national_id" */
export function personalData(text: string): string | null {
  for (const m of text.matchAll(EMAIL)) {
    SSH_GIT.lastIndex = m.index;
    if (!SSH_GIT.test(text)) return "email";
  }
  if (PHONES.some((re) => re.test(text))) return "phone";
  if (SSN.test(text)) return "national_id";
  for (const m of text.matchAll(TW_ID)) if (twIdOk(m[1], m[2], m[3])) return "national_id";
  return null;
}

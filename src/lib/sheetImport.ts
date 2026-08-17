/**
 * The parts every spreadsheet reader in this app needs.
 *
 * There are two readers - expenses and balances - and they face the same awkward
 * input: headings that vary, money typed as "Rs 35,000.00", a Total row under the
 * data, summary blocks under that, and blank rows in the middle. Those rules live
 * here so the two cannot disagree about what a number is or what a total row
 * looks like.
 *
 * What stays with each reader is what only it knows: which columns it needs, and
 * which rows below the data are its own summary blocks.
 */

import { cellText, type Cell } from "./parseTabular";
import { GENERAL_LABEL } from "./labels";

/** How far down a sheet to look for the heading row. */
export const HEADER_SEARCH_ROWS = 30;

export interface SkippedRow {
  row: number;
  /** A short rendering of what was on the row. */
  detail: string;
  reason: string;
}

/** "Amount (LKR):" -> "amount". Units and trailing colons are noise. */
export function heading(cell: Cell): string {
  return cellText(cell)
    .replace(/\s*[([][^)\]]*[)\]]\s*$/, "")
    .replace(/[:*]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Every non-empty heading on a row, normalised. */
export function headings(row: Cell[]): string[] {
  return row.map(heading).filter((t) => t !== "");
}

export function isBlankRow(row: Cell[]): boolean {
  return !row.some((c) => cellText(c) !== "");
}

/** A row that totals the rows above it rather than being an entry of its own. */
export function isTotalLabel(text: string): boolean {
  return /^(sub)?totals?$/i.test(text) || /\b(sub)?total$/i.test(text);
}

export interface AmountRead {
  value: number | null;
  /** Written in brackets, which in a ledger means a credit. */
  bracketed: boolean;
}

/**
 * "Rs35,000.00" | "35 000" | 35000 -> 35000.
 *
 * Brackets are reported rather than stripped: "(500)" is a credit in every
 * ledger, and silently reading it as a cost of 500 would invert the entry.
 */
export function readAmount(cell: Cell): AmountRead {
  if (typeof cell === "number") {
    return { value: Number.isFinite(cell) ? cell : null, bracketed: false };
  }
  const text = cellText(cell);
  if (text === "") return { value: null, bracketed: false };

  const bracketed = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[^\d.-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") {
    return { value: null, bracketed };
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { value: null, bracketed };
  return { value: bracketed ? -Math.abs(n) : n, bracketed };
}

/** The label written where something belongs to no container. */
export function isGeneralLabel(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    t === GENERAL_LABEL ||
    t === "general" ||
    t === "(general)" ||
    t === "general overhead" ||
    t === "overhead" ||
    t === "none" ||
    t === "n/a" ||
    t === "-"
  );
}

/** A short, safe rendering of a row for the "skipped" list. */
export function describe(row: Cell[]): string {
  const text = row
    .map((c) => cellText(c))
    .filter((t) => t !== "")
    .join(" | ");
  return text.length > 70 ? `${text.slice(0, 67)}...` : text;
}

/* ---------------------------- heading vocabulary --------------------------- */

// Matched as whole headings rather than by substring, so that "Expense Amount"
// is read as the amount and not as the name.
export const AMOUNT_HEADINGS = new Set([
  "amount",
  "expense amount",
  "amount spent",
  "value",
  "cost",
  "total",
  "spend",
  "spent",
  "sum",
  "lkr",
  "rs",
  "price",
  "debit",
]);

export const PARTY_HEADINGS = new Set([
  "partner",
  "partner name",
  "party",
  "paid by",
  "paid to",
  "person",
  "member",
  "shareholder",
  "who",
  "supplier",
  "vendor",
  "buyer",
  "customer",
  "name of party",
]);

export const CONTAINER_HEADINGS = new Set([
  "container",
  "container id",
  "container no",
  "container no.",
  "container number",
  "container#",
  "container code",
  "cntr",
  "shipment",
]);

export const ORDER_HEADINGS = new Set([
  "order",
  "order no",
  "order no.",
  "order number",
  "order ref",
  "reference",
  "ref",
  "ref no",
]);

/* ------------------------------- duplicates ------------------------------- */

/**
 * Flag rows that already exist, counting rather than merely matching.
 *
 * If the sheet already holds one 5,000 charge for a party and the file holds two,
 * the second is genuinely new. Treating the keys as a set would hide it.
 *
 * A duplicate is labelled, never refused: two identical entries are perfectly
 * possible, so what to do about it belongs to whoever is looking at the preview.
 */
export function markDuplicatesBy<T>(
  rows: T[],
  existingKeys: string[],
  keyOf: (row: T) => string,
): Array<T & { duplicate: boolean }> {
  const remaining = new Map<string, number>();
  for (const key of existingKeys) {
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return rows.map((row) => {
    const key = keyOf(row);
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      return { ...row, duplicate: true };
    }
    return { ...row, duplicate: false };
  });
}

/** Case and spacing folded, for comparing what people typed. */
export function fold(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

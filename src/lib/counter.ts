/**
 * Counting the bags in a warehouse.
 *
 * This is the one part of the system used standing up. Somebody is on a warehouse
 * floor with a phone in one hand, counting bags of an item and tapping a number
 * up. Everything here is shaped by that:
 *
 *   Every count starts at zero and is tallied up, because that is what counting
 *   is. Pre-filling the expected figure would turn a count into a confirmation,
 *   and a confirmation is what you get when nobody really counted.
 *
 *   A count of zero and a count not yet taken are different facts. "We found
 *   none of these" is a discovery; "we have not got to these yet" is a warning
 *   that the count is unfinished. So a row records whether it was touched.
 *
 *   Items turn up that are not on the list, so they can be added on the floor.
 *   Items on the list may not turn up at all, and the sheet has to say so.
 *
 * The expected figures come from the uploaded buyer list, which lets the count
 * report a difference - the only reason to count in the first place. No price
 * from that list is carried in: a count sheet has no business showing money, and
 * the person counting has no need to see it.
 */

import { readLocal, writeLocal } from "./storage";
import { clampNumber, LIMITS } from "./types";
import { sanitizeLine } from "./buyer";
import { normalizeItemKey } from "./stockpile";

export const COUNT_KEY = "balebook.bagCount.v1";
export const COUNT_VERSION = 1;
/** The same ceiling every other document uses. */
export const MAX_ROWS = LIMITS.rows;

export interface CountRow {
  id: string;
  name: string;
  /**
   * What the list says should be there. Zero for an item added on the floor,
   * which by definition was not expected.
   */
  expected: number;
  /** What was actually found. Starts at zero and is tallied up. */
  counted: number;
  /**
   * True once this row was counted at all.
   *
   * Without it, a row nobody reached looks identical to a row where nothing was
   * found, and a half-finished count reads as a complete one.
   */
  touched: boolean;
  /** Added during the count rather than read off the list. */
  added: boolean;
}

export interface CountDoc {
  app: "balebook-bag-count";
  version: number;
  /**
   * Which container is being counted. Free text, because a warehouse bay is as
   * likely to be called "Back room" as GAOU7441740.
   */
  containerId: string;
  /** The order the list came from, read out of the uploaded file's name. */
  orderNumber: string;
  rows: CountRow[];
  updatedAt: string;
}

export const CONTAINER_LABEL_MAX = 60;

export function emptyCountDoc(): CountDoc {
  return {
    app: "balebook-bag-count",
    version: COUNT_VERSION,
    containerId: "",
    orderNumber: "",
    rows: [],
    updatedAt: new Date().toISOString(),
  };
}

let counter = 0;
function uid(): string {
  counter += 1;
  return `bc${Date.now().toString(36)}${counter}`;
}

/* ------------------------------ construction ------------------------------ */

export function createCountRow(input: {
  name?: unknown;
  expected?: unknown;
  counted?: unknown;
  touched?: unknown;
  added?: unknown;
}): CountRow {
  return {
    id: uid(),
    name: sanitizeLine(input.name, LIMITS.itemName),
    // Bags are whole things.
    expected: Math.floor(clampNumber(input.expected, LIMITS.qty)),
    counted: Math.floor(clampNumber(input.counted, LIMITS.qty)),
    touched: input.touched === true,
    added: input.added === true,
  };
}

/**
 * Start a count from an uploaded list.
 *
 * Only the name and the quantity are taken. The per-bag price and the line total
 * sitting next to them in the file are deliberately dropped here, at the door,
 * rather than carried along and hidden later.
 */
export function fromOrderItems(
  items: Array<{ name: string; qty: number }>,
  containerId = "",
  orderNumber = "",
): CountDoc {
  const doc: CountDoc = {
    ...emptyCountDoc(),
    containerId: sanitizeLine(containerId, CONTAINER_LABEL_MAX),
    orderNumber: sanitizeLine(orderNumber, LIMITS.title),
    rows: [],
  };

  // The same item twice on one list is one thing to count.
  for (const item of items.slice(0, MAX_ROWS)) {
    const row = createCountRow({ name: item.name, expected: item.qty });
    if (row.name === "") continue;
    const existing = doc.rows.find(
      (r) => normalizeItemKey(r.name) === normalizeItemKey(row.name),
    );
    if (existing) existing.expected += row.expected;
    else doc.rows.push(row);
  }
  return doc;
}

/* --------------------------------- derived -------------------------------- */

/** Found less expected. Positive means more than the list said. */
export function difference(row: CountRow): number {
  return row.counted - row.expected;
}

export type CountStatus = "uncounted" | "matched" | "short" | "over";

export function countStatus(row: CountRow): CountStatus {
  if (!row.touched) return "uncounted";
  const diff = difference(row);
  if (diff === 0) return "matched";
  return diff < 0 ? "short" : "over";
}

export interface CountTotals {
  items: number;
  expected: number;
  counted: number;
  /** Counted less expected across everything touched so far. */
  difference: number;
  /** Rows that have been counted, and rows nobody has reached. */
  touched: number;
  untouched: number;
  matched: number;
  short: number;
  over: number;
  /** Items added on the floor that were not on the list. */
  added: number;
  /** How far through the list the count is, 0-100, or null with no rows. */
  progress: number | null;
}

export function countTotals(doc: CountDoc): CountTotals {
  const totals: CountTotals = {
    items: doc.rows.length,
    expected: 0,
    counted: 0,
    difference: 0,
    touched: 0,
    untouched: 0,
    matched: 0,
    short: 0,
    over: 0,
    added: 0,
    progress: null,
  };

  for (const row of doc.rows) {
    totals.expected += row.expected;
    totals.counted += row.counted;
    if (row.added) totals.added += 1;
    if (row.touched) totals.touched += 1;
    else totals.untouched += 1;

    switch (countStatus(row)) {
      case "matched":
        totals.matched += 1;
        break;
      case "short":
        totals.short += 1;
        break;
      case "over":
        totals.over += 1;
        break;
      default:
        break;
    }
  }

  totals.difference = totals.counted - totals.expected;
  totals.progress =
    doc.rows.length === 0
      ? null
      : (totals.touched / doc.rows.length) * 100;
  return totals;
}

/** True when every row has been counted, so the count can be trusted. */
export function isCountComplete(doc: CountDoc): boolean {
  return doc.rows.length > 0 && doc.rows.every((row) => row.touched);
}

/* -------------------------------- searching ------------------------------- */

/**
 * Rows matching what was typed, best first.
 *
 * Ordered so the top hit is the one Enter should tally: an exact name, then a
 * name that starts with the words, then anything containing them. On a warehouse
 * floor the difference between "the right item is first" and "the right item is
 * fourth" is the difference between counting and hunting.
 */
export function searchRows(doc: CountDoc, query: string): CountRow[] {
  const needle = normalizeItemKey(query);
  if (needle === "") return doc.rows;

  const scored: Array<{ row: CountRow; rank: number }> = [];
  for (const row of doc.rows) {
    const key = normalizeItemKey(row.name);
    if (key === needle) scored.push({ row, rank: 0 });
    else if (key.startsWith(needle)) scored.push({ row, rank: 1 });
    else if (key.includes(needle)) scored.push({ row, rank: 2 });
  }
  return scored
    .sort((a, b) => a.rank - b.rank || a.row.name.localeCompare(b.row.name))
    .map((entry) => entry.row);
}

/** The row Enter should tally, or null when the search is ambiguous or empty. */
export function bestMatch(doc: CountDoc, query: string): CountRow | null {
  if (normalizeItemKey(query) === "") return null;
  return searchRows(doc, query)[0] ?? null;
}

/* -------------------------------- counting -------------------------------- */

function touch(doc: CountDoc, patch: Partial<CountDoc>): CountDoc {
  return { ...doc, ...patch, updatedAt: new Date().toISOString() };
}

/**
 * Add to a count, or take away from it.
 *
 * Never goes below zero: you cannot find minus one bag, and a stray tap on the
 * minus button should not invent a number that has to be explained later.
 *
 * Counting down still counts as having counted. Tapping plus then minus leaves a
 * row at zero, and that is a real answer - "I looked, there were none" - not the
 * same as never having looked.
 */
export function addToCount(doc: CountDoc, id: string, by: number): CountDoc {
  const step = Math.floor(Number.isFinite(by) ? by : 0);
  if (step === 0) return doc;
  return touch(doc, {
    rows: doc.rows.map((row) =>
      row.id === id
        ? {
            ...row,
            counted: Math.max(
              0,
              Math.min(LIMITS.qty, Math.floor(row.counted + step)),
            ),
            touched: true,
          }
        : row,
    ),
  });
}

/** Type a figure straight in, for when the number is already known. */
export function setCount(doc: CountDoc, id: string, value: number): CountDoc {
  return touch(doc, {
    rows: doc.rows.map((row) =>
      row.id === id
        ? {
            ...row,
            counted: Math.floor(clampNumber(value, LIMITS.qty)),
            touched: true,
          }
        : row,
    ),
  });
}

/** Put a row back to never-counted, for a tally that went wrong. */
export function clearCount(doc: CountDoc, id: string): CountDoc {
  return touch(doc, {
    rows: doc.rows.map((row) =>
      row.id === id ? { ...row, counted: 0, touched: false } : row,
    ),
  });
}

export interface AddItemResult {
  doc: CountDoc;
  /** The row the name belongs to, whether it was created or already there. */
  row: CountRow | null;
  /** True when the name matched a row that already existed. */
  existed: boolean;
}

/**
 * Add an item found on the floor.
 *
 * A name that already exists is not added twice: two rows for one item would let
 * a count be split across both and quietly under-report. The existing row is
 * handed back instead, so the page can take you straight to it.
 */
export function addItem(doc: CountDoc, name: string): AddItemResult {
  const clean = sanitizeLine(name, LIMITS.itemName);
  if (clean === "") return { doc, row: null, existed: false };

  const key = normalizeItemKey(clean);
  const existing = doc.rows.find((row) => normalizeItemKey(row.name) === key);
  if (existing) return { doc, row: existing, existed: true };

  if (doc.rows.length >= MAX_ROWS) return { doc, row: null, existed: false };

  const row = createCountRow({ name: clean, added: true });
  return {
    doc: touch(doc, { rows: [...doc.rows, row] }),
    row,
    existed: false,
  };
}

export function removeRow(doc: CountDoc, id: string): CountDoc {
  return touch(doc, { rows: doc.rows.filter((row) => row.id !== id) });
}

export function setContainer(doc: CountDoc, containerId: string): CountDoc {
  return touch(doc, {
    containerId: sanitizeLine(containerId, CONTAINER_LABEL_MAX),
  });
}

export function setOrderNumber(doc: CountDoc, orderNumber: string): CountDoc {
  return touch(doc, { orderNumber: sanitizeLine(orderNumber, LIMITS.title) });
}

/** Start the tallies again, keeping the list of items. */
export function resetCounts(doc: CountDoc): CountDoc {
  return touch(doc, {
    rows: doc.rows.map((row) => ({ ...row, counted: 0, touched: false })),
  });
}

/* ------------------------------- persistence ------------------------------ */

export function parseCountDoc(input: unknown): CountDoc {
  const raw = (input ?? {}) as Record<string, unknown>;
  const rawRows = Array.isArray(raw.rows) ? raw.rows : [];

  const rows: CountRow[] = rawRows
    .slice(0, MAX_ROWS)
    .map((entry) => {
      const r = (entry ?? {}) as Record<string, unknown>;
      const built = createCountRow(r);
      return { ...built, id: String(r.id ?? built.id) };
    })
    // A row with no name cannot be counted or reported.
    .filter((row) => row.name !== "");

  return {
    app: "balebook-bag-count",
    version: Number(raw.version) || COUNT_VERSION,
    containerId: sanitizeLine(raw.containerId, CONTAINER_LABEL_MAX),
    orderNumber: sanitizeLine(raw.orderNumber, LIMITS.title),
    rows,
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
  };
}

export function loadCountDoc(): CountDoc {
  if (typeof window === "undefined") return emptyCountDoc();
  try {
    const raw = readLocal(COUNT_KEY);
    if (!raw) return emptyCountDoc();
    return parseCountDoc(JSON.parse(raw));
  } catch {
    return emptyCountDoc();
  }
}

export function saveCountDoc(doc: CountDoc): void {
  writeLocal(COUNT_KEY, JSON.stringify(doc));
}

/** `<Order> - <Container> - Bag Count.xlsx`, with whichever parts are known. */
export function countFilename(doc: CountDoc, ext = "xlsx"): string {
  const clean = (s: string) =>
    s.replace(/[^\w\d\- ]+/g, " ").replace(/\s+/g, " ").trim();
  const parts = [clean(doc.orderNumber), clean(doc.containerId)].filter(
    (part) => part !== "",
  );
  const stem = parts.length > 0 ? parts.join(" - ") : "Warehouse";
  return `${stem} - Bag Count.${ext.replace(/[^\w]+/g, "")}`;
}

/**
 * Working out the markup, item by item.
 *
 * The price list adds one markup to every bag. That is not how the business
 * actually prices: a fast-moving item carries a different markup from something
 * that sits in the warehouse. So this holds a markup per item, starting from one
 * figure applied across the board and then overridden where it needs to be.
 *
 * The markup is the profit. Everything here is arranged around that: the profit a
 * row produces, the profit the whole order produces, and how much of it comes
 * from the items that move.
 *
 * One rule shapes the model. A row remembers whether its markup was set by hand.
 * Changing the figure applied across the board updates the rows that were left
 * alone and leaves the overridden ones exactly as they were - otherwise a change
 * of mind about the base would silently undo an afternoon of per-item work.
 */

import { readLocal, writeLocal } from "./storage";
import { clampNumber, LIMITS } from "./types";
import { sanitizeLine } from "./buyer";

export const CALC_KEY = "balebook.calculation.v1";
export const CALC_VERSION = 1;
/** Enough for any real order; the same ceiling the other documents use. */
export const MAX_ROWS = LIMITS.rows;

export interface CalcRow {
  id: string;
  name: string;
  /** Bags of this item. */
  qty: number;
  /** What a bag costs us. */
  costPerBag: number;
  /** What we add to a bag. This is the profit. */
  markup: number;
  /**
   * True once the markup was set for this row by hand.
   *
   * The point of the flag: it protects the row from a later change to the figure
   * applied across the board.
   */
  overridden: boolean;
  /** Marked as fast moving, which is usually why a markup differs. */
  fast: boolean;
}

export interface CalcDoc {
  app: "balebook-calculation";
  version: number;
  /** Which order this is, read from the uploaded file's name. */
  orderNumber: string;
  /** The markup applied to every bag that has not been given its own. */
  baseMarkup: number;
  rows: CalcRow[];
  updatedAt: string;
}

export const DEFAULT_MARKUP = 2000;

export function emptyCalcDoc(): CalcDoc {
  return {
    app: "balebook-calculation",
    version: CALC_VERSION,
    orderNumber: "",
    baseMarkup: DEFAULT_MARKUP,
    rows: [],
    updatedAt: new Date().toISOString(),
  };
}

let counter = 0;
function uid(): string {
  counter += 1;
  return `cr${Date.now().toString(36)}${counter}`;
}

/* ------------------------------ construction ------------------------------ */

export function createCalcRow(input: {
  name?: unknown;
  qty?: unknown;
  costPerBag?: unknown;
  markup?: unknown;
  overridden?: unknown;
  fast?: unknown;
}): CalcRow {
  return {
    id: uid(),
    name: sanitizeLine(input.name, LIMITS.itemName),
    // Bags are whole things.
    qty: Math.floor(clampNumber(input.qty, LIMITS.qty)),
    costPerBag: clampNumber(input.costPerBag, LIMITS.money),
    markup: clampNumber(input.markup, LIMITS.markup),
    overridden: input.overridden === true,
    fast: input.fast === true,
  };
}

/**
 * Start a calculation from an uploaded order.
 *
 * Every row begins on the base markup and untouched, so the first thing shown is
 * the same answer the price list would give. The work starts from there.
 */
export function fromOrderItems(
  items: Array<{ name: string; qty: number; perBag: number }>,
  baseMarkup: number,
  orderNumber = "",
): CalcDoc {
  const base = clampNumber(baseMarkup, LIMITS.markup);
  return {
    ...emptyCalcDoc(),
    orderNumber: sanitizeLine(orderNumber, LIMITS.title),
    baseMarkup: base,
    rows: items
      .slice(0, MAX_ROWS)
      .map((item) =>
        createCalcRow({
          name: item.name,
          qty: item.qty,
          costPerBag: item.perBag,
          markup: base,
        }),
      )
      // A line with no name is not an item, and one with no bags prices nothing.
      .filter((row) => row.name !== "" && row.qty > 0),
  };
}

/* --------------------------------- derived -------------------------------- */

/** What a bag of this item sells for. */
export function sellingPerBag(row: CalcRow): number {
  return row.costPerBag + row.markup;
}

/** What this line costs us. */
export function lineCost(row: CalcRow): number {
  return row.qty * row.costPerBag;
}

/** What this line sells for. */
export function lineTotal(row: CalcRow): number {
  return row.qty * sellingPerBag(row);
}

/** What this line earns. The markup, times the bags. */
export function lineProfit(row: CalcRow): number {
  return row.qty * row.markup;
}

export interface CalcTotals {
  items: number;
  bags: number;
  cost: number;
  /** The whole markup: the profit on the order. */
  profit: number;
  selling: number;
  /** Markup per bag across the order, or null with no bags. */
  averageMarkup: number | null;
  /** Profit as a percentage of what it sells for, or null with nothing to sell. */
  margin: number | null;
  /** Split by how the item moves, since that is what a markup follows. */
  fastBags: number;
  fastProfit: number;
  normalBags: number;
  normalProfit: number;
  /** Rows whose markup was set by hand. */
  overridden: number;
}

export function calcTotals(doc: CalcDoc): CalcTotals {
  const totals: CalcTotals = {
    items: doc.rows.length,
    bags: 0,
    cost: 0,
    profit: 0,
    selling: 0,
    averageMarkup: null,
    margin: null,
    fastBags: 0,
    fastProfit: 0,
    normalBags: 0,
    normalProfit: 0,
    overridden: 0,
  };

  for (const row of doc.rows) {
    totals.bags += row.qty;
    totals.cost += lineCost(row);
    totals.profit += lineProfit(row);
    totals.selling += lineTotal(row);
    if (row.overridden) totals.overridden += 1;
    if (row.fast) {
      totals.fastBags += row.qty;
      totals.fastProfit += lineProfit(row);
    } else {
      totals.normalBags += row.qty;
      totals.normalProfit += lineProfit(row);
    }
  }

  totals.averageMarkup = totals.bags === 0 ? null : totals.profit / totals.bags;
  totals.margin =
    totals.selling === 0 ? null : (totals.profit / totals.selling) * 100;
  return totals;
}

/* -------------------------------- mutation -------------------------------- */

function touch(doc: CalcDoc, patch: Partial<CalcDoc>): CalcDoc {
  return { ...doc, ...patch, updatedAt: new Date().toISOString() };
}

/**
 * Change the markup applied across the board.
 *
 * Rows that were set by hand keep what they were given. This is the whole reason
 * `overridden` exists: without it, nudging the base figure would quietly wipe
 * every per-item decision already made.
 */
export function setBaseMarkup(doc: CalcDoc, markup: number): CalcDoc {
  const base = clampNumber(markup, LIMITS.markup);
  return touch(doc, {
    baseMarkup: base,
    rows: doc.rows.map((row) => (row.overridden ? row : { ...row, markup: base })),
  });
}

/** Set one row's markup, which marks it as decided by hand. */
export function setRowMarkup(doc: CalcDoc, id: string, markup: number): CalcDoc {
  const value = clampNumber(markup, LIMITS.markup);
  return touch(doc, {
    rows: doc.rows.map((row) =>
      row.id === id ? { ...row, markup: value, overridden: true } : row,
    ),
  });
}

/** Hand a row back to the base markup. */
export function resetRowMarkup(doc: CalcDoc, id: string): CalcDoc {
  return touch(doc, {
    rows: doc.rows.map((row) =>
      row.id === id
        ? { ...row, markup: doc.baseMarkup, overridden: false }
        : row,
    ),
  });
}

/** Give every row the base markup again, overrides included. */
export function resetAllMarkups(doc: CalcDoc): CalcDoc {
  return touch(doc, {
    rows: doc.rows.map((row) => ({
      ...row,
      markup: doc.baseMarkup,
      overridden: false,
    })),
  });
}

export function toggleFast(doc: CalcDoc, id: string): CalcDoc {
  return touch(doc, {
    rows: doc.rows.map((row) =>
      row.id === id ? { ...row, fast: !row.fast } : row,
    ),
  });
}

/**
 * Give every fast-moving row the same markup in one go.
 *
 * The point of marking items in the first place: they are priced as a group, and
 * that group's markup is the one that gets revisited.
 */
export function setFastMarkup(doc: CalcDoc, markup: number): CalcDoc {
  const value = clampNumber(markup, LIMITS.markup);
  return touch(doc, {
    rows: doc.rows.map((row) =>
      row.fast ? { ...row, markup: value, overridden: true } : row,
    ),
  });
}

export function updateCalcRow(
  doc: CalcDoc,
  id: string,
  patch: Partial<Omit<CalcRow, "id">>,
): CalcDoc {
  return touch(doc, {
    rows: doc.rows.map((row) =>
      row.id === id
        ? {
            ...row,
            ...patch,
            name:
              patch.name === undefined
                ? row.name
                : sanitizeLine(patch.name, LIMITS.itemName),
            qty:
              patch.qty === undefined
                ? row.qty
                : Math.floor(clampNumber(patch.qty, LIMITS.qty)),
            costPerBag:
              patch.costPerBag === undefined
                ? row.costPerBag
                : clampNumber(patch.costPerBag, LIMITS.money),
            markup:
              patch.markup === undefined
                ? row.markup
                : clampNumber(patch.markup, LIMITS.markup),
          }
        : row,
    ),
  });
}

export function removeCalcRow(doc: CalcDoc, id: string): CalcDoc {
  return touch(doc, { rows: doc.rows.filter((row) => row.id !== id) });
}

export function setOrderNumber(doc: CalcDoc, orderNumber: string): CalcDoc {
  return touch(doc, { orderNumber: sanitizeLine(orderNumber, LIMITS.title) });
}

/* ------------------------------- persistence ------------------------------ */

export function parseCalcDoc(input: unknown): CalcDoc {
  const raw = (input ?? {}) as Record<string, unknown>;
  const rawRows = Array.isArray(raw.rows) ? raw.rows : [];

  const rows: CalcRow[] = rawRows
    .slice(0, MAX_ROWS)
    .map((entry) => {
      const r = (entry ?? {}) as Record<string, unknown>;
      const built = createCalcRow(r);
      return { ...built, id: String(r.id ?? built.id) };
    })
    .filter((row) => row.name !== "" && row.qty > 0);

  const base = clampNumber(
    raw.baseMarkup === undefined ? DEFAULT_MARKUP : raw.baseMarkup,
    LIMITS.markup,
  );

  return {
    app: "balebook-calculation",
    version: Number(raw.version) || CALC_VERSION,
    orderNumber: sanitizeLine(raw.orderNumber, LIMITS.title),
    baseMarkup: base,
    rows,
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
  };
}

export function loadCalcDoc(): CalcDoc {
  if (typeof window === "undefined") return emptyCalcDoc();
  try {
    const raw = readLocal(CALC_KEY);
    if (!raw) return emptyCalcDoc();
    return parseCalcDoc(JSON.parse(raw));
  } catch {
    return emptyCalcDoc();
  }
}

export function saveCalcDoc(doc: CalcDoc): void {
  writeLocal(CALC_KEY, JSON.stringify(doc));
}

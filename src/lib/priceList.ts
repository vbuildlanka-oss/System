/**
 * The buyer's price list while it is being put together.
 *
 * There are two ways a sheet arrives here, and the difference is the whole reason
 * this file exists:
 *
 *   A supplier order sheet already carries what each bag cost. Nothing needs
 *   deciding; the markup goes on and the buyer's copy is ready.
 *
 *   A warehouse count carries item names and bag counts and no prices at all.
 *   Every cost has to be put in by hand before there is anything to sell.
 *
 * So a cost is held per row and is editable either way, and the sheet knows when it
 * is not finished. That last part matters more than it looks: a missing cost is not
 * zero. Sending a buyer a price list built on a cost of nothing would quote them
 * the markup alone - the cheapest possible price for every bag, and a mistake that
 * looks like a working document. `isPriceListReady` is what stands in the way, and
 * the page refuses to download until it passes.
 *
 * The markup arithmetic is untouched: selling is still cost plus markup, and the
 * buyer's copy is still built by `buildBuyerPriceList` from these rows.
 */

import { readLocal, writeLocal } from "./storage";
import { clampNumber, LIMITS, type OrderItem } from "./types";
import { sanitizeLine } from "./buyer";
import { lookupPrice, type PriceBook } from "./priceBook";

export const PRICE_LIST_KEY = "balebook.priceList.v1";
export const PRICE_LIST_VERSION = 1;
export const MAX_ROWS = LIMITS.rows;
export const DEFAULT_MARKUP = 2000;

export interface PriceRow {
  id: string;
  name: string;
  /** Bags of this item. */
  qty: number;
  /** What a bag cost us. Zero means nobody has said yet. */
  costPerBag: number;
  /**
   * True when the cost came from the price book rather than from the file or from
   * somebody typing it.
   *
   * Worth keeping because a price inherited from last month is a guess, and it
   * should not look identical to one decided today.
   */
  remembered: boolean;
}

export interface PriceListDoc {
  app: "balebook-price-list";
  version: number;
  /** Headlines the buyer's copy and names the download. */
  orderNumber: string;
  /** Added to every bag's cost. */
  markup: number;
  rows: PriceRow[];
  updatedAt: string;
}

export function emptyPriceListDoc(): PriceListDoc {
  return {
    app: "balebook-price-list",
    version: PRICE_LIST_VERSION,
    orderNumber: "",
    markup: DEFAULT_MARKUP,
    rows: [],
    updatedAt: new Date().toISOString(),
  };
}

let counter = 0;
function uid(): string {
  counter += 1;
  return `pr${Date.now().toString(36)}${counter}`;
}

/* ------------------------------ construction ------------------------------ */

export function createPriceRow(input: {
  name?: unknown;
  qty?: unknown;
  costPerBag?: unknown;
  remembered?: unknown;
}): PriceRow {
  return {
    id: uid(),
    name: sanitizeLine(input.name, LIMITS.itemName),
    // Bags are whole things.
    qty: Math.floor(clampNumber(input.qty, LIMITS.qty)),
    costPerBag: clampNumber(input.costPerBag, LIMITS.money),
    remembered: input.remembered === true,
  };
}

/**
 * Build a sheet from an uploaded file.
 *
 * Where the file gave no cost - which is every row of a warehouse count - the price
 * book is asked what that item last cost, and the row is marked as remembered so it
 * is obvious the figure was inherited rather than decided. A cost that came from
 * the file is never overwritten by the book: the file is about this order, the book
 * is about the last one.
 */
export function fromParsedItems(
  items: Array<{ name: string; qty: number; perBag: number }>,
  options: {
    orderNumber?: string;
    markup?: number;
    book?: PriceBook;
  } = {},
): PriceListDoc {
  const book = options.book;

  return {
    ...emptyPriceListDoc(),
    orderNumber: sanitizeLine(options.orderNumber, LIMITS.title),
    markup: clampNumber(
      options.markup === undefined ? DEFAULT_MARKUP : options.markup,
      LIMITS.markup,
    ),
    rows: items
      .slice(0, MAX_ROWS)
      .map((item) => {
        const fromFile = clampNumber(item.perBag, LIMITS.money);
        const remembered =
          fromFile <= 0 && book ? lookupPrice(book, item.name) : null;
        return createPriceRow({
          name: item.name,
          qty: item.qty,
          costPerBag: fromFile > 0 ? fromFile : (remembered ?? 0),
          remembered: fromFile <= 0 && remembered !== null,
        });
      })
      // A line with no name is not an item, and one with no bags prices nothing.
      .filter((row) => row.name !== "" && row.qty > 0),
  };
}

/* --------------------------------- derived -------------------------------- */

/** What a bag of this item sells for. */
export function sellingPerBag(row: PriceRow, markup: number): number {
  return row.costPerBag + Math.max(0, markup);
}

/** What this line sells for. */
export function lineTotal(row: PriceRow, markup: number): number {
  return row.qty * sellingPerBag(row, markup);
}

export interface PriceListTotals {
  items: number;
  bags: number;
  /** What the bags cost us. */
  cost: number;
  /** What the markup adds. */
  markupTotal: number;
  /** What the buyer pays. */
  selling: number;
  /** Rows still waiting for a cost. */
  missing: number;
  /** Rows whose cost came from the price book. */
  remembered: number;
}

export function priceListTotals(doc: PriceListDoc): PriceListTotals {
  const markup = Math.max(0, doc.markup);
  const totals: PriceListTotals = {
    items: doc.rows.length,
    bags: 0,
    cost: 0,
    markupTotal: 0,
    selling: 0,
    missing: 0,
    remembered: 0,
  };

  for (const row of doc.rows) {
    totals.bags += row.qty;
    totals.cost += row.qty * row.costPerBag;
    totals.markupTotal += row.qty * markup;
    totals.selling += lineTotal(row, markup);
    if (row.costPerBag <= 0) totals.missing += 1;
    if (row.remembered) totals.remembered += 1;
  }
  return totals;
}

/** The items still waiting for a cost, for telling somebody what is left. */
export function missingCostNames(doc: PriceListDoc): string[] {
  return doc.rows.filter((row) => row.costPerBag <= 0).map((row) => row.name);
}

/**
 * Whether this can be sent to a buyer.
 *
 * False while any row has no cost. Quoting a bag at the markup alone is the one
 * mistake this page must never make, so it is a hard gate rather than a warning.
 */
export function isPriceListReady(doc: PriceListDoc): boolean {
  return doc.rows.length > 0 && doc.rows.every((row) => row.costPerBag > 0);
}

/** The rows in the shape the buyer's document and the route expect. */
export function toOrderItems(doc: PriceListDoc): OrderItem[] {
  return doc.rows.map((row) => ({
    name: row.name,
    qty: row.qty,
    perBag: row.costPerBag,
  }));
}

/* -------------------------------- mutation -------------------------------- */

function touch(doc: PriceListDoc, patch: Partial<PriceListDoc>): PriceListDoc {
  return { ...doc, ...patch, updatedAt: new Date().toISOString() };
}

/** Set one row's cost. It stops being a remembered figure and becomes a decision. */
export function setRowCost(
  doc: PriceListDoc,
  id: string,
  costPerBag: number,
): PriceListDoc {
  const cost = clampNumber(costPerBag, LIMITS.money);
  return touch(doc, {
    rows: doc.rows.map((row) =>
      row.id === id ? { ...row, costPerBag: cost, remembered: false } : row,
    ),
  });
}

export function setRowQty(doc: PriceListDoc, id: string, qty: number): PriceListDoc {
  return touch(doc, {
    rows: doc.rows.map((row) =>
      row.id === id
        ? { ...row, qty: Math.floor(clampNumber(qty, LIMITS.qty)) }
        : row,
    ),
  });
}

export function removeRow(doc: PriceListDoc, id: string): PriceListDoc {
  return touch(doc, { rows: doc.rows.filter((row) => row.id !== id) });
}

export function setMarkup(doc: PriceListDoc, markup: number): PriceListDoc {
  return touch(doc, { markup: clampNumber(markup, LIMITS.markup) });
}

export function setOrderNumber(
  doc: PriceListDoc,
  orderNumber: string,
): PriceListDoc {
  return touch(doc, { orderNumber: sanitizeLine(orderNumber, LIMITS.title) });
}

/**
 * Fill every empty cost from the price book in one go.
 *
 * For picking the book up again after it has learned something new, without
 * disturbing a cost already decided on this sheet.
 */
export function fillFromBook(doc: PriceListDoc, book: PriceBook): PriceListDoc {
  return touch(doc, {
    rows: doc.rows.map((row) => {
      if (row.costPerBag > 0) return row;
      const known = lookupPrice(book, row.name);
      return known === null
        ? row
        : { ...row, costPerBag: known, remembered: true };
    }),
  });
}

/* ------------------------------- persistence ------------------------------ */

export function parsePriceListDoc(input: unknown): PriceListDoc {
  const raw = (input ?? {}) as Record<string, unknown>;
  const rawRows = Array.isArray(raw.rows) ? raw.rows : [];

  const rows: PriceRow[] = rawRows
    .slice(0, MAX_ROWS)
    .map((entry) => {
      const r = (entry ?? {}) as Record<string, unknown>;
      const built = createPriceRow(r);
      return { ...built, id: String(r.id ?? built.id) };
    })
    .filter((row) => row.name !== "" && row.qty > 0);

  return {
    app: "balebook-price-list",
    version: Number(raw.version) || PRICE_LIST_VERSION,
    orderNumber: sanitizeLine(raw.orderNumber, LIMITS.title),
    markup: clampNumber(
      raw.markup === undefined ? DEFAULT_MARKUP : raw.markup,
      LIMITS.markup,
    ),
    rows,
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
  };
}

export function loadPriceListDoc(): PriceListDoc {
  if (typeof window === "undefined") return emptyPriceListDoc();
  try {
    const raw = readLocal(PRICE_LIST_KEY);
    if (!raw) return emptyPriceListDoc();
    return parsePriceListDoc(JSON.parse(raw));
  } catch {
    return emptyPriceListDoc();
  }
}

export function savePriceListDoc(doc: PriceListDoc): void {
  writeLocal(PRICE_LIST_KEY, JSON.stringify(doc));
}

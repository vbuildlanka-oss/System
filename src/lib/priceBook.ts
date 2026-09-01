/**
 * What we last paid for each item.
 *
 * A count taken in the warehouse arrives with no prices on it, so every item has
 * to be priced by hand before a buyer's copy can be made. Doing that from scratch
 * for eighty-five items, every time, is the difference between a feature that gets
 * used and one that does not. So each price is remembered against the item name and
 * offered back the next time that name turns up.
 *
 * Keyed on the normalised name, the same key the stockpile and the warehouse count
 * use. That deliberately folds "Anorak #2" and "Anorak 2" together: they are the
 * same product typed two ways, and they should not carry two different prices.
 *
 * A remembered price is a suggestion, never an answer. The page marks which prices
 * came from here so that a figure inherited from last month is visibly different
 * from one decided today.
 */

import { readLocal, writeLocal } from "./storage";
import { clampNumber, LIMITS } from "./types";
import { sanitizeLine } from "./buyer";
import { normalizeItemKey } from "./stockpile";

export const PRICE_BOOK_KEY = "balebook.priceBook.v1";
export const PRICE_BOOK_VERSION = 1;
/** Enough for years of trading without the browser store growing unbounded. */
export const MAX_REMEMBERED = 2000;

export interface PriceBookEntry {
  /** The name as last written, for showing in a list. */
  name: string;
  costPerBag: number;
  /** ISO date the price was last used. */
  at: string;
}

export interface PriceBook {
  app: "balebook-price-book";
  version: number;
  /** Normalised item name to what it last cost. */
  prices: Record<string, PriceBookEntry>;
  updatedAt: string;
}

export function emptyPriceBook(): PriceBook {
  return {
    app: "balebook-price-book",
    version: PRICE_BOOK_VERSION,
    prices: {},
    updatedAt: new Date().toISOString(),
  };
}

/** What we last paid for this item, or null if we have never priced it. */
export function lookupPrice(book: PriceBook, name: string): number | null {
  const key = normalizeItemKey(name);
  if (key === "") return null;
  const entry = book.prices[key];
  return entry && entry.costPerBag > 0 ? entry.costPerBag : null;
}

/**
 * Record what an item cost.
 *
 * The newest price wins outright rather than being averaged: what a bag costs now
 * is a fact about now, and a price that drifted towards a blend of last year's
 * would be wrong in a way nobody could see.
 */
export function rememberPrice(
  book: PriceBook,
  name: string,
  costPerBag: number,
): PriceBook {
  const clean = sanitizeLine(name, LIMITS.itemName);
  const key = normalizeItemKey(clean);
  const cost = clampNumber(costPerBag, LIMITS.money);
  if (key === "" || cost <= 0) return book;

  const prices = { ...book.prices, [key]: { name: clean, costPerBag: cost, at: new Date().toISOString() } };

  // Oldest first out, so the book cannot grow without limit.
  const keys = Object.keys(prices);
  if (keys.length > MAX_REMEMBERED) {
    const kept = keys
      .sort((a, b) => prices[b].at.localeCompare(prices[a].at))
      .slice(0, MAX_REMEMBERED);
    const trimmed: Record<string, PriceBookEntry> = {};
    for (const k of kept) trimmed[k] = prices[k];
    return { ...book, prices: trimmed, updatedAt: new Date().toISOString() };
  }

  return { ...book, prices, updatedAt: new Date().toISOString() };
}

/** Record a whole sheet's prices at once. */
export function rememberPrices(
  book: PriceBook,
  rows: Array<{ name: string; costPerBag: number }>,
): PriceBook {
  let next = book;
  for (const row of rows) next = rememberPrice(next, row.name, row.costPerBag);
  return next;
}

export function forgetPrice(book: PriceBook, name: string): PriceBook {
  const key = normalizeItemKey(name);
  if (!(key in book.prices)) return book;
  const prices = { ...book.prices };
  delete prices[key];
  return { ...book, prices, updatedAt: new Date().toISOString() };
}

export function priceBookSize(book: PriceBook): number {
  return Object.keys(book.prices).length;
}

/* ------------------------------- persistence ------------------------------ */

export function parsePriceBook(input: unknown): PriceBook {
  const raw = (input ?? {}) as Record<string, unknown>;
  const rawPrices =
    raw.prices !== null && typeof raw.prices === "object"
      ? (raw.prices as Record<string, unknown>)
      : {};

  const prices: Record<string, PriceBookEntry> = {};
  for (const key of Object.keys(rawPrices).slice(0, MAX_REMEMBERED)) {
    const entry = (rawPrices[key] ?? {}) as Record<string, unknown>;
    const name = sanitizeLine(entry.name, LIMITS.itemName);
    const cost = clampNumber(entry.costPerBag, LIMITS.money);
    // A remembered price of nothing is not a price.
    if (name === "" || cost <= 0) continue;
    prices[key] = {
      name,
      costPerBag: cost,
      at: String(entry.at ?? new Date().toISOString()),
    };
  }

  return {
    app: "balebook-price-book",
    version: Number(raw.version) || PRICE_BOOK_VERSION,
    prices,
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
  };
}

export function loadPriceBook(): PriceBook {
  if (typeof window === "undefined") return emptyPriceBook();
  try {
    const raw = readLocal(PRICE_BOOK_KEY);
    if (!raw) return emptyPriceBook();
    return parsePriceBook(JSON.parse(raw));
  } catch {
    return emptyPriceBook();
  }
}

export function savePriceBook(book: PriceBook): void {
  writeLocal(PRICE_BOOK_KEY, JSON.stringify(book));
}

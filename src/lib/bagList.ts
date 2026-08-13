/**
 * Order Bag Lists: a distributable manifest showing only what is in an order,
 * never what it cost.
 *
 * Two things matter here.
 *
 * 1. NO MONEY. A bag list carries item names and bag counts only. Prices are
 *    dropped at import, so there is no way for a per-bag or total figure to
 *    reach an exported manifest.
 *
 * 2. THE TARGET IS EXACT. You give a total number of bags and the per-item
 *    quantities are reduced at random until they sum to precisely that figure,
 *    with every item keeping at least one bag. The reduction is derived from a
 *    stored seed rather than saved, so the same list always renders the same
 *    numbers, and "reshuffle" is just a new seed.
 */

import { readLocal, writeLocal } from "./storage";
import { LIMITS, clampNumber } from "./types";
import { sanitizeLine } from "./buyer";

export const BAG_LISTS_KEY = "balebook.bagLists.v1";

/** One line on a manifest. */
export interface BagItem {
  name: string;
  qty: number;
}

export interface BagList {
  id: string;
  title: string;
  /** Quantities exactly as imported. Never mutated by generating a target. */
  items: BagItem[];
  /** Requested grand total, or null while it has not been set. */
  target: number | null;
  /** Seed for the random reduction. A new seed reshuffles the distribution. */
  seed: number;
  createdAt: string;
}

export interface BagListDoc {
  app: "balebook-bag-lists";
  version: number;
  lists: BagList[];
  updatedAt: string;
}

export const BAG_LIST_VERSION = 1;
/** Enough for many orders without letting the browser store grow unbounded. */
export const MAX_LISTS = 50;

export function emptyBagListDoc(): BagListDoc {
  return {
    app: "balebook-bag-lists",
    version: BAG_LIST_VERSION,
    lists: [],
    updatedAt: new Date().toISOString(),
  };
}

/* ---------------------------------- ids ---------------------------------- */

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) || 1;
}

/* -------------------------------- totals --------------------------------- */

export function sumQty(items: BagItem[]): number {
  return items.reduce((s, i) => s + i.qty, 0);
}

/**
 * Strip an imported order down to a manifest: names and bag counts only.
 *
 * Prices are discarded here rather than hidden later, and every quantity is
 * floored to a whole number and raised to at least 1, which is the invariant
 * the reduction relies on.
 */
export function toBagItems(
  source: Array<{ name?: unknown; qty?: unknown }>,
): BagItem[] {
  const out: BagItem[] = [];
  for (const raw of source) {
    const row = (raw ?? {}) as { name?: unknown; qty?: unknown };
    const name = sanitizeLine(row.name, LIMITS.itemName);
    if (!name) continue;
    const qty = Math.max(1, Math.floor(clampNumber(row.qty, LIMITS.qty)));
    out.push({ name, qty });
  }
  return out;
}

/* ------------------------------- validation ------------------------------- */

export interface TargetCheck {
  ok: boolean;
  /** Smallest achievable total: one bag per item. */
  min: number;
  /** Largest achievable total: the order as imported. */
  max: number;
  message?: string;
}

/**
 * A target is only workable if it sits between "one bag per item" and the
 * order's current total, since quantities are only ever reduced.
 */
export function checkTarget(
  items: BagItem[],
  target: number | null,
): TargetCheck {
  const min = items.length;
  const max = sumQty(items);

  if (items.length === 0) {
    return { ok: false, min, max, message: "This list has no items." };
  }
  if (target === null || Number.isNaN(target)) {
    return { ok: false, min, max, message: "Enter a target number of bags." };
  }
  if (!Number.isFinite(target) || !Number.isInteger(target)) {
    return { ok: false, min, max, message: "Enter a whole number of bags." };
  }
  if (target < min) {
    return {
      ok: false,
      min,
      max,
      message: `Target must be at least ${min} - one bag for each of the ${min} items.`,
    };
  }
  if (target > max) {
    return {
      ok: false,
      min,
      max,
      message: `Target cannot exceed the current total of ${max} bags. Quantities are only reduced, never increased.`,
    };
  }
  return { ok: true, min, max };
}

/* ------------------------------ the reduction ----------------------------- */

/** Small deterministic PRNG so a stored seed always reproduces a list. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Randomly reduce quantities so they total exactly `target`, never dropping an
 * item below one bag.
 *
 * Each bag to be removed is drawn from an item with probability proportional to
 * how many bags that item can still spare. Picking a random *bag* rather than a
 * random *item* keeps the shape of the order intact - a line of 62 gives up
 * more than a line of 3 - instead of flattening every line towards 1.
 *
 * Total spare capacity is exactly (total - itemCount), and each removal reduces
 * it by one, so validation guaranteeing `target >= itemCount` is enough to
 * guarantee this loop can always finish.
 */
export function reduceToTarget(
  items: BagItem[],
  target: number,
  seed: number,
): BagItem[] {
  const check = checkTarget(items, target);
  if (!check.ok) throw new Error(check.message ?? "Invalid target.");

  const quantities = items.map((i) => i.qty);
  let remaining = sumQty(items) - target;
  let capacity = sumQty(items) - items.length;
  const rand = mulberry32(seed);

  while (remaining > 0 && capacity > 0) {
    let pick = rand() * capacity;
    for (let i = 0; i < quantities.length; i += 1) {
      const spare = quantities[i] - 1;
      if (spare <= 0) continue;
      if (pick < spare) {
        quantities[i] -= 1;
        break;
      }
      pick -= spare;
    }
    remaining -= 1;
    capacity -= 1;
  }

  return items.map((item, i) => ({ name: item.name, qty: quantities[i] }));
}

/**
 * The rows a list should display and export: the reduced quantities when a
 * valid target is set, otherwise the order as imported.
 */
export function resolveBagList(list: BagList): {
  items: BagItem[];
  total: number;
  reduced: boolean;
} {
  const check = checkTarget(list.items, list.target);
  if (list.target !== null && check.ok) {
    const items = reduceToTarget(list.items, list.target, list.seed);
    return { items, total: sumQty(items), reduced: true };
  }
  return { items: list.items, total: sumQty(list.items), reduced: false };
}

/* ------------------------------ persistence ------------------------------ */

export function parseBagListDoc(input: unknown): BagListDoc {
  const raw = (input ?? {}) as Record<string, unknown>;
  const lists = Array.isArray(raw.lists) ? raw.lists : [];

  const clean: BagList[] = lists.slice(0, MAX_LISTS).map((entry, i) => {
    const l = (entry ?? {}) as Record<string, unknown>;
    const items = toBagItems(Array.isArray(l.items) ? l.items : []);
    const rawTarget = Number(l.target);
    return {
      id: String(l.id ?? uid("bl")),
      title: sanitizeLine(l.title, LIMITS.title) || `Order ${i + 1}`,
      items,
      target:
        l.target === null || l.target === undefined || !Number.isFinite(rawTarget)
          ? null
          : Math.floor(rawTarget),
      seed: Number.isFinite(Number(l.seed)) ? Number(l.seed) : randomSeed(),
      createdAt: String(l.createdAt ?? new Date().toISOString()),
    };
  });

  return {
    app: "balebook-bag-lists",
    version: Number(raw.version) || BAG_LIST_VERSION,
    lists: clean,
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
  };
}

export function loadBagLists(): BagListDoc {
  if (typeof window === "undefined") return emptyBagListDoc();
  try {
    const raw = readLocal(BAG_LISTS_KEY);
    if (!raw) return emptyBagListDoc();
    return parseBagListDoc(JSON.parse(raw));
  } catch {
    return emptyBagListDoc();
  }
}

export function saveBagLists(doc: BagListDoc): void {
  writeLocal(BAG_LISTS_KEY, JSON.stringify(doc));
}

/** Build a new list from an imported order. */
export function createBagList(
  title: string,
  source: Array<{ name?: unknown; qty?: unknown }>,
): BagList {
  return {
    id: uid("bl"),
    title: sanitizeLine(title, LIMITS.title) || "Order",
    items: toBagItems(source),
    target: null,
    seed: randomSeed(),
    createdAt: new Date().toISOString(),
  };
}

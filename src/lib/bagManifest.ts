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
import { normalizeContainerNumber } from "./container";

export const MANIFESTS_KEY = "balebook.bagManifests.v1";
/** Data saved before the module was renamed from "bag lists". */
const MANIFESTS_KEY_LEGACY = "balebook.bagLists.v1";

/** One line on a manifest. */
export interface BagItem {
  name: string;
  qty: number;
}

export interface BagManifest {
  id: string;
  /**
   * The order number, e.g. "Sri Lanka Order 3 2026" or "SL-003".
   *
   * This is the headline of an exported manifest - the one thing the reader sees
   * first - so it is required before exporting. It replaced a separate order
   * title: two headings said the same thing twice.
   */
  orderNumber: string;
  /** ISO 6346 code, stored uppercase. Required before exporting. */
  containerNumber: string;
  /** Quantities exactly as imported. Never mutated by generating a manifest. */
  items: BagItem[];
  /** Requested grand total, or null while it has not been set. */
  target: number | null;
  /**
   * The distribution as generated, stored rather than recomputed.
   *
   * A manifest goes to a shipper or to customs, so the numbers on it are a
   * record. Re-downloading must reproduce the same document byte for byte, and
   * it must keep doing so even if the reduction algorithm is ever changed. That
   * only holds if the figures themselves are saved, so they are. Re-randomising
   * is an explicit action that overwrites this.
   */
  generated: BagItem[] | null;
  /** Seed used for the stored distribution, kept for reference. */
  seed: number;
  createdAt: string;
  generatedAt: string | null;
}

export interface BagManifestDoc {
  app: "balebook-bag-manifests";
  version: number;
  manifests: BagManifest[];
  updatedAt: string;
}

export const MANIFEST_VERSION = 2;
/** Enough for many orders without letting the browser store grow unbounded. */
export const MAX_MANIFESTS = 50;

export function emptyManifestDoc(): BagManifestDoc {
  return {
    app: "balebook-bag-manifests",
    version: MANIFEST_VERSION,
    manifests: [],
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
 * The rows a manifest should display and export.
 *
 * Once generated, the stored distribution is used verbatim - never recomputed -
 * so a re-download is always the same document. Before that, the order shows
 * through as imported.
 */
export function resolveManifest(manifest: BagManifest): {
  items: BagItem[];
  total: number;
  generated: boolean;
} {
  if (manifest.generated && manifest.generated.length > 0) {
    return {
      items: manifest.generated,
      total: sumQty(manifest.generated),
      generated: true,
    };
  }
  return {
    items: manifest.items,
    total: sumQty(manifest.items),
    generated: false,
  };
}

/**
 * Produce and store a distribution for `target`. Used both by "generate" and by
 * "re-randomise" - the only difference is that a fresh seed is passed in.
 */
export function generateManifest(
  manifest: BagManifest,
  target: number,
  seed: number = randomSeed(),
): BagManifest {
  const generated = reduceToTarget(manifest.items, target, seed);
  return {
    ...manifest,
    target,
    seed,
    generated,
    generatedAt: new Date().toISOString(),
  };
}

/** Discard the stored distribution and go back to the imported quantities. */
export function clearGenerated(manifest: BagManifest): BagManifest {
  return { ...manifest, target: null, generated: null, generatedAt: null };
}

/* ------------------------------ persistence ------------------------------ */

export function parseManifestDoc(input: unknown): BagManifestDoc {
  const raw = (input ?? {}) as Record<string, unknown>;
  // Accepts documents saved before the rename, which used "lists".
  const entries = Array.isArray(raw.manifests)
    ? raw.manifests
    : Array.isArray(raw.lists)
      ? raw.lists
      : [];

  const clean: BagManifest[] = entries
    .slice(0, MAX_MANIFESTS)
    .map((entry, i) => {
      const m = (entry ?? {}) as Record<string, unknown>;
      const items = toBagItems(Array.isArray(m.items) ? m.items : []);
      const rawTarget = Number(m.target);
      const target =
        m.target === null ||
        m.target === undefined ||
        !Number.isFinite(rawTarget)
          ? null
          : Math.floor(rawTarget);

      // A stored distribution is only trusted if it still lines up with the
      // order: same number of lines, and totalling the recorded target.
      let generated: BagItem[] | null = null;
      if (Array.isArray(m.generated)) {
        const candidate = toBagItems(m.generated);
        const matchesShape = candidate.length === items.length;
        const matchesTarget = target === null || sumQty(candidate) === target;
        if (matchesShape && matchesTarget && candidate.length > 0) {
          generated = candidate;
        }
      }

      return {
        id: String(m.id ?? uid("bm")),
        // `title` is read as a fallback so manifests saved before the order
        // number replaced it keep their heading.
        orderNumber:
          sanitizeLine(m.orderNumber, LIMITS.title) ||
          sanitizeLine(m.title, LIMITS.title) ||
          `Order ${i + 1}`,
        containerNumber: normalizeContainerNumber(m.containerNumber),
        items,
        target,
        generated,
        seed: Number.isFinite(Number(m.seed)) ? Number(m.seed) : randomSeed(),
        createdAt: String(m.createdAt ?? new Date().toISOString()),
        generatedAt: m.generatedAt ? String(m.generatedAt) : null,
      };
    });

  return {
    app: "balebook-bag-manifests",
    version: Number(raw.version) || MANIFEST_VERSION,
    manifests: clean,
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
  };
}

export function loadManifests(): BagManifestDoc {
  if (typeof window === "undefined") return emptyManifestDoc();
  try {
    const raw = readLocal(MANIFESTS_KEY, MANIFESTS_KEY_LEGACY);
    if (!raw) return emptyManifestDoc();
    return parseManifestDoc(JSON.parse(raw));
  } catch {
    return emptyManifestDoc();
  }
}

export function saveManifests(doc: BagManifestDoc): void {
  writeLocal(MANIFESTS_KEY, JSON.stringify(doc));
}

/**
 * Build a new manifest from an imported order. The imported sheet's heading is
 * used as the starting order number, since that is usually what it is.
 */
export function createManifest(
  orderNumber: string,
  source: Array<{ name?: unknown; qty?: unknown }>,
  containerNumber = "",
): BagManifest {
  return {
    id: uid("bm"),
    orderNumber: sanitizeLine(orderNumber, LIMITS.title) || "Order",
    containerNumber: normalizeContainerNumber(containerNumber),
    items: toBagItems(source),
    target: null,
    generated: null,
    seed: randomSeed(),
    createdAt: new Date().toISOString(),
    generatedAt: null,
  };
}

/**
 * Work out an order number from an uploaded file's name.
 *
 * Files arrive named things like "Sri Lanka 2026 04.pdf" or
 * "Sri Lanka Order 3 2026 - Sheet1 (1).pdf". The number in the name is the one
 * worth tracking, so it is pulled out and used as the default order number,
 * which keeps a downloaded manifest tied to the file it came from.
 *
 * Two things are deliberately ignored: a four digit year, which would otherwise
 * be mistaken for the order number, and the noise spreadsheet exports leave
 * behind ("Sheet1", a trailing "(1)"). The first remaining number wins, so a
 * "rev 2" on the end does not override it. Single digits are padded to two.
 *
 * Returns an empty string when there is nothing usable, letting the caller fall
 * back to the heading inside the file.
 */
export function orderNumberFromFilename(filename: string): string {
  const withoutExtension = String(filename ?? "").replace(/\.[^.]+$/, "");

  const cleaned = withoutExtension
    // "(1)" that download managers add for a duplicate.
    .replace(/\(\s*\d+\s*\)\s*$/, " ")
    // Leftovers from spreadsheet exports.
    .replace(
      /\b(sheet\s*\d*|copy|final|draft|export|version|rev|revision)\b/gi,
      " ",
    );

  const withoutYear = cleaned.replace(/\b(19|20)\d{2}\b/g, " ");

  const numbers = withoutYear.match(/\d+/g);
  const number = numbers ? numbers[0] : null;

  const words = withoutYear
    .replace(/\d+/g, " ")
    .replace(/[_\-\u2013\u2014]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!number) return sanitizeLine(words, LIMITS.title);

  const padded = number.length === 1 ? `0${number}` : number;
  return sanitizeLine(words ? `${words} ${padded}` : padded, LIMITS.title);
}

/** `<Order Number> - <Container Number> - Bags.<ext>` */
export function manifestFilename(
  orderNumber: string,
  containerNumber: string,
  ext: string,
): string {
  const safe = (s: string) => s.replace(/[^\w\d\- ]+/g, "").trim();
  const parts = [
    safe(orderNumber) || "Order",
    safe(containerNumber),
    "Bags",
  ].filter((p) => p !== "");
  return `${parts.join(" - ")}.${ext}`;
}

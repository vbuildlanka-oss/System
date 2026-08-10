/**
 * The Stockpile: leftover bags carried forward across orders.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS SHAPED THIS WAY
 * ---------------------------------------------------------------------------
 * When sales are slow, unsold bags from an order don't disappear - they get set
 * aside and mixed with leftovers from earlier orders. The tricky part is that
 * the same item can arrive from different orders at different prices, and you
 * need to know how long each batch has been sitting.
 *
 * So the stockpile stores an item ONCE, holding a list of "lots" (batches):
 *
 *   Blanket
 *     +- 12 bags @ Rs20,000  from "Order 3"  added 2026-06-02
 *     +-  5 bags @ Rs22,000  from "Order 4"  added 2026-08-09
 *
 * This gives four things for free:
 *   1. SIZE - storage grows with the number of batches, not the number of bags.
 *      Adding 500 bags in one go is still a single lot.
 *   2. TRUTH - totals, averages and values are always CALCULATED from the lots,
 *      never stored. Nothing can drift out of sync with itself.
 *   3. AGE - each lot carries its own date, so slow-moving stock is visible and
 *      withdrawals can take the oldest bags first (FIFO), like real stock.
 *   4. HISTORY - every movement in or out is logged, capped so the file stays
 *      small.
 *
 * The whole stockpile is one JSON document: autosaved in the browser and
 * downloadable as a file. No database.
 */

import { formatLKR } from "./types";

export const STOCKPILE_KEY = "vbuild.stockpile.v1";
export const STOCKPILE_VERSION = 1;
/** Keep the audit trail useful without letting the file grow forever. */
export const MAX_HISTORY = 300;

/* --------------------------------- model --------------------------------- */

/** One batch of an item, from one source, at one price. */
export interface StockLot {
  id: string;
  bags: number;
  /** Value/price per bag for this batch, in LKR. */
  perBag: number;
  /** Where it came from, e.g. "Sri Lanka Order 3 2026". */
  source: string;
  /** ISO timestamp this batch entered the stockpile. */
  addedAt: string;
  note?: string;
}

export interface StockItem {
  id: string;
  /** Display name, as first entered. */
  name: string;
  /** Normalised name used to merge the same item across orders. */
  key: string;
  lots: StockLot[];
}

export type MovementKind = "in" | "out";

export interface StockMovement {
  id: string;
  at: string;
  kind: MovementKind;
  itemName: string;
  bags: number;
  /** Total value of the movement, in LKR. */
  value: number;
  /** Source for an addition, or reason for a withdrawal. */
  reason: string;
}

export interface Stockpile {
  app: "vbuild-stockpile";
  version: number;
  items: StockItem[];
  history: StockMovement[];
  updatedAt: string;
}

export function emptyStockpile(): Stockpile {
  return {
    app: "vbuild-stockpile",
    version: STOCKPILE_VERSION,
    items: [],
    history: [],
    updatedAt: new Date().toISOString(),
  };
}

/* ---------------------------------- ids ---------------------------------- */

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

/* ------------------------------ name matching ----------------------------- */

/**
 * Normalise an item name so leftovers of the same thing merge across orders.
 *
 * Real sheets are inconsistent: "Anorak 2" in one order is "Anorak #2" in the
 * next, and capitalisation wanders. We fold those together, but deliberately
 * keep genuinely different grades apart ("Anorak" stays separate from
 * "Anorak 2"). Anything we can't be sure about is left for you to merge by hand.
 */
export function normalizeItemKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[#]/g, "")
    .replace(/[()]/g, " ")
    .replace(/[^a-z0-9/\s.-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s.-]+$/g, "")
    .trim();
}

/* ------------------------------ persistence ------------------------------ */

/** Coerce anything read from disk/storage into a valid stockpile. */
export function parseStockpile(input: unknown): Stockpile {
  const raw = (input ?? {}) as Record<string, unknown>;
  const items = Array.isArray(raw.items) ? raw.items : [];
  const history = Array.isArray(raw.history) ? raw.history : [];

  const cleanItems: StockItem[] = items.map((it, i) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const name = String(o.name ?? "").trim() || `Item ${i + 1}`;
    const lots = Array.isArray(o.lots) ? o.lots : [];
    return {
      id: String(o.id ?? uid("i")),
      name,
      key: String(o.key ?? "") || normalizeItemKey(name),
      lots: lots
        .map((l) => {
          const lo = (l ?? {}) as Record<string, unknown>;
          return {
            id: String(lo.id ?? uid("l")),
            bags: Math.max(0, Number(lo.bags) || 0),
            perBag: Math.max(0, Number(lo.perBag) || 0),
            source: String(lo.source ?? "").trim(),
            addedAt: String(lo.addedAt ?? new Date().toISOString()),
            note: lo.note ? String(lo.note) : undefined,
          };
        })
        .filter((l) => l.bags > 0),
    };
  });

  const cleanHistory: StockMovement[] = history
    .map((h, i) => {
      const o = (h ?? {}) as Record<string, unknown>;
      return {
        id: String(o.id ?? `m${i}`),
        at: String(o.at ?? new Date().toISOString()),
        kind: o.kind === "out" ? ("out" as const) : ("in" as const),
        itemName: String(o.itemName ?? ""),
        bags: Number(o.bags) || 0,
        value: Number(o.value) || 0,
        reason: String(o.reason ?? ""),
      };
    })
    .slice(0, MAX_HISTORY);

  return {
    app: "vbuild-stockpile",
    version: Number(raw.version) || STOCKPILE_VERSION,
    items: cleanItems,
    history: cleanHistory,
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
  };
}

export function loadStockpile(): Stockpile {
  if (typeof window === "undefined") return emptyStockpile();
  try {
    const raw = window.localStorage.getItem(STOCKPILE_KEY);
    if (!raw) return emptyStockpile();
    return parseStockpile(JSON.parse(raw));
  } catch {
    return emptyStockpile();
  }
}

export function saveStockpile(sp: Stockpile): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STOCKPILE_KEY, JSON.stringify(sp));
  } catch {
    /* storage unavailable - not fatal */
  }
}

/* ------------------------------- aggregation ------------------------------ */

export function itemBags(item: StockItem): number {
  return item.lots.reduce((s, l) => s + l.bags, 0);
}

export function itemValue(item: StockItem): number {
  return item.lots.reduce((s, l) => s + l.bags * l.perBag, 0);
}

/** Weighted average price per bag across all lots. */
export function itemAvgPerBag(item: StockItem): number {
  const bags = itemBags(item);
  return bags === 0 ? 0 : itemValue(item) / bags;
}

/** ISO date of the oldest lot still holding bags. */
export function oldestLotDate(item: StockItem): string | null {
  const dates = item.lots.filter((l) => l.bags > 0).map((l) => l.addedAt);
  if (dates.length === 0) return null;
  return dates.reduce((a, b) => (a < b ? a : b));
}

export function daysSince(iso: string | null, now: Date = new Date()): number {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

/** How long an item has been sitting, by its oldest remaining lot. */
export function itemAgeDays(item: StockItem, now: Date = new Date()): number {
  return daysSince(oldestLotDate(item), now);
}

export interface AgeBucket {
  key: "fresh" | "watch" | "slow" | "dead";
  label: string;
  /** Inclusive lower bound in days. */
  from: number;
  /** Exclusive upper bound in days, or null for open-ended. */
  to: number | null;
}

export const AGE_BUCKETS: AgeBucket[] = [
  { key: "fresh", label: "Under 30 days", from: 0, to: 30 },
  { key: "watch", label: "30 to 59 days", from: 30, to: 60 },
  { key: "slow", label: "60 to 89 days", from: 60, to: 90 },
  { key: "dead", label: "90 days or more", from: 90, to: null },
];

export function ageBucket(days: number): AgeBucket {
  for (const b of AGE_BUCKETS) {
    if (days >= b.from && (b.to === null || days < b.to)) return b;
  }
  return AGE_BUCKETS[AGE_BUCKETS.length - 1];
}

export interface StockpileTotals {
  itemCount: number;
  bags: number;
  value: number;
  /** Bags and value that have been sitting 90+ days. */
  deadBags: number;
  deadValue: number;
  /** Age of the oldest item in the pile. */
  oldestDays: number;
  /** Bags and value per age bucket, for the breakdown bar. */
  byBucket: Record<AgeBucket["key"], { bags: number; value: number }>;
}

export function stockpileTotals(
  sp: Stockpile,
  now: Date = new Date(),
): StockpileTotals {
  const byBucket = {
    fresh: { bags: 0, value: 0 },
    watch: { bags: 0, value: 0 },
    slow: { bags: 0, value: 0 },
    dead: { bags: 0, value: 0 },
  };
  let bags = 0;
  let value = 0;
  let oldestDays = 0;
  let itemCount = 0;

  for (const item of sp.items) {
    const b = itemBags(item);
    if (b > 0) itemCount += 1;
    bags += b;
    value += itemValue(item);

    // Bucket each lot by its own age so a mixed item is split correctly.
    for (const lot of item.lots) {
      const d = daysSince(lot.addedAt, now);
      const bucket = ageBucket(d).key;
      byBucket[bucket].bags += lot.bags;
      byBucket[bucket].value += lot.bags * lot.perBag;
      if (d > oldestDays && lot.bags > 0) oldestDays = d;
    }
  }

  return {
    itemCount,
    bags,
    value,
    deadBags: byBucket.dead.bags,
    deadValue: byBucket.dead.value,
    oldestDays,
    byBucket,
  };
}

/* -------------------------------- mutations ------------------------------- */

function touch(sp: Stockpile, movements: StockMovement[]): Stockpile {
  return {
    ...sp,
    history: [...movements, ...sp.history].slice(0, MAX_HISTORY),
    updatedAt: new Date().toISOString(),
  };
}

export interface LotInput {
  name: string;
  bags: number;
  perBag: number;
  source: string;
  note?: string;
}

/** Same day + same source + same price folds into one lot. */
function sameLot(lot: StockLot, input: LotInput, dayKey: string): boolean {
  return (
    lot.perBag === input.perBag &&
    lot.source === input.source &&
    lot.addedAt.slice(0, 10) === dayKey
  );
}

/**
 * Add bags to the stockpile. Items are matched on their normalised name, and
 * identical batches are consolidated instead of piling up duplicate lots.
 */
export function addLots(
  sp: Stockpile,
  inputs: LotInput[],
  at: Date = new Date(),
): { stockpile: Stockpile; itemsTouched: number; bagsAdded: number } {
  const iso = at.toISOString();
  const dayKey = iso.slice(0, 10);
  const items = sp.items.map((i) => ({ ...i, lots: [...i.lots] }));
  const movements: StockMovement[] = [];
  let bagsAdded = 0;
  const touched = new Set<string>();

  for (const input of inputs) {
    const name = input.name.trim();
    const bags = Math.floor(Number(input.bags));
    const perBag = Number(input.perBag);
    if (!name || !Number.isFinite(bags) || bags <= 0) continue;
    if (!Number.isFinite(perBag) || perBag < 0) continue;

    const key = normalizeItemKey(name);
    let item = items.find((i) => i.key === key);
    if (!item) {
      item = { id: uid("i"), name, key, lots: [] };
      items.push(item);
    }

    const existing = item.lots.find((l) => sameLot(l, { ...input, perBag }, dayKey));
    if (existing) {
      existing.bags += bags;
    } else {
      item.lots.push({
        id: uid("l"),
        bags,
        perBag,
        source: input.source.trim(),
        addedAt: iso,
        note: input.note?.trim() || undefined,
      });
    }

    bagsAdded += bags;
    touched.add(item.id);
    movements.push({
      id: uid("m"),
      at: iso,
      kind: "in",
      itemName: item.name,
      bags,
      value: bags * perBag,
      reason: input.source.trim() || "Added manually",
    });
  }

  return {
    stockpile: touch({ ...sp, items }, movements),
    itemsTouched: touched.size,
    bagsAdded,
  };
}

export interface WithdrawResult {
  stockpile: Stockpile;
  /** Which lots were drawn from, oldest first. */
  consumed: Array<{ bags: number; perBag: number; source: string; addedAt: string }>;
  bags: number;
  value: number;
}

/**
 * Plan a FIFO withdrawal without changing anything - used to preview which
 * batches a sale would draw from before it is confirmed.
 */
export function planWithdrawal(
  item: StockItem,
  bags: number,
): { consumed: WithdrawResult["consumed"]; value: number; shortfall: number } {
  const wanted = Math.floor(Number(bags)) || 0;
  const sorted = [...item.lots]
    .filter((l) => l.bags > 0)
    .sort((a, b) => (a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : 0));

  const consumed: WithdrawResult["consumed"] = [];
  let remaining = wanted;
  let value = 0;
  for (const lot of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(lot.bags, remaining);
    consumed.push({
      bags: take,
      perBag: lot.perBag,
      source: lot.source,
      addedAt: lot.addedAt,
    });
    value += take * lot.perBag;
    remaining -= take;
  }
  return { consumed, value, shortfall: Math.max(0, remaining) };
}

/**
 * Remove bags from an item, oldest batch first. Throws if there aren't enough
 * bags, so stock can never go negative.
 */
export function withdraw(
  sp: Stockpile,
  itemId: string,
  bags: number,
  reason: string,
  at: Date = new Date(),
): WithdrawResult {
  const item = sp.items.find((i) => i.id === itemId);
  if (!item) throw new Error("That item is no longer in the stockpile.");

  const wanted = Math.floor(Number(bags));
  if (!Number.isFinite(wanted) || wanted <= 0) {
    throw new Error("Enter how many bags to remove.");
  }
  const available = itemBags(item);
  if (wanted > available) {
    throw new Error(
      `Only ${available} bag${available === 1 ? "" : "s"} of "${item.name}" in the stockpile.`,
    );
  }

  const plan = planWithdrawal(item, wanted);

  // Apply the plan: drain the oldest lots first and drop empty ones.
  const sorted = [...item.lots].sort((a, b) =>
    a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : 0,
  );
  let remaining = wanted;
  const nextLots: StockLot[] = [];
  for (const lot of sorted) {
    if (remaining > 0 && lot.bags > 0) {
      const take = Math.min(lot.bags, remaining);
      remaining -= take;
      const left = lot.bags - take;
      if (left > 0) nextLots.push({ ...lot, bags: left });
    } else {
      nextLots.push(lot);
    }
  }

  const items = sp.items.map((i) =>
    i.id === itemId ? { ...i, lots: nextLots } : i,
  );

  const movement: StockMovement = {
    id: uid("m"),
    at: at.toISOString(),
    kind: "out",
    itemName: item.name,
    bags: wanted,
    value: plan.value,
    reason: reason.trim() || "Removed",
  };

  return {
    stockpile: touch({ ...sp, items }, [movement]),
    consumed: plan.consumed,
    bags: wanted,
    value: plan.value,
  };
}

/** Move every lot from one item into another (for tidying up near-duplicates). */
export function mergeItems(
  sp: Stockpile,
  fromId: string,
  intoId: string,
): Stockpile {
  if (fromId === intoId) return sp;
  const from = sp.items.find((i) => i.id === fromId);
  const into = sp.items.find((i) => i.id === intoId);
  if (!from || !into) return sp;

  const items = sp.items
    .map((i) =>
      i.id === intoId ? { ...i, lots: [...i.lots, ...from.lots] } : i,
    )
    .filter((i) => i.id !== fromId);

  return {
    ...sp,
    items,
    updatedAt: new Date().toISOString(),
  };
}

export function renameItem(
  sp: Stockpile,
  itemId: string,
  name: string,
): Stockpile {
  const clean = name.trim();
  if (!clean) return sp;
  return {
    ...sp,
    items: sp.items.map((i) =>
      i.id === itemId ? { ...i, name: clean, key: normalizeItemKey(clean) } : i,
    ),
    updatedAt: new Date().toISOString(),
  };
}

export function removeItem(sp: Stockpile, itemId: string): Stockpile {
  const item = sp.items.find((i) => i.id === itemId);
  const next = { ...sp, items: sp.items.filter((i) => i.id !== itemId) };
  if (!item) return next;
  const bags = itemBags(item);
  return touch(
    next,
    bags > 0
      ? [
          {
            id: uid("m"),
            at: new Date().toISOString(),
            kind: "out",
            itemName: item.name,
            bags,
            value: itemValue(item),
            reason: "Item deleted",
          },
        ]
      : [],
  );
}

/** Drop items that have no bags left, keeping the list tidy. */
export function removeEmptyItems(sp: Stockpile): Stockpile {
  return {
    ...sp,
    items: sp.items.filter((i) => itemBags(i) > 0),
    updatedAt: new Date().toISOString(),
  };
}

/* --------------------------------- export --------------------------------- */

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * One row per lot, so a spreadsheet can pivot it any way you like while still
 * carrying the full batch detail (source and date).
 */
export function toCsv(sp: Stockpile, now: Date = new Date()): string {
  const lines = [
    [
      "Item",
      "Bags",
      "Per Bag",
      "Lot Value",
      "Source",
      "Date Added",
      "Age (days)",
    ]
      .map(csvCell)
      .join(","),
  ];

  for (const item of sp.items) {
    for (const lot of item.lots) {
      lines.push(
        [
          item.name,
          lot.bags,
          lot.perBag,
          lot.bags * lot.perBag,
          lot.source,
          lot.addedAt.slice(0, 10),
          daysSince(lot.addedAt, now),
        ]
          .map(csvCell)
          .join(","),
      );
    }
  }

  const totals = stockpileTotals(sp, now);
  lines.push("");
  lines.push([csvCell("Total"), totals.bags, "", totals.value].join(","));
  return lines.join("\n");
}

/** Human summary used in notices, e.g. "17 bags worth Rs340,000.00". */
export function describeBags(bags: number, value: number): string {
  return `${bags} bag${bags === 1 ? "" : "s"} worth ${formatLKR(value)}`;
}

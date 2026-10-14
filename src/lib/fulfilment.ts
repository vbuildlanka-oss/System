/**
 * Can every request be filled? Checking request sheets against a bag count.
 *
 * The Requests page checks one buyer at a time against "what is on hand", and
 * says so: two buyers wanting the same item both see the same stock figure.
 * That is the right answer for one buyer and the wrong one for the question
 * asked when a container has been counted: "here is everything we have, here is
 * everything everyone wants - does it go round, and if not, what is missing?"
 *
 * So this puts every request against the count together:
 *
 *   - Demand is what is still **outstanding** on each sheet (wanted minus
 *     already supplied). Bags that already went out are not wanted again.
 *   - Counts from several files add up, e.g. two containers counted separately.
 *   - Items match on the stockpile's normalised name, so `Anorak #2` on a sheet
 *     finds `Anorak 2` on the count.
 *   - Where demand exceeds the count, bags are shared out in the order the
 *     sheets are listed - first sheet first - so each buyer can be told exactly
 *     what they would get. Reorder the sheets to change who comes first.
 *   - **Not counted is not zero.** An item on the count that nobody reached is
 *     reported as unknown, and the check refuses to call everything fulfilled
 *     while a wanted item is unknown.
 *
 * Nothing here changes the stockpile, the request lists or the count. It is a
 * reading, kept with the request lists so it survives a refresh and travels in
 * the saved file.
 */

import { checkPhone, sanitizeLine } from "./buyer";
import { normalizeItemKey } from "./stockpile";
import { LIMITS, clampNumber } from "./types";

/* --------------------------------- model --------------------------------- */

export interface CheckCountRow {
  name: string;
  /** null when the count listed the item but nobody counted it. */
  counted: number | null;
}

/** One uploaded bag count. */
export interface CheckCount {
  id: string;
  /** The file it came from, so it is recognisable in the list. */
  name: string;
  /** Container or bay, when the count recorded one. */
  containerId: string;
  rows: CheckCountRow[];
  addedAt: string;
}

export interface CheckRequestItem {
  name: string;
  qty: number;
  supplied: number;
  perBag: number;
}

/** One buyer's request, as read from a sheet. */
export interface CheckRequest {
  id: string;
  buyerName: string;
  buyerPhone: string;
  /** Which file (or "Saved list") this came from. */
  from: string;
  items: CheckRequestItem[];
  addedAt: string;
}

export interface FulfilmentCheck {
  counts: CheckCount[];
  /** In priority order: the first sheet is served first when an item is short. */
  requests: CheckRequest[];
}

export const MAX_CHECK_COUNTS = 20;
export const MAX_CHECK_REQUESTS = 100;

export function emptyCheck(): FulfilmentCheck {
  return { counts: [], requests: [] };
}

let seq = 0;
function uid(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}`;
}

/* ------------------------------ construction ------------------------------ */

function toCountRows(
  rows: Array<{ name?: unknown; counted?: unknown }>,
): CheckCountRow[] {
  const out: CheckCountRow[] = [];
  for (const raw of rows) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const name = sanitizeLine(row.name, LIMITS.itemName);
    if (!name) continue;
    const counted =
      row.counted === null || row.counted === undefined || row.counted === ""
        ? null
        : Math.max(0, Math.floor(clampNumber(row.counted, LIMITS.qty)));
    out.push({ name, counted });
  }
  return out;
}

function toCheckItems(
  items: Array<{ name?: unknown; qty?: unknown; supplied?: unknown; perBag?: unknown }>,
): CheckRequestItem[] {
  const out: CheckRequestItem[] = [];
  for (const raw of items) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const name = sanitizeLine(row.name, LIMITS.itemName);
    if (!name) continue;
    const qty = Math.floor(clampNumber(row.qty, LIMITS.qty));
    if (qty <= 0) continue;
    const supplied = Math.min(qty, Math.max(0, Math.floor(clampNumber(row.supplied, LIMITS.qty))));
    out.push({ name, qty, supplied, perBag: clampNumber(row.perBag, LIMITS.money) });
  }
  return out;
}

export function createCheckCount(
  name: string,
  containerId: string,
  rows: Array<{ name?: unknown; counted?: unknown }>,
): CheckCount {
  return {
    id: uid("cc"),
    name: sanitizeLine(name, LIMITS.title) || "Bag count",
    containerId: sanitizeLine(containerId, 60),
    rows: toCountRows(rows),
    addedAt: new Date().toISOString(),
  };
}

export function createCheckRequest(input: {
  buyerName?: unknown;
  buyerPhone?: unknown;
  from?: unknown;
  items: Array<{ name?: unknown; qty?: unknown; supplied?: unknown; perBag?: unknown }>;
}): CheckRequest {
  return {
    id: uid("cr"),
    buyerName: sanitizeLine(input.buyerName, LIMITS.title) || "Buyer",
    buyerPhone: sanitizeLine(input.buyerPhone, 30),
    from: sanitizeLine(input.from, LIMITS.title),
    items: toCheckItems(input.items),
    addedAt: new Date().toISOString(),
  };
}

/* -------------------------------- mutation -------------------------------- */

/** Uploading the same count again replaces it rather than doubling the bags. */
export function addCheckCount(check: FulfilmentCheck, count: CheckCount): FulfilmentCheck {
  const others = check.counts.filter(
    (c) => c.name.toLowerCase() !== count.name.toLowerCase(),
  );
  return { ...check, counts: [...others, count].slice(0, MAX_CHECK_COUNTS) };
}

export function removeCheckCount(check: FulfilmentCheck, id: string): FulfilmentCheck {
  return { ...check, counts: check.counts.filter((c) => c.id !== id) };
}

/**
 * The same buyer on two sheets. A PDF prints `+94 77 123 4567` where the CSV
 * kept `0771234567`, so phones are compared the way the rest of the app does.
 * The same phone is the same buyer, as everywhere else; failing that, the same
 * name is, unless both carry phones and they differ.
 */
function sameBuyer(
  a: { buyerName: string; buyerPhone: string },
  b: { buyerName: string; buyerPhone: string },
): boolean {
  const pa = checkPhone(a.buyerPhone).e164;
  const pb = checkPhone(b.buyerPhone).e164;
  if (pa && pb) return pa === pb;
  const raw = (p: string) => p.replace(/\D/g, "");
  const phonesClash = raw(a.buyerPhone) !== "" && raw(b.buyerPhone) !== "" && raw(a.buyerPhone) !== raw(b.buyerPhone);
  return !phonesClash && a.buyerName.trim().toLowerCase() === b.buyerName.trim().toLowerCase();
}

/**
 * Add request sheets. A buyer already on the check (same name and phone) is
 * replaced in place, keeping their place in the queue, so re-uploading a newer
 * sheet does not count that buyer twice.
 */
export function addCheckRequests(
  check: FulfilmentCheck,
  incoming: CheckRequest[],
): { check: FulfilmentCheck; added: number; replaced: number } {
  let requests = [...check.requests];
  let added = 0;
  let replaced = 0;
  for (const req of incoming) {
    if (req.items.length === 0) continue;
    const at = requests.findIndex((r) => sameBuyer(r, req));
    if (at >= 0) {
      requests[at] = req;
      replaced += 1;
    } else {
      requests.push(req);
      added += 1;
    }
  }
  requests = requests.slice(0, MAX_CHECK_REQUESTS);
  return { check: { ...check, requests }, added, replaced };
}

export function removeCheckRequest(check: FulfilmentCheck, id: string): FulfilmentCheck {
  return { ...check, requests: check.requests.filter((r) => r.id !== id) };
}

/** Move a sheet up (-1) or down (+1) the queue. */
export function moveCheckRequest(
  check: FulfilmentCheck,
  id: string,
  by: -1 | 1,
): FulfilmentCheck {
  const from = check.requests.findIndex((r) => r.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= check.requests.length) return check;
  const requests = [...check.requests];
  const [moved] = requests.splice(from, 1);
  requests.splice(to, 0, moved);
  return { ...check, requests };
}

/* -------------------------------- analysis -------------------------------- */

/**
 * What the count says about an item.
 *
 *  counted   - at least one count has a figure for it
 *  uncounted - it is on a count, but nobody reached it
 *  missing   - it is on no count at all
 */
export type CountState = "counted" | "uncounted" | "missing";

export type ItemVerdict =
  /** Every bag wanted is there. */
  | "enough"
  /** Some bags are there, not enough. */
  | "short"
  /** Not one bag of it was counted. */
  | "none"
  /** Wanted, but the count cannot say how many there are. */
  | "unknown";

export interface ItemDemand {
  requestId: string;
  buyerName: string;
  wanted: number;
  /** Bags this buyer gets when the item is shared out in queue order. */
  allocated: number;
}

export interface ItemResult {
  key: string;
  name: string;
  /** Outstanding bags wanted across every sheet. */
  wanted: number;
  /** Bags counted, summed over every count file. */
  counted: number;
  countState: CountState;
  /** Count files that list this item without a figure. */
  uncountedIn: number;
  /** Bags missing: wanted minus counted, never below zero. */
  short: number;
  /** Bags left over once every request is met, never below zero. */
  spare: number;
  verdict: ItemVerdict;
  /** Highest per-bag price on the sheets, for valuing what is short. */
  perBag: number;
  demand: ItemDemand[];
}

export type BuyerVerdict = "full" | "part" | "none" | "nothing-outstanding";

export interface BuyerLine {
  name: string;
  key: string;
  wanted: number;
  allocated: number;
  short: number;
  perBag: number;
  /** The count alone has enough of this for this buyer. */
  aloneOk: boolean;
  /** Short only because sheets higher in the queue took the bags. */
  lostToQueue: boolean;
  verdict: ItemVerdict;
}

export interface BuyerResult {
  request: CheckRequest;
  /** Position in the queue, from 1. */
  position: number;
  lines: BuyerLine[];
  wanted: number;
  allocated: number;
  short: number;
  /** Value of what cannot be supplied, at the sheet's prices. */
  shortValue: number;
  /** The count would cover this sheet if it were the only one. */
  aloneOk: boolean;
  /** At least one wanted item has no figure on the count. */
  hasUnknown: boolean;
  verdict: BuyerVerdict;
}

export interface FulfilmentResult {
  items: ItemResult[];
  buyers: BuyerResult[];
  /** Counted items nobody asked for, or with bags left over. */
  spare: Array<{ key: string; name: string; spare: number; wanted: number }>;
  totals: {
    sheets: number;
    counts: number;
    wanted: number;
    counted: number;
    coverable: number;
    short: number;
    spare: number;
    shortValue: number;
    itemsWanted: number;
    itemsShort: number;
    itemsUnknown: number;
    buyersFull: number;
    buyersShort: number;
  };
  /**
   * Every outstanding bag on every sheet is on the count. False while anything
   * is short or uncounted, and false when there is nothing to check.
   */
  allFulfilled: boolean;
  /** There is both a count and at least one outstanding bag to check. */
  ready: boolean;
}

interface CountEntry {
  name: string;
  counted: number;
  hasFigure: boolean;
  uncountedIn: number;
}

function countIndex(counts: CheckCount[]): Map<string, CountEntry> {
  const map = new Map<string, CountEntry>();
  for (const file of counts) {
    for (const row of file.rows) {
      const key = normalizeItemKey(row.name);
      if (!key) continue;
      const entry =
        map.get(key) ?? { name: row.name, counted: 0, hasFigure: false, uncountedIn: 0 };
      if (row.counted === null) entry.uncountedIn += 1;
      else {
        entry.counted += row.counted;
        entry.hasFigure = true;
      }
      map.set(key, entry);
    }
  }
  return map;
}

function verdictFor(wanted: number, available: number, state: CountState, uncountedIn: number): ItemVerdict {
  if (wanted <= available) return "enough";
  // Short, but a count that never reached the item might hold the rest.
  if (state === "uncounted" || uncountedIn > 0) return "unknown";
  return available > 0 ? "short" : "none";
}

export function analyseFulfilment(check: FulfilmentCheck): FulfilmentResult {
  const index = countIndex(check.counts);

  // Demand, item by item, in queue order. A buyer naming the same item on two
  // lines is one demand for the combined figure.
  const items = new Map<string, ItemResult>();
  const perBuyer: Array<Map<string, { name: string; wanted: number; perBag: number }>> = [];

  for (const req of check.requests) {
    const mine = new Map<string, { name: string; wanted: number; perBag: number }>();
    for (const line of req.items) {
      const out = Math.max(0, line.qty - line.supplied);
      const key = normalizeItemKey(line.name);
      if (!key) continue;
      const had = mine.get(key);
      mine.set(key, {
        name: had?.name ?? line.name,
        wanted: (had?.wanted ?? 0) + out,
        perBag: Math.max(had?.perBag ?? 0, line.perBag),
      });
    }
    perBuyer.push(mine);

    mine.forEach((d, key) => {
      if (d.wanted <= 0) return;
      const entry = index.get(key);
      const item =
        items.get(key) ??
        ({
          key,
          // The count's spelling, when there is one: that is what is on the floor.
          name: entry?.name ?? d.name,
          wanted: 0,
          counted: entry?.counted ?? 0,
          countState: !entry ? "missing" : entry.hasFigure ? "counted" : "uncounted",
          uncountedIn: entry?.uncountedIn ?? 0,
          short: 0,
          spare: 0,
          verdict: "enough",
          perBag: 0,
          demand: [],
        } as ItemResult);
      item.wanted += d.wanted;
      item.perBag = Math.max(item.perBag, d.perBag);
      item.demand.push({ requestId: req.id, buyerName: req.buyerName, wanted: d.wanted, allocated: 0 });
      items.set(key, item);
    });
  }

  // Share each item out in queue order.
  items.forEach((item) => {
    let left = item.counted;
    for (const d of item.demand) {
      d.allocated = Math.min(d.wanted, left);
      left -= d.allocated;
    }
    item.short = Math.max(0, item.wanted - item.counted);
    item.spare = Math.max(0, item.counted - item.wanted);
    item.verdict = verdictFor(item.wanted, item.counted, item.countState, item.uncountedIn);
  });

  const buyers: BuyerResult[] = check.requests.map((req, i) => {
    const lines: BuyerLine[] = [];
    perBuyer[i].forEach((d, key) => {
      if (d.wanted <= 0) return;
      const item = items.get(key)!;
      const allocated = item.demand.find((x) => x.requestId === req.id)?.allocated ?? 0;
      const short = d.wanted - allocated;
      const aloneOk = item.counted >= d.wanted;
      lines.push({
        name: d.name,
        key,
        wanted: d.wanted,
        allocated,
        short,
        perBag: d.perBag,
        aloneOk,
        lostToQueue: short > 0 && aloneOk,
        verdict:
          short === 0
            ? "enough"
            : item.verdict === "unknown"
              ? "unknown"
              : allocated > 0
                ? "short"
                : "none",
      });
    });

    const wanted = lines.reduce((s, l) => s + l.wanted, 0);
    const allocated = lines.reduce((s, l) => s + l.allocated, 0);
    const short = wanted - allocated;
    return {
      request: req,
      position: i + 1,
      lines,
      wanted,
      allocated,
      short,
      shortValue: lines.reduce((s, l) => s + l.short * l.perBag, 0),
      aloneOk: lines.every((l) => l.aloneOk),
      hasUnknown: lines.some((l) => l.verdict === "unknown"),
      verdict:
        wanted === 0
          ? "nothing-outstanding"
          : short === 0
            ? "full"
            : allocated > 0
              ? "part"
              : "none",
    };
  });

  // Worst first: nothing at all, then short, then unknown, then fine.
  const rank: Record<ItemVerdict, number> = { none: 0, short: 1, unknown: 2, enough: 3 };
  const itemList = Array.from(items.values()).sort(
    (a, b) => rank[a.verdict] - rank[b.verdict] || b.short - a.short || a.name.localeCompare(b.name),
  );

  const spare: FulfilmentResult["spare"] = [];
  index.forEach((entry, key) => {
    const wanted = items.get(key)?.wanted ?? 0;
    const left = entry.counted - wanted;
    if (left > 0) spare.push({ key, name: entry.name, spare: left, wanted });
  });
  spare.sort((a, b) => b.spare - a.spare || a.name.localeCompare(b.name));

  let counted = 0;
  index.forEach((e) => (counted += e.counted));
  const wanted = itemList.reduce((s, i) => s + i.wanted, 0);
  const coverable = itemList.reduce((s, i) => s + Math.min(i.wanted, i.counted), 0);
  const short = wanted - coverable;
  const itemsShort = itemList.filter((i) => i.verdict === "short" || i.verdict === "none").length;
  const itemsUnknown = itemList.filter((i) => i.verdict === "unknown").length;
  const ready = check.counts.length > 0 && wanted > 0;

  return {
    items: itemList,
    buyers,
    spare,
    totals: {
      sheets: check.requests.length,
      counts: check.counts.length,
      wanted,
      counted,
      coverable,
      short,
      spare: spare.reduce((s, x) => s + x.spare, 0),
      shortValue: itemList.reduce((s, i) => s + i.short * i.perBag, 0),
      itemsWanted: itemList.length,
      itemsShort,
      itemsUnknown,
      buyersFull: buyers.filter((b) => b.verdict === "full" || b.verdict === "nothing-outstanding").length,
      buyersShort: buyers.filter((b) => b.verdict === "part" || b.verdict === "none").length,
    },
    allFulfilled: ready && short === 0 && itemsUnknown === 0,
    ready,
  };
}

/* ------------------------------ persistence ------------------------------ */

export function parseCheck(input: unknown): FulfilmentCheck {
  const raw = (input ?? {}) as Record<string, unknown>;
  const counts = (Array.isArray(raw.counts) ? raw.counts : [])
    .slice(0, MAX_CHECK_COUNTS)
    .map((entry, i) => {
      const c = (entry ?? {}) as Record<string, unknown>;
      return {
        id: String(c.id ?? uid("cc")),
        name: sanitizeLine(c.name, LIMITS.title) || `Bag count ${i + 1}`,
        containerId: sanitizeLine(c.containerId, 60),
        rows: toCountRows(Array.isArray(c.rows) ? c.rows : []),
        addedAt: String(c.addedAt ?? new Date().toISOString()),
      };
    })
    .filter((c) => c.rows.length > 0);

  const requests = (Array.isArray(raw.requests) ? raw.requests : [])
    .slice(0, MAX_CHECK_REQUESTS)
    .map((entry, i) => {
      const r = (entry ?? {}) as Record<string, unknown>;
      return {
        id: String(r.id ?? uid("cr")),
        buyerName: sanitizeLine(r.buyerName, LIMITS.title) || `Buyer ${i + 1}`,
        buyerPhone: sanitizeLine(r.buyerPhone, 30),
        from: sanitizeLine(r.from, LIMITS.title),
        items: toCheckItems(Array.isArray(r.items) ? r.items : []),
        addedAt: String(r.addedAt ?? new Date().toISOString()),
      };
    })
    .filter((r) => r.items.length > 0);

  return { counts, requests };
}

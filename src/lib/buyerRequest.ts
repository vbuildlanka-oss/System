/**
 * Buyer request lists: what a customer has asked for.
 *
 * Some buyers send through a list of what they need. This keeps those lists in
 * one place and answers the question that actually matters when one arrives:
 * "can I fill this from what I already have?"
 *
 * Each line records how many bags were asked for and how many have been
 * supplied so far. Outstanding is always derived from those two, never stored,
 * so a line cannot end up disagreeing with itself. Availability is read live
 * from the stockpile and matched on the same normalised item name the stockpile
 * uses, so "Anorak #2" on a buyer's list finds "Anorak 2" in stock.
 *
 * Everything lives in one JSON document: autosaved in the browser and
 * downloadable as a file.
 */

import { readLocal, writeLocal } from "./storage";
import { LIMITS, clampNumber } from "./types";
import { sanitizeLine, type Buyer } from "./buyer";
import {
  itemBags,
  normalizeItemKey,
  withdraw,
  type Stockpile,
} from "./stockpile";

export const REQUESTS_KEY = "balebook.buyerRequests.v1";
export const REQUEST_VERSION = 1;
export const MAX_REQUESTS = 100;

/* --------------------------------- model --------------------------------- */

export interface RequestItem {
  id: string;
  name: string;
  /** Bags the buyer asked for. */
  qty: number;
  /** Bags supplied so far. Never more than `qty`. */
  supplied: number;
  /**
   * Price per bag agreed with this buyer, in LKR.
   *
   * A request is a quote in the making, so unlike a bag manifest it does carry
   * money. Line and grand totals are always derived from this and the bag
   * counts, never stored, so a figure cannot drift from the rows above it.
   */
  perBag: number;
  note: string;
}

export interface BuyerRequest {
  id: string;
  buyer: Buyer;
  items: RequestItem[];
  /** Free text - delivery dates, terms, anything worth remembering. */
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/** A line in an uploaded container or order file. */
export interface SourceItem {
  name: string;
  qty: number;
  /** Price per bag from the file, or 0 when it carried no prices. */
  perBag: number;
}

/**
 * Somewhere bags can come from, other than the stockpile.
 *
 * Most stock is not sitting in the stockpile - it is in a container that has
 * arrived or is on the way. Uploading that order file makes it available to
 * check requests against. Sources are reference data: they are never altered by
 * supplying a line, because the file is a record of what shipped.
 */
export interface StockSource {
  id: string;
  /** Usually the order number from the file, e.g. "Sri Lanka Order 3 2026". */
  name: string;
  items: SourceItem[];
  addedAt: string;
}

export interface RequestDoc {
  app: "balebook-buyer-requests";
  version: number;
  requests: BuyerRequest[];
  /** Uploaded container/order files kept for availability checks. */
  sources: StockSource[];
  updatedAt: string;
}

export function emptyRequestDoc(): RequestDoc {
  return {
    app: "balebook-buyer-requests",
    version: REQUEST_VERSION,
    requests: [],
    sources: [],
    updatedAt: new Date().toISOString(),
  };
}

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

/* -------------------------------- derived -------------------------------- */

/** Bags still owed on a line. */
export function outstanding(item: RequestItem): number {
  return Math.max(0, item.qty - item.supplied);
}

/** What a line is worth at the agreed price. */
export function lineValue(item: RequestItem): number {
  return item.qty * item.perBag;
}

/** What has actually gone out on a line is worth. */
export function suppliedValue(item: RequestItem): number {
  return Math.min(item.supplied, item.qty) * item.perBag;
}

export interface RequestTotals {
  lines: number;
  requested: number;
  supplied: number;
  outstanding: number;
  /** Lines with nothing left to supply. */
  completeLines: number;
  /** Value of everything asked for, in LKR. */
  value: number;
  /** Value of what has been supplied so far. */
  suppliedValue: number;
  /** Value still to go out. */
  outstandingValue: number;
  /** True when at least one line has no price yet. */
  hasUnpriced: boolean;
}

export function requestTotals(request: BuyerRequest): RequestTotals {
  let requested = 0;
  let supplied = 0;
  let out = 0;
  let completeLines = 0;
  let value = 0;
  let suppliedVal = 0;
  let hasUnpriced = false;

  for (const item of request.items) {
    requested += item.qty;
    supplied += item.supplied;
    const o = outstanding(item);
    out += o;
    if (o === 0) completeLines += 1;
    value += lineValue(item);
    suppliedVal += suppliedValue(item);
    if (item.perBag <= 0) hasUnpriced = true;
  }

  return {
    lines: request.items.length,
    requested,
    supplied,
    outstanding: out,
    completeLines,
    value,
    suppliedValue: suppliedVal,
    outstandingValue: Math.max(0, value - suppliedVal),
    hasUnpriced,
  };
}

export type RequestStatus = "empty" | "open" | "partial" | "complete";

export function requestStatus(request: BuyerRequest): RequestStatus {
  if (request.items.length === 0) return "empty";
  const t = requestTotals(request);
  if (t.outstanding === 0) return "complete";
  return t.supplied > 0 ? "partial" : "open";
}

/* ----------------------------- availability ------------------------------ */

export type LineAvailability = "done" | "ready" | "part" | "none";

/**
 * Bags on hand, keyed by normalised item name.
 *
 * Using the same key the stockpile uses means a buyer writing "Anorak #2" is
 * matched against "Anorak 2" wherever it came from.
 */
export type Availability = Map<string, number>;

export function availabilityFromStockpile(stockpile: Stockpile): Availability {
  const map: Availability = new Map();
  for (const item of stockpile.items) {
    map.set(item.key, (map.get(item.key) ?? 0) + itemBags(item));
  }
  return map;
}

export function availabilityFromSource(source: StockSource): Availability {
  const map: Availability = new Map();
  for (const item of source.items) {
    const key = normalizeItemKey(item.name);
    map.set(key, (map.get(key) ?? 0) + item.qty);
  }
  return map;
}

/** Add several sources together, e.g. the stockpile plus every container. */
export function combineAvailability(parts: Availability[]): Availability {
  const map: Availability = new Map();
  for (const part of parts) {
    part.forEach((bags, key) => {
      map.set(key, (map.get(key) ?? 0) + bags);
    });
  }
  return map;
}

export interface LineMatch {
  item: RequestItem;
  outstanding: number;
  /** Bags of this item available from whichever source was supplied. */
  inStock: number;
  /** How many of the outstanding bags could be supplied right now. */
  canSupply: number;
  status: LineAvailability;
}

/**
 * Compare a request against whatever is available.
 *
 * Each line is looked up independently. If a buyer asks for the same item on
 * two lines, both report the same figure - this is "what is on hand", not a
 * reservation.
 */
export function matchRequest(
  request: BuyerRequest,
  available: Availability,
): LineMatch[] {
  return request.items.map((item) => {
    const out = outstanding(item);
    const inStock = available.get(normalizeItemKey(item.name)) ?? 0;
    const canSupply = Math.min(out, inStock);
    let status: LineAvailability;
    if (out === 0) status = "done";
    else if (inStock >= out) status = "ready";
    else if (inStock > 0) status = "part";
    else status = "none";
    return { item, outstanding: out, inStock, canSupply, status };
  });
}

/* -------------------------------- sources -------------------------------- */

export function toSourceItems(
  source: Array<{ name?: unknown; qty?: unknown; perBag?: unknown }>,
): SourceItem[] {
  const out: SourceItem[] = [];
  for (const raw of source) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const name = sanitizeLine(row.name, LIMITS.itemName);
    if (!name) continue;
    const qty = Math.max(1, Math.floor(clampNumber(row.qty, LIMITS.qty)));
    out.push({ name, qty, perBag: clampNumber(row.perBag, LIMITS.money) });
  }
  return out;
}

export function createSource(
  name: string,
  items: Array<{ name?: unknown; qty?: unknown }>,
): StockSource {
  return {
    id: uid("src"),
    name: sanitizeLine(name, LIMITS.title) || "Container",
    items: toSourceItems(items),
    addedAt: new Date().toISOString(),
  };
}

export function sourceTotal(source: StockSource): number {
  return source.items.reduce((s, i) => s + i.qty, 0);
}

export function addSource(doc: RequestDoc, source: StockSource): RequestDoc {
  // Re-uploading the same container replaces it rather than doubling it up.
  const others = doc.sources.filter(
    (s) => s.name.toLowerCase() !== source.name.toLowerCase(),
  );
  return {
    ...doc,
    sources: [source, ...others].slice(0, 50),
    updatedAt: new Date().toISOString(),
  };
}

export function removeSource(doc: RequestDoc, id: string): RequestDoc {
  return {
    ...doc,
    sources: doc.sources.filter((s) => s.id !== id),
    updatedAt: new Date().toISOString(),
  };
}

export interface MatchSummary {
  /** Lines that can be filled completely from stock right now. */
  ready: number;
  /** Lines that can be filled only partly. */
  part: number;
  /** Lines with none of that item in stock. */
  none: number;
  done: number;
  /** Outstanding bags that could be supplied from stock right now. */
  canSupplyBags: number;
}

export function matchSummary(matches: LineMatch[]): MatchSummary {
  const summary: MatchSummary = {
    ready: 0,
    part: 0,
    none: 0,
    done: 0,
    canSupplyBags: 0,
  };
  for (const m of matches) {
    summary[m.status] += 1;
    summary.canSupplyBags += m.canSupply;
  }
  return summary;
}

/* -------------------------------- mutation -------------------------------- */

function touch(doc: RequestDoc, requests: BuyerRequest[]): RequestDoc {
  return { ...doc, requests, updatedAt: new Date().toISOString() };
}

/** Present for readability in exports and notices. */
export const STOCKPILE_SOURCE_ID = "stockpile";
export const ALL_SOURCES_ID = "all";

export function createRequest(
  buyer: Buyer,
  items: Array<{
    name?: unknown;
    qty?: unknown;
    note?: unknown;
    perBag?: unknown;
    supplied?: unknown;
  }> = [],
): BuyerRequest {
  const now = new Date().toISOString();
  return {
    id: uid("br"),
    buyer: {
      name: sanitizeLine(buyer.name, LIMITS.title),
      phone: sanitizeLine(buyer.phone, 30),
    },
    items: toRequestItems(items),
    notes: "",
    createdAt: now,
    updatedAt: now,
  };
}

export function toRequestItems(
  source: Array<{
    name?: unknown;
    qty?: unknown;
    note?: unknown;
    supplied?: unknown;
    perBag?: unknown;
  }>,
): RequestItem[] {
  const out: RequestItem[] = [];
  for (const raw of source) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const name = sanitizeLine(row.name, LIMITS.itemName);
    if (!name) continue;
    const qty = Math.max(1, Math.floor(clampNumber(row.qty, LIMITS.qty)));
    // Supplied can never exceed what was asked for.
    const supplied = Math.min(
      qty,
      Math.floor(clampNumber(row.supplied, LIMITS.qty)),
    );
    out.push({
      id: String(row.id ?? uid("ri")),
      name,
      qty,
      supplied,
      perBag: clampNumber(row.perBag, LIMITS.money),
      note: sanitizeLine(row.note, 120),
    });
  }
  return out;
}

export function upsertRequest(
  doc: RequestDoc,
  request: BuyerRequest,
): RequestDoc {
  const exists = doc.requests.some((r) => r.id === request.id);
  const stamped = { ...request, updatedAt: new Date().toISOString() };
  return touch(
    doc,
    exists
      ? doc.requests.map((r) => (r.id === request.id ? stamped : r))
      : [stamped, ...doc.requests].slice(0, MAX_REQUESTS),
  );
}

export function removeRequest(doc: RequestDoc, id: string): RequestDoc {
  return touch(
    doc,
    doc.requests.filter((r) => r.id !== id),
  );
}

/** Record bags as supplied without touching the stockpile. */
export function markSupplied(
  request: BuyerRequest,
  itemId: string,
  bags: number,
): BuyerRequest {
  const wanted = Math.floor(Number(bags));
  if (!Number.isFinite(wanted) || wanted === 0) {
    throw new Error("Enter how many bags to record.");
  }
  const item = request.items.find((i) => i.id === itemId);
  if (!item) throw new Error("That line is no longer on the request.");

  const next = item.supplied + wanted;
  if (next < 0) throw new Error("That would take supplied below zero.");
  if (next > item.qty) {
    throw new Error(
      `Only ${outstanding(item)} bag(s) of "${item.name}" are still outstanding.`,
    );
  }

  return {
    ...request,
    items: request.items.map((i) =>
      i.id === itemId ? { ...i, supplied: next } : i,
    ),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Supply bags from the stockpile: takes them out of stock (oldest batch first)
 * and records them against the request in one step, so the two cannot drift
 * apart. Throws before changing anything if the numbers do not work.
 */
export function supplyFromStockpile(
  request: BuyerRequest,
  stockpile: Stockpile,
  itemId: string,
  bags: number,
): { request: BuyerRequest; stockpile: Stockpile; value: number } {
  const item = request.items.find((i) => i.id === itemId);
  if (!item) throw new Error("That line is no longer on the request.");

  const wanted = Math.floor(Number(bags));
  if (!Number.isFinite(wanted) || wanted <= 0) {
    throw new Error("Enter how many bags to supply.");
  }
  const out = outstanding(item);
  if (wanted > out) {
    throw new Error(
      `Only ${out} bag(s) of "${item.name}" are still outstanding.`,
    );
  }

  const key = normalizeItemKey(item.name);
  const stockItem = stockpile.items.find((s) => s.key === key);
  if (!stockItem) {
    throw new Error(`"${item.name}" is not in the stockpile.`);
  }

  // withdraw() refuses to go negative, so this cannot oversupply.
  const result = withdraw(
    stockpile,
    stockItem.id,
    wanted,
    `Supplied to ${request.buyer.name.trim() || "buyer"}`,
  );

  return {
    request: markSupplied(request, itemId, wanted),
    stockpile: result.stockpile,
    value: result.value,
  };
}

/* ------------------------------ persistence ------------------------------ */

export function parseRequestDoc(input: unknown): RequestDoc {
  const raw = (input ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(raw.requests) ? raw.requests : [];

  const requests: BuyerRequest[] = entries
    .slice(0, MAX_REQUESTS)
    .map((entry, i) => {
      const r = (entry ?? {}) as Record<string, unknown>;
      const buyer = (r.buyer ?? {}) as Record<string, unknown>;
      const now = new Date().toISOString();
      return {
        id: String(r.id ?? uid("br")),
        buyer: {
          name: sanitizeLine(buyer.name, LIMITS.title) || `Buyer ${i + 1}`,
          phone: sanitizeLine(buyer.phone, 30),
        },
        items: toRequestItems(Array.isArray(r.items) ? r.items : []),
        notes: sanitizeLine(r.notes, LIMITS.subtitle),
        createdAt: String(r.createdAt ?? now),
        updatedAt: String(r.updatedAt ?? now),
      };
    });

  const rawSources = Array.isArray(raw.sources) ? raw.sources : [];
  const sources: StockSource[] = rawSources
    .slice(0, 50)
    .map((entry, i) => {
      const s = (entry ?? {}) as Record<string, unknown>;
      return {
        id: String(s.id ?? uid("src")),
        name: sanitizeLine(s.name, LIMITS.title) || `Container ${i + 1}`,
        items: toSourceItems(Array.isArray(s.items) ? s.items : []),
        addedAt: String(s.addedAt ?? new Date().toISOString()),
      };
    })
    .filter((s) => s.items.length > 0);

  return {
    app: "balebook-buyer-requests",
    version: Number(raw.version) || REQUEST_VERSION,
    requests,
    sources,
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
  };
}

export function loadRequests(): RequestDoc {
  if (typeof window === "undefined") return emptyRequestDoc();
  try {
    const raw = readLocal(REQUESTS_KEY);
    if (!raw) return emptyRequestDoc();
    return parseRequestDoc(JSON.parse(raw));
  } catch {
    return emptyRequestDoc();
  }
}

export function saveRequests(doc: RequestDoc): void {
  writeLocal(REQUESTS_KEY, JSON.stringify(doc));
}

/* --------------------------------- export --------------------------------- */

/**
 * `<Buyer> - Requested Bags.pdf`
 *
 * Lives here rather than beside the PDF renderer so the page can name a
 * download without pulling the whole PDF library into the browser bundle.
 */
export function requestPdfFilename(buyerName: string): string {
  const base = String(buyerName ?? "")
    .replace(/[^\w\d\- ]+/g, "")
    .trim();
  return `${base || "Buyer"} - Requested Bags.pdf`;
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per requested line, across every buyer. */
export function requestsToCsv(
  requests: BuyerRequest[],
  available?: Availability,
): string {
  const header = [
    "Buyer",
    "Phone",
    "Item",
    "Requested",
    "Supplied",
    "Outstanding",
    "Available",
    "Per Bag",
    "Total",
    "Note",
  ];
  const lines = [header.map(csvCell).join(",")];

  for (const request of requests) {
    const matches = available ? matchRequest(request, available) : null;
    request.items.forEach((item, i) => {
      lines.push(
        [
          request.buyer.name,
          request.buyer.phone,
          item.name,
          item.qty,
          item.supplied,
          outstanding(item),
          matches ? matches[i].inStock : "",
          item.perBag,
          lineValue(item),
          item.note,
        ]
          .map(csvCell)
          .join(","),
      );
    });
  }
  return lines.join("\n");
}

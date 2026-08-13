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

export interface RequestDoc {
  app: "balebook-buyer-requests";
  version: number;
  requests: BuyerRequest[];
  updatedAt: string;
}

export function emptyRequestDoc(): RequestDoc {
  return {
    app: "balebook-buyer-requests",
    version: REQUEST_VERSION,
    requests: [],
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

export interface RequestTotals {
  lines: number;
  requested: number;
  supplied: number;
  outstanding: number;
  /** Lines with nothing left to supply. */
  completeLines: number;
}

export function requestTotals(request: BuyerRequest): RequestTotals {
  let requested = 0;
  let supplied = 0;
  let out = 0;
  let completeLines = 0;
  for (const item of request.items) {
    requested += item.qty;
    supplied += item.supplied;
    const o = outstanding(item);
    out += o;
    if (o === 0) completeLines += 1;
  }
  return {
    lines: request.items.length,
    requested,
    supplied,
    outstanding: out,
    completeLines,
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

export interface LineMatch {
  item: RequestItem;
  outstanding: number;
  /** Bags of this item currently in the stockpile. */
  inStock: number;
  /** How many of the outstanding bags could be supplied right now. */
  canSupply: number;
  status: LineAvailability;
}

/**
 * Compare a request against the stockpile.
 *
 * Note the stockpile is consulted per line independently. If a buyer asks for
 * the same item on two lines, both will report the same stock - the figures are
 * "what is on the shelf", not a reservation.
 */
export function matchRequest(
  request: BuyerRequest,
  stockpile: Stockpile,
): LineMatch[] {
  const stock = new Map<string, number>();
  for (const item of stockpile.items) {
    const bags = itemBags(item);
    stock.set(item.key, (stock.get(item.key) ?? 0) + bags);
  }

  return request.items.map((item) => {
    const out = outstanding(item);
    const inStock = stock.get(normalizeItemKey(item.name)) ?? 0;
    const canSupply = Math.min(out, inStock);
    let status: LineAvailability;
    if (out === 0) status = "done";
    else if (inStock >= out) status = "ready";
    else if (inStock > 0) status = "part";
    else status = "none";
    return { item, outstanding: out, inStock, canSupply, status };
  });
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

export function createRequest(
  buyer: Buyer,
  items: Array<{ name?: unknown; qty?: unknown; note?: unknown }> = [],
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
  source: Array<{ name?: unknown; qty?: unknown; note?: unknown; supplied?: unknown }>,
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

  return {
    app: "balebook-buyer-requests",
    version: Number(raw.version) || REQUEST_VERSION,
    requests,
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

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per requested line, across every buyer. */
export function requestsToCsv(
  requests: BuyerRequest[],
  stockpile?: Stockpile,
): string {
  const header = [
    "Buyer",
    "Phone",
    "Item",
    "Requested",
    "Supplied",
    "Outstanding",
    "In Stockpile",
    "Note",
  ];
  const lines = [header.map(csvCell).join(",")];

  for (const request of requests) {
    const matches = stockpile ? matchRequest(request, stockpile) : null;
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
          item.note,
        ]
          .map(csvCell)
          .join(","),
      );
    });
  }
  return lines.join("\n");
}

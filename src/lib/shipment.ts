/**
 * A shipment: an order number and a container ID.
 *
 * These two are the spine the whole system organises itself around. Every
 * document belongs to an order, most belong to a container, and everything worth
 * finding later is found by one or the other. So they are defined once, here,
 * rather than being retyped per page:
 *
 *   read out of an uploaded file name        shipmentFromFilename
 *   printed the same way on every document   shipmentLabel
 *   named the same way in every download     shipmentFilename
 *   suggested from what the system knows     collectShipmentValues
 *
 * A section may use one key without the other - the price list starts with only
 * an order number, general overhead on the balance sheet has no container - so
 * both are optional everywhere, and every function here copes with a blank.
 */

import { orderNumberFromFilename } from "./bagManifest";
import { checkContainerNumber, normalizeContainerNumber } from "./container";
import { documentFilename } from "./types";

export interface Shipment {
  /** e.g. "Sri Lanka Order 03". May be empty. */
  orderNumber: string;
  /** e.g. "GAOU7441740". May be empty. */
  containerId: string;
}

export const EMPTY_SHIPMENT: Shipment = { orderNumber: "", containerId: "" };

/**
 * An ISO 6346 code sitting in a file name: four letters then seven digits.
 *
 * Separators are allowed anywhere between the digits, because a container is
 * written by hand in several ways - GAOU7441740, "GAOU 744174-0" (the six-digit
 * serial and the check digit split off), gaou_744174_0. The digits are pulled out
 * and rejoined rather than matched in fixed groups.
 *
 * The lookahead refuses a run of more than seven digits, so a longer number does
 * not have its first seven taken and passed off as a container.
 */
const CONTAINER_IN_TEXT =
  /\b([A-Za-z]{4})[\s\-_]*((?:\d[\s\-_]*){7})(?![\s\-_]*\d)/;

/**
 * The container ID written in a file name, or "".
 *
 * Only a code whose check digit adds up is accepted. Four letters followed by
 * seven digits is a specific enough shape that a false positive is unlikely, but
 * a phone number or a date range should not be turned into a container.
 */
export function containerFromFilename(filename: string): string {
  const text = String(filename ?? "").replace(/\.[^.]+$/, "");
  const match = CONTAINER_IN_TEXT.exec(text);
  if (!match) return "";

  // Separators are stripped here rather than left to normalizeContainerNumber,
  // which keeps underscores: they are word characters, so "gaou_744174_0" would
  // otherwise survive as an eleven-character code that fails its check digit.
  const candidate = normalizeContainerNumber(
    `${match[1]}${match[2]}`.replace(/[^A-Za-z0-9]/g, ""),
  );
  const check = checkContainerNumber(candidate);
  // ok covers the shape; checkDigitValid is what separates a real code from
  // eleven characters that happen to look like one.
  return check.ok && check.checkDigitValid ? check.value : "";
}

/**
 * Both keys, read out of an uploaded file name.
 *
 * The container is found and removed *before* the order number is worked out.
 * Without that, "GAOU7441740 - Sri Lanka Order 3.pdf" would take 7441740 as the
 * order number, because it is the first number in the name.
 */
export function shipmentFromFilename(filename: string): Shipment {
  const name = String(filename ?? "");
  const containerId = containerFromFilename(name);

  const withoutContainer =
    containerId === "" ? name : name.replace(CONTAINER_IN_TEXT, " ");

  return {
    orderNumber: orderNumberFromFilename(withoutContainer),
    containerId,
  };
}

/** Trim and normalise whatever was typed into the two fields. */
export function cleanShipment(input: {
  orderNumber?: unknown;
  containerId?: unknown;
}): Shipment {
  return {
    orderNumber: String(input.orderNumber ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    containerId: normalizeContainerNumber(input.containerId),
  };
}

/**
 * How a shipment reads on screen: "Sri Lanka Order 03 - GAOU7441740".
 *
 * Falls back to whichever key exists, so a document with only one of them is
 * still labelled rather than showing a stray dash.
 */
export function shipmentLabel(shipment: Shipment, separator = " - "): string {
  return [shipment.orderNumber, shipment.containerId]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(separator);
}

/**
 * `<Order number> - <Container> - <Document>.<ext>`
 *
 * The convention the bag manifests already used, applied to everything, so a
 * folder of downloads sorts by order and every file for one container sits
 * together. Missing parts are dropped rather than leaving "Order -  - Bags".
 */
export function shipmentFilename(
  shipment: Shipment,
  label: string,
  ext = "pdf",
): string {
  const stem = shipmentLabel(shipment);
  return documentFilename(stem, label, ext);
}

/** The line printed under a document title, or "" when there is no container. */
export function containerLine(containerId: string): string {
  const value = containerId.trim();
  return value === "" ? "" : `Container Number: ${value}`;
}

/* ------------------------------- suggestions ------------------------------ */

export interface ShipmentValues {
  orderNumbers: string[];
  containerIds: string[];
}

function pushUnique(into: string[], value: unknown, normalise = false): void {
  if (typeof value !== "string") return;
  const clean = normalise
    ? normalizeContainerNumber(value)
    : value.replace(/\s+/g, " ").trim();
  if (clean === "") return;
  if (!into.some((existing) => existing.toLowerCase() === clean.toLowerCase())) {
    into.push(clean);
  }
}

/**
 * Every order number and container ID the system already knows about.
 *
 * Fed whatever documents the caller has to hand, and deliberately forgiving
 * about their shape: this is for filling a suggestion list, so a document from an
 * older version missing a field should quietly contribute nothing rather than
 * stopping the others from being read.
 *
 * The payoff is that a container typed once anywhere - on a manifest, against an
 * expense, on a request - can be picked from a list everywhere else, instead of
 * being retyped and mistyped.
 */
export function collectShipmentValues(sources: {
  manifests?: unknown;
  balance?: unknown;
  requests?: unknown;
  stockpile?: unknown;
  editor?: unknown;
}): ShipmentValues {
  const orderNumbers: string[] = [];
  const containerIds: string[] = [];

  const arrayAt = (doc: unknown, field: string): unknown[] => {
    if (!doc || typeof doc !== "object") return [];
    const value = (doc as Record<string, unknown>)[field];
    return Array.isArray(value) ? value : [];
  };
  const field = (row: unknown, name: string): unknown =>
    row && typeof row === "object"
      ? (row as Record<string, unknown>)[name]
      : undefined;

  // Bag manifests carry both keys already.
  for (const manifest of arrayAt(sources.manifests, "manifests")) {
    pushUnique(orderNumbers, field(manifest, "orderNumber"));
    pushUnique(containerIds, field(manifest, "containerNumber"), true);
  }

  // The balance sheet knows every container that has cost or earned money.
  for (const expense of arrayAt(sources.balance, "expenses")) {
    pushUnique(containerIds, field(expense, "containerId"), true);
  }
  for (const entry of arrayAt(sources.balance, "turnover")) {
    pushUnique(containerIds, field(entry, "containerId"), true);
  }

  // Requests name their uploaded container files.
  for (const source of arrayAt(sources.requests, "sources")) {
    pushUnique(containerIds, field(source, "containerId"), true);
    pushUnique(orderNumbers, field(source, "orderNumber"));
  }

  // Open order sheets are named by their order number.
  for (const sheet of arrayAt(sources.editor, "sheets")) {
    pushUnique(orderNumbers, field(sheet, "title"));
  }

  // Stockpile lots record where the bags came from.
  for (const item of arrayAt(sources.stockpile, "items")) {
    for (const lot of arrayAt(item, "lots")) {
      pushUnique(orderNumbers, field(lot, "source"));
    }
  }

  orderNumbers.sort((a, b) => a.localeCompare(b));
  containerIds.sort((a, b) => a.localeCompare(b));
  return { orderNumbers, containerIds };
}

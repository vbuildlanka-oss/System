/**
 * CSV and XLSX order sheets.
 *
 * Both formats reduce to a grid of cells, so they share one interpreter. It is
 * written to cope with real exports rather than a fixed template: the header
 * row can sit anywhere near the top, columns can appear in any order, money may
 * be formatted as "Rs35,000.00" or a bare number, and a trailing Total row is
 * recognised and used to sanity-check the parse.
 */

import type { OrderItem, ParsedOrder } from "./types";

export type Cell = string | number | null | undefined;

/* ---------------------------------- CSV ---------------------------------- */

/**
 * Split CSV text into rows of cells, honouring quoted fields, escaped quotes
 * and newlines inside quotes.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Strip a UTF-8 byte order mark, which Excel likes to add.
  const src = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* -------------------------------- helpers -------------------------------- */

function cellText(cell: Cell): string {
  if (cell === null || cell === undefined) return "";
  return String(cell).trim();
}

/** "Rs35,000.00" | "35 000" | 35000 -> 35000, or null when not a number. */
function cellNumber(cell: Cell): number | null {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  const text = cellText(cell);
  if (text === "") return null;
  const cleaned = text.replace(/[^\d.-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isBlankRow(row: Cell[]): boolean {
  return !row.some((c) => cellText(c) !== "");
}

const NAME_RE = /^(item\s*name|item|description|product)$/i;
const QTY_RE = /^(quantity|qty|bags|no\.?\s*of\s*bags)$/i;
const PER_BAG_RE = /^(per\s*bag|price\s*per\s*bag|unit\s*price|rate)$/i;
const TOTAL_RE = /^(total|amount|line\s*total)$/i;

interface HeaderInfo {
  index: number;
  name: number;
  qty: number;
  perBag: number;
  total: number;
}

/** Locate the header row and work out which column is which. */
function findHeader(rows: Cell[][]): HeaderInfo | null {
  const limit = Math.min(rows.length, 25);
  for (let r = 0; r < limit; r += 1) {
    const row = rows[r];
    let name = -1;
    let qty = -1;
    let perBag = -1;
    let total = -1;

    row.forEach((cell, c) => {
      const text = cellText(cell);
      if (name === -1 && NAME_RE.test(text)) name = c;
      else if (qty === -1 && QTY_RE.test(text)) qty = c;
      else if (perBag === -1 && PER_BAG_RE.test(text)) perBag = c;
      else if (total === -1 && TOTAL_RE.test(text)) total = c;
    });

    if (name !== -1 && qty !== -1) {
      return { index: r, name, qty, perBag, total };
    }
  }
  return null;
}

/* --------------------------------- parse --------------------------------- */

/**
 * Interpret a grid as an order.
 *
 * `fallbackTitle` is used when the sheet has no title line of its own - the
 * uploaded file name is a sensible choice.
 */
export function parseTabularOrder(
  rows: Cell[][],
  fallbackTitle: string,
): ParsedOrder {
  const header = findHeader(rows);

  // Without a recognisable header, assume the plain shape used by the order
  // sheets in this business: name, quantity, per bag, total.
  const cols: HeaderInfo = header ?? {
    index: -1,
    name: 0,
    qty: 1,
    perBag: 2,
    total: 3,
  };

  // A row above the header carrying a single distinct value is the sheet title.
  //
  // "Distinct" rather than "one filled cell" because a title is often merged
  // across the table width, and a merged range reports the same value in every
  // cell it covers.
  let title = "";
  for (let r = 0; r < Math.max(cols.index, 0); r += 1) {
    const values = rows[r].map(cellText).filter((t) => t !== "");
    const distinct = Array.from(new Set(values));
    if (distinct.length === 1) {
      title = distinct[0];
      break;
    }
  }
  if (!title) title = fallbackTitle;

  const items: OrderItem[] = [];
  let printedTotal: number | null = null;
  let printedQty: number | null = null;

  for (let r = cols.index + 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (isBlankRow(row)) continue;

    const first = cellText(row[cols.name]);

    // A trailing "Total" row closes the table and gives us a figure to check
    // our own arithmetic against.
    if (/^total$/i.test(first)) {
      printedQty = cellNumber(row[cols.qty]);
      printedTotal =
        (cols.total >= 0 ? cellNumber(row[cols.total]) : null) ??
        cellNumber(row[row.length - 1]);
      continue;
    }

    const qty = cellNumber(row[cols.qty]);
    if (!first || qty === null || qty <= 0) continue;

    const perBag = cols.perBag >= 0 ? cellNumber(row[cols.perBag]) : null;
    items.push({ name: first, qty, perBag: perBag ?? 0 });
  }

  let totalQty = 0;
  let computedTotal = 0;
  for (const item of items) {
    totalQty += item.qty;
    computedTotal += item.qty * item.perBag;
  }

  const totalsMatch =
    printedTotal === null
      ? true
      : Math.abs(printedTotal - computedTotal) < 1 &&
        (printedQty === null || printedQty === totalQty);

  return { title, items, totalQty, computedTotal, printedTotal, totalsMatch };
}

/** Parse a CSV upload. */
export function parseCsvOrder(
  text: string,
  fallbackTitle: string,
): ParsedOrder {
  return parseTabularOrder(parseCsv(text), fallbackTitle);
}

/** Parse an XLSX upload. Reads the first worksheet. */
export async function parseXlsxOrder(
  buffer: Buffer,
  fallbackTitle: string,
): Promise<ParsedOrder> {
  // Imported lazily so the spreadsheet library is only loaded when a
  // spreadsheet is actually uploaded.
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return {
      title: fallbackTitle,
      items: [],
      totalQty: 0,
      computedTotal: 0,
      printedTotal: null,
      totalsMatch: true,
    };
  }

  const rows: Cell[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const cells: Cell[] = [];
    const count = Math.max(row.cellCount, 4);
    for (let c = 1; c <= count; c += 1) {
      const value = row.getCell(c).value;
      if (value === null || value === undefined) {
        cells.push("");
      } else if (typeof value === "object") {
        // Formulas and rich text arrive as objects; take the computed result.
        const v = value as { result?: unknown; text?: unknown };
        cells.push(
          v.result !== undefined
            ? (v.result as Cell)
            : v.text !== undefined
              ? String(v.text)
              : "",
        );
      } else {
        cells.push(value as Cell);
      }
    }
    rows.push(cells);
  });

  return parseTabularOrder(rows, fallbackTitle);
}

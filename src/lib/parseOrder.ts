import type { OrderItem, ParsedOrder } from "./types";

// Import the implementation file directly. The pdf-parse index module runs a
// debug harness that tries to read a sample file; importing the lib path skips
// that and is the recommended way to use it inside a server bundle.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdf = require("pdf-parse/lib/pdf-parse.js");

/**
 * pdf-parse ships several pdf.js engines. The default one occasionally rejects
 * perfectly valid documents with "bad XRef entry" - small PDFs produced by this
 * app were one example - and the failure is not even consistent between runs.
 *
 * Rather than trust a single engine, we try them in turn. The default comes
 * first because it is the one proven against the real supplier sheets; the
 * others are only reached if it fails or finds no text at all.
 */
const ENGINES = ["v1.10.100", "v2.0.550", "v1.10.88", "v1.9.426"] as const;

async function extractText(buffer: Buffer): Promise<string> {
  let emptyResult: string | null = null;
  let lastError: unknown = null;

  for (const version of ENGINES) {
    try {
      const data = await pdf(buffer, { version });
      const text = String(data?.text ?? "");
      if (text.trim() !== "") return text;
      // Readable but no text: remember it, another engine may do better.
      emptyResult = text;
    } catch (err) {
      lastError = err;
    }
  }

  // Every engine agreed there is no text (likely a scan) - let the caller
  // report "no items found" rather than a hard failure.
  if (emptyResult !== null) return emptyResult;

  throw lastError instanceof Error
    ? lastError
    : new Error("Could not read the PDF.");
}

/** "Rs35,000.00" | "35,000.00" -> 35000 */
function parseMoney(text: string): number {
  return Number(text.replace(/[^\d.]/g, ""));
}

/**
 * pdf-parse concatenates the cells of a row with no separators, e.g.
 *   "3/4 Jeans14Rs35,000.00Rs490,000.00"
 *   "Anorak 29Rs17,000.00Rs153,000.00"   (name "Anorak 2", qty 9)
 *
 * The two "Rs" amounts are unambiguous (per-bag price, then line total).
 * Everything before the first "Rs" is "<name><qty>" run together. Because
 * item names can themselves end in a digit (e.g. "Anorak 2"), we cannot
 * simply grab trailing digits as the quantity. Instead we derive the
 * quantity from total / perBag and strip exactly that many characters.
 */
const ROW_RE = /^(.+?)Rs\s*([\d,]+(?:\.\d+)?)\s*Rs\s*([\d,]+(?:\.\d+)?)$/;

/**
 * Matches the grand-total footer such as:
 *   "Total733Rs17,878,000.00"  or  "Total 733 Rs17,878,000.00"
 */
const TOTAL_RE = /^Total\s*(\d+)\s*Rs\s*([\d,]+(?:\.\d+)?)$/i;

const HEADER_RE = /^item\s*name\b/i;

/**
 * Split a "<name><qty>" prefix into its name and quantity, using the line
 * total and per-bag price to determine the true quantity.
 */
function splitNameAndQty(
  prefix: string,
  perBag: number,
  total: number,
): { name: string; qty: number } | null {
  const trimmed = prefix.trim();

  // Primary strategy: qty = total / perBag (the source data is exact).
  if (perBag > 0) {
    const derived = Math.round(total / perBag);
    if (derived > 0 && Math.abs(derived * perBag - total) < 1) {
      const qtyStr = String(derived);
      const compact = trimmed.replace(/\s+$/, "");
      if (compact.endsWith(qtyStr)) {
        const name = compact.slice(0, compact.length - qtyStr.length).trim();
        if (name) return { name, qty: derived };
      }
    }
  }

  // Fallback: take the trailing run of digits as the quantity.
  const m = trimmed.match(/^(.*?)(\d+)$/);
  if (m && m[1].trim()) {
    return { name: m[1].trim(), qty: Number(m[2]) };
  }
  return null;
}

export async function parseOrderPdf(buffer: Buffer): Promise<ParsedOrder> {
  const text = await extractText(buffer);
  const rawLines: string[] = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const items: OrderItem[] = [];
  let title = "";
  let printedTotal: number | null = null;
  let printedQty: number | null = null;

  for (const line of rawLines) {
    // Grand-total footer
    const totalMatch = line.match(TOTAL_RE);
    if (totalMatch) {
      printedQty = Number(totalMatch[1]);
      printedTotal = parseMoney(totalMatch[2]);
      continue;
    }

    // Skip the column header
    if (HEADER_RE.test(line)) continue;

    // Data row
    const rowMatch = line.match(ROW_RE);
    if (rowMatch) {
      const prefix = rowMatch[1];
      const perBag = parseMoney(rowMatch[2]);
      const total = parseMoney(rowMatch[3]);
      const split = splitNameAndQty(prefix, perBag, total);
      if (
        split &&
        Number.isFinite(split.qty) &&
        Number.isFinite(perBag) &&
        split.qty > 0
      ) {
        items.push({ name: split.name, qty: split.qty, perBag });
      }
      continue;
    }

    // First non-matching, non-empty line is treated as the sheet title.
    if (!title) {
      title = line;
    }
  }

  if (!title) title = "Order";

  let totalQty = 0;
  let computedTotal = 0;
  for (const item of items) {
    totalQty += item.qty;
    computedTotal += item.qty * item.perBag;
  }

  // Validate against the printed footer when available.
  const totalsMatch =
    printedTotal === null
      ? true
      : Math.abs(printedTotal - computedTotal) < 1 &&
        (printedQty === null || printedQty === totalQty);

  return {
    title,
    items,
    totalQty,
    computedTotal,
    printedTotal,
    totalsMatch,
  };
}

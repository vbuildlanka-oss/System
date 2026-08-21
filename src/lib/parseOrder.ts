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

/* ----------------------- quantity-only lists (no prices) ------------------ */

/**
 * A buyer's own list is usually just what they want and how many, with no
 * prices: "Blanket 12". These rows are read only when no priced rows were
 * found, so a normal order sheet is never interpreted this way.
 */
const QTY_TOTAL_RE = /^Total\s*(\d+)$/i;

/** Lines that are furniture rather than items. */
function isNoiseLine(line: string): boolean {
  if (line.includes(":")) return true; // "Container Number: GAOU7441740"
  if (/page\s*\d+\s*of\s*\d+/i.test(line)) return true;
  if (/^(balebook|item\s*name|quantity|total)\b/i.test(line)) return true;
  // The brand is rendered with wide letter spacing, arriving as "B A L E ...".
  if (/^(?:[A-Za-z]\s){3,}[A-Za-z]\s*$/.test(line)) return true;
  return false;
}

/**
 * Ways to read "<name><qty>" when the two ran together.
 *
 * "Blanket12" is unambiguous enough, but "Anorak 29" could be Anorak 2 with 9
 * bags or Anorak with 29. Every split of the trailing digits is offered, widest
 * first because that is the common case, and the caller picks between them.
 */
function qtySplits(prefix: string): Array<{ name: string; qty: number }> {
  const trimmedEnd = prefix.replace(/\s+$/, "");
  const digits = trimmedEnd.match(/\d+$/)?.[0];
  if (!digits) return [];

  const out: Array<{ name: string; qty: number }> = [];
  for (let take = digits.length; take >= 1; take -= 1) {
    const qty = Number(digits.slice(digits.length - take));
    if (qty <= 0) continue;
    const name = trimmedEnd.slice(0, trimmedEnd.length - take).trim();
    if (name === "") continue;
    out.push({ name, qty });
  }
  return out;
}

/**
 * Choose one split per line so the quantities add up to `target`.
 *
 * Depth-first over the alternatives in preference order, so when several
 * readings are possible the most likely one wins. Failed (line, running total)
 * pairs are remembered, which keeps this quick on real lists.
 */
function resolveToTotal(
  options: Array<Array<{ name: string; qty: number }>>,
  target: number,
): Array<{ name: string; qty: number }> | null {
  const failed = new Set<string>();

  const walk = (
    index: number,
    running: number,
    chosen: Array<{ name: string; qty: number }>,
  ): Array<{ name: string; qty: number }> | null => {
    if (running > target) return null;
    if (index === options.length) return running === target ? chosen : null;

    const key = `${index}:${running}`;
    if (failed.has(key)) return null;

    for (const option of options[index]) {
      const result = walk(index + 1, running + option.qty, [...chosen, option]);
      if (result) return result;
    }
    failed.add(key);
    return null;
  };

  return walk(0, 0, []);
}

interface QtyListResult {
  items: OrderItem[];
  printedTotal: number | null;
  resolved: boolean;
}

/** Read a list that has names and quantities but no prices. */
function parseQuantityList(lines: string[]): QtyListResult {
  const options: Array<Array<{ name: string; qty: number }>> = [];
  let printedQty: number | null = null;

  for (const line of lines) {
    const total = line.match(QTY_TOTAL_RE);
    if (total) {
      printedQty = Number(total[1]);
      continue;
    }
    if (isNoiseLine(line)) continue;

    const splits = qtySplits(line);
    if (splits.length > 0) options.push(splits);
  }

  if (options.length === 0) {
    return { items: [], printedTotal: printedQty, resolved: false };
  }

  // Widest split for each line: right for most lists.
  const greedy = options.map((o) => o[0]);
  const greedyTotal = greedy.reduce((s, o) => s + o.qty, 0);

  if (printedQty === null || greedyTotal === printedQty) {
    return {
      items: greedy.map((o) => ({ name: o.name, qty: o.qty, perBag: 0 })),
      printedTotal: printedQty,
      resolved: printedQty !== null,
    };
  }

  // The printed total disagrees, so a name probably ended in a digit. Look for
  // the reading that adds up. Bounded so a huge list cannot stall the request.
  if (options.length <= 400 && printedQty <= 200_000) {
    const fixed = resolveToTotal(options, printedQty);
    if (fixed) {
      return {
        items: fixed.map((o) => ({ name: o.name, qty: o.qty, perBag: 0 })),
        printedTotal: printedQty,
        resolved: true,
      };
    }
  }

  // Nothing adds up: hand back the straightforward reading and let the caller
  // report that the total does not match, rather than quietly inventing one.
  return {
    items: greedy.map((o) => ({ name: o.name, qty: o.qty, perBag: 0 })),
    printedTotal: printedQty,
    resolved: false,
  };
}

/**
 * A request list printed by this app, rather than a supplier order sheet.
 *
 * It matters because the two layouts differ in a way that corrupts item names.
 * A supplier row is "<name><qty>Rs<per bag>Rs<total>", but a request row carries
 * three counts before the money - "<name><wanted><supplied><to go>" - so reading
 * it as a supplier row leaves the first two glued to the name: "Anorak210".
 */
const REQUEST_LAYOUT_RE = /wanted\s*supplied\s*to\s*go/i;

/**
 * Split "<name><wanted><supplied><to go>" from a request list.
 *
 * The three counts are not independent: what is wanted is the quantity derived
 * from the money, and "to go" is what is wanted less what was supplied. So the
 * whole trailing run is `${wanted}${supplied}${wanted - supplied}`, and the only
 * unknown is how much was supplied - which can simply be tried.
 *
 * The longest match wins, since it accounts for more of the run. Where two are
 * the same length, a name not ending in a digit is preferred: most item names do
 * not, so that reading is the likelier one.
 */
function splitRequestRow(
  prefix: string,
  wanted: number,
): { name: string; qty: number } | null {
  const compact = prefix.replace(/\s+$/, "");
  let best: { name: string; qty: number; length: number } | null = null;

  for (let supplied = 0; supplied <= wanted; supplied += 1) {
    const suffix = `${wanted}${supplied}${wanted - supplied}`;
    if (!compact.endsWith(suffix)) continue;
    const name = compact.slice(0, compact.length - suffix.length).trim();
    if (name === "") continue;

    const better =
      best === null ||
      suffix.length > best.length ||
      (suffix.length === best.length &&
        /\d$/.test(best.name) &&
        !/\d$/.test(name));
    if (better) best = { name, qty: wanted, length: suffix.length };
  }

  return best === null ? null : { name: best.name, qty: best.qty };
}

/**
 * Split a "<name><qty>" prefix into its name and quantity, using the line
 * total and per-bag price to determine the true quantity.
 */
function splitNameAndQty(
  prefix: string,
  perBag: number,
  total: number,
  requestLayout = false,
): { name: string; qty: number } | null {
  const trimmed = prefix.trim();

  // Primary strategy: qty = total / perBag (the source data is exact).
  if (perBag > 0) {
    const derived = Math.round(total / perBag);
    if (derived > 0 && Math.abs(derived * perBag - total) < 1) {
      // A request list puts two more counts between the name and the money.
      if (requestLayout) {
        const asRequest = splitRequestRow(trimmed, derived);
        if (asRequest) return asRequest;
      }
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
  // Decided once from the whole document, since a single row cannot tell you
  // which layout it is in.
  const requestLayout = REQUEST_LAYOUT_RE.test(text);

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
      const split = splitNameAndQty(prefix, perBag, total, requestLayout);
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

    // First line that is neither a row nor page furniture is the sheet title.
    // Without this guard a document produced by this app hands back its own
    // wordmark, since that is the first line on the page.
    if (!title && !isNoiseLine(line)) {
      title = line;
    }
  }

  if (!title) title = "Order";

  // No priced rows: this is probably a plain list of what someone wants, so
  // read it as names and quantities instead.
  if (items.length === 0) {
    const list = parseQuantityList(rawLines);
    if (list.items.length > 0) {
      const listQty = list.items.reduce((s, i) => s + i.qty, 0);
      return {
        title,
        items: list.items,
        totalQty: listQty,
        computedTotal: 0,
        printedTotal: null,
        // Only claim the totals agree when there was a printed total to agree
        // with, and the readings could be made to match it.
        totalsMatch: list.printedTotal === null ? true : list.resolved,
      };
    }
  }

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

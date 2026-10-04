import type { OrderItem, ParsedOrder } from "./types";

/**
 * Why a PDF could not be read, so the caller can say something true about it
 * instead of blaming the file. "It may be corrupted" sent people back to
 * re-upload a file that was never the problem.
 */
export type PdfFailure =
  | "not-a-pdf" // no %PDF- header: an HTML error page, a renamed file
  | "incomplete" // header but no %%EOF: still downloading, or truncated
  | "encrypted" // password protected
  | "unreadable"; // every engine refused it

export class PdfReadError extends Error {
  readonly failure: PdfFailure;
  /** Safe to show a user: says what to do, not just that it went wrong. */
  readonly userMessage: string;

  constructor(failure: PdfFailure, userMessage: string, cause?: unknown) {
    super(`${failure}: ${userMessage}`);
    this.name = "PdfReadError";
    this.failure = failure;
    this.userMessage = userMessage;
    this.cause = cause;
  }
}

/**
 * pdf-parse ships several pdf.js engines. The default one occasionally rejects
 * perfectly valid documents with "bad XRef entry" - small PDFs produced by this
 * app were one example - so we try them in turn rather than trust one.
 *
 * The default comes first because it is the one proven against the real
 * supplier sheets; the others are only reached if it fails or finds no text.
 *
 * We deliberately do NOT go through pdf-parse's own wrapper to do this. It
 * caches the engine in a module-level variable:
 *
 *     PDFJS = PDFJS ? PDFJS : require(`./pdf.js/${options.version}/build/pdf.js`)
 *
 * so its `version` option is honoured only on the first call in the process and
 * silently ignored ever after. Asking it for four engines got the same engine
 * four times, which meant the fallback below never actually fell back. Loading
 * the builds ourselves is what makes it real. They are separate module objects
 * and do not interfere with each other.
 */
const ENGINES = ["v1.10.100", "v2.0.550", "v1.10.88", "v1.9.426"] as const;
type Engine = (typeof ENGINES)[number];

interface TextItem {
  str: string;
  transform: number[];
}
interface PdfPage {
  getTextContent(options: unknown): Promise<{ items: TextItem[] }>;
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): void;
}
interface PdfEngine {
  version: string;
  disableWorker: boolean;
  getDocument(data: Uint8Array): Promise<PdfDocument>;
}

/**
 * Static requires, one per engine, so the bundler can resolve each path. A
 * template-string require would leave it guessing. Called lazily: a file that
 * the first engine reads never loads the other three.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const LOADERS: Record<Engine, () => PdfEngine> = {
  "v1.10.100": () => require("pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js"),
  "v2.0.550": () => require("pdf-parse/lib/pdf.js/v2.0.550/build/pdf.js"),
  "v1.10.88": () => require("pdf-parse/lib/pdf.js/v1.10.88/build/pdf.js"),
  "v1.9.426": () => require("pdf-parse/lib/pdf.js/v1.9.426/build/pdf.js"),
};
/* eslint-enable @typescript-eslint/no-var-requires */

const engines = new Map<Engine, PdfEngine>();

function loadEngine(version: Engine): PdfEngine {
  const cached = engines.get(version);
  if (cached) return cached;
  const engine = LOADERS[version]();
  // Workers need a script URL, which there isn't one of on a server.
  engine.disableWorker = true;
  engines.set(version, engine);
  return engine;
}

/** The engine that last read a file, tried first next time. */
let preferred: Engine = ENGINES[0];

/**
 * Pull the text out one page at a time.
 *
 * The joining here is not a free choice: every pattern further down this file
 * was written against pdf-parse's own output, so this reproduces its
 * `render_page` exactly - items on one line concatenated with no separator, a
 * newline when the y coordinate changes, and each page prefixed with a blank
 * line. Changing it would quietly re-break parsing of every supplier sheet.
 */
interface Extracted {
  /** Exactly what pdf-parse would have produced. Supplier parsing reads this. */
  text: string;
  /**
   * The same lines with a tab between the separate pieces of text on them.
   *
   * Only read for documents this app printed. Joining cells with nothing
   * between them is what supplier parsing was written against, but it glues
   * "Anorak #2" to its 9 bags; a document we laid out ourselves can be read by
   * its columns instead, with no guessing.
   */
  tabbed: string;
}

async function extractWith(version: Engine, bytes: Uint8Array): Promise<Extracted> {
  const engine = loadEngine(version);
  // A fresh copy per attempt: pdf.js takes ownership of what it is handed, so a
  // failed attempt must not be able to spoil the buffer for the next engine.
  const doc = await engine.getDocument(new Uint8Array(bytes));
  try {
    let text = "";
    let tabbed = "";
    for (let i = 1; i <= doc.numPages; i++) {
      let pageText = "";
      let pageTabbed = "";
      try {
        const page = await doc.getPage(i);
        const content = await page.getTextContent({
          normalizeWhitespace: false,
          disableCombineTextItems: false,
        });
        let lastY: number | undefined;
        for (const item of content.items) {
          const sameLine = lastY === item.transform[5] || !lastY;
          if (sameLine) pageText += item.str;
          else pageText += `\n${item.str}`;
          // Each piece carries where it starts across the page, so a table
          // can be read by column position rather than by what the text says.
          const piece = `${Math.round(item.transform[4])}\u0001${item.str}`;
          pageTabbed +=
            sameLine ? (pageTabbed === "" ? piece : `\t${piece}`) : `\n${piece}`;
          lastY = item.transform[5];
        }
      } catch {
        // One unreadable page should not lose the other twenty.
        pageText = "";
        pageTabbed = "";
      }
      text = `${text}\n\n${pageText}`;
      tabbed = `${tabbed}\n\n${pageTabbed}`;
    }
    return { text, tabbed };
  } finally {
    try {
      doc.destroy();
    } catch {
      /* nothing useful to do if teardown fails */
    }
  }
}

function isEncrypted(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  const message = (err as { message?: string })?.message ?? "";
  return name === "PasswordException" || /password/i.test(message);
}

/**
 * Check the envelope before blaming the contents.
 *
 * A PDF that is missing its trailer is usually one that was uploaded while the
 * browser was still writing it - download the count, upload it straight away,
 * and you can catch it half-written. That reads as "bad XRef entry" deep inside
 * pdf.js, which is a terrible thing to show someone: the file is fine, it just
 * was not finished yet, and trying again works. So we say that instead.
 */
function checkEnvelope(bytes: Uint8Array): void {
  // The spec allows junk before the header, so look in the first kilobyte.
  const head = Buffer.from(
    bytes.subarray(0, Math.min(bytes.length, 1024)),
  ).toString("latin1");
  if (!head.includes("%PDF-")) {
    throw new PdfReadError(
      "not-a-pdf",
      "That file is not a PDF. If it was downloaded from an email or a web page, open it first and check it is the order sheet.",
    );
  }
  // %%EOF is the last thing in a finished PDF, give or take some whitespace.
  const tail = Buffer.from(
    bytes.subarray(Math.max(0, bytes.length - 2048)),
  ).toString("latin1");
  if (!tail.includes("%%EOF")) {
    throw new PdfReadError(
      "incomplete",
      "That PDF looks incomplete - the end of the file is missing. If it is still downloading, wait for it to finish and upload it again.",
    );
  }
}

async function extractText(buffer: Buffer): Promise<Extracted> {
  const bytes = new Uint8Array(buffer);
  checkEnvelope(bytes);

  // Whichever engine worked last time goes first, then the rest in order.
  const order: Engine[] = [
    preferred,
    ...ENGINES.filter((v) => v !== preferred),
  ];

  let sawEmpty = false;
  let lastError: unknown = null;

  for (const version of order) {
    try {
      const extracted = await extractWith(version, bytes);
      if (extracted.text.trim() !== "") {
        preferred = version;
        return extracted;
      }
      // Readable but no text: remember it, another engine may do better.
      sawEmpty = true;
    } catch (err) {
      lastError = err;
      if (isEncrypted(err)) {
        throw new PdfReadError(
          "encrypted",
          "That PDF is password protected. Open it, save an unprotected copy, and upload that.",
          err,
        );
      }
    }
  }

  // Every engine opened it and agreed there is no text in it - likely a scan.
  // Hand back the empty string and let the caller say "no items found", which
  // is more use than a hard failure.
  if (sawEmpty) return { text: "", tabbed: "" };

  throw new PdfReadError(
    "unreadable",
    "Could not read that PDF. If it is a scan or a photo there is no text in it to read, so the figures will have to be entered by hand.",
    lastError,
  );
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
  if (/^(balebook|mdn\s*erp|item\s*name|quantity|total)\b/i.test(line)) return true;
  // Our wordmark, whichever name it was printed under.
  if (BRAND_LINE_RE.test(line)) return true;
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
export const REQUEST_LAYOUT_RE = /wanted\s*supplied\s*to\s*go/i;

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
): { name: string; qty: number; supplied: number } | null {
  const compact = prefix.replace(/\s+$/, "");
  let best: { name: string; qty: number; supplied: number; length: number } | null =
    null;

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
    if (better) best = { name, qty: wanted, supplied, length: suffix.length };
  }

  return best === null
    ? null
    : { name: best.name, qty: best.qty, supplied: best.supplied };
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
        if (asRequest) return { name: asRequest.name, qty: asRequest.qty };
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

/**
 * The wordmark at the top of every document this app prints.
 *
 * It is rendered with wide letter spacing and arrives as "M D N   E R P" (or,
 * from some engines, run together). Uppercase and on a line of its own, so a
 * supplier sheet that merely mentions the name cannot match it.
 *
 * The app was called BaleBook before, and files printed then carry BALEBOOK.
 * Both are recognised, so a download made under the old name still restores.
 */
const BRAND_LINE_RE =
  /^(?:M\s*D\s*N\s*E\s*R\s*P|B\s*A\s*L\s*E\s*B\s*O\s*O\s*K)$/;

/** True for the wordmark line this app prints, and nothing a supplier would. */
export function isBalebookWordmark(line: string): boolean {
  return BRAND_LINE_RE.test(line.trim());
}

export interface PdfCell {
  x: number;
  text: string;
}

export interface PdfText {
  text: string;
  /** Trimmed, non-empty lines in reading order. */
  lines: string[];
  /**
   * The same lines split into their separate pieces of text, each with the x
   * position it starts at. Only consulted for documents this app printed.
   */
  cells: PdfCell[][];
  /** True when the document is one this app printed. */
  balebook: boolean;
}

/** Pull the text out of a PDF and say whether it is one of ours. */
export async function readPdfText(buffer: Buffer): Promise<PdfText> {
  const { text, tabbed } = await extractText(buffer);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const cells = tabbed
    .split(/\r?\n/)
    .map((l) =>
      l
        .split("\t")
        .map((piece) => {
          const at = piece.indexOf("\u0001");
          return at < 0
            ? { x: 0, text: piece.trim() }
            : { x: Number(piece.slice(0, at)) || 0, text: piece.slice(at + 1).trim() };
        })
        .filter((c) => c.text !== ""),
    )
    .filter((row) => row.length > 0);
  return { text, lines, cells, balebook: lines.some((l) => BRAND_LINE_RE.test(l)) };
}

/* ----------------------- tables this app printed ------------------------ */

export interface OwnTableRow {
  name: string;
  /** The first count column: quantity, count or wanted. */
  qty: number;
  /** A request list's supplied column, when there is one. */
  supplied: number | null;
  perBag: number;
  /** Text printed under the name, such as a request line's note. */
  note: string;
}

const MONEY_CELL_RE = /^Rs\s*[\d,]+(?:\.\d+)?$/;
const COUNT_CELL_RE = /^\d+$/;

/**
 * Read the table of a document this app printed, column by column.
 *
 * The header row says what each column is and where it starts across the page
 * ("Item Name | Quantity | Per Bag | Total", "Item | Wanted | Supplied | ..."),
 * so every piece of text on a row belongs to the column it sits under. A name
 * the PDF engine handed over in several pieces ("3/4", "Ladies Jeans") is put
 * back together, and a figure is never prised off the end of a name - which is
 * what reading "Anorak #29" as one string has to guess at.
 *
 * A line with text only in the name column, between rows, is the note printed
 * under the item above it.
 */
export function readOwnTable(cells: PdfCell[][]): {
  rows: OwnTableRow[];
  printedQty: number | null;
} {
  const rows: OwnTableRow[] = [];
  let printedQty: number | null = null;
  let columns: Array<{ label: string; x: number }> | null = null;
  /** Name-column text waiting to find out whether it is a name or a note. */
  const held: string[] = [];
  const attachHeld = () => {
    if (held.length > 0 && rows.length > 0) {
      const last = rows[rows.length - 1];
      last.note = [last.note, ...held].filter((t) => t !== "").join(" ");
    }
    held.length = 0;
  };

  /**
   * Which column a piece of text sits in.
   *
   * Names are left-aligned under "Item", so text that starts there is the name. Figures are
   * right-aligned, which means a single "9" starts well to the right of a "12"
   * in the same column - so a figure is matched on where it ENDS, against where
   * each heading ends. Widths are estimated from the character count at the
   * size these tables print at, which is plenty to tell columns 50pt apart.
   */
  const CHAR = 5;
  const columnOf = (piece: PdfCell): number => {
    if (!columns) return -1;
    // Anything starting well inside the name column is part of the name - a
    // name is one left-aligned run however long it is. Everything further
    // right is a figure, or a "-" standing in for a price not agreed yet.
    if (columns.length < 2 || piece.x < columns[1].x - 40) return 0;
    const end = piece.x + piece.text.length * CHAR;
    let best = 1;
    let bestGap = Infinity;
    for (let i = 1; i < columns.length; i += 1) {
      const headingEnd = columns[i].x + columns[i].label.length * CHAR;
      const gap = Math.abs(headingEnd - end);
      if (gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    }
    return best;
  };

  for (const line of cells) {
    const joined = line.map((c) => c.text).join(" ");
    if (BRAND_LINE_RE.test(joined.replace(/\s+/g, " ").trim()) || BRAND_LINE_RE.test(line[0]?.text ?? "")) {
      columns = null;
      continue;
    }
    if (/^item(\s*name)?$/i.test(line[0].text) && line.length >= 2) {
      columns = line.map((c) => ({ label: c.text.toLowerCase(), x: c.x }));
      continue;
    }
    if (!columns) continue;

    const byColumn: string[] = columns.map(() => "");
    for (const piece of line) {
      const col = columnOf(piece);
      byColumn[col] = byColumn[col] ? `${byColumn[col]} ${piece.text}` : piece.text;
    }
    const name = byColumn[0].replace(/\s+/g, " ").trim();

    if (/^total$/i.test(name)) {
      attachHeld();
      const n = byColumn.slice(1).find((c) => COUNT_CELL_RE.test(c.trim()));
      if (n !== undefined) printedQty = Number(n.trim());
      columns = null;
      continue;
    }
    if (/^page \d+ of \d+$/i.test(joined) || /^(balebook|mdn\s*erp)\b/i.test(joined)) continue;

    const at = (label: string) => columns!.findIndex((c) => c.label === label);
    const qtyAt = [at("quantity"), at("count"), at("wanted"), 1].find((i) => i >= 1)!;
    const qtyText = (byColumn[qtyAt] ?? "").trim();
    if (!COUNT_CELL_RE.test(qtyText)) {
      // Text only in the name column. Either the name of an item whose
      // figures are printed lower down (it has a note under it, so the row is
      // taller), or a note belonging to the row above. Held until the next
      // line says which.
      const onlyName = byColumn.slice(1).every((c) => c.trim() === "");
      if (onlyName && name !== "") held.push(name);
      continue;
    }
    const suppliedAt = at("supplied");
    const perBagAt = at("per bag");
    const suppliedText = suppliedAt >= 0 ? (byColumn[suppliedAt] ?? "").trim() : "";
    const moneyText = perBagAt >= 0 ? (byColumn[perBagAt] ?? "").trim() : "";
    let rowName = name;
    let note = "";
    if (rowName === "") {
      // Figures with no name beside them: the name and its note came first.
      rowName = held.shift() ?? "";
      note = held.join(" ");
      held.length = 0;
    } else {
      attachHeld();
    }
    if (rowName === "") continue;
    rows.push({
      name: rowName,
      qty: Number(qtyText),
      supplied: COUNT_CELL_RE.test(suppliedText) ? Number(suppliedText) : null,
      perBag: MONEY_CELL_RE.test(moneyText) ? parseMoney(moneyText) : 0,
      note,
    });
  }
  attachHeld();
  return { rows, printedQty };
}

export async function parseOrderPdf(buffer: Buffer): Promise<ParsedOrder> {
  return parseOrderText(await readPdfText(buffer));
}

/** The column header of a table this app printed: "Item NameQuantity", "ItemCount", ... */
const OWN_TABLE_HEADER_RE = /^item\s*(name)?\s*(quantity|count|wanted)/i;

/**
 * Only the lines inside the table of a document this app printed.
 *
 * Everything above the column header - the heading, the container line, a
 * "Generated 01 Oct 2026" subtitle - is furniture, and several of those end in a
 * digit, which the plain-list reading would take for a quantity. The header and
 * wordmark reprint on every page, so the window reopens on each one.
 */
export function tableLines(lines: string[]): string[] {
  const out: string[] = [];
  let inTable = false;
  for (const line of lines) {
    if (BRAND_LINE_RE.test(line)) {
      inTable = false;
      continue;
    }
    if (OWN_TABLE_HEADER_RE.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable) out.push(line);
  }
  return out;
}

/**
 * Read an order out of a PDF's text.
 *
 * Supplier sheets go through exactly the rules they always have. The only
 * difference for a document this app printed is in the plain-list reading
 * below: its heading is excluded from the items, because a heading such as
 * "Sri Lanka Order 03" ends in a digit and would otherwise be read as an item
 * with 3 bags - which also throws off the printed total that names ending in a
 * digit rely on.
 */
export function parseOrderText(pdf: PdfText): ParsedOrder {
  const { text } = pdf;
  const rawLines = pdf.lines;

  // A document this app printed is read by its columns. Supplier files never
  // take this path: they do not carry the wordmark.
  if (pdf.balebook) {
    const own = readOwnTable(pdf.cells);
    if (own.rows.length > 0) {
      const title =
        rawLines.find((l) => !isNoiseLine(l) && !OWN_TABLE_HEADER_RE.test(l)) ?? "Order";
      const items = own.rows
        .filter((r) => r.qty > 0)
        .map((r) => ({ name: r.name, qty: r.qty, perBag: r.perBag }));
      const totalQty = items.reduce((s, i) => s + i.qty, 0);
      return {
        title,
        items,
        totalQty,
        computedTotal: items.reduce((s, i) => s + i.qty * i.perBag, 0),
        printedTotal: null,
        totalsMatch: own.printedQty === null || own.printedQty === totalQty,
      };
    }
  }

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
    const listLines = pdf.balebook ? tableLines(rawLines) : rawLines;
    const list = parseQuantityList(listLines);
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

/**
 * The lines of a request list this app printed, with what was supplied.
 *
 * The ordinary reading only needs what was wanted, so it drops the supplied
 * count; a restore needs both, or every delivery recorded so far is lost.
 */
export function readRequestRows(
  lines: string[],
): Array<{ name: string; qty: number; supplied: number; perBag: number }> {
  const out: Array<{ name: string; qty: number; supplied: number; perBag: number }> = [];
  for (const line of lines) {
    const match = line.match(ROW_RE);
    if (!match) continue;
    const perBag = parseMoney(match[2]);
    const total = parseMoney(match[3]);
    const prefix = match[1].trim();
    if (perBag > 0) {
      const wanted = Math.round(total / perBag);
      if (wanted <= 0 || Math.abs(wanted * perBag - total) >= 1) continue;
      const row = splitRequestRow(prefix, wanted);
      if (row) out.push({ ...row, perBag });
      continue;
    }
    // No price agreed yet, so the money cannot say how many were wanted. The
    // three counts still constrain each other - to go is wanted less supplied -
    // which is enough to find them in the run of digits.
    const row = splitUnpricedRequestRow(prefix);
    if (row) out.push({ ...row, perBag: 0 });
  }
  return out;
}

function splitUnpricedRequestRow(
  prefix: string,
): { name: string; qty: number; supplied: number } | null {
  const digits = prefix.match(/\d+$/)?.[0] ?? "";
  if (digits.length < 3 || digits.length > 21) return null;
  const okPart = (part: string) => part === "0" || !part.startsWith("0");

  let best: { name: string; qty: number; supplied: number; length: number } | null =
    null;
  for (let start = 0; start <= digits.length - 3; start += 1) {
    const run = digits.slice(start);
    for (let a = 1; a < run.length - 1; a += 1) {
      for (let b = a + 1; b < run.length; b += 1) {
        const [w, s, g] = [run.slice(0, a), run.slice(a, b), run.slice(b)];
        if (!okPart(w) || !okPart(s) || !okPart(g)) continue;
        const wanted = Number(w);
        const supplied = Number(s);
        if (wanted <= 0 || supplied > wanted || Number(g) !== wanted - supplied) continue;
        const name = prefix.slice(0, prefix.length - run.length).trim();
        if (name === "") continue;
        const better =
          best === null ||
          run.length > best.length ||
          (run.length === best.length && /\d$/.test(best.name) && !/\d$/.test(name));
        if (better) best = { name, qty: wanted, supplied, length: run.length };
      }
    }
  }
  return best === null
    ? null
    : { name: best.name, qty: best.qty, supplied: best.supplied };
}

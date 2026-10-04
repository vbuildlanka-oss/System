/**
 * Recognise a file this app generated, and read back everything it carries.
 *
 * The ordinary readers in parseOrder.ts and parseTabular.ts read supplier files,
 * and they are left exactly as they are: a supplier PDF or spreadsheet goes
 * through the same rules it always has. This file only looks at what those
 * readers could not keep - a count is not an expected quantity, a markup is not
 * a cost, a payroll row is not an order line - and only for files that carry
 * something nobody else prints:
 *
 *   PDF   the MDN ERP wordmark (BALEBOOK on files printed before the rename), plus the heading or column layout of one of
 *         our documents
 *   XLSX  our exact sheet names and column headings
 *   CSV   our exact column headings
 *
 * Anything else returns no restore, and the upload is treated as it always was.
 */

import { FAST_LABEL } from "./labels";
import {
  readOwnTable,
  readRequestRows,
  REQUEST_LAYOUT_RE,
  tableLines,
  type PdfText,
} from "./parseOrder";
import { cellText, type Cell, type SheetGrid } from "./parseTabular";
import type { OrderItem, ParsedOrder } from "./types";
import type {
  Restore,
  RestoredCalcRow,
  RestoredLot,
  RestoredPayroll,
  RestoredPayrollMonth,
  RestoredPayrollRow,
  RestoredRequest,
} from "./restoreTypes";

export interface Recognised {
  restore: Restore;
  /**
   * Clean order lines, when the ordinary reading of this file gets them wrong
   * (a calculation read past its total row into the summary, say). Pages that do
   * not know this kind still get a sensible list to work with.
   */
  items?: OrderItem[];
}

const ISO_CONTAINER_RE = /^[A-Z]{4}\d{7}$/;
const CONTAINER_LINE_RE = /^container\s*(?:no\.?|number)\s*:\s*(.+)$/i;

/** "Sri Lanka 07 - GAOU7441740 - Bag count" -> order and container. */
function splitCountHeading(
  heading: string,
  knownContainer = "",
): { orderNumber: string; containerId: string } {
  const stem = heading.replace(/\s*-?\s*bag count$/i, "").trim();
  if (knownContainer !== "") {
    const suffix = ` - ${knownContainer}`;
    if (stem === knownContainer) return { orderNumber: "", containerId: knownContainer };
    if (stem.endsWith(suffix)) {
      return {
        orderNumber: stem.slice(0, stem.length - suffix.length).trim(),
        containerId: knownContainer,
      };
    }
    return { orderNumber: stem, containerId: knownContainer };
  }
  const parts = stem.split(" - ").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0) return { orderNumber: "", containerId: "" };
  if (parts.length === 1) {
    return ISO_CONTAINER_RE.test(parts[0])
      ? { orderNumber: "", containerId: parts[0] }
      : { orderNumber: parts[0], containerId: "" };
  }
  // The heading is "<order> - <container>", and a container may be free text
  // such as "Back room", so the last part is the container.
  return {
    orderNumber: parts.slice(0, -1).join(" - "),
    containerId: parts[parts.length - 1],
  };
}

/** "01 Oct 2026" -> "2026-10-01". */
const MONTHS_SHORT = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];
function readShortDate(text: string): string {
  const m = text.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
  if (!m) return "";
  const month = MONTHS_SHORT.indexOf(m[2].toLowerCase());
  if (month < 0) return "";
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/* =================================== PDF ================================== */

export function recognisePdf(
  pdf: PdfText,
  parsed: ParsedOrder,
): Recognised | null {
  if (!pdf.balebook) return null;
  const { lines } = pdf;
  const title = parsed.title;

  if (/\(buyer price list\)$/i.test(title)) {
    return {
      restore: {
        kind: "buyer-price-list",
        orderNumber: title.replace(/\s*\(buyer price list\)$/i, "").trim(),
      },
    };
  }

  const containerLine = lines
    .map((l) => l.match(CONTAINER_LINE_RE)?.[1]?.trim() ?? "")
    .find((c) => c !== "") ?? "";

  if (/(^|\s-\s)bag count$/i.test(title) || /^bag count$/i.test(title)) {
    const { orderNumber, containerId } = splitCountHeading(title, containerLine);
    return {
      restore: {
        kind: "count",
        orderNumber,
        containerId,
        rows: parsed.items.map((i) => ({ name: i.name, counted: i.qty })),
      },
    };
  }

  if (REQUEST_LAYOUT_RE.test(pdf.text)) {
    const header = lines.findIndex((l) => /^item\s*wanted/i.test(l));
    const meta = lines.findIndex((l) => /^requested items/i.test(l));
    const phone =
      meta >= 0
        ? (lines[meta]
            .split("·")
            .map((p) => p.trim())
            .find((p) => /^\+?[\d\s()-]{7,}$/.test(p)) ?? "")
        : "";
    const notes =
      meta >= 0 && header > meta + 1 ? lines.slice(meta + 1, header).join(" ") : "";
    // Read by column; the older run-together reading is the fallback for an
    // engine that hands the row back as one piece of text.
    const own = readOwnTable(pdf.cells).rows.filter((r) => r.qty > 0);
    const rows =
      own.length > 0
        ? own.map((r) => ({
            name: r.name,
            qty: r.qty,
            supplied: Math.min(r.qty, r.supplied ?? 0),
            perBag: r.perBag,
            note: r.note,
          }))
        : readRequestRows(tableLines(lines)).map((r) => ({ ...r, note: "" }));
    const request: RestoredRequest = {
      buyerName: title,
      buyerPhone: phone,
      notes,
      items: rows,
    };
    return {
      restore: { kind: "requests", requests: [request] },
      items: rows.map((r) => ({ name: r.name, qty: r.qty, perBag: r.perBag })),
    };
  }

  // A manifest has a container line and a two-column table, no prices.
  if (
    containerLine !== "" &&
    lines.some((l) => /^item\s*name\s*quantity$/i.test(l))
  ) {
    return {
      restore: {
        kind: "manifest",
        orderNumber: title,
        containerNumber: containerLine.toUpperCase().replace(/\s+/g, ""),
      },
    };
  }

  if (/^stockpile$/i.test(title)) {
    const asAt = lines.find((l) => /^as at /i.test(l)) ?? "";
    const addedOn = readShortDate(asAt);
    return {
      restore: {
        kind: "stockpile",
        detailed: false,
        lots: parsed.items.map((i) => ({
          name: i.name,
          bags: i.qty,
          perBag: i.perBag,
          source: `Stockpile PDF${addedOn ? ` ${addedOn}` : ""}`,
          addedOn,
        })),
      },
    };
  }

  // Any other priced document of ours is an order sheet. The buyer printed on
  // it is worth having back.
  if (parsed.items.length > 0) {
    const prepared = lines.findIndex((l) =>
      /^P\s*R\s*E\s*P\s*A\s*R\s*E\s*D\s+F\s*O\s*R$/i.test(l),
    );
    const reference = lines.findIndex((l) =>
      /^R\s*E\s*F\s*E\s*R\s*E\s*N\s*C\s*E$/i.test(l),
    );
    let buyer = null;
    if (prepared >= 0) {
      const name = lines[prepared + 1] ?? "";
      const maybePhone = lines[prepared + 2] ?? "";
      const phone = /^\+?[\d\s()-]{7,}$/.test(maybePhone) ? maybePhone : "";
      buyer = {
        name,
        phone,
        refNo: reference >= 0 ? (lines[reference + 1] ?? "") : "",
      };
    }
    return { restore: { kind: "sheet", buyer } };
  }

  return null;
}

/* =================================== CSV ================================== */

const fold = (cell: Cell) => cellText(cell).toLowerCase().replace(/\s+/g, " ");

function startsWithHeadings(row: Cell[] | undefined, wanted: string[]): boolean {
  if (!row) return false;
  return wanted.every((w, i) => fold(row[i]) === w);
}

function num(cell: Cell): number {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : 0;
  const cleaned = cellText(cell).replace(/[^\d.-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

const STOCK_CSV = ["item", "bags", "per bag", "lot value", "source", "date added"];
const REQUESTS_CSV = ["buyer", "phone", "item", "requested", "supplied", "outstanding"];

export function recogniseCsv(rows: Cell[][]): Recognised | null {
  const header = rows[0];

  if (startsWithHeadings(header, STOCK_CSV)) {
    const lots: RestoredLot[] = [];
    for (const row of rows.slice(1)) {
      const name = cellText(row[0]);
      if (name === "" || /^total$/i.test(name)) continue;
      const bags = Math.floor(num(row[1]));
      if (bags <= 0) continue;
      const date = cellText(row[5]);
      lots.push({
        name,
        bags,
        perBag: num(row[2]),
        source: cellText(row[4]),
        addedOn: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
      });
    }
    return {
      restore: { kind: "stockpile", detailed: true, lots },
      items: lots.map((l) => ({ name: l.name, qty: l.bags, perBag: l.perBag })),
    };
  }

  if (startsWithHeadings(header, REQUESTS_CSV)) {
    const at = (name: string) => header.findIndex((c) => fold(c) === name);
    const perBagAt = at("per bag");
    const noteAt = at("note");
    const byBuyer = new Map<string, RestoredRequest>();
    for (const row of rows.slice(1)) {
      const item = cellText(row[2]);
      const qty = Math.floor(num(row[3]));
      if (item === "" || qty <= 0) continue;
      const buyerName = cellText(row[0]);
      const buyerPhone = cellText(row[1]);
      const key = `${buyerName.toLowerCase()}|${buyerPhone}`;
      let request = byBuyer.get(key);
      if (!request) {
        request = { buyerName, buyerPhone, notes: "", items: [] };
        byBuyer.set(key, request);
      }
      request.items.push({
        name: item,
        qty,
        supplied: Math.min(qty, Math.max(0, Math.floor(num(row[4])))),
        perBag: perBagAt >= 0 ? num(row[perBagAt]) : 0,
        note: noteAt >= 0 ? cellText(row[noteAt]) : "",
      });
    }
    const requests = Array.from(byBuyer.values());
    return {
      restore: { kind: "requests", requests },
      items: requests.flatMap((r) =>
        r.items.map((i) => ({ name: i.name, qty: i.qty, perBag: i.perBag })),
      ),
    };
  }

  return null;
}

/* =================================== XLSX ================================= */

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function monthKeyFromSheet(name: string): string {
  const m = name.trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return "";
  const index = MONTH_NAMES.indexOf(m[1].toLowerCase());
  return index < 0 ? "" : `${m[2]}-${String(index + 1).padStart(2, "0")}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A payroll month sheet's header: Name first, with TIN and Gross Salary in it. */
function isPayrollHeader(row: Cell[] | undefined): boolean {
  if (!row || fold(row[0]) !== "name") return false;
  const texts = row.map(fold);
  return texts.includes("tin") && texts.includes("gross salary");
}

function readPayroll(grids: SheetGrid[]): RestoredPayroll | null {
  const monthSheets = grids.filter(
    (g) =>
      monthKeyFromSheet(g.name) !== "" &&
      isPayrollHeader(g.rows[1]),
  );
  if (monthSheets.length === 0) return null;

  // The rates the file was worked out with, read from its own Rates tab.
  const ratesSheet = grids.find((g) => g.name === "Rates");
  let rates: RestoredPayroll["rates"] = null;
  if (ratesSheet) {
    const pct = (r: number) => round2(num(ratesSheet.rows[r]?.[1]) * 100);
    rates = { epfEmployee: pct(1), epfEmployer: pct(2), etf: pct(3) };
  }

  let employer = "";
  const fields: RestoredPayroll["fields"] = [];
  const addField = (label: string, kind: "allowance" | "deduction") => {
    if (!fields.some((f) => f.label.toLowerCase() === label.toLowerCase())) {
      fields.push({ label, kind });
    }
  };

  const months: RestoredPayrollMonth[] = [];
  for (const sheet of monthSheets) {
    const header = sheet.rows[1].map((c) => cellText(c));
    const find = (test: (h: string) => boolean) => header.findIndex(test);
    // Found by heading, not position: workbooks made before Position was added
    // have TIN in the second column, and those must still restore.
    const positionAt = find((h) => h === "Position");
    const tinAt = find((h) => h === "TIN");
    const grossAt = find((h) => h === "Gross Salary");
    const earnings = find((h) => h === "Total Earnings");
    const epfEe = find((h) => /^EPF .*\(employee\)$/i.test(h));
    const other = find((h) => h === "Other Deductions");
    const totalDed = find((h) => h === "Total Deductions");
    const epfEr = find((h) => /^EPF .*\(employer\)$/i.test(h));
    const etf = find((h) => /^ETF .*\(employer\)$/i.test(h));
    const note = find((h) => h === "Note");
    if (earnings < 0 || other < 0 || totalDed < 0) continue;

    // Fall back to the percentages in the headings when there is no Rates tab.
    const pctIn = (i: number) => {
      const m = (header[i] ?? "").match(/([\d.]+)%/);
      return m ? Number(m[1]) : 0;
    };
    const used = rates ?? {
      epfEmployee: pctIn(epfEe),
      epfEmployer: pctIn(epfEr),
      etf: pctIn(etf),
    };
    if (!rates) rates = used;

    const allowanceCols = header
      .slice(grossAt + 1, earnings)
      .map((label, k) => ({ label, col: grossAt + 1 + k }))
      .filter((c) => c.label !== "");
    const deductionCols = header
      .slice(other + 1, totalDed)
      .map((label, k) => ({ label, col: other + 1 + k }))
      .filter((c) => c.label !== "");
    allowanceCols.forEach((c) => addField(c.label, "allowance"));
    deductionCols.forEach((c) => addField(c.label, "deduction"));

    const titleCell = cellText(sheet.rows[0]?.[0]);
    const who = titleCell.match(/^(.*) - Payroll [A-Za-z]+ \d{4}$/);
    if (who && employer === "") employer = who[1].trim();

    const stamp = (sheet.rows[0] ?? []).map(cellText).find((t) => /^Paid \d{4}-\d{2}-\d{2}$/.test(t));
    const paidOn = stamp ? stamp.slice(5) : "";

    const rows: RestoredPayrollRow[] = [];
    for (const row of sheet.rows.slice(2)) {
      const name = cellText(row[0]);
      if (/^total\b/i.test(name)) break;
      const gross = num(row[grossAt]);
      if (name === "" && gross === 0) continue;

      const extras: Record<string, number> = {};
      for (const c of [...allowanceCols, ...deductionCols]) {
        const v = num(row[c.col]);
        if (v > 0) extras[c.label] = v;
      }
      // A contribution that is not what the rate gives was typed in for that
      // month, so it comes back as the typed figure rather than being recomputed.
      const typed = (col: number, rate: number): number | null => {
        if (col < 0) return null;
        const value = num(row[col]);
        return Math.abs(value - round2((gross * rate) / 100)) > 0.005 ? value : null;
      };
      rows.push({
        name,
        position: positionAt >= 0 ? cellText(row[positionAt]) : "",
        tin: cellText(row[tinAt]),
        gross,
        otherDeductions: num(row[other]),
        extras,
        overrides: {
          epfEmployee: typed(epfEe, used.epfEmployee),
          epfEmployer: typed(epfEr, used.epfEmployer),
          etf: typed(etf, used.etf),
        },
        note: note >= 0 ? cellText(row[note]) : "",
      });
    }
    months.push({ month: monthKeyFromSheet(sheet.name), paidOn, rows });
  }

  if (months.length === 0) return null;
  return { employer, rates, fields, months };
}

export function recogniseGrids(grids: SheetGrid[]): Recognised | null {
  const payroll = readPayroll(grids);
  if (payroll) return { restore: { kind: "payroll", payroll }, items: [] };

  const calc = grids.find(
    (g) =>
      g.name === "Calculation" &&
      startsWithHeadings(g.rows[1], ["item", "bags", "cost / bag", "markup / bag"]),
  );
  if (calc) {
    const rows: RestoredCalcRow[] = [];
    for (const row of calc.rows.slice(2)) {
      const name = cellText(row[0]);
      if (/^total$/i.test(name)) break;
      const qty = Math.floor(num(row[1]));
      if (name === "" || qty <= 0) continue;
      rows.push({
        name,
        qty,
        costPerBag: num(row[2]),
        markup: num(row[3]),
        fast: cellText(row[7]) === FAST_LABEL,
      });
    }
    const heading = cellText(calc.rows[0]?.[0]);
    return {
      restore: {
        kind: "calculation",
        orderNumber: heading.replace(/\s*-?\s*markup calculation$/i, "").trim(),
        rows,
      },
      items: rows.map((r) => ({ name: r.name, qty: r.qty, perBag: r.costPerBag })),
    };
  }

  const count = grids.find(
    (g) => g.name === "Bag Count" && startsWithHeadings(g.rows[1], ["item", "count"]),
  );
  if (count) {
    const rows: Array<{ name: string; counted: number | null }> = [];
    for (const row of count.rows.slice(2)) {
      const name = cellText(row[0]);
      if (/^total$/i.test(name)) break;
      if (name === "") continue;
      const raw = cellText(row[1]);
      rows.push({ name, counted: raw === "" ? null : Math.max(0, Math.floor(num(row[1]))) });
    }
    const { orderNumber, containerId } = splitCountHeading(cellText(count.rows[0]?.[0]));
    return {
      restore: { kind: "count", orderNumber, containerId, rows },
      items: rows
        .filter((r) => (r.counted ?? 0) > 0)
        .map((r) => ({ name: r.name, qty: r.counted as number, perBag: 0 })),
    };
  }

  const manifest = grids.find(
    (g) =>
      g.name === "Bag Manifest" &&
      startsWithHeadings(g.rows[2], ["item name", "quantity"]),
  );
  if (manifest) {
    const containerNumber =
      cellText(manifest.rows[1]?.[0]).match(CONTAINER_LINE_RE)?.[1]?.trim() ?? "";
    return {
      restore: {
        kind: "manifest",
        orderNumber: cellText(manifest.rows[0]?.[0]),
        containerNumber: containerNumber.toUpperCase().replace(/\s+/g, ""),
      },
    };
  }

  return null;
}

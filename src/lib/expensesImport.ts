/**
 * Reading an expenses spreadsheet back in.
 *
 * The point of this is the round trip: export the expenses, add rows to them in
 * Excel, upload the file, and the new rows land on the sheet. That only works if
 * the reader is suspicious of its input, so two rules run through everything
 * here:
 *
 *   Nothing is imported that is not clearly an expense. The exported sheet has a
 *   Total row and a per-partner block underneath the entries, and a naive row
 *   loop would happily read those back as expenses called "Total".
 *
 *   Nothing is dropped silently. Every row that is not imported comes back with
 *   the reason why, so a row that was quietly ignored can never be mistaken for
 *   a row that was added.
 *
 * Columns are found by their heading rather than by position, so a sheet someone
 * else typed still works as long as it says what its columns are.
 */

import { cellText, type Cell } from "./parseTabular";
import { normalizeContainerNumber } from "./container";
import { clampNumber, LIMITS } from "./types";
import {
  AMOUNT_HEADINGS,
  CONTAINER_HEADINGS,
  describe,
  fold,
  headings,
  heading,
  HEADER_SEARCH_ROWS,
  isBlankRow,
  isGeneralLabel,
  isTotalLabel,
  markDuplicatesBy,
  PARTY_HEADINGS,
  readAmount,
  type SkippedRow,
} from "./sheetImport";
import {
  createExpense,
  MAX_ENTRIES,
  type BalanceSheet,
  type Expense,
} from "./balanceSheet";

export type { SkippedRow };

export interface ImportedRow {
  name: string;
  partner: string;
  containerId: string;
  amount: number;
  /** 1-based row in the source sheet, so the preview can point at it. */
  row: number;
  /** True when an identical expense is already on the balance sheet. */
  duplicate: boolean;
}

export interface ExpenseImport {
  /** The worksheet the rows came from. */
  sheetName: string;
  rows: ImportedRow[];
  skipped: SkippedRow[];
  /** Which columns were recognised, for explaining the result. */
  found: { name: boolean; partner: boolean; container: boolean; amount: boolean };
  /** Set when the sheet could not be read at all. */
  problem?: string;
}

/* ----------------------------- column headings ---------------------------- */

/** What the thing was for. The one heading only this reader cares about. */
const NAME_HEADINGS = new Set([
  "expense",
  "expense name",
  "expenses",
  "name",
  "description",
  "detail",
  "details",
  "item",
  "particular",
  "particulars",
  "narration",
  "purpose",
  "reason",
]);

interface Columns {
  name: number;
  partner: number;
  container: number;
  amount: number;
}

/** Column positions from a candidate heading row, or null if it is not one. */
function columnsFrom(row: Cell[]): Columns | null {
  const cols: Columns = { name: -1, partner: -1, container: -1, amount: -1 };
  row.forEach((cell, c) => {
    const text = heading(cell);
    if (text === "") return;
    // Amount is tested first because "expense amount" would otherwise be
    // claimed by the name column.
    if (cols.amount === -1 && AMOUNT_HEADINGS.has(text)) cols.amount = c;
    else if (cols.container === -1 && CONTAINER_HEADINGS.has(text)) cols.container = c;
    else if (cols.partner === -1 && PARTY_HEADINGS.has(text)) cols.partner = c;
    else if (cols.name === -1 && NAME_HEADINGS.has(text)) cols.name = c;
  });
  // A heading row has to say what the thing is and what it cost. Without both,
  // it is prose or a summary block.
  return cols.name !== -1 && cols.amount !== -1 ? cols : null;
}

/**
 * A summary block heading, such as the per-partner block the export puts below
 * the entries. Everything from here down is a total of the rows above, so
 * reading on would count the same money twice.
 */
function isSummaryHeading(row: Cell[]): boolean {
  const texts = headings(row);
  if (texts.length === 0) return false;
  const hasParty = texts.some((t) => PARTY_HEADINGS.has(t));
  const hasTally = texts.some(
    (t) => t === "total" || t === "entries" || t === "count",
  );
  return hasParty && hasTally;
}

/* --------------------------------- parsing -------------------------------- */

/** Read one worksheet's grid. */
export function parseExpenseGrid(
  rows: Cell[][],
  sheetName: string,
): ExpenseImport {
  const out: ExpenseImport = {
    sheetName,
    rows: [],
    skipped: [],
    found: { name: false, partner: false, container: false, amount: false },
  };

  // Find the heading row.
  let headerAt = -1;
  let cols: Columns | null = null;
  const limit = Math.min(rows.length, HEADER_SEARCH_ROWS);
  for (let r = 0; r < limit; r += 1) {
    if (isSummaryHeading(rows[r])) continue;
    const candidate = columnsFrom(rows[r]);
    if (candidate) {
      headerAt = r;
      cols = candidate;
      break;
    }
  }

  if (!cols) {
    out.problem =
      "No heading row was found. The sheet needs a row naming its columns, at least an Expense column and an Amount column.";
    return out;
  }

  out.found = {
    name: cols.name !== -1,
    partner: cols.partner !== -1,
    container: cols.container !== -1,
    amount: cols.amount !== -1,
  };

  if (cols.partner === -1) {
    out.problem =
      "No Partner column was found. Every expense has to belong to a partner, so add a Partner column and upload the file again.";
    return out;
  }

  const at = (row: Cell[], col: number): Cell => (col === -1 ? "" : row[col]);

  for (let r = headerAt + 1; r < rows.length; r += 1) {
    const row = rows[r];
    const rowNumber = r + 1;

    if (isBlankRow(row)) continue;

    // A second heading, or the start of a summary block: everything below is
    // either a repeat or a total of what has already been read.
    if (isSummaryHeading(row) || columnsFrom(row) !== null) break;

    const name = cellText(at(row, cols.name));
    const partner = cellText(at(row, cols.partner));
    const containerText = cellText(at(row, cols.container));
    const amount = readAmount(at(row, cols.amount));

    const skip = (reason: string) =>
      out.skipped.push({ row: rowNumber, detail: describe(row), reason });

    if (name !== "" && isTotalLabel(name)) {
      skip("a total row, not an expense");
      continue;
    }
    if (name === "") {
      skip("no expense name");
      continue;
    }
    if (amount.value === null) {
      skip("no amount");
      continue;
    }
    if (amount.bracketed || amount.value < 0) {
      skip("the amount is a credit, not an expense");
      continue;
    }
    if (amount.value === 0) {
      skip("the amount is zero");
      continue;
    }
    if (amount.value > LIMITS.money) {
      skip("the amount is unrealistically large");
      continue;
    }
    if (partner === "") {
      skip("no partner, so it could not be attributed");
      continue;
    }

    // Built through createExpense so an imported row is sanitised and clamped
    // exactly like a typed one, then read back off it.
    const built = createExpense({
      name,
      partner,
      amount: amount.value,
      containerId: isGeneralLabel(containerText) ? "" : containerText,
    });

    out.rows.push({
      name: built.name,
      partner: built.partner,
      containerId: built.containerId,
      amount: built.amount,
      row: rowNumber,
      duplicate: false,
    });

    if (out.rows.length >= LIMITS.rows) break;
  }

  return out;
}

/**
 * Pick the worksheet the expenses are on.
 *
 * A sheet actually called Expenses wins, so uploading a whole balance sheet
 * workbook reads its Expenses tab rather than failing on the Summary tab.
 * Otherwise the sheet yielding the most rows wins, and if none yield any, the
 * first sheet's complaint is the one worth reporting.
 */
export function pickExpenseSheet(
  grids: Array<{ name: string; rows: Cell[][] }>,
): ExpenseImport {
  if (grids.length === 0) {
    return {
      sheetName: "",
      rows: [],
      skipped: [],
      found: { name: false, partner: false, container: false, amount: false },
      problem: "That workbook has no sheets in it.",
    };
  }

  const parsed = grids.map((g) => parseExpenseGrid(g.rows, g.name));

  const named = parsed.find(
    (p) => p.sheetName.trim().toLowerCase() === "expenses" && p.rows.length > 0,
  );
  if (named) return named;

  let best = parsed[0];
  for (const candidate of parsed) {
    if (candidate.rows.length > best.rows.length) best = candidate;
  }
  return best;
}

/* ------------------------------- duplicates ------------------------------- */

/** What makes two expenses the same entry. */
function dupKey(row: {
  name: string;
  partner: string;
  containerId: string;
  amount: number;
}): string {
  return `${fold(row.name)}|${fold(row.partner)}|${row.containerId}|${row.amount}`;
}

/**
 * Flag rows that are already on the sheet. Counted, not merely matched - see
 * markDuplicatesBy.
 */
export function markDuplicates(
  rows: ImportedRow[],
  existing: Expense[],
): ImportedRow[] {
  return markDuplicatesBy(rows, existing.map(dupKey), dupKey);
}

/** The rows that are not already on the sheet. */
export function newRows(rows: ImportedRow[]): ImportedRow[] {
  return rows.filter((row) => !row.duplicate);
}

/* --------------------------------- adding --------------------------------- */

export interface AddResult {
  sheet: BalanceSheet;
  added: number;
  /** Rows that did not fit under the entry cap. */
  dropped: number;
}

/**
 * Add imported rows to the sheet.
 *
 * Added in one pass rather than through addExpense per row, so that file order
 * is preserved instead of being reversed by repeated prepending, and so the
 * entry cap is applied once with the overflow reported rather than silently
 * swallowing the tail.
 */
export function addImportedExpenses(
  sheet: BalanceSheet,
  rows: ImportedRow[],
  source = "",
): AddResult {
  const room = Math.max(0, MAX_ENTRIES - sheet.expenses.length);
  const take = rows.slice(0, room);
  const note = source.trim() === "" ? "" : `Imported from ${source.trim()}`;

  const built: Expense[] = take.map((row) =>
    createExpense({
      name: row.name,
      partner: row.partner,
      amount: clampNumber(row.amount, LIMITS.money),
      containerId: row.containerId,
      note,
    }),
  );

  return {
    sheet: {
      ...sheet,
      // Newest first, matching how the page lists a typed expense.
      expenses: [...built.reverse(), ...sheet.expenses].slice(0, MAX_ENTRIES),
      updatedAt: new Date().toISOString(),
    },
    added: built.length,
    dropped: rows.length - take.length,
  };
}

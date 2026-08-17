/**
 * Reading a spreadsheet of outstanding balances.
 *
 * This is how balances from before the system existed get in: type them into a
 * sheet, or fill in the Balances tab of an export, and upload it. The same two
 * rules as the expenses reader apply - nothing is imported that is not clearly a
 * balance, and nothing is dropped without saying why - plus one of its own.
 *
 * An expenses sheet must not be readable as balances. "Partner" is a party and
 * "Amount" is an amount, so a plain expenses tab would otherwise satisfy a naive
 * party-plus-amount test and import every expense as a debt. A heading therefore
 * has to carry something only a balance sheet has: a direction, a paid figure, an
 * outstanding figure, a due date, or an amount column that names itself a balance.
 */

import { cellText, type Cell } from "./parseTabular";
import { LIMITS } from "./types";
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
  ORDER_HEADINGS,
  PARTY_HEADINGS,
  readAmount,
  type SkippedRow,
} from "./sheetImport";
import { OWE_LABEL, OWED_LABEL } from "./labels";
import {
  createBalanceDue,
  MAX_ENTRIES,
  type BalanceDirection,
  type BalanceDue,
  type BalanceSheet,
} from "./balanceSheet";

export type { SkippedRow };

export interface ImportedBalance {
  party: string;
  direction: BalanceDirection;
  amount: number;
  paid: number;
  containerId: string;
  orderNumber: string;
  dueAt: string;
  /** 1-based row in the source sheet, so the preview can point at it. */
  row: number;
  duplicate: boolean;
}

export interface BalanceImport {
  sheetName: string;
  rows: ImportedBalance[];
  skipped: SkippedRow[];
  found: {
    party: boolean;
    amount: boolean;
    paid: boolean;
    outstanding: boolean;
    due: boolean;
    direction: boolean;
  };
  problem?: string;
}

/* ----------------------------- column headings ---------------------------- */

/**
 * Amount headings that only a balance sheet uses.
 *
 * Kept apart from the general ones because they are also what tells a balances
 * sheet apart from an expenses sheet.
 */
const BALANCE_AMOUNT_HEADINGS = new Set([
  "balance",
  "balance due",
  "balance to be paid",
  "amount due",
  "due amount",
  "arrears",
  "opening balance",
  "previous balance",
]);

const PAID_HEADINGS = new Set([
  "paid",
  "amount paid",
  "paid so far",
  "settled",
  "received",
  "payment",
  "payments",
  "credit",
]);

const OUTSTANDING_HEADINGS = new Set([
  "outstanding",
  "remaining",
  "left",
  "left to pay",
  "still to pay",
  "unpaid",
  "balance remaining",
]);

const DUE_HEADINGS = new Set([
  "due",
  "due date",
  "due on",
  "date due",
  "deadline",
  "payable on",
]);

const DIRECTION_HEADINGS = new Set([
  "direction",
  "type",
  "kind",
  "we owe or owed to us",
  "owed",
]);

interface Columns {
  party: number;
  amount: number;
  paid: number;
  outstanding: number;
  due: number;
  direction: number;
  container: number;
  order: number;
  /** True when the amount column named itself a balance. */
  amountIsBalance: boolean;
}

function emptyColumns(): Columns {
  return {
    party: -1,
    amount: -1,
    paid: -1,
    outstanding: -1,
    due: -1,
    direction: -1,
    container: -1,
    order: -1,
    amountIsBalance: false,
  };
}

/** Column positions from a candidate heading row, or null if it is not one. */
function columnsFrom(row: Cell[]): Columns | null {
  const cols = emptyColumns();

  row.forEach((cell, c) => {
    const text = heading(cell);
    if (text === "") return;

    // Tested before the general amount headings, so "Balance" is read as the
    // amount and also marks the sheet as a balances sheet.
    if (cols.amount === -1 && BALANCE_AMOUNT_HEADINGS.has(text)) {
      cols.amount = c;
      cols.amountIsBalance = true;
    } else if (cols.paid === -1 && PAID_HEADINGS.has(text)) cols.paid = c;
    else if (cols.outstanding === -1 && OUTSTANDING_HEADINGS.has(text)) {
      cols.outstanding = c;
    } else if (cols.due === -1 && DUE_HEADINGS.has(text)) cols.due = c;
    else if (cols.direction === -1 && DIRECTION_HEADINGS.has(text)) {
      cols.direction = c;
    } else if (cols.amount === -1 && AMOUNT_HEADINGS.has(text)) cols.amount = c;
    else if (cols.container === -1 && CONTAINER_HEADINGS.has(text)) {
      cols.container = c;
    } else if (cols.order === -1 && ORDER_HEADINGS.has(text)) cols.order = c;
    else if (cols.party === -1 && PARTY_HEADINGS.has(text)) cols.party = c;
  });

  if (cols.party === -1) return null;

  // Either an amount, or an outstanding figure to use as one.
  if (cols.amount === -1 && cols.outstanding === -1) return null;

  // The distinguishing test: an expenses sheet has a party and an amount and
  // nothing else here, and must not be read as a ledger of debts.
  const distinctive =
    cols.amountIsBalance ||
    cols.paid !== -1 ||
    cols.outstanding !== -1 ||
    cols.due !== -1 ||
    cols.direction !== -1;

  return distinctive ? cols : null;
}

/**
 * The Position block the export writes below the balances, or any similar
 * summary. Everything from there down totals the rows above.
 */
function isSummaryHeading(row: Cell[]): boolean {
  const texts = headings(row);
  if (texts.length === 0) return false;
  const summaryWord = texts.some(
    (t) => t === "position" || t === "summary" || t === "totals",
  );
  const hasAmount = texts.some(
    (t) => AMOUNT_HEADINGS.has(t) || BALANCE_AMOUNT_HEADINGS.has(t),
  );
  return summaryWord && hasAmount;
}

/* -------------------------------- row values ------------------------------- */

/**
 * Which way a balance points.
 *
 * Reads the words the export writes, and the plainer ones somebody would type.
 * Anything unrecognised is money we owe, which is what "balance to be paid"
 * means unless it says otherwise.
 */
export function readDirection(text: string): BalanceDirection {
  const t = fold(text);
  if (t === "") return "payable";
  if (t === fold(OWED_LABEL)) return "receivable";
  if (t === fold(OWE_LABEL)) return "payable";
  if (
    t === "receivable" ||
    t === "in" ||
    t === "incoming" ||
    t === "owed to us" ||
    t === "owed to me" ||
    t === "they owe" ||
    t === "debtor" ||
    t === "to receive" ||
    t === "receive"
  ) {
    return "receivable";
  }
  return "payable";
}

/** A date in a cell, as a plain ISO date, or "". */
function readDate(cell: Cell): string {
  // A Date is outside the Cell type, but a grid built from a live worksheet can
  // still hand one over, so it is handled rather than stringified by accident.
  const value = cell as unknown;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? "" : value.toISOString().slice(0, 10);
  }
  const text = cellText(cell);
  if (text === "") return "";
  const time = Date.parse(text);
  return Number.isNaN(time) ? "" : new Date(time).toISOString().slice(0, 10);
}

/* --------------------------------- parsing -------------------------------- */

/** Read one worksheet's grid as balances. */
export function parseBalanceGrid(
  rows: Cell[][],
  sheetName: string,
): BalanceImport {
  const out: BalanceImport = {
    sheetName,
    rows: [],
    skipped: [],
    found: {
      party: false,
      amount: false,
      paid: false,
      outstanding: false,
      due: false,
      direction: false,
    },
  };

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
      "No balances were recognised. The sheet needs a row naming its columns: a Party column, an amount (Total, Balance or Outstanding), and at least one of Paid, Outstanding, Due or Direction so it cannot be confused with a sheet of expenses.";
    return out;
  }

  out.found = {
    party: cols.party !== -1,
    amount: cols.amount !== -1,
    paid: cols.paid !== -1,
    outstanding: cols.outstanding !== -1,
    due: cols.due !== -1,
    direction: cols.direction !== -1,
  };

  const at = (row: Cell[], col: number): Cell => (col === -1 ? "" : row[col]);

  for (let r = headerAt + 1; r < rows.length; r += 1) {
    const row = rows[r];
    const rowNumber = r + 1;

    if (isBlankRow(row)) continue;
    if (isSummaryHeading(row) || columnsFrom(row) !== null) break;

    const party = cellText(at(row, cols.party));
    const total = readAmount(at(row, cols.amount));
    const paid = readAmount(at(row, cols.paid));
    const outstanding = readAmount(at(row, cols.outstanding));

    const skip = (reason: string) =>
      out.skipped.push({ row: rowNumber, detail: describe(row), reason });

    if (party !== "" && isTotalLabel(party)) {
      skip("a total row, not a balance");
      continue;
    }
    if (party === "") {
      skip("no party, so there is nobody to settle with");
      continue;
    }

    // Three shapes are accepted, in this order:
    //   total and paid      -> the pair as given
    //   total only          -> nothing paid yet
    //   outstanding only    -> what is left is the whole balance
    let amountValue = total.value;
    let paidValue = paid.value ?? 0;

    if (amountValue === null && outstanding.value !== null) {
      amountValue = outstanding.value;
      paidValue = 0;
    }

    if (amountValue === null) {
      skip("no amount");
      continue;
    }
    if (total.bracketed || amountValue < 0) {
      skip("the amount is written as a credit, not a balance");
      continue;
    }
    if (amountValue === 0) {
      skip("the amount is zero");
      continue;
    }
    if (amountValue > LIMITS.money) {
      skip("the amount is unrealistically large");
      continue;
    }
    if (paid.bracketed || paidValue < 0) {
      skip("the paid figure is negative");
      continue;
    }
    if (paidValue > amountValue) {
      skip("more has been paid than the total, so one of the two is wrong");
      continue;
    }

    // A row that is already settled is not a balance to be paid. Reported rather
    // than dropped, so a sheet of finished business does not look half-read.
    if (paidValue === amountValue) {
      skip("already settled, so there is nothing outstanding");
      continue;
    }

    const containerText = cellText(at(row, cols.container));
    const built = createBalanceDue({
      party,
      direction: readDirection(cellText(at(row, cols.direction))),
      amount: amountValue,
      paid: paidValue,
      containerId: isGeneralLabel(containerText) ? "" : containerText,
      orderNumber: cellText(at(row, cols.order)),
      dueAt: readDate(at(row, cols.due)),
    });

    out.rows.push({
      party: built.party,
      direction: built.direction,
      amount: built.amount,
      paid: built.paid,
      containerId: built.containerId,
      orderNumber: built.orderNumber,
      dueAt: built.dueAt,
      row: rowNumber,
      duplicate: false,
    });

    if (out.rows.length >= LIMITS.rows) break;
  }

  return out;
}

/**
 * Pick the worksheet the balances are on.
 *
 * A tab called Balances wins, so uploading a whole balance sheet workbook reads
 * the right one instead of trying the Summary tab first.
 */
export function pickBalanceSheet(
  grids: Array<{ name: string; rows: Cell[][] }>,
): BalanceImport {
  if (grids.length === 0) {
    return {
      sheetName: "",
      rows: [],
      skipped: [],
      found: {
        party: false,
        amount: false,
        paid: false,
        outstanding: false,
        due: false,
        direction: false,
      },
      problem: "That workbook has no sheets in it.",
    };
  }

  const parsed = grids.map((g) => parseBalanceGrid(g.rows, g.name));

  const named = parsed.find(
    (p) => fold(p.sheetName) === "balances" && p.rows.length > 0,
  );
  if (named) return named;

  let best = parsed[0];
  for (const candidate of parsed) {
    if (candidate.rows.length > best.rows.length) best = candidate;
  }
  return best;
}

/* ------------------------------- duplicates ------------------------------- */

/** What makes two balances the same entry. */
function dupKey(row: {
  party: string;
  direction: BalanceDirection;
  amount: number;
  containerId: string;
}): string {
  return `${fold(row.party)}|${row.direction}|${row.amount}|${row.containerId}`;
}

/**
 * Flag balances already on the sheet. Counted, not merely matched, so a second
 * identical debt to the same party is still recognised as new.
 *
 * The paid figure is deliberately not part of the key: the same balance part-paid
 * to a different degree is the same balance, and flagging it lets a re-upload
 * update rather than duplicate.
 */
export function markBalanceDuplicates(
  rows: ImportedBalance[],
  existing: BalanceDue[],
): ImportedBalance[] {
  return markDuplicatesBy(rows, existing.map(dupKey), dupKey);
}

/** The rows that are not already on the sheet. */
export function newBalances(rows: ImportedBalance[]): ImportedBalance[] {
  return rows.filter((row) => !row.duplicate);
}

/* --------------------------------- adding --------------------------------- */

export interface AddBalancesResult {
  sheet: BalanceSheet;
  added: number;
  /** Rows that did not fit under the entry cap. */
  dropped: number;
}

/**
 * Add imported balances to the sheet.
 *
 * One pass rather than addBalanceDue per row, so file order survives instead of
 * being reversed by repeated prepending, and the cap is applied once with the
 * overflow reported rather than the tail vanishing.
 */
export function addImportedBalances(
  sheet: BalanceSheet,
  rows: ImportedBalance[],
  source = "",
): AddBalancesResult {
  const room = Math.max(0, MAX_ENTRIES - sheet.balances.length);
  const take = rows.slice(0, room);
  const note = source.trim() === "" ? "" : `Imported from ${source.trim()}`;

  const built: BalanceDue[] = take.map((row) =>
    createBalanceDue({
      party: row.party,
      direction: row.direction,
      amount: row.amount,
      paid: row.paid,
      containerId: row.containerId,
      orderNumber: row.orderNumber,
      dueAt: row.dueAt,
      note,
    }),
  );

  return {
    sheet: {
      ...sheet,
      balances: [...built.reverse(), ...sheet.balances].slice(0, MAX_ENTRIES),
      updatedAt: new Date().toISOString(),
    },
    added: built.length,
    dropped: rows.length - take.length,
  };
}

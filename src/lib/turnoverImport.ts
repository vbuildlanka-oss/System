/**
 * Reading turnover - what each container brought in - out of a spreadsheet.
 *
 * Until this existed, turnover was the one ledger on the balance sheet that
 * could be exported but never imported, so restoring a balance sheet workbook
 * brought back every expense and balance and silently lost every container's
 * takings, which is half of the profit arithmetic.
 *
 * Same rules as the other importers: a heading row is required, rows are read
 * until a total or a second heading, and nothing is added here - the page
 * previews it and flags what is already on the sheet.
 */

import { cellText, type Cell } from "./parseTabular";
import { readDateCell } from "./expensesImport";
import {
  AMOUNT_HEADINGS,
  CONTAINER_HEADINGS,
  describe,
  fold,
  heading,
  HEADER_SEARCH_ROWS,
  isBlankRow,
  isTotalLabel,
  markDuplicatesBy,
  readAmount,
  type SkippedRow,
} from "./sheetImport";
import {
  createTurnover,
  MAX_ENTRIES,
  type BalanceSheet,
  type TurnoverEntry,
} from "./balanceSheet";
import { LIMITS } from "./types";

export interface ImportedTurnover {
  containerId: string;
  turnover: number;
  at?: string;
  note?: string;
  row: number;
  duplicate: boolean;
}

export interface TurnoverImport {
  sheetName: string;
  rows: ImportedTurnover[];
  skipped: SkippedRow[];
  problem?: string;
}

const TURNOVER_HEADINGS = new Set([
  "turnover",
  "revenue",
  "sales",
  "income",
  "takings",
  "earned",
]);
const DATE_HEADINGS = new Set(["date", "day"]);
const NOTE_HEADINGS = new Set(["note", "notes", "remark", "remarks", "comment"]);

interface Columns {
  container: number;
  turnover: number;
  date: number;
  note: number;
}

function columnsFrom(row: Cell[]): Columns | null {
  const cols: Columns = { container: -1, turnover: -1, date: -1, note: -1 };
  row.forEach((cell, c) => {
    const text = heading(cell);
    if (text === "") return;
    if (cols.turnover === -1 && TURNOVER_HEADINGS.has(text)) cols.turnover = c;
    else if (cols.container === -1 && CONTAINER_HEADINGS.has(text)) cols.container = c;
    else if (cols.date === -1 && DATE_HEADINGS.has(text)) cols.date = c;
    else if (cols.note === -1 && NOTE_HEADINGS.has(text)) cols.note = c;
  });
  // A generic "Amount" column only counts as turnover beside a container, and
  // only when nothing says "turnover" outright.
  if (cols.turnover === -1 && cols.container !== -1) {
    row.forEach((cell, c) => {
      if (cols.turnover === -1 && AMOUNT_HEADINGS.has(heading(cell))) cols.turnover = c;
    });
  }
  return cols.container !== -1 && cols.turnover !== -1 ? cols : null;
}

export function parseTurnoverGrid(rows: Cell[][], sheetName: string): TurnoverImport {
  const out: TurnoverImport = { sheetName, rows: [], skipped: [] };

  let headerAt = -1;
  let cols: Columns | null = null;
  for (let r = 0; r < Math.min(rows.length, HEADER_SEARCH_ROWS); r += 1) {
    const candidate = columnsFrom(rows[r]);
    if (candidate) {
      headerAt = r;
      cols = candidate;
      break;
    }
  }
  if (!cols) {
    out.problem =
      "No heading row was found. The sheet needs a Container column and a Turnover column.";
    return out;
  }

  const at = (row: Cell[], col: number): Cell => (col === -1 ? "" : row[col]);
  for (let r = headerAt + 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (isBlankRow(row)) continue;
    if (columnsFrom(row) !== null) break;

    const containerText = cellText(at(row, cols.container));
    const firstText = cellText(row[0]);
    const amount = readAmount(at(row, cols.turnover));
    const skip = (reason: string) =>
      out.skipped.push({ row: r + 1, detail: describe(row), reason });

    if (isTotalLabel(firstText) || isTotalLabel(containerText)) {
      skip("a total row, not an entry");
      break;
    }
    if (containerText === "") {
      skip("no container");
      continue;
    }
    if (amount.value === null || amount.value <= 0 || amount.bracketed) {
      skip("no turnover amount");
      continue;
    }
    if (amount.value > LIMITS.money) {
      skip("the amount is unrealistically large");
      continue;
    }

    const built = createTurnover({ containerId: containerText, turnover: amount.value });
    const day = readDateCell(at(row, cols.date));
    const note = cellText(at(row, cols.note));
    out.rows.push({
      containerId: built.containerId,
      turnover: built.turnover,
      ...(day !== "" ? { at: day } : {}),
      ...(note !== "" ? { note } : {}),
      row: r + 1,
      duplicate: false,
    });
    if (out.rows.length >= LIMITS.rows) break;
  }
  return out;
}

/** The Turnover tab of a workbook, or failing that whichever sheet reads best. */
export function pickTurnoverSheet(
  grids: Array<{ name: string; rows: Cell[][] }>,
): TurnoverImport {
  const named = grids.find((g) => fold(g.name) === "turnover");
  if (named) return parseTurnoverGrid(named.rows, named.name);
  const readings = grids.map((g) => parseTurnoverGrid(g.rows, g.name));
  const best = readings
    .filter((r) => !r.problem)
    .sort((a, b) => b.rows.length - a.rows.length)[0];
  return best ?? readings[0] ?? { sheetName: "", rows: [], skipped: [], problem: "The file has no sheets." };
}

const keyOf = (containerId: string, turnover: number) =>
  `${fold(containerId)}|${Math.round(turnover * 100)}`;

export function markTurnoverDuplicates(
  rows: ImportedTurnover[],
  existing: TurnoverEntry[],
): ImportedTurnover[] {
  return markDuplicatesBy(
    rows,
    existing.map((e) => keyOf(e.containerId, e.turnover)),
    (row) => keyOf(row.containerId, row.turnover),
  );
}

export function addImportedTurnover(
  sheet: BalanceSheet,
  rows: ImportedTurnover[],
  source = "",
): { sheet: BalanceSheet; added: number; dropped: number } {
  const room = Math.max(0, MAX_ENTRIES - sheet.turnover.length);
  const take = rows.slice(0, room);
  const fallbackNote = source.trim() === "" ? "" : `Imported from ${source.trim()}`;
  const built = take.map((row) =>
    createTurnover({
      containerId: row.containerId,
      turnover: row.turnover,
      note: row.note || fallbackNote,
      ...(row.at ? { at: `${row.at}T12:00:00.000Z` } : {}),
    }),
  );
  return {
    sheet: {
      ...sheet,
      turnover: [...built.reverse(), ...sheet.turnover].slice(0, MAX_ENTRIES),
      updatedAt: new Date().toISOString(),
    },
    added: built.length,
    dropped: rows.length - take.length,
  };
}

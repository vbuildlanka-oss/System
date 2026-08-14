import ExcelJS from "exceljs";

/**
 * The shared bits of every spreadsheet this app writes: number formats, the
 * house colours, and the handful of row helpers that give each tab the same
 * title, header and total treatment.
 *
 * Kept in one place so the balance sheet workbook and the expenses-only workbook
 * cannot drift apart in how they look or how they format money.
 */

/** Row 1 is the tab title, row 2 the column header, so data starts at row 3. */
export const DATA_START_ROW = 3;

/** Money, with a loss in red so a negative is never read as a positive. */
export const MONEY_FMT = '"Rs"#,##0.00;[Red]-"Rs"#,##0.00';
export const PERCENT_FMT = "0.0%";
export const DATE_FMT = "yyyy-mm-dd";
export const INK = "FF1F2937";
export const ACCENT = "FFE0E7FF";
export const RULE = "FF4F46E5";

/** Partner shown for an expense that arrived without one, matching byPartner. */
export const UNASSIGNED_PARTNER = "Unassigned";

/**
 * How many rows a data block occupies. Always at least one, so that an empty
 * sheet still has a blank row between the header and the total. Without it the
 * total row would land inside its own SUM range and Excel would refuse the file
 * as a circular reference.
 */
export function blockRows(count: number): number {
  return Math.max(count, 1);
}

/** Last row of a data block, i.e. the last row a SUM should reach. */
export function lastDataRow(count: number): number {
  return DATA_START_ROW + blockRows(count) - 1;
}

/** The row holding the Total for a block of `count` entries. */
export function totalRow(count: number): number {
  return lastDataRow(count) + 1;
}

/**
 * Oldest entry first.
 *
 * The page lists the newest entry at the top, which is what you want while
 * typing, but a workbook is read as a ledger - down the page, in the order
 * things happened. Entries made in the same moment keep the order they were
 * typed in: the array is newest-first, so ties are broken by reversing it.
 *
 * Sorting cannot affect any figure, because every formula matches on the
 * container or the partner rather than on a row position.
 */
export function chronological<T extends { at: string }>(rows: T[]): T[] {
  const when = (row: T): number => {
    const parsed = Date.parse(row.at);
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => when(a.row) - when(b.row) || b.index - a.index)
    .map((entry) => entry.row);
}

export interface Formula {
  formula: string;
  result: number | string;
}

/**
 * A formula cell carrying its own answer.
 *
 * The cached result matters as much as the formula: Excel recalculates when the
 * file opens, but Google Sheets, LibreOffice, Numbers and most preview panes
 * show a formula cell as blank until they do.
 */
export function formula(f: string, result: number | string): Formula {
  return { formula: f, result };
}

export function titleRow(
  sheet: ExcelJS.Worksheet,
  span: string,
  text: string,
): void {
  sheet.mergeCells(span);
  const cell = sheet.getCell(span.split(":")[0]);
  cell.value = text;
  cell.font = { bold: true, size: 15 };
  cell.alignment = { vertical: "middle" };
  sheet.getRow(1).height = 24;
}

/** Columns after `rightFrom` are right-aligned, being numbers. */
export function headerRow(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  labels: string[],
  rightFrom = 1,
): void {
  const row = sheet.getRow(rowNumber);
  row.values = labels;
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.height = 18;
  labels.forEach((_, i) => {
    const cell = row.getCell(i + 1);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
    cell.alignment = {
      vertical: "middle",
      horizontal: i + 1 > rightFrom ? "right" : "left",
    };
  });
}

/** Bold, ruled and tinted - used for every Total row. */
export function emphasise(row: ExcelJS.Row, columns: number): void {
  row.font = { bold: true };
  for (let col = 1; col <= columns; col += 1) {
    const cell = row.getCell(col);
    cell.border = { top: { style: "thin", color: { argb: RULE } } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT } };
  }
}

export function noteAt(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  span: string,
  text: string,
): void {
  sheet.mergeCells(span);
  const cell = sheet.getCell(`A${rowNumber}`);
  cell.value = text;
  cell.font = { italic: true, size: 9, color: { argb: "FF6B7280" } };
  cell.alignment = { wrapText: true, vertical: "top" };
  sheet.getRow(rowNumber).height = 28;
}

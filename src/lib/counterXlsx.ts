import ExcelJS from "exceljs";
import { countTotals, type CountDoc } from "./counter";
import {
  DATA_START_ROW,
  emphasise,
  formula,
  headerRow,
  lastDataRow,
  noteAt,
  titleRow,
  totalRow,
} from "./xlsxKit";

/**
 * The warehouse count as a spreadsheet: the item, and how many were counted.
 *
 *   Item | Count
 *
 * Two columns on purpose. What the list expected, the difference and whether an
 * item came up short are all comparisons, and this sheet is the tally itself - the
 * record of what was physically found. The comparison lives on the page, where it
 * can be acted on; putting it here would also print the expected quantities onto a
 * sheet that goes to whoever did the counting.
 *
 * The total is a formula, so correcting a figure re-totals the sheet.
 *
 * An item nobody reached is listed with an empty cell rather than a zero. Zero is a
 * finding; empty is an admission. It is the one distinction worth keeping in two
 * columns, so the footer says what an empty cell means and SUM leaves it out of the
 * total rather than counting it as none.
 *
 * No price appears. The list this came from had a per-bag price beside every
 * quantity; a count is about how many bags exist.
 */

export async function buildCountXlsx(doc: CountDoc): Promise<Buffer> {
  const totals = countTotals(doc);
  const count = doc.rows.length;

  const firstRow = DATA_START_ROW;
  const lastRow = lastDataRow(count);
  const totalRowNumber = totalRow(count);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "BaleBook";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const ws = workbook.addWorksheet("Bag Count", {
    views: [{ state: "frozen", ySplit: 2 }],
  });
  ws.columns = [{ width: 46 }, { width: 14 }];

  const heading = [doc.orderNumber, doc.containerId]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" - ");
  titleRow(ws, "A1:B1", heading === "" ? "Bag count" : `${heading} - Bag count`);

  headerRow(ws, 2, ["Item", "Count"], 1);

  doc.rows.forEach((row, i) => {
    const line = ws.getRow(firstRow + i);
    line.getCell(1).value = row.name;

    const counted = line.getCell(2);
    // Left empty when nobody reached it, so the sheet cannot claim a count that
    // was never taken.
    if (row.touched) {
      counted.value = row.counted;
      counted.numFmt = "0";
    }
    counted.alignment = { horizontal: "right" };
  });

  const totalsRow = ws.getRow(totalRowNumber);
  totalsRow.getCell(1).value = "Total";
  const countedTotal = totalsRow.getCell(2);
  countedTotal.value = formula(`SUM(B${firstRow}:B${lastRow})`, totals.counted);
  countedTotal.numFmt = "0";
  countedTotal.alignment = { horizontal: "right" };
  emphasise(totalsRow, 2);

  noteAt(
    ws,
    totalRowNumber + 2,
    `A${totalRowNumber + 2}:B${totalRowNumber + 2}`,
    totals.untouched > 0
      ? `The total is a formula, so correcting a count re-totals the sheet. ${totals.untouched} of these ${count} items were never counted: their cells are empty rather than zero, and the total leaves them out. An empty cell is not the same as counting none.`
      : "The total is a formula, so correcting a count re-totals the sheet. Every item on this sheet was counted. An empty cell would mean an item was never counted, rather than none being found.",
  );

  if (count > 0) {
    ws.autoFilter = {
      from: { row: 2, column: 1 },
      to: { row: lastRow, column: 2 },
    };
  }
  ws.pageSetup.printTitlesRow = "1:2";

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

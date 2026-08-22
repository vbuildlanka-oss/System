import ExcelJS from "exceljs";
import {
  countTotals,
  difference,
  type CountDoc,
} from "./counter";
import {
  COUNT_MATCHED,
  COUNT_OVER,
  COUNT_SHORT,
  COUNT_UNCOUNTED,
} from "./labels";
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
 * The warehouse count as a spreadsheet.
 *
 * Item | Expected | Counted | Difference | Status
 *
 * Only Expected and Counted are typed. The difference and the status are formulas,
 * so a figure corrected in Excel re-states whether that item is short, over or
 * right - a status written as a word would sit there contradicting the numbers
 * beside it the moment anyone edited one.
 *
 * There is no money on this sheet. The list it came from had a per-bag price and a
 * line total next to every quantity, and none of it is here: a count is about how
 * many bags exist, and the sheet gets handed to whoever did the counting.
 *
 * An item nobody reached leaves Counted empty rather than showing zero. Zero is a
 * finding; empty is an admission. The difference and status follow suit, so an
 * unfinished count cannot be read as a complete one.
 */

export async function buildCountXlsx(doc: CountDoc): Promise<Buffer> {
  const totals = countTotals(doc);
  const count = doc.rows.length;

  const firstRow = DATA_START_ROW;
  const lastRow = lastDataRow(count);
  const totalRowNumber = totalRow(count);

  const summaryHeader = totalRowNumber + 2;
  const statusCol = `$E$${firstRow}:$E$${lastRow}`;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "BaleBook";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const ws = workbook.addWorksheet("Bag Count", {
    views: [{ state: "frozen", ySplit: 2 }],
  });
  ws.columns = [
    { width: 42 },
    { width: 13 },
    { width: 13 },
    { width: 13 },
    { width: 14 },
  ];

  const heading = [doc.orderNumber, doc.containerId]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" - ");
  titleRow(ws, "A1:C1", heading === "" ? "Bag count" : `${heading} - Bag count`);
  const stamp = ws.getCell("D1");
  stamp.value = `Counted ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  stamp.font = { italic: true, size: 8, color: { argb: "FF9CA3AF" } };
  stamp.alignment = { horizontal: "right", vertical: "middle" };

  headerRow(ws, 2, ["Item", "Expected", "Counted", "Difference", "Status"], 1);

  doc.rows.forEach((row, i) => {
    const r = firstRow + i;
    const line = ws.getRow(r);
    line.getCell(1).value = row.name;

    const expected = line.getCell(2);
    expected.value = row.expected;
    expected.numFmt = "0";
    expected.alignment = { horizontal: "right" };

    const counted = line.getCell(3);
    // Left empty when nobody reached it, so the sheet cannot claim a count that
    // was never taken.
    if (row.touched) {
      counted.value = row.counted;
      counted.numFmt = "0";
    }
    counted.alignment = { horizontal: "right" };

    const diff = line.getCell(4);
    diff.value = formula(
      `IF(C${r}="","",C${r}-B${r})`,
      row.touched ? difference(row) : "",
    );
    diff.numFmt = "0;[Red]-0";
    diff.alignment = { horizontal: "right" };

    const status = line.getCell(5);
    status.value = formula(
      `IF(C${r}="","${COUNT_UNCOUNTED}",IF(C${r}=B${r},"${COUNT_MATCHED}",IF(C${r}<B${r},"${COUNT_SHORT}","${COUNT_OVER}")))`,
      !row.touched
        ? COUNT_UNCOUNTED
        : difference(row) === 0
          ? COUNT_MATCHED
          : difference(row) < 0
            ? COUNT_SHORT
            : COUNT_OVER,
    );
    status.alignment = { horizontal: "center" };
    if (row.touched && difference(row) !== 0) {
      status.font = { bold: true, color: { argb: "FFB91C1C" } };
    }
    if (row.added) {
      // Something found that was never on the list is worth spotting.
      line.getCell(1).font = { italic: true, color: { argb: "FF1D4ED8" } };
    }
  });

  const totalsRow = ws.getRow(totalRowNumber);
  totalsRow.getCell(1).value = "Total";
  const expectedTotal = totalsRow.getCell(2);
  expectedTotal.value = formula(
    `SUM(B${firstRow}:B${lastRow})`,
    totals.expected,
  );
  const countedTotal = totalsRow.getCell(3);
  countedTotal.value = formula(`SUM(C${firstRow}:C${lastRow})`, totals.counted);
  const diffTotal = totalsRow.getCell(4);
  diffTotal.value = formula(
    `C${totalRowNumber}-B${totalRowNumber}`,
    totals.counted - totals.expected,
  );
  for (const cell of [expectedTotal, countedTotal]) {
    cell.numFmt = "0";
    cell.alignment = { horizontal: "right" };
  }
  diffTotal.numFmt = "0;[Red]-0";
  diffTotal.alignment = { horizontal: "right" };
  emphasise(totalsRow, 5);

  /* -------------------------------- summary -------------------------------- */

  headerRow(ws, summaryHeader, ["Result", "Items"]);
  const results: Array<[string, string, number]> = [
    [
      COUNT_MATCHED,
      `COUNTIF(${statusCol},"${COUNT_MATCHED}")`,
      totals.matched,
    ],
    [COUNT_SHORT, `COUNTIF(${statusCol},"${COUNT_SHORT}")`, totals.short],
    [COUNT_OVER, `COUNTIF(${statusCol},"${COUNT_OVER}")`, totals.over],
    [
      COUNT_UNCOUNTED,
      `COUNTIF(${statusCol},"${COUNT_UNCOUNTED}")`,
      totals.untouched,
    ],
  ];
  results.forEach((entry, i) => {
    const row = ws.getRow(summaryHeader + 1 + i);
    row.getCell(1).value = entry[0];
    const cell = row.getCell(2);
    cell.value = formula(entry[1], entry[2]);
    cell.numFmt = "0";
    cell.alignment = { horizontal: "right" };
  });
  const resultTotal = ws.getRow(summaryHeader + 5);
  resultTotal.getCell(1).value = "Items on the sheet";
  const itemCount = resultTotal.getCell(2);
  itemCount.value = formula(
    `SUM(B${summaryHeader + 1}:B${summaryHeader + 4})`,
    totals.items,
  );
  itemCount.numFmt = "0";
  itemCount.alignment = { horizontal: "right" };
  emphasise(resultTotal, 2);

  noteAt(
    ws,
    summaryHeader + 7,
    `A${summaryHeader + 7}:E${summaryHeader + 7}`,
    `Expected and Counted are the only typed figures; the difference, the status and the summary are formulas, so correcting a count re-states everything. An item nobody reached has an empty Counted cell and reads "${COUNT_UNCOUNTED}" - that is not the same as counting none of it. Names in italic blue were found during the count and were not on the list. There are no prices on this sheet.`,
  );

  if (count > 0) {
    ws.autoFilter = {
      from: { row: 2, column: 1 },
      to: { row: lastRow, column: 5 },
    };
  }
  ws.pageSetup.printTitlesRow = "1:2";

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

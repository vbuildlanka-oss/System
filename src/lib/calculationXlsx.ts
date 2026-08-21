import ExcelJS from "exceljs";
import {
  calcTotals,
  sellingPerBag,
  lineCost,
  lineProfit,
  lineTotal,
  type CalcDoc,
} from "./calculation";
import { FAST_LABEL, STEADY_LABEL } from "./labels";
import {
  DATA_START_ROW,
  emphasise,
  formula,
  headerRow,
  lastDataRow,
  MONEY_FMT,
  noteAt,
  PERCENT_FMT,
  titleRow,
  totalRow,
} from "./xlsxKit";

/**
 * The markup calculation as a spreadsheet.
 *
 * Internal, and named so it cannot be mistaken for anything a buyer should see:
 * it carries what each bag costs us and what we make on it, which is the whole
 * point of the sheet and exactly what must never leave the building by accident.
 *
 * Two columns are typed and everything else is worked out from them:
 *
 *   Bags          typed
 *   Cost / bag    typed
 *   Markup / bag  typed          <- the profit, per bag
 *   Selling / bag = cost + markup
 *   Line total    = bags x selling
 *   Profit        = bags x markup   <- a column of its own, so the split below it
 *                                      can be a plain SUMIF rather than a guess
 *
 * So the sheet can be used the way a spreadsheet actually gets used: try a markup,
 * see what the order makes, try another. A profit figure written as a number would
 * be a lie the moment a markup was edited.
 *
 * The fast/steady column is a real value rather than a tick, so the split below it
 * can be a SUMIF that follows an item being reclassified.
 */

export async function buildCalculationXlsx(doc: CalcDoc): Promise<Buffer> {
  const totals = calcTotals(doc);
  const count = doc.rows.length;

  const firstRow = DATA_START_ROW;
  const lastRow = lastDataRow(count);
  const totalRowNumber = totalRow(count);

  const summaryHeader = totalRowNumber + 2;
  const splitHeader = summaryHeader + 7;

  const speedCol = `$H$${firstRow}:$H$${lastRow}`;
  const bagsCol = `$B$${firstRow}:$B$${lastRow}`;
  const profitCol = `$G$${firstRow}:$G$${lastRow}`;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "BaleBook";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const ws = workbook.addWorksheet("Calculation", {
    views: [{ state: "frozen", ySplit: 2 }],
  });
  ws.columns = [
    { width: 40 },
    { width: 10 },
    { width: 15 },
    { width: 15 },
    { width: 15 },
    { width: 16 },
    { width: 16 },
    { width: 12 },
  ];

  titleRow(
    ws,
    "A1:F1",
    doc.orderNumber === ""
      ? "Markup calculation"
      : `${doc.orderNumber} - Markup calculation`,
  );
  const stamp = ws.getCell("G1");
  stamp.value = `Internal - generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  stamp.font = { italic: true, size: 8, color: { argb: "FF9CA3AF" } };
  stamp.alignment = { horizontal: "right", vertical: "middle" };

  headerRow(
    ws,
    2,
    [
      "Item",
      "Bags",
      "Cost / bag",
      "Markup / bag",
      "Selling / bag",
      "Line total",
      "Profit",
      "Moves",
    ],
    1,
  );

  doc.rows.forEach((row, i) => {
    const r = firstRow + i;
    const line = ws.getRow(r);
    line.getCell(1).value = row.name;

    const bags = line.getCell(2);
    bags.value = row.qty;
    bags.numFmt = "0";
    bags.alignment = { horizontal: "right" };

    const cost = line.getCell(3);
    cost.value = row.costPerBag;
    const markup = line.getCell(4);
    markup.value = row.markup;
    // A markup set by hand is worth seeing at a glance, since it is the figure
    // that was thought about rather than inherited.
    if (row.overridden) {
      markup.font = { bold: true, color: { argb: "FF1D4ED8" } };
    }

    const selling = line.getCell(5);
    selling.value = formula(`C${r}+D${r}`, sellingPerBag(row));
    const total = line.getCell(6);
    total.value = formula(`B${r}*E${r}`, lineTotal(row));

    for (const cell of [cost, markup, selling, total]) {
      cell.numFmt = MONEY_FMT;
      cell.alignment = { horizontal: "right" };
    }

    // What this line earns. Derived, so trying a different markup re-prices it.
    const profit = line.getCell(7);
    profit.value = formula(`B${r}*D${r}`, lineProfit(row));
    profit.numFmt = MONEY_FMT;
    profit.alignment = { horizontal: "right" };

    const speed = line.getCell(8);
    speed.value = row.fast ? FAST_LABEL : STEADY_LABEL;
    speed.alignment = { horizontal: "center" };
  });

  const totalsRow = ws.getRow(totalRowNumber);
  totalsRow.getCell(1).value = "Total";
  const bagTotal = totalsRow.getCell(2);
  bagTotal.value = formula(
    `SUM(B${firstRow}:B${lastRow})`,
    totals.bags,
  );
  bagTotal.numFmt = "0";
  bagTotal.alignment = { horizontal: "right" };
  const lineTotalSum = totalsRow.getCell(6);
  lineTotalSum.value = formula(
    `SUM(F${firstRow}:F${lastRow})`,
    totals.selling,
  );
  lineTotalSum.numFmt = MONEY_FMT;
  lineTotalSum.alignment = { horizontal: "right" };
  const profitSum = totalsRow.getCell(7);
  profitSum.value = formula(`SUM(G${firstRow}:G${lastRow})`, totals.profit);
  profitSum.numFmt = MONEY_FMT;
  profitSum.alignment = { horizontal: "right" };
  emphasise(totalsRow, 8);

  /* -------------------------------- summary -------------------------------- */

  headerRow(ws, summaryHeader, ["Figure", "Amount"]);
  const figures: Array<[string, string, number | string, string]> = [
    [
      "What the bags cost us",
      `SUMPRODUCT(${bagsCol},$C$${firstRow}:$C$${lastRow})`,
      totals.cost,
      MONEY_FMT,
    ],
    ["Profit on the markup", `SUM(${profitCol})`, totals.profit, MONEY_FMT],
    [
      "What it sells for",
      `B${summaryHeader + 1}+B${summaryHeader + 2}`,
      totals.selling,
      MONEY_FMT,
    ],
    [
      "Markup per bag, on average",
      `IF(B${totalRowNumber}=0,"",B${summaryHeader + 2}/B${totalRowNumber})`,
      totals.averageMarkup === null ? "" : totals.averageMarkup,
      MONEY_FMT,
    ],
    [
      "Profit as a share of the sale",
      `IF(B${summaryHeader + 3}=0,"",B${summaryHeader + 2}/B${summaryHeader + 3})`,
      totals.margin === null ? "" : totals.margin / 100,
      PERCENT_FMT,
    ],
  ];
  figures.forEach((entry, i) => {
    const row = ws.getRow(summaryHeader + 1 + i);
    row.getCell(1).value = entry[0];
    const cell = row.getCell(2);
    cell.value = formula(entry[1], entry[2]);
    cell.numFmt = entry[3];
    cell.alignment = { horizontal: "right" };
  });
  emphasise(ws.getRow(summaryHeader + 2), 2);

  /* --------------------------- fast versus steady --------------------------- */

  headerRow(ws, splitHeader, ["Moves", "Bags", "Profit"]);
  const split: Array<[string, number, number]> = [
    [FAST_LABEL, totals.fastBags, totals.fastProfit],
    [STEADY_LABEL, totals.normalBags, totals.normalProfit],
  ];
  split.forEach((entry, i) => {
    const r = splitHeader + 1 + i;
    const row = ws.getRow(r);
    row.getCell(1).value = entry[0];

    const bags = row.getCell(2);
    bags.value = formula(
      `SUMIF(${speedCol},$A${r},${bagsCol})`,
      entry[1],
    );
    bags.numFmt = "0";
    bags.alignment = { horizontal: "right" };

    const profit = row.getCell(3);
    profit.value = formula(
      `SUMIF(${speedCol},$A${r},${profitCol})`,
      entry[2],
    );
    profit.numFmt = MONEY_FMT;
    profit.alignment = { horizontal: "right" };
  });
  const splitTotal = ws.getRow(splitHeader + 3);
  splitTotal.getCell(1).value = "Total";
  const splitBags = splitTotal.getCell(2);
  splitBags.value = formula(
    `SUM(B${splitHeader + 1}:B${splitHeader + 2})`,
    totals.bags,
  );
  splitBags.numFmt = "0";
  splitBags.alignment = { horizontal: "right" };
  const splitProfit = splitTotal.getCell(3);
  splitProfit.value = formula(
    `SUM(C${splitHeader + 1}:C${splitHeader + 2})`,
    totals.profit,
  );
  splitProfit.numFmt = MONEY_FMT;
  splitProfit.alignment = { horizontal: "right" };
  emphasise(splitTotal, 3);

  noteAt(
    ws,
    splitHeader + 5,
    `A${splitHeader + 5}:H${splitHeader + 5}`,
    `Internal working. Bags, Cost / bag and Markup / bag are the only typed figures; selling prices, line totals, the profit and the split below are formulas over them, so trying a different markup in Excel re-prices the order. The markup is the profit. A markup shown in bold blue was set for that item by hand rather than taken from the figure applied across the board. "${FAST_LABEL}" and "${STEADY_LABEL}" drive the split, so changing one re-counts it.`,
  );

  if (count > 0) {
    ws.autoFilter = {
      from: { row: 2, column: 1 },
      to: { row: lastRow, column: 8 },
    };
  }
  ws.pageSetup.printTitlesRow = "1:2";

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

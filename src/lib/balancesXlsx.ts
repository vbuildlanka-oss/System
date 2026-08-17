import ExcelJS from "exceljs";
import {
  balanceDueTotals,
  balanceOutstanding,
  byParty,
  type BalanceDue,
  type BalanceSheet,
} from "./balanceSheet";
import { OWE_LABEL, OWED_LABEL } from "./labels";
import {
  DATA_START_ROW,
  DATE_FMT,
  emphasise,
  formula,
  headerRow,
  lastDataRow,
  MONEY_FMT,
  noteAt,
  titleRow,
  totalRow,
} from "./xlsxKit";

/**
 * The balances on their own: who, which way, how much, how much paid, when due.
 *
 * A chase-list. Money we owe first, then money owed to us, and within each the
 * soonest due at the top, because the reason for printing this is to work out
 * what to deal with next.
 *
 * It carries no turnover, no expenses and no profit. What is outstanding is a
 * position, and mixing it with trading figures is what makes a balance sheet
 * mislead - so this file simply does not contain them.
 *
 * Every derived figure is a formula: change a Total or a Paid figure in Excel and
 * what is left, the status, the position and the per-party rows all follow. The
 * headings are the ones balancesImport.ts reads, so this file can be edited and
 * uploaded back, and the two must be changed together.
 */

/** Money we owe first: this is a list of things to settle. */
function chaseOrder(balances: BalanceDue[]): BalanceDue[] {
  const rank = (b: BalanceDue) => (b.direction === "payable" ? 0 : 1);
  return [...balances].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      // Undated last, since a balance with no date is not a deadline.
      (a.dueAt || "9999-99-99").localeCompare(b.dueAt || "9999-99-99") ||
      a.party.localeCompare(b.party),
  );
}

export async function buildBalancesXlsx(sheet: BalanceSheet): Promise<Buffer> {
  const balances = chaseOrder(sheet.balances);
  const dues = balanceDueTotals(sheet);
  const parties = byParty(sheet);
  const count = balances.length;

  const firstRow = DATA_START_ROW;
  const lastRow = lastDataRow(count);
  const totalRowNumber = totalRow(count);

  const posHeader = totalRowNumber + 2;
  const partyHeader = posHeader + 5;
  const partyFirst = partyHeader + 1;
  const partyLast = partyFirst + Math.max(parties.length, 1) - 1;
  const partyTotal = partyLast + 1;

  const partyCol = `$A$${firstRow}:$A$${lastRow}`;
  const directionCol = `$B$${firstRow}:$B$${lastRow}`;
  const leftCol = `$E$${firstRow}:$E$${lastRow}`;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "BaleBook";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const ws = workbook.addWorksheet("Balances", {
    views: [{ state: "frozen", ySplit: 2 }],
  });
  ws.columns = [
    { width: 26 },
    { width: 14 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 12 },
    { width: 12 },
    { width: 20 },
    { width: 22 },
  ];

  titleRow(ws, "A1:G1", "Balances to be paid");
  // When the file was made, so an old download is not mistaken for today's.
  const stamp = ws.getCell("H1");
  stamp.value = `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  stamp.font = { italic: true, size: 8, color: { argb: "FF9CA3AF" } };
  stamp.alignment = { horizontal: "right", vertical: "middle" };

  headerRow(
    ws,
    2,
    [
      "Party",
      "Direction",
      "Total",
      "Paid",
      "Outstanding",
      "Due",
      "Status",
      "Container",
      "Order number",
    ],
    2,
  );

  balances.forEach((balance, i) => {
    const r = firstRow + i;
    const row = ws.getRow(r);
    row.getCell(1).value = balance.party;
    row.getCell(2).value =
      balance.direction === "receivable" ? OWED_LABEL : OWE_LABEL;

    const total = row.getCell(3);
    total.value = balance.amount;
    const paid = row.getCell(4);
    paid.value = balance.paid;
    const left = row.getCell(5);
    left.value = formula(`C${r}-D${r}`, balanceOutstanding(balance));
    for (const cell of [total, paid, left]) {
      cell.numFmt = MONEY_FMT;
      cell.alignment = { horizontal: "right" };
    }

    const due = row.getCell(6);
    if (balance.dueAt !== "") {
      due.value = new Date(`${balance.dueAt}T00:00:00.000Z`);
      due.numFmt = DATE_FMT;
    }

    // Live, so it cannot go stale the moment a paid figure is edited. Overdue is
    // worked out against the day the file is opened, not the day it was made.
    const overdue =
      balance.dueAt !== "" &&
      balanceOutstanding(balance) > 0 &&
      balance.dueAt < new Date().toISOString().slice(0, 10);
    const status = row.getCell(7);
    status.value = formula(
      `IF(E${r}=0,"settled",IF(AND(F${r}<>"",F${r}<TODAY()),"overdue",IF(D${r}>0,"part-paid","unpaid")))`,
      balanceOutstanding(balance) === 0
        ? "settled"
        : overdue
          ? "overdue"
          : balance.paid > 0
            ? "part-paid"
            : "unpaid",
    );
    status.alignment = { horizontal: "center" };
    if (overdue) status.font = { bold: true, color: { argb: "FFB91C1C" } };

    row.getCell(8).value = balance.containerId;
    row.getCell(9).value = balance.orderNumber;
  });

  const totals = ws.getRow(totalRowNumber);
  totals.getCell(1).value = "Total";
  const totalCells: Array<[string, number]> = [
    ["C", dues.payable + dues.receivable],
    ["D", dues.paid],
    ["E", dues.payableOutstanding + dues.receivableOutstanding],
  ];
  for (const entry of totalCells) {
    const cell = totals.getCell(entry[0].charCodeAt(0) - 64);
    cell.value = formula(
      `SUM(${entry[0]}${firstRow}:${entry[0]}${lastRow})`,
      entry[1],
    );
    cell.numFmt = MONEY_FMT;
    cell.alignment = { horizontal: "right" };
  }
  emphasise(totals, 9);

  /* ------------------------------- position -------------------------------- */

  headerRow(ws, posHeader, ["Position", "Amount"]);
  const position: Array<[string, string, number]> = [
    [
      "Still to pay",
      `SUMIF(${directionCol},"${OWE_LABEL}",${leftCol})`,
      dues.payableOutstanding,
    ],
    [
      "Still to receive",
      `SUMIF(${directionCol},"${OWED_LABEL}",${leftCol})`,
      dues.receivableOutstanding,
    ],
    ["Net position", `B${posHeader + 2}-B${posHeader + 1}`, dues.net],
  ];
  position.forEach((entry, i) => {
    const row = ws.getRow(posHeader + 1 + i);
    row.getCell(1).value = entry[0];
    const cell = row.getCell(2);
    cell.value = formula(entry[1], entry[2]);
    cell.numFmt = MONEY_FMT;
    cell.alignment = { horizontal: "right" };
  });
  emphasise(ws.getRow(posHeader + 3), 2);

  /* ------------------------------- by party -------------------------------- */

  headerRow(ws, partyHeader, ["Party", "We owe", "Owed to us", "Entries"]);
  parties.forEach((entry, i) => {
    const r = partyFirst + i;
    const row = ws.getRow(r);
    row.getCell(1).value = entry.party;

    // Split by direction as well as party: a party who is both owed and owing
    // would otherwise show one figure that is neither.
    const owe = row.getCell(2);
    owe.value = formula(
      `SUMIFS(${leftCol},${partyCol},$A${r},${directionCol},"${OWE_LABEL}")`,
      entry.payableOutstanding,
    );
    const owed = row.getCell(3);
    owed.value = formula(
      `SUMIFS(${leftCol},${partyCol},$A${r},${directionCol},"${OWED_LABEL}")`,
      entry.receivableOutstanding,
    );
    for (const cell of [owe, owed]) {
      cell.numFmt = MONEY_FMT;
      cell.alignment = { horizontal: "right" };
    }
    const entries = row.getCell(4);
    entries.value = formula(`COUNTIF(${partyCol},$A${r})`, entry.count);
    entries.numFmt = "0";
    entries.alignment = { horizontal: "right" };
  });

  const partyTotals = ws.getRow(partyTotal);
  partyTotals.getCell(1).value = "Total";
  const partySums: Array<[string, number]> = [
    ["B", dues.payableOutstanding],
    ["C", dues.receivableOutstanding],
  ];
  for (const entry of partySums) {
    const cell = partyTotals.getCell(entry[0].charCodeAt(0) - 64);
    cell.value = formula(
      `SUM(${entry[0]}${partyFirst}:${entry[0]}${partyLast})`,
      entry[1],
    );
    cell.numFmt = MONEY_FMT;
    cell.alignment = { horizontal: "right" };
  }
  const partyCount = partyTotals.getCell(4);
  partyCount.value = formula(`SUM(D${partyFirst}:D${partyLast})`, count);
  partyCount.numFmt = "0";
  partyCount.alignment = { horizontal: "right" };
  emphasise(partyTotals, 4);

  noteAt(
    ws,
    partyTotal + 2,
    `A${partyTotal + 2}:I${partyTotal + 2}`,
    `Outstanding, Status and every figure below are formulas, so changing a Total or a Paid figure updates them. Status and the overdue colour are worked out against the day this file is opened. Direction must read "${OWE_LABEL}" or "${OWED_LABEL}". Add rows above the Total and this sheet can be uploaded back into the Balance Sheet page. This is a position, not profit: no turnover, expense or profit figure appears here.`,
  );

  if (count > 0) {
    ws.autoFilter = {
      from: { row: 2, column: 1 },
      to: { row: lastRow, column: 9 },
    };
  }
  ws.pageSetup.printTitlesRow = "1:2";

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

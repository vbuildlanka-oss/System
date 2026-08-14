import ExcelJS from "exceljs";
import { byPartner, type BalanceSheet, type Expense } from "./balanceSheet";
import {
  chronological,
  DATA_START_ROW,
  emphasise,
  formula,
  GENERAL_LABEL,
  headerRow,
  lastDataRow,
  MONEY_FMT,
  noteAt,
  titleRow,
  totalRow,
  UNASSIGNED_PARTNER,
} from "./xlsxKit";

/**
 * The expenses on their own: expense name, partner, container, amount.
 *
 * This is deliberately not a cut-down balance sheet. It carries no turnover, no
 * profit and no margin, so what the containers earned stays out of it. The
 * container is named because an expense is only worth recording against the
 * shipment it belongs to.
 *
 * Layout:
 *
 *   row 1              Expenses
 *   row 2              Expense | Partner | Container | Amount
 *   row 3 .. n+2       the expenses, grouped by partner
 *   row n+3            Total   |         |           | =SUM(D3:D{n+2})
 *   row n+5 onwards    a per-partner block, live over the rows above
 *
 * The entries stay one unbroken block with no subtotals mixed in, so the Total
 * is a single plain SUM that cannot double-count. The per-partner figures sit
 * below it as SUMIF and COUNTIF over that same block, so they follow along when
 * an amount is edited in the spreadsheet.
 *
 * This is also the shape `expensesImport.ts` reads back, so the two must be
 * changed together: the header names, the "(general)" container label, and the
 * fact that the Total row and the per-partner block sit below the entries and
 * must not be mistaken for expenses.
 */

/** Expense rows are grouped under their partner, biggest spender first. */
function groupedByPartner(sheet: BalanceSheet): Expense[] {
  const order = byPartner(sheet).map((row) => row.partner);
  const rows = chronological(sheet.expenses);
  const partnerOf = (e: Expense) => e.partner.trim() || UNASSIGNED_PARTNER;

  const out: Expense[] = [];
  for (const partner of order) {
    for (const expense of rows) {
      if (partnerOf(expense) === partner) out.push(expense);
    }
  }
  // Nothing should fall through, since byPartner covers every expense, but an
  // expense silently vanishing from its own export would be far worse than an
  // out-of-order row.
  if (out.length !== rows.length) {
    for (const expense of rows) {
      if (!out.includes(expense)) out.push(expense);
    }
  }
  return out;
}

export async function buildExpensesXlsx(sheet: BalanceSheet): Promise<Buffer> {
  const expenses = groupedByPartner(sheet);
  const partners = byPartner(sheet);
  const count = expenses.length;

  const firstRow = DATA_START_ROW;
  const lastRow = lastDataRow(count);
  const totalRowNumber = totalRow(count);
  const total = expenses.reduce((s, e) => s + e.amount, 0);

  // The per-partner block, two rows clear of the total.
  const partnerHeaderRow = totalRowNumber + 2;
  const partnerFirstRow = partnerHeaderRow + 1;
  const partnerLastRow = partnerFirstRow + Math.max(partners.length, 1) - 1;
  const partnerTotalRow = partnerLastRow + 1;

  const amountRange = `$D$${firstRow}:$D$${lastRow}`;
  const partnerRange = `$B$${firstRow}:$B$${lastRow}`;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "BaleBook";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const ws = workbook.addWorksheet("Expenses", {
    views: [{ state: "frozen", ySplit: 2 }],
  });
  ws.columns = [
    { width: 40 },
    { width: 22 },
    { width: 20 },
    { width: 18 },
  ];

  titleRow(ws, "A1:C1", "Expenses");
  // When this file was made, in the corner of the sheet. Two exports of the same
  // expenses look identical otherwise, and an old download is easy to open by
  // mistake. Kept on row 1 so no data row shifts.
  const stamp = ws.getCell("D1");
  stamp.value = `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  stamp.font = { italic: true, size: 8, color: { argb: "FF9CA3AF" } };
  stamp.alignment = { horizontal: "right", vertical: "middle" };

  headerRow(ws, 2, ["Expense", "Partner", "Container", "Amount"], 3);

  expenses.forEach((expense, i) => {
    const row = ws.getRow(firstRow + i);
    row.getCell(1).value = expense.name;
    row.getCell(2).value = expense.partner.trim() || UNASSIGNED_PARTNER;
    // Labelled rather than left blank, so that editing this sheet and reading it
    // back cannot turn "no container" into "the container went missing".
    row.getCell(3).value = expense.containerId || GENERAL_LABEL;
    const amount = row.getCell(4);
    amount.value = expense.amount;
    amount.numFmt = MONEY_FMT;
    amount.alignment = { horizontal: "right" };
  });

  const totals = ws.getRow(totalRowNumber);
  totals.getCell(1).value = "Total";
  const totalCell = totals.getCell(4);
  totalCell.value = formula(`SUM(D${firstRow}:D${lastRow})`, total);
  totalCell.numFmt = MONEY_FMT;
  totalCell.alignment = { horizontal: "right" };
  emphasise(totals, 4);

  /* --------------------------- per partner block --------------------------- */

  headerRow(ws, partnerHeaderRow, ["Partner", "Total", "Entries"], 1);

  partners.forEach((entry, i) => {
    const r = partnerFirstRow + i;
    const row = ws.getRow(r);
    row.getCell(1).value = entry.partner;

    const spend = row.getCell(2);
    spend.value = formula(
      `SUMIF(${partnerRange},$A${r},${amountRange})`,
      entry.expenses,
    );
    spend.numFmt = MONEY_FMT;
    spend.alignment = { horizontal: "right" };

    const entries = row.getCell(3);
    entries.value = formula(`COUNTIF(${partnerRange},$A${r})`, entry.count);
    entries.numFmt = "0";
    entries.alignment = { horizontal: "right" };
  });

  const partnerTotals = ws.getRow(partnerTotalRow);
  partnerTotals.getCell(1).value = "Total";
  const partnerSpend = partnerTotals.getCell(2);
  partnerSpend.value = formula(
    `SUM(B${partnerFirstRow}:B${partnerLastRow})`,
    total,
  );
  partnerSpend.numFmt = MONEY_FMT;
  partnerSpend.alignment = { horizontal: "right" };
  const partnerCount = partnerTotals.getCell(3);
  partnerCount.value = formula(
    `SUM(C${partnerFirstRow}:C${partnerLastRow})`,
    count,
  );
  partnerCount.numFmt = "0";
  partnerCount.alignment = { horizontal: "right" };
  emphasise(partnerTotals, 3);

  noteAt(
    ws,
    partnerTotalRow + 2,
    `A${partnerTotalRow + 2}:D${partnerTotalRow + 2}`,
    'Expenses only - no turnover, profit or margin. Amounts are typed in the Amount column; the Total and the per-partner figures below it are formulas over those rows, so editing an amount updates them. Add rows above the Total and this sheet can be uploaded back into the Balance Sheet page. Leave the container as "(general)" for an expense that belongs to no single container.',
  );

  if (count > 0) {
    // The entries only. Including the Total row would let it be filtered away.
    ws.autoFilter = {
      from: { row: 2, column: 1 },
      to: { row: lastRow, column: 4 },
    };
  }
  ws.pageSetup.printTitlesRow = "1:2";

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

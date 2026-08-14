import ExcelJS from "exceljs";
import {
  balanceTotals,
  byContainer,
  byPartner,
  type BalanceSheet,
} from "./balanceSheet";
import {
  chronological,
  DATA_START_ROW,
  DATE_FMT,
  emphasise,
  formula,
  headerRow,
  lastDataRow,
  MONEY_FMT,
  noteAt,
  PERCENT_FMT,
  titleRow,
  totalRow,
  UNASSIGNED_PARTNER,
  type Formula,
} from "./xlsxKit";

/**
 * The spreadsheet version of the balance sheet: five tabs, and every figure on
 * them is a live formula.
 *
 *   Summary             the headline figures, each one pointing at another tab
 *   Profit by Container turnover, cost and profit per container
 *   Expenses            one row per expense - the only place amounts are typed
 *   Turnover            one row per turnover entry
 *   By Partner          what each partner has spent, and their share
 *
 * Only the Expenses and Turnover tabs hold typed numbers. Everything else is
 * SUMIF, COUNTIF and arithmetic over those two tabs, so editing an amount in the
 * spreadsheet re-derives the summary, both profit scopes and the partner
 * breakdown. A total can never sit there disagreeing with the rows above it.
 *
 * The two profit scopes are kept apart in the workbook exactly as they are in
 * the app: a container's profit uses only the expenses tagged to that container,
 * while the Total (net) row also carries general overhead, which is why the
 * overhead gets a labelled row of its own rather than being spread around.
 */

/** Sheet names, quoted in formulas because two of them contain spaces. */
const S_SUMMARY = "Summary";
const S_CONTAINER = "Profit by Container";
const S_EXPENSES = "Expenses";
const S_TURNOVER = "Turnover";
const S_PARTNER = "By Partner";

/**
 * The label written in the Container column for an expense that belongs to no
 * container. It is a real value rather than a blank cell so that the SUMIF
 * picking out general overhead has something dependable to match on, and so a
 * reader is never left wondering whether the cell was missed.
 */
export const GENERAL_LABEL = "(general)";
/** The label on the general overhead row of the Profit by Container tab. */
export const GENERAL_ROW_LABEL = "(general, not per container)";

/** An absolute range over one column of a data block, e.g. `'Expenses'!$E$3:$E$9`. */
function colRange(sheet: string, col: string, count: number): string {
  return `'${sheet}'!$${col}$${DATA_START_ROW}:$${col}$${lastDataRow(count)}`;
}

/** A margin as the fraction a percent-formatted cell expects, e.g. 72 -> 0.72. */
function marginFraction(margin: number | null): number | "" {
  return margin === null ? "" : margin / 100;
}

export async function buildBalanceXlsx(sheet: BalanceSheet): Promise<Buffer> {
  const totals = balanceTotals(sheet);
  const containers = byContainer(sheet);
  const partners = byPartner(sheet);

  const expenses = chronological(sheet.expenses);
  const turnover = chronological(sheet.turnover);
  const exCount = expenses.length;
  const tvCount = turnover.length;

  // Where every total lands. Worked out up front because the formulas on one
  // tab have to point at exact cells on another.
  const exTotal = totalRow(exCount);
  const tvTotal = totalRow(tvCount);
  const cLast = lastDataRow(containers.length);
  const cGeneral = cLast + 1; // general overhead sits below the containers
  const cTotal = cGeneral + 1; // and the net total below that
  const pLast = lastDataRow(partners.length);
  const pTotal = totalRow(partners.length);

  // Ranges on the two tabs that hold typed numbers.
  const exPartnerCol = colRange(S_EXPENSES, "C", exCount);
  const exContainerCol = colRange(S_EXPENSES, "D", exCount);
  const exAmountCol = colRange(S_EXPENSES, "E", exCount);
  const tvContainerCol = colRange(S_TURNOVER, "B", tvCount);
  const tvAmountCol = colRange(S_TURNOVER, "C", tvCount);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "BaleBook";
  workbook.created = new Date();
  // Recalculate on open, so the formulas are authoritative and the cached
  // results written below are only there for viewers that never recalculate.
  workbook.calcProperties.fullCalcOnLoad = true;

  /* ================================ Summary =============================== */

  const sum = workbook.addWorksheet(S_SUMMARY);
  sum.columns = [{ width: 38 }, { width: 20 }];
  titleRow(sum, "A1:B1", "Balance Sheet");
  const stamp = sum.getCell("A2");
  stamp.value = `Generated ${new Date().toISOString().slice(0, 10)}`;
  stamp.font = { italic: true, size: 9, color: { argb: "FF6B7280" } };

  headerRow(sum, 4, ["Figure", "Amount"]);

  const figures: Array<[string, Formula, string]> = [
    [
      "Total turnover",
      formula(`'${S_TURNOVER}'!C${tvTotal}`, totals.turnover),
      MONEY_FMT,
    ],
    [
      "Total expenses",
      formula(`'${S_EXPENSES}'!E${exTotal}`, totals.expenses),
      MONEY_FMT,
    ],
    [
      "   of which tied to a container",
      formula("B6-B8", totals.attributedExpenses),
      MONEY_FMT,
    ],
    [
      "   of which general overhead",
      formula(
        `SUMIF(${exContainerCol},"${GENERAL_LABEL}",${exAmountCol})`,
        totals.generalExpenses,
      ),
      MONEY_FMT,
    ],
    ["Net profit", formula("B5-B6", totals.netProfit), MONEY_FMT],
    [
      "Margin",
      formula('IF(B5=0,"",B9/B5)', marginFraction(totals.margin)),
      PERCENT_FMT,
    ],
  ];
  figures.forEach(([label, value, fmt], i) => {
    const row = sum.getRow(5 + i);
    row.getCell(1).value = label;
    const cell = row.getCell(2);
    cell.value = value;
    cell.numFmt = fmt;
    cell.alignment = { horizontal: "right" };
  });
  // Net profit and margin are the two figures being looked for, so they carry
  // the same emphasis as a total row.
  emphasise(sum.getRow(9), 2);
  sum.getRow(10).font = { bold: true };

  headerRow(sum, 12, ["Counted", "Number"]);
  const counts: Array<[string, Formula]> = [
    [
      "Containers",
      formula(
        `COUNTA('${S_CONTAINER}'!$A$${DATA_START_ROW}:$A$${cLast})`,
        containers.length,
      ),
    ],
    [
      "Partners",
      formula(
        `COUNTA('${S_PARTNER}'!$A$${DATA_START_ROW}:$A$${pLast})`,
        partners.length,
      ),
    ],
    ["Expense entries", formula(`COUNTA(${colRange(S_EXPENSES, "B", exCount)})`, exCount)],
    ["Turnover entries", formula(`COUNTA(${tvContainerCol})`, tvCount)],
  ];
  counts.forEach(([label, value], i) => {
    const row = sum.getRow(13 + i);
    row.getCell(1).value = label;
    const cell = row.getCell(2);
    cell.value = value;
    cell.numFmt = "0";
    cell.alignment = { horizontal: "right" };
  });

  noteAt(
    sum,
    18,
    "A18:B18",
    "Net profit counts every expense, general overhead included. A single container's profit counts only the expenses tagged to that container, because splitting overhead between containers would be a guess.",
  );
  noteAt(
    sum,
    20,
    "A20:B20",
    "Amounts are typed on the Expenses and Turnover tabs only. Every other figure in this workbook is a formula over those two tabs, so edit an amount there and the whole workbook follows.",
  );

  /* ========================= Profit by Container ========================== */

  const con = workbook.addWorksheet(S_CONTAINER, {
    views: [{ state: "frozen", ySplit: 2 }],
  });
  con.columns = [
    { width: 24 },
    { width: 18 },
    { width: 18 },
    { width: 18 },
    { width: 12 },
  ];
  titleRow(con, "A1:E1", "Profit by Container");
  headerRow(con, 2, ["Container", "Turnover", "Expenses", "Profit", "Margin"]);

  containers.forEach((entry, i) => {
    const r = DATA_START_ROW + i;
    const row = con.getRow(r);
    row.getCell(1).value = entry.containerId;

    const turnover = row.getCell(2);
    turnover.value = formula(
      `SUMIF(${tvContainerCol},$A${r},${tvAmountCol})`,
      entry.turnover,
    );
    const expenses = row.getCell(3);
    expenses.value = formula(
      `SUMIF(${exContainerCol},$A${r},${exAmountCol})`,
      entry.expenses,
    );
    const profit = row.getCell(4);
    profit.value = formula(`B${r}-C${r}`, entry.profit);
    const margin = row.getCell(5);
    margin.value = formula(
      `IF(B${r}=0,"",D${r}/B${r})`,
      marginFraction(entry.margin),
    );

    for (const cell of [turnover, expenses, profit]) {
      cell.numFmt = MONEY_FMT;
      cell.alignment = { horizontal: "right" };
    }
    margin.numFmt = PERCENT_FMT;
    margin.alignment = { horizontal: "right" };
  });

  // General overhead: a row of its own, inside the net total but outside every
  // container, so it is never quietly attributed to one of them.
  const generalRow = con.getRow(cGeneral);
  generalRow.getCell(1).value = GENERAL_ROW_LABEL;
  const generalExpense = generalRow.getCell(3);
  generalExpense.value = formula(
    `SUMIF(${exContainerCol},"${GENERAL_LABEL}",${exAmountCol})`,
    totals.generalExpenses,
  );
  const generalProfit = generalRow.getCell(4);
  generalProfit.value = formula(`-C${cGeneral}`, -totals.generalExpenses);
  for (const cell of [generalExpense, generalProfit]) {
    cell.numFmt = MONEY_FMT;
    cell.alignment = { horizontal: "right" };
  }
  generalRow.font = { italic: true };

  const conTotal = con.getRow(cTotal);
  conTotal.getCell(1).value = "Total (net)";
  const conTurnoverTotal = conTotal.getCell(2);
  conTurnoverTotal.value = formula(
    `SUM(B${DATA_START_ROW}:B${cGeneral})`,
    totals.turnover,
  );
  const conExpenseTotal = conTotal.getCell(3);
  conExpenseTotal.value = formula(
    `SUM(C${DATA_START_ROW}:C${cGeneral})`,
    totals.expenses,
  );
  const conProfitTotal = conTotal.getCell(4);
  conProfitTotal.value = formula(`B${cTotal}-C${cTotal}`, totals.netProfit);
  const conMarginTotal = conTotal.getCell(5);
  conMarginTotal.value = formula(
    `IF(B${cTotal}=0,"",D${cTotal}/B${cTotal})`,
    marginFraction(totals.margin),
  );
  for (const cell of [conTurnoverTotal, conExpenseTotal, conProfitTotal]) {
    cell.numFmt = MONEY_FMT;
    cell.alignment = { horizontal: "right" };
  }
  conMarginTotal.numFmt = PERCENT_FMT;
  conMarginTotal.alignment = { horizontal: "right" };
  emphasise(conTotal, 5);

  noteAt(
    con,
    cTotal + 2,
    `A${cTotal + 2}:E${cTotal + 2}`,
    `Each container row counts only the expenses tagged to it on the Expenses tab. General overhead is on its own row above and is included in Total (net), which is why the container rows do not add up to the net profit on their own. A container with cost but no turnover yet shows its loss so far, and no margin.`,
  );
  con.pageSetup.printTitlesRow = "1:2";

  /* =============================== Expenses =============================== */

  const ex = workbook.addWorksheet(S_EXPENSES, {
    views: [{ state: "frozen", ySplit: 2 }],
  });
  ex.columns = [
    { width: 12 },
    { width: 34 },
    { width: 20 },
    { width: 20 },
    { width: 16 },
    { width: 30 },
  ];
  titleRow(ex, "A1:F1", "Expenses");
  headerRow(ex, 2, ["Date", "Expense", "Partner", "Container", "Amount", "Note"], 4);

  expenses.forEach((expense, i) => {
    const row = ex.getRow(DATA_START_ROW + i);
    const date = row.getCell(1);
    date.value = new Date(expense.at);
    date.numFmt = DATE_FMT;
    row.getCell(2).value = expense.name;
    // Both of these fall back exactly as byPartner and byContainer do, so the
    // SUMIF and COUNTIF on the other tabs always find a match.
    row.getCell(3).value = expense.partner.trim() || UNASSIGNED_PARTNER;
    row.getCell(4).value = expense.containerId || GENERAL_LABEL;
    const amount = row.getCell(5);
    amount.value = expense.amount;
    amount.numFmt = MONEY_FMT;
    amount.alignment = { horizontal: "right" };
    row.getCell(6).value = expense.note;
  });

  const exTotalRow = ex.getRow(exTotal);
  exTotalRow.getCell(1).value = "Total";
  const exAmountTotal = exTotalRow.getCell(5);
  exAmountTotal.value = formula(
    `SUM(E${DATA_START_ROW}:E${lastDataRow(exCount)})`,
    totals.expenses,
  );
  exAmountTotal.numFmt = MONEY_FMT;
  exAmountTotal.alignment = { horizontal: "right" };
  emphasise(exTotalRow, 6);

  if (exCount > 0) {
    // Filter the entries only. Including the Total row would let it be hidden.
    ex.autoFilter = {
      from: { row: 2, column: 1 },
      to: { row: lastDataRow(exCount), column: 6 },
    };
  }
  ex.pageSetup.printTitlesRow = "1:2";

  /* =============================== Turnover =============================== */

  const tv = workbook.addWorksheet(S_TURNOVER, {
    views: [{ state: "frozen", ySplit: 2 }],
  });
  tv.columns = [{ width: 12 }, { width: 24 }, { width: 18 }, { width: 34 }];
  titleRow(tv, "A1:D1", "Turnover");
  headerRow(tv, 2, ["Date", "Container", "Turnover", "Note"], 2);

  turnover.forEach((entry, i) => {
    const row = tv.getRow(DATA_START_ROW + i);
    const date = row.getCell(1);
    date.value = new Date(entry.at);
    date.numFmt = DATE_FMT;
    row.getCell(2).value = entry.containerId;
    const amount = row.getCell(3);
    amount.value = entry.turnover;
    amount.numFmt = MONEY_FMT;
    amount.alignment = { horizontal: "right" };
    row.getCell(4).value = entry.note;
  });

  const tvTotalRow = tv.getRow(tvTotal);
  tvTotalRow.getCell(1).value = "Total";
  const tvAmountTotal = tvTotalRow.getCell(3);
  tvAmountTotal.value = formula(
    `SUM(C${DATA_START_ROW}:C${lastDataRow(tvCount)})`,
    totals.turnover,
  );
  tvAmountTotal.numFmt = MONEY_FMT;
  tvAmountTotal.alignment = { horizontal: "right" };
  emphasise(tvTotalRow, 4);

  if (tvCount > 0) {
    tv.autoFilter = {
      from: { row: 2, column: 1 },
      to: { row: lastDataRow(tvCount), column: 4 },
    };
  }
  tv.pageSetup.printTitlesRow = "1:2";

  /* ============================== By Partner ============================== */

  const pa = workbook.addWorksheet(S_PARTNER, {
    views: [{ state: "frozen", ySplit: 2 }],
  });
  pa.columns = [{ width: 26 }, { width: 18 }, { width: 12 }, { width: 16 }];
  titleRow(pa, "A1:D1", "Expenses by Partner");
  headerRow(pa, 2, ["Partner", "Expenses", "Entries", "Share of spend"]);

  partners.forEach((entry, i) => {
    const r = DATA_START_ROW + i;
    const row = pa.getRow(r);
    row.getCell(1).value = entry.partner;

    const spend = row.getCell(2);
    spend.value = formula(
      `SUMIF(${exPartnerCol},$A${r},${exAmountCol})`,
      entry.expenses,
    );
    spend.numFmt = MONEY_FMT;
    spend.alignment = { horizontal: "right" };

    const entries = row.getCell(3);
    entries.value = formula(`COUNTIF(${exPartnerCol},$A${r})`, entry.count);
    entries.numFmt = "0";
    entries.alignment = { horizontal: "right" };

    const share = row.getCell(4);
    share.value = formula(
      `IF($B$${pTotal}=0,"",B${r}/$B$${pTotal})`,
      entry.share === null ? "" : entry.share / 100,
    );
    share.numFmt = PERCENT_FMT;
    share.alignment = { horizontal: "right" };
  });

  const paTotal = pa.getRow(pTotal);
  paTotal.getCell(1).value = "Total";
  const paSpend = paTotal.getCell(2);
  paSpend.value = formula(
    `SUM(B${DATA_START_ROW}:B${pLast})`,
    totals.expenses,
  );
  paSpend.numFmt = MONEY_FMT;
  paSpend.alignment = { horizontal: "right" };
  const paEntries = paTotal.getCell(3);
  paEntries.value = formula(`SUM(C${DATA_START_ROW}:C${pLast})`, exCount);
  paEntries.numFmt = "0";
  paEntries.alignment = { horizontal: "right" };
  const paShare = paTotal.getCell(4);
  paShare.value = formula(
    `IF($B$${pTotal}=0,"",SUM(D${DATA_START_ROW}:D${pLast}))`,
    partners.length > 0 ? 1 : "",
  );
  paShare.numFmt = PERCENT_FMT;
  paShare.alignment = { horizontal: "right" };
  emphasise(paTotal, 4);

  noteAt(
    pa,
    pTotal + 2,
    `A${pTotal + 2}:D${pTotal + 2}`,
    "Every expense belongs to a partner, so these rows account for all spending, general overhead included. The share is of total expenses, not of turnover.",
  );
  pa.pageSetup.printTitlesRow = "1:2";

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

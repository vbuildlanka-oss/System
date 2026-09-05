import ExcelJS from "exceljs";
import {
  DATA_START_ROW,
  emphasise,
  formula,
  headerRow,
  INK,
  lastDataRow,
  MONEY_FMT,
  noteAt,
  PERCENT_FMT,
  RULE,
  titleRow,
  totalRow,
} from "./xlsxKit";
import {
  fieldTotal,
  monthLabel,
  monthTotals,
  rowFigures,
  type PayrollDoc,
  type PayrollField,
  type PayrollMonth,
} from "./payroll";

/**
 * The payroll workbook.
 *
 * Two things shape it. First, every derived figure is a formula, so the sheet
 * stays a working document: change somebody's gross and the EPF, the deductions,
 * the net and the employer's cost all follow. Only the figures a person actually
 * typed are written as values.
 *
 * Second, the employer's contributions sit in their own block to the right of
 * Net Salary, after the total. EPF at 12% and ETF at 3% are company costs, and
 * ETF may not lawfully be deducted from a wage at all. Putting them beyond the
 * net column means no plausible mis-reading of this sheet subtracts them - the
 * layout itself says which side of the line each figure is on.
 *
 * The rates live on their own sheet and every month refers to them, so a rate
 * that changes is changed once.
 */

const RATES_SHEET = "Rates";

/** 1 -> "A", 27 -> "AA". Twelve added columns can push a sheet past Z. */
function colLetter(index: number): string {
  let n = index;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Where each column of a month sheet sits, given the added fields. */
interface Layout {
  name: number;
  tin: number;
  gross: number;
  allowances: Array<{ field: PayrollField; col: number }>;
  earnings: number;
  epfEmployee: number;
  otherDeductions: number;
  deductions: Array<{ field: PayrollField; col: number }>;
  totalDeductions: number;
  net: number;
  epfEmployer: number;
  etf: number;
  employerCost: number;
  note: number;
  /** Total number of columns. */
  width: number;
  labels: string[];
}

function layoutFor(doc: PayrollDoc): Layout {
  const allowanceFields = doc.fields.filter((f) => f.kind === "allowance");
  const deductionFields = doc.fields.filter((f) => f.kind === "deduction");

  let col = 0;
  const next = () => (col += 1);

  const name = next();
  const tin = next();
  const gross = next();
  const allowances = allowanceFields.map((field) => ({ field, col: next() }));
  const earnings = next();
  const epfEmployee = next();
  const otherDeductions = next();
  const deductions = deductionFields.map((field) => ({ field, col: next() }));
  const totalDeductions = next();
  const net = next();
  const epfEmployer = next();
  const etf = next();
  const employerCost = next();
  const note = next();

  const labels: string[] = [];
  labels[name - 1] = "Name";
  labels[tin - 1] = "TIN";
  labels[gross - 1] = "Gross Salary";
  for (const a of allowances) labels[a.col - 1] = a.field.label;
  labels[earnings - 1] = "Total Earnings";
  labels[epfEmployee - 1] = `EPF ${doc.rates.epfEmployee}% (employee)`;
  labels[otherDeductions - 1] = "Other Deductions";
  for (const d of deductions) labels[d.col - 1] = d.field.label;
  labels[totalDeductions - 1] = "Total Deductions";
  labels[net - 1] = "Net Salary";
  labels[epfEmployer - 1] = `EPF ${doc.rates.epfEmployer}% (employer)`;
  labels[etf - 1] = `ETF ${doc.rates.etf}% (employer)`;
  labels[employerCost - 1] = "Cost to Employer";
  labels[note - 1] = "Note";

  return {
    name,
    tin,
    gross,
    allowances,
    earnings,
    epfEmployee,
    otherDeductions,
    deductions,
    totalDeductions,
    net,
    epfEmployer,
    etf,
    employerCost,
    note,
    width: col,
    labels,
  };
}

function addRatesSheet(workbook: ExcelJS.Workbook, doc: PayrollDoc): void {
  const ws = workbook.addWorksheet(RATES_SHEET);
  ws.columns = [{ width: 34 }, { width: 12 }];

  titleRow(ws, "A1:B1", "Contribution rates");

  const rows: Array<[string, number]> = [
    ["Employee EPF (deducted from pay)", doc.rates.epfEmployee / 100],
    ["Employer EPF (paid by the company)", doc.rates.epfEmployer / 100],
    ["ETF (paid by the company)", doc.rates.etf / 100],
  ];
  rows.forEach(([label, value], i) => {
    const row = ws.getRow(2 + i);
    row.getCell(1).value = label;
    const cell = row.getCell(2);
    cell.value = value;
    cell.numFmt = PERCENT_FMT;
    cell.alignment = { horizontal: "right" };
    cell.font = { bold: true };
  });

  noteAt(
    ws,
    6,
    "A6:B6",
    "Every month sheet reads these three cells, so changing a rate here changes " +
      "every payroll in this workbook. Only the employee's EPF is taken off a " +
      "wage. The employer's EPF and the ETF are the company's own cost, and ETF " +
      "may not be deducted from anybody's pay.",
  );
}

/** `Rates!$B$2` etc., for the three rate cells. */
const RATE_CELL = {
  epfEmployee: `${RATES_SHEET}!$B$2`,
  epfEmployer: `${RATES_SHEET}!$B$3`,
  etf: `${RATES_SHEET}!$B$4`,
} as const;

/**
 * One month of wages.
 *
 * Returns the row number of the Total row, which the year summary points at.
 */
function addMonthSheet(
  workbook: ExcelJS.Workbook,
  doc: PayrollDoc,
  month: PayrollMonth,
): number {
  const layout = layoutFor(doc);
  const ws = workbook.addWorksheet(monthLabel(month.month), {
    views: [{ state: "frozen", xSplit: 1, ySplit: 2 }],
  });

  ws.columns = Array.from({ length: layout.width }, (_, i) => {
    const col = i + 1;
    if (col === layout.name) return { width: 26 };
    if (col === layout.tin) return { width: 16 };
    if (col === layout.note) return { width: 30 };
    return { width: 18 };
  });

  const last = colLetter(layout.width);
  // The title stops one column short so the stamp beside it is not inside the
  // merged range, where it would be swallowed.
  titleRow(
    ws,
    `A1:${colLetter(layout.width - 1)}1`,
    `${doc.employer ? `${doc.employer} - ` : ""}Payroll ${monthLabel(month.month)}`,
  );
  const stamp = ws.getCell(`${last}1`);
  stamp.value =
    month.paidOn !== ""
      ? `Paid ${month.paidOn}`
      : `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  stamp.font = { italic: true, size: 8, color: { argb: "FF9CA3AF" } };
  stamp.alignment = { horizontal: "right", vertical: "middle" };

  headerRow(ws, 2, layout.labels, layout.tin);

  const count = month.rows.length;
  const first = DATA_START_ROW;
  const lastRow = lastDataRow(count);

  month.rows.forEach((entry, i) => {
    const rowNumber = first + i;
    const row = ws.getRow(rowNumber);
    const figures = rowFigures(entry, doc.fields, doc.rates);

    row.getCell(layout.name).value = entry.name;
    row.getCell(layout.tin).value = entry.tin;

    const setMoney = (col: number, value: number | ReturnType<typeof formula>) => {
      const cell = row.getCell(col);
      cell.value = value;
      cell.numFmt = MONEY_FMT;
      cell.alignment = { horizontal: "right" };
      return cell;
    };

    setMoney(layout.gross, entry.gross);
    for (const a of layout.allowances) {
      setMoney(a.col, entry.extras[a.field.id] ?? 0);
    }

    // Total earnings: gross plus every allowance column.
    const grossRef = `${colLetter(layout.gross)}${rowNumber}`;
    const allowanceRefs = layout.allowances.map(
      (a) => `${colLetter(a.col)}${rowNumber}`,
    );
    setMoney(
      layout.earnings,
      formula(
        [grossRef, ...allowanceRefs].join("+"),
        figures.earnings,
      ),
    );

    // A contribution is a formula unless somebody typed over it, in which case
    // the typed figure is the fact and a formula would overwrite it on open.
    const contribution = (
      col: number,
      overridden: boolean,
      rateCell: string,
      value: number,
    ) => {
      const cell = setMoney(
        col,
        overridden
          ? value
          : formula(`ROUND(${grossRef}*${rateCell},2)`, value),
      );
      if (overridden) {
        cell.font = { italic: true };
        cell.note = "Typed in for this month rather than worked out from the rate.";
      }
    };

    contribution(
      layout.epfEmployee,
      figures.overridden.epfEmployee,
      RATE_CELL.epfEmployee,
      figures.epfEmployee,
    );

    setMoney(layout.otherDeductions, entry.otherDeductions);
    for (const d of layout.deductions) {
      setMoney(d.col, entry.extras[d.field.id] ?? 0);
    }

    const deductionRefs = [
      `${colLetter(layout.epfEmployee)}${rowNumber}`,
      `${colLetter(layout.otherDeductions)}${rowNumber}`,
      ...layout.deductions.map((d) => `${colLetter(d.col)}${rowNumber}`),
    ];
    setMoney(
      layout.totalDeductions,
      formula(deductionRefs.join("+"), figures.totalDeductions),
    );

    const netCell = setMoney(
      layout.net,
      formula(
        `${colLetter(layout.earnings)}${rowNumber}-${colLetter(layout.totalDeductions)}${rowNumber}`,
        figures.net,
      ),
    );
    netCell.font = { bold: true };
    if (figures.overDeducted) {
      netCell.font = { bold: true, color: { argb: "FFB91C1C" } };
    }

    contribution(
      layout.epfEmployer,
      figures.overridden.epfEmployer,
      RATE_CELL.epfEmployer,
      figures.epfEmployer,
    );
    contribution(layout.etf, figures.overridden.etf, RATE_CELL.etf, figures.etf);

    setMoney(
      layout.employerCost,
      formula(
        `${colLetter(layout.earnings)}${rowNumber}+${colLetter(layout.epfEmployer)}${rowNumber}+${colLetter(layout.etf)}${rowNumber}`,
        figures.employerCost,
      ),
    );

    row.getCell(layout.note).value = entry.note;
    row.getCell(layout.note).alignment = { wrapText: true, vertical: "top" };
  });

  // Total row. Every money column is summed; the two text columns are not.
  const totals = monthTotals(month, doc.fields, doc.rates);
  const totalRowNumber = totalRow(count);
  const tRow = ws.getRow(totalRowNumber);
  tRow.getCell(layout.name).value = `Total - ${totals.people} ${
    totals.people === 1 ? "person" : "people"
  }`;

  const sumCell = (col: number, value: number) => {
    const letter = colLetter(col);
    const cell = tRow.getCell(col);
    cell.value = formula(`SUM(${letter}${first}:${letter}${lastRow})`, value);
    cell.numFmt = MONEY_FMT;
    cell.alignment = { horizontal: "right" };
  };

  sumCell(layout.gross, totals.gross);
  for (const a of layout.allowances) {
    sumCell(a.col, fieldTotal(month, a.field.id));
  }
  sumCell(layout.earnings, totals.earnings);
  sumCell(layout.epfEmployee, totals.epfEmployee);
  sumCell(layout.otherDeductions, totals.otherDeductions);
  for (const d of layout.deductions) {
    sumCell(d.col, fieldTotal(month, d.field.id));
  }
  sumCell(layout.totalDeductions, totals.totalDeductions);
  sumCell(layout.net, totals.net);
  sumCell(layout.epfEmployer, totals.epfEmployer);
  sumCell(layout.etf, totals.etf);
  sumCell(layout.employerCost, totals.employerCost);
  emphasise(tRow, layout.width);

  // What has to be paid where, worked out from the total row rather than
  // restated, so it cannot disagree with the sheet above it.
  const netLetter = colLetter(layout.net);
  const epfEeLetter = colLetter(layout.epfEmployee);
  const epfErLetter = colLetter(layout.epfEmployer);
  const etfLetter = colLetter(layout.etf);

  const payments: Array<[string, string, number]> = [
    [
      "Wages to staff",
      `${netLetter}${totalRowNumber}`,
      totals.net,
    ],
    [
      "EPF to remit (employee + employer)",
      `${epfEeLetter}${totalRowNumber}+${epfErLetter}${totalRowNumber}`,
      totals.epfRemittance,
    ],
    ["ETF to remit", `${etfLetter}${totalRowNumber}`, totals.etf],
  ];

  const payStart = totalRowNumber + 2;
  const heading = ws.getCell(`A${payStart}`);
  heading.value = "To pay";
  heading.font = { bold: true, color: { argb: INK } };

  payments.forEach(([label, ref, value], i) => {
    const row = ws.getRow(payStart + 1 + i);
    row.getCell(1).value = label;
    const cell = row.getCell(2);
    cell.value = formula(ref, value);
    cell.numFmt = MONEY_FMT;
    cell.alignment = { horizontal: "right" };
    cell.font = { bold: true };
    cell.border = { top: { style: "hair", color: { argb: RULE } } };
  });

  const noteRow = payStart + payments.length + 2;
  noteAt(
    ws,
    noteRow,
    `A${noteRow}:${last}${noteRow}`,
    "Every figure except the ones somebody typed is a formula, so this sheet " +
      "recalculates if a salary is edited. Net Salary is Total Earnings less " +
      "Total Deductions. The employer's EPF and the ETF are to the right of Net " +
      "Salary because they are the company's cost and are not deducted from " +
      "anybody's wage - ETF lawfully cannot be. A contribution shown in italics " +
      "was typed in for this month instead of being worked out from the rate." +
      (month.note ? `  Note: ${month.note}` : ""),
  );

  if (count > 0) {
    ws.autoFilter = {
      from: { row: 2, column: 1 },
      to: { row: lastRow, column: layout.width },
    };
  }
  ws.pageSetup.printTitlesRow = "1:2";
  ws.pageSetup.orientation = "landscape";
  ws.pageSetup.fitToPage = true;
  ws.pageSetup.fitToWidth = 1;
  ws.pageSetup.fitToHeight = 0;

  return totalRowNumber;
}

/** One month, as its own workbook. */
export async function buildPayrollXlsx(
  doc: PayrollDoc,
  monthId: string,
): Promise<Buffer> {
  const month = doc.months.find((m) => m.id === monthId);
  if (!month) throw new Error("That month is not on the payroll.");

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "BaleBook";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  // Wages first, rates behind them: the payroll is what you opened the file for.
  // A formula may refer to a sheet added later, so the order is free.
  addMonthSheet(workbook, doc, month);
  addRatesSheet(workbook, doc);

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

/**
 * A year of wages: every month as its own sheet, plus a summary that adds them
 * up by pointing at each month's total row.
 *
 * This is the sheet the annual EPF and ETF returns are filled in from, which is
 * why the summary is references rather than copied numbers - a month corrected
 * in March shows up in the year total without anybody remembering to redo it.
 */
export async function buildPayrollYearXlsx(
  doc: PayrollDoc,
  year: string,
): Promise<Buffer> {
  const months = doc.months
    .filter((m) => m.month.startsWith(`${year}-`))
    .sort((a, b) => a.month.localeCompare(b.month));
  if (months.length === 0) {
    throw new Error(`There is no payroll for ${year}.`);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "BaleBook";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  // Created first so it is the tab that opens, then written once the month
  // sheets exist and their total rows are known.
  const summary = workbook.addWorksheet(`Year ${year}`, {
    views: [{ state: "frozen", ySplit: 2 }],
  });

  // The month sheets first, so their total rows are known.
  const placed = months.map((month) => ({
    month,
    totalRowNumber: addMonthSheet(workbook, doc, month),
  }));

  const layout = layoutFor(doc);
  const columns: Array<{ label: string; col: number; pick: (t: ReturnType<typeof monthTotals>) => number }> = [
    { label: "Gross Salary", col: layout.gross, pick: (t) => t.gross },
    { label: "Total Earnings", col: layout.earnings, pick: (t) => t.earnings },
    {
      label: `EPF ${doc.rates.epfEmployee}% (employee)`,
      col: layout.epfEmployee,
      pick: (t) => t.epfEmployee,
    },
    {
      label: "Total Deductions",
      col: layout.totalDeductions,
      pick: (t) => t.totalDeductions,
    },
    { label: "Net Salary", col: layout.net, pick: (t) => t.net },
    {
      label: `EPF ${doc.rates.epfEmployer}% (employer)`,
      col: layout.epfEmployer,
      pick: (t) => t.epfEmployer,
    },
    { label: `ETF ${doc.rates.etf}% (employer)`, col: layout.etf, pick: (t) => t.etf },
    {
      label: "Cost to Employer",
      col: layout.employerCost,
      pick: (t) => t.employerCost,
    },
  ];

  summary.columns = [
    { width: 18 },
    { width: 10 },
    ...columns.map(() => ({ width: 18 })),
  ];

  const width = 2 + columns.length;
  const lastLetter = colLetter(width);
  titleRow(
    summary,
    `A1:${colLetter(width - 1)}1`,
    `${doc.employer ? `${doc.employer} - ` : ""}Payroll ${year}`,
  );
  const yearStamp = summary.getCell(`${lastLetter}1`);
  yearStamp.value = `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  yearStamp.font = { italic: true, size: 8, color: { argb: "FF9CA3AF" } };
  yearStamp.alignment = { horizontal: "right", vertical: "middle" };
  headerRow(
    summary,
    2,
    ["Month", "People", ...columns.map((c) => c.label)],
    2,
  );

  placed.forEach(({ month, totalRowNumber }, i) => {
    const rowNumber = DATA_START_ROW + i;
    const row = summary.getRow(rowNumber);
    const totals = monthTotals(month, doc.fields, doc.rates);
    // Sheet names carry a space, so they have to be quoted in a reference.
    const sheetRef = `'${monthLabel(month.month)}'`;

    row.getCell(1).value = monthLabel(month.month);
    row.getCell(2).value = totals.people;
    row.getCell(2).alignment = { horizontal: "right" };

    columns.forEach((column, c) => {
      const cell = row.getCell(3 + c);
      cell.value = formula(
        `${sheetRef}!${colLetter(column.col)}${totalRowNumber}`,
        column.pick(totals),
      );
      cell.numFmt = MONEY_FMT;
      cell.alignment = { horizontal: "right" };
    });
  });

  const first = DATA_START_ROW;
  const lastRow = lastDataRow(placed.length);
  const yearTotalRow = totalRow(placed.length);
  const tRow = summary.getRow(yearTotalRow);
  tRow.getCell(1).value = `${year} total`;

  const peopleLetter = colLetter(2);
  tRow.getCell(2).value = formula(
    `MAX(${peopleLetter}${first}:${peopleLetter}${lastRow})`,
    Math.max(...placed.map((p) => p.month.rows.length), 0),
  );
  tRow.getCell(2).alignment = { horizontal: "right" };
  tRow.getCell(2).note =
    "The largest headcount in any one month. Adding the months would count the same person twelve times.";

  columns.forEach((column, c) => {
    const letter = colLetter(3 + c);
    const cell = tRow.getCell(3 + c);
    const total = placed.reduce(
      (sum, p) => sum + column.pick(monthTotals(p.month, doc.fields, doc.rates)),
      0,
    );
    cell.value = formula(
      `SUM(${letter}${first}:${letter}${lastRow})`,
      Math.round(total * 100) / 100,
    );
    cell.numFmt = MONEY_FMT;
    cell.alignment = { horizontal: "right" };
  });
  emphasise(tRow, width);

  const noteRow = yearTotalRow + 2;
  noteAt(
    summary,
    noteRow,
    `A${noteRow}:${lastLetter}${noteRow}`,
    `Each row points at that month's own sheet rather than copying its ` +
      `figures, so correcting a month corrects this summary too. Headcount is ` +
      `the largest month rather than a sum, because the same person appears in ` +
      `every month they were paid.`,
  );

  summary.pageSetup.printTitlesRow = "1:2";
  summary.pageSetup.orientation = "landscape";
  summary.pageSetup.fitToPage = true;

  addRatesSheet(workbook, doc);

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

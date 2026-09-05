/**
 * Payroll: the arithmetic, the privacy of a payslip, and the one rule that
 * matters most.
 *
 * EPF is 8% from the employee and 12% from the employer; ETF is 3% from the
 * employer and may not be deducted from wages at all. So ETF must never touch
 * net pay. Getting that wrong underpays every employee by 3% of gross a month
 * and is unlawful besides, which is why a good third of this file is about it.
 */
import ExcelJS from "exceljs";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import {
  addField,
  addMonth,
  addRow,
  DEFAULT_RATES,
  emptyPayrollDoc,
  fieldTotal,
  findMonth,
  isMonthKey,
  isMonthReady,
  MAX_FIELDS,
  missingNames,
  missingTins,
  money,
  monthKeyOf,
  monthLabel,
  monthsNewestFirst,
  monthTotals,
  overDeductedNames,
  parsePayrollDoc,
  payrollFilename,
  payrollYearFilename,
  payslipFilename,
  payslipsFilename,
  removeField,
  removeMonth,
  removeRow,
  renameField,
  rowFigures,
  setEmployer,
  setMonthNote,
  setPaidOn,
  setRates,
  setRowExtra,
  setRowMoney,
  setRowOverride,
  setRowText,
  type PayrollDoc,
} from "../src/lib/payroll";
import { buildPayrollXlsx, buildPayrollYearXlsx } from "../src/lib/payrollXlsx";
import { renderPayslipPdf, renderPayslipsPdf } from "../src/lib/payrollPdf";
import { POST as payrollPost } from "../src/app/api/payroll-export/route";
import type { NextRequest } from "next/server";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require("pdf-parse/lib/pdf-parse.js");

let failures = 0;
function check(cond: boolean, msg: string) {
  if (cond) console.log("  ok   -", msg);
  else {
    console.error("  FAIL -", msg);
    failures += 1;
  }
}
function section(name: string) {
  console.log(`\n== ${name} ==`);
}

const CONTENT_XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function jsonReq(body: unknown): NextRequest {
  return new Request("http://localhost/api/payroll-export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function rawReq(body: string): NextRequest {
  return new Request("http://localhost/api/payroll-export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }) as unknown as NextRequest;
}

/** A month with three people, an allowance, a deduction and an override. */
function fixture() {
  let doc = emptyPayrollDoc();
  doc = setEmployer(doc, "Vbuild Lanka (Pvt) Ltd");

  const aug = addMonth(doc, "2026-08");
  doc = aug.doc;
  const augId = aug.month!.id;
  doc = setPaidOn(doc, augId, "2026-08-31");
  doc = setMonthNote(doc, augId, "Wages for August.");

  const paye = addField(doc, "PAYE", "deduction");
  doc = paye.doc;
  const transport = addField(doc, "Transport", "allowance");
  doc = transport.doc;

  doc = addRow(doc, augId, { name: "Nimal Perera", tin: "123456789", gross: 100_000 });
  doc = addRow(doc, augId, { name: "Kamala Silva", tin: "987654321", gross: 60_000 });
  doc = addRow(doc, augId, { name: "Sunil Fernando", tin: "", gross: 45_000 });

  const rows = findMonth(doc, augId)!.rows;
  doc = setRowExtra(doc, augId, rows[0].id, paye.field!.id, 5_000);
  doc = setRowExtra(doc, augId, rows[0].id, transport.field!.id, 7_500);
  doc = setRowMoney(doc, augId, rows[0].id, "otherDeductions", 2_000);
  doc = setRowText(doc, augId, rows[0].id, "note", "Advance recovered.");
  // On probation: EPF typed in rather than worked out.
  doc = setRowOverride(doc, augId, rows[2].id, "epfEmployee", 1_000);

  return {
    doc,
    augId,
    payeId: paye.field!.id,
    transportId: transport.field!.id,
    ids: findMonth(doc, augId)!.rows.map((r) => r.id),
  };
}

async function main() {
  mkdirSync(".verify", { recursive: true });

  /* ==================================================================== */
  section("The arithmetic of one wage");
  {
    const { doc, augId } = fixture();
    const month = findMonth(doc, augId)!;
    const nimal = rowFigures(month.rows[0], doc.fields, doc.rates);

    check(nimal.earnings === 107_500, `gross plus the allowance (${nimal.earnings})`);
    check(nimal.allowances === 7_500, `the allowance on its own (${nimal.allowances})`);
    check(nimal.epfBase === 100_000, `EPF is worked out on gross (${nimal.epfBase})`);
    check(nimal.epfEmployee === 8_000, `8% off the employee (${nimal.epfEmployee})`);
    check(nimal.epfEmployer === 12_000, `12% from the employer (${nimal.epfEmployer})`);
    check(nimal.etf === 3_000, `3% ETF from the employer (${nimal.etf})`);
    check(
      nimal.totalDeductions === 15_000,
      `EPF plus other plus PAYE (${nimal.totalDeductions})`,
    );
    check(nimal.net === 92_500, `net is earnings less deductions (${nimal.net})`);
    check(
      nimal.employerCost === 122_500,
      `what the person costs the company (${nimal.employerCost})`,
    );
    check(!nimal.overDeducted, "and the wage is payable");
  }

  /* ==================================================================== */
  section("ETF never comes out of anybody's wage");
  {
    const { doc, augId } = fixture();
    const month = findMonth(doc, augId)!;
    const before = rowFigures(month.rows[0], doc.fields, doc.rates);

    // Net must be reachable without knowing the ETF at all.
    check(
      before.net ===
        money(
          before.earnings -
            before.epfEmployee -
            before.otherDeductions -
            before.customDeductions,
        ),
      "net is earnings less the employee's own deductions, and nothing else",
    );
    check(
      before.net !== money(before.net - before.etf),
      "which is not the same figure as one with ETF taken off",
    );

    // Tripling the ETF rate must not move a single wage.
    const dearer = setRates(doc, { etf: 9 });
    const after = rowFigures(
      findMonth(dearer, augId)!.rows[0],
      dearer.fields,
      dearer.rates,
    );
    check(after.etf === 9_000, `a higher ETF rate is applied (${after.etf})`);
    check(
      after.net === before.net,
      `but the wage is untouched (${after.net} vs ${before.net})`,
    );
    check(
      after.totalDeductions === before.totalDeductions,
      "and the deductions are untouched",
    );
    check(
      after.employerCost === money(before.employerCost + 6_000),
      `only the company's cost goes up (${after.employerCost})`,
    );

    // The employer's EPF is the same: a cost, not a deduction.
    const dearerEpf = setRates(doc, { epfEmployer: 20 });
    const afterEpf = rowFigures(
      findMonth(dearerEpf, augId)!.rows[0],
      dearerEpf.fields,
      dearerEpf.rates,
    );
    check(
      afterEpf.net === before.net,
      "raising the employer's EPF does not touch the wage either",
    );

    // The employee's EPF, by contrast, must move it.
    const dearerOwn = setRates(doc, { epfEmployee: 10 });
    const afterOwn = rowFigures(
      findMonth(dearerOwn, augId)!.rows[0],
      dearerOwn.fields,
      dearerOwn.rates,
    );
    check(
      afterOwn.net === money(before.net - 2_000),
      `while the employee's own EPF does (${afterOwn.net})`,
    );

    const totals = monthTotals(month, doc.fields, doc.rates);
    check(
      totals.net === money(totals.earnings - totals.totalDeductions),
      `the month's total net agrees (${totals.net})`,
    );
    check(
      totals.epfRemittance === money(totals.epfEmployee + totals.epfEmployer),
      `what goes to EPF is both halves (${totals.epfRemittance})`,
    );
  }

  /* ==================================================================== */
  section("A month's totals");
  {
    const { doc, augId, payeId, transportId } = fixture();
    const month = findMonth(doc, augId)!;
    const t = monthTotals(month, doc.fields, doc.rates);

    check(t.people === 3, `three people (${t.people})`);
    check(t.gross === 205_000, `gross (${t.gross})`);
    check(t.earnings === 212_500, `earnings (${t.earnings})`);
    check(t.epfEmployee === 13_800, `employee EPF, one of them typed in (${t.epfEmployee})`);
    check(t.epfEmployer === 24_600, `employer EPF (${t.epfEmployer})`);
    check(t.etf === 6_150, `ETF (${t.etf})`);
    check(t.net === 191_700, `wages to pay (${t.net})`);
    check(t.employerCost === 243_250, `total cost (${t.employerCost})`);
    check(fieldTotal(month, payeId) === 5_000, "an added deduction totals up");
    check(fieldTotal(month, transportId) === 7_500, "and so does an added allowance");
    check(missingTins(month) === 1, `one person has no TIN (${missingTins(month)})`);
    check(missingNames(month) === 0, "everybody is named");
  }

  /* ==================================================================== */
  section("A figure typed in beats the rate");
  {
    const { doc, augId, ids } = fixture();
    const sunil = findMonth(doc, augId)!.rows[2];
    const f = rowFigures(sunil, doc.fields, doc.rates);
    check(f.epfEmployee === 1_000, `the typed EPF is used (${f.epfEmployee})`);
    check(
      f.epfEmployee !== 3_600,
      "rather than 8% of the gross, which would have been 3600",
    );
    check(f.overridden.epfEmployee, "and the row says it was typed in");
    check(!f.overridden.etf, "while the untouched ones do not");
    check(f.net === 44_000, `so the net follows the typed figure (${f.net})`);

    // Clearing it goes back to the rate.
    const cleared = setRowOverride(doc, augId, ids[2], "epfEmployee", "");
    const back = rowFigures(
      findMonth(cleared, augId)!.rows[2],
      cleared.fields,
      cleared.rates,
    );
    check(back.epfEmployee === 3_600, `clearing it returns to the rate (${back.epfEmployee})`);
    check(!back.overridden.epfEmployee, "and it is no longer marked as typed in");
  }

  /* ==================================================================== */
  section("Opening a month carries the people, not the figures");
  {
    const { doc, augId } = fixture();
    const sep = addMonth(doc, "2026-09");
    check(sep.month !== null, `September opens (${sep.problem || "no problem"})`);
    const next = sep.month!;

    check(next.rows.length === 3, `the same three people (${next.rows.length})`);
    check(
      next.rows.map((r) => r.name).join(", ") ===
        "Nimal Perera, Kamala Silva, Sunil Fernando",
      "with their names",
    );
    check(
      next.rows.every((r) => r.gross > 0),
      "and their salaries",
    );
    check(
      next.rows[0].tin === "123456789",
      `and their TINs (${next.rows[0].tin})`,
    );
    check(
      next.rows.every((r) => r.otherDeductions === 0),
      "but last month's deductions do not come with them",
    );
    check(
      next.rows.every((r) => Object.keys(r.extras).length === 0),
      "nor last month's PAYE or allowance",
    );
    check(
      next.rows.every((r) => r.overrides.epfEmployee === null),
      "nor a figure typed in for one particular month",
    );
    check(
      next.rows.every((r) => r.note === ""),
      "nor a note about something that happened in August",
    );
    check(
      next.rows[2].id !== findMonth(doc, augId)!.rows[2].id,
      "and the carried rows are new rows, not shared with August",
    );

    // Editing September must not reach back into August.
    const edited = setRowMoney(sep.doc, next.id, next.rows[0].id, "gross", 120_000);
    check(
      findMonth(edited, augId)!.rows[0].gross === 100_000,
      "changing a September salary leaves August alone",
    );
  }

  /* ==================================================================== */
  section("Which month a new one copies from");
  {
    let doc = emptyPayrollDoc();
    doc = addMonth(doc, "2026-03").doc;
    const march = monthsNewestFirst(doc)[0];
    doc = addRow(doc, march.id, { name: "March Person", gross: 10_000 });
    doc = addMonth(doc, "2026-06").doc;
    const june = doc.months.find((m) => m.month === "2026-06")!;
    doc = addRow(doc, june.id, { name: "June Person", gross: 20_000 });

    // Opening a month that was missed copies from the month before it, not from
    // the latest month overall.
    const april = addMonth(doc, "2026-04");
    check(
      april.month!.rows.map((r) => r.name).join(",") === "March Person",
      `April copies March, not June (${april.month!.rows.map((r) => r.name).join(",")})`,
    );

    // June itself was opened after March, so it already carries March's person.
    // July must copy June's roster exactly, whatever that has grown into.
    const july = addMonth(doc, "2026-07");
    const juneRoster = findMonth(doc, june.id)!.rows.map((r) => r.name).join(",");
    check(
      july.month!.rows.map((r) => r.name).join(",") === juneRoster,
      `July copies June's roster (${july.month!.rows.map((r) => r.name).join(",")} = ${juneRoster})`,
    );
    check(
      juneRoster === "March Person,June Person",
      `and June's roster grew from March's (${juneRoster})`,
    );

    const first = addMonth(emptyPayrollDoc(), "2026-01");
    check(first.month!.rows.length === 0, "the very first month starts empty");
  }

  /* ==================================================================== */
  section("A month has to be a month");
  {
    const { doc } = fixture();
    check(isMonthKey("2026-08"), "a real month is accepted");
    check(!isMonthKey("2026-13"), "a thirteenth month is not");
    check(!isMonthKey("2026-00"), "nor a zeroth");
    check(!isMonthKey("26-08"), "nor a two-digit year");
    check(!isMonthKey("2026-8"), "nor a one-digit month");
    check(!isMonthKey(""), "nor nothing");
    check(!isMonthKey(42), "nor a number");

    check(addMonth(doc, "nonsense").month === null, "nonsense is refused");
    check(
      addMonth(doc, "2026-08").problem.includes("already"),
      `and a month already open is refused (${addMonth(doc, "2026-08").problem})`,
    );
    check(
      addMonth(doc, "2026-08").doc.months.length === doc.months.length,
      "without adding anything",
    );

    check(monthLabel("2026-08") === "August 2026", "a month reads as a month");
    check(monthLabel("2026-01") === "January 2026", "in January too");
    check(monthLabel("2026-12") === "December 2026", "and December");
    check(monthLabel("rubbish") === "Unknown month", "and rubbish says so");
    check(isMonthKey(monthKeyOf()), `today gives a usable month (${monthKeyOf()})`);

    const gone = removeMonth(doc, findMonth(doc, fixture().augId)?.id ?? "nope");
    check(gone.months.length === doc.months.length, "removing a month that is not there changes nothing");
  }

  /* ==================================================================== */
  section("Columns you add yourself");
  {
    let doc = emptyPayrollDoc();
    const aug = addMonth(doc, "2026-08");
    doc = aug.doc;
    const monthId = aug.month!.id;
    doc = addRow(doc, monthId, { name: "One Person", gross: 50_000 });

    const advance = addField(doc, "Salary advance", "deduction");
    doc = advance.doc;
    check(advance.field !== null, "a deduction column is added");
    check(
      addField(doc, "  salary ADVANCE  ", "deduction").field === null,
      "the same name in a different case is refused",
    );
    check(
      addField(doc, "", "allowance").field === null,
      "and a column with no name is refused",
    );

    const rowId = findMonth(doc, monthId)!.rows[0].id;
    doc = setRowExtra(doc, monthId, rowId, advance.field!.id, 4_000);
    let f = rowFigures(findMonth(doc, monthId)!.rows[0], doc.fields, doc.rates);
    check(f.customDeductions === 4_000, `the deduction is counted (${f.customDeductions})`);
    check(f.net === 42_000, `and comes off the wage (${f.net})`);

    // An allowance adds to pay instead.
    const bonus = addField(doc, "Bonus", "allowance");
    doc = bonus.doc;
    doc = setRowExtra(doc, monthId, rowId, bonus.field!.id, 10_000);
    f = rowFigures(findMonth(doc, monthId)!.rows[0], doc.fields, doc.rates);
    check(f.allowances === 10_000, `the allowance is counted (${f.allowances})`);
    check(f.earnings === 60_000, `and adds to earnings (${f.earnings})`);
    check(f.net === 52_000, `and to the wage (${f.net})`);
    check(
      f.epfBase === 50_000,
      `while EPF still follows gross alone (${f.epfBase})`,
    );

    const renamed = renameField(doc, bonus.field!.id, "Annual bonus");
    check(
      renamed.fields.find((x) => x.id === bonus.field!.id)?.label ===
        "Annual bonus",
      "a column can be renamed",
    );
    check(
      renameField(doc, bonus.field!.id, "   ").fields.find(
        (x) => x.id === bonus.field!.id,
      )?.label === "Bonus",
      "but not renamed to nothing",
    );

    // Removing a column takes its figures with it.
    const pruned = removeField(doc, advance.field!.id);
    check(pruned.fields.length === 1, "removing a column drops the column");
    check(
      findMonth(pruned, monthId)!.rows[0].extras[advance.field!.id] === undefined,
      "and the figures that were in it",
    );
    const after = rowFigures(
      findMonth(pruned, monthId)!.rows[0],
      pruned.fields,
      pruned.rates,
    );
    check(after.net === 56_000, `so the wage goes back up (${after.net})`);

    // The ceiling.
    let many = emptyPayrollDoc();
    for (let i = 0; i < MAX_FIELDS; i++) {
      many = addField(many, `Column ${i}`, "deduction").doc;
    }
    check(many.fields.length === MAX_FIELDS, `${MAX_FIELDS} columns fit`);
    const overflow = addField(many, "One too many", "deduction");
    check(overflow.field === null, "and the next one is refused");
    check(overflow.problem.includes(String(MAX_FIELDS)), "saying what the limit is");
  }

  /* ==================================================================== */
  section("Rates");
  {
    const doc = emptyPayrollDoc();
    check(doc.rates.epfEmployee === 8, "the employee's EPF starts at 8%");
    check(doc.rates.epfEmployer === 12, "the employer's at 12%");
    check(doc.rates.etf === 3, "and ETF at 3%");
    check(
      DEFAULT_RATES.epfEmployee === 8 &&
        DEFAULT_RATES.epfEmployer === 12 &&
        DEFAULT_RATES.etf === 3,
      "which are the statutory figures",
    );

    check(setRates(doc, { etf: 150 }).rates.etf === 100, "a rate over 100% is clamped");
    check(setRates(doc, { etf: -5 }).rates.etf === 0, "a negative rate becomes zero");
    check(
      setRates(doc, { etf: "nonsense" as unknown as number }).rates.etf === 0,
      "and nonsense becomes zero rather than NaN",
    );
    check(
      setRates(doc, { epfEmployee: 8.5 }).rates.epfEmployee === 8.5,
      "a half percent is kept",
    );
    check(
      setRates(doc, { etf: 4 }).rates.epfEmployee === 8,
      "changing one rate leaves the others alone",
    );
  }

  /* ==================================================================== */
  section("A wage that cannot be paid");
  {
    let doc = emptyPayrollDoc();
    const aug = addMonth(doc, "2026-08");
    doc = aug.doc;
    const monthId = aug.month!.id;
    doc = addRow(doc, monthId, { name: "Over Deducted", gross: 30_000 });
    const rowId = findMonth(doc, monthId)!.rows[0].id;
    doc = setRowMoney(doc, monthId, rowId, "otherDeductions", 40_000);

    const month = findMonth(doc, monthId)!;
    const f = rowFigures(month.rows[0], doc.fields, doc.rates);
    check(f.net < 0, `the net is negative (${f.net})`);
    check(f.overDeducted, "and the row is flagged");
    check(
      overDeductedNames(month, doc.fields, doc.rates).join(",") === "Over Deducted",
      "and named",
    );
    check(
      !isMonthReady(month, doc.fields, doc.rates),
      "so the month is not ready to pay",
    );

    // A month with nobody in it is not ready either.
    const bare = addMonth(emptyPayrollDoc(), "2026-08");
    check(
      !isMonthReady(bare.month!, [], bare.doc.rates),
      "an empty month is not ready",
    );

    // Nor is one where somebody has no name.
    let unnamed = emptyPayrollDoc();
    const m = addMonth(unnamed, "2026-08");
    unnamed = addRow(m.doc, m.month!.id, { gross: 10_000 });
    const um = findMonth(unnamed, m.month!.id)!;
    check(missingNames(um) === 1, "an unnamed person is counted");
    check(!isMonthReady(um, [], unnamed.rates), "and the month is not ready");
  }

  /* ==================================================================== */
  section("Rebuilding a saved payroll");
  {
    check(parsePayrollDoc(null).months.length === 0, "null gives an empty payroll");
    check(parsePayrollDoc(42).months.length === 0, "so does a number");
    check(parsePayrollDoc("nonsense").fields.length === 0, "and a string");
    check(
      parsePayrollDoc({ months: "not an array" }).months.length === 0,
      "months that are not a list are dropped",
    );
    check(
      parsePayrollDoc({ fields: {} }).fields.length === 0,
      "and so are fields that are not a list",
    );
    check(
      parsePayrollDoc({}).rates.epfEmployee === 8,
      "a payroll with no rates gets the statutory ones",
    );
    check(
      parsePayrollDoc({ rates: { epfEmployee: "x" } }).rates.epfEmployee === 8,
      "an unreadable rate falls back rather than becoming NaN",
    );

    const negatives = parsePayrollDoc({
      months: [
        {
          month: "2026-08",
          rows: [{ name: "X", gross: -5_000, otherDeductions: -100 }],
        },
      ],
    });
    check(
      negatives.months[0].rows[0].gross === 0,
      "a negative salary is refused rather than stored",
    );
    check(
      negatives.months[0].rows[0].otherDeductions === 0,
      "and so is a negative deduction",
    );

    const dupes = parsePayrollDoc({
      months: [
        { month: "2026-08", rows: [{ name: "First", gross: 1 }] },
        { month: "2026-08", rows: [{ name: "Second", gross: 2 }] },
        { month: "not-a-month", rows: [] },
      ],
    });
    check(dupes.months.length === 1, `one month per month (${dupes.months.length})`);
    check(dupes.months[0].rows[0].name === "First", "the first one wins");

    // Values for a column that no longer exists must not survive, or deleting a
    // column and adding another would resurrect the old figures.
    const orphaned = parsePayrollDoc({
      fields: [{ id: "keep", label: "Kept", kind: "deduction" }],
      months: [
        {
          month: "2026-08",
          rows: [{ name: "X", gross: 10_000, extras: { keep: 100, gone: 900 } }],
        },
      ],
    });
    const extras = orphaned.months[0].rows[0].extras;
    check(extras.keep === 100, "a value for a live column is kept");
    check(extras.gone === undefined, "a value for a column that is gone is dropped");

    const oddKind = parsePayrollDoc({
      fields: [{ id: "f", label: "Odd", kind: "something else" }],
    });
    check(
      oddKind.fields[0].kind === "allowance",
      "a column of unknown kind is money paid, not money taken",
    );

    const badDate = parsePayrollDoc({
      months: [{ month: "2026-08", paidOn: "not a date", rows: [] }],
    });
    check(badDate.months[0].paidOn === "", "an unusable paid-on date is cleared");

    // A full round trip.
    const { doc } = fixture();
    const back = parsePayrollDoc(JSON.parse(JSON.stringify(doc)));
    check(back.months.length === doc.months.length, "a saved payroll reloads");
    check(back.employer === doc.employer, "with the employer");
    check(back.fields.length === doc.fields.length, "and its columns");
    const beforeT = monthTotals(doc.months[0], doc.fields, doc.rates);
    const afterT = monthTotals(back.months[0], back.fields, back.rates);
    check(
      afterT.net === beforeT.net && afterT.etf === beforeT.etf,
      `and every figure intact (${afterT.net})`,
    );

    // The shape of a date is not enough - these are all the right shape.
    for (const bad of ["2026-13-99", "2026-02-30", "2026-00-10", "2026-04-31"]) {
      check(
        setPaidOn(doc, doc.months[0].id, bad).months[0].paidOn === "",
        `${bad} is not a day, so it is not stored`,
      );
    }
    check(
      setPaidOn(doc, doc.months[0].id, "2026-02-29").months[0].paidOn === "",
      "and neither is the 29th of February in a year that has no 29th",
    );
    check(
      setPaidOn(doc, doc.months[0].id, "2024-02-29").months[0].paidOn ===
        "2024-02-29",
      "but a real leap day is kept",
    );
  }

  /* ==================================================================== */
  section("Rows come and go");
  {
    const { doc, augId, ids } = fixture();
    const fewer = removeRow(doc, augId, ids[1]);
    check(findMonth(fewer, augId)!.rows.length === 2, "somebody can be taken off");
    check(
      findMonth(fewer, augId)!.rows.every((r) => r.name !== "Kamala Silva"),
      "and it is the right somebody",
    );
    check(
      findMonth(removeRow(doc, augId, "nope"), augId)!.rows.length === 3,
      "removing somebody who is not there changes nothing",
    );
    const more = addRow(doc, augId, { name: "New Starter", gross: 35_000 });
    check(findMonth(more, augId)!.rows.length === 4, "and somebody can be added");
    check(
      addRow(doc, "no-such-month", {}).months.length === doc.months.length,
      "adding to a month that is not there does nothing",
    );
  }

  /* ==================================================================== */
  section("What the files are called");
  {
    check(
      payrollFilename("2026-08", "xlsx", "Vbuild Lanka") ===
        "Vbuild Lanka - Payroll - August 2026.xlsx",
      payrollFilename("2026-08", "xlsx", "Vbuild Lanka"),
    );
    check(
      payrollFilename("2026-08", "xlsx") === "Payroll - August 2026.xlsx",
      "the employer is left out when there is not one",
    );
    check(
      payrollYearFilename("2026", "xlsx", "Vbuild Lanka") ===
        "Vbuild Lanka - Payroll 2026.xlsx",
      payrollYearFilename("2026", "xlsx", "Vbuild Lanka"),
    );
    check(
      payslipFilename("Nimal Perera", "2026-08") ===
        "Payslip - Nimal Perera - August 2026.pdf",
      payslipFilename("Nimal Perera", "2026-08"),
    );
    check(
      payslipFilename("", "2026-08") === "Payslip - Employee - August 2026.pdf",
      "somebody with no name still gets a usable file name",
    );
    check(
      payslipFilename("A/B\\C:D*E", "2026-08").indexOf("/") === -1,
      "and a name with characters Windows refuses is cleaned",
    );
    check(
      payslipsFilename("2026-08").includes("office copy"),
      `the everybody file says what it is (${payslipsFilename("2026-08")})`,
    );
  }

  /* ==================================================================== */
  section("The spreadsheet is a working document, not a picture");
  {
    const { doc, augId } = fixture();
    const buf = await buildPayrollXlsx(doc, augId);
    writeFileSync(".verify/payroll-month.xlsx", buf);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    check(
      wb.worksheets.map((w) => w.name).join(", ") === "August 2026, Rates",
      `the month comes first (${wb.worksheets.map((w) => w.name).join(", ")})`,
    );

    const ws = wb.getWorksheet("August 2026")!;
    const header = (ws.getRow(2).values as unknown[]).slice(1) as string[];
    check(header[0] === "Name", "Name is the first column");
    check(header[1] === "TIN", "then TIN");
    check(header[2] === "Gross Salary", "then Gross Salary");
    check(
      header.includes("EPF 8% (employee)"),
      `the employee's EPF names its rate (${header.join(" | ")})`,
    );
    check(header.includes("ETF 3% (employer)"), "and the ETF says whose it is");
    check(header.includes("Net Salary"), "Net Salary is a column");
    check(header.includes("Other Deductions"), "and Other Deductions");

    // The layout itself has to put the employer's contributions past the net,
    // so no reading of the sheet subtracts them.
    const netAt = header.indexOf("Net Salary");
    check(
      netAt > header.indexOf("EPF 8% (employee)"),
      "the employee's EPF comes before the net",
    );
    check(
      netAt < header.indexOf("EPF 12% (employer)"),
      "the employer's EPF comes after it",
    );
    check(netAt < header.indexOf("ETF 3% (employer)"), "and so does the ETF");

    const isFormula = (cell: ExcelJS.Cell) =>
      cell.value !== null &&
      typeof cell.value === "object" &&
      "formula" in (cell.value as object);
    const resultOf = (cell: ExcelJS.Cell) =>
      Number((cell.value as { result: number }).result);

    // Every derived figure must be a formula, so editing a salary recalculates.
    const netCell = ws.getCell(3, netAt + 1);
    check(isFormula(netCell), "the net is a formula, not a typed number");
    check(resultOf(netCell) === 92_500, `carrying its answer (${resultOf(netCell)})`);

    for (const label of [
      "Total Earnings",
      "Total Deductions",
      "Cost to Employer",
    ]) {
      const cell = ws.getCell(3, header.indexOf(label) + 1);
      check(isFormula(cell), `${label} is a formula`);
    }

    // EPF and ETF are formulas against the Rates sheet, so a rate change carries.
    const epfCell = ws.getCell(3, header.indexOf("EPF 8% (employee)") + 1);
    check(isFormula(epfCell), "the employee's EPF is a formula");
    check(
      (epfCell.value as { formula: string }).formula.includes("Rates!"),
      `pointing at the rates sheet (${(epfCell.value as { formula: string }).formula})`,
    );

    // ...unless it was typed in, where a formula would overwrite the fact.
    const sunilEpf = ws.getCell(5, header.indexOf("EPF 8% (employee)") + 1);
    check(!isFormula(sunilEpf), "a typed-in EPF stays a typed number");
    check(sunilEpf.value === 1_000, `with the figure that was typed (${sunilEpf.value})`);

    // The total row.
    const totalRowNumber = 6;
    check(
      String(ws.getCell(totalRowNumber, 1).value).startsWith("Total"),
      `the total row is where expected (${ws.getCell(totalRowNumber, 1).value})`,
    );
    for (const label of ["Gross Salary", "Net Salary", "ETF 3% (employer)"]) {
      const cell = ws.getCell(totalRowNumber, header.indexOf(label) + 1);
      check(
        isFormula(cell) &&
          (cell.value as { formula: string }).formula.startsWith("SUM("),
        `the ${label} total is a SUM (${(cell.value as { formula?: string }).formula})`,
      );
    }
    check(
      resultOf(ws.getCell(totalRowNumber, header.indexOf("Net Salary") + 1)) ===
        191_700,
      "and adds up",
    );

    // The rates sheet.
    const rates = wb.getWorksheet("Rates")!;
    check(rates.getCell("B2").value === 0.08, `employee EPF (${rates.getCell("B2").value})`);
    check(rates.getCell("B3").value === 0.12, "employer EPF");
    check(rates.getCell("B4").value === 0.03, "ETF");
    check(
      String(rates.getCell("A4").value).toLowerCase().includes("company"),
      `and the ETF row says who pays it (${rates.getCell("A4").value})`,
    );

    // The title must not swallow the stamp beside it.
    check(
      String(ws.getCell(1, 1).value).includes("Payroll August 2026"),
      `the title reads properly (${ws.getCell(1, 1).value})`,
    );
    check(
      String(ws.getCell(1, header.length).value).includes("Paid 2026-08-31"),
      `and the paid date survives beside it (${ws.getCell(1, header.length).value})`,
    );
  }

  /* ==================================================================== */
  section("A year of wages in one workbook");
  {
    let { doc } = fixture();
    doc = addMonth(doc, "2026-09").doc;
    const buf = await buildPayrollYearXlsx(doc, "2026");
    writeFileSync(".verify/payroll-year.xlsx", buf);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const names = wb.worksheets.map((w) => w.name);
    check(names[0] === "Year 2026", `the summary opens first (${names.join(", ")})`);
    check(names.includes("August 2026") && names.includes("September 2026"), "every month has a tab");

    const sum = wb.getWorksheet("Year 2026")!;
    check(String(sum.getCell("A3").value) === "August 2026", "August is the first row");

    // The summary must point at the months rather than restate them.
    const augNet = sum.getCell("G3");
    check(
      typeof augNet.value === "object" &&
        (augNet.value as { formula: string }).formula.includes("'August 2026'!"),
      `it refers to the month's own sheet (${(augNet.value as { formula?: string }).formula})`,
    );
    check(
      Number((augNet.value as { result: number }).result) === 191_700,
      "with the right answer cached",
    );

    // Headcount must not be a sum, or one person in twelve months becomes twelve.
    const heads = sum.getCell("B5");
    check(
      (heads.value as { formula: string }).formula.startsWith("MAX("),
      `headcount is the largest month, not a total (${(heads.value as { formula?: string }).formula})`,
    );
    check(Number((heads.value as { result: number }).result) === 3, "which is three");

    await (async () => {
      let empty = emptyPayrollDoc();
      empty = addMonth(empty, "2026-08").doc;
      let threw = "";
      try {
        await buildPayrollYearXlsx(empty, "2031");
      } catch (err) {
        threw = (err as Error).message;
      }
      check(threw.includes("2031"), `a year with no payroll is refused (${threw})`);
    })();
  }

  /* ==================================================================== */
  section("A payslip shows one person's pay and nobody else's");
  {
    const { doc, augId, ids } = fixture();
    const pdf = await renderPayslipPdf(doc, augId, ids[0]);
    writeFileSync(".verify/payslip.pdf", pdf);
    const text = String((await pdfParse(pdf)).text);

    check(text.includes("Nimal Perera"), "the person is named");
    check(text.includes("123456789"), "with their TIN");
    check(text.includes("August 2026"), "and the month");
    check(text.includes("Vbuild Lanka"), "and the employer");
    check(text.includes("Rs100,000.00"), "their gross is shown");
    check(text.includes("Rs92,500.00"), "and their net");

    // The whole point of a payslip being one page per person.
    check(!text.includes("Kamala"), "the next person on the payroll is not on it");
    check(!text.includes("Sunil"), "nor the one after that");
    check(!text.includes("987654321"), "nor anybody else's TIN");
    check(!text.includes("Rs60,000.00"), "nor anybody else's salary");
    check(!text.includes("Rs191,700.00"), "nor the month's total wage bill");
    check(!text.includes("Rs205,000.00"), "nor the total gross");

    // The three contributions have to read correctly.
    check(text.includes("Rs8,000.00"), "the employee's own EPF is shown");
    check(text.includes("Rs12,000.00"), "so is the employer's");
    check(text.includes("Rs3,000.00"), "and the ETF");
    check(
      /not deducted from your pay/i.test(text),
      "and it says the company's contributions are not deducted",
    );
    check(
      /paid by the company/i.test(text),
      "and that the company pays them",
    );

    // A column nobody used must not appear as a zero line.
    const withUnused = addField(doc, "Meal allowance", "allowance").doc;
    const text2 = String(
      (await pdfParse(await renderPayslipPdf(withUnused, augId, ids[0]))).text,
    );
    check(!text2.includes("Meal"), "an allowance nobody got is left off");

    // A used one must appear.
    check(text.includes("Transport"), "an allowance somebody did get is on it");
    check(text.includes("PAYE"), "and so is a deduction");
    check(text.includes("Advance recovered"), "and the note about the row");

    // Somebody with no TIN is still payable, and the slip says so plainly.
    const noTin = String((await pdfParse(await renderPayslipPdf(doc, augId, ids[2]))).text);
    check(
      noTin.includes("not recorded"),
      "a missing TIN is stated rather than left blank",
    );

    let threw = "";
    try {
      await renderPayslipPdf(doc, augId, "nobody");
    } catch (err) {
      threw = (err as Error).message;
    }
    check(threw !== "", `a payslip for somebody not on the payroll is refused (${threw})`);
  }

  /* ==================================================================== */
  section("The office copy holds everybody, one page each");
  {
    const { doc, augId } = fixture();
    const pdf = await renderPayslipsPdf(doc, augId);
    writeFileSync(".verify/payslips-office.pdf", pdf);
    const parsed = await pdfParse(pdf);
    const text = String(parsed.text);

    check(parsed.numpages === 3, `one page per person (${parsed.numpages})`);
    check(
      text.includes("Nimal Perera") &&
        text.includes("Kamala Silva") &&
        text.includes("Sunil Fernando"),
      "everybody is in the file",
    );
    check(
      payslipsFilename("2026-08").includes("office copy"),
      "and its name warns that it is not for handing out",
    );
  }

  /* ==================================================================== */
  section("The download route");
  {
    const { doc, augId, ids } = fixture();

    const monthRes = await payrollPost(
      jsonReq({ doc, scope: "month", monthId: augId }),
    );
    check(monthRes.status === 200, `a month exports (${monthRes.status})`);
    check(
      monthRes.headers.get("Content-Type") === CONTENT_XLSX,
      "as a spreadsheet",
    );
    check(
      (monthRes.headers.get("Content-Disposition") ?? "").includes(
        "Vbuild Lanka Pvt Ltd - Payroll - August 2026.xlsx",
      ),
      `named after the employer and the month, with the brackets taken out of the file name (${monthRes.headers.get("Content-Disposition")})`,
    );
    check(
      monthRes.headers.get("Cache-Control") === "no-store",
      "and is not cached, wages being nobody else's business",
    );

    const yearRes = await payrollPost(
      jsonReq({ doc, scope: "year", monthId: augId, year: "2026" }),
    );
    check(yearRes.status === 200, `a year exports (${yearRes.status})`);
    check(
      (yearRes.headers.get("Content-Disposition") ?? "").includes("Payroll 2026.xlsx"),
      `named after the year (${yearRes.headers.get("Content-Disposition")})`,
    );

    const slipRes = await payrollPost(
      jsonReq({ doc, scope: "payslip", monthId: augId, rowId: ids[0] }),
    );
    check(slipRes.status === 200, `a payslip exports (${slipRes.status})`);
    check(slipRes.headers.get("Content-Type") === "application/pdf", "as a PDF");
    check(
      (slipRes.headers.get("Content-Disposition") ?? "").includes(
        "Payslip - Nimal Perera - August 2026.pdf",
      ),
      `named after the person (${slipRes.headers.get("Content-Disposition")})`,
    );

    const allRes = await payrollPost(
      jsonReq({ doc, scope: "payslips", monthId: augId }),
    );
    check(allRes.status === 200, `the office copy exports (${allRes.status})`);
    check(
      (allRes.headers.get("Content-Disposition") ?? "").includes("office copy"),
      "with the warning in its name",
    );

    /* ------------------------------ refusals ------------------------------ */
    check(
      (await payrollPost(jsonReq({ doc: emptyPayrollDoc(), scope: "month" }))).status ===
        400,
      "a payroll with no months is refused",
    );
    check(
      (await payrollPost(jsonReq({ doc, scope: "month", monthId: "nope" }))).status === 400,
      "so is a month that is not there",
    );
    check(
      (await payrollPost(jsonReq({ doc, scope: "year", monthId: augId, year: "nope" })))
        .status === 400,
      "and a year that is not a year",
    );
    check(
      (await payrollPost(jsonReq({ doc, scope: "year", monthId: augId, year: "2031" })))
        .status === 400,
      "and a year with no payroll in it",
    );
    check(
      (await payrollPost(jsonReq({ doc, scope: "payslip", monthId: augId, rowId: "nope" })))
        .status === 400,
      "and a payslip for somebody not on the payroll",
    );

    // An empty month exports as a spreadsheet but has no payslips in it.
    let bare = emptyPayrollDoc();
    const bareMonth = addMonth(bare, "2026-08");
    bare = bareMonth.doc;
    check(
      (await payrollPost(jsonReq({ doc: bare, scope: "month", monthId: bareMonth.month!.id })))
        .status === 200,
      "a month with nobody on it still exports as a sheet",
    );
    const noSlips = await payrollPost(
      jsonReq({ doc: bare, scope: "payslips", monthId: bareMonth.month!.id }),
    );
    check(noSlips.status === 400, `but has no payslips (${noSlips.status})`);
    check(
      /nobody/i.test(((await noSlips.json()) as { error: string }).error),
      "and says so",
    );

    // A negative wage stops a payslip, because a payslip is a promise to pay.
    let broke = emptyPayrollDoc();
    const bm = addMonth(broke, "2026-08");
    broke = addRow(bm.doc, bm.month!.id, { name: "Over Deducted", gross: 10_000 });
    const brokeRow = findMonth(broke, bm.month!.id)!.rows[0].id;
    broke = setRowMoney(broke, bm.month!.id, brokeRow, "otherDeductions", 50_000);
    const brokeRes = await payrollPost(
      jsonReq({ doc: broke, scope: "payslip", monthId: bm.month!.id, rowId: brokeRow }),
    );
    check(brokeRes.status === 400, `a negative wage is refused (${brokeRes.status})`);
    const brokeBody = (await brokeRes.json()) as { error: string };
    check(
      brokeBody.error.includes("Over Deducted"),
      `naming who it is (${brokeBody.error})`,
    );
    check(
      (await payrollPost(jsonReq({ doc: broke, scope: "month", monthId: bm.month!.id })))
        .status === 200,
      "though the spreadsheet still exports, since that is where you fix it",
    );

    // Somebody unnamed stops a payslip too.
    let unnamed = emptyPayrollDoc();
    const un = addMonth(unnamed, "2026-08");
    unnamed = addRow(un.doc, un.month!.id, { gross: 10_000 });
    const unRes = await payrollPost(
      jsonReq({ doc: unnamed, scope: "payslips", monthId: un.month!.id }),
    );
    check(unRes.status === 400, `an unnamed person stops the payslips (${unRes.status})`);

    /* ---------------------------- bad payloads ---------------------------- */
    for (const body of ["null", "42", '"nonsense"', "[]"]) {
      const res = await payrollPost(rawReq(body));
      check(
        res.status === 400,
        `${body} is refused rather than crashing the route (${res.status})`,
      );
    }
    const malformed = await payrollPost(rawReq("{not json"));
    check(malformed.status === 500, `malformed JSON fails gracefully (${malformed.status})`);
    check(
      typeof ((await malformed.json()) as { error?: string }).error === "string",
      "with a readable message",
    );

    // A hand-edited payload is rebuilt, not trusted.
    const hostile = await payrollPost(
      jsonReq({
        doc: {
          months: [
            {
              id: "m",
              month: "2026-08",
              rows: [{ id: "r", name: "X", gross: -1, otherDeductions: "lots" }],
            },
          ],
        },
        scope: "month",
        monthId: "m",
      }),
    );
    check(hostile.status === 200, `a nonsense payload is cleaned, not crashed (${hostile.status})`);
    const cleanedWb = new ExcelJS.Workbook();
    await cleanedWb.xlsx.load(
      Buffer.from(await hostile.arrayBuffer()) as unknown as ArrayBuffer,
    );
    const cleanedWs = cleanedWb.getWorksheet("August 2026")!;
    check(
      cleanedWs.getCell("C3").value === 0,
      `and a negative salary became zero (${cleanedWs.getCell("C3").value})`,
    );
  }

  /* ==================================================================== */
  section("Every page is reachable from the menu");
  {
    const nav = readFileSync("src/components/Nav.tsx", "utf8");
    // Both spellings: the group entries declare `href: "/x"`, while the
    // standalone links are written `href="/x"`.
    const hrefs = new Set<string>();
    const hrefPattern = /href(?:=|:\s*)"([^"]+)"/g;
    let found: RegExpExecArray | null = hrefPattern.exec(nav);
    while (found !== null) {
      hrefs.add(found[1]);
      found = hrefPattern.exec(nav);
    }

    // Every page on disk has to be in the bar, or it exists and nobody can
    // get to it.
    const pages = readdirSync("src/app", { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "api")
      .map((e) => `/${e.name}`);
    pages.push("/");

    for (const page of pages) {
      check(hrefs.has(page), `${page} is in the menu`);
    }
    check(hrefs.has("/payroll"), "payroll among them");
    check(hrefs.has("/data"), "and the saved-data page");

    // And nothing in the bar points at a page that is not there.
    for (const href of Array.from(hrefs)) {
      if (href === "/") continue;
      check(
        pages.includes(href),
        `the menu entry ${href} goes to a page that exists`,
      );
    }

    // Grouped, or it is the wall of links it was before.
    check(
      /NAV_GROUPS/.test(nav),
      "the menu is grouped rather than one flat row",
    );
    check(
      (nav.match(/id: "(pricing|warehouse|accounts)"/g) ?? []).length === 3,
      "into three groups",
    );
    // A menu that only opens on hover cannot be used on a phone.
    check(/onClick/.test(nav), "the groups open on a click, not only on hover");
    check(/aria-expanded/.test(nav), "and say whether they are open");
    check(/Escape/.test(nav), "and close on Escape");
    check(/md:hidden/.test(nav), "with a separate arrangement for a phone");
  }

  /* ==================================================================== */
  if (failures === 0) console.log("\nALL PAYROLL CHECKS PASSED");
  else {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});

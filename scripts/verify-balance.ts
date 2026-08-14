/**
 * Verifies the balance sheet:
 *  - turnover, expenses, net profit and margin are derived, never stored
 *  - net profit counts general overhead; per-container profit does not, and the
 *    difference between the two is exactly the general overhead
 *  - a container that has cost money but earned none is still listed
 *  - margin is null rather than zero or Infinity when nothing came in
 *  - an expense without a name, a partner or a positive amount is refused
 *  - partner shares always account for 100% of the expenses
 *  - a saved file round-trips, and rubbish in the file cannot poison the sheet
 *  - the CSV carries both halves of the sheet plus the summary blocks
 */
import { mkdirSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import type { NextRequest } from "next/server";
import { buildBalanceXlsx } from "../src/lib/balanceXlsx";
import { buildExpensesXlsx } from "../src/lib/expensesXlsx";
import { totalRow } from "../src/lib/xlsxKit";
import { POST as balanceExportPost } from "../src/app/api/balance-export/route";
import {
  addExpense,
  addTurnover,
  balanceFilename,
  balanceToCsv,
  balanceTotals,
  expensesFilename,
  byContainer,
  byPartner,
  checkExpense,
  checkTurnover,
  containerIds,
  createExpense,
  createTurnover,
  emptyBalanceSheet,
  parseBalanceSheet,
  partnerNames,
  removeExpense,
  removeTurnover,
  updateExpense,
  MAX_ENTRIES,
  type BalanceSheet,
} from "../src/lib/balanceSheet";
import { LIMITS } from "../src/lib/types";

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

const A = "GAOU7441740";
const B = "MSCU1234565";

/**
 * A sheet with two earning containers plus one general overhead expense, so the
 * two different profit scopes can be told apart.
 */
function sample(): BalanceSheet {
  let sheet = emptyBalanceSheet();
  sheet = addTurnover(sheet, createTurnover({ containerId: A, turnover: 1_200_000 }));
  sheet = addTurnover(sheet, createTurnover({ containerId: B, turnover: 800_000 }));
  sheet = addExpense(
    sheet,
    createExpense({ name: "Customs duty", partner: "Anton", amount: 150_000, containerId: A }),
  );
  sheet = addExpense(
    sheet,
    createExpense({ name: "Freight", partner: "Anton", amount: 250_000, containerId: A }),
  );
  sheet = addExpense(
    sheet,
    createExpense({ name: "Labour", partner: "Bala", amount: 100_000, containerId: B }),
  );
  // No container: general overhead.
  sheet = addExpense(
    sheet,
    createExpense({ name: "Office rent", partner: "Bala", amount: 60_000 }),
  );
  return sheet;
}

/* --------------------------------- totals -------------------------------- */

section("Totals");
{
  const sheet = sample();
  const t = balanceTotals(sheet);

  check(t.turnover === 2_000_000, `turnover adds up (${t.turnover})`);
  check(t.expenses === 560_000, `expenses add up (${t.expenses})`);
  check(t.attributedExpenses === 500_000, `expenses tied to a container (${t.attributedExpenses})`);
  check(t.generalExpenses === 60_000, `expenses tied to nothing (${t.generalExpenses})`);
  check(
    t.attributedExpenses + t.generalExpenses === t.expenses,
    "attributed plus general is the whole expense figure",
  );
  check(t.netProfit === 1_440_000, `net profit is turnover less every expense (${t.netProfit})`);
  check(t.margin !== null && Math.abs(t.margin - 72) < 1e-9, `margin is 72% (${t.margin})`);

  const empty = balanceTotals(emptyBalanceSheet());
  check(
    empty.turnover === 0 && empty.expenses === 0 && empty.netProfit === 0,
    "an empty sheet totals zero rather than NaN",
  );
  check(empty.margin === null, "margin is null on an empty sheet, not 0% or Infinity");
}

/* ------------------------------ profit scopes ------------------------------ */

section("Profit scope: net vs per container");
{
  const sheet = sample();
  const t = balanceTotals(sheet);
  const rows = byContainer(sheet);

  check(rows.length === 2, `both containers are listed (${rows.length})`);

  const a = rows.find((r) => r.containerId === A);
  const b = rows.find((r) => r.containerId === B);

  check(a !== undefined && a.turnover === 1_200_000, "container A turnover");
  check(a !== undefined && a.expenses === 400_000, `container A uses only its own expenses (${a?.expenses})`);
  check(a !== undefined && a.profit === 800_000, `container A profit (${a?.profit})`);
  check(a !== undefined && a.expenseCount === 2, "container A counts its two expenses");
  check(
    a !== undefined && a.margin !== null && Math.abs(a.margin - 200 / 3) < 1e-9,
    `container A margin (${a?.margin})`,
  );

  check(b !== undefined && b.expenses === 100_000, `container B expenses (${b?.expenses})`);
  check(b !== undefined && b.profit === 700_000, `container B profit (${b?.profit})`);

  // The heart of the model: general overhead is in the net figure and in
  // neither container, so the gap between the two is exactly that overhead.
  const perContainer = rows.reduce((s, r) => s + r.profit, 0);
  check(
    perContainer === 1_500_000,
    `per-container profit sums to 1,500,000 (${perContainer})`,
  );
  check(
    perContainer - t.netProfit === t.generalExpenses,
    `the gap between per-container and net profit is the general overhead (${perContainer - t.netProfit})`,
  );

  check(
    rows[0].containerId === A && rows[1].containerId === B,
    "containers are listed in ID order",
  );
}

section("A container that cost money but earned none");
{
  let sheet = emptyBalanceSheet();
  sheet = addExpense(
    sheet,
    createExpense({ name: "Storage", partner: "Anton", amount: 50_000, containerId: "TCLU1234567" }),
  );
  const rows = byContainer(sheet);

  check(rows.length === 1, "it is still listed rather than hidden");
  check(rows[0].turnover === 0, "with no turnover");
  check(rows[0].profit === -50_000, `and a loss, not a blank (${rows[0].profit})`);
  check(rows[0].margin === null, "margin is null, not a division by zero");

  const t = balanceTotals(sheet);
  check(t.netProfit === -50_000, `net profit goes negative (${t.netProfit})`);
  check(t.margin === null, "and margin stays null with no turnover at all");
}

section("A loss-making sheet");
{
  let sheet = emptyBalanceSheet();
  sheet = addTurnover(sheet, createTurnover({ containerId: A, turnover: 100_000 }));
  sheet = addExpense(
    sheet,
    createExpense({ name: "Overspend", partner: "Anton", amount: 300_000, containerId: A }),
  );
  const t = balanceTotals(sheet);
  check(t.netProfit === -200_000, `a loss is reported as a negative (${t.netProfit})`);
  check(t.margin !== null && Math.abs(t.margin + 200) < 1e-9, `margin goes negative (${t.margin})`);
}

/* -------------------------------- validation ------------------------------ */

section("Refusing an expense that is not worth recording");
{
  const good = checkExpense({ name: "Customs duty", partner: "Anton", amount: 150_000 });
  check(good.ok, "a complete expense is accepted");

  const cases: Array<[string, { name: string; partner: string; amount: number | null }]> = [
    ["a blank name", { name: "   ", partner: "Anton", amount: 100 }],
    ["a blank partner", { name: "Duty", partner: "  ", amount: 100 }],
    ["no amount", { name: "Duty", partner: "Anton", amount: null }],
    ["an amount of zero", { name: "Duty", partner: "Anton", amount: 0 }],
    ["a negative amount", { name: "Duty", partner: "Anton", amount: -5 }],
    ["a non-numeric amount", { name: "Duty", partner: "Anton", amount: Number("abc") }],
    ["an infinite amount", { name: "Duty", partner: "Anton", amount: Infinity }],
    ["an unrealistic amount", { name: "Duty", partner: "Anton", amount: LIMITS.money * 2 }],
  ];
  for (const entry of cases) {
    const result = checkExpense(entry[1]);
    check(
      !result.ok && typeof result.message === "string" && result.message.length > 0,
      `${entry[0]} is refused, with a reason ("${result.message ?? ""}")`,
    );
  }
}

section("Refusing a turnover entry that is not worth recording");
{
  check(checkTurnover({ containerId: A, turnover: 500 }).ok, "a complete entry is accepted");

  const cases: Array<[string, { containerId: string; turnover: number | null }]> = [
    ["a blank container", { containerId: "  ", turnover: 500 }],
    ["no figure", { containerId: A, turnover: null }],
    ["a figure of zero", { containerId: A, turnover: 0 }],
    ["a negative figure", { containerId: A, turnover: -500 }],
    ["a non-numeric figure", { containerId: A, turnover: Number("x") }],
    ["an unrealistic figure", { containerId: A, turnover: LIMITS.money * 2 }],
  ];
  for (const entry of cases) {
    const result = checkTurnover(entry[1]);
    check(
      !result.ok && typeof result.message === "string" && result.message.length > 0,
      `${entry[0]} is refused, with a reason ("${result.message ?? ""}")`,
    );
  }
}

section("Sanitising what gets stored");
{
  const messy = createExpense({
    name: "  Customs\u0000  duty  ",
    partner: "  Anton  ",
    amount: "150000",
    containerId: "gaou 744174-0",
  });
  check(messy.name === "Customs duty", `control characters and padding stripped ("${messy.name}")`);
  check(messy.partner === "Anton", `partner trimmed ("${messy.partner}")`);
  check(messy.amount === 150_000, `a numeric string becomes a number (${messy.amount})`);
  check(messy.containerId === A, `container normalised to uppercase, no spaces ("${messy.containerId}")`);

  const hostile = createExpense({ name: { evil: true }, partner: [], amount: -99 });
  check(hostile.name === "", "an object cannot become the expense name");
  check(hostile.amount === 0, "a negative amount is clamped to zero, then refused by checkExpense");
  check(hostile.containerId === "", "a missing container means general overhead");

  const capped = createTurnover({ containerId: A, turnover: LIMITS.money * 5 });
  check(capped.turnover === LIMITS.money, `a runaway figure is capped (${capped.turnover})`);

  const dated = createExpense({ name: "X", partner: "Y", amount: 1, at: "not a date" });
  check(!Number.isNaN(Date.parse(dated.at)), "an unparseable date falls back to now");
}

/* ------------------------------- breakdowns ------------------------------- */

section("Expenses by partner");
{
  const sheet = sample();
  const rows = byPartner(sheet);

  check(rows.length === 2, `one row per partner (${rows.length})`);
  check(rows[0].partner === "Anton", "the biggest spender is listed first");
  check(rows[0].expenses === 400_000, `Anton's expenses (${rows[0].expenses})`);
  check(rows[0].count === 2, "with an entry count");
  check(rows[1].partner === "Bala" && rows[1].expenses === 160_000, "Bala's expenses include the general overhead");

  const shares = rows.reduce((s, r) => s + (r.share ?? 0), 0);
  check(Math.abs(shares - 100) < 1e-9, `the shares account for 100% of the expenses (${shares})`);

  const total = rows.reduce((s, r) => s + r.expenses, 0);
  check(total === balanceTotals(sheet).expenses, "and the partner rows add up to the expense total");

  check(byPartner(emptyBalanceSheet()).length === 0, "no partners on an empty sheet");
}

section("Autocomplete lists");
{
  const sheet = sample();
  check(
    partnerNames(sheet).join("|") === "Anton|Bala",
    `partner names are unique and sorted (${partnerNames(sheet).join("|")})`,
  );
  check(
    containerIds(sheet).join("|") === `${A}|${B}`,
    `container IDs come from both halves of the sheet (${containerIds(sheet).join("|")})`,
  );
  check(
    !containerIds(sheet).includes(""),
    "general overhead does not appear as a blank container suggestion",
  );
}

/* -------------------------------- mutation -------------------------------- */

section("Editing and removing");
{
  let sheet = sample();
  const target = sheet.expenses.find((e) => e.name === "Labour");
  check(target !== undefined, "the expense to edit exists");

  sheet = updateExpense(sheet, target!.id, { amount: 120_000 });
  check(
    balanceTotals(sheet).expenses === 580_000,
    `editing an amount moves the total (${balanceTotals(sheet).expenses})`,
  );

  sheet = updateExpense(sheet, target!.id, { containerId: "mscu 123456-5" });
  const b = byContainer(sheet).find((r) => r.containerId === B);
  check(b !== undefined && b.expenses === 120_000, "an edited container ID is normalised, not duplicated");

  sheet = updateExpense(sheet, target!.id, { containerId: "" });
  check(
    balanceTotals(sheet).generalExpenses === 180_000,
    `clearing the container moves it to general overhead (${balanceTotals(sheet).generalExpenses})`,
  );

  sheet = removeExpense(sheet, target!.id);
  check(sheet.expenses.length === 3, `removing an expense drops one row (${sheet.expenses.length})`);
  check(balanceTotals(sheet).expenses === 460_000, "and the total follows");

  const before = sheet.turnover.length;
  sheet = removeTurnover(sheet, sheet.turnover[0].id);
  check(sheet.turnover.length === before - 1, "a turnover entry can be taken back out");

  sheet = removeExpense(sheet, "no-such-id");
  check(sheet.expenses.length === 3, "removing an unknown id changes nothing");

  let big = emptyBalanceSheet();
  for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
    big = addExpense(big, createExpense({ name: `E${i}`, partner: "Anton", amount: 1 }));
  }
  check(big.expenses.length === MAX_ENTRIES, `the sheet is capped at ${MAX_ENTRIES} entries`);
}

/* ------------------------------- persistence ------------------------------ */

section("Saving and reloading");
{
  const sheet = sample();
  const round = parseBalanceSheet(JSON.parse(JSON.stringify(sheet)));

  check(round.expenses.length === 4, `every expense survives the round trip (${round.expenses.length})`);
  check(round.turnover.length === 2, `every turnover entry survives (${round.turnover.length})`);
  check(
    JSON.stringify(balanceTotals(round)) === JSON.stringify(balanceTotals(sheet)),
    "and every figure is identical afterwards",
  );
  check(
    round.expenses.map((e) => e.id).join("|") === sheet.expenses.map((e) => e.id).join("|"),
    "ids are preserved, so editing a reloaded sheet still works",
  );
  check(
    round.expenses[0].note === sheet.expenses[0].note &&
      round.expenses[0].at === sheet.expenses[0].at,
    "notes and dates are preserved",
  );
}

section("Rubbish in the file cannot poison the sheet");
{
  const garbage: unknown[] = [null, undefined, 42, "nonsense", [], { expenses: "nope" }];
  for (const item of garbage) {
    const parsed = parseBalanceSheet(item);
    check(
      parsed.expenses.length === 0 && parsed.turnover.length === 0,
      `${JSON.stringify(item) ?? "undefined"} parses to an empty sheet rather than throwing`,
    );
  }

  const mixed = parseBalanceSheet({
    expenses: [
      null,
      {},
      { name: "No amount" },
      { name: "", partner: "P", amount: 500 },
      { name: "Free", partner: "P", amount: 0 },
      { name: "Keeper", partner: "Anton", amount: 100, containerId: A },
    ],
    turnover: [
      { containerId: "", turnover: 900 },
      { containerId: B, turnover: 0 },
      { containerId: B, turnover: 700 },
    ],
  });
  check(
    mixed.expenses.length === 1 && mixed.expenses[0].name === "Keeper",
    `nameless and free expenses are dropped (${mixed.expenses.length} kept)`,
  );
  check(
    mixed.turnover.length === 1 && mixed.turnover[0].turnover === 700,
    `turnover with no container or no figure is dropped (${mixed.turnover.length} kept)`,
  );
  check(
    balanceTotals(mixed).netProfit === 600,
    `and the surviving rows still add up (${balanceTotals(mixed).netProfit})`,
  );
  check(
    mixed.expenses[0].id.length > 0 && mixed.turnover[0].id.length > 0,
    "rows missing an id are given one",
  );
}

/* ---------------------------------- CSV ----------------------------------- */

section("CSV export");
{
  const sheet = sample();
  const csv = balanceToCsv(sheet);
  const lines = csv.split("\n");

  check(
    lines[0] === "Section,Date,Container,Detail,Partner,Amount",
    `there is a header row (${lines[0]})`,
  );
  check(
    lines.filter((l) => l.startsWith("Turnover,")).length === 2,
    "both turnover entries are rows",
  );
  check(
    lines.filter((l) => l.startsWith("Expense,")).length === 4,
    "all four expenses are rows",
  );
  check(
    csv.includes("Total turnover") && csv.includes("Total expenses") && csv.includes("Net profit"),
    "the summary block is present",
  );
  check(csv.includes("Container,Turnover,Expenses,Profit"), "the per-container block is present");
  check(csv.includes("Partner,Expenses,Entries"), "the per-partner block is present");
  check(
    csv.includes("(general, not per container)"),
    "general overhead is labelled in the container block rather than hidden",
  );
  check(csv.includes(`${A},1200000,400000,800000`), "a container row carries its own figures");
  check(csv.includes("Anton,400000,2"), "a partner row carries its total and count");
  check(csv.includes("(general)"), "an expense with no container reads as general");

  // A comma in a name must not shift the columns.
  let tricky = emptyBalanceSheet();
  tricky = addExpense(
    tricky,
    createExpense({ name: 'Duty, port "A"', partner: "Anton", amount: 100 }),
  );
  const trickyCsv = balanceToCsv(tricky);
  check(
    trickyCsv.includes('"Duty, port ""A"""'),
    "commas and quotes in a name are escaped, not left to break the columns",
  );

  const emptyCsv = balanceToCsv(emptyBalanceSheet());
  check(emptyCsv.split("\n")[0].startsWith("Section,"), "an empty sheet still exports a header");

  mkdirSync(".verify", { recursive: true });
  writeFileSync(".verify/balance.csv", csv);
  writeFileSync(".verify/balance.json", JSON.stringify(sheet, null, 2));
}

/* --------------------------------- Excel ---------------------------------- */

/** The rows a range like "E3:E6" covers. */
function rangeRows(formula: string): [number, number] | null {
  const m = /([A-Z]+)(\d+):([A-Z]+)(\d+)/.exec(formula);
  if (!m) return null;
  return [Number(m[2]), Number(m[4])];
}

/**
 * The cached answers a spreadsheet stores next to its formulas, read out of the
 * file itself.
 *
 * This has to come from the raw XML rather than from ExcelJS's reader, because
 * the reader quietly discards a cached result of 0 or "" - which are exactly the
 * cases worth checking, since a missing cached value is what makes a total show
 * up blank in Google Sheets, LibreOffice or a mail preview pane that never
 * recalculates. jszip is already installed as an exceljs dependency.
 *
 * Tab order is Summary, Profit by Container, Expenses, Turnover, By Partner.
 */
async function cachedCells(
  buffer: Buffer,
  tab: number,
): Promise<Map<string, { formula?: string; cached?: string }>> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(`xl/worksheets/sheet${tab}.xml`);
  if (!file) throw new Error(`sheet${tab}.xml is missing from the workbook`);
  const xml = await file.async("string");

  const out = new Map<string, { formula?: string; cached?: string }>();
  const cell = /<c r="([A-Z]+\d+)"[^>]*>(?:<f>([^<]*)<\/f>)?(?:<v>([^<]*)<\/v>)?<\/c>/g;
  let m = cell.exec(xml);
  while (m !== null) {
    out.set(m[1], { formula: m[2], cached: m[3] });
    m = cell.exec(xml);
  }
  return out;
}

async function xlsxChecks() {
  section("Excel workbook: structure");

  const sheet = sample();
  const totals = balanceTotals(sheet);
  const buffer = await buildBalanceXlsx(sheet);

  check(buffer.length > 5000, `a workbook is produced (${buffer.length} bytes)`);

  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);

  const names = book.worksheets.map((w) => w.name);
  check(
    names.join(" | ") === "Summary | Profit by Container | Expenses | Turnover | By Partner",
    `five tabs, in reading order (${names.join(" | ")})`,
  );

  const sum = book.getWorksheet("Summary")!;
  const con = book.getWorksheet("Profit by Container")!;
  const ex = book.getWorksheet("Expenses")!;
  const tv = book.getWorksheet("Turnover")!;
  const pa = book.getWorksheet("By Partner")!;

  /** A cell's formula, or "" if it holds a plain value. */
  const f = (ws: ExcelJS.Worksheet, ref: string): string => {
    const v = ws.getCell(ref).value as { formula?: string } | null;
    return v && typeof v === "object" && typeof v.formula === "string" ? v.formula : "";
  };
  /** A formula cell's cached answer. */
  const r = (ws: ExcelJS.Worksheet, ref: string): unknown => {
    const v = ws.getCell(ref).value as { result?: unknown } | null;
    return v && typeof v === "object" && "result" in v ? v.result : v;
  };

  section("Excel workbook: the entry tabs hold the typed amounts");
  {
    // 4 expenses -> rows 3..6, total on row 7. 2 turnover -> rows 3..4, total 5.
    check(totalRow(4) === 7, `the expense total lands on row 7 (${totalRow(4)})`);
    check(totalRow(2) === 5, `the turnover total lands on row 5 (${totalRow(2)})`);

    check(ex.getCell("B3").value === "Customs duty", "an expense name is written out");
    check(ex.getCell("E3").value === 150_000, "its amount is a real number, not text");
    check(ex.getCell("C3").value === "Anton", "its partner is written out");
    check(ex.getCell("D3").value === A, "a tagged expense carries its container");
    const generalRow = [3, 4, 5, 6].find((n) => ex.getCell(`B${n}`).value === "Office rent");
    check(
      generalRow !== undefined && ex.getCell(`D${generalRow}`).value === "(general)",
      "an untagged expense reads as (general) rather than an empty cell",
    );
    check(
      ex.getCell("A3").value instanceof Date,
      "dates are real dates, so Excel can sort and filter them",
    );
    check(
      String(ex.getCell("E3").numFmt).includes("Rs"),
      `amounts are formatted as money (${ex.getCell("E3").numFmt})`,
    );
    check(
      String(ex.getCell("E3").numFmt).includes("Red"),
      "and a negative shows red, so a loss is not missed",
    );
    check(ex.autoFilter !== undefined && ex.autoFilter !== null, "the expenses can be filtered");
    check(tv.getCell("B3").value === A && tv.getCell("C3").value === 1_200_000, "turnover rows are written out");
  }

  section("Excel workbook: every total is a live formula");
  {
    const cases: Array<[string, ExcelJS.Worksheet, string, number]> = [
      ["Expenses total", ex, "E7", totals.expenses],
      ["Turnover total", tv, "C5", totals.turnover],
      ["Summary turnover", sum, "B5", totals.turnover],
      ["Summary expenses", sum, "B6", totals.expenses],
      ["Summary tied to a container", sum, "B7", totals.attributedExpenses],
      ["Summary general overhead", sum, "B8", totals.generalExpenses],
      ["Summary net profit", sum, "B9", totals.netProfit],
    ];
    for (const entry of cases) {
      const label = entry[0];
      const cell = f(entry[1], entry[2]);
      check(cell !== "", `${label} is a formula, not a typed number (${cell || "PLAIN VALUE"})`);
      check(
        r(entry[1], entry[2]) === entry[3],
        `${label} also carries the right cached answer (${String(r(entry[1], entry[2]))})`,
      );
    }

    check(
      f(ex, "E7") === "SUM(E3:E6)",
      `the expense total sums exactly the entry rows (${f(ex, "E7")})`,
    );
    check(
      f(tv, "C5") === "SUM(C3:C4)",
      `the turnover total sums exactly the entry rows (${f(tv, "C5")})`,
    );
    check(
      f(sum, "B5").includes("'Turnover'!C5"),
      `the summary points at the Turnover tab rather than repeating the number (${f(sum, "B5")})`,
    );
    check(
      f(sum, "B10").startsWith("IF(B5=0"),
      `margin guards against dividing by nothing (${f(sum, "B10")})`,
    );
    check(
      Math.abs((r(sum, "B10") as number) - 0.72) < 1e-9,
      `margin is cached as a fraction for the percent format (${String(r(sum, "B10"))})`,
    );
    check(
      String(sum.getCell("B10").numFmt).includes("%"),
      "and the margin cell is percent-formatted",
    );
  }

  section("Excel workbook: profit per container is derived, and keeps its scope");
  {
    check(con.getCell("A3").value === A, "containers are listed");
    check(con.getCell("A4").value === B, "both of them");

    check(
      f(con, "B3").startsWith("SUMIF('Turnover'!"),
      `container turnover is a SUMIF over the Turnover tab (${f(con, "B3")})`,
    );
    check(
      f(con, "C3").startsWith("SUMIF('Expenses'!"),
      `container expenses are a SUMIF over the Expenses tab (${f(con, "C3")})`,
    );
    check(f(con, "D3") === "B3-C3", `profit is turnover less expenses (${f(con, "D3")})`);
    check(r(con, "B3") === 1_200_000, "container A turnover is cached correctly");
    check(r(con, "C3") === 400_000, "container A expenses exclude the general overhead");
    check(r(con, "D3") === 800_000, "so container A profit is 800,000");

    // Row 5 is the general overhead row, row 6 the net total.
    check(
      con.getCell("A5").value === "(general, not per container)",
      `general overhead gets a labelled row of its own (${String(con.getCell("A5").value)})`,
    );
    check(
      f(con, "C5").includes('"(general)"'),
      `it is picked out by matching the (general) label (${f(con, "C5")})`,
    );
    check(r(con, "C5") === 60_000, "with the right amount");
    check(con.getCell("B5").value === null || con.getCell("B5").value === undefined,
      "and no turnover of its own");
    check(r(con, "D5") === -60_000, "overhead shows as a loss on that row");

    check(con.getCell("A6").value === "Total (net)", "the net total is labelled as such");
    check(
      f(con, "B6") === "SUM(B3:B5)" && f(con, "C6") === "SUM(C3:C5)",
      `the total sweeps the containers and the overhead row (${f(con, "C6")})`,
    );
    check(
      r(con, "D6") === totals.netProfit,
      `so the total profit equals the net profit, overhead included (${String(r(con, "D6"))})`,
    );
    // The scope rule, expressed in the spreadsheet itself.
    const perContainer = (r(con, "D3") as number) + (r(con, "D4") as number);
    check(
      perContainer - (r(con, "D6") as number) === totals.generalExpenses,
      `container profits exceed the net by exactly the overhead (${perContainer - (r(con, "D6") as number)})`,
    );
  }

  section("Excel workbook: partner breakdown is derived");
  {
    check(pa.getCell("A3").value === "Anton", "partners are listed, biggest first");
    check(
      f(pa, "B3").startsWith("SUMIF('Expenses'!"),
      `partner spend is a SUMIF over the Expenses tab (${f(pa, "B3")})`,
    );
    check(
      f(pa, "C3").startsWith("COUNTIF('Expenses'!"),
      `the entry count is a COUNTIF (${f(pa, "C3")})`,
    );
    check(r(pa, "B3") === 400_000, "Anton's spend is cached correctly");
    check(r(pa, "C3") === 2, "and his entry count");
    check(
      f(pa, "D3").includes("$B$5"),
      `each share divides by the partner total (${f(pa, "D3")})`,
    );
    check(r(pa, "B5") === totals.expenses, "the partner total matches total expenses");
    check(r(pa, "D5") === 1, "and the shares add up to 100%");
  }

  section("Excel workbook: no total can sit inside its own SUM");
  {
    // A circular reference makes Excel refuse to open the file, so this is
    // checked on both a populated workbook and an empty one.
    const sums: Array<[string, ExcelJS.Worksheet, string, number]> = [
      ["the expense total", ex, "E7", 7],
      ["the turnover total", tv, "C5", 5],
      ["the container turnover total", con, "B6", 6],
      ["the partner total", pa, "B5", 5],
    ];
    for (const entry of sums) {
      const rows = rangeRows(f(entry[1], entry[2]));
      check(
        rows !== null && entry[3] > rows[1],
        `${entry[0]} sums rows above itself only (${f(entry[1], entry[2])} on row ${entry[3]})`,
      );
    }
  }

  section("Excel workbook: entries read as a ledger, oldest first");
  {
    // The page lists newest first for typing; the workbook runs down the page in
    // the order things happened.
    const order = [3, 4, 5, 6].map((n) => String(ex.getCell(`B${n}`).value));
    check(
      order.join(" > ") === "Customs duty > Freight > Labour > Office rent",
      `expenses are in the order they were entered (${order.join(" > ")})`,
    );
    const containersInOrder = [3, 4].map((n) => String(tv.getCell(`B${n}`).value));
    check(
      containersInOrder.join(" > ") === `${A} > ${B}`,
      `turnover likewise (${containersInOrder.join(" > ")})`,
    );
    // Order must not be able to change a figure, since nothing matches on row
    // position - so the totals are unchanged by the sort above.
    check(r(ex, "E7") === totals.expenses, "and the ordering leaves the totals alone");
  }

  section("Excel workbook: every formula carries its own answer");
  {
    // Without a cached answer, a formula cell shows blank in Google Sheets,
    // LibreOffice and most preview panes until they recalculate.
    let formulaCells = 0;
    let missing: string[] = [];
    for (let tab = 1; tab <= 5; tab += 1) {
      const cells = await cachedCells(buffer, tab);
      const refs = Array.from(cells.keys());
      for (const ref of refs) {
        const entry = cells.get(ref)!;
        if (entry.formula === undefined) continue;
        formulaCells += 1;
        if (entry.cached === undefined) missing.push(`sheet${tab}!${ref}`);
      }
    }
    check(formulaCells >= 25, `the workbook is built out of formulas (${formulaCells} of them)`);
    check(
      missing.length === 0,
      `every one carries a cached answer, so nothing shows blank before a recalculation (${missing.join(", ") || "none missing"})`,
    );
  }

  section("Excel workbook: an empty sheet still opens");
  {
    // The awkward case: with no entries there is no row to sum, and a naive
    // range would either be backwards or swallow the total cell itself.
    const blank = await buildBalanceXlsx(emptyBalanceSheet());
    const blankBook = new ExcelJS.Workbook();
    await blankBook.xlsx.load(blank as unknown as ArrayBuffer);

    const bex = blankBook.getWorksheet("Expenses")!;
    const btv = blankBook.getWorksheet("Turnover")!;
    check(blankBook.worksheets.length === 5, "all five tabs are still there");
    check(totalRow(0) === 4, `the total drops to row 4, leaving a blank row (${totalRow(0)})`);

    const exFormula = f(bex, "E4");
    check(exFormula === "SUM(E3:E3)", `the range is a single blank row (${exFormula})`);
    const rows = rangeRows(exFormula);
    check(rows !== null && rows[0] <= rows[1], "and is not backwards");
    check(rows !== null && rows[1] < 4, "and does not include the total cell itself");
    check(f(btv, "C4") === "SUM(C3:C3)", `the turnover tab does the same (${f(btv, "C4")})`);
    check(bex.autoFilter === undefined || bex.autoFilter === null,
      "no filter is set over rows that do not exist");

    // Read from the file, because a zero cached answer is exactly what a viewer
    // that never recalculates has to fall back on.
    const blankEx = await cachedCells(blank, 3);
    check(blankEx.get("E4")?.cached === "0", `the total is cached as 0, not left blank (${String(blankEx.get("E4")?.cached)})`);

    const blankSum = await cachedCells(blank, 1);
    check(blankSum.get("B9")?.cached === "0", `net profit is cached as 0 rather than an error (${String(blankSum.get("B9")?.cached)})`);
    check(
      blankSum.get("B10")?.cached === "",
      "and margin is cached as an empty string, so it shows blank rather than 0%",
    );
  }

  section("Excel workbook: awkward content survives the trip");
  {
    let odd = emptyBalanceSheet();
    odd = addTurnover(odd, createTurnover({ containerId: A, turnover: 100 }));
    odd = addExpense(
      odd,
      // A quote in a name would break a formula if it were ever interpolated.
      createExpense({ name: 'Duty, port "A"', partner: "O'Brien & Co", amount: 400, containerId: A }),
    );
    // An expense on a container that has earned nothing yet.
    odd = addExpense(
      odd,
      createExpense({ name: "Storage", partner: "Anton", amount: 25, containerId: "TCLU1234567" }),
    );

    const buf = await buildBalanceXlsx(odd);
    const oddBook = new ExcelJS.Workbook();
    await oddBook.xlsx.load(buf as unknown as ArrayBuffer);
    const oex = oddBook.getWorksheet("Expenses")!;
    const ocon = oddBook.getWorksheet("Profit by Container")!;

    const names = [3, 4].map((n) => String(oex.getCell(`B${n}`).value));
    check(
      names.includes('Duty, port "A"'),
      `commas and quotes come through intact (${names.join(" / ")})`,
    );
    const partners = [3, 4].map((n) => String(oex.getCell(`C${n}`).value));
    check(partners.includes("O'Brien & Co"), "an apostrophe and an ampersand survive");

    const ids = [3, 4].map((n) => String(ocon.getCell(`A${n}`).value));
    check(
      ids.includes("TCLU1234567"),
      `a container with cost but no turnover is still listed (${ids.join(" / ")})`,
    );
    const lossRow = ids.indexOf("TCLU1234567") + 3;
    check(r(ocon, `D${lossRow}`) === -25, "and its loss so far");

    const oddCon = await cachedCells(buf, 2);
    check(
      oddCon.get(`B${lossRow}`)?.cached === "0",
      `with its turnover cached as 0 (${String(oddCon.get(`B${lossRow}`)?.cached)})`,
    );
    check(
      oddCon.get(`E${lossRow}`)?.cached === "",
      "and a blank margin rather than a division by zero",
    );

    const netProfit = balanceTotals(odd).netProfit;
    check(
      r(oddBook.getWorksheet("Summary")!, "B9") === netProfit,
      `the summary agrees with the app (${String(r(oddBook.getWorksheet("Summary")!, "B9"))} vs ${netProfit})`,
    );
  }

  section("Expenses-only workbook: just the three fields");
  {
    const buf = await buildExpensesXlsx(sheet);
    const book2 = new ExcelJS.Workbook();
    await book2.xlsx.load(buf as unknown as ArrayBuffer);

    check(book2.worksheets.length === 1, `one tab, not five (${book2.worksheets.length})`);
    const ws = book2.getWorksheet("Expenses")!;
    check(ws !== undefined, "and it is called Expenses");
    check(
      String(ws.getCell("A2").value) === "Expense" &&
        String(ws.getCell("B2").value) === "Partner" &&
        String(ws.getCell("C2").value) === "Amount",
      `the columns are Expense, Partner, Amount (${[1, 2, 3].map((c) => String(ws.getRow(2).getCell(c).value)).join(", ")})`,
    );

    // 4 expenses -> rows 3..6, total row 7.
    check(ws.getCell("C3").value === 150_000, "an amount is a real number");
    check(
      f(ws, "C7") === "SUM(C3:C6)",
      `the total is a live SUM over exactly the entry rows (${f(ws, "C7")})`,
    );
    check(
      r(ws, "C7") === totals.expenses,
      `and equals the expense total, so nothing is double counted (${String(r(ws, "C7"))})`,
    );
    check(String(ws.getCell("A7").value) === "Total", "the total row is labelled");
  }

  section("Expenses-only workbook: nothing else leaks into the file");
  {
    // The point of this export is that it can be handed to someone without also
    // handing over what the containers earned. So the figures are checked to be
    // absent from the file, not merely hidden in it.
    const buf = await buildExpensesXlsx(sheet);
    const book2 = new ExcelJS.Workbook();
    await book2.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = book2.getWorksheet("Expenses")!;

    const texts: string[] = [];
    const numbers: number[] = [];
    const formulas: string[] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value as unknown;
        if (typeof v === "number") numbers.push(v);
        else if (typeof v === "string") texts.push(v);
        else if (v && typeof v === "object") {
          const obj = v as { formula?: string; result?: unknown };
          if (typeof obj.formula === "string") formulas.push(obj.formula);
          if (typeof obj.result === "number") numbers.push(obj.result);
        }
      });
    });
    const blob = texts.join(" | ");

    for (const id of [A, B]) {
      check(!blob.includes(id), `the container ID ${id} appears nowhere in the file`);
    }
    for (const figure of [1_200_000, 800_000, 2_000_000, 1_440_000, 700_000]) {
      check(
        !numbers.includes(figure),
        `no turnover or profit figure (${figure}) appears as a value`,
      );
    }
    check(
      formulas.every((formula) => !formula.includes("!")),
      `no formula reaches out to another tab (${formulas.filter((x) => x.includes("!")).join(", ") || "none do"})`,
    );
    check(
      formulas.length > 0 && formulas.every((formula) => !/Turnover|Profit|Margin/i.test(formula)),
      "and none of them mention turnover, profit or margin",
    );
    // A fourth column would be the easy way for a container or date to sneak in.
    let strayColumn = false;
    ws.eachRow({ includeEmpty: true }, (row) => {
      const cell = row.getCell(4).value;
      if (cell !== null && cell !== undefined && cell !== "") strayColumn = true;
    });
    check(!strayColumn, "column D is empty, so there is no fourth field hiding");
  }

  section("Expenses-only workbook: grouped by partner, with live per-partner figures");
  {
    const buf = await buildExpensesXlsx(sheet);
    const book2 = new ExcelJS.Workbook();
    await book2.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = book2.getWorksheet("Expenses")!;

    const rows = [3, 4, 5, 6].map(
      (n) => `${String(ws.getCell(`A${n}`).value)}/${String(ws.getCell(`B${n}`).value)}`,
    );
    check(
      rows.join(" > ") ===
        "Customs duty/Anton > Freight/Anton > Labour/Bala > Office rent/Bala",
      `a partner's expenses sit together, biggest spender first (${rows.join(" > ")})`,
    );

    // Per-partner block: header row 9, partners 10-11, total 12.
    check(
      String(ws.getCell("A9").value) === "Partner" &&
        String(ws.getCell("B9").value) === "Total",
      `there is a per-partner block below the total (${String(ws.getCell("A9").value)})`,
    );
    check(String(ws.getCell("A10").value) === "Anton", "listing each partner");
    check(
      f(ws, "B10") === "SUMIF($B$3:$B$6,$A10,$C$3:$C$6)",
      `their total is a SUMIF over the entry rows only (${f(ws, "B10")})`,
    );
    check(r(ws, "B10") === 400_000, "with the right cached figure");
    check(
      f(ws, "C10") === "COUNTIF($B$3:$B$6,$A10)" && r(ws, "C10") === 2,
      `and a live entry count (${f(ws, "C10")})`,
    );
    check(
      r(ws, "B12") === totals.expenses,
      `the partner block totals the same as the entries (${String(r(ws, "B12"))})`,
    );
    check(r(ws, "C12") === 4, "and counts every entry");

    const ranges = [f(ws, "B10"), f(ws, "C10")];
    check(
      ranges.every((formula) => !formula.includes("$7")),
      "the per-partner ranges stop short of the Total row",
    );
  }

  section("Expenses-only workbook: edge cases");
  {
    // Expenses but no turnover at all - the export must still work, since it
    // never needed the turnover.
    let noTurnover = emptyBalanceSheet();
    noTurnover = addExpense(
      noTurnover,
      createExpense({ name: "Office rent", partner: "Bala", amount: 60_000 }),
    );
    const one = await buildExpensesXlsx(noTurnover);
    const oneBook = new ExcelJS.Workbook();
    await oneBook.xlsx.load(one as unknown as ArrayBuffer);
    const ows = oneBook.getWorksheet("Expenses")!;
    check(ows.getCell("C3").value === 60_000, "a sheet with no turnover still exports");
    check(f(ows, "C4") === "SUM(C3:C3)", `with a total over the single row (${f(ows, "C4")})`);
    check(r(ows, "C4") === 60_000, "and the right answer");
    check(
      String(ows.getCell("B3").value) === "Bala",
      "an untagged expense keeps its partner, since that is what this sheet is for",
    );

    // No expenses: the route refuses this, but the builder must not produce a
    // circular reference if it is ever reached another way.
    const blank = await buildExpensesXlsx(emptyBalanceSheet());
    const blankBook = new ExcelJS.Workbook();
    await blankBook.xlsx.load(blank as unknown as ArrayBuffer);
    const bws = blankBook.getWorksheet("Expenses")!;
    const blankTotal = f(bws, "C4");
    const rows = rangeRows(blankTotal);
    check(
      rows !== null && rows[1] < 4,
      `an empty export still keeps the total outside its own SUM (${blankTotal})`,
    );
    const blankCells = await cachedCells(blank, 1);
    check(blankCells.get("C4")?.cached === "0", "and caches it as 0");

    // An expense arriving with no partner must still be attributable.
    const parsed = parseBalanceSheet({
      expenses: [{ name: "Mystery", amount: 500, partner: "" }],
    });
    check(parsed.expenses.length === 1, "a partnerless expense can exist in a loaded file");
    const odd = await buildExpensesXlsx(parsed);
    const oddBook = new ExcelJS.Workbook();
    await oddBook.xlsx.load(odd as unknown as ArrayBuffer);
    const dws = oddBook.getWorksheet("Expenses")!;
    check(
      String(dws.getCell("B3").value) === "Unassigned",
      `it is labelled Unassigned rather than left blank (${String(dws.getCell("B3").value)})`,
    );
    // One expense -> entries on row 3, total row 4, partner header 6, partner 7.
    check(
      String(dws.getCell("A7").value) === "Unassigned",
      `the per-partner block shifts up with the shorter table (${String(dws.getCell("A7").value)})`,
    );
    check(
      r(dws, "B7") === 500,
      `and the per-partner SUMIF still finds it (${String(r(dws, "B7"))})`,
    );
  }

  section("The export route serves both scopes");
  {
    const jsonReq = (body: unknown): NextRequest =>
      new Request("http://localhost/api/balance-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }) as unknown as NextRequest;

    const XLSX_TYPE =
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    const full = await balanceExportPost(jsonReq({ scope: "full", sheet }));
    check(full.status === 200, `the full sheet is served (${full.status})`);
    check(
      full.headers.get("Content-Type") === XLSX_TYPE,
      "as a spreadsheet, not as JSON",
    );
    check(
      (full.headers.get("Content-Disposition") ?? "").includes("Balance Sheet"),
      `named as the balance sheet (${full.headers.get("Content-Disposition")})`,
    );
    const fullBook = new ExcelJS.Workbook();
    await fullBook.xlsx.load(await full.arrayBuffer());
    check(fullBook.worksheets.length === 5, `with five tabs (${fullBook.worksheets.length})`);

    const only = await balanceExportPost(jsonReq({ scope: "expenses", sheet }));
    check(only.status === 200, `the expenses-only sheet is served (${only.status})`);
    check(
      (only.headers.get("Content-Disposition") ?? "").includes("Expenses"),
      `named for the expenses (${only.headers.get("Content-Disposition")})`,
    );
    const onlyBook = new ExcelJS.Workbook();
    await onlyBook.xlsx.load(await only.arrayBuffer());
    check(onlyBook.worksheets.length === 1, `with one tab (${onlyBook.worksheets.length})`);
    check(
      onlyBook.worksheets[0].getCell("C3").value === 150_000,
      "and the expenses in it",
    );

    // The sheet used to be posted as the whole body.
    const legacy = await balanceExportPost(jsonReq(sheet));
    check(legacy.status === 200, `a sheet posted as the bare body still works (${legacy.status})`);

    // An unrecognised scope must not silently hand over the whole sheet.
    const odd = await balanceExportPost(jsonReq({ scope: "nonsense", sheet }));
    const oddBook = new ExcelJS.Workbook();
    await oddBook.xlsx.load(await odd.arrayBuffer());
    check(
      odd.status === 200 && oddBook.worksheets.length === 5,
      "an unknown scope falls back to the full sheet rather than erroring",
    );

    section("The export route refuses what it cannot build");
    {
      // Turnover but no expenses: the full sheet is fine, expenses-only is not.
      let turnoverOnly = emptyBalanceSheet();
      turnoverOnly = addTurnover(
        turnoverOnly,
        createTurnover({ containerId: A, turnover: 500 }),
      );

      const ok = await balanceExportPost(jsonReq({ scope: "full", sheet: turnoverOnly }));
      check(ok.status === 200, `the full sheet exports with turnover alone (${ok.status})`);

      const refused = await balanceExportPost(
        jsonReq({ scope: "expenses", sheet: turnoverOnly }),
      );
      check(refused.status === 400, `the expenses-only export refuses (${refused.status})`);
      const body = (await refused.json()) as { error?: string };
      check(
        (body.error ?? "").includes("no expenses"),
        `saying why, rather than sending an empty file ("${body.error ?? ""}")`,
      );

      const nothing = await balanceExportPost(jsonReq({ scope: "full", sheet: emptyBalanceSheet() }));
      check(nothing.status === 400, `an empty sheet is refused (${nothing.status})`);

      for (const junk of [null, 42, "nonsense", { sheet: "not a sheet" }]) {
        const res = await balanceExportPost(jsonReq(junk));
        check(
          res.status === 400,
          `${JSON.stringify(junk)} is refused rather than crashing the route (${res.status})`,
        );
      }
    }
  }

  section("Export filename");
  {
    const name = balanceFilename("xlsx", new Date("2026-08-09T10:00:00Z"));
    check(name === "Balance Sheet 2026-08-09.xlsx", `dated and readable (${name})`);
    check(
      balanceFilename("csv", new Date("2026-08-09T10:00:00Z")) === "Balance Sheet 2026-08-09.csv",
      "the CSV uses the same naming",
    );
    check(
      !balanceFilename("xlsx").includes("undefined") &&
        !Number.isNaN(Date.parse(balanceFilename("xlsx").slice(14, 24))),
      "and defaults to today when no date is given",
    );
    const expensesName = expensesFilename("xlsx", new Date("2026-08-09T10:00:00Z"));
    check(
      expensesName === "Expenses 2026-08-09.xlsx",
      `the expenses export is named so it cannot be mistaken for the full sheet (${expensesName})`,
    );
    check(
      expensesName !== balanceFilename("xlsx", new Date("2026-08-09T10:00:00Z")),
      "and the two exports never collide in a downloads folder",
    );
  }

  mkdirSync(".verify", { recursive: true });
  writeFileSync(".verify/Balance Sheet.xlsx", buffer);

  if (failures > 0) {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nALL BALANCE SHEET CHECKS PASSED");
}

xlsxChecks();

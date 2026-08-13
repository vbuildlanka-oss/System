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
import {
  addExpense,
  addTurnover,
  balanceToCsv,
  balanceTotals,
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

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("\nALL BALANCE SHEET CHECKS PASSED");

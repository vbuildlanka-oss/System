/**
 * Verifies balances to be paid:
 *  - outstanding is always derived, and a balance can never owe less than nothing
 *  - overdue means past its date with something left, not merely dated
 *  - balances stay OUT of the profit arithmetic, so an expense already recorded
 *    is not counted a second time as a debt
 *  - the workbook tab is a live form: change the total or the paid figure and
 *    what is left follows, and it exports even when empty so it can be filled in
 *  - a sheet of expenses cannot be read as a ledger of debts
 *  - nothing is imported without a reason for every row left out
 *  - the page cannot drag a spreadsheet library into the browser
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";
import type { NextRequest } from "next/server";
import {
  addBalanceDue,
  addExpense,
  addTurnover,
  balanceDueStatus,
  balanceDueTotals,
  balanceOutstanding,
  balanceToCsv,
  balanceTotals,
  byParty,
  checkBalanceDue,
  createBalanceDue,
  createExpense,
  createTurnover,
  emptyBalanceSheet,
  isBalanceOverdue,
  parseBalanceSheet,
  partyNames,
  removeBalanceDue,
  settleBalanceDue,
  balancesFilename,
  todayIso,
  updateBalanceDue,
  MAX_ENTRIES,
  type BalanceDue,
  type BalanceSheet,
} from "../src/lib/balanceSheet";
import { buildBalanceXlsx } from "../src/lib/balanceXlsx";
import { buildBalancesXlsx } from "../src/lib/balancesXlsx";
import { POST as balanceExportPost } from "../src/app/api/balance-export/route";
import { xlsxToGrids } from "../src/lib/parseTabular";
import {
  addImportedBalances,
  markBalanceDuplicates,
  newBalances,
  parseBalanceGrid,
  pickBalanceSheet,
  readDirection,
  type ImportedBalance,
} from "../src/lib/balancesImport";
import { OWE_LABEL, OWED_LABEL } from "../src/lib/labels";
import { LIMITS } from "../src/lib/types";
import { POST as balanceImportPost } from "../src/app/api/balance-import/route";

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
const PAST = "2020-01-01";
const FUTURE = "2099-12-31";

/** Two owed out, one owed in, one of them overdue. */
function sample(): BalanceSheet {
  let sheet = emptyBalanceSheet();
  sheet = addBalanceDue(
    sheet,
    createBalanceDue({
      party: "Anton",
      amount: 150_000,
      paid: 50_000,
      containerId: A,
      dueAt: PAST,
    }),
  );
  sheet = addBalanceDue(
    sheet,
    createBalanceDue({ party: "Bala", amount: 60_000 }),
  );
  sheet = addBalanceDue(
    sheet,
    createBalanceDue({
      party: "Ahmad Trading",
      direction: "receivable",
      amount: 200_000,
      paid: 20_000,
      dueAt: FUTURE,
    }),
  );
  return sheet;
}

/* ------------------------------- what is left ------------------------------ */

section("What is left to settle");
{
  const sheet = sample();
  const anton = sheet.balances.find((b) => b.party === "Anton")!;
  const bala = sheet.balances.find((b) => b.party === "Bala")!;

  check(balanceOutstanding(anton) === 100_000, `a part-paid balance (${balanceOutstanding(anton)})`);
  check(balanceOutstanding(bala) === 60_000, "and one nothing has been paid against");
  check(balanceDueStatus(anton) === "part-paid", `status reads part-paid (${balanceDueStatus(anton)})`);
  check(balanceDueStatus(bala) === "unpaid", "and unpaid");

  const settled = createBalanceDue({ party: "X", amount: 500, paid: 500 });
  check(balanceOutstanding(settled) === 0, "a fully paid balance owes nothing");
  check(balanceDueStatus(settled) === "settled", "and reads as settled");

  // Stored figures could disagree after a hand-edited file; the answer must not
  // become a negative debt, which reads as money owed the other way.
  const overpaid = { ...settled, paid: 900 };
  check(balanceOutstanding(overpaid) === 0, `an overpayment floors at zero (${balanceOutstanding(overpaid)})`);
}

section("Overdue means past the date with something left");
{
  const today = todayIso();
  const overdue = createBalanceDue({ party: "X", amount: 100, dueAt: PAST });
  check(isBalanceOverdue(overdue, today), "a balance past its date is overdue");

  const later = createBalanceDue({ party: "X", amount: 100, dueAt: FUTURE });
  check(!isBalanceOverdue(later, today), "one due later is not");

  const dueToday = createBalanceDue({ party: "X", amount: 100, dueAt: today });
  check(!isBalanceOverdue(dueToday, today), "one due today is not overdue yet");

  const undated = createBalanceDue({ party: "X", amount: 100 });
  check(
    !isBalanceOverdue(undated, today),
    "and one with no date never is - an undated balance is a note, not a deadline",
  );

  const paidLate = createBalanceDue({ party: "X", amount: 100, paid: 100, dueAt: PAST });
  check(
    !isBalanceOverdue(paidLate, today),
    "a settled balance is not overdue, however late it was paid",
  );
}

/* --------------------------------- totals --------------------------------- */

section("The position");
{
  const t = balanceDueTotals(sample());

  check(t.payable === 210_000, `everything we owe (${t.payable})`);
  check(t.receivable === 200_000, `everything owed to us (${t.receivable})`);
  check(t.payableOutstanding === 160_000, `still to pay (${t.payableOutstanding})`);
  check(t.receivableOutstanding === 180_000, `still to receive (${t.receivableOutstanding})`);
  check(t.paid === 70_000, `settled so far (${t.paid})`);
  check(t.net === 20_000, `net position is in less out (${t.net})`);
  check(t.overdueAmount === 100_000, `overdue amount (${t.overdueAmount})`);
  check(t.overdueCount === 1, `overdue count (${t.overdueCount})`);
  check(t.settledCount === 0, "nothing settled yet");
  check(t.count === 3, "three balances");

  const empty = balanceDueTotals(emptyBalanceSheet());
  check(
    empty.payableOutstanding === 0 && empty.net === 0 && empty.count === 0,
    "an empty ledger totals zero rather than NaN",
  );

  // Net can go either way, and must not be dressed up as a positive.
  let owing = emptyBalanceSheet();
  owing = addBalanceDue(owing, createBalanceDue({ party: "X", amount: 500 }));
  check(balanceDueTotals(owing).net === -500, `owing more than owed reads negative (${balanceDueTotals(owing).net})`);
}

section("Balances are not profit");
{
  // The rule worth protecting: an expense already recorded, plus a balance for
  // what is left to pay on it, must not count the same money twice.
  let sheet = emptyBalanceSheet();
  sheet = addTurnover(sheet, createTurnover({ containerId: A, turnover: 1_000_000 }));
  sheet = addExpense(
    sheet,
    createExpense({ name: "Freight", partner: "Anton", amount: 150_000, containerId: A }),
  );
  const before = balanceTotals(sheet);

  sheet = addBalanceDue(
    sheet,
    createBalanceDue({ party: "Anton", amount: 150_000, containerId: A }),
  );
  const after = balanceTotals(sheet);

  check(after.expenses === before.expenses, `expenses are unchanged by a balance (${after.expenses})`);
  check(after.netProfit === before.netProfit, `so is net profit (${after.netProfit})`);
  check(after.margin === before.margin, "and the margin");
  check(
    balanceDueTotals(sheet).payableOutstanding === 150_000,
    "while the balance is reported on its own",
  );
}

/* ------------------------------- by party --------------------------------- */

section("By party");
{
  const rows = byParty(sample());
  check(rows.length === 3, `one row per party (${rows.length})`);
  check(rows[0].party === "Ahmad Trading", `biggest outstanding first (${rows[0].party})`);
  check(rows[0].receivableOutstanding === 180_000, "with the right figure");
  check(rows[0].net === 180_000, "and a net for that party alone");

  const anton = rows.find((r) => r.party === "Anton")!;
  check(anton.payableOutstanding === 100_000, "a part-paid balance counts what is left");
  check(anton.overdueCount === 1, "and its overdue entry is counted");
  check(anton.net === -100_000, `owing shows as a negative net (${anton.net})`);

  // Someone both owed and owing appears once, with both figures.
  let both = emptyBalanceSheet();
  both = addBalanceDue(both, createBalanceDue({ party: "Anton", amount: 500 }));
  both = addBalanceDue(
    both,
    createBalanceDue({ party: "anton", direction: "receivable", amount: 800 }),
  );
  const bothRows = byParty(both);
  check(
    bothRows.length === 2,
    `a different spelling is a different party, since it is a name (${bothRows.length})`,
  );

  check(partyNames(sample()).join(", ") === "Ahmad Trading, Anton, Bala", "parties are listed for autocomplete");
  check(byParty(emptyBalanceSheet()).length === 0, "no parties on an empty ledger");
}

/* -------------------------------- validation ------------------------------ */

section("Refusing a balance that is not worth recording");
{
  check(checkBalanceDue({ party: "Anton", amount: 500, paid: 100 }).ok, "a complete balance is accepted");
  check(checkBalanceDue({ party: "Anton", amount: 500 }).ok, "and one with nothing paid yet");

  const cases: Array<[string, { party: string; amount: number | null; paid?: number | null }]> = [
    ["a blank party", { party: "   ", amount: 500 }],
    ["no amount", { party: "Anton", amount: null }],
    ["an amount of zero", { party: "Anton", amount: 0 }],
    ["a negative amount", { party: "Anton", amount: -5 }],
    ["a non-numeric amount", { party: "Anton", amount: Number("abc") }],
    ["an unrealistic amount", { party: "Anton", amount: LIMITS.money * 2 }],
    ["a negative paid figure", { party: "Anton", amount: 500, paid: -1 }],
    ["a non-numeric paid figure", { party: "Anton", amount: 500, paid: Number("x") }],
    ["paid more than the total", { party: "Anton", amount: 500, paid: 900 }],
  ];
  for (const entry of cases) {
    const result = checkBalanceDue(entry[1]);
    check(
      !result.ok && typeof result.message === "string" && result.message.length > 0,
      `${entry[0]} is refused, with a reason ("${result.message ?? ""}")`,
    );
  }
}

section("Sanitising what gets stored");
{
  const messy = createBalanceDue({
    party: "  Anton\u0000  Perera  ",
    direction: "nonsense",
    amount: "150000",
    paid: "50000",
    containerId: "gaou 744174-0",
    orderNumber: "  Sri Lanka  Order 03 ",
    dueAt: "2026-08-20T13:45:00.000Z",
  });
  check(messy.party === "Anton Perera", `control characters stripped ("${messy.party}")`);
  check(messy.direction === "payable", "an unrecognised direction becomes money we owe");
  check(messy.amount === 150_000 && messy.paid === 50_000, "numeric strings become numbers");
  check(messy.containerId === A, `container normalised (${messy.containerId})`);
  check(messy.orderNumber === "Sri Lanka Order 03", `order number tidied ("${messy.orderNumber}")`);
  check(messy.dueAt === "2026-08-20", `the due date loses its clock (${messy.dueAt})`);

  const hostile = createBalanceDue({ party: { evil: true }, amount: -99, paid: -5 });
  check(hostile.party === "", "an object cannot become a party name");
  check(hostile.amount === 0 && hostile.paid === 0, "negatives are clamped, then refused by checkBalanceDue");
  check(createBalanceDue({ party: "X", dueAt: "not a date" }).dueAt === "", "an unreadable due date becomes none");
  check(createBalanceDue({ party: "X", amount: LIMITS.money * 5 }).amount === LIMITS.money, "a runaway amount is capped");
  check(
    createBalanceDue({ party: "X", direction: "receivable" }).direction === "receivable",
    "a stated direction is kept",
  );
}

/* -------------------------------- mutation -------------------------------- */

section("Editing, settling and removing");
{
  let sheet = sample();
  const anton = sheet.balances.find((b) => b.party === "Anton")!;

  sheet = updateBalanceDue(sheet, anton.id, { paid: 150_000 });
  check(
    balanceDueStatus(sheet.balances.find((b) => b.id === anton.id)!) === "settled",
    "paying it off settles it",
  );
  check(balanceDueTotals(sheet).payableOutstanding === 60_000, "and the position follows");

  sheet = updateBalanceDue(sheet, anton.id, { containerId: "mscu 123456-5" });
  check(
    sheet.balances.find((b) => b.id === anton.id)!.containerId === "MSCU1234565",
    "an edited container is normalised",
  );
  sheet = updateBalanceDue(sheet, anton.id, { dueAt: "2027-01-05T10:00:00Z" });
  check(
    sheet.balances.find((b) => b.id === anton.id)!.dueAt === "2027-01-05",
    "and an edited due date loses its clock",
  );

  let paying = sample();
  const bala = paying.balances.find((b) => b.party === "Bala")!;
  paying = settleBalanceDue(paying, bala.id, 20_000);
  check(
    paying.balances.find((b) => b.id === bala.id)!.paid === 20_000,
    "a payment is recorded against the balance",
  );
  paying = settleBalanceDue(paying, bala.id, 999_999);
  check(
    paying.balances.find((b) => b.id === bala.id)!.paid === 60_000,
    "and a payment can never take it past the total",
  );
  check(
    settleBalanceDue(paying, "no-such-id", 100).balances.length === paying.balances.length,
    "settling an unknown id changes nothing",
  );

  let removing = sample();
  // Ids are minted per balance, so this has to come from the sheet being changed
  // rather than from another copy of the sample.
  const doomed = removing.balances.find((b) => b.party === "Bala")!;
  removing = removeBalanceDue(removing, doomed.id);
  check(removing.balances.length === 2, `removing drops one row (${removing.balances.length})`);
  check(removeBalanceDue(removing, "nope").balances.length === 2, "removing an unknown id changes nothing");

  let big = emptyBalanceSheet();
  for (let i = 0; i < MAX_ENTRIES + 3; i += 1) {
    big = addBalanceDue(big, createBalanceDue({ party: `P${i}`, amount: 1 }));
  }
  check(big.balances.length === MAX_ENTRIES, `the ledger is capped at ${MAX_ENTRIES}`);
}

/* ------------------------------- persistence ------------------------------ */

section("Saving and reloading");
{
  const sheet = sample();
  const round = parseBalanceSheet(JSON.parse(JSON.stringify(sheet)));

  check(round.balances.length === 3, `every balance survives (${round.balances.length})`);
  check(
    JSON.stringify(balanceDueTotals(round)) === JSON.stringify(balanceDueTotals(sheet)),
    "and every figure is identical afterwards",
  );
  check(
    round.balances.map((b) => b.id).join("|") === sheet.balances.map((b) => b.id).join("|"),
    "ids are preserved, so a reloaded balance can still be edited",
  );
  check(round.balances[0].dueAt === sheet.balances[0].dueAt, "due dates are preserved");

  // A document saved before balances existed.
  const old = parseBalanceSheet({
    app: "balebook-balance-sheet",
    version: 1,
    expenses: [{ name: "Freight", partner: "Anton", amount: 100 }],
    turnover: [],
  });
  check(Array.isArray(old.balances) && old.balances.length === 0, "an older document loads with an empty ledger");
  check(old.expenses.length === 1, "and keeps everything it did have");

  const mixed = parseBalanceSheet({
    balances: [
      null,
      {},
      { party: "No amount" },
      { party: "", amount: 500 },
      { party: "Free", amount: 0 },
      { party: "Keeper", amount: 100, paid: 40, dueAt: PAST },
    ],
  });
  check(
    mixed.balances.length === 1 && mixed.balances[0].party === "Keeper",
    `partyless and zero rows are dropped (${mixed.balances.length} kept)`,
  );
  check(mixed.balances[0].id.length > 0, "a row missing an id is given one");
  for (const junk of [null, 42, "nonsense", { balances: "not an array" }]) {
    check(
      parseBalanceSheet(junk).balances.length === 0,
      `${JSON.stringify(junk)} parses to an empty ledger rather than throwing`,
    );
  }
}

/* ---------------------------------- CSV ----------------------------------- */

section("CSV export");
{
  const csv = balanceToCsv(sample());
  check(
    csv.includes("Party,Direction,Total,Paid,Outstanding,Due,Container,Order number,Status"),
    "the balances block has its own heading",
  );
  check(csv.includes(`Anton,${OWE_LABEL},150000,50000,100000,${PAST},${A}`), "a row carries its figures");
  check(csv.includes(`Ahmad Trading,${OWED_LABEL},200000,20000,180000`), "including one owed to us");
  check(csv.includes("overdue"), "an overdue row is marked");
  check(csv.includes("Still to pay") && csv.includes("Still to receive"), "and the position is summarised");
  check(csv.includes("Net position"), "with a net");

  check(
    !balanceToCsv(emptyBalanceSheet()).includes("Still to pay"),
    "an empty ledger adds no balances block at all",
  );
}

/* ------------------------------- the bundle ------------------------------- */

section("The page cannot drag a spreadsheet library into the browser");
{
  // This has bitten twice: once pulling @react-pdf/renderer in through a filename
  // helper, once pulling ExcelJS in through a label. Both times a one-line import
  // added ~260 kB to a page. Walked here rather than trusted.
  const HEAVY = ["exceljs", "@react-pdf/renderer", "pdf-parse", "jszip"];

  const readSource = (path: string): string => {
    for (const candidate of [path, `${path}.ts`, `${path}.tsx`, `${path}/index.ts`]) {
      try {
        return readFileSync(candidate, "utf8");
      } catch {
        /* try the next extension */
      }
    }
    return "";
  };

  /** Every module a client file reaches, and the first path that gets to each. */
  const walk = (entry: string): Map<string, string[]> => {
    const seen = new Map<string, string[]>();
    const queue: Array<{ file: string; trail: string[] }> = [
      { file: entry, trail: [entry] },
    ];
    while (queue.length > 0) {
      const next = queue.shift()!;
      const source = readSource(next.file);
      if (source === "") continue;
      const imports = source.match(/from\s+"([^"]+)"/g) ?? [];
      for (const raw of imports) {
        const spec = /from\s+"([^"]+)"/.exec(raw)?.[1] ?? "";
        if (spec === "") continue;

        const isLocal = spec.startsWith("@/") || spec.startsWith(".");
        const resolved = spec.startsWith("@/")
          ? `src/${spec.slice(2)}`
          : spec.startsWith(".")
            ? `${next.file.replace(/\/[^/]+$/, "")}/${spec}`.replace(/\/\.\//g, "/")
            : spec;

        if (seen.has(resolved)) continue;
        seen.set(resolved, [...next.trail, resolved]);
        if (isLocal) queue.push({ file: resolved, trail: [...next.trail, resolved] });
      }
    }
    return seen;
  };

  const clientPages = readdirSync("src/app", { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "api")
    .map((e) => `src/app/${e.name}/page.tsx`)
    .concat(["src/app/page.tsx"]);

  for (const page of clientPages) {
    const reached = walk(page);
    const offenders = HEAVY.filter((lib) => reached.has(lib));
    const trail = offenders.length > 0 ? reached.get(offenders[0])!.join(" -> ") : "";
    check(
      offenders.length === 0,
      `${page} keeps every spreadsheet and PDF library on the server${trail ? ` (found: ${trail})` : ""}`,
    );
  }

  // The guard has to be able to fail, or it is decoration: the builders really do
  // import ExcelJS, and walking one must find it.
  check(
    walk("src/lib/balanceXlsx.ts").has("exceljs"),
    "and the walk does find ExcelJS where it is genuinely used",
  );
  check(
    !walk("src/lib/labels.ts").has("exceljs"),
    "while the labels module reaches nothing at all",
  );
}

/* ------------------------------ the workbook ------------------------------ */

async function fileChecks() {
  const sheet = sample();
  const dues = balanceDueTotals(sheet);
  const buffer = await buildBalanceXlsx(sheet);

  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = book.getWorksheet("Balances")!;

  const f = (ref: string): string => {
    const v = ws.getCell(ref).value as { formula?: string } | null;
    return v && typeof v === "object" && typeof v.formula === "string" ? v.formula : "";
  };
  const r = (sheetRef: ExcelJS.Worksheet, ref: string): unknown => {
    const v = sheetRef.getCell(ref).value as { result?: unknown } | null;
    return v && typeof v === "object" && "result" in v ? v.result : v;
  };

  section("Workbook: the Balances tab");
  check(ws !== undefined, "there is a Balances tab");
  check(
    [1, 2, 3, 4, 5, 6, 7, 8].map((c) => String(ws.getRow(2).getCell(c).value)).join(", ") ===
      "Party, Direction, Total, Paid, Outstanding, Due, Container, Order number",
    `with the columns in order (${[1, 2, 3, 4].map((c) => String(ws.getRow(2).getCell(c).value)).join(", ")}...)`,
  );

  // Soonest due first: Anton (2020), Ahmad (2099), Bala (undated) last.
  const order = [3, 4, 5].map((n) => String(ws.getCell(`A${n}`).value));
  check(
    order.join(" > ") === "Anton > Ahmad Trading > Bala",
    `soonest due first, undated last (${order.join(" > ")})`,
  );
  check(String(ws.getCell("B3").value) === OWE_LABEL, `direction reads in words (${String(ws.getCell("B3").value)})`);
  check(String(ws.getCell("B4").value) === OWED_LABEL, "both ways round");
  check(ws.getCell("C3").value === 150_000 && ws.getCell("D3").value === 50_000, "the typed figures are numbers");
  check(ws.getCell("F3").value instanceof Date, "a due date is a real date, so Excel can sort it");
  check(
    ws.getCell("F5").value === null || ws.getCell("F5").value === undefined,
    "and an undated balance leaves the cell empty rather than inventing one",
  );

  section("Workbook: outstanding is a formula, not a number");
  check(f("E3") === "C3-D3", `what is left is derived (${f("E3")})`);
  check(r(ws, "E3") === 100_000, `with the right cached answer (${String(r(ws, "E3"))})`);
  check(f("C6") === "SUM(C3:C5)", `the total sums exactly the entry rows (${f("C6")})`);
  check(r(ws, "E6") === 340_000, `and the outstanding total (${String(r(ws, "E6"))})`);

  section("Workbook: the position, split by direction");
  // Position block: header row 8, then Still to pay / receive / Net.
  check(String(ws.getCell("A9").value) === "Still to pay", `labelled (${String(ws.getCell("A9").value)})`);
  check(
    f("B9").startsWith(`SUMIF($B$3:$B$5,"${OWE_LABEL}"`),
    `still to pay is a SUMIF on the direction (${f("B9")})`,
  );
  check(r(ws, "B9") === dues.payableOutstanding, `cached correctly (${String(r(ws, "B9"))})`);
  check(r(ws, "B10") === dues.receivableOutstanding, "so is still to receive");
  check(f("B11") === "B10-B9", `the net is in less out (${f("B11")})`);
  check(r(ws, "B11") === dues.net, `and cached (${String(r(ws, "B11"))})`);

  section("Workbook: the position reaches the Summary tab");
  const sum = book.getWorksheet("Summary")!;
  check(String(sum.getCell("A22").value) === "Outstanding", "there is an Outstanding block");
  check(f2(sum, "B23").includes("'Balances'!"), `pointing at the Balances tab (${f2(sum, "B23")})`);
  check(r(sum, "B23") === dues.payableOutstanding, "with the right figure");
  check(r(sum, "B26") === dues.overdueAmount, `and an overdue figure (${String(r(sum, "B26"))})`);
  check(f2(sum, "B26").includes("TODAY()"), "worked out against today when the file opens");
  // The profit figures above must be untouched by any of this. Asserted on the
  // formula rather than the cached answer, because ExcelJS's reader discards a
  // cached 0 - the file carries it, the reader does not hand it back.
  check(
    f2(sum, "B9") === "B5-B6",
    `net profit is still turnover less expenses, not the ledger (${f2(sum, "B9")})`,
  );
  check(
    !f2(sum, "B6").includes("Balances"),
    `and the expense total does not reach into the balances (${f2(sum, "B6")})`,
  );

  section("Workbook: an empty ledger still exports as a form to fill in");
  const blank = await buildBalanceXlsx(emptyBalanceSheet());
  const blankBook = new ExcelJS.Workbook();
  await blankBook.xlsx.load(blank as unknown as ArrayBuffer);
  const bws = blankBook.getWorksheet("Balances")!;
  check(bws !== undefined, "the tab is there even with nothing on it");
  check(
    String(bws.getRow(2).getCell(1).value) === "Party",
    "with its headings, so balances can be typed straight in",
  );
  const blankTotal = /SUM\(C(\d+):C(\d+)\)/.exec(
    (bws.getCell("C4").value as { formula?: string })?.formula ?? "",
  );
  check(
    blankTotal !== null && Number(blankTotal[2]) < 4,
    `and its total stays outside its own SUM (${(bws.getCell("C4").value as { formula?: string })?.formula ?? "none"})`,
  );

  /* -------------------------------- importing ------------------------------- */

  section("Import: the round trip through Excel");
  const back = pickBalanceSheet(await xlsxToGrids(buffer));
  check(back.problem === undefined, `the exported file reads back (${back.problem ?? "no problem"})`);
  check(back.sheetName === "Balances", `from the Balances tab (${back.sheetName})`);
  check(back.rows.length === 3, `all three balances come back (${back.rows.length})`);
  check(
    !back.rows.some((row) => /total/i.test(row.party)),
    "and the Total row is not read as a balance",
  );
  check(
    !back.rows.some((row) => /still to|net position/i.test(row.party)),
    "nor the position block below it",
  );

  const anton = back.rows.find((row) => row.party === "Anton")!;
  check(anton.amount === 150_000 && anton.paid === 50_000, "the pair of figures survives");
  check(anton.direction === "payable", "the direction survives");
  check(anton.containerId === A, `the container survives (${anton.containerId})`);
  check(anton.dueAt === PAST, `and the due date (${anton.dueAt})`);
  const ahmad = back.rows.find((row) => row.party === "Ahmad Trading")!;
  check(ahmad.direction === "receivable", "a receivable comes back the right way round");

  const marked = markBalanceDuplicates(back.rows, sheet.balances);
  check(marked.every((row) => row.duplicate), "re-importing the same file flags every row");
  check(newBalances(marked).length === 0, "so nothing is added by accident");

  section("Import: an expenses sheet is not a ledger of debts");
  // Partner is a party and Amount is an amount, so a naive test would read every
  // expense as a debt. A distinctive balance column is required.
  const expensesGrid: unknown[][] = [
    ["Expense", "Partner", "Container", "Amount"],
    ["Customs duty", "Anton", A, 150_000],
    ["Freight", "Anton", A, 250_000],
  ];
  const refused = parseBalanceGrid(expensesGrid as never, "Expenses");
  check(refused.rows.length === 0, `nothing is imported from it (${refused.rows.length})`);
  check(
    refused.problem !== undefined && refused.problem.includes("Paid"),
    `and it says what a balances sheet needs ("${refused.problem ?? ""}")`,
  );

  // Uploading the whole workbook must still find the Balances tab, not read the
  // Expenses tab as debts.
  let withBoth = sample();
  withBoth = addExpense(
    withBoth,
    createExpense({ name: "Freight", partner: "Anton", amount: 250_000, containerId: A }),
  );
  const whole = pickBalanceSheet(await xlsxToGrids(await buildBalanceXlsx(withBoth)));
  check(whole.sheetName === "Balances", `the Balances tab is chosen (${whole.sheetName})`);
  check(
    !whole.rows.some((row) => row.amount === 250_000),
    "and the expense is not among the balances",
  );

  section("Import: the shapes a hand-typed sheet comes in");
  const shapes: unknown[][] = [
    ["Party", "Total", "Paid", "Due"],
    ["Anton", 150_000, 50_000, "2026-08-20"],
    ["Bala", 60_000, "", ""],
  ];
  const read = parseBalanceGrid(shapes as never, "Sheet1");
  check(read.rows.length === 2, `total and paid, or total alone (${read.rows.length})`);
  check(read.rows[1].paid === 0, "a blank paid figure means nothing paid yet");
  check(read.rows[0].dueAt === "2026-08-20", `a typed date is read (${read.rows[0].dueAt})`);

  const outstandingOnly: unknown[][] = [
    ["Party", "Outstanding"],
    ["Anton", "Rs 100,000.00"],
  ];
  const only = parseBalanceGrid(outstandingOnly as never, "Sheet1");
  check(only.rows.length === 1, "an outstanding column alone is enough");
  check(
    only.rows[0].amount === 100_000 && only.rows[0].paid === 0,
    `what is left becomes the whole balance (${only.rows[0].amount})`,
  );

  const named: unknown[][] = [
    ["Name of party", "Previous balance", "Direction"],
    ["Ahmad Trading", 200_000, "Owed to us"],
  ];
  const prev = parseBalanceGrid(named as never, "Sheet1");
  check(prev.rows.length === 1, `"Previous balance" is understood (${prev.rows.length})`);
  check(prev.rows[0].direction === "receivable", "and so is the direction in words");

  section("Import: directions");
  const directions: Array<[string, string]> = [
    [OWE_LABEL, "payable"],
    [OWED_LABEL, "receivable"],
    ["", "payable"],
    ["receivable", "receivable"],
    ["they owe", "receivable"],
    ["to receive", "receivable"],
    ["we owe", "payable"],
    ["payable", "payable"],
    ["nonsense", "payable"],
  ];
  for (const entry of directions) {
    check(
      readDirection(entry[0]) === entry[1],
      `"${entry[0] || "(blank)"}" -> ${readDirection(entry[0])}`,
    );
  }

  section("Import: nothing is dropped silently");
  const messy: unknown[][] = [
    ["Party", "Total", "Paid", "Due"],
    ["Good one", 1000, 200, ""],
    ["", 500, 0, ""],
    ["No amount", "", "", ""],
    ["Zero", 0, 0, ""],
    ["Credit", "(500)", 0, ""],
    ["Negative paid", 500, -50, ""],
    ["Overpaid", 500, 900, ""],
    ["Finished", 500, 500, ""],
    ["Silly", 1e15, 0, ""],
    ["Total", 4000, 0, ""],
  ];
  const messyRead = parseBalanceGrid(messy as never, "Sheet1");
  check(messyRead.rows.length === 1, `only the good row is imported (${messyRead.rows.length})`);
  check(messyRead.rows[0].party === "Good one", "and it is the right one");
  check(messyRead.skipped.length === 9, `every other row is reported (${messyRead.skipped.length})`);
  for (const row of messyRead.skipped) {
    check(row.reason.length > 0 && row.row > 0, `row ${row.row}: "${row.reason}"`);
  }
  const reasons = messyRead.skipped.map((s) => s.reason).join(" | ");
  check(reasons.includes("credit"), "a bracketed figure is called a credit");
  check(reasons.includes("already settled"), "a finished balance is called settled, not dropped quietly");
  check(reasons.includes("more has been paid"), "and an overpayment is named as the contradiction it is");

  section("Import: duplicates are counted, not merely matched");
  let twice = emptyBalanceSheet();
  twice = addBalanceDue(twice, createBalanceDue({ party: "Anton", amount: 5_000, containerId: A }));
  const rows: ImportedBalance[] = [1, 2].map((n) => ({
    party: "Anton",
    direction: "payable" as const,
    amount: 5_000,
    paid: 0,
    containerId: A,
    orderNumber: "",
    dueAt: "",
    row: n + 2,
    duplicate: false,
  }));
  const dupes = markBalanceDuplicates(rows, twice.balances);
  check(dupes[0].duplicate, "the first matches what is already there");
  check(!dupes[1].duplicate, "the second is genuinely new");

  const partPaid = markBalanceDuplicates(
    [{ ...rows[0], paid: 2_000 }],
    twice.balances,
  );
  check(
    partPaid[0].duplicate,
    "the same balance part-paid to a different degree is still the same balance",
  );

  section("Import: adding to the ledger");
  const before = balanceDueTotals(sample());
  const added = addImportedBalances(sample(), read.rows, "Balances.xlsx");
  check(added.added === 2, `both rows are added (${added.added})`);
  check(added.dropped === 0, "and none dropped");
  check(added.sheet.balances.length === 5, `the ledger grows (${added.sheet.balances.length})`);
  check(
    balanceDueTotals(added.sheet).payableOutstanding === before.payableOutstanding + 160_000,
    `and the position follows (${balanceDueTotals(added.sheet).payableOutstanding})`,
  );
  check(
    added.sheet.balances[0].note.includes("Balances.xlsx"),
    `an imported row records where it came from (${added.sheet.balances[0].note})`,
  );
  check(sample().balances.length === 3, "importing leaves the sheet it was given alone");

  let packed = emptyBalanceSheet();
  packed = {
    ...packed,
    balances: Array.from({ length: MAX_ENTRIES - 1 }, (_, i) =>
      createBalanceDue({ party: `P${i}`, amount: 1 }),
    ),
  };
  const overflow = addImportedBalances(packed, read.rows);
  check(overflow.added === 1 && overflow.dropped === 1, `the cap is reported (${overflow.added}/${overflow.dropped})`);

  /* --------------------------------- route --------------------------------- */

  section("Import: the upload route");
  const upload = async (name: string, body: Buffer | string, scope = "balances") => {
    const form = new FormData();
    form.append("file", new File([body as unknown as BlobPart], name));
    form.append("scope", scope);
    return balanceImportPost(
      new Request("http://localhost/api/balance-import", {
        method: "POST",
        body: form,
      }) as unknown as NextRequest,
    );
  };

  const ok = await upload("Balance Sheet.xlsx", buffer);
  check(ok.status === 200, `an exported workbook is accepted (${ok.status})`);
  const okBody = (await ok.json()) as { rows?: ImportedBalance[]; scope?: string; sheetName?: string };
  check(okBody.rows?.length === 3, `with its three balances (${okBody.rows?.length})`);
  check(okBody.scope === "balances", "and the reply says which kind it read");
  check(okBody.sheetName === "Balances", "from the right tab");

  const csvUpload = await upload(
    "previous.csv",
    "Party,Total,Paid,Due\nAnton,150000,50000,2026-08-20\nAhmad Trading,200000,0,\n",
  );
  check(csvUpload.status === 200, `a CSV of previous balances is accepted (${csvUpload.status})`);
  check(((await csvUpload.json()) as { rows?: unknown[] }).rows?.length === 2, "with both rows");

  const wrongKind = await upload(
    "expenses.csv",
    "Expense,Partner,Container,Amount\nCustoms duty,Anton,GAOU7441740,150000\n",
  );
  check(wrongKind.status === 422, `an expenses sheet is refused as balances (${wrongKind.status})`);
  check(
    (((await wrongKind.json()) as { error?: string }).error ?? "").length > 20,
    "with an explanation rather than a bare failure",
  );

  // The same file, read as expenses, must still work: the scope is what decides.
  const asExpenses = await upload(
    "expenses.csv",
    "Expense,Partner,Container,Amount\nCustoms duty,Anton,GAOU7441740,150000\n",
    "expenses",
  );
  check(asExpenses.status === 200, `and is accepted when read as expenses (${asExpenses.status})`);

  const xls = await upload("old.xls", "anything");
  check(xls.status === 400, `an .xls file is refused (${xls.status})`);
  const noFile = await balanceImportPost(
    new Request("http://localhost/api/balance-import", {
      method: "POST",
      body: new FormData(),
    }) as unknown as NextRequest,
  );
  check(noFile.status === 400, `a request with no file is refused (${noFile.status})`);

  /* ------------------------- the balances-only file ------------------------- */

  section("Balances on their own: a chase-list");
  const onlyBuf = await buildBalancesXlsx(sheet);
  const onlyBook = new ExcelJS.Workbook();
  await onlyBook.xlsx.load(onlyBuf as unknown as ArrayBuffer);

  check(onlyBook.worksheets.length === 1, `one tab, not six (${onlyBook.worksheets.length})`);
  const ows = onlyBook.getWorksheet("Balances")!;
  check(ows !== undefined, "and it is called Balances");
  check(
    [1, 2, 3, 4, 5, 6, 7].map((c) => String(ows.getRow(2).getCell(c).value)).join(", ") ===
      "Party, Direction, Total, Paid, Outstanding, Due, Status",
    `with a Status column of its own (${[5, 6, 7].map((c) => String(ows.getRow(2).getCell(c).value)).join(", ")})`,
  );

  // Money we owe first, soonest due at the top, undated last.
  const chase = [3, 4, 5].map(
    (n) => `${String(ows.getCell(`A${n}`).value)}/${String(ows.getCell(`B${n}`).value)}`,
  );
  check(
    chase.join(" > ") === `Anton/${OWE_LABEL} > Bala/${OWE_LABEL} > Ahmad Trading/${OWED_LABEL}`,
    `what we owe first, then what is owed to us (${chase.join(" > ")})`,
  );

  section("Balances on their own: every derived figure is a formula");
  check(f2(ows, "E3") === "C3-D3", `outstanding is derived (${f2(ows, "E3")})`);
  check(r(ows, "E3") === 100_000, "with the right cached answer");
  check(
    f2(ows, "G3").startsWith('IF(E3=0,"settled"'),
    `status is derived, so it cannot go stale (${f2(ows, "G3")})`,
  );
  check(
    f2(ows, "G3").includes("TODAY()"),
    "and overdue is worked out against the day the file is opened",
  );
  check(r(ows, "G3") === "overdue", `an overdue row says so (${String(r(ows, "G3"))})`);
  // Row 4 is Bala: we owe her, nothing paid, no due date.
  check(r(ows, "G4") === "unpaid", `an untouched one says unpaid (${String(r(ows, "G4"))})`);
  check(r(ows, "G5") === "part-paid", `a part-paid one says so (${String(r(ows, "G5"))})`);
  check(f2(ows, "E6") === "SUM(E3:E5)", `the total sums the entry rows (${f2(ows, "E6")})`);
  check(r(ows, "E6") === 340_000, "and is cached correctly");

  // Position block: header row 8, rows 9-11. Party block: header 13.
  check(String(ows.getCell("A9").value) === "Still to pay", "the position is worked out");
  check(r(ows, "B9") === dues.payableOutstanding, `still to pay (${String(r(ows, "B9"))})`);
  check(r(ows, "B11") === dues.net, `net position (${String(r(ows, "B11"))})`);
  check(String(ows.getCell("A13").value) === "Party", "and there is a per-party block");
  check(
    f2(ows, "B14").startsWith("SUMIFS("),
    `split by party and direction, so a party who is both owed and owing reads honestly (${f2(ows, "B14")})`,
  );

  section("Balances on their own: no trading figures leak in");
  // The file is a position. Turnover, expenses and profit have no business here.
  let trading = sample();
  trading = addTurnover(trading, createTurnover({ containerId: A, turnover: 1_234_567 }));
  trading = addExpense(
    trading,
    createExpense({ name: "Freight", partner: "Anton", amount: 987_654, containerId: A }),
  );
  const tradingBook = new ExcelJS.Workbook();
  await tradingBook.xlsx.load(
    (await buildBalancesXlsx(trading)) as unknown as ArrayBuffer,
  );
  const tws = tradingBook.getWorksheet("Balances")!;
  const numbers: number[] = [];
  const texts: string[] = [];
  tws.eachRow({ includeEmpty: true }, (row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      const v = cell.value as unknown;
      if (typeof v === "number") numbers.push(v);
      else if (typeof v === "string") texts.push(v);
      else if (v && typeof v === "object") {
        const obj = v as { result?: unknown };
        if (typeof obj.result === "number") numbers.push(obj.result);
      }
    });
  });
  check(tradingBook.worksheets.length === 1, "still one tab with trading on the sheet");
  check(!numbers.includes(1_234_567), "no turnover figure appears");
  check(!numbers.includes(987_654), "no expense figure appears");
  // Checked on the headings and row labels rather than every string on the sheet:
  // the note at the bottom explains that no profit appears here, so it naturally
  // contains the very words being searched for.
  const labels: string[] = [];
  tws.getRow(2).eachCell({ includeEmpty: true }, (cell) => {
    if (typeof cell.value === "string") labels.push(cell.value);
  });
  tws.eachRow({ includeEmpty: true }, (row, n) => {
    const first = row.getCell(1).value;
    // The note is merged across the row; everything above it is a real label.
    if (typeof first === "string" && first.length < 40 && n > 1) labels.push(first);
  });
  check(
    labels.length > 5 && !labels.some((t) => /turnover|profit|margin/i.test(t)),
    `no column or row is labelled turnover, profit or margin (${labels.length} labels checked)`,
  );
  check(
    labels.includes("Outstanding") && labels.includes("Still to pay"),
    "while the labels that should be there are",
  );

  section("Balances on their own: it can be uploaded back");
  const reread = pickBalanceSheet(await xlsxToGrids(onlyBuf));
  check(reread.problem === undefined, `the file reads back (${reread.problem ?? "no problem"})`);
  check(reread.rows.length === 3, `all three balances return (${reread.rows.length})`);
  check(
    !reread.rows.some((row) => /total|still to|net position/i.test(row.party)),
    "with none of the summary rows read as balances",
  );
  const backAnton = reread.rows.find((row) => row.party === "Anton")!;
  check(
    backAnton.amount === 150_000 && backAnton.paid === 50_000 && backAnton.dueAt === PAST,
    "and their figures intact",
  );
  check(
    markBalanceDuplicates(reread.rows, sheet.balances).every((row) => row.duplicate),
    "so a re-upload adds nothing by accident",
  );

  section("Balances on their own: an empty ledger");
  const emptyOnly = await buildBalancesXlsx(emptyBalanceSheet());
  const emptyBook = new ExcelJS.Workbook();
  await emptyBook.xlsx.load(emptyOnly as unknown as ArrayBuffer);
  const ews = emptyBook.getWorksheet("Balances")!;
  check(ews !== undefined, "still exports, as a form to fill in");
  const emptyTotal = f2(ews, "E4");
  const range = /SUM\(E(\d+):E(\d+)\)/.exec(emptyTotal);
  check(
    range !== null && Number(range[2]) < 4,
    `with its total outside its own SUM (${emptyTotal})`,
  );

  section("Balances on their own: the route and the file name");
  const exportRes = await balanceExportPost(
    new Request("http://localhost/api/balance-export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "balances", sheet }),
    }) as unknown as NextRequest,
  );
  check(exportRes.status === 200, `the route serves it (${exportRes.status})`);
  const disposition = exportRes.headers.get("Content-Disposition") ?? "";
  check(
    disposition.includes("Balances to be paid"),
    `named for what it is (${disposition})`,
  );
  check(
    !disposition.includes("Expenses") && !disposition.includes("Balance Sheet "),
    "and cannot be mistaken for either of the other two exports",
  );
  const servedBook = new ExcelJS.Workbook();
  await servedBook.xlsx.load(await exportRes.arrayBuffer());
  check(servedBook.worksheets.length === 1, "with one tab");

  const emptyExport = await balanceExportPost(
    new Request("http://localhost/api/balance-export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "balances", sheet: emptyBalanceSheet() }),
    }) as unknown as NextRequest,
  );
  check(emptyExport.status === 400, `an empty ledger is refused (${emptyExport.status})`);
  check(
    (((await emptyExport.json()) as { error?: string }).error ?? "").includes("balances"),
    "saying it is the balances that are missing",
  );

  const name = balancesFilename("xlsx", new Date("2026-08-09T10:00:00Z"));
  check(
    name === "Balances to be paid 2026-08-09 1000.xlsx",
    `dated and timed (${name})`,
  );

  mkdirSync(".verify", { recursive: true });
  writeFileSync(".verify/balances.csv", balanceToCsv(sample()));
  writeFileSync(".verify/balances.xlsx", buffer);
  writeFileSync(".verify/balances-only.xlsx", onlyBuf);

  if (failures > 0) {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nALL BALANCE-DUE CHECKS PASSED");
}

/** A formula off any worksheet. */
function f2(ws: ExcelJS.Worksheet, ref: string): string {
  const v = ws.getCell(ref).value as { formula?: string } | null;
  return v && typeof v === "object" && typeof v.formula === "string" ? v.formula : "";
}

fileChecks();

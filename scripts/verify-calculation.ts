/**
 * Verifies the markup calculation:
 *  - the markup is the profit, and every figure derived from it adds up
 *  - changing the markup applied across the board leaves per-item markups alone,
 *    which is the whole point of recording that they were set by hand
 *  - fast movers can be repriced as a group, and the split follows
 *  - a request list produced by this app can be uploaded and read cleanly, item
 *    names included
 *  - the spreadsheet re-prices the order when a markup is edited in Excel
 *  - AND, above all: no cost, markup or profit figure reaches any document that
 *    gets sent to a buyer or an investor
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";
import type { NextRequest } from "next/server";
import {
  calcTotals,
  createCalcRow,
  emptyCalcDoc,
  fromOrderItems,
  lineCost,
  lineProfit,
  lineTotal,
  loadCalcDoc,
  parseCalcDoc,
  removeCalcRow,
  resetAllMarkups,
  resetRowMarkup,
  sellingPerBag,
  setBaseMarkup,
  setFastMarkup,
  setOrderNumber,
  setRowMarkup,
  toggleFast,
  updateCalcRow,
  DEFAULT_MARKUP,
  MAX_ROWS,
  type CalcDoc,
} from "../src/lib/calculation";
import { buildCalculationXlsx } from "../src/lib/calculationXlsx";
import { FAST_LABEL, STEADY_LABEL } from "../src/lib/labels";
import { buildBuyerPriceList, LIMITS } from "../src/lib/types";
import { renderBuyerPdf } from "../src/lib/buyerPdf";
import { parseOrderPdf } from "../src/lib/parseOrder";
import { POST as calculationExportPost } from "../src/app/api/calculation-export/route";

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

const ITEMS = [
  { name: "3/4 Ladies Jeans", qty: 14, perBag: 37_000 },
  { name: "Anorak", qty: 21, perBag: 24_000 },
  { name: "Anorak #2", qty: 9, perBag: 19_000 },
  { name: "Cotton Scarf", qty: 6, perBag: 12_000 },
];

function sample(): CalcDoc {
  return fromOrderItems(ITEMS, 2_000, "Sri Lanka Order 03");
}

/* ------------------------------- the numbers ------------------------------- */

section("The markup is the profit");
{
  const doc = sample();
  check(doc.rows.length === 4, `every item is priced (${doc.rows.length})`);
  check(
    doc.rows.every((row) => row.markup === 2_000 && !row.overridden),
    "and starts on the figure applied across the board, untouched",
  );

  const jeans = doc.rows[0];
  check(sellingPerBag(jeans) === 39_000, `selling is cost plus markup (${sellingPerBag(jeans)})`);
  check(lineCost(jeans) === 518_000, `what the line costs (${lineCost(jeans)})`);
  check(lineTotal(jeans) === 546_000, `what it sells for (${lineTotal(jeans)})`);
  check(lineProfit(jeans) === 28_000, `and what it earns: bags times markup (${lineProfit(jeans)})`);

  const t = calcTotals(doc);
  check(t.bags === 50, `bags (${t.bags})`);
  check(t.cost === 1_265_000, `cost (${t.cost})`);
  check(t.profit === 100_000, `profit is every bag's markup (${t.profit})`);
  check(t.selling === 1_365_000, `what it all sells for (${t.selling})`);
  check(t.cost + t.profit === t.selling, "and cost plus profit is exactly the sale");
  check(t.averageMarkup === 2_000, `markup a bag (${t.averageMarkup})`);
  check(
    t.margin !== null && Math.abs(t.margin - (100_000 / 1_365_000) * 100) < 1e-9,
    `profit as a share of the sale (${t.margin})`,
  );

  const empty = calcTotals(emptyCalcDoc());
  check(
    empty.bags === 0 && empty.profit === 0,
    "an empty calculation totals zero rather than NaN",
  );
  check(empty.averageMarkup === null, "with no markup per bag to report");
  check(empty.margin === null, "and no share of a sale that does not exist");
}

section("A markup set by hand survives a change to the base");
{
  // The rule the whole model is built around: nudging the figure applied across
  // the board must not undo an afternoon of per-item decisions.
  let doc = sample();
  const anorak = doc.rows[1];
  doc = setRowMarkup(doc, anorak.id, 5_000);

  const edited = doc.rows.find((r) => r.id === anorak.id)!;
  check(edited.markup === 5_000, "the item takes its own markup");
  check(edited.overridden, "and is remembered as set by hand");
  check(calcTotals(doc).overridden === 1, "one item is overridden");

  doc = setBaseMarkup(doc, 3_000);
  check(doc.baseMarkup === 3_000, "the base changes");
  check(
    doc.rows.find((r) => r.id === anorak.id)!.markup === 5_000,
    "the overridden item keeps what it was given",
  );
  check(
    doc.rows.filter((r) => !r.overridden).every((r) => r.markup === 3_000),
    "every other item follows the new base",
  );
  check(
    calcTotals(doc).profit === 14 * 3_000 + 21 * 5_000 + 9 * 3_000 + 6 * 3_000,
    `and the profit reflects the mixture (${calcTotals(doc).profit})`,
  );

  // Putting one back, and putting everything back.
  const back = resetRowMarkup(doc, anorak.id);
  check(
    back.rows.find((r) => r.id === anorak.id)!.markup === 3_000,
    "an item can be handed back to the base",
  );
  check(!back.rows.find((r) => r.id === anorak.id)!.overridden, "and stops being overridden");

  const all = resetAllMarkups(doc);
  check(
    all.rows.every((r) => r.markup === 3_000 && !r.overridden),
    "or everything can be put back at once",
  );
  check(calcTotals(all).profit === 50 * 3_000, `which is a flat markup again (${calcTotals(all).profit})`);
}

section("Fast movers are priced as a group");
{
  let doc = sample();
  doc = toggleFast(doc, doc.rows[1].id);
  doc = toggleFast(doc, doc.rows[3].id);
  check(doc.rows.filter((r) => r.fast).length === 2, "two items are marked fast moving");

  doc = setFastMarkup(doc, 6_000);
  check(
    doc.rows[1].markup === 6_000 && doc.rows[3].markup === 6_000,
    "both take the fast markup",
  );
  check(
    doc.rows[1].overridden && doc.rows[3].overridden,
    "and count as set by hand, so the base cannot undo them",
  );
  check(doc.rows[0].markup === 2_000, "the steady items are untouched");

  const t = calcTotals(doc);
  check(t.fastBags === 27, `fast-moving bags (${t.fastBags})`);
  check(t.fastProfit === 21 * 6_000 + 6 * 6_000, `fast-moving profit (${t.fastProfit})`);
  check(t.normalBags === 23, `steady bags (${t.normalBags})`);
  check(t.normalProfit === 14 * 2_000 + 9 * 2_000, `steady profit (${t.normalProfit})`);
  check(
    t.fastBags + t.normalBags === t.bags && t.fastProfit + t.normalProfit === t.profit,
    "and the two halves account for the whole order",
  );

  doc = toggleFast(doc, doc.rows[1].id);
  check(!doc.rows[1].fast, "an item can stop being fast moving");
  check(
    calcTotals(doc).fastBags === 6,
    `and the split re-counts (${calcTotals(doc).fastBags})`,
  );
}

section("Editing and removing");
{
  let doc = sample();
  doc = updateCalcRow(doc, doc.rows[0].id, { qty: 20, costPerBag: 40_000 });
  check(doc.rows[0].qty === 20 && doc.rows[0].costPerBag === 40_000, "bags and cost can be corrected");
  check(lineProfit(doc.rows[0]) === 40_000, `and the profit follows the bags (${lineProfit(doc.rows[0])})`);

  doc = updateCalcRow(doc, doc.rows[0].id, { qty: 7.8 });
  check(doc.rows[0].qty === 7, `bags stay whole things (${doc.rows[0].qty})`);

  doc = setOrderNumber(doc, "  Sri Lanka   Order 04 ");
  check(doc.orderNumber === "Sri Lanka Order 04", `the order number is tidied (${doc.orderNumber})`);

  const before = doc.rows.length;
  doc = removeCalcRow(doc, doc.rows[0].id);
  check(doc.rows.length === before - 1, "an item can be taken out");
  check(removeCalcRow(doc, "nope").rows.length === doc.rows.length, "removing an unknown id changes nothing");
}

section("What gets stored is sanitised");
{
  const messy = createCalcRow({
    name: "  Anorak\u0000  #2  ",
    qty: "21",
    costPerBag: "24000",
    markup: -500,
  });
  check(messy.name === "Anorak #2", `names are tidied ("${messy.name}")`);
  check(messy.qty === 21 && messy.costPerBag === 24_000, "numeric strings become numbers");
  check(messy.markup === 0, "a negative markup is clamped to nothing");
  check(!messy.overridden && !messy.fast, "and flags default to off");

  check(
    createCalcRow({ name: "X", qty: 1, markup: LIMITS.markup * 5 }).markup === LIMITS.markup,
    "a runaway markup is capped",
  );
  check(createCalcRow({ name: { evil: true }, qty: 1 }).name === "", "an object cannot become a name");

  const dropped = fromOrderItems(
    [
      { name: "Good", qty: 5, perBag: 100 },
      { name: "", qty: 5, perBag: 100 },
      { name: "No bags", qty: 0, perBag: 100 },
    ],
    1_000,
  );
  check(dropped.rows.length === 1, `nameless and bagless lines are dropped (${dropped.rows.length})`);
}

section("Saving and reloading");
{
  let doc = sample();
  doc = setRowMarkup(doc, doc.rows[1].id, 5_000);
  doc = toggleFast(doc, doc.rows[1].id);

  const round = parseCalcDoc(JSON.parse(JSON.stringify(doc)));
  check(round.rows.length === 4, "every row survives");
  check(round.baseMarkup === doc.baseMarkup, "so does the base markup");
  check(round.orderNumber === doc.orderNumber, "and the order number");
  check(
    round.rows[1].markup === 5_000 && round.rows[1].overridden && round.rows[1].fast,
    "and a hand-set, fast-moving item keeps all three facts",
  );
  check(
    JSON.stringify(calcTotals(round)) === JSON.stringify(calcTotals(doc)),
    "so every figure is identical afterwards",
  );
  check(
    round.rows.map((r) => r.id).join("|") === doc.rows.map((r) => r.id).join("|"),
    "ids are preserved, so a reloaded row can still be edited",
  );

  for (const junk of [null, 42, "nonsense", { rows: "not an array" }]) {
    const parsed = parseCalcDoc(junk);
    check(
      parsed.rows.length === 0 && parsed.baseMarkup === DEFAULT_MARKUP,
      `${JSON.stringify(junk)} parses to an empty calculation rather than throwing`,
    );
  }
  check(loadCalcDoc().rows.length === 0, "loading outside a browser gives an empty one");

  let big = emptyCalcDoc();
  big = {
    ...big,
    rows: Array.from({ length: MAX_ROWS + 5 }, (_, i) =>
      createCalcRow({ name: `I${i}`, qty: 1, costPerBag: 1 }),
    ),
  };
  check(parseCalcDoc(big).rows.length === MAX_ROWS, `the list is capped at ${MAX_ROWS}`);
}

/* --------------------- nothing leaks into shared documents ------------------ */

section("The markup cannot reach anything that gets sent out");
{
  // Structural, and the strongest guarantee available: if no other module reads
  // the calculation, its figures cannot appear in another document by accident.
  const readSource = (path: string): string => {
    for (const candidate of [path, `${path}.ts`, `${path}.tsx`]) {
      try {
        return readFileSync(candidate, "utf8");
      } catch {
        /* try the next extension */
      }
    }
    return "";
  };

  const libs = readdirSync("src/lib").filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
  const readers: string[] = [];
  for (const file of libs) {
    if (file.startsWith("calculation")) continue;
    const source = readSource(`src/lib/${file}`);
    if (/from\s+"\.\/calculation/.test(source)) readers.push(`src/lib/${file}`);
  }
  check(
    readers.length === 0,
    `no other library reads the calculation (${readers.join(", ") || "none do"})`,
  );

  // The same for every page and route except its own.
  const pages: string[] = [];
  const walkDir = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walkDir(full);
      else if (/\.tsx?$/.test(entry.name)) pages.push(full);
    }
  };
  walkDir("src/app");
  const outsideReaders = pages.filter((file) => {
    if (file.includes("/calculation")) return false;
    return /from\s+"@\/lib\/calculation/.test(readSource(file));
  });
  check(
    outsideReaders.length === 0,
    `and no page or route outside /calculation does either (${outsideReaders.join(", ") || "none do"})`,
  );

  // The guard must be able to fail: the calculation's own files do read it.
  check(
    /from\s+"@\/lib\/calculation/.test(readSource("src/app/calculation/page.tsx")),
    "while the calculation page itself does, so the check is looking properly",
  );

  // And no shared document even mentions a markup.
  const shared = [
    "src/lib/buyerPdf.tsx",
    "src/lib/bagManifestPdf.tsx",
    "src/lib/bagManifestXlsx.ts",
    "src/lib/requestPdf.tsx",
    "src/lib/balanceXlsx.ts",
    "src/lib/expensesXlsx.ts",
    "src/lib/balancesXlsx.ts",
  ];
  for (const file of shared) {
    const source = readSource(file);
    check(
      source !== "" && !/markup/i.test(source),
      `${file.replace("src/lib/", "")} never mentions a markup`,
    );
  }
}

/* --------------------------------- the file -------------------------------- */

async function fileChecks() {
  const doc0 = sample();
  let doc = setRowMarkup(doc0, doc0.rows[1].id, 5_000);
  doc = toggleFast(doc, doc.rows[1].id);
  const totals = calcTotals(doc);
  const buffer = await buildCalculationXlsx(doc);

  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = book.getWorksheet("Calculation")!;
  const f = (ref: string): string => {
    const v = ws.getCell(ref).value as { formula?: string } | null;
    return v && typeof v === "object" && typeof v.formula === "string" ? v.formula : "";
  };
  const r = (ref: string): unknown => {
    const v = ws.getCell(ref).value as { result?: unknown } | null;
    return v && typeof v === "object" && "result" in v ? v.result : v;
  };

  section("The spreadsheet");
  check(book.worksheets.length === 1, `one tab (${book.worksheets.length})`);
  check(
    [1, 2, 3, 4, 5, 6, 7, 8].map((c) => String(ws.getRow(2).getCell(c).value)).join(", ") ===
      "Item, Bags, Cost / bag, Markup / bag, Selling / bag, Line total, Profit, Moves",
    `with the columns in order (${[3, 4, 5].map((c) => String(ws.getRow(2).getCell(c).value)).join(", ")})`,
  );
  check(
    String(ws.getCell("A1").value).includes("Sri Lanka Order 03"),
    `titled with the order (${String(ws.getCell("A1").value)})`,
  );
  check(
    String(ws.getCell("G1").value).startsWith("Internal"),
    `and marked internal on the sheet (${String(ws.getCell("G1").value)})`,
  );

  section("The spreadsheet re-prices when a markup is edited");
  check(ws.getCell("B3").value === 14, "bags are typed");
  check(ws.getCell("C3").value === 37_000, "cost is typed");
  check(ws.getCell("D3").value === 2_000, "markup is typed");
  check(f("E3") === "C3+D3", `selling is derived (${f("E3")})`);
  check(f("F3") === "B3*E3", `the line total is derived (${f("F3")})`);
  check(f("G3") === "B3*D3", `and the profit is bags times markup (${f("G3")})`);
  check(
    r("E3") === 39_000 && r("F3") === 546_000 && r("G3") === 28_000,
    "with the right cached answers",
  );
  check(
    f(`B${3 + doc.rows.length}`) === `SUM(B3:B${2 + doc.rows.length})`,
    `bags are summed (${f(`B${3 + doc.rows.length}`)})`,
  );

  // Summary block: header on row 9, figures 10-14 for four items.
  check(String(ws.getCell("A10").value) === "What the bags cost us", "the summary is labelled plainly");
  check(
    f("B11") === "SUM($G$3:$G$6)",
    `the profit sums the profit column (${f("B11")})`,
  );
  check(r("B11") === totals.profit, `cached correctly (${String(r("B11"))})`);
  check(f("B12") === "B10+B11", `what it sells for is cost plus profit (${f("B12")})`);
  check(r("B12") === totals.selling, "and cached");

  section("The fast/steady split follows the labels");
  check(String(ws.getCell("H3").value) === STEADY_LABEL, `a steady item is labelled (${String(ws.getCell("H3").value)})`);
  check(String(ws.getCell("H4").value) === FAST_LABEL, "and a fast one");
  check(String(ws.getCell("A17").value) === FAST_LABEL, "the split names the fast movers");
  check(
    f("B17") === "SUMIF($H$3:$H$6,$A17,$B$3:$B$6)",
    `bags come from a SUMIF on the label, so reclassifying re-counts (${f("B17")})`,
  );
  // The bug this guards against: summing the Line total column instead of the
  // Profit column. The cached answers looked right while the formulas did not.
  check(
    f("C17") === "SUMIF($H$3:$H$6,$A17,$G$3:$G$6)",
    `and the profit comes from the profit column, not the line totals (${f("C17")})`,
  );
  check(r("C17") === totals.fastProfit, `fast profit (${String(r("C17"))})`);
  check(r("C18") === totals.normalProfit, `steady profit (${String(r("C18"))})`);

  section("An empty calculation still produces a usable form");
  const blank = await buildCalculationXlsx(emptyCalcDoc());
  const blankBook = new ExcelJS.Workbook();
  await blankBook.xlsx.load(blank as unknown as ArrayBuffer);
  const bws = blankBook.getWorksheet("Calculation")!;
  check(String(bws.getRow(2).getCell(1).value) === "Item", "the headings are there");
  const blankTotal = (bws.getCell("B4").value as { formula?: string })?.formula ?? "";
  const range = /SUM\(B(\d+):B(\d+)\)/.exec(blankTotal);
  check(
    range !== null && Number(range[2]) < 4,
    `and the total stays outside its own SUM (${blankTotal || "none"})`,
  );

  /* ----------------------- the buyer's copy stays clean ---------------------- */

  section("None of it reaches the buyer's price list");
  // Built from the same items with the same markup, then read back as text. The
  // buyer should see one price per bag - the selling price - and no sign of what
  // it cost us or what we made.
  const priceList = buildBuyerPriceList(
    { title: "Sri Lanka Order 03", items: ITEMS },
    2_000,
  );
  const pdf = await renderBuyerPdf(priceList, {
    buyer: { name: "Ahmad Trading", phone: "0771234567" },
    refNo: "BB-3F7K-260817-001",
  });
  const text = String((await pdfParse(pdf, { version: "v2.0.550" })).text);

  check(text.includes("Sri Lanka Order 03"), "the order is named on it");
  check(text.includes("39,000"), "the buyer sees the selling price");
  check(!text.includes("37,000"), "but not what the bag cost us");
  check(!text.includes("2,000.00"), "nor the markup added to it");
  check(!/markup/i.test(text), "the word markup does not appear");
  check(!/profit/i.test(text), "neither does profit");
  check(!/\bcost\b/i.test(text), "nor cost");
  check(
    !text.includes(String(totals.profit).slice(0, 3)) || !/profit/i.test(text),
    "and no total profit figure is presented as one",
  );

  /* --------------------------- a request list reads in ---------------------- */

  section("A request list from this app uploads cleanly");
  // The layout differs from a supplier sheet: three counts sit between the item
  // name and the money, and reading it as a supplier row leaves them stuck to the
  // name ("Anorak210"), which would make the calculation useless.
  const { renderRequestPdf } = await import("../src/lib/requestPdf");
  const { toRequestItems } = await import("../src/lib/buyerRequest");
  const requestPdf = await renderRequestPdf({
    buyerName: "Ahmad Trading",
    buyerPhone: "0771234567",
    items: toRequestItems([
      { name: "3/4 Ladies Jeans", qty: 14, perBag: 37_000, supplied: 5 },
      { name: "Anorak", qty: 21, perBag: 24_000 },
      { name: "Anorak #2", qty: 9, perBag: 19_000, supplied: 4 },
      { name: "Blanket 3", qty: 12, perBag: 15_000 },
    ]),
    subtitle: "Sri Lanka Order 3 2026",
  });
  const readBack = await parseOrderPdf(requestPdf);

  check(readBack.items.length === 4, `every requested item is read (${readBack.items.length})`);
  const names = readBack.items.map((i) => i.name);
  check(
    names.join(" | ") === "3/4 Ladies Jeans | Anorak | Anorak #2 | Blanket 3",
    `with clean names, digits and all (${names.join(" | ")})`,
  );
  check(
    !names.some((n) => /\d{3,}$/.test(n)),
    "and no bag counts left stuck to the end of a name",
  );
  const wanted = readBack.items.map((i) => i.qty);
  check(
    wanted.join(",") === "14,21,9,12",
    `the bags read are the bags asked for, not what is left to send (${wanted.join(",")})`,
  );
  check(
    readBack.items.map((i) => i.perBag).join(",") === "37000,24000,19000,15000",
    "and the price we pay comes through",
  );

  const fromRequest = fromOrderItems(readBack.items, 2_500, "Sri Lanka Order 03");
  check(fromRequest.rows.length === 4, "so a calculation can be built straight from it");
  check(
    calcTotals(fromRequest).bags === 56 && calcTotals(fromRequest).profit === 140_000,
    `with the right bags and profit (${calcTotals(fromRequest).bags} bags, ${calcTotals(fromRequest).profit})`,
  );

  /* --------------------------------- route ---------------------------------- */

  section("The download route");
  const post = (body: unknown) =>
    calculationExportPost(
      new Request("http://localhost/api/calculation-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }) as unknown as NextRequest,
    );

  const ok = await post({ doc });
  check(ok.status === 200, `the spreadsheet is served (${ok.status})`);
  const disposition = ok.headers.get("Content-Disposition") ?? "";
  check(
    disposition.includes("Markup Calculation INTERNAL"),
    `named so a wrong attachment is caught by eye (${disposition})`,
  );
  check(
    disposition.includes("Sri Lanka Order 03"),
    "and carries the order number",
  );
  const servedBook = new ExcelJS.Workbook();
  await servedBook.xlsx.load(await ok.arrayBuffer());
  check(servedBook.worksheets.length === 1, "with one tab");

  const empty = await post({ doc: emptyCalcDoc() });
  check(empty.status === 400, `an empty calculation is refused (${empty.status})`);
  check(
    (((await empty.json()) as { error?: string }).error ?? "").length > 10,
    "with a reason",
  );
  for (const junk of [null, 42, "nonsense"]) {
    const res = await post(junk);
    check(
      res.status === 400,
      `${JSON.stringify(junk)} is refused rather than crashing the route (${res.status})`,
    );
  }

  mkdirSync(".verify", { recursive: true });
  writeFileSync(".verify/calculation.xlsx", buffer);

  if (failures > 0) {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nALL CALCULATION CHECKS PASSED");
}

fileChecks();

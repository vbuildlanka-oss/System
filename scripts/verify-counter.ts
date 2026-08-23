/**
 * Verifies the warehouse count:
 *  - every count starts at zero and can never go below it
 *  - a count of zero and a count never taken are kept apart, so an unfinished
 *    count cannot be read as a complete one
 *  - searching puts the item you typed first, since Enter tallies that one
 *  - an item found on the floor can be added, and never added twice
 *  - the sheet states short, over or matched with formulas, so correcting a
 *    figure in Excel re-states it
 *  - no price from the uploaded buyer list reaches the count sheet
 */
import { mkdirSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";
import type { NextRequest } from "next/server";
import {
  addItem,
  addToCount,
  bestMatch,
  clearCount,
  countFilename,
  countStatus,
  countTotals,
  createCountRow,
  difference,
  emptyCountDoc,
  fromOrderItems,
  isCountComplete,
  loadCountDoc,
  parseCountDoc,
  removeRow,
  resetCounts,
  searchRows,
  setContainer,
  setCount,
  setOrderNumber,
  MAX_ROWS,
  type CountDoc,
} from "../src/lib/counter";
import { buildCountXlsx } from "../src/lib/counterXlsx";
import { LIMITS } from "../src/lib/types";
import { POST as countExportPost } from "../src/app/api/count-export/route";

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

/** As it arrives off a buyer list: names, bags, and prices we must not carry. */
const LIST = [
  { name: "3/4 Ladies Jeans", qty: 14, perBag: 37_000 },
  { name: "Anorak", qty: 21, perBag: 24_000 },
  { name: "Anorak #2", qty: 9, perBag: 19_000 },
  { name: "Cotton Scarf", qty: 6, perBag: 12_000 },
];

function sample(): CountDoc {
  return fromOrderItems(LIST, "GAOU7441740", "Sri Lanka Order 03");
}

/* ------------------------------ starting out ------------------------------ */

section("A count starts at zero");
{
  const doc = sample();
  check(doc.rows.length === 4, `every item is listed (${doc.rows.length})`);
  check(
    doc.rows.every((row) => row.counted === 0 && !row.touched),
    "and nothing is counted yet",
  );
  check(
    doc.rows.map((row) => row.expected).join(",") === "14,21,9,6",
    "with what the list expects kept beside it",
  );
  check(doc.containerId === "GAOU7441740", "the container is recorded");
  check(doc.orderNumber === "Sri Lanka Order 03", "and the order");

  const t = countTotals(doc);
  check(t.expected === 50, `bags expected (${t.expected})`);
  check(t.counted === 0, "none counted");
  check(t.untouched === 4, "four items still to reach");
  check(t.progress === 0, `and no progress yet (${t.progress})`);
  check(!isCountComplete(doc), "so the count is not complete");

  // Pre-filling the expected figure would turn a count into a confirmation.
  check(
    doc.rows.every((row) => row.counted !== row.expected || row.expected === 0),
    "no row is pre-filled with what was expected",
  );

  const blank = countTotals(emptyCountDoc());
  check(blank.expected === 0 && blank.counted === 0, "an empty count totals zero");
  check(blank.progress === null, "with no progress to report");
  check(!isCountComplete(emptyCountDoc()), "and it is not complete either");
}

section("The same item twice on one list is one thing to count");
{
  const doubled = fromOrderItems([
    { name: "Anorak", qty: 10 },
    { name: "anorak", qty: 5 },
    { name: "Anorak #2", qty: 3 },
  ]);
  check(doubled.rows.length === 2, `duplicate names merge (${doubled.rows.length})`);
  check(doubled.rows[0].expected === 15, `and their bags add up (${doubled.rows[0].expected})`);
  check(
    doubled.rows[1].name === "Anorak #2",
    "while a genuinely different item stays separate",
  );
}

/* -------------------------------- counting -------------------------------- */

section("Tallying up and down");
{
  let doc = sample();
  const anorak = doc.rows[1];

  doc = addToCount(doc, anorak.id, 1);
  check(doc.rows[1].counted === 1, "one bag counted");
  check(doc.rows[1].touched, "and the row is marked as counted");

  doc = addToCount(doc, anorak.id, 10);
  doc = addToCount(doc, anorak.id, 10);
  check(doc.rows[1].counted === 21, `counting in steps works (${doc.rows[1].counted})`);
  check(countStatus(doc.rows[1]) === "matched", "and it matches the list");
  check(difference(doc.rows[1]) === 0, "with no difference");

  doc = addToCount(doc, anorak.id, -1);
  check(doc.rows[1].counted === 20, "counting down works");
  check(countStatus(doc.rows[1]) === "short", `and reads short (${countStatus(doc.rows[1])})`);
  check(difference(doc.rows[1]) === -1, "by one");

  doc = addToCount(doc, anorak.id, 5);
  check(countStatus(doc.rows[1]) === "over", `going past the list reads over (${countStatus(doc.rows[1])})`);
  check(difference(doc.rows[1]) === 4, "by four");

  // You cannot find minus one bag, and a stray tap must not invent a number.
  let low = sample();
  low = addToCount(low, low.rows[0].id, -5);
  check(low.rows[0].counted === 0, `a count never goes below zero (${low.rows[0].counted})`);
  check(low.rows[0].touched, "though the row still counts as counted");

  check(
    addToCount(doc, "no-such-id", 1).rows[1].counted === doc.rows[1].counted,
    "counting an unknown id changes nothing",
  );
  check(addToCount(doc, anorak.id, 0) === doc, "and a step of zero is not a change");
  check(
    addToCount(doc, anorak.id, 2.7).rows[1].counted === doc.rows[1].counted + 2,
    "a fractional step counts whole bags",
  );
}

section("Counted none is not the same as not counted");
{
  let doc = sample();
  const scarf = doc.rows[3];

  check(countStatus(scarf) === "uncounted", "an untouched row reads as uncounted");

  // Tap up then down: the answer is zero, and that is a real finding.
  doc = addToCount(doc, scarf.id, 1);
  doc = addToCount(doc, scarf.id, -1);
  check(doc.rows[3].counted === 0, "the tally is back to zero");
  check(doc.rows[3].touched, "but the row has been counted");
  check(
    countStatus(doc.rows[3]) === "short",
    `so finding none of six reads short, not uncounted (${countStatus(doc.rows[3])})`,
  );
  check(countTotals(doc).untouched === 3, "and only three items are still to reach");

  // Clearing is how you take that back.
  doc = clearCount(doc, scarf.id);
  check(!doc.rows[3].touched, "clearing puts a row back to never counted");
  check(doc.rows[3].counted === 0, "with the tally at zero");
  check(countStatus(doc.rows[3]) === "uncounted", "and the status follows");
}

section("Typing a figure straight in");
{
  let doc = sample();
  doc = setCount(doc, doc.rows[0].id, 14);
  check(doc.rows[0].counted === 14 && doc.rows[0].touched, "a known figure can be typed");
  check(countStatus(doc.rows[0]) === "matched", "and is judged the same way");

  doc = setCount(doc, doc.rows[0].id, -3);
  check(doc.rows[0].counted === 0, "a negative figure is clamped to zero");
  doc = setCount(doc, doc.rows[0].id, 7.9);
  check(doc.rows[0].counted === 7, `and bags stay whole (${doc.rows[0].counted})`);
  check(
    setCount(doc, doc.rows[0].id, LIMITS.qty * 5).rows[0].counted === LIMITS.qty,
    "a runaway figure is capped",
  );
}

section("Progress and completeness");
{
  let doc = sample();
  for (const row of doc.rows) doc = setCount(doc, row.id, row.expected);
  const t = countTotals(doc);
  check(t.counted === 50, `everything counted (${t.counted})`);
  check(t.matched === 4, "every item matches");
  check(t.difference === 0, "with no difference overall");
  check(t.progress === 100, `and the count is complete (${t.progress}%)`);
  check(isCountComplete(doc), "which is reported as complete");

  let half = sample();
  half = setCount(half, half.rows[0].id, 14);
  half = setCount(half, half.rows[1].id, 20);
  check(countTotals(half).progress === 50, `half done reads 50% (${countTotals(half).progress}%)`);
  check(countTotals(half).short === 1, "one item is short");
  check(!isCountComplete(half), "and the count is not complete");

  const reset = resetCounts(doc);
  check(
    reset.rows.every((row) => row.counted === 0 && !row.touched),
    "starting again clears every tally",
  );
  check(reset.rows.length === 4, "but keeps the item list");
}

/* -------------------------------- searching ------------------------------- */

section("Searching puts the right item first");
{
  const doc = sample();
  check(searchRows(doc, "").length === 4, "an empty search shows everything");

  const anorak = searchRows(doc, "anorak");
  check(anorak.length === 2, `both anoraks are found (${anorak.length})`);
  check(
    anorak[0].name === "Anorak",
    `and the exact name comes first, since Enter tallies it (${anorak[0].name})`,
  );

  check(searchRows(doc, "scarf")[0].name === "Cotton Scarf", "a word inside a name is found");
  check(searchRows(doc, "jeans")[0].name === "3/4 Ladies Jeans", "so is one at the end");
  check(searchRows(doc, "zzz").length === 0, "and nothing matches nonsense");

  check(bestMatch(doc, "anorak")?.name === "Anorak", "the best match is the exact one");
  check(bestMatch(doc, "cotton")?.name === "Cotton Scarf", "or the one that starts with it");
  check(bestMatch(doc, "")=== null, "an empty search has no best match");
  check(bestMatch(doc, "zzz") === null, "nor does one that finds nothing");
  check(bestMatch(doc, "ANORAK")?.name === "Anorak", "and case does not matter");
}

/* ------------------------- items found on the floor ------------------------ */

section("Adding an item found on the floor");
{
  const doc = sample();
  const added = addItem(doc, "  Kids Hoodie  ");
  check(added.row?.name === "Kids Hoodie", `the name is tidied (${added.row?.name})`);
  check(added.row?.added === true, "and it is marked as not on the list");
  check(added.row?.expected === 0, "with nothing expected, because it was not");
  check(added.row?.counted === 0 && added.row?.touched === false, "and no count yet");
  check(added.doc.rows.length === 5, "the list grows");
  check(!added.existed, "and it is reported as new");
  check(countTotals(added.doc).added === 1, "the totals count it as an extra find");

  // Two rows for one item would let a count split across both.
  const again = addItem(added.doc, "kids hoodie");
  check(again.existed, "adding the same name again is reported as already there");
  check(again.doc.rows.length === 5, "and does not add a second row");
  check(again.row?.id === added.row?.id, "handing back the row it already had");

  const onList = addItem(doc, "Anorak");
  check(onList.existed, "an item already on the list is recognised");
  check(onList.doc.rows.length === 4, "and not duplicated");

  const nameless = addItem(doc, "   ");
  check(nameless.row === null, "a blank name adds nothing");
  check(nameless.doc.rows.length === 4, "and changes nothing");

  let removed = added.doc;
  removed = removeRow(removed, added.row!.id);
  check(removed.rows.length === 4, "an added item can be removed");
  check(removeRow(removed, "nope").rows.length === 4, "removing an unknown id changes nothing");
}

section("Container and order");
{
  let doc = sample();
  doc = setContainer(doc, "  Back   room  ");
  check(
    doc.containerId === "Back room",
    `a warehouse bay can be named in plain words (${doc.containerId})`,
  );
  doc = setContainer(doc, "GAOU7441740");
  check(doc.containerId === "GAOU7441740", "and a container code is kept as typed");
  doc = setOrderNumber(doc, "  Sri Lanka  Order 04 ");
  check(doc.orderNumber === "Sri Lanka Order 04", "the order number is tidied");

  check(
    countFilename(doc) === "Sri Lanka Order 04 - GAOU7441740 - Bag Count.xlsx",
    `the file is named after both (${countFilename(doc)})`,
  );
  check(
    countFilename(setContainer(doc, "")) === "Sri Lanka Order 04 - Bag Count.xlsx",
    "a missing container is dropped rather than leaving a gap",
  );
  check(
    countFilename(emptyCountDoc()) === "Warehouse - Bag Count.xlsx",
    `with neither, it still gets a usable name (${countFilename(emptyCountDoc())})`,
  );
}

/* ------------------------------- persistence ------------------------------ */

section("Saving and reloading");
{
  let doc = sample();
  doc = setCount(doc, doc.rows[1].id, 20);
  const withExtra = addItem(doc, "Kids Hoodie");
  doc = addToCount(withExtra.doc, withExtra.row!.id, 3);

  const round = parseCountDoc(JSON.parse(JSON.stringify(doc)));
  check(round.rows.length === 5, "every row survives");
  check(round.containerId === doc.containerId, "so does the container");
  check(round.orderNumber === doc.orderNumber, "and the order number");
  check(
    round.rows[1].counted === 20 && round.rows[1].touched,
    "a counted row keeps its tally and that it was counted",
  );
  check(
    round.rows[4].added && round.rows[4].counted === 3,
    "and an item found on the floor keeps both facts",
  );
  check(
    JSON.stringify(countTotals(round)) === JSON.stringify(countTotals(doc)),
    "so every figure is identical afterwards",
  );
  check(
    round.rows.map((r) => r.id).join("|") === doc.rows.map((r) => r.id).join("|"),
    "ids are preserved, so a reloaded row can still be tallied",
  );

  const mixed = parseCountDoc({
    rows: [null, {}, { name: "" }, { name: "Keeper", expected: 5, counted: 2, touched: true }],
  });
  check(
    mixed.rows.length === 1 && mixed.rows[0].name === "Keeper",
    `nameless rows are dropped (${mixed.rows.length} kept)`,
  );
  for (const junk of [null, 42, "nonsense", { rows: "not an array" }]) {
    check(
      parseCountDoc(junk).rows.length === 0,
      `${JSON.stringify(junk)} parses to an empty count rather than throwing`,
    );
  }
  check(loadCountDoc().rows.length === 0, "loading outside a browser gives an empty one");

  const big = parseCountDoc({
    rows: Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({ name: `I${i}` })),
  });
  check(big.rows.length === MAX_ROWS, `the list is capped at ${MAX_ROWS}`);

  const hostile = createCountRow({ name: { evil: true }, expected: -5, counted: "9" });
  check(hostile.name === "", "an object cannot become an item name");
  check(hostile.expected === 0, "a negative expectation is clamped");
  check(hostile.counted === 9, "and a numeric string counts");
}

/* --------------------------------- the file -------------------------------- */

async function fileChecks() {
  let doc = sample();
  doc = setCount(doc, doc.rows[0].id, 14); // matched
  doc = setCount(doc, doc.rows[1].id, 18); // short
  doc = setCount(doc, doc.rows[2].id, 11); // over
  // rows[3] is left untouched on purpose
  const extra = addItem(doc, "Kids Hoodie");
  doc = addToCount(extra.doc, extra.row!.id, 4);
  const totals = countTotals(doc);
  const buffer = await buildCountXlsx(doc);

  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = book.getWorksheet("Bag Count")!;
  const f = (ref: string): string => {
    const v = ws.getCell(ref).value as { formula?: string } | null;
    return v && typeof v === "object" && typeof v.formula === "string" ? v.formula : "";
  };
  const r = (ref: string): unknown => {
    const v = ws.getCell(ref).value as { result?: unknown } | null;
    return v && typeof v === "object" && "result" in v ? v.result : v;
  };

  section("The spreadsheet: the item and the count, and nothing else");
  check(book.worksheets.length === 1, `one tab (${book.worksheets.length})`);
  check(
    [1, 2].map((c) => String(ws.getRow(2).getCell(c).value)).join(", ") === "Item, Count",
    `two columns (${[1, 2].map((c) => String(ws.getRow(2).getCell(c).value)).join(", ")})`,
  );
  // The comparison belongs on the page, not on the tally - and the expected
  // quantities have no business on a sheet handed to whoever did the counting.
  check(
    ws.getCell("C2").value === null || ws.getCell("C2").value === undefined,
    `there is no third column (${JSON.stringify(ws.getCell("C2").value)})`,
  );
  let strayColumn = false;
  ws.eachRow({ includeEmpty: true }, (row) => {
    for (const col of [3, 4, 5, 6]) {
      const cell = row.getCell(col).value;
      if (cell !== null && cell !== undefined && cell !== "") strayColumn = true;
    }
  });
  check(!strayColumn, "and nothing at all sits to the right of the count");

  const labelText: string[] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const first = row.getCell(1).value;
    if (typeof first === "string" && first.length < 40) labelText.push(first);
  });
  for (const word of ["Expected", "Difference", "Status", "Matched", "Short", "Over"]) {
    check(
      !labelText.includes(word),
      `nothing is labelled "${word}" any more`,
    );
  }
  check(
    String(ws.getCell("A1").value).includes("GAOU7441740") &&
      String(ws.getCell("A1").value).includes("Sri Lanka Order 03"),
    `though the heading still says which count this is (${String(ws.getCell("A1").value)})`,
  );

  section("The count is typed, the total is worked out");
  check(ws.getCell("A3").value === "3/4 Ladies Jeans", "the item name is written out");
  check(ws.getCell("B3").value === 14, "with the count beside it");
  check(ws.getCell("B4").value === 18, "as counted, not as expected");
  check(ws.getCell("B5").value === 11, "even when more were found than the list said");
  check(
    f(`B${3 + doc.rows.length}`) === `SUM(B3:B${2 + doc.rows.length})`,
    `the total is a live SUM (${f(`B${3 + doc.rows.length}`)})`,
  );
  check(
    r(`B${3 + doc.rows.length}`) === totals.counted,
    `with the right cached answer (${String(r(`B${3 + doc.rows.length}`))})`,
  );
  check(
    String(ws.getCell(`A${3 + doc.rows.length}`).value) === "Total",
    "and the row is labelled",
  );

  section("An item nobody reached is not reported as zero");
  const untouched = ws.getCell("B6");
  check(
    untouched.value === null || untouched.value === undefined,
    `its cell is left empty (${JSON.stringify(untouched.value)})`,
  );
  check(
    String(ws.getCell("A6").value) === "Cotton Scarf",
    "though the item is still listed, so the gap is visible",
  );
  // SUM ignores an empty cell, so an uncounted item cannot be totalled as none.
  check(
    totals.counted === 14 + 18 + 11 + 4,
    `and the total leaves it out (${totals.counted})`,
  );
  const note = String(ws.getCell(`A${3 + doc.rows.length + 2}`).value ?? "");
  check(
    note.includes("never counted") && note.includes("empty"),
    "the footer says what an empty cell means",
  );

  section("No price reaches the count sheet");
  // The list this came from had a per-bag price and a line total beside every
  // quantity. A count is about how many bags exist, and the sheet goes to whoever
  // did the counting.
  const numbers: number[] = [];
  const texts: string[] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
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
  for (const price of [37_000, 24_000, 19_000, 12_000]) {
    check(!numbers.includes(price), `no per-bag price appears (${price})`);
  }
  check(
    !numbers.some((n) => n === 518_000 || n === 504_000),
    "and no line total either",
  );
  const labels = texts.filter((t) => t.length < 40);
  check(
    !labels.some((t) => /price|cost|value|rs|total\s*value/i.test(t)),
    "nothing on the sheet is labelled as money",
  );
  check(
    !ws.getColumn(2).numFmt?.includes?.("Rs") &&
      !String(ws.getCell("B3").numFmt ?? "").includes("Rs"),
    "and no cell is formatted as currency",
  );

  section("An empty count still produces a usable sheet");
  const blank = await buildCountXlsx(emptyCountDoc());
  const blankBook = new ExcelJS.Workbook();
  await blankBook.xlsx.load(blank as unknown as ArrayBuffer);
  const bws = blankBook.getWorksheet("Bag Count")!;
  check(String(bws.getRow(2).getCell(1).value) === "Item", "the headings are there");
  const blankTotal = (bws.getCell("B4").value as { formula?: string })?.formula ?? "";
  const range = /SUM\(B(\d+):B(\d+)\)/.exec(blankTotal);
  check(
    range !== null && Number(range[2]) < 4,
    `and the total stays outside its own SUM (${blankTotal || "none"})`,
  );

  section("The download route");
  const post = (body: unknown) =>
    countExportPost(
      new Request("http://localhost/api/count-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }) as unknown as NextRequest,
    );

  const ok = await post({ doc });
  check(ok.status === 200, `the sheet is served (${ok.status})`);
  const disposition = ok.headers.get("Content-Disposition") ?? "";
  check(
    disposition.includes("Bag Count"),
    `named for what it is (${disposition})`,
  );
  check(disposition.includes("GAOU7441740"), "and carries the container");
  const servedBook = new ExcelJS.Workbook();
  await servedBook.xlsx.load(await ok.arrayBuffer());
  check(servedBook.worksheets.length === 1, "with one tab");

  const empty = await post({ doc: emptyCountDoc() });
  check(empty.status === 400, `an empty count is refused (${empty.status})`);
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
  writeFileSync(".verify/bag-count.xlsx", buffer);

  if (failures > 0) {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nALL COUNTER CHECKS PASSED");
}

fileChecks();

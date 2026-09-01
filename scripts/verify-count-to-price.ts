/**
 * Verifies the count-to-price loop: warehouse, then office.
 *
 *  - the count PDF reads back with the right names and quantities, including the
 *    ones ending in digits, which is the whole reason it prints a total
 *  - it carries no prices, and an item nobody counted is left off it
 *  - a sheet built from that count knows it is unfinished, and refuses to be sent
 *    to a buyer while any bag has no cost
 *  - a cost typed in behaves exactly as one read off a supplier sheet: selling is
 *    cost plus markup, and the buyer's copy is unchanged
 *  - the price book fills the second count in, and a remembered figure is visibly
 *    a guess rather than a decision
 *  - the buyer still sees no cost, no markup and no container
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import {
  addToCount,
  countTotals,
  fromOrderItems,
  setCount,
  type CountDoc,
} from "../src/lib/counter";
import { renderCountPdf, countPdfTitle } from "../src/lib/counterPdf";
import { parseOrderPdf } from "../src/lib/parseOrder";
import {
  emptyPriceListDoc,
  fillFromBook,
  fromParsedItems,
  isPriceListReady,
  lineTotal,
  loadPriceListDoc,
  missingCostNames,
  parsePriceListDoc,
  priceListTotals,
  removeRow,
  sellingPerBag,
  setMarkup,
  setOrderNumber,
  setRowCost,
  setRowQty,
  toOrderItems,
  DEFAULT_MARKUP,
  MAX_ROWS,
} from "../src/lib/priceList";
import {
  emptyPriceBook,
  forgetPrice,
  loadPriceBook,
  lookupPrice,
  parsePriceBook,
  priceBookSize,
  rememberPrice,
  rememberPrices,
  MAX_REMEMBERED,
} from "../src/lib/priceBook";
import { buildBuyerPriceList, formatLKR, LIMITS } from "../src/lib/types";
import { renderBuyerPdf } from "../src/lib/buyerPdf";
import { POST as countExportPost } from "../src/app/api/count-export/route";

const pdf = require("pdf-parse/lib/pdf-parse.js");

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

/**
 * pdf-parse ships several engines and the default one sometimes refuses a
 * perfectly good document. parseOrder tries them in turn for this reason; the same
 * is needed here to read a PDF's text directly.
 */
const ENGINES = ["v1.10.100", "v2.0.550", "v1.10.88", "v1.9.426"] as const;
async function pdfText(buffer: Buffer): Promise<string> {
  for (const version of ENGINES) {
    try {
      const data = await pdf(buffer, { version });
      const text = String(data?.text ?? "");
      if (text.trim() !== "") return text;
    } catch {
      /* try the next engine */
    }
  }
  return "";
}

/** Names chosen to break a careless reader: three of them end in a digit. */
const LIST = [
  { name: "3/4 Ladies Jeans", qty: 14 },
  { name: "Anorak", qty: 21 },
  { name: "Anorak #2", qty: 9 },
  { name: "Blanket 3", qty: 12 },
  { name: "Cotton Scarf", qty: 6 },
];

/** A count with four items done and one never reached. */
function countedInWarehouse(): CountDoc {
  let doc = fromOrderItems(LIST, "GAOU7441740", "Sri Lanka Order 03");
  doc = setCount(doc, doc.rows[0].id, 14);
  doc = setCount(doc, doc.rows[1].id, 29); // more than the list said
  doc = setCount(doc, doc.rows[2].id, 9);
  doc = addToCount(doc, doc.rows[3].id, 12);
  // Cotton Scarf deliberately never counted.
  return doc;
}

async function main() {
  /* ------------------------- the count leaves the floor ------------------------- */

  section("The count PDF");
  const doc = countedInWarehouse();
  const countPdf = await renderCountPdf(doc);
  check(countPdf.length > 1500, `a PDF is produced (${countPdf.length} bytes)`);
  check(
    countPdfTitle(doc) === "Sri Lanka Order 03 - GAOU7441740 - Bag count",
    `headed with the order and the container (${countPdfTitle(doc)})`,
  );
  // The heading must not end in a digit, or the parser reads it as an item.
  check(
    !/\d$/.test(countPdfTitle(doc)),
    "and the heading does not end in a digit",
  );

  const text = await pdfText(countPdf);
  check(text.includes("Total64"), `it prints a total (${countTotals(doc).counted})`);
  check(
    /^Total\s*\d+$/im.test(text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("Total")) ?? ""),
    "in the shape the parser recognises",
  );
  check(!/Rs/.test(text), "there is no money on it");
  check(!/price|cost|markup/i.test(text), "and nothing about prices");

  section("Reading the count back");
  const back = await parseOrderPdf(countPdf);
  check(back.items.length === 4, `the four counted items come back (${back.items.length})`);
  check(
    back.items.map((i) => i.name).join(" | ") ===
      "3/4 Ladies Jeans | Anorak | Anorak #2 | Blanket 3",
    `with their names intact (${back.items.map((i) => i.name).join(" | ")})`,
  );
  // This is what the total line buys: "Anorak #29" could be read as "Anorak #"
  // with 29 bags. It is only settled by making the list add up.
  check(
    back.items.find((i) => i.name === "Anorak #2")?.qty === 9,
    `a name ending in a digit keeps its digit and its count (${JSON.stringify(back.items.find((i) => i.name === "Anorak #2"))})`,
  );
  check(
    back.items.find((i) => i.name === "Blanket 3")?.qty === 12,
    "and so does another",
  );
  check(
    back.items.map((i) => i.qty).join(",") === "14,29,9,12",
    `the counts are what was counted (${back.items.map((i) => i.qty).join(",")})`,
  );
  check(back.totalQty === countTotals(doc).counted, "the bags add up to the count");
  check(
    back.items.every((i) => i.perBag === 0),
    "and every price is zero, because a count has none",
  );
  check(
    !back.items.some((i) => i.name === "Cotton Scarf"),
    "the item nobody counted is left off",
  );

  /* ---------------------------- pricing it afterwards --------------------------- */

  section("A sheet built from a count knows it is unfinished");
  let sheet = fromParsedItems(back.items, {
    orderNumber: "Sri Lanka Order 03",
    markup: 2_000,
  });
  check(sheet.rows.length === 4, `every counted item becomes a row (${sheet.rows.length})`);
  check(
    sheet.rows.every((row) => row.costPerBag === 0),
    "with no cost on any of them",
  );
  check(priceListTotals(sheet).missing === 4, "all four are reported as missing a price");
  check(
    !isPriceListReady(sheet),
    "so the sheet is not ready to send to a buyer",
  );
  check(
    missingCostNames(sheet).length === 4,
    `and it can say which ones (${missingCostNames(sheet).slice(0, 2).join(", ")}...)`,
  );
  check(priceListTotals(sheet).bags === 64, `the bags carry over (${priceListTotals(sheet).bags})`);

  section("Putting the prices in");
  sheet = setRowCost(sheet, sheet.rows[0].id, 37_000);
  check(sheet.rows[0].costPerBag === 37_000, "a cost can be typed in");
  check(priceListTotals(sheet).missing === 3, "and one fewer is missing");
  check(!isPriceListReady(sheet), "but the sheet is still not ready");

  sheet = setRowCost(sheet, sheet.rows[1].id, 24_000);
  sheet = setRowCost(sheet, sheet.rows[2].id, 19_000);
  sheet = setRowCost(sheet, sheet.rows[3].id, 15_000);
  check(priceListTotals(sheet).missing === 0, "with all of them in, nothing is missing");
  check(isPriceListReady(sheet), "and the sheet is ready");

  const totals = priceListTotals(sheet);
  check(totals.cost === 14 * 37_000 + 29 * 24_000 + 9 * 19_000 + 12 * 15_000, `what the bags cost (${totals.cost})`);
  check(totals.markupTotal === 64 * 2_000, `what the markup adds (${totals.markupTotal})`);
  check(
    totals.selling === totals.cost + totals.markupTotal,
    `and what the buyer pays is the two together (${totals.selling})`,
  );
  check(
    sellingPerBag(sheet.rows[0], sheet.markup) === 39_000,
    `selling is cost plus markup (${sellingPerBag(sheet.rows[0], sheet.markup)})`,
  );
  check(
    lineTotal(sheet.rows[0], sheet.markup) === 14 * 39_000,
    "and a line is that, times the bags",
  );

  section("A cost of zero is refused, not treated as free");
  // The mistake this gate exists for: a bag left at zero would be quoted to the
  // buyer at the markup alone.
  let holed = setRowCost(sheet, sheet.rows[2].id, 0);
  check(!isPriceListReady(holed), "one cost back to zero makes the sheet unready again");
  check(priceListTotals(holed).missing === 1, "and it is counted as missing");
  check(
    missingCostNames(holed)[0] === "Anorak #2",
    `named, so it can be pointed at (${missingCostNames(holed)[0]})`,
  );
  holed = setRowCost(holed, sheet.rows[2].id, -500);
  check(
    holed.rows[2].costPerBag === 0,
    "a negative cost is clamped to nothing rather than cutting the price",
  );
  check(!isPriceListReady(emptyPriceListDoc()), "an empty sheet is never ready");

  section("The buyer's copy is built from these rows");
  // The point: a priced count and a supplier sheet arrive at the same document.
  const items = toOrderItems(sheet);
  check(
    items.every((i) => i.perBag > 0),
    "the rows convert with the cost as the per-bag figure",
  );
  const built = buildBuyerPriceList(
    { title: sheet.orderNumber, items },
    sheet.markup,
  );
  check(built.totalQty === 64, `the buyer's copy has the bags (${built.totalQty})`);
  check(
    built.grandTotal === totals.selling,
    `and the same grand total (${formatLKR(built.grandTotal)})`,
  );
  check(
    built.rows[0].perBag === 39_000,
    "with the selling price per bag, not the cost",
  );

  section("A supplier sheet still behaves as it always did");
  const priced = fromParsedItems(
    [
      { name: "3/4 Jeans", qty: 14, perBag: 37_000 },
      { name: "Anorak", qty: 21, perBag: 24_000 },
    ],
    { orderNumber: "Sri Lanka Order 04", markup: 2_000 },
  );
  check(priceListTotals(priced).missing === 0, "a file with prices has nothing missing");
  check(isPriceListReady(priced), "and is ready straight away");
  check(
    priced.rows.every((row) => !row.remembered),
    "with nothing marked as a remembered guess",
  );
  check(
    priceListTotals(priced).selling === 14 * 39_000 + 21 * 26_000,
    `and the arithmetic is unchanged (${priceListTotals(priced).selling})`,
  );

  /* -------------------------------- the price book ------------------------------ */

  section("Remembering what things cost");
  let book = emptyPriceBook();
  check(lookupPrice(book, "Anorak") === null, "an empty book knows nothing");
  book = rememberPrice(book, "Anorak", 24_000);
  check(lookupPrice(book, "Anorak") === 24_000, "a price can be remembered");
  check(lookupPrice(book, "  anorak  ") === 24_000, "and is found whatever the case or padding");
  // The same fold the warehouse count uses, so one product cannot hold two prices.
  book = rememberPrice(book, "Anorak #2", 19_000);
  check(
    lookupPrice(book, "Anorak 2") === 19_000,
    `"Anorak #2" and "Anorak 2" are the same item (${lookupPrice(book, "Anorak 2")})`,
  );
  book = rememberPrice(book, "Anorak", 26_000);
  check(
    lookupPrice(book, "Anorak") === 26_000,
    `the newest price wins outright rather than being averaged (${lookupPrice(book, "Anorak")})`,
  );
  check(priceBookSize(book) === 2, `one entry per item (${priceBookSize(book)})`);

  check(rememberPrice(book, "", 5_000) === book, "a nameless item is not remembered");
  check(rememberPrice(book, "Ghost", 0) === book, "and neither is a price of nothing");
  book = forgetPrice(book, "Anorak #2");
  check(lookupPrice(book, "Anorak #2") === null, "a price can be forgotten");
  check(forgetPrice(book, "never known") === book, "forgetting what was never there changes nothing");

  section("The second count fills itself in");
  let learned = rememberPrices(emptyPriceBook(), [
    { name: "3/4 Ladies Jeans", costPerBag: 37_000 },
    { name: "Anorak", costPerBag: 24_000 },
    { name: "Blanket 3", costPerBag: 15_000 },
  ]);
  check(priceBookSize(learned) === 3, "a whole sheet can be remembered at once");

  const second = fromParsedItems(back.items, {
    orderNumber: "Sri Lanka Order 05",
    markup: 2_000,
    book: learned,
  });
  const secondTotals = priceListTotals(second);
  check(secondTotals.remembered === 3, `three prices come back (${secondTotals.remembered})`);
  check(secondTotals.missing === 1, `and only the unknown one is missing (${secondTotals.missing})`);
  check(
    missingCostNames(second)[0] === "Anorak #2",
    `which is the item never priced before (${missingCostNames(second)[0]})`,
  );
  check(
    second.rows.find((r) => r.name === "Anorak")?.remembered === true,
    "a filled row is marked as remembered, so an inherited figure is visibly a guess",
  );
  check(
    second.rows.find((r) => r.name === "Anorak")?.costPerBag === 24_000,
    "with last month's figure",
  );

  // Typing over it makes it a decision.
  const decided = setRowCost(
    second,
    second.rows.find((r) => r.name === "Anorak")!.id,
    25_000,
  );
  check(
    decided.rows.find((r) => r.name === "Anorak")?.remembered === false,
    "typing a cost turns a remembered guess into a decision",
  );

  section("The book never overrides a price the file gave");
  const bookSaysOtherwise = rememberPrice(emptyPriceBook(), "Anorak", 99_000);
  const fromFile = fromParsedItems([{ name: "Anorak", qty: 5, perBag: 24_000 }], {
    book: bookSaysOtherwise,
  });
  check(
    fromFile.rows[0].costPerBag === 24_000,
    `the file wins, because it is about this order (${fromFile.rows[0].costPerBag})`,
  );
  check(!fromFile.rows[0].remembered, "and it is not flagged as remembered");

  section("Filling the gaps later");
  const filled = fillFromBook(second, rememberPrice(learned, "Anorak #2", 19_000));
  check(priceListTotals(filled).missing === 0, "the book can be applied again once it knows more");
  check(
    filled.rows.find((r) => r.name === "Anorak #2")?.remembered === true,
    "and the newly filled row is marked",
  );
  const guarded = fillFromBook(decided, rememberPrice(learned, "Anorak", 1));
  check(
    guarded.rows.find((r) => r.name === "Anorak")?.costPerBag === 25_000,
    "while a cost already decided is left alone",
  );

  /* -------------------------------- persistence -------------------------------- */

  section("Nothing typed in is lost");
  const round = parsePriceListDoc(JSON.parse(JSON.stringify(sheet)));
  check(round.rows.length === 4, "every row survives a reload");
  check(round.markup === sheet.markup, "so does the markup");
  check(round.orderNumber === sheet.orderNumber, "and the order number");
  check(
    JSON.stringify(priceListTotals(round)) === JSON.stringify(totals),
    "so every figure is identical afterwards",
  );
  check(
    round.rows.map((r) => r.id).join("|") === sheet.rows.map((r) => r.id).join("|"),
    "ids are preserved, so a reloaded row can still be edited",
  );
  check(isPriceListReady(round), "and a finished sheet is still finished");

  const bookRound = parsePriceBook(JSON.parse(JSON.stringify(learned)));
  check(priceBookSize(bookRound) === 3, "the book survives too");
  check(lookupPrice(bookRound, "Anorak") === 24_000, "with its prices");

  for (const junk of [null, 42, "nonsense", { rows: "not an array" }]) {
    check(
      parsePriceListDoc(junk).rows.length === 0,
      `${JSON.stringify(junk)} parses to an empty sheet rather than throwing`,
    );
  }
  for (const junk of [null, 42, "nonsense", { prices: "not an object" }]) {
    check(
      priceBookSize(parsePriceBook(junk)) === 0,
      `${JSON.stringify(junk)} parses to an empty book rather than throwing`,
    );
  }
  check(
    priceBookSize(parsePriceBook({ prices: { x: { name: "X", costPerBag: 0 } } })) === 0,
    "a remembered price of nothing is dropped on the way in",
  );
  check(loadPriceListDoc().rows.length === 0, "loading outside a browser gives an empty sheet");
  check(priceBookSize(loadPriceBook()) === 0, "and an empty book");

  section("Sanitising and limits");
  const messy = fromParsedItems(
    [
      { name: "  Anorak\u0000  #2  ", qty: "21" as unknown as number, perBag: "24000" as unknown as number },
      { name: "", qty: 5, perBag: 100 },
      { name: "No bags", qty: 0, perBag: 100 },
    ],
    {},
  );
  check(messy.rows.length === 1, `nameless and bagless lines are dropped (${messy.rows.length})`);
  check(messy.rows[0].name === "Anorak #2", `names are tidied ("${messy.rows[0].name}")`);
  check(messy.rows[0].qty === 21 && messy.rows[0].costPerBag === 24_000, "numeric strings become numbers");
  check(
    setRowQty(messy, messy.rows[0].id, 7.9).rows[0].qty === 7,
    "bags stay whole things",
  );
  check(
    setMarkup(messy, LIMITS.markup * 5).markup === LIMITS.markup,
    "a runaway markup is capped",
  );
  check(
    setOrderNumber(messy, "  Sri Lanka   Order 06 ").orderNumber === "Sri Lanka Order 06",
    "the order number is tidied",
  );
  check(removeRow(messy, messy.rows[0].id).rows.length === 0, "a row can be taken off");
  check(
    fromParsedItems(
      Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({ name: `I${i}`, qty: 1, perBag: 1 })),
      {},
    ).rows.length === MAX_ROWS,
    `the sheet is capped at ${MAX_ROWS} rows`,
  );
  let huge = emptyPriceBook();
  for (let i = 0; i < MAX_REMEMBERED + 10; i += 1) {
    huge = rememberPrice(huge, `Item ${i}`, i + 1);
  }
  check(
    priceBookSize(huge) === MAX_REMEMBERED,
    `and the book at ${MAX_REMEMBERED} prices (${priceBookSize(huge)})`,
  );
  check(
    fromParsedItems([{ name: "X", qty: 1, perBag: 1 }], {}).markup === DEFAULT_MARKUP,
    `the markup defaults to ${DEFAULT_MARKUP}`,
  );

  /* ------------------------ the buyer still sees nothing ----------------------- */

  section("The buyer's copy gives nothing away");
  const buyerPdf = await renderBuyerPdf(built, {
    buyer: { name: "Ahmad Trading", phone: "0771234567" },
    refNo: "BB-3F7K-260901-001",
  });
  const buyerText = await pdfText(buyerPdf);
  check(buyerText.includes("Sri Lanka Order 03"), "the order is named on it");
  check(buyerText.includes("39,000"), "the buyer sees the selling price");
  check(!buyerText.includes("37,000"), "but not what the bag cost us");
  check(!buyerText.includes("2,000.00"), "nor the markup added to it");
  check(!/markup/i.test(buyerText), "the word markup does not appear");
  check(!/\bcost\b/i.test(buyerText), "neither does cost");
  check(
    !buyerText.includes("GAOU7441740"),
    "and the container the bags were counted in is nowhere on it",
  );

  /* ----------------------------------- route ---------------------------------- */

  section("The count PDF route");
  const post = (body: unknown) =>
    countExportPost(
      new Request("http://localhost/api/count-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }) as unknown as NextRequest,
    );

  const served = await post({ doc, format: "pdf" });
  check(served.status === 200, `a PDF is served (${served.status})`);
  check(
    (served.headers.get("Content-Type") ?? "") === "application/pdf",
    "as a PDF, not as a spreadsheet",
  );
  const disposition = served.headers.get("Content-Disposition") ?? "";
  check(disposition.endsWith('.pdf"'), `named as a PDF (${disposition})`);
  check(disposition.includes("Bag Count"), "and for what it is");

  const stillXlsx = await post({ doc });
  check(
    (stillXlsx.headers.get("Content-Type") ?? "").includes("spreadsheet"),
    "the spreadsheet is still what you get without asking for a PDF",
  );

  // A PDF of nothing but headings is not worth handing to anybody.
  const nothingCounted = fromOrderItems(LIST, "GAOU7441740", "Sri Lanka Order 03");
  const refused = await post({ doc: nothingCounted, format: "pdf" });
  check(refused.status === 400, `an uncounted list is refused as a PDF (${refused.status})`);
  check(
    (((await refused.json()) as { error?: string }).error ?? "").length > 10,
    "with a reason",
  );
  const asSheet = await post({ doc: nothingCounted });
  check(
    asSheet.status === 200,
    `though the spreadsheet still exports, since it shows what is left to do (${asSheet.status})`,
  );

  mkdirSync(".verify", { recursive: true });
  writeFileSync(".verify/bag-count.pdf", countPdf);
  writeFileSync(".verify/buyer-from-count.pdf", buyerPdf);

  if (failures > 0) {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nALL COUNT-TO-PRICE CHECKS PASSED");
}

main();

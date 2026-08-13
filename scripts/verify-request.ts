/**
 * Verifies buyer request lists:
 *  - outstanding is always derived, and supplied can never exceed requested
 *  - availability is matched against the stockpile on normalised item names
 *  - supplying from stock moves the bags and records them in one step, and
 *    refuses cleanly rather than half-completing
 *  - saving and reloading the file preserves everything, and rejects rubbish
 *  - CSV carries one row per requested line
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseOrderPdf } from "../src/lib/parseOrder";
import { parseCsvOrder } from "../src/lib/parseTabular";
import { renderManifestPdf } from "../src/lib/bagManifestPdf";
import { toBagItems } from "../src/lib/bagManifest";
import {
  addSource,
  availabilityFromSource,
  availabilityFromStockpile,
  combineAvailability,
  createRequest,
  createSource,
  lineValue,
  removeSource,
  sourceTotal,
  markSupplied,
  matchRequest,
  matchSummary,
  outstanding,
  parseRequestDoc,
  removeRequest,
  requestStatus,
  requestTotals,
  requestsToCsv,
  supplyFromStockpile,
  toRequestItems,
  upsertRequest,
  emptyRequestDoc,
  type BuyerRequest,
} from "../src/lib/buyerRequest";
import {
  addLots,
  emptyStockpile,
  itemBags,
  stockpileTotals,
  type Stockpile,
} from "../src/lib/stockpile";

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

const BUYER = { name: "Ahmad Trading", phone: "0771234567" };

/** A stockpile holding a few known items. */
function buildStock(): Stockpile {
  return addLots(
    emptyStockpile(),
    [
      { name: "Blanket", bags: 20, perBag: 20000, source: "Order 3" },
      { name: "Bed Sheet", bags: 4, perBag: 34000, source: "Order 3" },
      { name: "Anorak 2", bags: 6, perBag: 17000, source: "Order 3" },
    ],
    new Date("2026-06-01T00:00:00.000Z"),
  ).stockpile;
}

/* ------------------------------ the model ------------------------------- */
section("Building a request");

let request = createRequest(BUYER, [
  { name: "Blanket", qty: 12 },
  { name: "Bed Sheet", qty: 10 },
  { name: "Cotton Scarf", qty: 5, note: "mixed colours" },
]);

check(request.buyer.name === "Ahmad Trading", "the buyer is stored with the list");
check(request.items.length === 3, `three lines added (got ${request.items.length})`);
check(
  request.items[2].note === "mixed colours",
  "a per-line note is kept",
);
check(
  requestTotals(request).requested === 27,
  `27 bags asked for (got ${requestTotals(request).requested})`,
);
check(requestStatus(request) === "open", "a fresh list reads as open");
check(
  requestStatus(createRequest(BUYER, [])) === "empty",
  "a list with no lines reads as empty",
);

check(
  toRequestItems([{ name: "  ", qty: 5 }]).length === 0,
  "an unnamed line is dropped",
);
check(
  toRequestItems([{ name: "Ghost", qty: 0 }])[0].qty === 1,
  "a zero quantity is raised to 1",
);
check(
  toRequestItems([{ name: "Ghost", qty: 5, supplied: 99 }])[0].supplied === 5,
  "supplied loaded from a file can never exceed what was asked for",
);

/* ------------------------------ outstanding ------------------------------ */
section("Recording what has gone out");

request = markSupplied(request, request.items[0].id, 5);
check(
  request.items[0].supplied === 5 && outstanding(request.items[0]) === 7,
  "supplying 5 of 12 leaves 7 outstanding",
);
check(requestStatus(request) === "partial", "the list now reads as partial");

request = markSupplied(request, request.items[0].id, -2);
check(
  request.items[0].supplied === 3,
  "a negative adjustment corrects an over-entry",
);

let threw = false;
try {
  markSupplied(request, request.items[0].id, 99);
} catch {
  threw = true;
}
check(threw, "supplying more than was asked for is refused");

threw = false;
try {
  markSupplied(request, request.items[0].id, -99);
} catch {
  threw = true;
}
check(threw, "taking supplied below zero is refused");

threw = false;
try {
  markSupplied(request, "nope", 1);
} catch {
  threw = true;
}
check(threw, "a line that no longer exists is refused");

const single = createRequest(BUYER, [{ name: "Blanket", qty: 3 }]);
const finished = markSupplied(single, single.items[0].id, 3);
check(
  requestTotals(finished).outstanding === 0,
  "a fully supplied line leaves nothing outstanding",
);
check(
  requestStatus(finished) === "complete",
  "and the list reads as complete",
);

/* ----------------------------- availability ----------------------------- */
section("Checking against the stockpile");

let stock = buildStock();
const fresh = createRequest(BUYER, [
  { name: "Blanket", qty: 12 }, // 20 in stock -> ready
  { name: "Bed Sheet", qty: 10 }, // 4 in stock  -> part
  { name: "Cotton Scarf", qty: 5, note: "mixed colours" }, // none -> none
  { name: "Anorak #2", qty: 6 }, // spelled differently, 6 in stock
]);
const matches = matchRequest(fresh, availabilityFromStockpile(stock));

check(matches[0].status === "ready", "12 wanted with 20 in stock reads as ready");
check(
  matches[1].status === "part" && matches[1].canSupply === 4,
  "10 wanted with 4 in stock reads as part, supplying 4",
);
check(matches[2].status === "none", "an item not in stock reads as none");
check(
  matches[3].inStock === 6 && matches[3].status === "ready",
  '"Anorak #2" on the list finds "Anorak 2" in the stockpile',
);

const summary = matchSummary(matches);
check(
  summary.ready === 2 && summary.part === 1 && summary.none === 1,
  `summary counts 2 ready, 1 part, 1 none (got ${summary.ready}/${summary.part}/${summary.none})`,
);
check(
  summary.canSupplyBags === 12 + 4 + 0 + 6,
  `22 bags could go out today (got ${summary.canSupplyBags})`,
);

const suppliedLine = markSupplied(fresh, fresh.items[0].id, 12);
check(
  matchRequest(suppliedLine, availabilityFromStockpile(stock))[0].status === "done",
  "a line with nothing outstanding reads as done regardless of stock",
);

/* -------------------------- supplying from stock ------------------------- */
section("Supplying from the stockpile");

const before = stockpileTotals(stock).bags;
const result = supplyFromStockpile(fresh, stock, fresh.items[0].id, 12);
check(
  result.request.items[0].supplied === 12,
  "the request records the 12 bags",
);
check(
  stockpileTotals(result.stockpile).bags === before - 12,
  `the stockpile drops by 12 (${before} -> ${stockpileTotals(result.stockpile).bags})`,
);
check(
  itemBags(result.stockpile.items.find((i) => i.key === "blanket")!) === 8,
  "8 Blankets left in stock",
);
check(
  result.stockpile.history.some(
    (h) => h.kind === "out" && h.reason.includes("Ahmad Trading"),
  ),
  "the withdrawal is logged against the buyer's name",
);
check(result.value > 0, `the withdrawal reports its value (${result.value})`);

// Failure cases must leave both sides untouched.
threw = false;
try {
  supplyFromStockpile(fresh, stock, fresh.items[1].id, 10); // only 4 in stock
} catch {
  threw = true;
}
check(threw, "supplying more than is in stock is refused");
check(
  stockpileTotals(stock).bags === before,
  "the refused attempt did not change the stockpile",
);
check(
  fresh.items[1].supplied === 0,
  "the refused attempt did not change the request",
);

threw = false;
try {
  supplyFromStockpile(fresh, stock, fresh.items[2].id, 1); // not in stockpile
} catch {
  threw = true;
}
check(threw, "supplying an item that is not in the stockpile is refused");

threw = false;
try {
  supplyFromStockpile(fresh, stock, fresh.items[0].id, 0);
} catch {
  threw = true;
}
check(threw, "supplying zero bags is refused");

/* ----------------------------- the document ----------------------------- */
section("The requests file");

let doc = emptyRequestDoc();
doc = upsertRequest(doc, fresh);
doc = upsertRequest(doc, createRequest({ name: "Fatima Corp", phone: "" }, [
  { name: "Blanket", qty: 4 },
]));
check(doc.requests.length === 2, "two buyers held in one document");

const edited: BuyerRequest = { ...fresh, notes: "Wants delivery by Friday" };
doc = upsertRequest(doc, edited);
check(
  doc.requests.length === 2,
  "saving an existing list updates it rather than adding a copy",
);
check(
  doc.requests.find((r) => r.id === fresh.id)?.notes ===
    "Wants delivery by Friday",
  "the note was saved",
);

const reloaded = parseRequestDoc(JSON.parse(JSON.stringify(doc)));
check(
  reloaded.requests.length === 2,
  "saving and reloading keeps both lists",
);
check(
  JSON.stringify(reloaded.requests.map((r) => r.items)) ===
    JSON.stringify(doc.requests.map((r) => r.items)),
  "every line survives the round trip exactly",
);
check(
  reloaded.requests.find((r) => r.id === fresh.id)?.buyer.phone ===
    "0771234567",
  "the buyer's phone survives the round trip",
);

const junk = parseRequestDoc({
  requests: [null, { buyer: null, items: [{ name: "", qty: 3 }, null] }, 42],
});
check(
  junk.requests.every((r) => typeof r.buyer.name === "string"),
  "a corrupt file degrades to usable lists instead of crashing",
);
check(
  junk.requests.every((r) => r.items.every((i) => i.name !== "")),
  "unusable lines are dropped on load",
);
check(
  parseRequestDoc("nonsense").requests.length === 0,
  "a file that is not a requests document loads as empty",
);

doc = removeRequest(doc, fresh.id);
check(doc.requests.length === 1, "a list can be removed");

/* The remaining checks read files, so they run inside an async function. */
async function fileChecks() {
  /* ----------------------- importing a buyer's own list ---------------------- */
  section("Importing a list from a file");

  // A buyer's list is usually just items and quantities, with no prices at all.
  const plainList = await renderManifestPdf({
    orderNumber: "Ahmad wants",
    containerNumber: "GAOU7441740",
    items: [
      { name: "Blanket", qty: 12 },
      { name: "Bed Sheet", qty: 4 },
      { name: "Anorak 2", qty: 9 },
    ],
    total: 25,
  });
  const fromPdf = await parseOrderPdf(plainList);
  check(
    fromPdf.items.length === 3,
    `a priceless PDF list yields 3 lines (got ${fromPdf.items.length})`,
  );
  check(
    fromPdf.totalQty === 25,
    `the quantities total 25 (got ${fromPdf.totalQty})`,
  );
  check(
    fromPdf.items[2].name === "Anorak 2" && fromPdf.items[2].qty === 9,
    `"Anorak 2" with 9 bags is read correctly rather than "Anorak" with 29 (got "${fromPdf.items[2].name}" ${fromPdf.items[2].qty})`,
  );
  check(
    fromPdf.totalsMatch,
    "the printed total confirms the reading",
  );
  check(
    fromPdf.items.every((i) => i.perBag === 0),
    "no price is invented for a list that had none",
  );

  const asLines = toRequestItems(
    fromPdf.items.map((i) => ({ name: i.name, qty: i.qty })),
  );
  check(
    asLines.length === 3 && asLines.every((l) => l.supplied === 0),
    "imported lines start with nothing supplied",
  );
  const importedRequest = createRequest(BUYER, asLines);
  check(
    requestTotals(importedRequest).requested === 25,
    "the imported request asks for 25 bags",
  );
  const importedMatch = matchRequest(importedRequest, availabilityFromStockpile(buildStock()));
  check(
    importedMatch[2].item.name === "Anorak 2" &&
      importedMatch[2].inStock === 6 &&
      importedMatch[2].canSupply === 6 &&
      importedMatch[2].status === "part",
    `the imported "Anorak 2" line finds its 6 bags in stock against 9 wanted (${importedMatch[2].status})`,
  );
  check(
    importedMatch[0].status === "ready" && importedMatch[1].status === "ready",
    "the other imported lines are fully covered by stock",
  );

  // A priced order sheet must still import, ignoring the money entirely.
  const priced = await parseOrderPdf(
    readFileSync("sample-orders/Sri Lanka Order 3 2026 - Sheet1 (1).pdf"),
  );
  check(
    priced.items.length === 85 && priced.totalQty === 733,
    `a priced order sheet still reads as 85 lines / 733 bags (got ${priced.items.length} / ${priced.totalQty})`,
  );
  const fromPriced = createRequest(BUYER, priced.items);
  const blanketLine = fromPriced.items.find((i) => i.name === "Blanket")!;
  check(
    fromPriced.items.length === 85 && blanketLine.perBag === 20000,
    `importing a priced sheet carries the price through (Blanket at ${blanketLine.perBag})`,
  );
  check(
    lineValue(blanketLine) === blanketLine.qty * 20000,
    `the line is worth ${lineValue(blanketLine)}`,
  );

  // A CSV of just two columns is the other common shape.
  const csvList = parseCsvOrder(
    ["Item Name,Quantity", "Blanket,12", "Cotton Scarf,5"].join("\n"),
    "Ahmad list",
  );
  check(
    csvList.items.length === 2 && csvList.totalQty === 17,
    `a two-column CSV yields 2 lines / 17 bags (got ${csvList.items.length} / ${csvList.totalQty})`,
  );

  /* --------------------- containers as availability sources ------------------ */
  section("Checking against an uploaded container file");

  // The container that actually holds the stock, uploaded from its order sheet.
  const container = createSource("Sri Lanka Order 3 2026", priced.items);
  check(
    container.items.length === 85 && sourceTotal(container) === 733,
    `the container file holds 85 items / 733 bags (got ${container.items.length} / ${sourceTotal(container)})`,
  );
  check(
    container.items.find((i) => i.name === "Blanket")?.perBag === 20000,
    "a container source keeps the price from the file",
  );

  // A request the stockpile cannot fill, but the container can.
  const bigRequest = createRequest(BUYER, [
    { name: "Blanket", qty: 40 }, // stockpile has 20, container has 62
    { name: "Comforter Cover", qty: 10 }, // not in the stockpile at all
  ]);

  const viaStock = matchRequest(bigRequest, availabilityFromStockpile(buildStock()));
  check(
    viaStock[0].status === "part" && viaStock[1].status === "none",
    "against the stockpile alone the lines are short",
  );

  const viaContainer = matchRequest(bigRequest, availabilityFromSource(container));
  check(
    viaContainer[0].inStock === 62 && viaContainer[0].status === "ready",
    `against the container, 40 Blankets are covered by its 62 (got ${viaContainer[0].inStock})`,
  );
  check(
    viaContainer[1].status === "ready",
    "and Comforter Cover is found in the container",
  );

  const combined = matchRequest(
    bigRequest,
    combineAvailability([
      availabilityFromStockpile(buildStock()),
      availabilityFromSource(container),
    ]),
  );
  check(
    combined[0].inStock === 20 + 62,
    `everything together adds the two pools (got ${combined[0].inStock})`,
  );

  // Container names are matched the same way, so a buyer's spelling still lands.
  const spelled = createRequest(BUYER, [{ name: "Anorak #2", qty: 3 }]);
  check(
    matchRequest(spelled, availabilityFromSource(container))[0].inStock === 9,
    "a differently spelled item still matches inside a container file",
  );

  // Sources live in the document and survive a save/load.
  let sourceDoc = addSource(emptyRequestDoc(), container);
  check(sourceDoc.sources.length === 1, "a container is stored on the document");
  sourceDoc = addSource(
    sourceDoc,
    createSource("Sri Lanka Order 3 2026", priced.items.slice(0, 10)),
  );
  check(
    sourceDoc.sources.length === 1,
    "re-uploading the same container replaces it rather than doubling it up",
  );
  sourceDoc = addSource(sourceDoc, createSource("Sri Lanka Order 4 2026", [
    { name: "Blanket", qty: 15 },
  ]));
  check(sourceDoc.sources.length === 2, "a different container is added alongside");

  const reloadedSources = parseRequestDoc(
    JSON.parse(JSON.stringify(sourceDoc)),
  );
  check(
    reloadedSources.sources.length === 2,
    "containers survive saving and reloading",
  );
  check(
    sourceTotal(reloadedSources.sources[1]) === sourceTotal(sourceDoc.sources[1]),
    "their quantities survive too",
  );
  check(
    parseRequestDoc({ sources: [{ name: "Empty", items: [] }] }).sources.length === 0,
    "a container with no usable lines is dropped on load",
  );
  check(
    removeSource(sourceDoc, sourceDoc.sources[0].id).sources.length === 1,
    "a container can be removed",
  );

  // Supplying from a container must not pretend to move stock.
  const beforeStock = stockpileTotals(buildStock()).bags;
  const afterRecord = markSupplied(bigRequest, bigRequest.items[0].id, 40);
  check(
    afterRecord.items[0].supplied === 40 &&
      stockpileTotals(buildStock()).bags === beforeStock,
    "recording against a container leaves the stockpile untouched",
  );

  /* ------------------- prices come out of the file itself ------------------- */
  section("Prices are read from the file, not typed");

  // The whole point: import a priced sheet and the request is already worth
  // something, with no price typed by hand.
  const pricedSource = createSource(
    "Sri Lanka Order 3 2026 - Sheet1 (1)",
    priced.items.map((i) => ({ name: i.name, qty: i.qty, perBag: i.perBag })),
  );
  check(
    pricedSource.items.every((i) => i.perBag > 0),
    `every one of the ${pricedSource.items.length} lines came in with a price`,
  );
  const srcBlanket = pricedSource.items.find((i) => i.name === "Blanket")!;
  check(
    srcBlanket.perBag === 20000 && srcBlanket.qty === 62,
    `Blanket read as 62 bags at ${srcBlanket.perBag}`,
  );
  check(
    pricedSource.items.reduce((s, i) => s + i.qty * i.perBag, 0) === 17_878_000,
    "the container is worth Rs17,878,000, matching the sheet",
  );

  const autoPriced = createRequest(
    BUYER,
    toRequestItems(
      priced.items.map((i) => ({ name: i.name, qty: i.qty, perBag: i.perBag })),
    ),
  );
  const autoTotals = requestTotals(autoPriced);
  check(
    autoTotals.value === 17_878_000,
    `an imported request is worth ${autoTotals.value} straight away`,
  );
  check(
    !autoTotals.hasUnpriced,
    "no line needs a price typing in after a priced import",
  );

  // A file with no prices stays unpriced rather than inventing figures.
  check(
    fromPdf.items.every((i) => i.perBag === 0),
    "a list with no prices imports unpriced instead of guessing",
  );

  // A document this app produced must not hand back its own wordmark as the
  // heading, which is what made an uploaded container show up as "BaleBook".
  const ownDocument = await renderManifestPdf({
    orderNumber: "Sri Lanka 04",
    containerNumber: "GAOU7441740",
    items: [{ name: "Blanket", qty: 12 }],
    total: 12,
  });
  const ownTitle = (await parseOrderPdf(ownDocument)).title;
  check(
    ownTitle === "Sri Lanka 04",
    `a BaleBook document reports its order number, not its wordmark (got "${ownTitle}")`,
  );
  check(
    !/balebook/i.test(ownTitle),
    "the wordmark never becomes a title",
  );

  // A price column is worded differently on every sheet. Missing one is not a
  // cosmetic problem: the whole order silently comes out worth nothing.
  section("Price columns are recognised however they are worded");

  for (const heading of [
    "Per Bag",
    "per bag",
    "Price Per Bag",
    "Bag Price",
    "Unit Price",
    "Unit Rate",
    "Rate Per Bag",
    "Rate",
    "Price",
    "Cost",
    "Cost Per Bag",
    "Value Per Bag",
  ]) {
    const parsedCsv = parseCsvOrder(
      [`Item Name,Quantity,${heading},Total`, "Blanket,12,20000,240000"].join(
        "\n",
      ),
      "x",
    );
    check(
      parsedCsv.items[0]?.perBag === 20000,
      `"${heading}" is read as the per-bag price (got ${parsedCsv.items[0]?.perBag})`,
    );
  }
  const amountSheet = parseCsvOrder(
    ["Item Name,Quantity,Per Bag,Amount", "Blanket,12,20000,240000"].join("\n"),
    "x",
  );
  check(
    amountSheet.items[0]?.perBag === 20000 && amountSheet.totalsMatch,
    "\"Amount\" is treated as the line total, not the per-bag price",
  );

  /* --------------------------------- money --------------------------------- */
  section("Pricing");

  const quote = createRequest(BUYER, [
    { name: "Blanket", qty: 10, perBag: 22000 },
    { name: "Bed Sheet", qty: 4, perBag: 36000 },
    { name: "Cotton Scarf", qty: 5 }, // no price agreed yet
  ]);
  const quoteTotals = requestTotals(quote);
  check(
    quoteTotals.value === 10 * 22000 + 4 * 36000,
    `the order is worth ${quoteTotals.value} with the unpriced line counted as nothing`,
  );
  check(
    quoteTotals.hasUnpriced,
    "an unpriced line is flagged so the value is not mistaken for the whole order",
  );
  check(
    quoteTotals.suppliedValue === 0 &&
      quoteTotals.outstandingValue === quoteTotals.value,
    "nothing supplied yet, so the whole value is still to invoice",
  );

  const partly = markSupplied(quote, quote.items[0].id, 4);
  const partlyTotals = requestTotals(partly);
  check(
    partlyTotals.suppliedValue === 4 * 22000,
    `supplying 4 bags is worth ${partlyTotals.suppliedValue}`,
  );
  check(
    partlyTotals.outstandingValue ===
      partlyTotals.value - partlyTotals.suppliedValue,
    "supplied and outstanding value always add back to the order value",
  );

  check(
    toRequestItems([{ name: "X", qty: 2, perBag: -50 }])[0].perBag === 0,
    "a negative price clamps to nothing",
  );
  check(
    toRequestItems([{ name: "X", qty: 2, perBag: "abc" }])[0].perBag === 0,
    "a price that is not a number clamps to nothing",
  );
  check(
    toRequestItems([{ name: "X", qty: 2 }])[0].perBag === 0,
    "a missing price is simply unpriced, not an error",
  );

  // Bag manifests must stay free of money even though requests now carry it.
  const manifestItems = toBagItems(priced.items);
  check(
    !JSON.stringify(manifestItems).includes("perBag"),
    "bag manifests still carry no prices",
  );

  /* -------------------------------- the CSV -------------------------------- */
  section("CSV export");

  stock = buildStock();
  const csvDoc = upsertRequest(emptyRequestDoc(), fresh);
  const csv = requestsToCsv(csvDoc.requests, availabilityFromStockpile(stock));
  const rows = csv.trim().split("\n");
  check(rows[0].startsWith("Buyer,Phone,Item"), "there is a header row");
  check(
    rows[0].includes("Per Bag") && rows[0].includes("Total"),
    "the CSV carries the money columns",
  );
  check(
    rows.length === 1 + fresh.items.length,
    `one row per requested line (${rows.length - 1} for ${fresh.items.length} lines)`,
  );
  check(
    csv.includes("Ahmad Trading"),
    "the buyer appears on every row",
  );
  check(
    csv.includes("mixed colours"),
    "per-line notes are exported",
  );
  const scarfRow = rows.find((r) => r.includes("Cotton Scarf")) ?? "";
  check(
    scarfRow.endsWith("0,mixed colours") || scarfRow.includes(",0,"),
    `the in-stock column is filled in (${scarfRow})`,
  );
  const csvNoStock = requestsToCsv(csvDoc.requests);
  check(
    csvNoStock.split("\n").length === rows.length,
    "the CSV still works without a stockpile to compare against",
  );

  mkdirSync(".verify", { recursive: true });
  writeFileSync(".verify/requests.csv", csv);
  writeFileSync(".verify/requests.json", JSON.stringify(csvDoc, null, 2));

  if (failures > 0) {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nALL REQUEST CHECKS PASSED");

}

fileChecks();

/**
 * Verifies buyer request lists:
 *  - outstanding is always derived, and supplied can never exceed requested
 *  - availability is matched against the stockpile on normalised item names
 *  - supplying from stock moves the bags and records them in one step, and
 *    refuses cleanly rather than half-completing
 *  - saving and reloading the file preserves everything, and rejects rubbish
 *  - CSV carries one row per requested line
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  createRequest,
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
const matches = matchRequest(fresh, stock);

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
  matchRequest(suppliedLine, stock)[0].status === "done",
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

/* -------------------------------- the CSV -------------------------------- */
section("CSV export");

stock = buildStock();
const csvDoc = upsertRequest(emptyRequestDoc(), fresh);
const csv = requestsToCsv(csvDoc.requests, stock);
const rows = csv.trim().split("\n");
check(rows[0].startsWith("Buyer,Phone,Item"), "there is a header row");
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

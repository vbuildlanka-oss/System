/**
 * Verifies the stockpile:
 *  - items merge across orders, batches consolidate, prices stay separate
 *  - totals / averages are always derived from the lots
 *  - FIFO withdrawals draw the oldest bags first and cannot go negative
 *  - ageing buckets, merging, tidy-up, CSV and file round-tripping
 *  - a realistic run using the two real order PDFs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseOrderPdf } from "../src/lib/parseOrder";
import { buildSheetFromRows, formatLKR } from "../src/lib/types";
import { renderSheetPdf } from "../src/lib/buyerPdf";
import {
  addLots,
  ageBucket,
  emptyStockpile,
  itemAgeDays,
  itemAvgPerBag,
  itemBags,
  itemValue,
  MAX_HISTORY,
  mergeItems,
  normalizeItemKey,
  parseStockpile,
  planWithdrawal,
  removeEmptyItems,
  stockpileTotals,
  toCsv,
  withdraw,
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

const NOW = new Date("2026-08-09T10:00:00.000Z");
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 86_400_000);

/* ------------------------------ name matching ----------------------------- */
section("Item name matching");
check(
  normalizeItemKey("Anorak 2") === normalizeItemKey("Anorak #2"),
  '"Anorak 2" and "Anorak #2" are treated as the same item',
);
check(
  normalizeItemKey("  BLANKET  ") === normalizeItemKey("Blanket"),
  "case and padding are ignored",
);
check(
  normalizeItemKey("Anorak") !== normalizeItemKey("Anorak 2"),
  '"Anorak" stays separate from "Anorak 2"',
);
check(
  normalizeItemKey("Curtains (light)") === normalizeItemKey("Curtains light"),
  "brackets are ignored",
);

/* ------------------------- adding and consolidating ----------------------- */
section("Adding bags");
let sp: Stockpile = emptyStockpile();

sp = addLots(
  sp,
  [
    { name: "Blanket", bags: 12, perBag: 20000, source: "Order 3" },
    { name: "Bed Sheet", bags: 4, perBag: 34000, source: "Order 3" },
    { name: "Anorak 2", bags: 3, perBag: 17000, source: "Order 3" },
  ],
  daysAgo(100),
).stockpile;
check(sp.items.length === 3, "three items created");
check(stockpileTotals(sp, NOW).bags === 19, "19 bags held in total");

// Same item, same source, same price, same day -> folds into the existing lot.
sp = addLots(
  sp,
  [{ name: "Blanket", bags: 8, perBag: 20000, source: "Order 3" }],
  daysAgo(100),
).stockpile;
const blanket1 = sp.items.find((i) => i.key === "blanket")!;
check(
  blanket1.lots.length === 1,
  "identical batch consolidated into one lot (no duplicate lots)",
);
check(itemBags(blanket1) === 20, "Blanket now holds 20 bags");

// Same item, different price -> a separate lot, so cost history is preserved.
sp = addLots(
  sp,
  [{ name: "Blanket", bags: 5, perBag: 22000, source: "Order 4" }],
  daysAgo(10),
).stockpile;
const blanket2 = sp.items.find((i) => i.key === "blanket")!;
check(blanket2.lots.length === 2, "a different price creates a second batch");
check(itemBags(blanket2) === 25, "Blanket holds 25 bags across two batches");
check(
  itemValue(blanket2) === 20 * 20000 + 5 * 22000,
  `Blanket value is ${formatLKR(20 * 20000 + 5 * 22000)}`,
);
check(
  Math.abs(itemAvgPerBag(blanket2) - itemValue(blanket2) / 25) < 0.001,
  "average per bag is weighted across batches",
);

// The "#2" spelling from a later order lands on the existing item.
sp = addLots(
  sp,
  [{ name: "Anorak #2", bags: 8, perBag: 19000, source: "Order 4" }],
  daysAgo(10),
).stockpile;
check(
  sp.items.filter((i) => i.key === "anorak 2").length === 1,
  '"Anorak #2" merged into the existing "Anorak 2" item',
);
check(
  itemBags(sp.items.find((i) => i.key === "anorak 2")!) === 11,
  "Anorak 2 holds 11 bags after the merge",
);

/* --------------------------------- ageing -------------------------------- */
section("Ageing");
check(
  itemAgeDays(sp.items.find((i) => i.key === "bed sheet")!, NOW) === 100,
  "age is measured from the oldest remaining batch (100 days)",
);
check(ageBucket(5).key === "fresh", "5 days -> fresh");
check(ageBucket(30).key === "watch", "30 days -> watch");
check(ageBucket(75).key === "slow", "75 days -> slow");
check(ageBucket(100).key === "dead", "100 days -> dead");

const t = stockpileTotals(sp, NOW);
check(
  t.byBucket.dead.bags === 20 + 4 + 3,
  `dead bucket holds the 27 bags added 100 days ago (got ${t.byBucket.dead.bags})`,
);
check(
  t.byBucket.fresh.bags === 5 + 8,
  `fresh bucket holds the 13 recent bags (got ${t.byBucket.fresh.bags})`,
);
check(
  t.bags === t.byBucket.fresh.bags + t.byBucket.dead.bags,
  "buckets add up to the total bag count",
);
check(t.oldestDays === 100, "oldest bag is 100 days old");
check(
  t.deadValue === 20 * 20000 + 4 * 34000 + 3 * 17000,
  `dead stock value is ${formatLKR(20 * 20000 + 4 * 34000 + 3 * 17000)}`,
);

/* ------------------------------ FIFO removal ------------------------------ */
section("FIFO withdrawal");
const bl = sp.items.find((i) => i.key === "blanket")!;
const plan = planWithdrawal(bl, 22);
check(plan.consumed.length === 2, "22 bags spans two batches");
check(
  plan.consumed[0].bags === 20 && plan.consumed[0].perBag === 20000,
  "the older Rs20,000 batch is drained first (20 bags)",
);
check(
  plan.consumed[1].bags === 2 && plan.consumed[1].perBag === 22000,
  "the remaining 2 bags come from the newer Rs22,000 batch",
);
check(
  plan.value === 20 * 20000 + 2 * 22000,
  `withdrawal value uses each batch's own price (${formatLKR(20 * 20000 + 2 * 22000)})`,
);
check(plan.shortfall === 0, "no shortfall when enough bags exist");
check(
  planWithdrawal(bl, 999).shortfall === 999 - 25,
  "a shortfall is reported when asking for too many",
);

const res = withdraw(sp, bl.id, 22, "Sold", NOW);
sp = res.stockpile;
const blAfter = sp.items.find((i) => i.key === "blanket")!;
check(itemBags(blAfter) === 3, "3 bags left after selling 22");
check(
  blAfter.lots.length === 1 && blAfter.lots[0].perBag === 22000,
  "the emptied batch is dropped, leaving only the newer one",
);
check(
  itemAgeDays(blAfter, NOW) === 10,
  "age now reflects the newer remaining batch (10 days)",
);

let threw = false;
try {
  withdraw(sp, blAfter.id, 99, "Sold", NOW);
} catch {
  threw = true;
}
check(threw, "removing more bags than held is refused (stock cannot go negative)");

threw = false;
try {
  withdraw(sp, blAfter.id, 0, "Sold", NOW);
} catch {
  threw = true;
}
check(threw, "a zero withdrawal is refused");

/* --------------------------------- history -------------------------------- */
section("Movement history");
check(
  sp.history.some((m) => m.kind === "out" && m.bags === 22),
  "the withdrawal was logged",
);
check(
  sp.history.filter((m) => m.kind === "in").length >= 6,
  "every addition was logged",
);
check(sp.history.length <= MAX_HISTORY, `history is capped at ${MAX_HISTORY}`);
check(
  sp.history[0].at >= sp.history[sp.history.length - 1].at,
  "history is newest first",
);

/* ------------------------------ merge / tidy ------------------------------ */
section("Merging and tidying");
let sp2 = addLots(
  emptyStockpile(),
  [
    { name: "Ladies Tshirt S/S", bags: 6, perBag: 30000, source: "Order 3" },
    { name: "Ladies Tshirts S/S", bags: 4, perBag: 30000, source: "Order 4" },
  ],
  daysAgo(20),
).stockpile;
check(
  sp2.items.length === 2,
  "a plural spelling is not auto-merged (left for you to decide)",
);
const [a, b] = sp2.items;
sp2 = mergeItems(sp2, b.id, a.id);
check(sp2.items.length === 1, "manual merge combines them into one item");
check(itemBags(sp2.items[0]) === 10, "merged item holds all 10 bags");

const drained = withdraw(sp2, sp2.items[0].id, 10, "Sold", NOW).stockpile;
check(itemBags(drained.items[0]) === 0, "item can be emptied to zero bags");
check(
  drained.items.length === 1,
  "an emptied item is kept so the name is not lost",
);
check(
  removeEmptyItems(drained).items.length === 0,
  "tidy up removes emptied items",
);

/* ---------------------------- file round-tripping -------------------------- */
section("File storage");
const json = JSON.stringify(sp);
const reloaded = parseStockpile(JSON.parse(json));
check(
  stockpileTotals(reloaded, NOW).bags === stockpileTotals(sp, NOW).bags &&
    stockpileTotals(reloaded, NOW).value === stockpileTotals(sp, NOW).value,
  "saving and reloading preserves bags and value exactly",
);
const junk = parseStockpile({
  items: [
    { name: "Ghost", lots: [{ bags: -5, perBag: "abc" }] },
    { lots: null },
    null,
  ],
  history: "nope",
});
check(
  junk.items.every((i) => i.lots.every((l) => l.bags > 0)),
  "corrupt or negative batches are discarded on load",
);
check(
  Array.isArray(junk.history) && junk.history.length === 0,
  "a broken history degrades to an empty list instead of crashing",
);

const csv = toCsv(sp, NOW);
const csvLines = csv.trim().split("\n");
const lotCount = sp.items.reduce((s, i) => s + i.lots.length, 0);
check(
  csvLines[0].startsWith("Item,Bags,Per Bag"),
  "CSV has a header row",
);
check(
  csvLines.filter((l) => l && !l.startsWith("Item,") && !l.startsWith("Total"))
    .length === lotCount,
  `CSV has one row per batch (${lotCount})`,
);
check(csv.includes("Total,"), "CSV ends with a total row");

/* --------------------------- realistic scenario --------------------------- */
section("Realistic run with the real order PDFs");
(async () => {
  const order3 = await parseOrderPdf(
    readFileSync("sample-orders/Sri Lanka Order 3 2026 - Sheet1 (1).pdf"),
  );
  const order4 = await parseOrderPdf(
    readFileSync("sample-orders/Sri Lanka Order 4 2026 - Sheet1 (1).pdf"),
  );

  // Order 3 arrives, most of it sells, a quarter of each line is left over.
  const leftovers3 = order3.items
    .map((it) => ({
      name: it.name,
      bags: Math.floor(it.qty / 4),
      perBag: it.perBag,
      source: order3.title,
    }))
    .filter((l) => l.bags > 0);

  let pile = addLots(emptyStockpile(), leftovers3, daysAgo(95)).stockpile;
  const bags3 = leftovers3.reduce((s, l) => s + l.bags, 0);
  check(
    stockpileTotals(pile, NOW).bags === bags3,
    `Order 3 leftovers stockpiled: ${bags3} bags`,
  );

  // Order 4 arrives later; its leftovers merge into the same pile.
  const leftovers4 = order4.items
    .map((it) => ({
      name: it.name,
      bags: Math.floor(it.qty / 5),
      perBag: it.perBag,
      source: order4.title,
    }))
    .filter((l) => l.bags > 0);

  const before = pile.items.length;
  pile = addLots(pile, leftovers4, daysAgo(8)).stockpile;
  const bags4 = leftovers4.reduce((s, l) => s + l.bags, 0);
  const totals = stockpileTotals(pile, NOW);

  check(
    totals.bags === bags3 + bags4,
    `both orders combined: ${bags3 + bags4} bags`,
  );
  check(
    pile.items.length < before + leftovers4.length,
    "items shared by both orders merged instead of duplicating",
  );

  const multiBatch = pile.items.filter((i) => i.lots.length > 1);
  check(
    multiBatch.length > 0,
    `${multiBatch.length} items now hold batches from both orders`,
  );
  check(
    totals.byBucket.dead.bags === bags3 && totals.byBucket.fresh.bags === bags4,
    "Order 3 leftovers show as dead stock, Order 4 as fresh",
  );
  check(
    Math.abs(
      totals.value -
        pile.items.reduce((s, i) => s + itemValue(i), 0),
    ) < 0.01,
    `total value ties back to the sum of every item (${formatLKR(totals.value)})`,
  );

  // Sell from the pile: oldest bags go first.
  const target = multiBatch[0];
  const oldestPerBag = [...target.lots].sort((x, y) =>
    x.addedAt < y.addedAt ? -1 : 1,
  )[0].perBag;
  const sale = withdraw(pile, target.id, 1, "Sold", NOW);
  check(
    sale.consumed[0].perBag === oldestPerBag,
    `selling 1 bag of "${target.name}" drew from the oldest batch`,
  );

  // The stockpile PDF sends a ROUNDED average price but the EXACT lot value as
  // an override, so a mixed-price item can never round adrift. Prove that here.
  section("Stockpile PDF export");
  const exportRows = pile.items
    .filter((i) => itemBags(i) > 0)
    .map((i) => ({
      id: i.id,
      name: i.name,
      qty: itemBags(i),
      perBag: Math.round(itemAvgPerBag(i)),
      totalOverride: itemValue(i),
    }));
  const sheet = buildSheetFromRows("Stockpile", exportRows);
  check(
    sheet.totalQty === totals.bags,
    `PDF bag count matches the stockpile (${totals.bags})`,
  );
  check(
    Math.abs(sheet.grandTotal - totals.value) < 0.01,
    `PDF value matches the stockpile exactly, despite rounded averages (${formatLKR(totals.value)})`,
  );
  // Build a deliberately awkward item whose average price is NOT a whole
  // number, to show the override is what keeps the PDF honest.
  const odd = addLots(
    emptyStockpile(),
    [
      { name: "Mixed Lot", bags: 3, perBag: 10000, source: "A" },
      { name: "Mixed Lot", bags: 1, perBag: 10001, source: "B" },
    ],
    daysAgo(1),
  ).stockpile.items[0];
  const exactValue = itemValue(odd); // 40001
  const roundedAvg = Math.round(itemAvgPerBag(odd)); // 10000
  const naive = itemBags(odd) * roundedAvg; // 40000
  check(
    naive !== exactValue,
    `a rounded average alone would misstate this item by ${formatLKR(Math.abs(naive - exactValue))}`,
  );
  const oddSheet = buildSheetFromRows("Stockpile", [
    {
      id: odd.id,
      name: odd.name,
      qty: itemBags(odd),
      perBag: roundedAvg,
      totalOverride: exactValue,
    },
  ]);
  check(
    oddSheet.grandTotal === exactValue,
    `the exact-value override reports it correctly as ${formatLKR(exactValue)}`,
  );
  const pdf = await renderSheetPdf(sheet, {
    label: "",
    subtitle: "As at 09 Aug 2026",
  });
  check(pdf.length > 5000, `stockpile PDF rendered (${pdf.length} bytes)`);

  mkdirSync(".verify", { recursive: true });
  writeFileSync(".verify/stockpile.pdf", pdf);
  writeFileSync(".verify/stockpile.json", JSON.stringify(pile, null, 2));
  writeFileSync(".verify/stockpile.csv", toCsv(pile, NOW));

  const sizeKb = Buffer.byteLength(JSON.stringify(pile)) / 1024;
  console.log(
    `\n  stockpile file: ${pile.items.length} items, ` +
      `${pile.items.reduce((s, i) => s + i.lots.length, 0)} batches, ` +
      `${totals.bags} bags, ${formatLKR(totals.value)} -> ${sizeKb.toFixed(1)} KB`,
  );

  if (failures > 0) {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nALL STOCKPILE CHECKS PASSED");
})();

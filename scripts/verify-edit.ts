/**
 * Verifies the Order Editor pipeline:
 *   parse PDF -> editable rows -> edits + a bag sale + a manual total
 *   -> buildSheetFromRows -> rendered "Updated" PDF
 * Also renders a sales receipt from the sale log.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseOrderPdf } from "../src/lib/parseOrder";
import {
  buildSheetFromRows,
  computeRowTotal,
  formatLKR,
  type EditableRow,
} from "../src/lib/types";
import { renderSheetPdf } from "../src/lib/buyerPdf";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("  ok -", msg);
}

(async () => {
  mkdirSync(".verify", { recursive: true });

  const src = "sample-orders/Sri Lanka Order 3 2026 - Sheet1 (1).pdf";
  const parsed = await parseOrderPdf(readFileSync(src));
  console.log(`Loaded ${parsed.items.length} items, ${parsed.totalQty} bags`);

  // 1. Convert to editable rows
  let rows: EditableRow[] = parsed.items.map((it, i) => ({
    id: `r${i}`,
    name: it.name,
    qty: it.qty,
    perBag: it.perBag,
    totalOverride: null,
  }));
  const baseTotal = rows.reduce((s, r) => s + computeRowTotal(r), 0);
  assert(
    Math.abs(baseTotal - parsed.computedTotal) < 0.01,
    `editable rows preserve the sheet value (${formatLKR(baseTotal)})`,
  );

  // 2. Sell 10 bags of Blanket (62 -> 52)
  const blanketIdx = rows.findIndex((r) => r.name === "Blanket");
  assert(blanketIdx !== -1, "found the Blanket row");
  const blanket = rows[blanketIdx];
  const soldBags = 10;
  const saleValue = soldBags * blanket.perBag;
  rows[blanketIdx] = { ...blanket, qty: blanket.qty - soldBags };
  assert(
    rows[blanketIdx].qty === 52,
    `selling ${soldBags} bags leaves 52 in stock`,
  );
  assert(
    computeRowTotal(rows[blanketIdx]) === 52 * blanket.perBag,
    "row total recalculated after the sale",
  );

  // 3. Rename an item and change a price
  const renameIdx = rows.findIndex((r) => r.name === "Anorak 2");
  rows[renameIdx] = { ...rows[renameIdx], name: "Anorak (Heavy Grade)" };
  const priceIdx = rows.findIndex((r) => r.name === "Bed Sheet");
  const oldPerBag = rows[priceIdx].perBag;
  rows[priceIdx] = { ...rows[priceIdx], perBag: oldPerBag + 3000 };
  assert(
    rows[renameIdx].name === "Anorak (Heavy Grade)",
    "item name edit applied",
  );
  assert(
    computeRowTotal(rows[priceIdx]) ===
      rows[priceIdx].qty * (oldPerBag + 3000),
    "per-bag edit recalculates that row's total",
  );

  // 4. Manually override one total
  const ovIdx = rows.findIndex((r) => r.name === "Cardigan");
  rows[ovIdx] = { ...rows[ovIdx], totalOverride: 12345 };
  assert(
    computeRowTotal(rows[ovIdx]) === 12345,
    "manual total override is respected",
  );

  // 5. Add a new row, delete another
  rows.push({
    id: "new1",
    name: "Winter Jacket (new)",
    qty: 5,
    perBag: 28000,
    totalOverride: null,
  });
  const beforeDelete = rows.length;
  rows = rows.filter((r) => r.name !== "Towels");
  assert(rows.length === beforeDelete - 1, "row deletion works");

  // 6. Build the sheet and check the arithmetic
  const sheet = buildSheetFromRows("Sri Lanka Order 3 2026", rows);
  const expectedQty = rows.reduce((s, r) => s + r.qty, 0);
  const expectedTotal = rows.reduce((s, r) => s + computeRowTotal(r), 0);
  assert(sheet.totalQty === expectedQty, `bag count sums to ${expectedQty}`);
  assert(
    Math.abs(sheet.grandTotal - expectedTotal) < 0.01,
    `sheet value sums to ${formatLKR(expectedTotal)}`,
  );
  assert(
    sheet.rows.length === rows.length,
    `all ${rows.length} rows carried into the sheet`,
  );

  // 7. Render the updated PDF
  const updated = await renderSheetPdf(sheet, {
    label: "Updated",
    subtitle: "Updated 09 Aug 2026",
  });
  writeFileSync(".verify/updated.pdf", updated);
  assert(updated.length > 5000, `updated PDF rendered (${updated.length} bytes)`);

  // 8. Render a sales receipt from the sale
  const receipt = buildSheetFromRows("Sri Lanka Order 3 2026", [
    {
      id: "s1",
      name: "Blanket",
      qty: soldBags,
      perBag: blanket.perBag,
      totalOverride: null,
    },
  ]);
  assert(
    receipt.grandTotal === saleValue,
    `sales receipt totals ${formatLKR(saleValue)}`,
  );
  const salesPdf = await renderSheetPdf(receipt, {
    label: "Sales",
    subtitle: "Sales recorded 09 Aug 2026",
  });
  writeFileSync(".verify/sales.pdf", salesPdf);
  assert(salesPdf.length > 2000, `sales PDF rendered (${salesPdf.length} bytes)`);

  console.log("\nALL EDITOR CHECKS PASSED");
  console.log("expected updated grand total:", formatLKR(sheet.grandTotal));
  console.log("expected updated bags:", sheet.totalQty);
})();

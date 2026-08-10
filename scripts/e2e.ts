import { readFileSync, writeFileSync } from "node:fs";
import { parseOrderPdf } from "../src/lib/parseOrder";
import { buildBuyerPriceList, formatLKR } from "../src/lib/types";
import { renderBuyerPdf } from "../src/lib/buyerPdf";

async function run(path: string, markup: number) {
  const buf = readFileSync(path);
  const parsed = await parseOrderPdf(buf);
  console.log(`\n=== ${path} ===`);
  console.log("title:", parsed.title);
  console.log(
    "items:",
    parsed.items.length,
    "| bags:",
    parsed.totalQty,
    "| computed:",
    formatLKR(parsed.computedTotal),
    "| printed:",
    parsed.printedTotal !== null ? formatLKR(parsed.printedTotal) : "n/a",
    "| totalsMatch:",
    parsed.totalsMatch,
  );

  const buyer = buildBuyerPriceList(parsed, markup);
  console.log(
    `buyer(+${markup}): bags:`,
    buyer.totalQty,
    "| grandTotal:",
    formatLKR(buyer.grandTotal),
  );
  console.log("sample rows:");
  for (const r of buyer.rows.slice(0, 3)) {
    console.log(
      `  ${r.name} | ${r.qty} | ${formatLKR(r.perBag)} | ${formatLKR(r.total)}`,
    );
  }

  // Sanity: grandTotal should equal computedTotal + markup*bags
  const expected = parsed.computedTotal + markup * parsed.totalQty;
  const ok = Math.abs(expected - buyer.grandTotal) < 0.01;
  console.log("markup math correct:", ok, "(expected", formatLKR(expected) + ")");

  const pdf = await renderBuyerPdf(buyer);
  const out = `.verify/${parsed.title} - Buyer Price List.pdf`;
  writeFileSync(out, pdf);
  console.log("PDF bytes:", pdf.length, "->", out);
  return ok;
}

(async () => {
  const a = await run("sample-orders/Sri Lanka Order 3 2026 - Sheet1 (1).pdf", 2000);
  const b = await run("sample-orders/Sri Lanka Order 4 2026 - Sheet1 (1).pdf", 2000);
  if (!a || !b) {
    console.error("\nFAIL: markup math mismatch");
    process.exit(1);
  }
  console.log("\nALL CHECKS PASSED");
})();

/**
 * Verifies the Order Bag Lists module:
 *  - the random reduction hits the target exactly, never drops an item to zero
 *    and never increases a quantity
 *  - validation refuses impossible targets
 *  - the spreadsheet Total is a live SUM formula, not a number
 *  - the .xlsx and .pdf for one order carry identical data
 *  - no price reaches either file
 *  - CSV and XLSX orders can be imported
 *  - the API route behaves on both success and failure paths
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import ExcelJS from "exceljs";
import type { NextRequest } from "next/server";
import { parseOrderPdf } from "../src/lib/parseOrder";
import { parseCsvOrder, parseXlsxOrder } from "../src/lib/parseTabular";
import {
  checkTarget,
  createBagList,
  reduceToTarget,
  resolveBagList,
  sumQty,
  toBagItems,
  type BagItem,
} from "../src/lib/bagList";
import { buildBagListXlsx, totalFormula } from "../src/lib/bagListXlsx";
import { renderBagListPdf } from "../src/lib/bagListPdf";
import { POST as bagListPost } from "../src/app/api/bag-list/route";

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

const ORDER3 = "sample-orders/Sri Lanka Order 3 2026 - Sheet1 (1).pdf";
const ORDER4 = "sample-orders/Sri Lanka Order 4 2026 - Sheet1 (1).pdf";

function jsonReq(body: unknown): NextRequest {
  return new Request("http://localhost/api/bag-list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

/** Read a generated workbook back into plain values. */
async function readXlsx(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  const title = String(ws.getCell("A1").value ?? "");
  const header = [
    String(ws.getCell("A2").value ?? ""),
    String(ws.getCell("B2").value ?? ""),
  ];

  const items: BagItem[] = [];
  let row = 3;
  for (;;) {
    const name = ws.getCell(`A${row}`).value;
    if (name === null || name === undefined || String(name) === "") break;
    if (String(name).toLowerCase() === "total") break;
    items.push({ name: String(name), qty: Number(ws.getCell(`B${row}`).value) });
    row += 1;
  }
  const totalCell = ws.getCell(`B${row}`).value as
    | { formula?: string; result?: number }
    | number
    | null;

  return { title, header, items, totalRow: row, totalCell, sheetName: ws.name };
}

/** Pull the item lines out of a generated bag list PDF. */
async function readBagListPdfText(buf: Buffer): Promise<string> {
  const data = await pdfParse(buf, { version: "v2.0.550" });
  return String(data.text);
}

(async () => {
  mkdirSync(".verify", { recursive: true });

  const order3 = await parseOrderPdf(readFileSync(ORDER3));
  const order4 = await parseOrderPdf(readFileSync(ORDER4));

  /* ------------------------------ stripping ------------------------------ */
  section("Pricing is stripped at import");

  const list3 = createBagList(order3.title, order3.items);
  check(list3.title === "Sri Lanka Order 3 2026", `title kept: "${list3.title}"`);
  check(
    list3.items.length === 85 && sumQty(list3.items) === 733,
    `85 items, 733 bags carried over (got ${list3.items.length}, ${sumQty(list3.items)})`,
  );
  check(
    Object.keys(list3.items[0]).sort().join(",") === "name,qty",
    `an item holds only name and qty (${Object.keys(list3.items[0]).join(", ")})`,
  );
  check(
    !JSON.stringify(list3.items).includes("perBag"),
    "no per-bag price survives the conversion",
  );
  check(
    toBagItems([{ name: "Ghost", qty: 0 }])[0].qty === 1,
    "a zero quantity is raised to 1 so the manifest invariant holds",
  );
  check(
    toBagItems([{ name: "  ", qty: 5 }]).length === 0,
    "an unnamed row is dropped",
  );

  /* ------------------------------ validation ----------------------------- */
  section("Target validation");

  const v = (t: number | null) => checkTarget(list3.items, t);
  check(v(null).ok === false, "an empty target is refused");
  check(v(84).ok === false, "a target below the item count is refused (84 < 85)");
  check(
    (v(84).message ?? "").includes("one bag for each"),
    "the message explains the one-bag-per-item floor",
  );
  check(v(734).ok === false, "a target above the original total is refused (734 > 733)");
  check(
    (v(734).message ?? "").includes("only reduced"),
    "the message explains quantities are never increased",
  );
  check(v(520.5).ok === false, "a fractional target is refused");
  check(v(Number.NaN).ok === false, "a non-numeric target is refused");
  check(v(85).ok === true, "the minimum (85) is allowed");
  check(v(733).ok === true, "the original total (733) is allowed");
  check(v(520).ok === true, "a sensible target (520) is allowed");
  check(v(520).min === 85 && v(520).max === 733, "the allowed range is reported as 85-733");
  check(
    checkTarget([], 10).ok === false,
    "a list with no items is refused",
  );

  /* ------------------------------ reduction ------------------------------ */
  section("Random reduction");

  const target520 = reduceToTarget(list3.items, 520, 12345);
  check(sumQty(target520) === 520, `sums to exactly 520 (got ${sumQty(target520)})`);
  check(
    target520.every((i) => i.qty >= 1),
    "every item keeps at least one bag",
  );
  check(
    target520.length === list3.items.length,
    "no item is dropped from the list",
  );
  check(
    target520.every((it, i) => it.qty <= list3.items[i].qty),
    "no quantity was increased",
  );
  check(
    target520.every((it, i) => it.name === list3.items[i].name),
    "item names and order are preserved",
  );

  const again = reduceToTarget(list3.items, 520, 12345);
  check(
    JSON.stringify(again) === JSON.stringify(target520),
    "the same seed reproduces the same list exactly",
  );
  const other = reduceToTarget(list3.items, 520, 999);
  check(
    JSON.stringify(other) !== JSON.stringify(target520),
    "a different seed produces a different split",
  );
  check(sumQty(other) === 520, "the reshuffled split still totals 520");

  const floor = reduceToTarget(list3.items, 85, 7);
  check(
    floor.every((i) => i.qty === 1) && sumQty(floor) === 85,
    "targeting the minimum leaves exactly one bag per item",
  );
  const untouched = reduceToTarget(list3.items, 733, 7);
  check(
    JSON.stringify(untouched) === JSON.stringify(list3.items),
    "targeting the original total changes nothing",
  );

  // The reduction should spread across many lines rather than gutting a few.
  const touched = target520.filter((it, i) => it.qty < list3.items[i].qty).length;
  check(
    touched > 30,
    `the reduction is spread across the order (${touched} of 85 lines changed)`,
  );
  // Bigger lines should give up more than small ones, keeping the order's shape.
  const blanketIdx = list3.items.findIndex((i) => i.name === "Blanket");
  check(
    list3.items[blanketIdx].qty === 62 && target520[blanketIdx].qty < 62,
    `the largest line (Blanket 62) was reduced to ${target520[blanketIdx].qty}`,
  );

  let threw = false;
  try {
    reduceToTarget(list3.items, 10, 1);
  } catch {
    threw = true;
  }
  check(threw, "reducing below the item count throws rather than silently clamping");

  /* --------------------------- separate targets -------------------------- */
  section("Different targets for different orders");

  const listA = { ...createBagList(order3.title, order3.items), target: 520, seed: 42 };
  const listB = { ...createBagList(order4.title, order4.items), target: 515, seed: 43 };
  const rA = resolveBagList(listA);
  const rB = resolveBagList(listB);
  check(rA.total === 520, `${listA.title} totals 520 (got ${rA.total})`);
  check(rB.total === 515, `${listB.title} totals 515 (got ${rB.total})`);
  check(
    rA.reduced && rB.reduced,
    "both orders report as reduced independently",
  );
  const noTarget = resolveBagList({ ...listA, target: null });
  check(
    noTarget.total === 733 && !noTarget.reduced,
    "with no target the original quantities show through",
  );

  /* -------------------------------- xlsx --------------------------------- */
  section("Spreadsheet export");

  const xlsxBuf = await buildBagListXlsx({ title: listA.title, items: rA.items });
  writeFileSync(".verify/bag-list.xlsx", xlsxBuf);
  const sheet = await readXlsx(xlsxBuf);

  check(sheet.title === listA.title, `A1 holds the order title ("${sheet.title}")`);
  check(
    sheet.header[0] === "Item Name" && sheet.header[1] === "Quantity",
    "row 2 is the Item Name / Quantity header",
  );
  check(sheet.items.length === 85, `85 item rows written (got ${sheet.items.length})`);
  check(sheet.totalRow === 88, `the Total row lands on row 88 (got ${sheet.totalRow})`);

  const formula =
    typeof sheet.totalCell === "object" && sheet.totalCell
      ? sheet.totalCell.formula
      : undefined;
  check(
    typeof formula === "string",
    `the Total cell is a formula, not a hardcoded number (${JSON.stringify(sheet.totalCell)})`,
  );
  check(
    formula === "SUM(B3:B87)",
    `the formula is SUM(B3:B87) as required (got ${formula})`,
  );
  check(
    totalFormula(85) === "SUM(B3:B87)" && totalFormula(1) === "SUM(B3:B3)",
    "the formula range tracks the number of items",
  );
  check(
    sumQty(sheet.items) === 520,
    `the quantities in the sheet still total 520 (got ${sumQty(sheet.items)})`,
  );
  check(
    JSON.stringify(sheet.items) === JSON.stringify(rA.items),
    "every row matches the generated list exactly",
  );

  /* --------------------------------- pdf --------------------------------- */
  section("PDF export");

  const pdfBuf = await renderBagListPdf({
    title: listA.title,
    items: rA.items,
    total: rA.total,
  });
  writeFileSync(".verify/bag-list.pdf", pdfBuf);
  const pdfText = await readBagListPdfText(pdfBuf);

  check(pdfText.includes(listA.title), "the order title appears at the top");
  check(
    pdfText.includes("Item Name") && pdfText.includes("Quantity"),
    "the table header is Item Name / Quantity",
  );
  check(!/Per\s*Bag/i.test(pdfText), "there is no Per Bag column");
  check(!/Rs\s*[\d,]/.test(pdfText), "no money value appears anywhere in the PDF");
  check(
    pdfText.includes(`Total${rA.total}`) || pdfText.includes(`Total ${rA.total}`),
    `the Total row reads ${rA.total}`,
  );

  /* ------------------------- xlsx and pdf agree -------------------------- */
  section("The .xlsx and .pdf carry identical data");

  let mismatches = 0;
  for (const item of sheet.items) {
    // The PDF lays each row out as name followed by quantity.
    if (!pdfText.includes(`${item.name}${item.qty}`)) mismatches += 1;
  }
  check(
    mismatches === 0,
    `all 85 name+quantity pairs from the spreadsheet are present in the PDF (${mismatches} missing)`,
  );
  check(
    pdfText.includes(`Total${sumQty(sheet.items)}`),
    "both files agree on the grand total",
  );

  /* ------------------------------- imports ------------------------------- */
  section("CSV and XLSX imports");

  const csv = [
    "Sri Lanka Order 9 2026,,,",
    ",,,",
    "Item Name,Quantity,Per Bag,Total",
    '"Blanket, heavy",12,"Rs20,000.00","Rs240,000.00"',
    "Bed Sheet,4,Rs34000,Rs136000",
    "Anorak #2,3,17000,51000",
    ",,,",
    "Total,19,,Rs427000",
  ].join("\n");
  const csvOrder = parseCsvOrder(csv, "fallback");
  check(csvOrder.title === "Sri Lanka Order 9 2026", `CSV title read ("${csvOrder.title}")`);
  check(csvOrder.items.length === 3, `3 CSV rows parsed (got ${csvOrder.items.length})`);
  check(
    csvOrder.items[0].name === "Blanket, heavy" && csvOrder.items[0].qty === 12,
    "a quoted name containing a comma is handled",
  );
  check(csvOrder.totalQty === 19, `CSV quantities total 19 (got ${csvOrder.totalQty})`);
  check(csvOrder.totalsMatch, "the CSV Total row agrees with the parsed rows");

  const csvNoHeader = parseCsvOrder("Blanket,12,20000,240000\nBed Sheet,4,34000,136000", "Untitled");
  check(
    csvNoHeader.items.length === 2 && csvNoHeader.title === "Untitled",
    "a headerless CSV still parses, falling back to the file name",
  );

  // Round-trip: a bag list spreadsheet can be read straight back in.
  const reimported = await parseXlsxOrder(xlsxBuf, "fallback");
  check(
    reimported.items.length === 85,
    `an exported .xlsx re-imports as 85 items (got ${reimported.items.length})`,
  );
  check(
    reimported.totalQty === 520,
    `the re-imported total is 520 (got ${reimported.totalQty})`,
  );
  check(
    reimported.title === listA.title,
    `the re-imported title is "${reimported.title}"`,
  );

  /* ------------------------------ API route ------------------------------ */
  section("/api/bag-list");

  const apiXlsx = await bagListPost(
    jsonReq({ title: listA.title, format: "xlsx", items: rA.items }),
  );
  check(apiXlsx.status === 200, `xlsx request returns 200 (got ${apiXlsx.status})`);
  check(
    (apiXlsx.headers.get("content-type") ?? "").includes("spreadsheetml"),
    "the xlsx content type is a spreadsheet",
  );
  check(
    (apiXlsx.headers.get("content-disposition") ?? "").includes(
      'filename="Sri Lanka Order 3 2026 - Bag List.xlsx"',
    ),
    `the xlsx filename is correct (${apiXlsx.headers.get("content-disposition")})`,
  );
  const apiXlsxBuf = Buffer.from(await apiXlsx.arrayBuffer());
  const apiSheet = await readXlsx(apiXlsxBuf);
  check(
    JSON.stringify(apiSheet.items) === JSON.stringify(rA.items),
    "the route's spreadsheet matches the generated list",
  );

  const apiPdf = await bagListPost(
    jsonReq({ title: listA.title, format: "pdf", items: rA.items }),
  );
  check(apiPdf.status === 200, `pdf request returns 200 (got ${apiPdf.status})`);
  check(
    apiPdf.headers.get("content-type") === "application/pdf",
    "the pdf content type is application/pdf",
  );
  const apiPdfBuf = Buffer.from(await apiPdf.arrayBuffer());
  check(
    apiPdfBuf.subarray(0, 5).toString() === "%PDF-",
    "the pdf body really is a PDF",
  );

  // Both formats from the route must agree with each other too.
  const apiPdfText = await readBagListPdfText(apiPdfBuf);
  let apiMismatch = 0;
  for (const item of apiSheet.items) {
    if (!apiPdfText.includes(`${item.name}${item.qty}`)) apiMismatch += 1;
  }
  check(
    apiMismatch === 0,
    `the route's two formats agree on every row (${apiMismatch} mismatched)`,
  );

  for (const [body, label] of [
    [{ title: "T", format: "pdf", items: [] }, "an empty item list"],
    [{ title: "T", format: "pdf" }, "a missing item list"],
    [{ title: "T", format: "pdf", items: "nope" }, "items that are not a list"],
    [
      {
        title: "T",
        format: "pdf",
        items: Array.from({ length: 2001 }, () => ({ name: "X", qty: 1 })),
      },
      "more than 2000 items",
    ],
    [{ title: "T", format: "pdf", items: [{ name: "   ", qty: 3 }] }, "only unnamed items"],
  ] as Array<[unknown, string]>) {
    const res = await bagListPost(jsonReq(body));
    check(res.status === 400, `${label} is refused with 400 (got ${res.status})`);
  }

  const badJson = await bagListPost(
    new Request("http://localhost/api/bag-list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{oops",
    }) as unknown as NextRequest,
  );
  check(badJson.status === 500, `malformed JSON fails gracefully (got ${badJson.status})`);

  // A price smuggled into the payload must simply be ignored.
  const sneaky = await bagListPost(
    jsonReq({
      title: "Sneaky",
      format: "xlsx",
      items: [{ name: "Blanket", qty: 3, perBag: 20000, total: 60000 }],
    }),
  );
  const sneakySheet = await readXlsx(Buffer.from(await sneaky.arrayBuffer()));
  check(
    JSON.stringify(sneakySheet.items) === JSON.stringify([{ name: "Blanket", qty: 3 }]),
    "a price included in the request is discarded, not printed",
  );

  if (failures > 0) {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nALL BAG LIST CHECKS PASSED");
})();

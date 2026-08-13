/**
 * Verifies the Order Bag Manifests module:
 *  - pricing is removed at import, not hidden
 *  - container numbers are validated ISO 6346 style and stored uppercase
 *  - the random reduction hits the target exactly, never drops an item to zero
 *    and never increases a quantity
 *  - a generated distribution is persisted, so re-downloading is identical, and
 *    re-randomising is an explicit, separate action
 *  - the spreadsheet Total is a live SUM formula over the right range
 *  - the .xlsx and .pdf carry identical data and both show the container number
 *  - filenames follow "<Order Title> - <Container Number> - Bags.<ext>"
 *  - the API route refuses to export without a valid container number
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import ExcelJS from "exceljs";
import type { NextRequest } from "next/server";
import { parseOrderPdf } from "../src/lib/parseOrder";
import { parseCsvOrder, parseXlsxOrder } from "../src/lib/parseTabular";
import {
  checkTarget,
  clearGenerated,
  createManifest,
  generateManifest,
  manifestFilename,
  parseManifestDoc,
  reduceToTarget,
  resolveManifest,
  sumQty,
  toBagItems,
  type BagItem,
} from "../src/lib/bagManifest";
import {
  checkContainerNumber,
  containerCheckDigit,
  normalizeContainerNumber,
} from "../src/lib/container";
import { buildManifestXlsx, totalFormula } from "../src/lib/bagManifestXlsx";
import { renderManifestPdf } from "../src/lib/bagManifestPdf";
import { POST as manifestPost } from "../src/app/api/bag-manifest/route";

import { inflateRawSync } from "node:zlib";

const pdfParse = require("pdf-parse/lib/pdf-parse.js");

/**
 * Read one file out of a .xlsx (a zip) without extra dependencies.
 *
 * Checking the XML that actually ends up in the file is the only way to be sure
 * about a spreadsheet: ExcelJS does not read every property back, so asserting
 * against its reader can pass while the file itself is wrong.
 */
function readZipEntry(zip: Buffer, wanted: string): string | null {
  // Locate the end-of-central-directory record.
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;

  const entries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);

  for (let n = 0; n < entries; n += 1) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString();

    if (name === wanted) {
      const lNameLen = zip.readUInt16LE(localOffset + 26);
      const lExtraLen = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(start, start + compSize);
      return method === 0
        ? data.toString()
        : inflateRawSync(data).toString();
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

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
const CONTAINER = "GAOU7441740";

function jsonReq(body: unknown): NextRequest {
  return new Request("http://localhost/api/bag-manifest", {
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

  const items: BagItem[] = [];
  let row = 4;
  for (;;) {
    const name = ws.getCell(`A${row}`).value;
    if (name === null || name === undefined || String(name) === "") break;
    if (String(name).toLowerCase() === "total") break;
    items.push({ name: String(name), qty: Number(ws.getCell(`B${row}`).value) });
    row += 1;
  }

  return {
    orderNumber: String(ws.getCell("A1").value ?? ""),
    containerLine: String(ws.getCell("A2").value ?? ""),
    header: [
      String(ws.getCell("A3").value ?? ""),
      String(ws.getCell("B3").value ?? ""),
    ],
    items,
    totalRow: row,
    totalCell: ws.getCell(`B${row}`).value as
      | { formula?: string }
      | number
      | null,
  };
}

async function pdfText(buf: Buffer): Promise<string> {
  const data = await pdfParse(buf, { version: "v2.0.550" });
  return String(data.text);
}

(async () => {
  mkdirSync(".verify", { recursive: true });

  const order3 = await parseOrderPdf(readFileSync(ORDER3));
  const order4 = await parseOrderPdf(readFileSync(ORDER4));

  /* --------------------------- container numbers -------------------------- */
  section("Container numbers (ISO 6346)");

  const good = checkContainerNumber(CONTAINER);
  check(good.ok, `${CONTAINER} is accepted`);
  check(good.checkDigitValid, `${CONTAINER} has a valid check digit`);
  check(good.value === CONTAINER, "stored exactly as given");
  check(
    containerCheckDigit("GAOU744174") === 0,
    "the check digit for GAOU744174 computes as 0",
  );

  const messy = checkContainerNumber("  gaou 744174-0 ");
  check(
    messy.ok && messy.value === CONTAINER,
    `spaces, dashes and lower case are normalised ("${messy.value}")`,
  );

  const wrongDigit = checkContainerNumber("GAOU7441741");
  check(
    wrongDigit.ok && !wrongDigit.checkDigitValid,
    "a wrong check digit is flagged but not blocked",
  );
  check(
    wrongDigit.blocking === false,
    "a check digit mismatch never blocks an export",
  );
  check(
    (wrongDigit.message ?? "").includes("expected 0"),
    "the warning names the expected digit",
  );

  for (const [bad, why] of [
    ["", "an empty value"],
    ["GAOU744174", "only six digits"],
    ["GAO74417400", "only three letters"],
    ["GAOU74417400", "too long"],
    ["GA0U7441740", "a zero in the letter block"],
  ] as Array<[string, string]>) {
    const res = checkContainerNumber(bad);
    check(!res.ok && res.blocking, `${why} is rejected and blocks export`);
  }
  check(
    normalizeContainerNumber("gaou-744174-0-extra") === "GAOU7441740",
    "normalisation caps the length at 11 characters",
  );

  /* ------------------------------ stripping ------------------------------ */
  section("Pricing is stripped at import");

  const m3 = createManifest(order3.title, order3.items, CONTAINER);
  check(
    m3.orderNumber === "Sri Lanka Order 3 2026",
    `the imported heading becomes the order number: "${m3.orderNumber}"`,
  );
  check(m3.containerNumber === CONTAINER, "container number stored on the order");
  check(
    m3.items.length === 85 && sumQty(m3.items) === 733,
    `85 items, 733 bags carried over (got ${m3.items.length}, ${sumQty(m3.items)})`,
  );
  check(
    Object.keys(m3.items[0]).sort().join(",") === "name,qty",
    `an item holds only name and qty (${Object.keys(m3.items[0]).join(", ")})`,
  );
  check(
    !JSON.stringify(m3.items).includes("perBag"),
    "no per-bag price survives the conversion",
  );
  check(
    toBagItems([{ name: "Ghost", qty: 0 }])[0].qty === 1,
    "a zero quantity is raised to 1 so the manifest invariant holds",
  );

  /* ------------------------------ validation ----------------------------- */
  section("Target validation");

  const v = (t: number | null) => checkTarget(m3.items, t);
  check(!v(null).ok, "an empty target is refused");
  check(!v(84).ok, "a target below the item count is refused (84 < 85)");
  check(!v(734).ok, "a target above the current total is refused (734 > 733)");
  check(!v(520.5).ok, "a fractional target is refused");
  check(v(85).ok, "the minimum (85) is allowed");
  check(v(733).ok, "the current total (733) is allowed");
  check(v(520).ok && v(520).min === 85 && v(520).max === 733, "range reported as 85-733");

  /* ------------------------------ reduction ------------------------------ */
  section("Random reduction");

  const gen520 = generateManifest(m3, 520, 12345);
  const r520 = resolveManifest(gen520);
  check(r520.total === 520, `sums to exactly 520 (got ${r520.total})`);
  check(r520.items.every((i) => i.qty >= 1), "every item keeps at least one bag");
  check(r520.items.length === 85, "no item is dropped");
  check(
    r520.items.every((it, i) => it.qty <= m3.items[i].qty),
    "no quantity was increased",
  );
  check(
    r520.items.every((it, i) => it.name === m3.items[i].name),
    "item names and order are preserved",
  );
  const touched = r520.items.filter((it, i) => it.qty < m3.items[i].qty).length;
  check(touched > 30, `the reduction is spread across the order (${touched} of 85 lines)`);

  const floor = reduceToTarget(m3.items, 85, 7);
  check(
    floor.every((i) => i.qty === 1) && sumQty(floor) === 85,
    "targeting the minimum leaves exactly one bag per item",
  );
  check(
    JSON.stringify(reduceToTarget(m3.items, 733, 7)) === JSON.stringify(m3.items),
    "targeting the current total changes nothing",
  );

  let threw = false;
  try {
    reduceToTarget(m3.items, 10, 1);
  } catch {
    threw = true;
  }
  check(threw, "reducing below the item count throws rather than clamping");

  /* -------------------------- persisted distribution ---------------------- */
  section("The generated distribution is persisted");

  check(gen520.generated !== null, "generating stores the distribution");
  check(gen520.generatedAt !== null, "the generation time is recorded");
  check(
    JSON.stringify(resolveManifest(gen520).items) ===
      JSON.stringify(resolveManifest(gen520).items),
    "resolving twice yields the same figures",
  );

  // Survives a save/load cycle unchanged - this is what makes a re-download
  // reproduce the same document.
  const roundTripped = parseManifestDoc({
    manifests: [gen520],
  }).manifests[0];
  check(
    JSON.stringify(roundTripped.generated) === JSON.stringify(gen520.generated),
    "the stored distribution survives saving and reloading exactly",
  );
  check(
    roundTripped.containerNumber === CONTAINER,
    "the container number survives saving and reloading",
  );
  check(
    sumQty(roundTripped.generated ?? []) === 520,
    "the reloaded manifest still totals 520",
  );

  // A tampered store is not trusted.
  const tampered = parseManifestDoc({
    manifests: [{ ...gen520, generated: [{ name: "Only one", qty: 5 }] }],
  }).manifests[0];
  check(
    tampered.generated === null,
    "a stored distribution that no longer matches the order is discarded",
  );

  const rerolled = generateManifest(gen520, 520, 999);
  check(
    JSON.stringify(rerolled.generated) !== JSON.stringify(gen520.generated),
    "re-randomising produces a different split",
  );
  check(
    sumQty(rerolled.generated ?? []) === 520,
    "the re-randomised split still totals 520",
  );
  const cleared = clearGenerated(gen520);
  check(
    cleared.generated === null &&
      cleared.target === null &&
      resolveManifest(cleared).total === 733,
    "clearing returns the original quantities",
  );

  /* --------------------------- separate targets --------------------------- */
  section("Different targets for different orders");

  const mA = generateManifest(
    createManifest(order3.title, order3.items, CONTAINER),
    520,
    42,
  );
  const mB = generateManifest(
    createManifest(order4.title, order4.items, "MSCU1234565"),
    515,
    43,
  );
  check(resolveManifest(mA).total === 520, `${mA.orderNumber} totals 520`);
  check(resolveManifest(mB).total === 515, `${mB.orderNumber} totals 515`);
  check(
    mA.containerNumber !== mB.containerNumber,
    "each order carries its own container number",
  );

  /* -------------------------------- xlsx --------------------------------- */
  section("Spreadsheet export");

  const rA = resolveManifest(mA);
  const xlsxBuf = await buildManifestXlsx({
    orderNumber: mA.orderNumber,
    containerNumber: mA.containerNumber,
    items: rA.items,
  });
  writeFileSync(".verify/manifest.xlsx", xlsxBuf);
  const sheet = await readXlsx(xlsxBuf);

  check(
    sheet.orderNumber === mA.orderNumber,
    `row 1 is the order number ("${sheet.orderNumber}")`,
  );
  check(
    sheet.containerLine === `Container Number: ${CONTAINER}`,
    `row 2 is "${sheet.containerLine}"`,
  );
  check(
    sheet.header[0] === "Item Name" && sheet.header[1] === "Quantity",
    "row 3 is the Item Name / Quantity header",
  );
  check(sheet.items.length === 85, `85 item rows from row 4 (got ${sheet.items.length})`);
  check(sheet.totalRow === 89, `the Total row lands on row 89 (got ${sheet.totalRow})`);

  const formula =
    typeof sheet.totalCell === "object" && sheet.totalCell
      ? sheet.totalCell.formula
      : undefined;
  check(
    typeof formula === "string",
    `the Total cell is a formula, not a number (${JSON.stringify(sheet.totalCell)})`,
  );
  check(
    formula === "SUM(B4:B88)",
    `the formula is SUM(B4:B88) as required (got ${formula})`,
  );

  // A formula alone leaves the cell blank in Google Sheets, LibreOffice,
  // Numbers and most preview panes, which recalculate lazily or not at all.
  // The cached result must be written next to the formula, and Excel must be
  // told to recalculate on open so the formula stays authoritative.
  const cachedResult =
    typeof sheet.totalCell === "object" && sheet.totalCell
      ? (sheet.totalCell as { result?: unknown }).result
      : undefined;
  check(
    cachedResult === 520,
    `the Total cell carries a cached value so it is visible immediately (got ${JSON.stringify(cachedResult)})`,
  );
  // Inspect the XML inside the file itself, not ExcelJS's view of it.
  const workbookXml = readZipEntry(xlsxBuf, "xl/workbook.xml") ?? "";
  check(
    /fullCalcOnLoad="1"/.test(workbookXml),
    "the file tells the spreadsheet app to recalculate on open",
  );
  const sheetXml = readZipEntry(xlsxBuf, "xl/worksheets/sheet1.xml") ?? "";
  const totalRowXml = sheetXml.match(/<row r="89"[\s\S]*?<\/row>/)?.[0] ?? "";
  check(
    totalRowXml.includes("<f>SUM(B4:B88)</f>"),
    "the Total cell in the file holds the SUM formula",
  );
  check(
    /<v>520<\/v>/.test(totalRowXml),
    `the Total cell in the file also holds the value 520, so it is never blank (${totalRowXml.slice(-60)})`,
  );
  check(
    totalFormula(85) === "SUM(B4:B88)" && totalFormula(1) === "SUM(B4:B4)",
    "the formula range tracks the number of items",
  );
  check(
    sumQty(sheet.items) === 520,
    `the quantities in the sheet total 520 (got ${sumQty(sheet.items)})`,
  );
  check(
    JSON.stringify(sheet.items) === JSON.stringify(rA.items),
    "every row matches the generated manifest exactly",
  );
  check(
    !JSON.stringify(sheet).includes("Per Bag"),
    "the sheet has no Per Bag column",
  );

  /* --------------------------------- pdf --------------------------------- */
  section("PDF export");

  const pdfBuf = await renderManifestPdf({
    orderNumber: mA.orderNumber,
    containerNumber: mA.containerNumber,
    items: rA.items,
    total: rA.total,
  });
  writeFileSync(".verify/manifest.pdf", pdfBuf);
  const text = await pdfText(pdfBuf);

  check(text.includes(mA.orderNumber), "heading line 1 is the order number");
  check(
    text.includes(`Container Number: ${CONTAINER}`),
    "heading line 2 is the container number",
  );
  check(
    text.includes("Item Name") && text.includes("Quantity"),
    "the table header is Item Name / Quantity",
  );
  check(!/Per\s*Bag/i.test(text), "there is no Per Bag column");
  check(!/Rs\s*[\d,]/.test(text), "no money value appears anywhere");
  check(
    text.includes(`Total${rA.total}`) || text.includes(`Total ${rA.total}`),
    `the Total row reads ${rA.total}`,
  );

  // The header must reappear on every page, so it should occur once per page.
  const pages = (await pdfParse(pdfBuf, { version: "v2.0.550" })).numpages as number;
  const headerCount = text.split("Item Name").length - 1;
  check(pages > 1, `the manifest runs to ${pages} pages`);
  check(
    headerCount === pages,
    `the table header repeats on each of the ${pages} pages (found ${headerCount})`,
  );
  const headingCount = text.split(mA.orderNumber).length - 1;
  check(
    headingCount === pages,
    `the order number heads every one of the ${pages} pages (found ${headingCount})`,
  );
  const containerCount = text.split("Container Number:").length - 1;
  check(
    containerCount === pages,
    `the container number appears on every page (found ${containerCount})`,
  );

  /* ------------------------- xlsx and pdf agree -------------------------- */
  section("The .xlsx and .pdf carry identical data");

  let mismatches = 0;
  for (const item of sheet.items) {
    if (!text.includes(`${item.name}${item.qty}`)) mismatches += 1;
  }
  check(
    mismatches === 0,
    `all 85 name+quantity pairs match between the two files (${mismatches} missing)`,
  );
  check(
    text.includes(`Total${sumQty(sheet.items)}`),
    "both files agree on the grand total",
  );

  /* ------------------------------ filenames ------------------------------ */
  section("Filenames");

  check(
    manifestFilename("Sri Lanka Order 3 2026", CONTAINER, "xlsx") ===
      "Sri Lanka Order 3 2026 - GAOU7441740 - Bags.xlsx",
    "xlsx filename uses the order number",
  );
  check(
    manifestFilename("Sri Lanka Order 3 2026", CONTAINER, "pdf") ===
      "Sri Lanka Order 3 2026 - GAOU7441740 - Bags.pdf",
    "pdf filename uses the order number",
  );
  check(
    !manifestFilename('Order"/\\:*?<>|', CONTAINER, "pdf").match(/["/\\:*?<>|]/),
    "characters that are illegal in filenames are stripped",
  );

  /* ------------------------------- imports ------------------------------- */
  section("CSV and XLSX imports");

  const csv = [
    "Sri Lanka Order 9 2026,,,",
    ",,,",
    "Item Name,Quantity,Per Bag,Total",
    '"Blanket, heavy",12,"Rs20,000.00","Rs240,000.00"',
    "Bed Sheet,4,Rs34000,Rs136000",
    ",,,",
    "Total,16,,Rs376000",
  ].join("\n");
  const csvOrder = parseCsvOrder(csv, "fallback");
  check(csvOrder.title === "Sri Lanka Order 9 2026", `CSV title read ("${csvOrder.title}")`);
  check(csvOrder.items.length === 2, `2 CSV rows parsed (got ${csvOrder.items.length})`);
  check(
    csvOrder.items[0].name === "Blanket, heavy" && csvOrder.items[0].qty === 12,
    "a quoted name containing a comma is handled",
  );
  check(csvOrder.totalsMatch, "the CSV Total row agrees with the parsed rows");

  const reimported = await parseXlsxOrder(xlsxBuf, "fallback");
  check(
    reimported.items.length === 85 && reimported.totalQty === 520,
    `an exported manifest re-imports as 85 items / 520 bags (got ${reimported.items.length} / ${reimported.totalQty})`,
  );
  check(
    reimported.title === mA.orderNumber,
    `an exported manifest re-imports its order number as the heading ("${reimported.title}")`,
  );

  /* ------------------------------ API route ------------------------------ */
  section("/api/bag-manifest");

  const apiXlsx = await manifestPost(
    jsonReq({
      orderNumber: mA.orderNumber,
      containerNumber: CONTAINER,
      format: "xlsx",
      items: rA.items,
    }),
  );
  check(apiXlsx.status === 200, `xlsx request returns 200 (got ${apiXlsx.status})`);
  check(
    (apiXlsx.headers.get("content-type") ?? "").includes("spreadsheetml"),
    "the xlsx content type is a spreadsheet",
  );
  check(
    (apiXlsx.headers.get("content-disposition") ?? "").includes(
      'filename="Sri Lanka Order 3 2026 - GAOU7441740 - Bags.xlsx"',
    ),
    `the xlsx filename header is correct (${apiXlsx.headers.get("content-disposition")})`,
  );
  const apiSheet = await readXlsx(Buffer.from(await apiXlsx.arrayBuffer()));
  check(
    JSON.stringify(apiSheet.items) === JSON.stringify(rA.items),
    "the route's spreadsheet matches the stored manifest",
  );
  check(
    apiSheet.containerLine === `Container Number: ${CONTAINER}`,
    "the route's spreadsheet carries the container number",
  );

  const apiPdf = await manifestPost(
    jsonReq({
      orderNumber: mA.orderNumber,
      containerNumber: CONTAINER,
      format: "pdf",
      items: rA.items,
    }),
  );
  check(apiPdf.status === 200, `pdf request returns 200 (got ${apiPdf.status})`);
  check(
    (apiPdf.headers.get("content-disposition") ?? "").includes(
      'filename="Sri Lanka Order 3 2026 - GAOU7441740 - Bags.pdf"',
    ),
    "the pdf filename header is correct",
  );
  const apiPdfBuf = Buffer.from(await apiPdf.arrayBuffer());
  check(apiPdfBuf.subarray(0, 5).toString() === "%PDF-", "the pdf body really is a PDF");
  const apiText = await pdfText(apiPdfBuf);
  let apiMismatch = 0;
  for (const item of apiSheet.items) {
    if (!apiText.includes(`${item.name}${item.qty}`)) apiMismatch += 1;
  }
  check(
    apiMismatch === 0,
    `the route's two formats agree on every row (${apiMismatch} mismatched)`,
  );

  // Container number is required, and normalised on the way through.
  for (const [container, why] of [
    ["", "a missing container number"],
    ["GAOU744174", "a short container number"],
    ["NOTACONTAINER", "a malformed container number"],
  ] as Array<[string, string]>) {
    const res = await manifestPost(
      jsonReq({
        orderNumber: "Sri Lanka 01",
        containerNumber: container,
        format: "pdf",
        items: rA.items.slice(0, 3),
      }),
    );
    check(res.status === 400, `${why} is refused with 400 (got ${res.status})`);
  }
  const lower = await manifestPost(
    jsonReq({
      orderNumber: "Sri Lanka 01",
      containerNumber: "gaou-744174-0",
      format: "pdf",
      items: rA.items.slice(0, 3),
    }),
  );
  check(
    lower.status === 200 &&
      (lower.headers.get("content-disposition") ?? "").includes(CONTAINER),
    "a lower case container number is accepted and upper-cased in the filename",
  );

  // The order number is the heading, so a manifest cannot go out without one.
  for (const [orderNumber, why] of [
    ["", "a missing order number"],
    ["   ", "a whitespace-only order number"],
  ] as Array<[string, string]>) {
    const res = await manifestPost(
      jsonReq({
        orderNumber,
        containerNumber: CONTAINER,
        format: "pdf",
        items: rA.items.slice(0, 3),
      }),
    );
    check(res.status === 400, `${why} is refused with 400 (got ${res.status})`);
  }
  const sriLanka01 = await manifestPost(
    jsonReq({
      orderNumber: "Sri Lanka 01",
      containerNumber: CONTAINER,
      format: "xlsx",
      items: rA.items.slice(0, 3),
    }),
  );
  check(
    sriLanka01.status === 200 &&
      (sriLanka01.headers.get("content-disposition") ?? "").includes(
        'filename="Sri Lanka 01 - GAOU7441740 - Bags.xlsx"',
      ),
    `the "Sri Lanka 01" format works end to end (${sriLanka01.headers.get("content-disposition")})`,
  );
  const sriLankaSheet = await readXlsx(
    Buffer.from(await sriLanka01.arrayBuffer()),
  );
  check(
    sriLankaSheet.orderNumber === "Sri Lanka 01",
    `row 1 of that sheet reads "${sriLankaSheet.orderNumber}"`,
  );

  for (const [body, why] of [
    [
      { orderNumber: "Sri Lanka 01", containerNumber: CONTAINER, items: [] },
      "an empty item list",
    ],
    [
      { orderNumber: "Sri Lanka 01", containerNumber: CONTAINER },
      "a missing item list",
    ],
    [
      { orderNumber: "Sri Lanka 01", containerNumber: CONTAINER, items: "nope" },
      "items that are not a list",
    ],
    [
      {
        orderNumber: "Sri Lanka 01",
        containerNumber: CONTAINER,
        items: Array.from({ length: 2001 }, () => ({ name: "X", qty: 1 })),
      },
      "more than 2000 items",
    ],
  ] as Array<[unknown, string]>) {
    const res = await manifestPost(jsonReq(body));
    check(res.status === 400, `${why} is refused with 400 (got ${res.status})`);
  }

  const badJson = await manifestPost(
    new Request("http://localhost/api/bag-manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{oops",
    }) as unknown as NextRequest,
  );
  check(badJson.status === 500, `malformed JSON fails gracefully (got ${badJson.status})`);

  // A price smuggled into the payload must simply be ignored.
  const sneaky = await manifestPost(
    jsonReq({
      orderNumber: "Sri Lanka 01",
      containerNumber: CONTAINER,
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
  console.log("\nALL BAG MANIFEST CHECKS PASSED");
})();

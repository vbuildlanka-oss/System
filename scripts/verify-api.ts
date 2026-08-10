/**
 * Exercises the three API routes through their real request/response contract:
 * FormData uploads, JSON bodies, status codes and response headers - including
 * every rejection path.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { POST as processPost } from "../src/app/api/process/route";
import { POST as generatePost } from "../src/app/api/generate/route";
import { POST as exportPost } from "../src/app/api/export/route";
import {
  buildSheetFromRows,
  clampNumber,
  formatLKR,
  LIMITS,
} from "../src/lib/types";
import { sanitizeLine } from "../src/lib/buyer";
import { renderSheetPdf } from "../src/lib/buyerPdf";
import type { NextRequest } from "next/server";

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

function jsonReq(body: unknown): NextRequest {
  return new Request("http://localhost/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function rawReq(body: string): NextRequest {
  return new Request("http://localhost/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }) as unknown as NextRequest;
}

function fileReq(
  bytes: Uint8Array,
  name: string,
  type: string,
  field = "file",
): NextRequest {
  const fd = new FormData();
  fd.append(field, new File([bytes as unknown as BlobPart], name, { type }));
  return new Request("http://localhost/api", {
    method: "POST",
    body: fd,
  }) as unknown as NextRequest;
}

async function isPdf(res: Response): Promise<boolean> {
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.subarray(0, 5).toString() === "%PDF-";
}

(async () => {
  mkdirSync(".verify", { recursive: true });
  const orderBytes = readFileSync(ORDER3);

  /* ------------------------- low-level guardrails ------------------------- */
  section("Guardrails");

  check(formatLKR(Number.NaN) === "Rs0.00", "NaN never prints as RsNaN");
  check(
    formatLKR(Number.POSITIVE_INFINITY) === "Rs0.00",
    "Infinity never prints on a document",
  );
  check(formatLKR(1234567.5) === "Rs1,234,567.50", "normal amounts format correctly");

  check(clampNumber("abc", 100) === 0, "text clamps to 0");
  check(clampNumber(-5, 100) === 0, "negatives clamp to 0");
  check(clampNumber(null, 100) === 0, "null clamps to 0");
  check(clampNumber(Number.NaN, 100) === 0, "NaN clamps to 0");
  // Infinity is treated as unusable rather than capped: on a money field,
  // silently substituting the ceiling would be a misleading figure.
  check(clampNumber(1e999, 100) === 0, "Infinity clamps to 0, not the maximum");
  check(clampNumber(250, 100) === 100, "values above the maximum are capped");
  check(clampNumber("42", 100) === 42, "numeric strings are accepted");

  check(sanitizeLine({ a: 1 }, 50) === "", "objects never become [object Object]");
  check(sanitizeLine([1, 2], 50) === "", "arrays are rejected as text");
  check(sanitizeLine(true, 50) === "", "booleans are rejected as text");
  check(sanitizeLine(2026, 50) === "2026", "numbers are usable as text");
  check(
    sanitizeLine("  a\u0000b\nc  ", 50) === "a b c",
    "control characters and newlines are collapsed",
  );
  check(sanitizeLine("x".repeat(99), 10).length === 10, "text is capped to the limit");

  /* ----------------------------- /api/process ---------------------------- */
  section("/api/process - upload and parse");

  const okRes = await processPost(
    fileReq(orderBytes, "order.pdf", "application/pdf"),
  );
  check(okRes.status === 200, `valid PDF returns 200 (got ${okRes.status})`);
  const parsed = await okRes.json();
  check(parsed.items?.length === 85, `85 items parsed (got ${parsed.items?.length})`);
  check(parsed.totalQty === 733, `733 bags (got ${parsed.totalQty})`);
  check(parsed.totalsMatch === true, "totals verified against the source PDF");

  const txtRes = await processPost(
    fileReq(Buffer.from("not a pdf"), "notes.txt", "text/plain"),
  );
  check(txtRes.status === 400, `a .txt upload is refused with 400 (got ${txtRes.status})`);
  check(
    (await txtRes.json()).error?.includes("PDF"),
    "the error message names the problem",
  );

  const noFileRes = await processPost(
    new Request("http://localhost/api", {
      method: "POST",
      body: new FormData(),
    }) as unknown as NextRequest,
  );
  check(noFileRes.status === 400, `a form with no file is refused (got ${noFileRes.status})`);

  const wrongFieldRes = await processPost(
    fileReq(orderBytes, "order.pdf", "application/pdf", "document"),
  );
  check(
    wrongFieldRes.status === 400,
    `a mis-named form field is refused (got ${wrongFieldRes.status})`,
  );

  const bigRes = await processPost(
    fileReq(Buffer.alloc(16 * 1024 * 1024, 1), "huge.pdf", "application/pdf"),
  );
  check(bigRes.status === 400, `a 16 MB upload is refused (got ${bigRes.status})`);
  check(
    (await bigRes.json()).error?.toLowerCase().includes("large"),
    "the size error explains the limit",
  );

  const junkRes = await processPost(
    fileReq(Buffer.from("%PDF-1.4 then total rubbish"), "bad.pdf", "application/pdf"),
  );
  check(
    junkRes.status >= 400 && junkRes.status < 600,
    `a corrupt PDF fails gracefully with ${junkRes.status}, not a crash`,
  );
  check(
    typeof (await junkRes.json()).error === "string",
    "a corrupt PDF still returns a readable error",
  );

  // A real PDF that contains no item rows should be reported, not silently
  // accepted as an empty order.
  const emptySheet = await renderSheetPdf(
    buildSheetFromRows("Empty Sheet", []),
    { label: "Updated" },
  );
  const emptyRes = await processPost(
    fileReq(emptySheet, "empty.pdf", "application/pdf"),
  );
  check(
    emptyRes.status === 422,
    `a PDF with no item rows returns 422 (got ${emptyRes.status})`,
  );

  /* --------------------------- round-trip safety -------------------------- */
  // Re-uploading a sheet that BaleBook produced is a normal thing to do, so the
  // parser must be able to read its own output at any size. The default pdf.js
  // engine intermittently rejected small documents, hence these checks.
  section("Round-trip - BaleBook re-reading its own PDFs");

  const rtRows = (parsed.items as Array<{ name: string; qty: number; perBag: number }>).map(
    (it, i) => ({
      id: String(i),
      name: it.name,
      qty: it.qty,
      perBag: it.perBag,
      totalOverride: null,
    }),
  );

  for (const [n, label] of [
    [0, "an empty sheet"],
    [1, "a single-item sheet"],
    [2, "a two-item sheet"],
    [85, "a full 85-item sheet"],
  ] as Array<[number, string]>) {
    const generated = await renderSheetPdf(
      buildSheetFromRows("Round Trip", rtRows.slice(0, n)),
      { label: "Updated" },
    );
    const res = await processPost(
      fileReq(generated, "generated.pdf", "application/pdf"),
    );
    if (n === 0) {
      check(res.status === 422, `${label} is reported as having no items (got ${res.status})`);
    } else {
      const body = res.status === 200 ? await res.json() : null;
      check(
        res.status === 200 && body?.items?.length === n,
        `${label} re-parses to ${n} items (status ${res.status}, items ${body?.items?.length ?? "-"})`,
      );
    }
  }

  /* ---------------------------- /api/generate ---------------------------- */
  section("/api/generate - buyer price list");

  const items = parsed.items as Array<{ name: string; qty: number; perBag: number }>;

  const genOk = await generatePost(
    jsonReq({
      title: "Sri Lanka Order 3 2026",
      markup: 2000,
      items,
      buyer: { name: "Ahmad Trading", phone: "0771234567" },
      refNo: "BB-260809-001",
    }),
  );
  check(genOk.status === 200, `valid request returns 200 (got ${genOk.status})`);
  check(
    genOk.headers.get("content-type") === "application/pdf",
    "content-type is application/pdf",
  );
  const disp = genOk.headers.get("content-disposition") ?? "";
  check(
    disp.includes('filename="Sri Lanka Order 3 2026 - Buyer Price List.pdf"'),
    `filename header is correct (${disp})`,
  );
  check(
    genOk.headers.get("cache-control") === "no-store",
    "the response is not cached",
  );
  check(await isPdf(genOk), "the body really is a PDF");

  for (const [markup, label] of [
    [-500, "negative markup"],
    ["abc", "non-numeric markup"],
    [null, "null markup"],
    [Number.POSITIVE_INFINITY, "infinite markup"],
    [LIMITS.markup + 1, "absurdly large markup"],
  ] as Array<[unknown, string]>) {
    const res = await generatePost(
      jsonReq({ title: "T", markup, items: items.slice(0, 2) }),
    );
    check(res.status === 400, `${label} is refused with 400 (got ${res.status})`);
  }

  const noItems = await generatePost(jsonReq({ title: "T", markup: 2000, items: [] }));
  check(noItems.status === 400, `an empty item list is refused (got ${noItems.status})`);

  const notArray = await generatePost(
    jsonReq({ title: "T", markup: 2000, items: "nope" }),
  );
  check(notArray.status === 400, `items that are not a list are refused (got ${notArray.status})`);

  const tooMany = await generatePost(
    jsonReq({
      title: "T",
      markup: 2000,
      items: Array.from({ length: LIMITS.rows + 1 }, () => ({
        name: "X",
        qty: 1,
        perBag: 1000,
      })),
    }),
  );
  check(tooMany.status === 400, `over ${LIMITS.rows} items is refused (got ${tooMany.status})`);

  const badJson = await generatePost(rawReq("{ not valid json"));
  check(badJson.status === 500, `malformed JSON fails gracefully (got ${badJson.status})`);
  check(
    typeof (await badJson.json()).error === "string",
    "malformed JSON returns a readable error",
  );

  // Garbage row values must be clamped, never printed as NaN.
  const garbage = await generatePost(
    jsonReq({
      title: "Garbage Test",
      markup: 2000,
      items: [
        { name: null, qty: "abc", perBag: undefined },
        { name: "  Spaced\u0007Name\n\n ", qty: -50, perBag: "1e999" },
        { name: "x".repeat(500), qty: 1.5, perBag: 20000 },
      ],
    }),
  );
  check(garbage.status === 200, `garbage rows are cleaned rather than rejected (got ${garbage.status})`);
  const garbageBuf = Buffer.from(await garbage.arrayBuffer());
  writeFileSync(".verify/api-garbage.pdf", garbageBuf);
  check(garbageBuf.subarray(0, 5).toString() === "%PDF-", "the cleaned result is still a valid PDF");

  // A hostile title must not be able to break the download header.
  const nastyTitle = await generatePost(
    jsonReq({
      title: 'Order"; DROP\r\nX-Injected: yes',
      markup: 2000,
      items: items.slice(0, 2),
    }),
  );
  const nastyDisp = nastyTitle.headers.get("content-disposition") ?? "";
  check(
    !nastyDisp.includes("\n") &&
      !nastyDisp.includes("\r") &&
      (nastyDisp.match(/"/g) ?? []).length === 2,
    `quotes and newlines are stripped from the filename header (${nastyDisp})`,
  );
  check(
    !(nastyTitle.headers.get("x-injected") === "yes"),
    "no header could be injected through the title",
  );

  /* ----------------------------- /api/export ----------------------------- */
  section("/api/export - edited sheet and stockpile");

  const expOk = await exportPost(
    jsonReq({
      title: "Sri Lanka Order 3 2026",
      label: "Updated",
      subtitle: "Updated 09 Aug 2026",
      rows: [
        { name: "Blanket", qty: 52, perBag: 22000, totalOverride: null },
        { name: "Bed Sheet", qty: 4, perBag: 36000, totalOverride: null },
      ],
      buyer: { name: "Ahmad Trading", phone: "0771234567" },
      refNo: "BB-260809-002",
    }),
  );
  check(expOk.status === 200, `valid export returns 200 (got ${expOk.status})`);
  check(
    (expOk.headers.get("content-disposition") ?? "").includes(
      'filename="Sri Lanka Order 3 2026 - Updated.pdf"',
    ),
    "the export filename includes the label",
  );
  check(await isPdf(expOk), "the export body is a PDF");

  const noLabel = await exportPost(
    jsonReq({
      title: "Stockpile",
      label: "",
      rows: [{ name: "Blanket", qty: 5, perBag: 22000, totalOverride: null }],
    }),
  );
  check(
    (noLabel.headers.get("content-disposition") ?? "").includes(
      'filename="Stockpile.pdf"',
    ),
    "an empty label produces a clean filename",
  );

  const expEmpty = await exportPost(jsonReq({ title: "T", rows: [] }));
  check(expEmpty.status === 400, `an empty row list is refused (got ${expEmpty.status})`);

  const expNoRows = await exportPost(jsonReq({ title: "T" }));
  check(expNoRows.status === 400, `a missing row list is refused (got ${expNoRows.status})`);

  const expTooMany = await exportPost(
    jsonReq({
      title: "T",
      rows: Array.from({ length: LIMITS.rows + 1 }, () => ({
        name: "X",
        qty: 1,
        perBag: 1,
      })),
    }),
  );
  check(expTooMany.status === 400, `over ${LIMITS.rows} rows is refused (got ${expTooMany.status})`);

  const expBadJson = await exportPost(rawReq("]["));
  check(expBadJson.status === 500, `malformed JSON fails gracefully (got ${expBadJson.status})`);

  // The stockpile relies on totalOverride carrying an exact value.
  const overrideRes = await exportPost(
    jsonReq({
      title: "Stockpile",
      label: "",
      rows: [{ name: "Mixed Lot", qty: 4, perBag: 10000, totalOverride: 40001 }],
    }),
  );
  const overrideBuf = Buffer.from(await overrideRes.arrayBuffer());
  writeFileSync(".verify/api-override.pdf", overrideBuf);
  check(overrideRes.status === 200, "an exact-value override is accepted");

  const expGarbage = await exportPost(
    jsonReq({
      title: 12345,
      label: { bad: true },
      rows: [
        null,
        { name: 999, qty: "x", perBag: null, totalOverride: "abc" },
        { name: "Fine", qty: 2, perBag: 1000, totalOverride: undefined },
      ],
    }),
  );
  check(
    expGarbage.status === 200,
    `garbage export payload is cleaned rather than crashing (got ${expGarbage.status})`,
  );
  const expGarbageBuf = Buffer.from(await expGarbage.arrayBuffer());
  writeFileSync(".verify/api-export-garbage.pdf", expGarbageBuf);
  check(
    expGarbageBuf.subarray(0, 5).toString() === "%PDF-",
    "the cleaned export is still a valid PDF",
  );

  if (failures > 0) {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nALL API CHECKS PASSED");
})();

/**
 * Reading PDFs: why an upload failed, and saying something true about it.
 *
 * This suite exists because of a real complaint - a good PDF would be called
 * corrupted, and re-uploading it did nothing until the page was refreshed.
 * Two separate faults were behind that, and both are pinned down here:
 *
 *   1. pdf-parse caches its engine in a module-level variable, so its `version`
 *      option only works on the first call in a process. The four-engine
 *      fallback in parseOrder.ts was asking for four engines and being handed
 *      the same one four times, so there was no fallback at all.
 *   2. The file input was not cleared after a failed read, so choosing the same
 *      file again fired no change event and the retry did nothing.
 */
import { readFileSync, readdirSync } from "node:fs";
import * as React from "react";
import { Document, Page, View, renderToBuffer } from "@react-pdf/renderer";
import { parseOrderPdf, PdfReadError } from "../src/lib/parseOrder";
import { POST as processPost } from "../src/app/api/process/route";
import { renderCountPdf } from "../src/lib/counterPdf";
import {
  fromOrderItems,
  setCount,
} from "../src/lib/counter";
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

function fileReq(bytes: Uint8Array, name: string): NextRequest {
  const fd = new FormData();
  fd.append(
    "file",
    new File([bytes as unknown as BlobPart], name, { type: "application/pdf" }),
  );
  return new Request("http://localhost/api/process", {
    method: "POST",
    body: fd,
  }) as unknown as NextRequest;
}

/** Run parseOrderPdf and report how it failed, if it did. */
async function failureOf(bytes: Buffer): Promise<string> {
  try {
    await parseOrderPdf(bytes);
    return "no-error";
  } catch (err) {
    if (err instanceof PdfReadError) return err.failure;
    return `other: ${(err as Error).message}`;
  }
}

async function messageOf(bytes: Buffer): Promise<string> {
  try {
    await parseOrderPdf(bytes);
    return "";
  } catch (err) {
    return err instanceof PdfReadError ? err.userMessage : (err as Error).message;
  }
}

async function main() {
  const order = readFileSync(ORDER3);

  /* ------------------------------------------------------------------ */
  section("a good PDF is still read exactly as before");

  const parsed = await parseOrderPdf(order);
  check(parsed.items.length === 85, `85 items (got ${parsed.items.length})`);
  check(parsed.totalQty === 733, `733 bags (got ${parsed.totalQty})`);
  check(parsed.totalsMatch === true, "the printed total still verifies");

  // Reading the same file repeatedly must not degrade. The engine is cached
  // between calls, which is exactly where a stale-state bug would show up.
  let repeats = 0;
  for (let i = 0; i < 6; i++) {
    const again = await parseOrderPdf(readFileSync(ORDER3));
    if (again.items.length === 85 && again.totalQty === 733) repeats++;
  }
  check(repeats === 6, `six consecutive reads all agree (${repeats}/6)`);

  /* ------------------------------------------------------------------ */
  section("a half-downloaded file is not called corrupt");

  // Chop the tail off a genuinely good PDF: this is what an upload started
  // before the download finished looks like.
  const truncated = Buffer.from(order.subarray(0, Math.floor(order.length * 0.7)));
  check(
    (await failureOf(truncated)) === "incomplete",
    `a truncated PDF reports "incomplete" (got ${await failureOf(truncated)})`,
  );
  const truncMsg = await messageOf(truncated);
  check(
    /incomplete/i.test(truncMsg),
    `and says the file is incomplete (${JSON.stringify(truncMsg.slice(0, 60))})`,
  );
  check(
    /still downloading|wait/i.test(truncMsg),
    "and tells the user to let the download finish",
  );
  check(
    !/corrupt/i.test(truncMsg),
    "without calling a perfectly good file corrupt",
  );

  // Losing only the trailer is the same fault, and is caught the same way.
  const noEof = Buffer.from(order.subarray(0, order.length - 8));
  check(
    (await failureOf(noEof)) === "incomplete",
    `a PDF missing just its %%EOF reports "incomplete" (got ${await failureOf(noEof)})`,
  );

  /* ------------------------------------------------------------------ */
  section("something that was never a PDF");

  const html = Buffer.from(
    "<!doctype html><html><body>504 Gateway Time-out</body></html>",
  );
  check(
    (await failureOf(html)) === "not-a-pdf",
    `an HTML error page saved as .pdf reports "not-a-pdf" (got ${await failureOf(html)})`,
  );
  check(
    /not a PDF/i.test(await messageOf(html)),
    "and says so plainly",
  );

  // A header and a trailer, but nothing usable in between: this one really is
  // damaged, and is allowed to say so.
  const damaged = Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    Buffer.alloc(4096, 0x41),
    Buffer.from("\n%%EOF\n"),
  ]);
  const damagedFailure = await failureOf(damaged);
  check(
    damagedFailure === "unreadable" || damagedFailure === "no-error",
    `a damaged body reports "unreadable" or degrades to no items (got ${damagedFailure})`,
  );

  /* ------------------------------------------------------------------ */
  section("a scan has no text, which is not a failure");

  // A real PDF with no text in it at all - a black box on a page. This is what
  // a scanned sheet amounts to as far as text extraction goes. It must come
  // back empty rather than throwing, so the caller can say "no items found".
  const imageOnly = Buffer.from(
    await renderToBuffer(
      React.createElement(
        Document,
        null,
        React.createElement(
          Page,
          { size: "A4" },
          React.createElement(View, {
            style: { width: 200, height: 200, backgroundColor: "#111827" },
          }),
        ),
      ) as never,
    ),
  );
  let scanThrew: string | null = null;
  let scanItems = -1;
  try {
    scanItems = (await parseOrderPdf(imageOnly)).items.length;
  } catch (err) {
    scanThrew = (err as Error).message;
  }
  check(scanThrew === null, `a text-free PDF does not throw (${scanThrew ?? "ok"})`);
  check(scanItems === 0, `and yields no items (got ${scanItems})`);

  const scanRes = await processPost(fileReq(imageOnly, "scan.pdf"));
  check(
    scanRes.status === 422,
    `the route answers 422 for a scan, not 500 (got ${scanRes.status})`,
  );
  check(
    /could not read any items/i.test((await scanRes.json()).error ?? ""),
    "telling the user there were no items to find",
  );

  /* ------------------------------------------------------------------ */
  section("the route reports the reason, not a guess");

  const truncRes = await processPost(fileReq(truncated, "order.pdf"));
  check(
    truncRes.status === 400,
    `an incomplete upload is a 400, not a 500 (got ${truncRes.status})`,
  );
  const truncBody = (await truncRes.json()).error ?? "";
  check(
    /incomplete/i.test(truncBody) && !/corrupt/i.test(truncBody),
    `and the message says incomplete rather than corrupt (${JSON.stringify(truncBody.slice(0, 50))})`,
  );

  const htmlRes = await processPost(fileReq(html, "order.pdf"));
  check(htmlRes.status === 400, `a non-PDF is a 400 (got ${htmlRes.status})`);

  const goodRes = await processPost(fileReq(order, "Sri Lanka Order 3 2026.pdf"));
  check(goodRes.status === 200, `a good PDF is still a 200 (got ${goodRes.status})`);

  /* ------------------------------------------------------------------ */
  section("the app's own count PDF still round-trips");

  let doc = fromOrderItems(
    [
      { name: "3/4 Ladies Jeans", qty: 12 },
      { name: "Anorak #2", qty: 9 },
      { name: "Blanket", qty: 3 },
    ],
    "GAOU7441740",
    "Sri Lanka 07",
  );
  for (const row of doc.rows) doc = setCount(doc, row.id, row.expected);
  const countPdf = Buffer.from(await renderCountPdf(doc));

  const back = await parseOrderPdf(countPdf);
  check(back.items.length === 3, `3 counted items read back (got ${back.items.length})`);
  check(
    back.items.find((i) => i.name === "Anorak #2")?.qty === 9,
    "and a name ending in a digit keeps its count",
  );

  /* ------------------------------------------------------------------ */
  section("the fallback is a real fallback");

  // Guard on the third-party bug the workaround exists for. pdf-parse caches
  // its engine module-wide, so the second request for a different version is
  // ignored. If this ever starts failing, pdf-parse has been fixed and
  // parseOrder.ts can go back to using it directly.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfParse = require("pdf-parse/lib/pdf-parse.js");
  const first = await pdfParse(readFileSync(ORDER3), { version: "v1.10.100" });
  const second = await pdfParse(readFileSync(ORDER3), { version: "v1.9.426" });
  check(
    first.version === second.version,
    `pdf-parse still ignores its own version option (${first.version} then ${second.version}) - which is why we load the engines ourselves`,
  );

  // Ours are four genuinely different engines, each of which can read a sheet.
  const versions = ["v1.10.100", "v2.0.550", "v1.10.88", "v1.9.426"];
  const reported = new Set<string>();
  let readable = 0;
  for (const v of versions) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const engine = require(`pdf-parse/lib/pdf.js/${v}/build/pdf.js`);
    engine.disableWorker = true;
    reported.add(engine.version);
    const d = await engine.getDocument(new Uint8Array(readFileSync(ORDER3)));
    const page = await d.getPage(1);
    const content = await page.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    });
    if (content.items.length > 0) readable++;
    d.destroy();
  }
  check(
    reported.size === 4,
    `four distinct engines are available (${Array.from(reported).join(", ")})`,
  );
  check(readable === 4, `and all four can read a supplier sheet (${readable}/4)`);

  // Loading the others must not break the one we normally use: they each set a
  // global, so this is worth holding down.
  const afterAll = await parseOrderPdf(readFileSync(ORDER3));
  check(
    afterAll.items.length === 85 && afterAll.totalQty === 733,
    `the default engine still works after the others load (${afterAll.items.length} items, ${afterAll.totalQty} bags)`,
  );

  /* ------------------------------------------------------------------ */
  section("a failed upload can be retried without reloading the page");

  // The retry was a no-op because the file input kept its value, so picking the
  // same file again fired no change event. There is no DOM here, so this is
  // held down at the source: every page with a file input must clear it.
  const pages = readdirSync("src/app", { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name === "page.tsx")
    .map((e) => `${e.parentPath ?? (e as unknown as { path: string }).path}/${e.name}`);

  let checkedPages = 0;
  for (const file of pages) {
    const src = readFileSync(file, "utf8");
    const inputs = (src.match(/type="file"/g) ?? []).length;
    if (inputs === 0) continue;
    checkedPages++;
    const resets = (src.match(/\.value = ""/g) ?? []).length;
    check(
      resets >= inputs,
      `${file.replace("src/app/", "")}: ${inputs} file input${inputs === 1 ? "" : "s"}, ${resets} cleared`,
    );
  }
  check(checkedPages >= 7, `every uploading page was inspected (${checkedPages})`);

  // The two that were wrong, named so a regression is unmistakable.
  const priceList = readFileSync("src/app/page.tsx", "utf8");
  check(
    /finally \{[\s\S]{0,400}inputRef\.current\.value = ""/.test(priceList),
    "the Price List clears its input in a finally, so a failed read can be retried",
  );
  const editor = readFileSync("src/app/edit/page.tsx", "utf8");
  check(
    (editor.match(/e\.target\.value = ""/g) ?? []).length === 2,
    "the Order Editor clears both of its inputs as the file is taken",
  );

  /* ------------------------------------------------------------------ */
  if (failures === 0) console.log("\nALL PDF READING CHECKS PASSED");
  else {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});

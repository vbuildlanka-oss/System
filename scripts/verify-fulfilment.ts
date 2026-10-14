/**
 * Verifies the "can every request be filled?" check on the Requests page:
 *  - demand is what is outstanding, summed across every sheet, matched on the
 *    normalised name
 *  - counts from several files add up
 *  - short items are shared out in queue order, and each buyer is told what
 *    they would get
 *  - not counted is not zero, and blocks an "all fulfilled" verdict
 *  - the app's own count and request files read straight into it
 *  - the check survives the saved request document
 */
import { POST as processPost } from "../src/app/api/process/route";
import { buildCountXlsx } from "../src/lib/counterXlsx";
import { renderCountPdf } from "../src/lib/counterPdf";
import { fromOrderItems as countFrom, setCount } from "../src/lib/counter";
import { renderRequestPdf } from "../src/lib/requestPdf";
import { createRequest, emptyRequestDoc, parseRequestDoc, requestsToCsv } from "../src/lib/buyerRequest";
import {
  addCheckCount,
  addCheckRequests,
  analyseFulfilment,
  createCheckCount,
  createCheckRequest,
  emptyCheck,
  moveCheckRequest,
  parseCheck,
  removeCheckCount,
  type FulfilmentCheck,
} from "../src/lib/fulfilment";
import type { ParsedOrder } from "../src/lib/types";
import type { Restore } from "../src/lib/restoreTypes";
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

type Reply = ParsedOrder & { restore?: Restore; error?: string };
async function upload(bytes: Uint8Array | Buffer, name: string): Promise<{ status: number; body: Reply }> {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(bytes) as BlobPart], name));
  const res = await processPost(
    new Request("http://x/api/process", { method: "POST", body: fd }) as unknown as NextRequest,
  );
  return { status: res.status, body: (await res.json()) as Reply };
}

async function main() {
  /* ================================================================== */
  section("Everything fits");
  {
    let c: FulfilmentCheck = emptyCheck();
    c = addCheckCount(c, createCheckCount("Count A", "", [
      { name: "Anorak 2", counted: 10 },
      { name: "Blanket", counted: 5 },
      { name: "Scarf", counted: 7 },
    ]));
    c = addCheckRequests(c, [
      createCheckRequest({ buyerName: "Ahmad", items: [{ name: "Anorak #2", qty: 6 }, { name: "Blanket", qty: 2 }] }),
      createCheckRequest({ buyerName: "Bilal", items: [{ name: "anorak 2", qty: 4, supplied: 0 }, { name: "Blanket", qty: 5, supplied: 2 }] }),
    ]).check;
    const r = analyseFulfilment(c);
    check(r.ready, "a count and sheets make it ready");
    check(r.allFulfilled, "every request fits");
    check(r.totals.wanted === 15, `outstanding demand is summed, net of supplied (${r.totals.wanted})`);
    check(r.items.find((i) => i.key === "anorak 2")?.wanted === 10, "`Anorak #2` and `anorak 2` are one item");
    check(r.totals.short === 0 && r.totals.buyersFull === 2, "nobody is short");
    check(r.spare.find((s) => s.name === "Scarf")?.spare === 7, "an item nobody asked for is left over");
    check(r.totals.spare === 7, `and only it (${r.totals.spare})`);
  }

  /* ================================================================== */
  section("Something is short");
  {
    let c: FulfilmentCheck = emptyCheck();
    c = addCheckCount(c, createCheckCount("Container 1", "", [{ name: "Anorak 2", counted: 4 }, { name: "Blanket", counted: 1 }]));
    c = addCheckCount(c, createCheckCount("Container 2", "", [{ name: "Anorak 2", counted: 4 }]));
    c = addCheckRequests(c, [
      createCheckRequest({ buyerName: "Ahmad", items: [{ name: "Anorak 2", qty: 6, perBag: 20_000 }] }),
      createCheckRequest({ buyerName: "Bilal", items: [{ name: "Anorak 2", qty: 5, perBag: 20_000 }, { name: "Blanket", qty: 3, perBag: 30_000 }, { name: "Jeans", qty: 2, perBag: 15_000 }] }),
    ]).check;
    let r = analyseFulfilment(c);
    const anorak = r.items.find((i) => i.key === "anorak 2")!;
    check(anorak.counted === 8, `counts from two files add up (${anorak.counted})`);
    check(anorak.short === 3 && anorak.verdict === "short", "11 wanted against 8 is 3 short");
    check(anorak.demand[0].allocated === 6 && anorak.demand[1].allocated === 2, "the first sheet is served first");
    const jeans = r.items.find((i) => i.key === "jeans")!;
    check(jeans.countState === "missing" && jeans.verdict === "none", "an item on no count is none");
    check(r.items[0].verdict === "none", "worst problems are listed first");
    check(!r.allFulfilled, "it is not all fulfilled");
    check(r.totals.short === 3 + 2 + 2, `bags lacking add up (${r.totals.short})`);
    check(r.totals.shortValue === 3 * 20_000 + 2 * 30_000 + 2 * 15_000, `and are valued (${r.totals.shortValue})`);
    const [ahmad, bilal] = r.buyers;
    check(ahmad.verdict === "full", "the first buyer is filled in full");
    check(bilal.verdict === "part" && bilal.allocated === 3 && bilal.short === 7, `the second gets 3 of 10 (${bilal.allocated}/${bilal.wanted})`);
    check(bilal.lines.find((l) => l.key === "anorak 2")?.lostToQueue === true, "and is told the anoraks went to a sheet above");
    check(!bilal.aloneOk, "but would be short alone too, because of the blankets");

    // Put Bilal first.
    c = moveCheckRequest(c, c.requests[1].id, -1);
    r = analyseFulfilment(c);
    check(r.buyers[0].request.buyerName === "Bilal", "reordering moves the queue");
    check(r.buyers[1].request.buyerName === "Ahmad" && r.buyers[1].allocated === 3, "and Ahmad now gets what is left");
    check(analyseFulfilment(removeCheckCount(c, c.counts[1].id)).items.find((i) => i.key === "anorak 2")!.counted === 4, "removing a count takes its bags away");
  }

  /* ================================================================== */
  section("Not counted is not zero");
  {
    let c: FulfilmentCheck = emptyCheck();
    c = addCheckCount(c, createCheckCount("Half done", "", [{ name: "Anorak 2", counted: 5 }, { name: "Blanket", counted: null }]));
    c = addCheckRequests(c, [createCheckRequest({ buyerName: "Ahmad", items: [{ name: "Anorak 2", qty: 5 }, { name: "Blanket", qty: 1 }] })]).check;
    const r = analyseFulfilment(c);
    const blanket = r.items.find((i) => i.key === "blanket")!;
    check(blanket.countState === "uncounted" && blanket.verdict === "unknown", "an uncounted item is unknown, not none");
    check(!r.allFulfilled, "and it blocks an all-fulfilled verdict");
    check(r.totals.itemsUnknown === 1 && r.buyers[0].hasUnknown, "the buyer is flagged too");
  }

  /* ================================================================== */
  section("Nothing to check");
  {
    check(!analyseFulfilment(emptyCheck()).ready && !analyseFulfilment(emptyCheck()).allFulfilled, "an empty check is not 'all fulfilled'");
    const c = addCheckRequests(addCheckCount(emptyCheck(), createCheckCount("C", "", [{ name: "A", counted: 1 }])), [
      createCheckRequest({ buyerName: "Done", items: [{ name: "A", qty: 2, supplied: 2 }] }),
    ]).check;
    const r = analyseFulfilment(c);
    check(!r.ready && r.buyers[0].verdict === "nothing-outstanding", "a fully supplied sheet has nothing outstanding");
  }

  /* ================================================================== */
  section("Re-uploading replaces, never doubles");
  {
    let c = addCheckCount(emptyCheck(), createCheckCount("Count", "", [{ name: "A", counted: 3 }]));
    c = addCheckCount(c, createCheckCount("count", "", [{ name: "A", counted: 4 }]));
    check(c.counts.length === 1 && analyseFulfilment(c).totals.counted === 4, "the same count file replaces the old one");
    const first = addCheckRequests(c, [createCheckRequest({ buyerName: "Ahmad", buyerPhone: "077 123 4567", items: [{ name: "A", qty: 1 }] })]);
    const again = addCheckRequests(first.check, [createCheckRequest({ buyerName: "ahmad", buyerPhone: "0771234567", items: [{ name: "A", qty: 2 }] })]);
    check(again.check.requests.length === 1 && again.replaced === 1, "the same buyer replaces their older sheet");
    check(again.check.requests[0].items[0].qty === 2, "with the newer figures");
  }

  /* ================================================================== */
  section("The app's own files read straight in");
  {
    let count = countFrom(
      [{ name: "Anorak #2", qty: 9 }, { name: "Blanket", qty: 3 }, { name: "Cotton Scarf", qty: 21 }],
      "GAOU7441740",
      "Sri Lanka 07",
    );
    count = setCount(count, count.rows[0].id, 8);
    count = setCount(count, count.rows[1].id, 3);
    // Cotton Scarf left uncounted.

    for (const [ext, bytes] of [
      ["xlsx", await buildCountXlsx(count)],
      ["pdf", await renderCountPdf(count)],
    ] as Array<[string, Buffer]>) {
      const { status, body } = await upload(bytes, `Sri Lanka 07 - GAOU7441740 - Bag Count.${ext}`);
      check(status === 200 && body.restore?.kind === "count", `the ${ext} count is recognised (${body.restore?.kind})`);
      if (body.restore?.kind !== "count") continue;
      const cc = createCheckCount("x", body.restore.containerId, body.restore.rows);
      check(cc.rows.find((r) => r.name === "Anorak #2")?.counted === 8, `${ext}: a count ending in a digit survives`);
    }

    const req1 = createRequest({ name: "Ahmad Trading", phone: "0771234567" }, [
      { name: "Anorak 2", qty: 6, supplied: 1, perBag: 20_000 },
      { name: "Blanket", qty: 2, perBag: 30_000 },
    ]);
    const req2 = createRequest({ name: "Bilal Stores", phone: "0719876543" }, [
      { name: "Anorak 2", qty: 5, perBag: 20_000 },
      { name: "Cotton Scarf", qty: 4, perBag: 12_000 },
    ]);
    const pdf = await renderRequestPdf({
      buyerName: req1.buyer.name,
      buyerPhone: req1.buyer.phone,
      notes: "",
      subtitle: "14 Oct 2026",
      items: req1.items,
    });
    const fromPdf = await upload(pdf, "Ahmad Trading - Requested Bags.pdf");
    check(fromPdf.body.restore?.kind === "requests", `a request PDF is recognised (${fromPdf.body.restore?.kind})`);
    const fromCsv = await upload(Buffer.from(requestsToCsv([req1, req2])), "Buyer requests.csv");
    check(fromCsv.body.restore?.kind === "requests", "a request CSV is recognised");

    const xlsx = await upload(await buildCountXlsx(count), "Bag Count.xlsx");
    let c = emptyCheck();
    if (xlsx.body.restore?.kind === "count") {
      c = addCheckCount(c, createCheckCount("Bag Count", xlsx.body.restore.containerId, xlsx.body.restore.rows));
    }
    for (const reply of [fromPdf.body, fromCsv.body]) {
      if (reply.restore?.kind !== "requests") continue;
      c = addCheckRequests(c, reply.restore.requests.map((r) => createCheckRequest({ ...r, from: "file", items: r.items }))).check;
    }
    check(c.requests.length === 2, `the PDF and CSV copies of Ahmad are one buyer (${c.requests.map((r) => r.buyerName).join(", ")})`);

    const r = analyseFulfilment(c);
    const anorak = r.items.find((i) => i.key === "anorak 2")!;
    check(anorak.wanted === 10 && anorak.counted === 8 && anorak.short === 2, `anoraks: 10 wanted, 8 counted, 2 short (${anorak.wanted}/${anorak.counted}/${anorak.short})`);
    check(r.items.find((i) => i.key === "cotton scarf")?.verdict === "unknown", "the uncounted scarf is unknown");
    check(r.items.find((i) => i.key === "blanket")?.verdict === "enough", "the blankets are fine");
    check(r.spare.find((s) => s.key === "blanket")?.spare === 1, "with one left over");
    check(!r.allFulfilled, "so not everything can be filled");
  }

  /* ================================================================== */
  section("Saved with the request lists");
  {
    const c = addCheckRequests(addCheckCount(emptyCheck(), createCheckCount("C", "BAY 1", [{ name: "A", counted: 2 }, { name: "B", counted: null }])), [
      createCheckRequest({ buyerName: "Ahmad", items: [{ name: "A", qty: 3, perBag: 100 }] }),
    ]).check;
    const doc = { ...emptyRequestDoc(), check: c };
    const back = parseRequestDoc(JSON.parse(JSON.stringify(doc)));
    check(back.check.counts.length === 1 && back.check.counts[0].rows[1].counted === null, "the count, uncounted rows and all, survives a save");
    check(back.check.requests[0].items[0].perBag === 100, "and so do the sheets");
    const old = parseRequestDoc({ requests: [], sources: [] });
    check(old.check.counts.length === 0 && old.check.requests.length === 0, "a file saved before the check existed still loads");
    const junk = parseCheck({ counts: [{ rows: "nope" }, null], requests: [{ items: [{ name: "", qty: 5 }] }] });
    check(junk.counts.length === 0 && junk.requests.length === 0, "rubbish is dropped, not trusted");
  }

  console.log(failures === 0 ? "\nAll fulfilment checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

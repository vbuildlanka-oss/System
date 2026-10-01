/**
 * Every file BaleBook writes can be read back by the page that wrote it.
 *
 * The point: a download is a backup. If a browser is cleared or a phone is
 * replaced, uploading last week's count sheet, payroll workbook or stockpile
 * export puts the page back - counts as counts, markups as markups, wages with
 * their typed-in exceptions, stock on the dates it arrived.
 *
 * Each section here generates a real file with the same code the download
 * routes use, uploads it through the same route the page uses, applies it with
 * the same function the page calls, and compares the result with what went in.
 *
 * And the other half of the promise: supplier files go through exactly the
 * rules they always did. None of this may change how a third-party order sheet
 * is read on the Price List.
 */
import { readFileSync } from "node:fs";
import { POST as processPost } from "../src/app/api/process/route";
import { POST as balanceImportPost } from "../src/app/api/balance-import/route";
import { buildManifestXlsx } from "../src/lib/bagManifestXlsx";
import { renderManifestPdf } from "../src/lib/bagManifestPdf";
import { buildCountXlsx } from "../src/lib/counterXlsx";
import { renderCountPdf } from "../src/lib/counterPdf";
import {
  emptyCountDoc,
  fromOrderItems as countFrom,
  restoreCounts,
  setCount,
  bestMatch,
  searchRows,
} from "../src/lib/counter";
import { buildCalculationXlsx } from "../src/lib/calculationXlsx";
import {
  fromOrderItems as calcFrom,
  fromRestoredRows,
  setRowMarkup,
  toggleFast,
  calcTotals,
} from "../src/lib/calculation";
import {
  addLots,
  addRestoredLots,
  emptyStockpile,
  itemBags,
  itemValue,
  stockpileTotals,
  toCsv,
} from "../src/lib/stockpile";
import { renderBuyerPdf, renderSheetPdf } from "../src/lib/buyerPdf";
import { buildBuyerPriceList, buildSheetFromRows, type ParsedOrder } from "../src/lib/types";
import { createRequest, requestsToCsv } from "../src/lib/buyerRequest";
import { renderRequestPdf } from "../src/lib/requestPdf";
import { parseBalanceSheet } from "../src/lib/balanceSheet";
import { buildBalanceXlsx } from "../src/lib/balanceXlsx";
import { addImportedTurnover } from "../src/lib/turnoverImport";
import { addImportedExpenses } from "../src/lib/expensesImport";
import {
  addField,
  addMonth,
  addRow,
  emptyPayrollDoc,
  findMonth,
  monthTotals,
  restorePayroll,
  setEmployer,
  setPaidOn,
  setRates,
  setRowExtra,
  setRowMoney,
  setRowOverride,
  setRowText,
  rowFigures,
} from "../src/lib/payroll";
import { buildPayrollXlsx, buildPayrollYearXlsx } from "../src/lib/payrollXlsx";
import { isBalebookWordmark } from "../src/lib/parseOrder";
import { recogniseCsv, recogniseGrids } from "../src/lib/restore";
import { parseCsv } from "../src/lib/parseTabular";
import type { Restore } from "../src/lib/restoreTypes";
import { matchRank, matches, searchList } from "../src/lib/search";
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

async function upload(bytes: Uint8Array | Buffer, name: string, page = ""): Promise<{ status: number; body: Reply }> {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(bytes) as BlobPart], name));
  if (page) fd.append("for", page);
  const res = await processPost(
    new Request("http://x/api/process", { method: "POST", body: fd }) as unknown as NextRequest,
  );
  return { status: res.status, body: (await res.json()) as Reply };
}

const ITEMS = [
  { name: "3/4 Ladies Jeans", qty: 12, perBag: 24_000 },
  { name: "Anorak #2", qty: 9, perBag: 19_000 },
  { name: "Blanket", qty: 3, perBag: 30_000 },
  { name: "Cotton Scarf", qty: 21, perBag: 12_500 },
];

const SUPPLIERS = [
  { file: "sample-orders/Sri Lanka Order 3 2026 - Sheet1 (1).pdf", items: 85, bags: 733 },
  { file: "sample-orders/Sri Lanka Order 4 2026 - Sheet1 (1).pdf", items: null, bags: null },
];

async function main() {
  /* ================================================================== */
  section("Supplier files are read exactly as before");
  for (const supplier of SUPPLIERS) {
    const bytes = readFileSync(supplier.file);
    const { status, body } = await upload(bytes, supplier.file.split("/").pop()!, "/");
    check(status === 200, `${supplier.file.split("/").pop()} still reads (${status})`);
    check(body.restore === undefined, "and is not mistaken for a BaleBook file");
    if (supplier.items !== null) {
      check(body.items.length === supplier.items, `with all ${supplier.items} items (${body.items.length})`);
      check(body.totalQty === supplier.bags, `and ${supplier.bags} bags (${body.totalQty})`);
      check(body.totalsMatch === true, "and its printed total still checks out");
      check(body.items.every((i) => i.perBag > 0), "every line keeps its supplier price");
    }
  }

  // A supplier spreadsheet in the usual shape: no BaleBook headings, no restore.
  const supplierCsv = "Sri Lanka Order 7 2026\nItem Name,Quantity,Per Bag,Total\nAnorak,21,22000,462000\nBlanket,3,30000,90000\nTotal,24,,552000\n";
  const sc = await upload(Buffer.from(supplierCsv), "Sri Lanka Order 7 2026.csv", "/");
  check(sc.status === 200 && sc.body.restore === undefined, "a supplier CSV is not mistaken for one of ours");
  check(sc.body.items.length === 2 && sc.body.items[0].perBag === 22_000, "and its prices come through");

  check(isBalebookWordmark("B A L E B O O K"), "the printed wordmark is recognised");
  check(isBalebookWordmark("BALEBOOK"), "run together too");
  check(!isBalebookWordmark("Balebook Traders (Pvt) Ltd"), "a supplier merely called Balebook is not");
  check(!isBalebookWordmark("balebook"), "nor the word in lower case");
  check(!isBalebookWordmark("BALEBOOK ORDER 3"), "nor a line that only starts with it");

  /* ================================================================== */
  section("A count comes back as a count");
  {
    let count = countFrom(ITEMS.map(({ name, qty }) => ({ name, qty })), "GAOU7441740", "Sri Lanka 07");
    count = setCount(count, count.rows[0].id, 11);
    count = setCount(count, count.rows[1].id, 9);
    count = setCount(count, count.rows[2].id, 0); // found none: a real finding
    // Cotton Scarf never counted.

    for (const [kind, bytes] of [
      ["xlsx", await buildCountXlsx(count)],
      ["pdf", await renderCountPdf(count)],
    ] as Array<[string, Buffer]>) {
      const { status, body } = await upload(bytes, `Sri Lanka 07 - GAOU7441740 - Bag Count.${kind}`, "/counter");
      check(status === 200 && body.restore?.kind === "count", `the ${kind} count sheet is recognised (${body.restore?.kind})`);
      if (body.restore?.kind !== "count") continue;
      check(body.restore.containerId === "GAOU7441740", `its container comes back (${body.restore.containerId})`);
      check(body.restore.orderNumber === "Sri Lanka 07", `and its order (${body.restore.orderNumber})`);

      // Onto the same list, loaded fresh: the usual way to carry on a count.
      const fresh = countFrom(ITEMS.map(({ name, qty }) => ({ name, qty })), "", "");
      const result = restoreCounts(fresh, body.restore.rows, body.restore);
      const by = (name: string) => result.doc.rows.find((r) => r.name === name)!;
      check(by("3/4 Ladies Jeans").counted === 11 && by("3/4 Ladies Jeans").touched, "a count lands on its row");
      check(by("Anorak #2").counted === 9, "a name ending in a digit keeps its count");
      check(by("Cotton Scarf").touched === false, "an item never counted stays never counted");
      check(by("3/4 Ladies Jeans").expected === 12, "and the list's expected figures are untouched");
      check(result.added === 0, "nothing is added that was already on the list");
      if (kind === "xlsx") {
        check(by("Blanket").touched && by("Blanket").counted === 0, "a counted zero stays a counted zero");
      }
      check(result.doc.containerId === "GAOU7441740", "the container is filled in from the file");
    }

    // With nothing open there is nothing to compare against, so nothing is
    // claimed to match.
    const xlsx = await upload(await buildCountXlsx(count), "Bag Count.xlsx", "/counter");
    if (xlsx.body.restore?.kind === "count") {
      const alone = restoreCounts(emptyCountDoc(), xlsx.body.restore.rows, xlsx.body.restore);
      check(alone.withoutList, "with no list open, it says so");
      check(alone.doc.rows.every((r) => r.added && r.expected === 0), "and invents no expected figures");
      check(alone.doc.rows.find((r) => r.name === "Cotton Scarf")?.touched === false, "an uncounted item is still listed as uncounted");
    }

    // Matching is on the normalised name.
    const loose = restoreCounts(
      countFrom([{ name: "Anorak 2", qty: 9 }], "", ""),
      [{ name: "Anorak #2", counted: 4 }],
      { orderNumber: "", containerId: "" },
    );
    check(loose.doc.rows.length === 1 && loose.doc.rows[0].counted === 4, '"Anorak #2" in the file finds "Anorak 2" on the list');
  }

  /* ================================================================== */
  section("A manifest comes back with its container");
  {
    const many = Array.from({ length: 70 }, (_, i) => ({ name: `Item ${String.fromCharCode(65 + (i % 26))}${i} #${i % 7}`, qty: (i % 9) + 1 }));
    for (const items of [ITEMS.map(({ name, qty }) => ({ name, qty })), many]) {
      const total = items.reduce((s, i) => s + i.qty, 0);
      const data = { orderNumber: "Sri Lanka Order 03", containerNumber: "GAOU7441740", items };
      for (const [kind, bytes] of [
        ["xlsx", await buildManifestXlsx(data)],
        ["pdf", await renderManifestPdf({ ...data, total, subtitle: "Generated 01 Oct 2026" })],
      ] as Array<[string, Buffer]>) {
        const { body } = await upload(bytes, `Sri Lanka Order 03 - GAOU7441740 - Bags.${kind}`, "/bag-manifests");
        const label = `${items.length}-item manifest ${kind}`;
        check(body.restore?.kind === "manifest", `the ${label} is recognised`);
        if (body.restore?.kind === "manifest") {
          check(body.restore.containerNumber === "GAOU7441740", `with its container (${body.restore.containerNumber})`);
          check(body.restore.orderNumber === "Sri Lanka Order 03", "and its order number");
        }
        const same =
          body.items.length === items.length &&
          items.every((it, i) => body.items[i].name === it.name && body.items[i].qty === it.qty);
        check(same, `every line comes back as written (${body.items.length}/${items.length})`);
        check(body.totalQty === total, `adding up to ${total} (${body.totalQty})`);
      }
    }
  }

  /* ================================================================== */
  section("A calculation comes back with its markups");
  {
    let calc = calcFrom(ITEMS, 2_000, "Sri Lanka 07");
    calc = setRowMarkup(calc, calc.rows[1].id, 3_500);
    calc = toggleFast(calc, calc.rows[1].id);
    calc = toggleFast(calc, calc.rows[3].id);
    const { status, body } = await upload(await buildCalculationXlsx(calc), "Sri Lanka 07 - Markup Calculation INTERNAL.xlsx", "/calculation");
    check(status === 200 && body.restore?.kind === "calculation", "the workbook is recognised");
    if (body.restore?.kind === "calculation") {
      const back = fromRestoredRows(body.restore.rows, body.restore.orderNumber);
      check(back.rows.length === 4, `every item comes back, and no summary rows (${back.rows.length})`);
      check(back.baseMarkup === 2_000, `the base markup is worked out (${back.baseMarkup})`);
      check(back.orderNumber === "Sri Lanka 07", `the order number (${back.orderNumber})`);
      check(back.rows[1].markup === 3_500 && back.rows[1].overridden, "a hand-set markup stays hand-set");
      check(!back.rows[0].overridden, "and the rest stay on the base");
      check(back.rows[1].fast && back.rows[3].fast && !back.rows[0].fast, "fast movers are still fast");
      check(back.rows.every((r, i) => r.costPerBag === calc.rows[i].costPerBag && r.qty === calc.rows[i].qty), "costs and bags are exact");
      const a = calcTotals(calc);
      const b = calcTotals(back);
      check(a.profit === b.profit && a.selling === b.selling, `the order makes the same (${b.profit})`);
    }
    // Uploaded to the price list instead, it is still a good list with costs.
    check(body.items.every((i) => i.perBag > 0) && body.items.length === 4, "anywhere else it reads as a clean list with its costs");
  }

  /* ================================================================== */
  section("The stockpile comes back on the dates it arrived");
  {
    let sp = emptyStockpile();
    sp = addLots(sp, [{ name: "Anorak #2", bags: 9, perBag: 19_000, source: "Order 01" }], new Date("2026-05-10T12:00:00Z")).stockpile;
    sp = addLots(sp, [{ name: "Anorak #2", bags: 4, perBag: 21_000, source: "Order 03" }], new Date("2026-08-02T12:00:00Z")).stockpile;
    sp = addLots(sp, [{ name: "Blanket", bags: 3, perBag: 30_000, source: "Order 03" }], new Date("2026-08-02T12:00:00Z")).stockpile;

    const csv = await upload(Buffer.from(toCsv(sp)), "Stockpile.csv", "/stockpile");
    check(csv.body.restore?.kind === "stockpile", "the CSV export is recognised");
    if (csv.body.restore?.kind === "stockpile") {
      check(csv.body.restore.detailed, "as a detailed one, batch by batch");
      const back = addRestoredLots(emptyStockpile(), csv.body.restore.lots).stockpile;
      const before = stockpileTotals(sp);
      const after = stockpileTotals(back);
      check(after.bags === before.bags && after.value === before.value, `same bags and value (${after.bags}, ${after.value})`);
      const anorak = back.items.find((i) => i.name === "Anorak #2")!;
      check(anorak.lots.length === 2, "each batch is its own batch again");
      check(
        anorak.lots.map((l) => l.addedAt.slice(0, 10)).sort().join(",") === "2026-05-10,2026-08-02",
        "on the day it first arrived, so its age is right",
      );
      check(anorak.lots.some((l) => l.source === "Order 01"), "with where it came from");
      check(itemBags(anorak) === 13 && itemValue(anorak) === 9 * 19_000 + 4 * 21_000, "mixed prices are not averaged away");
    }

    const sheet = buildSheetFromRows(
      "Stockpile",
      sp.items.map((i, n) => ({ id: String(n), name: i.name, qty: itemBags(i), perBag: Math.round(itemValue(i) / itemBags(i)), totalOverride: itemValue(i) })),
    );
    const pdf = await upload(await renderSheetPdf(sheet, { label: "", subtitle: "As at 01 Oct 2026" }), "Stockpile.pdf", "/stockpile");
    check(pdf.body.restore?.kind === "stockpile", "the PDF export is recognised");
    if (pdf.body.restore?.kind === "stockpile") {
      check(!pdf.body.restore.detailed, "and known to have no batch dates");
      check(pdf.body.restore.lots.reduce((n, l) => n + l.bags, 0) === 16, "but every bag comes back");
      check(pdf.body.restore.lots[0].addedOn === "2026-10-01", `dated as at the day it was printed (${pdf.body.restore.lots[0].addedOn})`);
    }
  }

  /* ================================================================== */
  section("Buyer requests come back with what was supplied");
  {
    const first = createRequest({ name: "Ahmad Trading", phone: "0771234567" }, [
      { name: "3/4 Ladies Jeans", qty: 12, supplied: 5, perBag: 24_000 },
      { name: "Anorak #2", qty: 9, supplied: 9, perBag: 19_000, note: "black only" },
    ]);
    const second = createRequest({ name: "Nimal Stores", phone: "0719876543" }, [
      { name: "Blanket", qty: 3, supplied: 0, perBag: 0 },
    ]);
    const csv = await upload(Buffer.from(requestsToCsv([first, second])), "Requests.csv", "/requests");
    check(csv.body.restore?.kind === "requests", "the CSV is recognised");
    if (csv.body.restore?.kind === "requests") {
      const rs = csv.body.restore.requests;
      check(rs.length === 2, `each buyer is their own list (${rs.length})`);
      check(rs[0].buyerPhone === "0771234567", "with their phone");
      check(rs[0].items[0].supplied === 5 && rs[0].items[1].supplied === 9, "and what they have already had");
      check(rs[0].items[1].note === "black only", "and the line's note");
      check(rs[1].items[0].perBag === 0, "an unpriced line stays unpriced");
      const rebuilt = createRequest({ name: rs[0].buyerName, phone: rs[0].buyerPhone }, rs[0].items);
      check(rebuilt.items[0].qty === 12 && rebuilt.items[0].supplied === 5, "and it rebuilds into a request exactly");
    }
    check(!csv.body.items.some((i) => i.name === "Ahmad Trading"), "a buyer's name is never read as an item");

    const pdf = await upload(
      await renderRequestPdf({ buyerName: "Ahmad Trading", buyerPhone: "0771234567", items: first.items, notes: "Deliver Friday", subtitle: "01 Oct 2026" }),
      "Ahmad Trading - Request.pdf",
      "/requests",
    );
    check(pdf.body.restore?.kind === "requests", "the PDF is recognised");
    if (pdf.body.restore?.kind === "requests") {
      const r = pdf.body.restore.requests[0];
      check(r.buyerName === "Ahmad Trading", "for the right buyer");
      check(r.buyerPhone.replace(/\D/g, "").endsWith("771234567"), `with their phone (${r.buyerPhone})`);
      check(r.notes === "Deliver Friday", `and the list's notes (${r.notes})`);
      check(r.items[0].supplied === 5 && r.items[1].supplied === 9, "and the supplied counts the ordinary reading drops");
    }
    const unpriced = await upload(
      await renderRequestPdf({ buyerName: "Nimal Stores", buyerPhone: "", items: createRequest({ name: "x", phone: "" }, [{ name: "Blanket", qty: 12, supplied: 4, perBag: 0 }]).items }),
      "Nimal Stores - Request.pdf",
      "/requests",
    );
    if (unpriced.body.restore?.kind === "requests") {
      const line = unpriced.body.restore.requests[0].items[0];
      check(line?.name === "Blanket" && line.qty === 12 && line.supplied === 4, `a line with no price still reads (${JSON.stringify(line)})`);
    } else {
      check(false, "an unpriced request PDF is recognised");
    }
  }

  /* ================================================================== */
  section("Payroll comes back month by month, exceptions and all");
  {
    let doc = setEmployer(emptyPayrollDoc(), "Vbuild Lanka (Pvt) Ltd");
    const aug = addMonth(doc, "2026-08");
    doc = aug.doc;
    const augId = aug.month!.id;
    doc = setPaidOn(doc, augId, "2026-08-31");
    const paye = addField(doc, "PAYE", "deduction");
    doc = paye.doc;
    const transport = addField(doc, "Transport", "allowance");
    doc = transport.doc;
    doc = addRow(doc, augId, { name: "Nimal Perera", tin: "123456789", gross: 100_000 });
    doc = addRow(doc, augId, { name: "Kamala Silva", tin: "987654321", gross: 60_000 });
    doc = addRow(doc, augId, { name: "Sunil Fernando", tin: "", gross: 45_000 });
    const rows = findMonth(doc, augId)!.rows;
    doc = setRowExtra(doc, augId, rows[0].id, paye.field!.id, 5_000);
    doc = setRowExtra(doc, augId, rows[0].id, transport.field!.id, 7_500);
    doc = setRowMoney(doc, augId, rows[0].id, "otherDeductions", 2_000);
    doc = setRowText(doc, augId, rows[0].id, "note", "Advance recovered");
    doc = setRowOverride(doc, augId, rows[2].id, "epfEmployee", 1_000);
    doc = setRowOverride(doc, augId, rows[1].id, "etf", 0);
    const sep = addMonth(doc, "2026-09");
    doc = sep.doc;

    const month = await upload(await buildPayrollXlsx(doc, augId), "Payroll - August 2026.xlsx", "/payroll");
    check(month.status === 200 && month.body.restore?.kind === "payroll", "the month workbook is recognised");
    if (month.body.restore?.kind === "payroll") {
      const restored = restorePayroll(emptyPayrollDoc(), month.body.restore.payroll);
      const back = restored.doc;
      check(restored.added.join() === "2026-08", `August comes back (${restored.added.join()})`);
      check(back.employer === "Vbuild Lanka (Pvt) Ltd", `with the employer (${back.employer})`);
      check(back.fields.map((f) => `${f.label}:${f.kind}`).join() === "Transport:allowance,PAYE:deduction", "and its own columns, each the right kind");
      const m = back.months[0];
      check(m.paidOn === "2026-08-31", "and the date it was paid");
      const a = monthTotals(findMonth(doc, augId)!, doc.fields, doc.rates);
      const b = monthTotals(m, back.fields, back.rates);
      check(a.net === b.net, `the wages to pay are identical (${b.net})`);
      check(a.epfEmployee === b.epfEmployee && a.etf === b.etf && a.epfEmployer === b.epfEmployer, "and every contribution");
      const sunil = m.rows.find((r) => r.name === "Sunil Fernando")!;
      check(sunil.overrides.epfEmployee === 1_000, "a typed-in EPF stays typed in, not recomputed");
      check(rowFigures(sunil, back.fields, back.rates).epfEmployee === 1_000, "so it still comes off at 1000, not 3600");
      const kamala = m.rows.find((r) => r.name === "Kamala Silva")!;
      check(kamala.overrides.etf === 0, "a contribution typed in as nothing stays nothing");
      check(m.rows[0].note === "Advance recovered", "and the row's note");
      check(m.rows.find((r) => r.name === "Sunil Fernando")!.tin === "", "and a missing TIN stays missing");
    }

    const year = await upload(await buildPayrollYearXlsx(doc, "2026"), "Payroll 2026.xlsx", "/payroll");
    if (year.body.restore?.kind === "payroll") {
      const restored = restorePayroll(emptyPayrollDoc(), year.body.restore.payroll);
      check(restored.added.sort().join() === "2026-08,2026-09", `the year brings every month (${restored.added.join()})`);
      check(restored.doc.months.find((x) => x.month === "2026-09")!.rows.length === 3, "September with its people");
    } else {
      check(false, "the year workbook is recognised");
    }

    // Restoring onto a payroll that already has August replaces it, rather
    // than merging two versions of one month.
    if (month.body.restore?.kind === "payroll") {
      const already = restorePayroll(doc, month.body.restore.payroll);
      check(already.replaced.join() === "2026-08" && already.added.length === 0, "a month already here is replaced, not doubled");
      check(findMonth(already.doc, augId)!.rows.length === 3, "with the same three people, not six");
      check(already.doc.months.length === 2, "and September is left alone");
      check(already.doc.fields.length === 2, "columns are matched by name, not added twice");
      const changed = restorePayroll(setRates(doc, { epfEmployee: 10 }), month.body.restore.payroll);
      check(changed.ratesDiffer, "a file worked out at other rates is flagged");
      check(changed.doc.rates.epfEmployee === 10, "and the page keeps its own rates");
    }

    const wrong = await upload(await buildPayrollYearXlsx(doc, "2026"), "Payroll 2026.xlsx", "/counter");
    check(wrong.status === 422 && /Payroll page/.test(wrong.body.error ?? ""), `uploaded to the Counter, it says where it belongs (${wrong.body.error})`);
  }

  /* ================================================================== */
  section("A balance sheet workbook restores all three ledgers");
  {
    const sheet = parseBalanceSheet({
      expenses: [
        { id: "e1", name: "Customs duty", partner: "Lathurshan", amount: 50_000, containerId: "GAOU7441740", at: "2026-08-01T12:00:00.000Z", note: "Port" },
        { id: "e2", name: "Rent", partner: "Partner B", amount: 20_000, containerId: "", at: "2026-07-03T12:00:00.000Z", note: "" },
      ],
      turnover: [{ id: "t1", containerId: "GAOU7441740", turnover: 900_000, at: "2026-08-03T12:00:00.000Z", note: "Sold out" }],
      balances: [{ id: "b1", party: "Supplier A", direction: "payable", amount: 100_000, paid: 20_000, containerId: "", orderNumber: "", dueAt: "2026-09-01", at: "2026-08-01T00:00:00.000Z", note: "" }],
    });
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array(await buildBalanceXlsx(sheet)) as BlobPart], "Balance Sheet.xlsx"));
    fd.append("scope", "all");
    const res = await balanceImportPost(new Request("http://x", { method: "POST", body: fd }) as unknown as NextRequest);
    const body = (await res.json()) as { expenses: Array<{ at?: string; note?: string; amount: number }>; turnover: Array<{ containerId: string; turnover: number; at?: string; note?: string; duplicate: boolean }>; balances: unknown[] };
    check(res.status === 200, `the workbook reads (${res.status})`);
    check(body.expenses.length === 2 && body.turnover.length === 1 && body.balances.length === 1, `all three ledgers are found (${body.expenses.length}/${body.turnover.length}/${body.balances.length})`);
    check(body.turnover[0].turnover === 900_000 && body.turnover[0].containerId === "GAOU7441740", "turnover, which could never be imported before");
    check(body.expenses.some((e) => e.at === "2026-07-03"), "expenses keep their dates");
    check(body.expenses.some((e) => e.note === "Port"), "and their notes");

    const empty = parseBalanceSheet({});
    let restored = addImportedExpenses(empty, body.expenses.map((e) => ({ ...e, duplicate: false })) as never, "x").sheet;
    restored = addImportedTurnover(restored, body.turnover.map((t) => ({ ...t, row: 0 })), "x").sheet;
    check(restored.expenses.find((e) => e.name === "Rent")?.at.slice(0, 10) === "2026-07-03", "a restored expense is dated as it was");
    check(restored.turnover[0].note === "Sold out" && restored.turnover[0].at.slice(0, 10) === "2026-08-03", "and so is turnover");
  }

  /* ================================================================== */
  section("A buyer's price list is never taken as costs");
  {
    const buyer = buildBuyerPriceList({ title: "Sri Lanka Order 03", items: ITEMS }, 2_000);
    const { body } = await upload(await renderBuyerPdf(buyer, { buyer: { name: "Ahmad", phone: "0771234567" } }), "Sri Lanka Order 03 - Buyer Price List.pdf", "/");
    check(body.restore?.kind === "buyer-price-list", "it is recognised as the buyer's copy");
    if (body.restore?.kind === "buyer-price-list") check(body.restore.orderNumber === "Sri Lanka Order 03", "with its order number");
    // The page zeroes these before using them; the file itself carries the
    // marked-up figure, which is exactly why it must not be read as a cost.
    check(body.items[0].perBag === 26_000, "its prices include the markup, which is why they are not costs");
    const page = readFileSync("src/app/page.tsx", "utf8");
    check(/buyer-price-list[\s\S]{0,400}perBag: 0/.test(page), "and the Price List drops them rather than marking them up again");
  }

  /* ================================================================== */
  section("An order sheet brings back who it was for");
  {
    const sheet = buildSheetFromRows("Sri Lanka Order 03", ITEMS.map((i, n) => ({ id: String(n), ...i, totalOverride: null })));
    const { body } = await upload(
      await renderSheetPdf(sheet, { label: "Updated", subtitle: "Updated 01 Oct 2026", buyer: { name: "Ahmad Trading", phone: "0771234567" }, refNo: "BB-3F7K-261001-001" }),
      "Sri Lanka Order 03 - Updated.pdf",
      "/edit",
    );
    check(body.restore?.kind === "sheet", "the updated sheet is recognised");
    if (body.restore?.kind === "sheet") {
      check(body.restore.buyer?.name === "Ahmad Trading", `with its buyer (${body.restore.buyer?.name})`);
      check(body.restore.buyer?.refNo === "BB-3F7K-261001-001", "and its reference");
    }
    check(body.items.length === 4 && body.items[1].name === "Anorak #2" && body.items[1].qty === 9, "and every line");
  }

  /* ================================================================== */
  section("Only our exact layouts are recognised");
  {
    check(recogniseCsv(parseCsv("Item,Bags,Price\nAnorak,3,100")) === null, "a CSV that merely says Item and Bags is not ours");
    check(recogniseCsv(parseCsv("Buyer,Item,Qty\nA,B,1")) === null, "nor one that starts with Buyer");
    check(recogniseGrids([{ name: "Sheet1", rows: [["Item", "Count"], ["A", 1]] }]) === null, "a sheet called Sheet1 with Item and Count is not a count");
    check(recogniseGrids([{ name: "Calculation", rows: [["x"], ["Item", "Qty"]] }]) === null, "nor a Calculation tab with other headings");
    check(recogniseGrids([{ name: "August 2026", rows: [["x"], ["Name", "Age"]] }]) === null, "nor a month-named sheet that is not a payroll");
  }

  /* ================================================================== */
  section("Search forgives the way people type on a phone");
  {
    check(matchRank("anorak 2", "Anorak #2") !== null, '"anorak 2" finds "Anorak #2"');
    check(matchRank("jeans ladies", "3/4 Ladies Jeans") !== null, "words in any order");
    check(matchRank("blk", "Black T-Shirt") !== null, '"blk" finds "Black"');
    check(matchRank("lad jea", "3/4 Ladies Jeans") !== null, "the start of each word");
    check(matchRank("ANORAK", "Anorak") === 0, "case does not matter");
    check(matchRank("xyz", "Anorak") === null, "and nonsense finds nothing");
    check((matchRank("anorak", "Anorak") ?? 9) < (matchRank("anorak", "Anorak #2") ?? 9), "the exact name ranks above a longer one");
    check((matchRank("blanket", "Blanket") ?? 9) < (matchRank("blnk", "Blanket") ?? 9), "a typed name ranks above an abbreviation");
    check(matches("gaou", "Customs", "GAOU7441740"), "any field can answer");
    const list = ["Anorak #2", "Blanket", "Anorak", "Anorak Hooded"];
    check(searchList(list, "anorak", (x) => [x])[0] === "Anorak", "the exact item is first in a list");
    check(searchList(list, "", (x) => [x]).join() === list.join(), "an empty search leaves the order alone");

    // The Counter's Enter key adds a bag without anyone looking, so it must not guess.
    const count = countFrom([{ name: "Black Shirt", qty: 1 }, { name: "Blue Kurta", qty: 1 }, { name: "Blanket", qty: 1 }], "", "");
    check(bestMatch(count, "blanket")?.name === "Blanket", "Enter tallies the exact item");
    check(bestMatch(count, "bk") === null || searchRows(count, "bk").length <= 1, "but not a loose abbreviation that fits several");
    check(bestMatch(count, "blnkt")?.name === "Blanket", "an abbreviation that fits one item is fine");
    check(bestMatch(count, "shirt black")?.name === "Black Shirt", "and words in any order");
  }

  /* ================================================================== */
  section("Every page that deletes can undo, and every uploader takes spreadsheets");
  {
    for (const page of ["page.tsx", "counter/page.tsx", "stockpile/page.tsx", "balance/page.tsx", "payroll/page.tsx", "calculation/page.tsx", "requests/page.tsx", "bag-manifests/page.tsx"]) {
      const src = readFileSync(`src/app/${page}`, "utf8");
      check(/<UndoToast undo=\{undoer\} \/>/.test(src), `${page} has undo`);
    }
    for (const page of ["page.tsx", "edit/page.tsx", "stockpile/page.tsx", "counter/page.tsx", "calculation/page.tsx", "bag-manifests/page.tsx", "requests/page.tsx"]) {
      const src = readFileSync(`src/app/${page}`, "utf8");
      const accepts = Array.from(src.matchAll(/accept="([^"]+)"/g)).map((m) => m[1]);
      check(accepts.some((a) => a.includes(".pdf") && a.includes(".xlsx") && a.includes(".csv")), `${page} accepts PDF, CSV and Excel`);
      check(/fd\.append\("for"/.test(src), `${page} tells the reader which page it is`);
    }
    const nav = readFileSync("src/components/Nav.tsx", "utf8");
    check(/<QuickJump/.test(nav), "the quick-jump is in the bar on every page");
  }

  /* ================================================================== */
  section("The quick-jump finds things, and shows no money");
  {
    // A browser's storage, with a little of everything in it.
    const data = new Map<string, string>();
    const store = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    (globalThis as unknown as { window: unknown }).window = { localStorage: store };

    let sp = addLots(emptyStockpile(), [{ name: "Anorak #2", bags: 9, perBag: 19_000, source: "Order 01" }]).stockpile;
    sp = addLots(sp, [{ name: "Blanket", bags: 3, perBag: 30_000, source: "Order 01" }]).stockpile;
    data.set("balebook.stockpile.v1", JSON.stringify(sp));
    let count = countFrom([{ name: "Anorak #2", qty: 12 }], "GAOU7441740", "");
    count = setCount(count, count.rows[0].id, 7);
    data.set("balebook.bagCount.v1", JSON.stringify(count));
    let pay = emptyPayrollDoc();
    const m = addMonth(pay, "2026-08");
    pay = addRow(m.doc, m.month!.id, { name: "Nimal Perera", tin: "123456789", gross: 100_000 });
    data.set("balebook.payroll.v1", JSON.stringify(pay));

    const { gather } = await import("../src/components/QuickJump");
    const pages = [{ href: "/stockpile", label: "Stockpile", hint: "What is in stock", group: "Warehouse" }];

    const anorak = gather("anorak 2", pages);
    const stock = anorak.find((r) => r.kind === "stock");
    check(stock?.detail === "9 bags in the stockpile", `stock is found, with how many bags (${stock?.detail})`);
    check(stock?.href === "/stockpile" && stock.q === "Anorak #2", "and it goes to the stockpile, searched for that item");
    const counted = anorak.find((r) => r.kind === "count");
    check(/Counted 7 of 12/.test(counted?.detail ?? ""), `the count on the floor is shown too (${counted?.detail})`);

    const person = gather("nimal", pages).find((r) => r.kind === "person");
    check(person?.href === "/payroll", "a person on the payroll is found");
    check(!/\d{4,}|Rs/.test(person?.detail ?? ""), `but never with their pay (${person?.detail})`);
    check(gather("123456789", pages).some((r) => r.kind === "person"), "and can be found by TIN");

    const everything = gather("a", pages).map((r) => `${r.title} ${r.detail}`).join(" ");
    check(!/Rs\s?\d/.test(everything), "no result anywhere shows a money figure");
    check(gather("", pages).every((r) => r.kind === "page"), "an empty box lists the pages, like a menu");
    check(gather("stockpile", pages)[0]?.kind === "page", "a page name finds the page first");
    delete (globalThis as unknown as { window?: unknown }).window;
  }

  if (failures === 0) console.log("\nALL ROUND-TRIP CHECKS PASSED");
  else {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});

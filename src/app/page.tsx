"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  UploadCloud,
  FileText,
  Download,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { ParsedOrder } from "@/lib/types";
import {
  buildBuyerPriceList,
  buyerPriceFilename,
  formatLKR,
  LIMITS,
} from "@/lib/types";
import { shipmentFromFilename } from "@/lib/shipment";
import {
  emptyPriceListDoc,
  fillFromBook,
  fromParsedItems,
  isPriceListReady,
  loadPriceListDoc,
  missingCostNames,
  priceListTotals,
  removeRow,
  savePriceListDoc,
  sellingPerBag,
  setMarkup as setDocMarkup,
  setOrderNumber as setDocOrderNumber,
  setRowCost,
  toOrderItems,
  DEFAULT_MARKUP,
  type PriceListDoc,
} from "@/lib/priceList";
import {
  emptyPriceBook,
  loadPriceBook,
  priceBookSize,
  rememberPrices,
  savePriceBook,
  type PriceBook,
} from "@/lib/priceBook";
import {
  EMPTY_BUYER,
  hasBuyerInfo,
  nextRefNo,
  recordRef,
  rememberBuyer,
  type Buyer,
} from "@/lib/buyer";
import BuyerFields from "@/components/BuyerFields";
import { cn } from "@/lib/cn";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  /** What the uploaded file said, kept for its totals check. */
  const [parsed, setParsed] = useState<ParsedOrder | null>(null);
  /**
   * The sheet being put together: the rows, their costs, the markup and the order
   * number. Held here rather than read off `parsed` because a count arrives with no
   * costs and they have to be typed in, then survive a refresh.
   */
  const [doc, setDoc] = useState<PriceListDoc | null>(null);
  const [book, setBook] = useState<PriceBook>(() => emptyPriceBook());
  /** The markup field's text, so it can be emptied while typing. */
  const [markupInput, setMarkupInput] = useState(String(DEFAULT_MARKUP));
  const [buyer, setBuyer] = useState<Buyer>(EMPTY_BUYER);
  const [refNo, setRefNo] = useState("");
  // The reference this sheet was generated with, so its own number never
  // trips the "already used" warning.
  const [generatedRef, setGeneratedRef] = useState("");
  const [buyerRefreshKey, setBuyerRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Pick up an unfinished sheet, and what we last paid for things.
  useEffect(() => {
    const saved = loadPriceListDoc();
    setBook(loadPriceBook());
    if (saved.rows.length > 0) {
      setDoc(saved);
      setMarkupInput(String(saved.markup));
    }
  }, []);

  const persist = useCallback((next: PriceListDoc) => {
    setDoc(next);
    savePriceListDoc(next);
  }, []);

  const orderNumber = doc?.orderNumber ?? "";
  const markup = doc?.markup ?? DEFAULT_MARKUP;
  const totals = useMemo(
    () => priceListTotals(doc ?? emptyPriceListDoc()),
    [doc],
  );
  const ready = doc !== null && isPriceListReady(doc);

  const priceList = useMemo(() => {
    if (!doc || doc.rows.length === 0) return null;
    return buildBuyerPriceList(
      { title: doc.orderNumber.trim() || parsed?.title || "Order", items: toOrderItems(doc) },
      markup,
    );
  }, [doc, parsed, markup]);

  const handleFile = useCallback(async (f: File) => {
    setError(null);
    setNotice(null);
    setParsed(null);
    setFile(f);
    setLoading(true);
    // Read fresh rather than trusting state, so a price saved a moment ago on
    // another tab is still offered.
    const currentBook = loadPriceBook();
    setBook(currentBook);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/process", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to read the PDF.");
      }
      const loaded = data as ParsedOrder;
      setParsed(loaded);

      // Prefer the order number in the file name over the heading inside the
      // sheet, since that is what the file was tracked by. Read through
      // shipmentFromFilename, which takes a container ID out of the name first:
      // its digits would otherwise be read as the order number, and a container
      // has no business on a buyer's document.
      const fresh = fromParsedItems(loaded.items, {
        orderNumber: shipmentFromFilename(f.name).orderNumber || loaded.title,
        markup: Number.isFinite(markup) ? markup : DEFAULT_MARKUP,
        // A count has no prices, so whatever we last paid is offered.
        book: currentBook,
      });
      if (fresh.rows.length === 0) {
        throw new Error("No items with bag counts were found in that file.");
      }
      persist(fresh);
      setMarkupInput(String(fresh.markup));

      const stats = priceListTotals(fresh);
      if (stats.missing > 0) {
        setNotice(
          `Read ${stats.items} items (${stats.bags} bags). This file had no prices on it, so ${stats.missing} of them still need one${stats.remembered > 0 ? `, and ${stats.remembered} were filled in from what you last paid` : ""}.`,
        );
      } else {
        setNotice(
          stats.remembered > 0
            ? `Read ${stats.items} items (${stats.bags} bags), with ${stats.remembered} priced from what you last paid.`
            : null,
        );
      }

      // Each newly loaded sheet gets its own document reference.
      const ref = nextRefNo();
      setRefNo(ref);
      setGeneratedRef(ref);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setFile(null);
    } finally {
      setLoading(false);
    }
  }, [markup, persist]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files?.[0];
      if (f) handleFile(f);
    },
    [handleFile],
  );

  const download = useCallback(async () => {
    if (!doc) return;
    // A missing cost is not a cost of zero. Sending this now would quote the buyer
    // the markup alone, which is why it is refused rather than warned about.
    if (!isPriceListReady(doc)) {
      const waiting = missingCostNames(doc);
      setError(
        `${waiting.length} item${waiting.length === 1 ? "" : "s"} still need a price: ${waiting.slice(0, 4).join(", ")}${waiting.length > 4 ? `, and ${waiting.length - 4} more` : ""}.`,
      );
      return;
    }
    const title = doc.orderNumber.trim() || parsed?.title || "Order";
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title,
          markup: Number.isFinite(markup) ? markup : 0,
          items: toOrderItems(doc),
          buyer,
          refNo,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to generate the PDF.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = buyerPriceFilename(title);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      // Remember the buyer so it can be picked from a list next time, and
      // record the reference so a later document can warn if it is reused.
      if (hasBuyerInfo(buyer)) rememberBuyer(buyer);
      recordRef(refNo);
      setBuyerRefreshKey((k) => k + 1);

      // And remember what these bags cost, so the next count fills itself in.
      const learned = rememberPrices(
        loadPriceBook(),
        doc.rows.map((row) => ({ name: row.name, costPerBag: row.costPerBag })),
      );
      savePriceBook(learned);
      setBook(learned);
      setNotice(
        `Downloaded. ${doc.rows.length} price${doc.rows.length === 1 ? "" : "s"} remembered for next time.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setDownloading(false);
    }
  }, [doc, parsed, markup, buyer, refNo]);

  const reset = useCallback(() => {
    setFile(null);
    setParsed(null);
    setError(null);
    setNotice(null);
    const fresh = emptyPriceListDoc();
    setDoc(null);
    savePriceListDoc(fresh);
    setMarkupInput(String(DEFAULT_MARKUP));
    setBuyer(EMPTY_BUYER);
    setRefNo("");
    setGeneratedRef("");
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:py-14">
      {/* Header */}
      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
          Buyer Price List
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-gray-500">
          Upload an order sheet, set the markup, and download the buyer&apos;s
          copy. A warehouse count from the Counter works too: it comes with no
          prices, so put in what you paid for each item and the markup goes on
          as usual.
        </p>
      </header>

      {/* Error banner */}
      {error && (
        <div className="mb-6 flex animate-fade-in items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            className="rounded-md p-0.5 hover:bg-red-100"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Upload zone */}
      {!parsed && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "group flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed bg-white/70 px-6 py-16 text-center shadow-sm backdrop-blur transition-all",
            dragging
              ? "border-brand-500 bg-brand-50 ring-4 ring-brand-100"
              : "border-gray-300 hover:border-brand-400 hover:bg-white",
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          {loading ? (
            <>
              <Loader2 className="h-12 w-12 animate-spin text-brand-500" />
              <p className="mt-4 text-lg font-medium text-gray-700">
                Reading {file?.name}…
              </p>

            </>
          ) : (
            <>
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 transition-transform group-hover:scale-105">
                <UploadCloud className="h-8 w-8" />
              </div>
              <p className="mt-5 text-lg font-semibold text-gray-800">
                Drop your order PDF here
              </p>
              <p className="mt-1 text-sm text-gray-500">
                or{" "}
                <span className="font-medium text-brand-600">
                  click to browse
                </span>{" "}
                · PDF up to 15 MB
              </p>
            </>
          )}
        </div>
      )}

      {notice && !error && (
        <div className="mb-6 flex animate-fade-in items-start gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button
            onClick={() => setNotice(null)}
            className="rounded-md p-0.5 hover:bg-brand-100"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Results */}
      {doc && priceList && (
        <div className="animate-fade-in space-y-6">
          {/* File + controls card */}
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                  <FileText className="h-6 w-6" />
                </div>
                <div className="min-w-0">
                  <p className="truncate font-semibold text-gray-900">
                    {file?.name ?? doc.orderNumber ?? "Saved sheet"}
                  </p>
                  <p className="text-sm text-gray-500">
                    {totals.items} items &middot; {totals.bags} bags
                    {totals.missing > 0 && (
                      <span className="text-amber-700">
                        {" "}
                        &middot; {totals.missing} without a price
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <button
                onClick={reset}
                className="inline-flex items-center gap-2 self-start rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50 sm:self-auto"
              >
                <RefreshCw className="h-4 w-4" />
                New upload
              </button>
            </div>

            {/* Order number: the heading on the buyer's copy and the file name */}
            <div className="mt-4 border-t border-gray-100 pt-4">
              <label
                htmlFor="order-number"
                className="block text-sm font-medium text-gray-700"
              >
                Order number
              </label>
              <input
                id="order-number"
                type="text"
                value={orderNumber}
                onChange={(e) =>
                  doc && persist(setDocOrderNumber(doc, e.target.value))
                }
                placeholder={parsed?.title || "Sri Lanka 01"}
                maxLength={LIMITS.title}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm transition focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 sm:max-w-md"
              />
              <p className="mt-1.5 text-xs text-gray-500">
                Taken from the file name, and used as the heading on the
                buyer&apos;s copy. Downloads as{" "}
                <span className="font-medium text-gray-600">
                  {buyerPriceFilename(orderNumber.trim() || parsed?.title || "Order")}
                </span>
              </p>
            </div>

            {/* Validation notice, for a file that came with its own prices */}
            {parsed === null || totals.missing > 0 ? null : parsed.totalsMatch ? (
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                Totals match the source sheet.
              </div>
            ) : (
              <div className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Heads up: our computed total ({formatLKR(parsed.computedTotal)}
                  ) does not match the total printed on the PDF (
                  {parsed.printedTotal !== null
                    ? formatLKR(parsed.printedTotal)
                    : "not found"}
                  ). Please review the rows below before sending to a buyer.
                </span>
              </div>
            )}

            {/* Nothing to sell until every bag has a cost */}
            {totals.missing > 0 && (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
                <p className="flex items-start gap-2 font-medium">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  {totals.missing} of {totals.items} items still need the price
                  you paid.
                </p>
                <p className="mt-1 pl-6 text-xs text-amber-800">
                  This file carried counts but no prices. Fill in the{" "}
                  <span className="font-semibold">Cost / bag</span> column below.
                  The buyer&apos;s copy cannot be downloaded until they are all
                  in, because a bag left at zero would be quoted at the markup
                  alone.
                  {priceBookSize(book) > 0 && (
                    <>
                      {" "}
                      <button
                        onClick={() => doc && persist(fillFromBook(doc, book))}
                        className="font-semibold underline"
                      >
                        Fill any I have priced before
                      </button>
                    </>
                  )}
                </p>
              </div>
            )}

            {/* Markup control */}
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
              <label
                htmlFor="markup"
                className="text-sm font-medium text-gray-700"
              >
                Markup per bag
              </label>
              <div className="relative w-full sm:w-48">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-gray-400">
                  Rs
                </span>
                <input
                  id="markup"
                  type="number"
                  min={0}
                  step={500}
                  value={markupInput}
                  onChange={(e) => {
                    setMarkupInput(e.target.value);
                    const n = parseFloat(e.target.value);
                    // Never allow a negative markup - it would cut the price.
                    if (doc) {
                      persist(
                        setDocMarkup(doc, Number.isFinite(n) ? Math.max(0, n) : 0),
                      );
                    }
                  }}
                  className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm font-semibold text-gray-900 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                />
              </div>
              <span className="text-sm text-gray-400">
                added to every item
              </span>
            </div>
          </div>

          {/* Buyer details */}
          <BuyerFields
            value={buyer}
            onChange={setBuyer}
            refNo={refNo}
            onRefChange={setRefNo}
            knownRef={generatedRef}
            refreshKey={buyerRefreshKey}
            description="Printed at the top of the price list."
          />

          {/* Summary stats */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <StatCard label="Total Bags" value={totals.bags.toString()} />
            <StatCard
              label="Buyer Grand Total"
              value={totals.missing > 0 ? "-" : formatLKR(totals.selling)}
              highlight
            />
            <StatCard
              label="Added by Markup"
              value={formatLKR(totals.markupTotal)}
            />
          </div>

          {/* Preview table */}
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
            <div className="preview-scroll max-h-[460px] overflow-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 z-10 bg-gray-900 text-white">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold">
                      Item Name
                    </th>
                    <th className="px-4 py-3 text-center font-semibold">Qty</th>
                    <th className="px-4 py-3 text-right font-semibold">
                      Cost / bag
                    </th>
                    <th className="px-4 py-3 text-right font-semibold">
                      Per Bag
                    </th>
                    <th className="px-4 py-3 text-right font-semibold">Total</th>
                    <th className="px-2 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {doc.rows.map((row, i) => {
                    const needsPrice = row.costPerBag <= 0;
                    return (
                      <tr
                        key={row.id}
                        className={cn(
                          "border-b border-gray-100 transition-colors hover:bg-brand-50/50",
                          i % 2 === 1 && "bg-gray-50/60",
                          needsPrice && "bg-amber-50/70 hover:bg-amber-50",
                        )}
                      >
                        <td className="px-4 py-2.5 text-gray-800">{row.name}</td>
                        <td className="px-4 py-2.5 text-center text-gray-600">
                          {row.qty}
                        </td>
                        <td className="px-4 py-1.5 text-right">
                          <input
                            type="number"
                            min={0}
                            step={500}
                            value={row.costPerBag === 0 ? "" : row.costPerBag}
                            placeholder="0"
                            aria-label={`What a bag of ${row.name} cost`}
                            onChange={(e) =>
                              persist(
                                setRowCost(doc, row.id, Number(e.target.value)),
                              )
                            }
                            className={cn(
                              "w-28 rounded-md border px-2 py-1 text-right tabular-nums outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100",
                              needsPrice
                                ? "border-amber-400 bg-white"
                                : row.remembered
                                  ? "border-blue-200 bg-blue-50/60 text-blue-900"
                                  : "border-transparent bg-transparent text-gray-700 hover:border-gray-200",
                            )}
                          />
                          {row.remembered && (
                            <span
                              title="What you last paid for this item"
                              className="ml-1 text-[10px] font-medium uppercase text-blue-500"
                            >
                              last
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium text-gray-900">
                          {needsPrice ? (
                            <span className="text-amber-700">&mdash;</span>
                          ) : (
                            formatLKR(sellingPerBag(row, markup))
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium text-gray-900">
                          {needsPrice ? (
                            <span className="text-amber-700">&mdash;</span>
                          ) : (
                            formatLKR(row.qty * sellingPerBag(row, markup))
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-right">
                          <button
                            onClick={() => persist(removeRow(doc, row.id))}
                            title="Take this item off the list"
                            className="rounded-md p-1 text-gray-300 transition hover:bg-red-50 hover:text-red-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="sticky bottom-0 bg-brand-100 font-bold text-gray-900">
                  <tr>
                    <td className="px-4 py-3">Total</td>
                    <td className="px-4 py-3 text-center">{totals.bags}</td>
                    <td className="px-4 py-3 text-right">
                      {formatLKR(totals.cost)}
                    </td>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3 text-right">
                      {totals.missing > 0 ? "\u2014" : formatLKR(totals.selling)}
                    </td>
                    <td className="px-2 py-3" />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Download */}
          <div className="flex flex-wrap items-center justify-end gap-3">
            {!ready && (
              <p className="text-xs font-medium text-amber-700">
                {totals.missing} item{totals.missing === 1 ? "" : "s"} still need a
                price
              </p>
            )}
            <button
              onClick={download}
              disabled={downloading || !ready}
              title={
                ready
                  ? undefined
                  : "Every item needs the price you paid before this can be sent to a buyer"
              }
              className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-600/25 transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {downloading ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <Download className="h-5 w-5" />
                  Download Buyer PDF
                </>
              )}
            </button>
          </div>
        </div>
      )}

      <footer className="mt-16 text-center text-xs text-gray-400">
        Built by Lathurshan
      </footer>
    </main>
  );
}

function StatCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border p-4 shadow-sm",
        highlight
          ? "border-brand-200 bg-brand-50"
          : "border-gray-200 bg-white",
      )}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 truncate text-lg font-bold",
          highlight ? "text-brand-700" : "text-gray-900",
        )}
      >
        {value}
      </p>
    </div>
  );
}

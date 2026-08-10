"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  UploadCloud,
  FileText,
  Download,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  X,
} from "lucide-react";
import type { ParsedOrder } from "@/lib/types";
import { buildBuyerPriceList, formatLKR } from "@/lib/types";
import {
  EMPTY_BUYER,
  hasBuyerInfo,
  nextRefNo,
  rememberBuyer,
  type Buyer,
} from "@/lib/buyer";
import BuyerFields from "@/components/BuyerFields";
import { cn } from "@/lib/cn";

const DEFAULT_MARKUP = 2000;

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedOrder | null>(null);
  const [markup, setMarkup] = useState<number>(DEFAULT_MARKUP);
  const [buyer, setBuyer] = useState<Buyer>(EMPTY_BUYER);
  const [refNo, setRefNo] = useState("");
  const [buyerRefreshKey, setBuyerRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const priceList = useMemo(() => {
    if (!parsed) return null;
    return buildBuyerPriceList(
      { title: parsed.title, items: parsed.items },
      Number.isFinite(markup) ? markup : 0,
    );
  }, [parsed, markup]);

  const handleFile = useCallback(async (f: File) => {
    setError(null);
    setParsed(null);
    setFile(f);
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/process", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to read the PDF.");
      }
      setParsed(data as ParsedOrder);
      // Each newly loaded sheet gets its own document reference.
      setRefNo(nextRefNo());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setFile(null);
    } finally {
      setLoading(false);
    }
  }, []);

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
    if (!parsed) return;
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: parsed.title,
          markup: Number.isFinite(markup) ? markup : 0,
          items: parsed.items,
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
      a.download = `${parsed.title} - Buyer Price List.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      // Remember the buyer so it can be picked from a list next time.
      if (hasBuyerInfo(buyer)) {
        rememberBuyer(buyer);
        setBuyerRefreshKey((k) => k + 1);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setDownloading(false);
    }
  }, [parsed, markup, buyer, refNo]);

  const reset = useCallback(() => {
    setFile(null);
    setParsed(null);
    setError(null);
    setMarkup(DEFAULT_MARKUP);
    setBuyer(EMPTY_BUYER);
    setRefNo("");
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
          copy.
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

      {/* Results */}
      {parsed && priceList && (
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
                    {parsed.title}
                  </p>
                  <p className="text-sm text-gray-500">
                    {parsed.items.length} items · {parsed.totalQty} bags
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

            {/* Validation notice */}
            {parsed.totalsMatch ? (
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
                  value={Number.isFinite(markup) ? markup : ""}
                  onChange={(e) => {
                    const n = parseFloat(e.target.value);
                    // Never allow a negative markup - it would cut the price.
                    setMarkup(Number.isFinite(n) ? Math.max(0, n) : NaN);
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
            refreshKey={buyerRefreshKey}
            description="Printed at the top of the price list."
          />

          {/* Summary stats */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <StatCard label="Total Bags" value={priceList.totalQty.toString()} />
            <StatCard
              label="Buyer Grand Total"
              value={formatLKR(priceList.grandTotal)}
              highlight
            />
            <StatCard
              label="Added by Markup"
              value={formatLKR(priceList.totalQty * markup)}
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
                      Per Bag
                    </th>
                    <th className="px-4 py-3 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {priceList.rows.map((r, i) => (
                    <tr
                      key={`${r.name}-${i}`}
                      className={cn(
                        "border-b border-gray-100 transition-colors hover:bg-brand-50/50",
                        i % 2 === 1 && "bg-gray-50/60",
                      )}
                    >
                      <td className="px-4 py-2.5 text-gray-800">{r.name}</td>
                      <td className="px-4 py-2.5 text-center text-gray-600">
                        {r.qty}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-gray-900">
                        {formatLKR(r.perBag)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-gray-900">
                        {formatLKR(r.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 bg-brand-100 font-bold text-gray-900">
                  <tr>
                    <td className="px-4 py-3">Total</td>
                    <td className="px-4 py-3 text-center">
                      {priceList.totalQty}
                    </td>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3 text-right">
                      {formatLKR(priceList.grandTotal)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Download */}
          <div className="flex justify-end">
            <button
              onClick={download}
              disabled={downloading}
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

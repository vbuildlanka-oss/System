"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  Download,
  EyeOff,
  Loader2,
  RotateCcw,
  Sheet as SheetIcon,
  Trash2,
  UploadCloud,
  X,
  Zap,
} from "lucide-react";
import type { ParsedOrder } from "@/lib/types";
import { formatLKR, LIMITS } from "@/lib/types";
import {
  calcTotals,
  emptyCalcDoc,
  fromOrderItems,
  lineProfit,
  lineTotal,
  loadCalcDoc,
  removeCalcRow,
  resetAllMarkups,
  resetRowMarkup,
  saveCalcDoc,
  sellingPerBag,
  setBaseMarkup,
  setFastMarkup,
  setOrderNumber,
  setRowMarkup,
  toggleFast,
  DEFAULT_MARKUP,
  type CalcDoc,
} from "@/lib/calculation";
import { shipmentFromFilename } from "@/lib/shipment";
import { cn } from "@/lib/cn";

/**
 * Working out the markup, item by item.
 *
 * Private. Everything on this page is a cost or a profit, which is exactly what
 * the price lists, manifests, requests and the balance sheet are careful never to
 * show. Nothing here is written into any of those, and no other page reads it.
 */
export default function CalculationPage() {
  const [doc, setDoc] = useState<CalcDoc | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [baseInput, setBaseInput] = useState(String(DEFAULT_MARKUP));
  const [fastInput, setFastInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const loaded = loadCalcDoc();
    setDoc(loaded);
    setBaseInput(String(loaded.baseMarkup));
  }, []);

  const persist = useCallback((next: CalcDoc) => {
    setDoc(next);
    saveCalcDoc(next);
  }, []);

  const totals = useMemo(() => calcTotals(doc ?? emptyCalcDoc()), [doc]);
  const rows = doc?.rows ?? [];
  const fastCount = rows.filter((row) => row.fast).length;

  /* --------------------------------- upload -------------------------------- */

  const handleFile = useCallback(
    async (f: File) => {
      setError(null);
      setNotice(null);
      setFile(f);
      setLoading(true);
      try {
        const fd = new FormData();
        fd.append("file", f);
        const res = await fetch("/api/process", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not read that file.");

        const parsed = data as ParsedOrder;
        const base = Number(baseInput);
        // The order number comes from the file name, the same way every other
        // page reads it, so the download can be matched back to its order.
        const orderNumber =
          shipmentFromFilename(f.name).orderNumber || parsed.title;
        const next = fromOrderItems(
          parsed.items,
          Number.isFinite(base) ? base : DEFAULT_MARKUP,
          orderNumber,
        );
        if (next.rows.length === 0) {
          throw new Error("No items with bag counts were found in that file.");
        }
        persist(next);
        setNotice(
          `Read ${next.rows.length} items (${calcTotals(next).bags} bags) from ${f.name}.` +
            (parsed.totalsMatch
              ? ""
              : " Note: the totals in the file did not add up, so check the bag counts."),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        setFile(null);
      } finally {
        setLoading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [baseInput, persist],
  );

  /* -------------------------------- markups -------------------------------- */

  const applyBase = useCallback(() => {
    if (!doc) return;
    const value = Number(baseInput);
    if (!Number.isFinite(value) || value < 0) {
      setError("Enter a markup of zero or more.");
      return;
    }
    const kept = doc.rows.filter((row) => row.overridden).length;
    persist(setBaseMarkup(doc, value));
    setError(null);
    setNotice(
      `Markup of ${formatLKR(value)} a bag applied.` +
        (kept > 0
          ? ` ${kept} item${kept === 1 ? "" : "s"} you set by hand kept their own.`
          : ""),
    );
  }, [doc, baseInput, persist]);

  const applyFast = useCallback(() => {
    if (!doc) return;
    const value = Number(fastInput);
    if (!Number.isFinite(value) || value < 0) {
      setError("Enter a markup of zero or more for the fast movers.");
      return;
    }
    if (fastCount === 0) {
      setError("No items are marked as fast moving yet.");
      return;
    }
    persist(setFastMarkup(doc, value));
    setError(null);
    setNotice(
      `${formatLKR(value)} a bag applied to ${fastCount} fast-moving item${fastCount === 1 ? "" : "s"}.`,
    );
  }, [doc, fastInput, fastCount, persist]);

  const download = useCallback(async () => {
    if (!doc || doc.rows.length === 0) {
      setError("There is nothing to download yet.");
      return;
    }
    setBuilding(true);
    setError(null);
    try {
      const res = await fetch("/api/calculation-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "The spreadsheet could not be built.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stem = doc.orderNumber.replace(/[^\w\d\- ]+/g, " ").trim() || "Order";
      a.download = `${stem} - Markup Calculation INTERNAL.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice(
        "Downloaded. The file is marked INTERNAL in its name and on the sheet - it holds costs and profit, so keep it out of anything you send out.",
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "The spreadsheet could not be built.",
      );
    } finally {
      setBuilding(false);
    }
  }, [doc]);

  const clear = useCallback(() => {
    const next = emptyCalcDoc();
    persist(next);
    setBaseInput(String(next.baseMarkup));
    setFile(null);
    setNotice(null);
    setError(null);
  }, [persist]);

  /* --------------------------------- render -------------------------------- */

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-5">
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold tracking-tight text-gray-900">
          <Calculator className="h-6 w-6 text-brand-600" />
          Calculation
          <span className="inline-flex items-center gap-1 rounded-full bg-gray-900 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">
            <EyeOff className="h-3 w-3" />
            Private
          </span>
        </h1>
        <p className="mt-1.5 max-w-3xl text-sm text-gray-600">
          Upload the bags you have been asked for, set the markup that goes on
          every bag, then change it per item where it needs to be. The markup is
          the profit.
        </p>
        <p className="mt-2 flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            This page and its spreadsheet are the only place costs and markup
            appear. Nothing here reaches the price lists, bag manifests, requests
            or the balance sheet, so those stay safe to send to buyers and
            investors.
          </span>
        </p>
      </header>

      {error && (
        <div className="mb-4 flex animate-fade-in items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {notice && !error && (
        <div className="mb-4 flex animate-fade-in items-start gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.csv,.xlsx,application/pdf,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />

      {rows.length === 0 ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) handleFile(f);
          }}
          className={cn(
            "rounded-2xl border-2 border-dashed p-10 text-center transition",
            dragging
              ? "border-brand-400 bg-brand-50"
              : "border-gray-300 bg-white hover:border-gray-400",
          )}
        >
          {loading ? (
            <>
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-brand-600" />
              <p className="mt-3 text-sm text-gray-600">
                Reading {file?.name}...
              </p>
            </>
          ) : (
            <>
              <UploadCloud className="mx-auto h-9 w-9 text-gray-400" />
              <p className="mt-3 font-medium text-gray-900">
                Upload the requested bags
              </p>
              <p className="mt-1 text-sm text-gray-500">
                A PDF, CSV or XLSX with item names, bag counts and the price you
                pay. Drag it here, or
              </p>
              <button
                onClick={() => inputRef.current?.click()}
                className="mt-3 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
              >
                <UploadCloud className="h-4 w-4" />
                Choose a file
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="Bags" value={String(totals.bags)} />
            <Stat label="They cost" value={formatLKR(totals.cost)} />
            <Stat
              label="Profit (markup)"
              value={formatLKR(totals.profit)}
              tone="good"
            />
            <Stat label="Sells for" value={formatLKR(totals.selling)} />
            <Stat
              label="Markup a bag"
              value={
                totals.averageMarkup === null
                  ? "-"
                  : formatLKR(totals.averageMarkup)
              }
            />
          </div>

          {/* Controls */}
          <section className="mt-5 rounded-2xl border border-gray-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-gray-100 px-5 py-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900">
                  {doc?.orderNumber || "Untitled order"}
                </p>
                <input
                  value={doc?.orderNumber ?? ""}
                  onChange={(e) =>
                    doc && persist(setOrderNumber(doc, e.target.value))
                  }
                  placeholder="Order number"
                  maxLength={LIMITS.title}
                  className="mt-1 w-56 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                />
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs font-medium text-gray-600">
                  Markup on every bag
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      value={baseInput}
                      onChange={(e) => setBaseInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && applyBase()}
                      type="number"
                      min="0"
                      className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                    />
                    <button
                      onClick={applyBase}
                      className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
                    >
                      Apply
                    </button>
                  </div>
                </label>
                <label className="text-xs font-medium text-gray-600">
                  <span className="inline-flex items-center gap-1">
                    <Zap className="h-3 w-3 text-amber-500" />
                    Fast movers ({fastCount})
                  </span>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      value={fastInput}
                      onChange={(e) => setFastInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && applyFast()}
                      type="number"
                      min="0"
                      placeholder="Markup"
                      className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
                    />
                    <button
                      onClick={applyFast}
                      disabled={fastCount === 0}
                      title="Give every item marked fast moving this markup"
                      className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 transition hover:bg-amber-100 disabled:opacity-40"
                    >
                      Apply
                    </button>
                  </div>
                </label>
              </div>
            </div>

            {totals.overridden > 0 && (
              <p className="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-blue-50/50 px-5 py-2 text-xs text-blue-800">
                {totals.overridden} item
                {totals.overridden === 1 ? " has" : "s have"} a markup you set by
                hand. Changing the figure above leaves{" "}
                {totals.overridden === 1 ? "it" : "them"} alone.
                <button
                  onClick={() => doc && persist(resetAllMarkups(doc))}
                  className="inline-flex items-center gap-1 font-medium underline"
                >
                  <RotateCcw className="h-3 w-3" />
                  Put everything back on {formatLKR(doc?.baseMarkup ?? 0)}
                </button>
              </p>
            )}

            {/* The list */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead className="border-b border-gray-100 bg-gray-50/70 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Item</th>
                    <th className="px-2 py-2 text-right font-medium">Bags</th>
                    <th className="px-2 py-2 text-right font-medium">
                      Cost / bag
                    </th>
                    <th className="px-2 py-2 text-right font-medium">
                      Markup / bag
                    </th>
                    <th className="px-2 py-2 text-right font-medium">
                      Selling / bag
                    </th>
                    <th className="px-2 py-2 text-right font-medium">Profit</th>
                    <th className="px-2 py-2 text-center font-medium">Fast</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className={cn(
                        "hover:bg-gray-50/60",
                        row.fast && "bg-amber-50/40",
                      )}
                    >
                      <td className="px-4 py-2 font-medium text-gray-900">
                        {row.name}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-gray-600">
                        {row.qty}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-gray-600">
                        {formatLKR(row.costPerBag)}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <input
                            value={row.markup}
                            type="number"
                            min="0"
                            onChange={(e) =>
                              doc &&
                              persist(
                                setRowMarkup(doc, row.id, Number(e.target.value)),
                              )
                            }
                            className={cn(
                              "w-24 rounded-md border border-transparent bg-transparent px-2 py-1 text-right tabular-nums outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100",
                              row.overridden
                                ? "font-semibold text-blue-700"
                                : "text-gray-700",
                            )}
                          />
                          {row.overridden && (
                            <button
                              onClick={() =>
                                doc && persist(resetRowMarkup(doc, row.id))
                              }
                              title={`Back to ${formatLKR(doc?.baseMarkup ?? 0)}`}
                              className="rounded p-0.5 text-gray-300 transition hover:bg-gray-100 hover:text-gray-600"
                            >
                              <RotateCcw className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums font-medium text-gray-900">
                        {formatLKR(sellingPerBag(row))}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums font-semibold text-emerald-700">
                        {formatLKR(lineProfit(row))}
                      </td>
                      <td className="px-2 py-2 text-center">
                        <button
                          onClick={() => doc && persist(toggleFast(doc, row.id))}
                          title={
                            row.fast
                              ? "Marked fast moving"
                              : "Mark as fast moving"
                          }
                          className={cn(
                            "rounded-md p-1 transition",
                            row.fast
                              ? "bg-amber-100 text-amber-700"
                              : "text-gray-300 hover:bg-gray-100 hover:text-gray-500",
                          )}
                        >
                          <Zap className="h-4 w-4" />
                        </button>
                      </td>
                      <td className="px-2 py-2 text-right">
                        <button
                          onClick={() =>
                            doc && persist(removeCalcRow(doc, row.id))
                          }
                          title="Take this item out"
                          className="rounded-md p-1 text-gray-400 transition hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-brand-100 bg-brand-50/40 text-sm font-semibold">
                  <tr>
                    <td className="px-4 py-2 text-gray-900">Total</td>
                    <td className="px-2 py-2 text-right tabular-nums text-gray-900">
                      {totals.bags}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-gray-700">
                      {formatLKR(totals.cost)}
                    </td>
                    <td className="px-2 py-2" />
                    <td className="px-2 py-2 text-right tabular-nums text-gray-900">
                      {formatLKR(totals.selling)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-emerald-700">
                      {formatLKR(totals.profit)}
                    </td>
                    <td className="px-2 py-2" colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Fast versus steady */}
            {fastCount > 0 && (
              <div className="grid gap-3 border-t border-gray-100 px-5 py-4 sm:grid-cols-2">
                <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <span className="font-semibold">Fast movers:</span>{" "}
                  {totals.fastBags} bags, {formatLKR(totals.fastProfit)} profit
                </div>
                <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700">
                  <span className="font-semibold">Steady:</span>{" "}
                  {totals.normalBags} bags, {formatLKR(totals.normalProfit)}{" "}
                  profit
                </div>
              </div>
            )}
          </section>

          {/* Actions */}
          <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
            <button
              onClick={clear}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
            >
              <Trash2 className="h-4 w-4" />
              Start again
            </button>
            <button
              onClick={() => inputRef.current?.click()}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-40"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UploadCloud className="h-4 w-4" />
              )}
              Upload another file
            </button>
            <button
              onClick={download}
              disabled={building}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-40"
            >
              {building ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <SheetIcon className="h-4 w-4" />
              )}
              {building ? "Building..." : "Download spreadsheet"}
            </button>
          </div>
          <p className="mt-2 text-right text-xs text-gray-400">
            Bags, cost and markup are the only typed figures; selling prices,
            profit and the totals are live formulas, so you can try a markup in
            Excel too. Saved as{" "}
            <span className="font-medium text-gray-500">
              ... Markup Calculation INTERNAL.xlsx
            </span>
          </p>
        </>
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good";
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border p-4 shadow-sm",
        tone === "good"
          ? "border-emerald-200 bg-emerald-50"
          : "border-gray-200 bg-white",
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 truncate text-lg font-bold",
          tone === "good" ? "text-emerald-800" : "text-gray-900",
        )}
      >
        {value}
      </p>
    </div>
  );
}

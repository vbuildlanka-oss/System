"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  Minus,
  Plus,
  RotateCcw,
  Search,
  Sheet as SheetIcon,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import type { ParsedOrder } from "@/lib/types";
import { LIMITS } from "@/lib/types";
import {
  addItem,
  addToCount,
  bestMatch,
  clearCount,
  countStatus,
  countTotals,
  difference,
  emptyCountDoc,
  fromOrderItems,
  isCountComplete,
  loadCountDoc,
  removeRow,
  resetCounts,
  saveCountDoc,
  searchRows,
  setContainer,
  setCount,
  setOrderNumber,
  CONTAINER_LABEL_MAX,
  type CountDoc,
  type CountRow,
} from "@/lib/counter";
import { shipmentFromFilename } from "@/lib/shipment";
import { cn } from "@/lib/cn";

type Filter = "all" | "todo" | "off";

/**
 * Counting bags on a warehouse floor.
 *
 * Built for one hand and a phone: a search box that stays focused, big targets,
 * and Enter to tally the item you just typed. Every change is saved as it happens,
 * because a count takes hours and losing it halfway would be unforgivable.
 */
export default function CounterPage() {
  const [doc, setDoc] = useState<CountDoc | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [newItem, setNewItem] = useState("");
  /** The row just changed, so it can be flashed and scrolled to. */
  const [lastTouched, setLastTouched] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDoc(loadCountDoc());
  }, []);

  const persist = useCallback((next: CountDoc) => {
    setDoc(next);
    saveCountDoc(next);
  }, []);

  const totals = useMemo(() => countTotals(doc ?? emptyCountDoc()), [doc]);

  const visible = useMemo(() => {
    if (!doc) return [];
    const found = searchRows(doc, query);
    if (filter === "todo") return found.filter((row) => !row.touched);
    if (filter === "off") {
      return found.filter((row) => row.touched && difference(row) !== 0);
    }
    return found;
  }, [doc, query, filter]);

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
        const orderNumber =
          shipmentFromFilename(f.name).orderNumber || parsed.title;
        // Only names and quantities cross over. The prices in that file stay in it.
        const next = fromOrderItems(
          parsed.items.map((item) => ({ name: item.name, qty: item.qty })),
          doc?.containerId ?? "",
          orderNumber,
        );
        if (next.rows.length === 0) {
          throw new Error("No items were found in that file.");
        }
        persist(next);
        setQuery("");
        setFilter("all");
        setNotice(
          `${next.rows.length} items to count, ${countTotals(next).expected} bags expected. Every count starts at zero.`,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        setFile(null);
      } finally {
        setLoading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [doc, persist],
  );

  /* -------------------------------- counting ------------------------------- */

  const bump = useCallback(
    (row: CountRow, by: number) => {
      if (!doc) return;
      persist(addToCount(doc, row.id, by));
      setLastTouched(row.id);
    },
    [doc, persist],
  );

  /**
   * Enter in the search box tallies the best match.
   *
   * The point of the page: type three letters, hit Enter, the count goes up, and
   * the box clears ready for the next item. No hunting through a list with one
   * hand full of bags.
   */
  const tallyBestMatch = useCallback(() => {
    if (!doc) return;
    const match = bestMatch(doc, query);
    if (!match) {
      setError(`Nothing here matches "${query.trim()}". Add it below if it is new.`);
      return;
    }
    persist(addToCount(doc, match.id, 1));
    setLastTouched(match.id);
    setError(null);
    setNotice(`${match.name}: ${match.counted + 1}`);
    setQuery("");
    searchRef.current?.focus();
  }, [doc, query, persist]);

  const submitNewItem = useCallback(() => {
    if (!doc) return;
    const result = addItem(doc, newItem);
    if (!result.row) {
      setError("Give the item a name.");
      return;
    }
    if (result.existed) {
      // Two rows for one item would let a count split across both.
      setError(null);
      setNotice(`${result.row.name} is already on the list.`);
      setQuery(result.row.name);
      setNewItem("");
      setLastTouched(result.row.id);
      return;
    }
    persist(result.doc);
    setNewItem("");
    setError(null);
    setNotice(`${result.row.name} added. It was not on the list.`);
    setLastTouched(result.row.id);
  }, [doc, newItem, persist]);

  const download = useCallback(async () => {
    if (!doc || doc.rows.length === 0) {
      setError("There is nothing to export yet.");
      return;
    }
    setBuilding(true);
    setError(null);
    try {
      const res = await fetch("/api/count-export", {
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
      const stem = [doc.orderNumber, doc.containerId]
        .map((part) => part.replace(/[^\w\d\- ]+/g, " ").trim())
        .filter((part) => part !== "")
        .join(" - ");
      a.download = `${stem || "Warehouse"} - Bag Count.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice(
        totals.untouched > 0
          ? `Downloaded, but ${totals.untouched} item${totals.untouched === 1 ? "" : "s"} were never counted - those are listed with an empty count rather than a zero.`
          : "Downloaded. Every item was counted.",
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "The spreadsheet could not be built.",
      );
    } finally {
      setBuilding(false);
    }
  }, [doc, totals.untouched]);

  const rows = doc?.rows ?? [];
  const complete = doc !== null && isCountComplete(doc);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-gray-900">
          <ClipboardCheck className="h-6 w-6 text-brand-600" />
          Counter
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-gray-600">
          Counting bags in the warehouse. Upload the buyer list to get the items,
          then search and tally each one up from zero. Saved as you go.
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

      {/* Which container is being counted */}
      <section className="mb-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-gray-600">
            Container
            <input
              value={doc?.containerId ?? ""}
              onChange={(e) => doc && persist(setContainer(doc, e.target.value))}
              placeholder="GAOU7441740, or Back room"
              maxLength={CONTAINER_LABEL_MAX}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
            />
          </label>
          <label className="text-xs font-medium text-gray-600">
            Order number
            <input
              value={doc?.orderNumber ?? ""}
              onChange={(e) =>
                doc && persist(setOrderNumber(doc, e.target.value))
              }
              placeholder="Read from the file name"
              maxLength={LIMITS.title}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
            />
          </label>
        </div>
      </section>

      {rows.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-gray-300 bg-white p-10 text-center">
          {loading ? (
            <>
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-brand-600" />
              <p className="mt-3 text-sm text-gray-600">Reading {file?.name}...</p>
            </>
          ) : (
            <>
              <UploadCloud className="mx-auto h-9 w-9 text-gray-400" />
              <p className="mt-3 font-medium text-gray-900">
                Upload the buyer list
              </p>
              <p className="mt-1 text-sm text-gray-500">
                A PDF, CSV or XLSX. Only the item names and bag counts are used -
                no prices come across.
              </p>
              <button
                onClick={() => inputRef.current?.click()}
                className="mt-3 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
              >
                <UploadCloud className="h-4 w-4" />
                Choose a file
              </button>
              <p className="mt-4 text-xs text-gray-400">
                Or add items by hand below and count without a list.
              </p>
              <div className="mx-auto mt-2 flex max-w-sm gap-2">
                <input
                  value={newItem}
                  onChange={(e) => setNewItem(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitNewItem()}
                  placeholder="Item name"
                  maxLength={LIMITS.itemName}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                />
                <button
                  onClick={submitNewItem}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                >
                  Add
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          {/* Progress */}
          <div className="mb-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-gray-900">
                {totals.counted} bags counted
                <span className="ml-2 text-xs font-normal text-gray-500">
                  of {totals.expected} expected
                </span>
              </p>
              <p
                className={cn(
                  "text-sm font-semibold tabular-nums",
                  totals.difference === 0
                    ? "text-gray-500"
                    : totals.difference < 0
                      ? "text-red-700"
                      : "text-amber-700",
                )}
              >
                {totals.difference > 0 ? "+" : ""}
                {totals.difference}
              </p>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  complete ? "bg-emerald-500" : "bg-brand-500",
                )}
                style={{ width: `${totals.progress ?? 0}%` }}
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
              <span>
                {totals.touched} of {totals.items} items counted
              </span>
              {totals.matched > 0 && (
                <span className="text-emerald-700">{totals.matched} matched</span>
              )}
              {totals.short > 0 && (
                <span className="text-red-700">{totals.short} short</span>
              )}
              {totals.over > 0 && (
                <span className="text-amber-700">{totals.over} over</span>
              )}
              {totals.added > 0 && (
                <span className="text-blue-700">{totals.added} not on the list</span>
              )}
            </div>
            {complete && (
              <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Every item has been counted.
              </p>
            )}
          </div>

          {/* Search: the main tool */}
          <div className="sticky top-16 z-10 mb-3 rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    tallyBestMatch();
                  }
                  if (e.key === "Escape") setQuery("");
                }}
                placeholder="Search an item, then press Enter to add one"
                autoComplete="off"
                className="w-full rounded-lg border border-gray-300 py-2.5 pl-9 pr-3 text-base outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {(
                [
                  ["all", `All ${totals.items}`],
                  ["todo", `Not counted ${totals.untouched}`],
                  ["off", `Doesn't match ${totals.short + totals.over}`],
                ] as Array<[Filter, string]>
              ).map((entry) => (
                <button
                  key={entry[0]}
                  onClick={() => setFilter(entry[0])}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium transition",
                    filter === entry[0]
                      ? "bg-gray-900 text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200",
                  )}
                >
                  {entry[1]}
                </button>
              ))}
            </div>
          </div>

          {/* The list */}
          {visible.length === 0 ? (
            <p className="rounded-2xl border border-gray-200 bg-white px-5 py-10 text-center text-sm text-gray-500">
              {filter === "todo"
                ? "Nothing left to count."
                : filter === "off"
                  ? "Every counted item matches the list."
                  : `Nothing matches "${query.trim()}".`}
            </p>
          ) : (
            <ul className="space-y-2">
              {visible.map((row) => {
                const status = countStatus(row);
                const diff = difference(row);
                return (
                  <li
                    key={row.id}
                    className={cn(
                      "rounded-xl border bg-white p-3 shadow-sm transition",
                      lastTouched === row.id
                        ? "border-brand-400 ring-2 ring-brand-100"
                        : status === "short"
                          ? "border-red-200"
                          : status === "over"
                            ? "border-amber-200"
                            : status === "matched"
                              ? "border-emerald-200"
                              : "border-gray-200",
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            "truncate font-medium text-gray-900",
                            row.added && "italic text-blue-800",
                          )}
                        >
                          {row.name}
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-gray-500">
                          {row.added ? (
                            <span className="text-blue-700">not on the list</span>
                          ) : (
                            <span>{row.expected} expected</span>
                          )}
                          {row.touched && !row.added && diff !== 0 && (
                            <span
                              className={cn(
                                "font-medium",
                                diff < 0 ? "text-red-700" : "text-amber-700",
                              )}
                            >
                              {diff > 0 ? "+" : ""}
                              {diff}
                            </span>
                          )}
                          {row.touched && diff === 0 && !row.added && (
                            <span className="font-medium text-emerald-700">
                              matches
                            </span>
                          )}
                          {!row.touched && (
                            <span className="text-gray-400">not counted yet</span>
                          )}
                        </p>
                      </div>

                      {/* Big targets: this gets tapped with one hand */}
                      <button
                        onClick={() => bump(row, -1)}
                        disabled={row.counted === 0}
                        aria-label={`One fewer ${row.name}`}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-gray-300 text-gray-700 transition hover:bg-gray-50 active:bg-gray-100 disabled:opacity-30"
                      >
                        <Minus className="h-5 w-5" />
                      </button>
                      <input
                        value={row.counted}
                        onChange={(e) =>
                          doc &&
                          persist(setCount(doc, row.id, Number(e.target.value)))
                        }
                        type="number"
                        min="0"
                        aria-label={`Bags of ${row.name}`}
                        className={cn(
                          "h-11 w-16 shrink-0 rounded-lg border text-center text-lg font-bold tabular-nums outline-none transition focus:ring-2 focus:ring-brand-100",
                          row.touched
                            ? "border-gray-300 text-gray-900"
                            : "border-gray-200 text-gray-400",
                        )}
                      />
                      <button
                        onClick={() => bump(row, 1)}
                        aria-label={`One more ${row.name}`}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white shadow-sm transition hover:bg-brand-700 active:bg-brand-800"
                      >
                        <Plus className="h-5 w-5" />
                      </button>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {[5, 10, 25].map((step) => (
                        <button
                          key={step}
                          onClick={() => bump(row, step)}
                          className="rounded-md bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 transition hover:bg-gray-200"
                        >
                          +{step}
                        </button>
                      ))}
                      {row.touched && (
                        <button
                          onClick={() => doc && persist(clearCount(doc, row.id))}
                          title="Back to never counted"
                          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
                        >
                          <RotateCcw className="h-3 w-3" />
                          Clear
                        </button>
                      )}
                      {row.added && (
                        <button
                          onClick={() => doc && persist(removeRow(doc, row.id))}
                          title="Remove this item"
                          className={cn(
                            "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-400 transition hover:bg-red-50 hover:text-red-600",
                            !row.touched && "ml-auto",
                          )}
                        >
                          <Trash2 className="h-3 w-3" />
                          Remove
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Add something found on the floor */}
          <section className="mt-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-medium text-gray-600">
              Found something that is not on the list?
            </p>
            <div className="mt-2 flex gap-2">
              <input
                value={newItem}
                onChange={(e) => setNewItem(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitNewItem()}
                placeholder="Item name"
                maxLength={LIMITS.itemName}
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              />
              <button
                onClick={submitNewItem}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                <Plus className="h-4 w-4" />
                Add item
              </button>
            </div>
          </section>

          {/* Actions */}
          <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
            <button
              onClick={() => {
                if (doc) persist(resetCounts(doc));
                setNotice("Every tally is back to zero. The item list is kept.");
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
            >
              <RotateCcw className="h-4 w-4" />
              Start the count again
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
              New list
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
              {building ? "Building..." : "Download the count"}
            </button>
          </div>
          <p className="mt-2 text-right text-xs text-gray-400">
            The sheet holds the item name and the count, with a live total and no
            prices. An item nobody reached is listed with an empty cell rather
            than a zero. What was expected, and whether it matches, stays here on
            the page.
          </p>
        </>
      )}
    </main>
  );
}

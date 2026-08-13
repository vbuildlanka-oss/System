"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ListChecks,
  Plus,
  Trash2,
  Save,
  FolderOpen,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle2,
  X,
  Search,
  PackageCheck,
  PackagePlus,
  Boxes,
  Minus,
  UploadCloud,
  Loader2,
} from "lucide-react";
import BuyerFields from "@/components/BuyerFields";
import { EMPTY_BUYER, rememberBuyer, hasBuyerInfo, type Buyer } from "@/lib/buyer";
import type { ParsedOrder } from "@/lib/types";
import {
  addSource,
  ALL_SOURCES_ID,
  availabilityFromSource,
  availabilityFromStockpile,
  combineAvailability,
  createRequest,
  createSource,
  loadRequests,
  markSupplied,
  matchRequest,
  matchSummary,
  outstanding,
  parseRequestDoc,
  removeRequest,
  removeSource,
  requestStatus,
  requestTotals,
  requestsToCsv,
  saveRequests,
  sourceTotal,
  STOCKPILE_SOURCE_ID,
  supplyFromStockpile,
  toRequestItems,
  upsertRequest,
  type BuyerRequest,
  type LineAvailability,
  type RequestDoc,
} from "@/lib/buyerRequest";
import {
  itemBags,
  loadStockpile,
  saveStockpile,
  type Stockpile,
} from "@/lib/stockpile";
import { cn } from "@/lib/cn";

const STATUS_STYLE: Record<LineAvailability, { chip: string; label: string }> = {
  done: { chip: "bg-gray-100 text-gray-600 border-gray-200", label: "Supplied" },
  ready: {
    chip: "bg-emerald-50 text-emerald-700 border-emerald-200",
    label: "In stock",
  },
  part: {
    chip: "bg-amber-50 text-amber-700 border-amber-200",
    label: "Part only",
  },
  none: { chip: "bg-red-50 text-red-700 border-red-200", label: "None" },
};

export default function RequestsPage() {
  const [doc, setDoc] = useState<RequestDoc | null>(null);
  const [stockpile, setStockpile] = useState<Stockpile | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);
  const [addingSource, setAddingSource] = useState(false);
  /** Which pool of bags requests are checked against. */
  const [sourceId, setSourceId] = useState<string>(STOCKPILE_SOURCE_ID);
  const [buyerRefreshKey, setBuyerRefreshKey] = useState(0);

  // New-line form
  const [newName, setNewName] = useState("");
  const [newQty, setNewQty] = useState("");
  const [newNote, setNewNote] = useState("");

  const jsonRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDoc(loadRequests());
    setStockpile(loadStockpile());
  }, []);

  const requests = doc?.requests ?? [];
  const active = useMemo(
    () => requests.find((r) => r.id === activeId) ?? requests[0] ?? null,
    [requests, activeId],
  );

  const persist = useCallback((next: RequestDoc) => {
    setDoc(next);
    saveRequests(next);
  }, []);

  const save = useCallback(
    (request: BuyerRequest) => {
      const base = doc ?? loadRequests();
      persist(upsertRequest(base, request));
    },
    [doc, persist],
  );

  const sources = doc?.sources ?? [];

  /** Bags on hand from whichever source is selected. */
  const availability = useMemo(() => {
    const fromStock = stockpile
      ? availabilityFromStockpile(stockpile)
      : new Map<string, number>();
    if (sourceId === STOCKPILE_SOURCE_ID) return fromStock;
    if (sourceId === ALL_SOURCES_ID) {
      return combineAvailability([
        fromStock,
        ...sources.map((s) => availabilityFromSource(s)),
      ]);
    }
    const source = sources.find((s) => s.id === sourceId);
    return source ? availabilityFromSource(source) : fromStock;
  }, [stockpile, sources, sourceId]);

  /** True when the selection can actually have bags taken out of it. */
  const sourceIsStockpile = sourceId === STOCKPILE_SOURCE_ID;
  const sourceLabel =
    sourceId === STOCKPILE_SOURCE_ID
      ? "the stockpile"
      : sourceId === ALL_SOURCES_ID
        ? "everything"
        : (sources.find((s) => s.id === sourceId)?.name ?? "the stockpile");

  // A removed container falls back to the stockpile.
  useEffect(() => {
    if (
      sourceId !== STOCKPILE_SOURCE_ID &&
      sourceId !== ALL_SOURCES_ID &&
      !sources.some((s) => s.id === sourceId)
    ) {
      setSourceId(STOCKPILE_SOURCE_ID);
    }
  }, [sources, sourceId]);

  /* ------------------------------- requests ------------------------------- */

  const addRequest = useCallback(() => {
    const request = createRequest(EMPTY_BUYER, []);
    const base = doc ?? loadRequests();
    persist(upsertRequest(base, request));
    setActiveId(request.id);
    setNotice("New request list added. Enter the buyer and what they need.");
  }, [doc, persist]);

  const deleteRequest = useCallback(() => {
    if (!active || !doc) return;
    const who = active.buyer.name.trim() || "this buyer";
    if (!window.confirm(`Remove the request list for ${who}?`)) return;
    persist(removeRequest(doc, active.id));
    setActiveId(null);
    setNotice("Request list removed.");
  }, [active, doc, persist]);

  const setBuyer = useCallback(
    (buyer: Buyer) => {
      if (!active) return;
      save({ ...active, buyer });
    },
    [active, save],
  );

  /* --------------------------------- lines -------------------------------- */

  const addLine = useCallback(() => {
    if (!active) return;
    const name = newName.trim();
    const qty = Number(newQty);
    if (name === "") {
      setError("Enter the item the buyer wants.");
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Enter how many bags they want.");
      return;
    }
    const [line] = toRequestItems([{ name, qty, note: newNote }]);
    if (!line) {
      setError("That item could not be added.");
      return;
    }
    save({ ...active, items: [...active.items, line] });
    setNewName("");
    setNewQty("");
    setNewNote("");
    setError(null);
  }, [active, newName, newQty, newNote, save]);

  const removeLine = useCallback(
    (itemId: string) => {
      if (!active) return;
      save({ ...active, items: active.items.filter((i) => i.id !== itemId) });
    },
    [active, save],
  );

  /** Edit a line in place, so anything read wrongly from a file can be fixed. */
  const updateLine = useCallback(
    (itemId: string, patch: { name?: string; qty?: number }) => {
      if (!active) return;
      save({
        ...active,
        items: active.items.map((i) => {
          if (i.id !== itemId) return i;
          const qty =
            patch.qty === undefined
              ? i.qty
              : Math.max(1, Math.floor(patch.qty) || 1);
          return {
            ...i,
            name: patch.name === undefined ? i.name : patch.name,
            qty,
            // Lowering what they want must not leave more supplied than asked.
            supplied: Math.min(i.supplied, qty),
          };
        }),
      });
    },
    [active, save],
  );

  /**
   * Import a buyer's list from a file. Works with a plain PDF list of items and
   * quantities as well as a priced order sheet, CSV or spreadsheet.
   */
  const importFile = useCallback(
    async (file: File) => {
      setError(null);
      setNotice(null);
      setImporting(true);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/process", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not read that file.");

        const parsed = data as ParsedOrder;
        const lines = toRequestItems(
          parsed.items.map((i) => ({ name: i.name, qty: i.qty })),
        );
        if (lines.length === 0) {
          throw new Error("No items with quantities were found in that file.");
        }

        // Add to the open list, or start one named after the file's heading.
        const base = doc ?? loadRequests();
        const target =
          active ??
          createRequest(
            { name: parsed.title || file.name.replace(/\.[^.]+$/, ""), phone: "" },
            [],
          );
        const merged: BuyerRequest = {
          ...target,
          items: [...target.items, ...lines],
        };
        persist(upsertRequest(base, merged));
        setActiveId(merged.id);

        const bags = lines.reduce((s, l) => s + l.qty, 0);
        setNotice(
          `Imported ${lines.length} item(s), ${bags} bags from ${file.name}.` +
            (parsed.totalsMatch
              ? ""
              : " The total on the file did not match the lines, so please check the quantities below."),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Import failed.");
      } finally {
        setImporting(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [active, doc, persist],
  );

  const adjustSupplied = useCallback(
    (itemId: string, delta: number) => {
      if (!active) return;
      try {
        save(markSupplied(active, itemId, delta));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not record that.");
      }
    },
    [active, save],
  );

  /** Take bags out of the stockpile and record them against the line at once. */
  const supplyFromStock = useCallback(
    (itemId: string, bags: number) => {
      if (!active || !stockpile) return;
      try {
        const result = supplyFromStockpile(active, stockpile, itemId, bags);
        save(result.request);
        setStockpile(result.stockpile);
        saveStockpile(result.stockpile);
        setError(null);
        const line = active.items.find((i) => i.id === itemId);
        setNotice(
          `Supplied ${bags} bag(s) of ${line?.name ?? "item"} from the stockpile.`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not supply from stock.");
      }
    },
    [active, stockpile, save],
  );

  /**
   * Add a container or order file as somewhere bags can come from. Most stock is
   * not in the stockpile - it is in a container - so this is usually what a
   * request needs checking against.
   */
  const addSourceFile = useCallback(
    async (file: File) => {
      setError(null);
      setNotice(null);
      setAddingSource(true);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/process", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not read that file.");

        const parsed = data as ParsedOrder;
        const source = createSource(
          parsed.title || file.name.replace(/\.[^.]+$/, ""),
          parsed.items.map((i) => ({ name: i.name, qty: i.qty })),
        );
        if (source.items.length === 0) {
          throw new Error("No items with quantities were found in that file.");
        }

        const base = doc ?? loadRequests();
        persist(addSource(base, source));
        setSourceId(source.id);
        setNotice(
          `Added "${source.name}" - ${source.items.length} items, ${sourceTotal(source)} bags. Requests are now checked against it.`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not add that file.");
      } finally {
        setAddingSource(false);
        if (sourceRef.current) sourceRef.current.value = "";
      }
    },
    [doc, persist],
  );

  const dropSource = useCallback(
    (id: string) => {
      if (!doc) return;
      const source = doc.sources.find((s) => s.id === id);
      if (!source) return;
      if (!window.confirm(`Remove "${source.name}" as a source?`)) return;
      persist(removeSource(doc, id));
      setNotice(`Removed "${source.name}".`);
    },
    [doc, persist],
  );

  /* -------------------------------- exports ------------------------------- */

  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, []);

  const saveFile = useCallback(() => {
    if (!doc) return;
    downloadBlob(
      new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
      `Buyer requests ${new Date().toISOString().slice(0, 10)}.json`,
    );
    setNotice("Saved. Keep the file to move these lists between devices.");
  }, [doc, downloadBlob]);

  const loadFile = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const parsed = parseRequestDoc(JSON.parse(await file.text()));
        persist(parsed);
        setActiveId(null);
        setNotice(`Loaded ${parsed.requests.length} request list(s).`);
      } catch {
        setError("That file is not a valid buyer requests file.");
      } finally {
        if (jsonRef.current) jsonRef.current.value = "";
      }
    },
    [persist],
  );

  const exportCsv = useCallback(() => {
    if (!doc || doc.requests.length === 0) {
      setError("There is nothing to export yet.");
      return;
    }
    downloadBlob(
      new Blob([requestsToCsv(doc.requests, availability)], {
        type: "text/csv;charset=utf-8",
      }),
      `Buyer requests ${new Date().toISOString().slice(0, 10)}.csv`,
    );
    setNotice(
      `CSV exported - one row per requested item, with availability from ${sourceLabel}.`,
    );
  }, [doc, availability, sourceLabel, downloadBlob]);

  /* -------------------------------- derived ------------------------------- */

  const matches = useMemo(
    () => (active ? matchRequest(active, availability) : []),
    [active, availability],
  );
  const summary = useMemo(() => matchSummary(matches), [matches]);
  const totals = active ? requestTotals(active) : null;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return matches;
    return matches.filter((m) => m.item.name.toLowerCase().includes(q));
  }, [matches, search]);

  /** Item names already in the stockpile, to help type a line quickly. */
  const stockNames = useMemo(() => {
    if (!stockpile) return [];
    return stockpile.items
      .filter((i) => itemBags(i) > 0)
      .map((i) => i.name)
      .sort((a, b) => a.localeCompare(b));
  }, [stockpile]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-12">
      <header className="mb-8">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
          <ListChecks className="h-7 w-7 text-brand-600" />
          Buyer Requests
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-gray-500">
          What each buyer has asked for, and whether you can fill it from the
          stockpile right now. Supplying a line takes the bags out of stock and
          records them here in one step.
        </p>
      </header>

      <input
        ref={jsonRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) loadFile(f);
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.csv,.xlsx,application/pdf,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importFile(f);
        }}
      />
      <input
        ref={sourceRef}
        type="file"
        accept=".pdf,.csv,.xlsx,application/pdf,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) addSourceFile(f);
        }}
      />

      {error && (
        <Banner tone="error" onClose={() => setError(null)}>
          {error}
        </Banner>
      )}
      {notice && !error && (
        <Banner tone="info" onClose={() => setNotice(null)}>
          {notice}
        </Banner>
      )}

      {/* Empty state */}
      {doc && requests.length === 0 && (
        <div className="rounded-2xl border-2 border-dashed border-gray-300 bg-white/70 px-6 py-16 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
            <ListChecks className="h-8 w-8" />
          </div>
          <p className="mt-5 text-lg font-semibold text-gray-800">
            No request lists yet
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
            Add a list when a buyer tells you what they need, then check it
            against the stockpile.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={importing}
              className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-brand-600/25 transition hover:bg-brand-700 disabled:opacity-60"
            >
              {importing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UploadCloud className="h-4 w-4" />
              )}
              Upload their list
            </button>
            <button
              onClick={addRequest}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              <Plus className="h-4 w-4" />
              Enter one by hand
            </button>
            <button
              onClick={() => jsonRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              <FolderOpen className="h-4 w-4" />
              Load a saved file
            </button>
          </div>
          <p className="mt-4 text-xs text-gray-400">
            PDF, CSV or XLSX. A plain list of items and quantities works, and so
            does a priced order sheet - prices are ignored here.
          </p>
        </div>
      )}

      {requests.length > 0 && (
        <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
          {/* Buyer list */}
          <aside>
            <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
              <p className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                Buyers
              </p>
              <ul className="space-y-1">
                {requests.map((r) => {
                  const isActive = active?.id === r.id;
                  const t = requestTotals(r);
                  const status = requestStatus(r);
                  return (
                    <li key={r.id}>
                      <button
                        onClick={() => setActiveId(r.id)}
                        className={cn(
                          "w-full rounded-lg px-3 py-2 text-left transition",
                          isActive
                            ? "bg-brand-50 ring-1 ring-brand-200"
                            : "hover:bg-gray-50",
                        )}
                      >
                        <span
                          className={cn(
                            "block truncate text-sm font-medium",
                            isActive ? "text-brand-800" : "text-gray-800",
                          )}
                        >
                          {r.buyer.name.trim() || "Unnamed buyer"}
                        </span>
                        <span className="block truncate text-xs text-gray-500">
                          {t.lines} item{t.lines === 1 ? "" : "s"}
                          {status === "complete" && t.lines > 0 ? (
                            <span className="text-emerald-600"> · all supplied</span>
                          ) : t.outstanding > 0 ? (
                            <span> · {t.outstanding} bags to go</span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="mt-3 space-y-1 border-t border-gray-100 pt-3">
                <button
                  onClick={addRequest}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                >
                  <Plus className="h-4 w-4" />
                  New request list
                </button>
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={importing}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
                >
                  {importing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UploadCloud className="h-4 w-4" />
                  )}
                  Upload a list
                </button>
                <button
                  onClick={saveFile}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                >
                  <Save className="h-4 w-4" />
                  Save to file
                </button>
                <button
                  onClick={() => jsonRef.current?.click()}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                >
                  <FolderOpen className="h-4 w-4" />
                  Load file
                </button>
                <button
                  onClick={exportCsv}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                >
                  <FileSpreadsheet className="h-4 w-4" />
                  Export CSV
                </button>
              </div>
            </div>
          </aside>

          {/* Active request */}
          {active && totals && (
            <section className="space-y-5">
              {/* Where bags can come from */}
              <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <label
                    htmlFor="br-source"
                    className="flex items-center gap-1.5 text-sm font-medium text-gray-700"
                  >
                    <Boxes className="h-4 w-4 text-brand-600" />
                    Check against
                  </label>
                  <select
                    id="br-source"
                    value={sourceId}
                    onChange={(e) => setSourceId(e.target.value)}
                    className="min-w-[200px] rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                  >
                    <option value={STOCKPILE_SOURCE_ID}>
                      Stockpile
                      {stockpile
                        ? ` (${stockpile.items.reduce((s, i) => s + itemBags(i), 0)} bags)`
                        : ""}
                    </option>
                    {sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({sourceTotal(s)} bags)
                      </option>
                    ))}
                    {sources.length > 0 && (
                      <option value={ALL_SOURCES_ID}>
                        Everything together
                      </option>
                    )}
                  </select>

                  <button
                    onClick={() => sourceRef.current?.click()}
                    disabled={addingSource}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
                  >
                    {addingSource ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <UploadCloud className="h-4 w-4" />
                    )}
                    Add container file
                  </button>

                  {!sourceIsStockpile && sourceId !== ALL_SOURCES_ID && (
                    <button
                      onClick={() => dropSource(sourceId)}
                      title="Remove this container as a source"
                      className="rounded-md p-2 text-red-500 transition hover:bg-red-50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  {sourceIsStockpile
                    ? "Supplying a line takes the bags out of the stockpile."
                    : "A container file is a record of what shipped, so supplying only records it here - the file is left alone."}
                </p>
              </div>

              <BuyerFields
                value={active.buyer}
                onChange={setBuyer}
                refreshKey={buyerRefreshKey}
                heading="Who is asking"
                description="Saved with the list, and remembered for next time."
              />

              {/* Summary */}
              <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-semibold text-gray-900">
                    What they need
                  </h2>
                  <button
                    onClick={deleteRequest}
                    title="Remove this request list"
                    className="rounded-md p-2 text-red-500 transition hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Items" value={String(totals.lines)} />
                  <Stat label="Bags asked for" value={String(totals.requested)} />
                  <Stat label="Supplied" value={String(totals.supplied)} />
                  <Stat
                    label="Outstanding"
                    value={String(totals.outstanding)}
                    tone={totals.outstanding > 0 ? "warn" : "good"}
                  />
                </div>

                {totals.lines > 0 && (
                  <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600">
                    <span className="flex items-center gap-1.5">
                      <Boxes className="h-4 w-4 text-brand-600" />
                      From {sourceLabel}:
                    </span>
                    <span className="font-medium text-emerald-700">
                      {summary.ready} ready
                    </span>
                    <span className="font-medium text-amber-700">
                      {summary.part} part
                    </span>
                    <span className="font-medium text-red-700">
                      {summary.none} unavailable
                    </span>
                    {summary.canSupplyBags > 0 && (
                      <span className="text-gray-500">
                        ({summary.canSupplyBags} bags could go out today)
                      </span>
                    )}
                  </p>
                )}

                <div className="mt-4">
                  <label
                    htmlFor="br-notes"
                    className="mb-1 block text-xs font-medium text-gray-600"
                  >
                    Notes
                  </label>
                  <input
                    id="br-notes"
                    value={active.notes}
                    onChange={(e) => save({ ...active, notes: e.target.value })}
                    placeholder="Delivery date, terms, anything worth remembering"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                  />
                </div>
              </div>

              {/* Add a line */}
              <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-[180px] flex-1">
                    <label
                      htmlFor="br-item"
                      className="mb-1 block text-xs font-medium text-gray-600"
                    >
                      Item
                    </label>
                    <input
                      id="br-item"
                      list="br-stock-names"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addLine();
                      }}
                      placeholder="e.g. Blanket"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                    />
                    <datalist id="br-stock-names">
                      {stockNames.map((n) => (
                        <option key={n} value={n} />
                      ))}
                    </datalist>
                  </div>
                  <div className="w-24">
                    <label
                      htmlFor="br-qty"
                      className="mb-1 block text-xs font-medium text-gray-600"
                    >
                      Bags
                    </label>
                    <input
                      id="br-qty"
                      value={newQty}
                      onChange={(e) => setNewQty(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addLine();
                      }}
                      inputMode="numeric"
                      placeholder="12"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                    />
                  </div>
                  <div className="min-w-[140px] flex-1">
                    <label
                      htmlFor="br-note"
                      className="mb-1 block text-xs font-medium text-gray-600"
                    >
                      Note (optional)
                    </label>
                    <input
                      id="br-note"
                      value={newNote}
                      onChange={(e) => setNewNote(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addLine();
                      }}
                      placeholder="Colour, grade..."
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                    />
                  </div>
                  <button
                    onClick={addLine}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700"
                  >
                    <Plus className="h-4 w-4" />
                    Add
                  </button>
                </div>
              </div>

              {/* The list */}
              {totals.lines > 0 && (
                <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
                  <div className="border-b border-gray-100 px-4 py-3">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search this list..."
                        className="w-full rounded-lg border border-gray-300 py-1.5 pl-9 pr-3 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      />
                    </div>
                  </div>

                  <div className="preview-scroll max-h-[520px] overflow-auto">
                    <table className="w-full border-collapse text-sm">
                      <thead className="sticky top-0 z-10 bg-gray-900 text-white">
                        <tr>
                          <th className="px-4 py-3 text-left font-semibold">
                            Item
                          </th>
                          <th className="w-20 px-2 py-3 text-center font-semibold">
                            Wants
                          </th>
                          <th className="w-28 px-2 py-3 text-center font-semibold">
                            Supplied
                          </th>
                          <th className="w-20 px-2 py-3 text-center font-semibold">
                            To go
                          </th>
                          <th className="w-24 px-2 py-3 text-center font-semibold">
                            Available
                          </th>
                          <th className="w-40 px-2 py-3 text-center font-semibold">
                            Status
                          </th>
                          <th className="w-10 px-2 py-3" />
                        </tr>
                      </thead>
                      <tbody>
                        {visible.length === 0 && (
                          <tr>
                            <td
                              colSpan={7}
                              className="px-4 py-10 text-center text-sm text-gray-500"
                            >
                              No items match this search.
                            </td>
                          </tr>
                        )}
                        {visible.map((m, idx) => (
                          <tr
                            key={m.item.id}
                            className={cn(
                              "border-b border-gray-100 transition-colors hover:bg-brand-50/40",
                              idx % 2 === 1 && "bg-gray-50/60",
                              m.status === "done" && "text-gray-400",
                            )}
                          >
                            <td className="px-4 py-2.5">
                              <input
                                value={m.item.name}
                                onChange={(e) =>
                                  updateLine(m.item.id, { name: e.target.value })
                                }
                                className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 font-medium text-gray-800 outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100"
                              />
                              {m.item.note && (
                                <span className="block px-2 text-xs text-gray-400">
                                  {m.item.note}
                                </span>
                              )}
                            </td>
                            <td className="px-2 py-2.5">
                              <input
                                value={m.item.qty}
                                onChange={(e) =>
                                  updateLine(m.item.id, {
                                    qty: Number(e.target.value),
                                  })
                                }
                                inputMode="numeric"
                                className="w-full rounded-md border border-transparent bg-transparent px-1 py-1 text-center font-medium text-gray-800 outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100"
                              />
                            </td>
                            <td className="px-2 py-2.5">
                              <div className="flex items-center justify-center gap-1">
                                <IconBtn
                                  title="Record one fewer supplied"
                                  onClick={() => adjustSupplied(m.item.id, -1)}
                                  disabled={m.item.supplied === 0}
                                >
                                  <Minus className="h-3.5 w-3.5" />
                                </IconBtn>
                                <span className="w-8 text-center font-medium text-gray-800">
                                  {m.item.supplied}
                                </span>
                                <IconBtn
                                  title="Record one more supplied"
                                  onClick={() => adjustSupplied(m.item.id, 1)}
                                  disabled={m.outstanding === 0}
                                >
                                  <PackagePlus className="h-3.5 w-3.5" />
                                </IconBtn>
                              </div>
                            </td>
                            <td
                              className={cn(
                                "px-2 py-2.5 text-center font-medium",
                                m.outstanding > 0
                                  ? "text-gray-900"
                                  : "text-gray-400",
                              )}
                            >
                              {m.outstanding}
                            </td>
                            <td className="px-2 py-2.5 text-center text-gray-600">
                              {m.inStock}
                            </td>
                            <td className="px-2 py-2.5">
                              <div className="flex items-center justify-center gap-2">
                                <span
                                  className={cn(
                                    "rounded-full border px-2 py-0.5 text-xs font-medium",
                                    STATUS_STYLE[m.status].chip,
                                  )}
                                >
                                  {STATUS_STYLE[m.status].label}
                                </span>
                                {m.canSupply > 0 && (
                                  <button
                                    onClick={() =>
                                      sourceIsStockpile
                                        ? supplyFromStock(m.item.id, m.canSupply)
                                        : adjustSupplied(m.item.id, m.canSupply)
                                    }
                                    title={
                                      sourceIsStockpile
                                        ? `Take ${m.canSupply} bag(s) out of the stockpile and record as supplied`
                                        : `Record ${m.canSupply} bag(s) as supplied from ${sourceLabel}`
                                    }
                                    className="inline-flex items-center gap-1 rounded-md border border-emerald-200 px-2 py-1 text-xs font-medium text-emerald-700 transition hover:bg-emerald-50"
                                  >
                                    <PackageCheck className="h-3.5 w-3.5" />
                                    Supply {m.canSupply}
                                  </button>
                                )}
                              </div>
                            </td>
                            <td className="px-2 py-2.5 text-center">
                              <IconBtn
                                title="Remove this item"
                                danger
                                onClick={() => removeLine(m.item.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </IconBtn>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="sticky bottom-0 bg-brand-100 font-bold text-gray-900">
                        <tr>
                          <td className="px-4 py-3">Total</td>
                          <td className="px-2 py-3 text-center">
                            {totals.requested}
                          </td>
                          <td className="px-2 py-3 text-center">
                            {totals.supplied}
                          </td>
                          <td className="px-2 py-3 text-center">
                            {totals.outstanding}
                          </td>
                          <td colSpan={3} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {hasBuyerInfo(active.buyer) && (
                <div className="flex justify-end">
                  <button
                    onClick={() => {
                      rememberBuyer(active.buyer);
                      setBuyerRefreshKey((k) => k + 1);
                      setNotice("Buyer saved for quick selection elsewhere.");
                    }}
                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50"
                  >
                    Save this buyer
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      <footer className="mt-16 text-center text-xs text-gray-400">
        Built by Lathurshan
      </footer>
    </main>
  );
}

/* ---------------------------- small components ---------------------------- */

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn" | "good";
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-3",
        tone === "warn"
          ? "border-amber-200 bg-amber-50"
          : tone === "good"
            ? "border-emerald-200 bg-emerald-50"
            : "border-gray-200 bg-gray-50",
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 truncate text-base font-bold",
          tone === "warn"
            ? "text-amber-800"
            : tone === "good"
              ? "text-emerald-800"
              : "text-gray-900",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  title,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        "rounded-md p-1.5 transition disabled:cursor-not-allowed disabled:opacity-30",
        danger
          ? "text-red-500 hover:bg-red-50"
          : "text-gray-500 hover:bg-brand-100 hover:text-brand-700",
      )}
    >
      {children}
    </button>
  );
}

function Banner({
  tone,
  children,
  onClose,
}: {
  tone: "error" | "info";
  children: React.ReactNode;
  onClose?: () => void;
}) {
  const Icon = tone === "error" ? AlertTriangle : CheckCircle2;
  return (
    <div
      className={cn(
        "mb-4 flex animate-fade-in items-start gap-3 rounded-xl border px-4 py-3 text-sm",
        tone === "error"
          ? "border-red-200 bg-red-50 text-red-700"
          : "border-brand-200 bg-brand-50 text-brand-800",
      )}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" />
      <span className="flex-1">{children}</span>
      {onClose && (
        <button
          onClick={onClose}
          className="rounded-md p-0.5 hover:bg-black/5"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

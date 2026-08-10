"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Boxes,
  Plus,
  Search,
  Download,
  Save,
  FolderOpen,
  UploadCloud,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  X,
  ChevronDown,
  ChevronRight,
  PackageMinus,
  PackagePlus,
  Merge,
  Trash2,
  Sparkles,
  History,
  FileSpreadsheet,
  Clock,
} from "lucide-react";
import type { ParsedOrder } from "@/lib/types";
import { formatLKR } from "@/lib/types";
import {
  AGE_BUCKETS,
  addLots,
  ageBucket,
  describeBags,
  emptyStockpile,
  itemAgeDays,
  itemAvgPerBag,
  itemBags,
  itemValue,
  loadStockpile,
  mergeItems,
  parseStockpile,
  planWithdrawal,
  removeEmptyItems,
  removeItem,
  saveStockpile,
  stockpileTotals,
  toCsv,
  withdraw,
  type AgeBucket,
  type StockItem,
  type Stockpile,
} from "@/lib/stockpile";
import { cn } from "@/lib/cn";

const BUCKET_STYLES: Record<
  AgeBucket["key"],
  { bar: string; chip: string; dot: string }
> = {
  fresh: {
    bar: "bg-emerald-500",
    chip: "bg-emerald-50 text-emerald-700 border-emerald-200",
    dot: "bg-emerald-500",
  },
  watch: {
    bar: "bg-sky-500",
    chip: "bg-sky-50 text-sky-700 border-sky-200",
    dot: "bg-sky-500",
  },
  slow: {
    bar: "bg-amber-500",
    chip: "bg-amber-50 text-amber-700 border-amber-200",
    dot: "bg-amber-500",
  },
  dead: {
    bar: "bg-red-500",
    chip: "bg-red-50 text-red-700 border-red-200",
    dot: "bg-red-500",
  },
};

type SortKey = "name" | "bags" | "value" | "age";

type Dialog =
  | { kind: "add" }
  | { kind: "lot"; itemId: string }
  | { kind: "withdraw"; itemId: string }
  | { kind: "merge"; itemId: string }
  | null;

export default function StockpilePage() {
  const [sp, setSp] = useState<Stockpile>(emptyStockpile);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("age");
  const [bucketFilter, setBucketFilter] = useState<AgeBucket["key"] | "">("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Dialog form fields
  const [fName, setFName] = useState("");
  const [fBags, setFBags] = useState("");
  const [fPerBag, setFPerBag] = useState("");
  const [fSource, setFSource] = useState("");
  const [fReason, setFReason] = useState("Sold");
  const [fMergeInto, setFMergeInto] = useState("");

  const pdfInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSp(loadStockpile());
    setLoaded(true);
  }, []);

  /** Every change goes through here so the file on disk is always current. */
  const apply = useCallback((next: Stockpile) => {
    setSp(next);
    saveStockpile(next);
  }, []);

  const totals = useMemo(() => stockpileTotals(sp), [sp]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = sp.items.filter((item) => {
      if (q && !item.name.toLowerCase().includes(q)) return false;
      if (bucketFilter && ageBucket(itemAgeDays(item)).key !== bucketFilter) {
        return false;
      }
      return true;
    });
    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sortKey) {
        case "name":
          return a.name.localeCompare(b.name);
        case "bags":
          return itemBags(b) - itemBags(a);
        case "value":
          return itemValue(b) - itemValue(a);
        case "age":
        default:
          return itemAgeDays(b) - itemAgeDays(a);
      }
    });
    return sorted;
  }, [sp.items, search, bucketFilter, sortKey]);

  const dialogItem: StockItem | null = useMemo(() => {
    if (!dialog || dialog.kind === "add") return null;
    return sp.items.find((i) => i.id === dialog.itemId) ?? null;
  }, [dialog, sp.items]);

  const closeDialog = useCallback(() => {
    setDialog(null);
    setFName("");
    setFBags("");
    setFPerBag("");
    setFSource("");
    setFReason("Sold");
    setFMergeInto("");
  }, []);

  /* ------------------------------- actions ------------------------------- */

  const submitAdd = useCallback(() => {
    const bags = Number(fBags);
    const perBag = Number(fPerBag);
    if (!fName.trim()) return setError("Enter an item name.");
    if (!Number.isFinite(bags) || bags <= 0)
      return setError("Enter how many bags to add.");
    if (!Number.isFinite(perBag) || perBag < 0)
      return setError("Enter a valid price per bag.");

    const { stockpile, bagsAdded } = addLots(sp, [
      {
        name: fName,
        bags,
        perBag,
        source: fSource.trim() || "Added manually",
      },
    ]);
    apply(stockpile);
    setError(null);
    setNotice(
      `Added ${describeBags(bagsAdded, bagsAdded * perBag)} of ${fName.trim()}.`,
    );
    closeDialog();
  }, [sp, fName, fBags, fPerBag, fSource, apply, closeDialog]);

  const submitLot = useCallback(() => {
    if (!dialogItem) return;
    const bags = Number(fBags);
    const perBag = Number(fPerBag);
    if (!Number.isFinite(bags) || bags <= 0)
      return setError("Enter how many bags to add.");
    if (!Number.isFinite(perBag) || perBag < 0)
      return setError("Enter a valid price per bag.");

    const { stockpile } = addLots(sp, [
      {
        name: dialogItem.name,
        bags,
        perBag,
        source: fSource.trim() || "Added manually",
      },
    ]);
    apply(stockpile);
    setError(null);
    setNotice(
      `Added ${describeBags(bags, bags * perBag)} to ${dialogItem.name}.`,
    );
    closeDialog();
  }, [sp, dialogItem, fBags, fPerBag, fSource, apply, closeDialog]);

  const submitWithdraw = useCallback(() => {
    if (!dialogItem) return;
    try {
      const result = withdraw(sp, dialogItem.id, Number(fBags), fReason);
      apply(result.stockpile);
      setError(null);
      setNotice(
        `Removed ${describeBags(result.bags, result.value)} of ${dialogItem.name} (${fReason.trim() || "removed"}).`,
      );
      closeDialog();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove those bags.");
    }
  }, [sp, dialogItem, fBags, fReason, apply, closeDialog]);

  const submitMerge = useCallback(() => {
    if (!dialogItem || !fMergeInto) return setError("Choose an item to merge into.");
    const target = sp.items.find((i) => i.id === fMergeInto);
    apply(mergeItems(sp, dialogItem.id, fMergeInto));
    setError(null);
    setNotice(`Merged ${dialogItem.name} into ${target?.name ?? "item"}.`);
    closeDialog();
  }, [sp, dialogItem, fMergeInto, apply, closeDialog]);

  const importPdf = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/process", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to read the PDF.");
        const parsed = data as ParsedOrder;

        const { stockpile, bagsAdded, itemsTouched } = addLots(
          sp,
          parsed.items.map((it) => ({
            name: it.name,
            bags: it.qty,
            perBag: it.perBag,
            source: parsed.title,
          })),
        );
        apply(stockpile);
        setNotice(
          `Added ${bagsAdded} bags across ${itemsTouched} items from "${parsed.title}" into the stockpile.`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Import failed.");
      } finally {
        setBusy(false);
        if (pdfInputRef.current) pdfInputRef.current.value = "";
      }
    },
    [sp, apply],
  );

  const importJson = useCallback(
    async (file: File) => {
      setError(null);
      setNotice(null);
      try {
        const parsed = parseStockpile(JSON.parse(await file.text()));
        apply(parsed);
        setNotice(
          `Stockpile file loaded: ${parsed.items.length} items, ${stockpileTotals(parsed).bags} bags.`,
        );
      } catch {
        setError("That file is not a valid stockpile file.");
      } finally {
        if (jsonInputRef.current) jsonInputRef.current.value = "";
      }
    },
    [apply],
  );

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
    downloadBlob(
      new Blob([JSON.stringify(sp, null, 2)], { type: "application/json" }),
      `Stockpile ${new Date().toISOString().slice(0, 10)}.json`,
    );
    setNotice("Stockpile file saved.");
  }, [sp, downloadBlob]);

  const exportCsv = useCallback(() => {
    downloadBlob(
      new Blob([toCsv(sp)], { type: "text/csv;charset=utf-8" }),
      `Stockpile ${new Date().toISOString().slice(0, 10)}.csv`,
    );
    setNotice("CSV exported - one row per batch.");
  }, [sp, downloadBlob]);

  const exportPdf = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const withStock = sp.items.filter((i) => itemBags(i) > 0);
      if (withStock.length === 0) throw new Error("The stockpile is empty.");

      const today = new Date().toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });

      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Stockpile",
          label: "",
          subtitle: `As at ${today}`,
          rows: withStock.map((i) => ({
            name: i.name,
            qty: itemBags(i),
            perBag: Math.round(itemAvgPerBag(i)),
            // The exact lot value, so mixed-price items never round adrift.
            totalOverride: itemValue(i),
          })),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to generate the PDF.");
      }
      downloadBlob(await res.blob(), "Stockpile.pdf");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }, [sp, downloadBlob]);

  /**
   * Wipe the stockpile completely. This is the one irreversible action on the
   * page, so it states exactly what will be lost and nudges you to save the
   * file first.
   */
  const clearStockpile = useCallback(() => {
    if (sp.items.length === 0 && sp.history.length === 0) {
      setNotice("The stockpile is already empty.");
      return;
    }
    const t = stockpileTotals(sp);
    if (
      !window.confirm(
        `Clear the entire stockpile?\n\n` +
          `${t.itemCount} item(s), ${t.bags} bag(s) worth ${formatLKR(t.value)} ` +
          `will be removed, along with the movement history.\n\n` +
          `Save the file first if you might need this. This cannot be undone.`,
      )
    ) {
      return;
    }

    const fresh = emptyStockpile();
    setSp(fresh);
    saveStockpile(fresh);
    setExpanded(null);
    setSearch("");
    setBucketFilter("");
    setShowHistory(false);
    setError(null);
    setNotice("Stockpile cleared.");
  }, [sp]);

  const tidyUp = useCallback(() => {
    const before = sp.items.length;
    const next = removeEmptyItems(sp);
    apply(next);
    const removed = before - next.items.length;
    setNotice(
      removed > 0
        ? `Removed ${removed} empty item${removed === 1 ? "" : "s"}.`
        : "Nothing to tidy - every item still has bags.",
    );
  }, [sp, apply]);

  /* -------------------------------- render -------------------------------- */

  const isEmpty = loaded && sp.items.length === 0;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-12">
      <header className="mb-8">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
          <Boxes className="h-7 w-7 text-brand-600" />
          Stockpile
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-gray-500">
          Bags carried forward from earlier orders. Each batch keeps its own
          price and date, so you can see what is ageing and what it is worth.
        </p>
      </header>

      <input
        ref={pdfInputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importPdf(f);
        }}
      />
      <input
        ref={jsonInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importJson(f);
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
      {totals.deadBags > 0 && (
        <Banner tone="warn">
          {totals.deadBags} bag{totals.deadBags === 1 ? "" : "s"} worth{" "}
          {formatLKR(totals.deadValue)} have been sitting 90 days or more.
        </Banner>
      )}

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Items" value={totals.itemCount.toString()} />
        <Stat label="Bags held" value={totals.bags.toString()} />
        <Stat label="Value tied up" value={formatLKR(totals.value)} highlight />
        <Stat
          label="Oldest bag"
          value={totals.oldestDays === 0 ? "-" : `${totals.oldestDays} days`}
          tone={totals.oldestDays >= 90 ? "danger" : undefined}
        />
      </div>

      {/* Ageing breakdown */}
      {totals.bags > 0 && (
        <section className="mt-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">
            <Clock className="h-4 w-4 text-brand-600" />
            How long it has been sitting
          </h2>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-gray-100">
            {AGE_BUCKETS.map((b) => {
              const bags = totals.byBucket[b.key].bags;
              const pct = totals.bags === 0 ? 0 : (bags / totals.bags) * 100;
              if (pct === 0) return null;
              return (
                <div
                  key={b.key}
                  className={cn(BUCKET_STYLES[b.key].bar, "transition-all")}
                  style={{ width: `${pct}%` }}
                  title={`${b.label}: ${bags} bags`}
                />
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
            {AGE_BUCKETS.map((b) => {
              const cell = totals.byBucket[b.key];
              const active = bucketFilter === b.key;
              return (
                <button
                  key={b.key}
                  onClick={() => setBucketFilter(active ? "" : b.key)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-2 py-1 text-xs transition",
                    active ? "bg-gray-100 ring-1 ring-gray-300" : "hover:bg-gray-50",
                  )}
                  title="Click to filter the table"
                >
                  <span
                    className={cn(
                      "h-2.5 w-2.5 rounded-full",
                      BUCKET_STYLES[b.key].dot,
                    )}
                  />
                  <span className="font-medium text-gray-700">{b.label}</span>
                  <span className="text-gray-500">
                    {cell.bags} bags · {formatLKR(cell.value)}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Toolbar */}
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
        <div className="relative min-w-[170px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search the stockpile..."
            className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </div>

        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        >
          <option value="age">Oldest first</option>
          <option value="value">Highest value</option>
          <option value="bags">Most bags</option>
          <option value="name">Name (A-Z)</option>
        </select>

        <Tool onClick={() => setDialog({ kind: "add" })} icon={Plus}>
          Add item
        </Tool>
        <Tool onClick={() => pdfInputRef.current?.click()} icon={UploadCloud}>
          Import PDF
        </Tool>
        <Tool onClick={tidyUp} icon={Sparkles}>
          Tidy up
        </Tool>

        <span className="mx-1 hidden h-6 w-px bg-gray-200 sm:block" />

        <Tool onClick={exportPdf} icon={Download} disabled={busy}>
          PDF
        </Tool>
        <Tool onClick={exportCsv} icon={FileSpreadsheet}>
          CSV
        </Tool>
        <Tool onClick={saveFile} icon={Save}>
          Save file
        </Tool>
        <Tool onClick={() => jsonInputRef.current?.click()} icon={FolderOpen}>
          Load file
        </Tool>
        <Tool onClick={clearStockpile} icon={Trash2} danger>
          Clear all
        </Tool>
      </div>

      {bucketFilter && (
        <div className="mt-3 flex items-center gap-2 text-sm text-gray-600">
          Filtered to{" "}
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-xs font-medium",
              BUCKET_STYLES[bucketFilter].chip,
            )}
          >
            {AGE_BUCKETS.find((b) => b.key === bucketFilter)?.label}
          </span>
          <button
            onClick={() => setBucketFilter("")}
            className="text-brand-600 underline-offset-2 hover:underline"
          >
            clear
          </button>
        </div>
      )}

      {/* Empty state */}
      {isEmpty && (
        <div className="mt-6 rounded-2xl border-2 border-dashed border-gray-300 bg-white/70 px-6 py-16 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
            <Boxes className="h-8 w-8" />
          </div>
          <p className="mt-5 text-lg font-semibold text-gray-800">
            The stockpile is empty
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
            Send leftover bags here from the Order Editor, import a whole order
            PDF, or add an item by hand.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <button
              onClick={() => setDialog({ kind: "add" })}
              className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-brand-600/25 transition hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" />
              Add an item
            </button>
            <button
              onClick={() => pdfInputRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              <UploadCloud className="h-4 w-4" />
              Import an order PDF
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      {!isEmpty && loaded && (
        <div className="mt-4 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="preview-scroll max-h-[560px] overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-gray-900 text-white">
                <tr>
                  <th className="w-8 px-2 py-3" />
                  <th className="px-3 py-3 text-left font-semibold">Item</th>
                  <th className="w-20 px-2 py-3 text-center font-semibold">
                    Bags
                  </th>
                  <th className="w-32 px-2 py-3 text-right font-semibold">
                    Avg / Bag
                  </th>
                  <th className="w-36 px-2 py-3 text-right font-semibold">
                    Value
                  </th>
                  <th className="w-28 px-2 py-3 text-center font-semibold">
                    Sitting
                  </th>
                  <th className="w-32 px-2 py-3 text-center font-semibold">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-10 text-center text-sm text-gray-500"
                    >
                      No items match this view.
                    </td>
                  </tr>
                )}
                {rows.map((item) => {
                  const bags = itemBags(item);
                  const days = itemAgeDays(item);
                  const bucket = ageBucket(days);
                  const open = expanded === item.id;
                  const empty = bags === 0;
                  return (
                    <Fragment key={item.id}>
                      <tr
                        className={cn(
                          "border-b border-gray-100 transition-colors hover:bg-brand-50/40",
                          empty && "bg-gray-50 text-gray-400",
                        )}
                      >
                        <td className="px-2 py-2 text-center">
                          <button
                            onClick={() => setExpanded(open ? null : item.id)}
                            className="rounded-md p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
                            title={open ? "Hide batches" : "Show batches"}
                          >
                            {open ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </button>
                        </td>
                        <td className="px-3 py-2">
                          <span className="font-medium text-gray-800">
                            {item.name}
                          </span>
                          <span className="ml-2 text-xs text-gray-400">
                            {item.lots.length} batch
                            {item.lots.length === 1 ? "" : "es"}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-center font-medium">
                          {bags}
                        </td>
                        <td className="px-2 py-2 text-right text-gray-600">
                          {formatLKR(itemAvgPerBag(item))}
                        </td>
                        <td className="px-2 py-2 text-right font-medium text-gray-900">
                          {formatLKR(itemValue(item))}
                        </td>
                        <td className="px-2 py-2 text-center">
                          {empty ? (
                            <span className="text-xs text-gray-400">empty</span>
                          ) : (
                            <span
                              className={cn(
                                "inline-block rounded-full border px-2 py-0.5 text-xs font-medium",
                                BUCKET_STYLES[bucket.key].chip,
                              )}
                              title={bucket.label}
                            >
                              {days}d
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center justify-center gap-1">
                            <IconBtn
                              title="Add more bags"
                              onClick={() => {
                                setDialog({ kind: "lot", itemId: item.id });
                                setFBags("");
                                setFPerBag(
                                  String(Math.round(itemAvgPerBag(item)) || ""),
                                );
                                setFSource("");
                              }}
                            >
                              <PackagePlus className="h-4 w-4" />
                            </IconBtn>
                            <IconBtn
                              title="Remove bags (oldest first)"
                              disabled={empty}
                              onClick={() => {
                                setDialog({ kind: "withdraw", itemId: item.id });
                                setFBags("");
                                setFReason("Sold");
                              }}
                            >
                              <PackageMinus className="h-4 w-4" />
                            </IconBtn>
                            <IconBtn
                              title="Merge into another item"
                              onClick={() => {
                                setDialog({ kind: "merge", itemId: item.id });
                                setFMergeInto("");
                              }}
                            >
                              <Merge className="h-4 w-4" />
                            </IconBtn>
                            <IconBtn
                              title="Delete item"
                              danger
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Delete "${item.name}" and its ${bags} bag(s) from the stockpile?`,
                                  )
                                ) {
                                  apply(removeItem(sp, item.id));
                                  setNotice(`Deleted ${item.name}.`);
                                }
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </IconBtn>
                          </div>
                        </td>
                      </tr>

                      {/* Batch detail */}
                      {open && (
                        <tr className="bg-gray-50/80">
                          <td />
                          <td colSpan={6} className="px-3 py-3">
                            {item.lots.length === 0 ? (
                              <p className="text-xs text-gray-500">
                                No batches left. Add bags to restock this item.
                              </p>
                            ) : (
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-left text-gray-500">
                                    <th className="py-1 font-medium">Batch from</th>
                                    <th className="py-1 text-center font-medium">
                                      Bags
                                    </th>
                                    <th className="py-1 text-right font-medium">
                                      Per bag
                                    </th>
                                    <th className="py-1 text-right font-medium">
                                      Value
                                    </th>
                                    <th className="py-1 text-center font-medium">
                                      Added
                                    </th>
                                    <th className="py-1 text-center font-medium">
                                      Age
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {[...item.lots]
                                    .sort((a, b) =>
                                      a.addedAt < b.addedAt ? -1 : 1,
                                    )
                                    .map((lot) => {
                                      const d = itemAgeDays(
                                        { ...item, lots: [lot] },
                                      );
                                      return (
                                        <tr
                                          key={lot.id}
                                          className="border-t border-gray-200 text-gray-700"
                                        >
                                          <td className="py-1.5">
                                            {lot.source || "Added manually"}
                                          </td>
                                          <td className="py-1.5 text-center">
                                            {lot.bags}
                                          </td>
                                          <td className="py-1.5 text-right">
                                            {formatLKR(lot.perBag)}
                                          </td>
                                          <td className="py-1.5 text-right">
                                            {formatLKR(lot.bags * lot.perBag)}
                                          </td>
                                          <td className="py-1.5 text-center">
                                            {lot.addedAt.slice(0, 10)}
                                          </td>
                                          <td className="py-1.5 text-center">
                                            {d}d
                                          </td>
                                        </tr>
                                      );
                                    })}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot className="sticky bottom-0 bg-brand-100 font-bold text-gray-900">
                <tr>
                  <td />
                  <td className="px-3 py-3">
                    Total
                    {rows.length !== sp.items.length && (
                      <span className="ml-2 text-xs font-normal text-gray-600">
                        (showing {rows.length} of {sp.items.length})
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-3 text-center">{totals.bags}</td>
                  <td />
                  <td className="px-2 py-3 text-right">
                    {formatLKR(totals.value)}
                  </td>
                  <td />
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Movement history */}
      {sp.history.length > 0 && (
        <section className="mt-5 rounded-2xl border border-gray-200 bg-white shadow-sm">
          <button
            onClick={() => setShowHistory((v) => !v)}
            className="flex w-full items-center justify-between px-5 py-4 text-left"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <History className="h-4 w-4 text-brand-600" />
              Movement history
              <span className="text-xs font-normal text-gray-500">
                ({sp.history.length} most recent)
              </span>
            </span>
            {showHistory ? (
              <ChevronDown className="h-4 w-4 text-gray-400" />
            ) : (
              <ChevronRight className="h-4 w-4 text-gray-400" />
            )}
          </button>
          {showHistory && (
            <ul className="max-h-72 overflow-auto border-t border-gray-100 px-5 py-3 text-sm">
              {sp.history.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-3 border-b border-gray-50 py-2 last:border-0"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase",
                        m.kind === "in"
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-red-50 text-red-700",
                      )}
                    >
                      {m.kind === "in" ? "In" : "Out"}
                    </span>
                    <span className="truncate text-gray-800">
                      {m.bags} x {m.itemName}
                    </span>
                    <span className="hidden truncate text-xs text-gray-400 sm:inline">
                      {m.reason}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-medium text-gray-700">
                      {formatLKR(m.value)}
                    </span>
                    <span className="block text-xs text-gray-400">
                      {m.at.slice(0, 10)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ------------------------------ dialogs ------------------------------ */}

      {dialog?.kind === "add" && (
        <Modal title="Add to the stockpile" onClose={closeDialog}>
          <Field label="Item name">
            <input
              autoFocus
              value={fName}
              onChange={(e) => setFName(e.target.value)}
              placeholder="e.g. Blanket"
              className={inputCls}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bags">
              <input
                value={fBags}
                onChange={(e) => setFBags(e.target.value)}
                inputMode="numeric"
                placeholder="12"
                className={inputCls}
              />
            </Field>
            <Field label="Price per bag (Rs)">
              <input
                value={fPerBag}
                onChange={(e) => setFPerBag(e.target.value)}
                inputMode="decimal"
                placeholder="20000"
                className={inputCls}
              />
            </Field>
          </div>
          <Field label="Source (optional)">
            <input
              value={fSource}
              onChange={(e) => setFSource(e.target.value)}
              placeholder="e.g. Sri Lanka Order 3 2026"
              className={inputCls}
            />
          </Field>
          <p className="mt-1 text-xs text-gray-500">
            An item already in the stockpile gets a new batch, not a replacement.
          </p>
          <Actions onCancel={closeDialog} onConfirm={submitAdd} confirm="Add bags" />
        </Modal>
      )}

      {dialog?.kind === "lot" && dialogItem && (
        <Modal title={`Add bags to ${dialogItem.name}`} onClose={closeDialog}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bags">
              <input
                autoFocus
                value={fBags}
                onChange={(e) => setFBags(e.target.value)}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="Price per bag (Rs)">
              <input
                value={fPerBag}
                onChange={(e) => setFPerBag(e.target.value)}
                inputMode="decimal"
                className={inputCls}
              />
            </Field>
          </div>
          <Field label="Source (optional)">
            <input
              value={fSource}
              onChange={(e) => setFSource(e.target.value)}
              placeholder="Which order are these from?"
              className={inputCls}
            />
          </Field>
          <Actions onCancel={closeDialog} onConfirm={submitLot} confirm="Add batch" />
        </Modal>
      )}

      {dialog?.kind === "withdraw" && dialogItem && (
        <WithdrawDialog
          item={dialogItem}
          bags={fBags}
          reason={fReason}
          onBags={setFBags}
          onReason={setFReason}
          onCancel={closeDialog}
          onConfirm={submitWithdraw}
        />
      )}

      {dialog?.kind === "merge" && dialogItem && (
        <Modal title={`Merge ${dialogItem.name} into...`} onClose={closeDialog}>
          <p className="mb-3 text-sm text-gray-500">
            Every batch of <strong>{dialogItem.name}</strong> moves into the item
            you pick. Use it when one product was named two ways.
          </p>
          <Field label="Merge into">
            <select
              value={fMergeInto}
              onChange={(e) => setFMergeInto(e.target.value)}
              className={inputCls}
            >
              <option value="">Choose an item...</option>
              {sp.items
                .filter((i) => i.id !== dialogItem.id)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({itemBags(i)} bags)
                  </option>
                ))}
            </select>
          </Field>
          <Actions onCancel={closeDialog} onConfirm={submitMerge} confirm="Merge" />
        </Modal>
      )}

      <footer className="mt-16 text-center text-xs text-gray-400">
        Built by Lathurshan
      </footer>
    </main>
  );
}

/* ---------------------------- small components ---------------------------- */

const inputCls =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

function WithdrawDialog({
  item,
  bags,
  reason,
  onBags,
  onReason,
  onCancel,
  onConfirm,
}: {
  item: StockItem;
  bags: string;
  reason: string;
  onBags: (v: string) => void;
  onReason: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const available = itemBags(item);
  const wanted = Number(bags) || 0;
  const plan = planWithdrawal(item, wanted);

  return (
    <Modal title={`Remove bags from ${item.name}`} onClose={onCancel}>
      <p className="mb-3 text-sm text-gray-500">
        {available} bag{available === 1 ? "" : "s"} held. Bags are taken from the
        oldest batch first.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Bags to remove">
          <input
            autoFocus
            value={bags}
            onChange={(e) => onBags(e.target.value)}
            inputMode="numeric"
            className={inputCls}
          />
        </Field>
        <Field label="Reason">
          <select
            value={reason}
            onChange={(e) => onReason(e.target.value)}
            className={inputCls}
          >
            <option>Sold</option>
            <option>Damaged</option>
            <option>Returned to supplier</option>
            <option>Sample / giveaway</option>
            <option>Stock recount</option>
          </select>
        </Field>
      </div>

      {wanted > 0 && plan.shortfall > 0 && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Only {available} bag{available === 1 ? "" : "s"} available - reduce the
          amount.
        </p>
      )}

      {wanted > 0 && plan.shortfall === 0 && (
        <div className="mt-3 rounded-lg bg-brand-50 px-3 py-2.5 text-sm text-brand-900">
          <p className="mb-1.5 font-semibold">
            Taken from {plan.consumed.length} batch
            {plan.consumed.length === 1 ? "" : "es"} (oldest first):
          </p>
          <ul className="space-y-0.5 text-xs">
            {plan.consumed.map((c, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span className="truncate">
                  {c.bags} x {c.source || "manual"} ({c.addedAt.slice(0, 10)})
                </span>
                <span className="shrink-0 font-medium">
                  {formatLKR(c.bags * c.perBag)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 border-t border-brand-200 pt-2 font-bold">
            Value: {formatLKR(plan.value)} · {available - wanted} bag
            {available - wanted === 1 ? "" : "s"} left
          </p>
        </div>
      )}

      <Actions
        onCancel={onCancel}
        onConfirm={onConfirm}
        confirm="Remove bags"
        disabled={wanted <= 0 || plan.shortfall > 0}
      />
    </Modal>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-gray-900/40 p-4 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-md animate-fade-in overflow-auto rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="text-lg font-bold text-gray-900">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 transition hover:bg-gray-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-xs font-medium text-gray-600">
        {label}
      </label>
      {children}
    </div>
  );
}

function Actions({
  onCancel,
  onConfirm,
  confirm,
  disabled,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  confirm: string;
  disabled?: boolean;
}) {
  return (
    <div className="mt-6 flex gap-3">
      <button
        onClick={onCancel}
        className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
      >
        Cancel
      </button>
      <button
        onClick={onConfirm}
        disabled={disabled}
        className="flex-1 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {confirm}
      </button>
    </div>
  );
}

function Tool({
  onClick,
  icon: Icon,
  children,
  disabled,
  danger,
}: {
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40",
        danger
          ? "border-red-200 text-red-600 hover:bg-red-50"
          : "border-gray-200 text-gray-700 hover:bg-gray-50",
      )}
    >
      <Icon className="h-4 w-4" />
      <span className="hidden md:inline">{children}</span>
    </button>
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

function Stat({
  label,
  value,
  highlight,
  tone,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  tone?: "danger";
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border p-4 shadow-sm",
        tone === "danger"
          ? "border-red-200 bg-red-50"
          : highlight
            ? "border-brand-200 bg-brand-50"
            : "border-gray-200 bg-white",
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 truncate text-lg font-bold",
          tone === "danger"
            ? "text-red-700"
            : highlight
              ? "text-brand-700"
              : "text-gray-900",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function Banner({
  tone,
  children,
  onClose,
}: {
  tone: "error" | "info" | "warn";
  children: React.ReactNode;
  onClose?: () => void;
}) {
  const tones = {
    error: "border-red-200 bg-red-50 text-red-700",
    info: "border-brand-200 bg-brand-50 text-brand-800",
    warn: "border-amber-200 bg-amber-50 text-amber-800",
  } as const;
  const Icon = tone === "info" ? CheckCircle2 : AlertTriangle;
  return (
    <div
      className={cn(
        "mb-4 flex animate-fade-in items-start gap-3 rounded-xl border px-4 py-3 text-sm",
        tones[tone],
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

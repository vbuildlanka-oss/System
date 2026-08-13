"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ClipboardList,
  UploadCloud,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  X,
  Plus,
  Trash2,
  Shuffle,
  FileDown,
  FileSpreadsheet,
  Target,
  PencilRuler,
  Search,
} from "lucide-react";
import type { ParsedOrder, EditableRow } from "@/lib/types";
import {
  checkTarget,
  createBagList,
  loadBagLists,
  randomSeed,
  resolveBagList,
  saveBagLists,
  sumQty,
  type BagList,
  type BagListDoc,
} from "@/lib/bagList";
import { readLocal } from "@/lib/storage";
import { cn } from "@/lib/cn";

/** Where the Order Editor keeps its current sheet. */
const EDITOR_KEY = "balebook.orderEditor.v1";
const EDITOR_KEY_LEGACY = "vbuild.orderEditor.v1";

export default function BagListsPage() {
  const [doc, setDoc] = useState<BagListDoc | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [targetDraft, setTargetDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<null | "pdf" | "xlsx">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [search, setSearch] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDoc(loadBagLists());
  }, []);

  const lists = doc?.lists ?? [];
  const active = useMemo(
    () => lists.find((l) => l.id === activeId) ?? lists[0] ?? null,
    [lists, activeId],
  );

  // Keep the target box in step with whichever list is selected.
  useEffect(() => {
    setTargetDraft(active?.target !== null && active ? String(active.target) : "");
  }, [active?.id, active?.target, active]);

  const persist = useCallback((next: BagListDoc) => {
    setDoc(next);
    saveBagLists(next);
  }, []);

  const updateList = useCallback(
    (id: string, patch: Partial<BagList>) => {
      if (!doc) return;
      persist({
        ...doc,
        lists: doc.lists.map((l) => (l.id === id ? { ...l, ...patch } : l)),
        updatedAt: new Date().toISOString(),
      });
    },
    [doc, persist],
  );

  const addList = useCallback(
    (list: BagList) => {
      const base = doc ?? loadBagLists();
      persist({
        ...base,
        lists: [list, ...base.lists],
        updatedAt: new Date().toISOString(),
      });
      setActiveId(list.id);
    },
    [doc, persist],
  );

  /* ------------------------------- sources ------------------------------- */

  const importFile = useCallback(
    async (file: File) => {
      setError(null);
      setNotice(null);
      setLoading(true);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/process", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not read that file.");
        const parsed = data as ParsedOrder;
        const list = createBagList(parsed.title, parsed.items);
        addList(list);
        setNotice(
          `Loaded "${list.title}" - ${list.items.length} items, ${sumQty(list.items)} bags. Pricing was dropped.`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Import failed.");
      } finally {
        setLoading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [addList],
  );

  /** Pull the sheet currently open in the Order Editor. */
  const importFromEditor = useCallback(() => {
    setError(null);
    setNotice(null);
    try {
      const raw = readLocal(EDITOR_KEY, EDITOR_KEY_LEGACY);
      if (!raw) {
        setError(
          "There is no sheet in the Order Editor yet. Open that page and load an order first.",
        );
        return;
      }
      const session = JSON.parse(raw) as {
        title?: string;
        rows?: EditableRow[];
      };
      const rows = Array.isArray(session.rows) ? session.rows : [];
      const usable = rows.filter((r) => Number(r.qty) > 0);
      if (usable.length === 0) {
        setError("The Order Editor sheet has no items with bags remaining.");
        return;
      }
      const list = createBagList(session.title || "Order", usable);
      addList(list);
      setNotice(
        `Pulled "${list.title}" from the Order Editor - ${list.items.length} items, ${sumQty(list.items)} bags.`,
      );
    } catch {
      setError("Could not read the Order Editor sheet.");
    }
  }, [addList]);

  /* ------------------------------- targets ------------------------------- */

  const resolved = useMemo(
    () => (active ? resolveBagList(active) : null),
    [active],
  );

  const validation = useMemo(() => {
    if (!active) return null;
    const draft = targetDraft.trim();
    const parsedTarget = draft === "" ? null : Number(draft);
    return checkTarget(active.items, parsedTarget);
  }, [active, targetDraft]);

  const applyTarget = useCallback(() => {
    if (!active) return;
    const draft = targetDraft.trim();
    const value = draft === "" ? null : Number(draft);
    const check = checkTarget(active.items, value);
    if (!check.ok) {
      setError(check.message ?? "That target cannot be used.");
      return;
    }
    updateList(active.id, { target: Math.floor(value as number), seed: randomSeed() });
    setError(null);
    setNotice(
      `Reduced to exactly ${value} bags across ${active.items.length} items.`,
    );
  }, [active, targetDraft, updateList]);

  const reshuffle = useCallback(() => {
    if (!active || active.target === null) return;
    updateList(active.id, { seed: randomSeed() });
    setNotice("Reshuffled - a different split totalling the same number.");
  }, [active, updateList]);

  const clearTarget = useCallback(() => {
    if (!active) return;
    updateList(active.id, { target: null });
    setTargetDraft("");
    setNotice("Target cleared - showing the original quantities.");
  }, [active, updateList]);

  const removeList = useCallback(() => {
    if (!active || !doc) return;
    if (!window.confirm(`Remove the bag list for "${active.title}"?`)) return;
    persist({
      ...doc,
      lists: doc.lists.filter((l) => l.id !== active.id),
      updatedAt: new Date().toISOString(),
    });
    setActiveId(null);
    setNotice("Bag list removed.");
  }, [active, doc, persist]);

  /* ------------------------------- exports ------------------------------- */

  const download = useCallback(
    async (format: "pdf" | "xlsx") => {
      if (!active || !resolved) return;
      setBusy(format);
      setError(null);
      try {
        const res = await fetch("/api/bag-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: active.title,
            format,
            items: resolved.items.map((i) => ({ name: i.name, qty: i.qty })),
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Export failed.");
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${active.title} - Bag List.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Export failed.");
      } finally {
        setBusy(null);
      }
    },
    [active, resolved],
  );

  /* -------------------------------- render -------------------------------- */

  const visibleItems = useMemo(() => {
    if (!resolved) return [];
    const q = search.trim().toLowerCase();
    if (!q) return resolved.items.map((item, i) => ({ item, i }));
    return resolved.items
      .map((item, i) => ({ item, i }))
      .filter(({ item }) => item.name.toLowerCase().includes(q));
  }, [resolved, search]);

  const originalTotal = active ? sumQty(active.items) : 0;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-12">
      <header className="mb-8">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
          <ClipboardList className="h-7 w-7 text-brand-600" />
          Order Bag Lists
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-gray-500">
          A manifest you can hand out: item names and bag counts only, with no
          prices anywhere. Set the total number of bags and the quantities are
          reduced at random to match it exactly.
        </p>
      </header>

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
      {doc && lists.length === 0 && (
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
            if (f) importFile(f);
          }}
          onClick={() => fileRef.current?.click()}
          className={cn(
            "group flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed bg-white/70 px-6 py-16 text-center shadow-sm backdrop-blur transition-all",
            dragging
              ? "border-brand-500 bg-brand-50 ring-4 ring-brand-100"
              : "border-gray-300 hover:border-brand-400 hover:bg-white",
          )}
        >
          {loading ? (
            <>
              <Loader2 className="h-12 w-12 animate-spin text-brand-500" />
              <p className="mt-4 text-lg font-medium text-gray-700">
                Reading the order...
              </p>
            </>
          ) : (
            <>
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 transition-transform group-hover:scale-105">
                <UploadCloud className="h-8 w-8" />
              </div>
              <p className="mt-5 text-lg font-semibold text-gray-800">
                Drop an order here
              </p>
              <p className="mt-1 text-sm text-gray-500">
                or{" "}
                <span className="font-medium text-brand-600">
                  click to browse
                </span>{" "}
                · PDF, CSV or XLSX
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  importFromEditor();
                }}
                className="mt-6 inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                <PencilRuler className="h-4 w-4" />
                Use the sheet from the Order Editor
              </button>
            </>
          )}
        </div>
      )}

      {lists.length > 0 && (
        <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
          {/* Order picker */}
          <aside className="space-y-3">
            <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
              <p className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                Orders
              </p>
              <ul className="space-y-1">
                {lists.map((l) => {
                  const isActive = active?.id === l.id;
                  const total = sumQty(l.items);
                  return (
                    <li key={l.id}>
                      <button
                        onClick={() => setActiveId(l.id)}
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
                          {l.title}
                        </span>
                        <span className="block text-xs text-gray-500">
                          {l.items.length} items ·{" "}
                          {l.target !== null ? (
                            <span className="font-medium text-brand-700">
                              target {l.target}
                            </span>
                          ) : (
                            `${total} bags`
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="mt-3 space-y-1 border-t border-gray-100 pt-3">
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={loading}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  Add from file
                </button>
                <button
                  onClick={importFromEditor}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                >
                  <PencilRuler className="h-4 w-4" />
                  From Order Editor
                </button>
              </div>
            </div>
          </aside>

          {/* Active list */}
          {active && resolved && validation && (
            <section className="space-y-5">
              {/* Title + target */}
              <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor="bl-title"
                      className="text-[11px] font-medium uppercase tracking-wide text-gray-500"
                    >
                      Order title
                    </label>
                    <input
                      id="bl-title"
                      value={active.title}
                      onChange={(e) =>
                        updateList(active.id, { title: e.target.value })
                      }
                      className="mt-1 w-full rounded-lg border border-transparent bg-transparent px-0 py-1 text-xl font-bold text-gray-900 outline-none transition focus:border-gray-300 focus:bg-gray-50 focus:px-3"
                    />
                  </div>
                  <button
                    onClick={removeList}
                    title="Remove this bag list"
                    className="mt-4 rounded-md p-2 text-red-500 transition hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-3">
                  <Stat label="Items" value={String(active.items.length)} />
                  <Stat label="Original bags" value={String(originalTotal)} />
                  <Stat
                    label="Bags on list"
                    value={String(resolved.total)}
                    highlight={resolved.reduced}
                  />
                </div>

                <div className="mt-5 flex flex-wrap items-end gap-3">
                  <div>
                    <label
                      htmlFor="bl-target"
                      className="mb-1 block text-xs font-medium text-gray-600"
                    >
                      Target total bags
                    </label>
                    <div className="relative w-44">
                      <Target className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                      <input
                        id="bl-target"
                        value={targetDraft}
                        onChange={(e) => setTargetDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") applyTarget();
                        }}
                        inputMode="numeric"
                        placeholder={`${validation.min} - ${validation.max}`}
                        className={cn(
                          "w-full rounded-lg border py-2 pl-9 pr-3 text-sm font-semibold outline-none transition focus:ring-2",
                          targetDraft.trim() !== "" && !validation.ok
                            ? "border-amber-300 bg-amber-50 focus:border-amber-400 focus:ring-amber-100"
                            : "border-gray-300 focus:border-brand-500 focus:ring-brand-100",
                        )}
                      />
                    </div>
                  </div>

                  <button
                    onClick={applyTarget}
                    disabled={!validation.ok}
                    className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Generate list
                  </button>

                  {active.target !== null && (
                    <>
                      <button
                        onClick={reshuffle}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                      >
                        <Shuffle className="h-4 w-4" />
                        Reshuffle
                      </button>
                      <button
                        onClick={clearTarget}
                        className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50"
                      >
                        Clear target
                      </button>
                    </>
                  )}
                </div>

                <p
                  className={cn(
                    "mt-2 text-xs",
                    targetDraft.trim() !== "" && !validation.ok
                      ? "text-amber-700"
                      : "text-gray-500",
                  )}
                >
                  {targetDraft.trim() !== "" && !validation.ok
                    ? validation.message
                    : `Anywhere from ${validation.min} (one bag per item) to ${validation.max} (the order as imported).`}
                </p>

                {resolved.reduced && (
                  <p className="mt-3 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    Showing {resolved.total} bags across {active.items.length}{" "}
                    items - {originalTotal - resolved.total} removed, every item
                    keeping at least one.
                  </p>
                )}
              </div>

              {/* The manifest */}
              <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
                <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search items..."
                      className="w-full rounded-lg border border-gray-300 py-1.5 pl-9 pr-3 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                    />
                  </div>
                  <span className="hidden text-xs text-gray-400 sm:inline">
                    No prices on this list
                  </span>
                </div>

                <div className="preview-scroll max-h-[520px] overflow-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead className="sticky top-0 z-10 bg-gray-900 text-white">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold">
                          Item Name
                        </th>
                        <th className="w-32 px-4 py-3 text-right font-semibold">
                          Quantity
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleItems.length === 0 && (
                        <tr>
                          <td
                            colSpan={2}
                            className="px-4 py-10 text-center text-sm text-gray-500"
                          >
                            No items match this search.
                          </td>
                        </tr>
                      )}
                      {visibleItems.map(({ item, i }) => {
                        const was = active.items[i]?.qty ?? item.qty;
                        const changed = resolved.reduced && was !== item.qty;
                        return (
                          <tr
                            key={`${item.name}-${i}`}
                            className={cn(
                              "border-b border-gray-100 transition-colors hover:bg-brand-50/40",
                              i % 2 === 1 && "bg-gray-50/60",
                            )}
                          >
                            <td className="px-4 py-2.5 text-gray-800">
                              {item.name}
                            </td>
                            <td className="px-4 py-2.5 text-right font-medium text-gray-900">
                              {item.qty}
                              {changed && (
                                <span className="ml-2 text-xs font-normal text-gray-400">
                                  was {was}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="sticky bottom-0 bg-brand-100 font-bold text-gray-900">
                      <tr>
                        <td className="px-4 py-3">
                          Total
                          {visibleItems.length !== resolved.items.length && (
                            <span className="ml-2 text-xs font-normal text-gray-600">
                              (showing {visibleItems.length} of{" "}
                              {resolved.items.length})
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {resolved.total}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              {/* Exports */}
              <div className="flex flex-wrap justify-end gap-3">
                <button
                  onClick={() => download("xlsx")}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-white px-5 py-3 text-sm font-semibold text-emerald-700 shadow-sm transition hover:bg-emerald-50 disabled:opacity-60"
                >
                  {busy === "xlsx" ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <FileSpreadsheet className="h-5 w-5" />
                  )}
                  Download .xlsx
                </button>
                <button
                  onClick={() => download("pdf")}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-600/25 transition hover:bg-brand-700 disabled:opacity-60"
                >
                  {busy === "pdf" ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <FileDown className="h-5 w-5" />
                  )}
                  Download .pdf
                </button>
              </div>
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
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-3",
        highlight ? "border-brand-200 bg-brand-50" : "border-gray-200 bg-gray-50",
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 truncate text-base font-bold",
          highlight ? "text-brand-700" : "text-gray-900",
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

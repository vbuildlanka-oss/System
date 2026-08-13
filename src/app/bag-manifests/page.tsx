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
  Container as ContainerIcon,
} from "lucide-react";
import type { ParsedOrder, EditableRow } from "@/lib/types";
import {
  checkTarget,
  clearGenerated,
  createManifest,
  generateManifest,
  loadManifests,
  manifestFilename,
  orderNumberFromFilename,
  randomSeed,
  resolveManifest,
  saveManifests,
  sumQty,
  type BagManifest,
  type BagManifestDoc,
} from "@/lib/bagManifest";
import { checkContainerNumber } from "@/lib/container";
import { readLocal } from "@/lib/storage";
import { cn } from "@/lib/cn";

/** Where the Order Editor keeps its current sheet. */
const EDITOR_KEY = "balebook.orderEditor.v1";
const EDITOR_KEY_LEGACY = "vbuild.orderEditor.v1";

export default function BagManifestsPage() {
  const [doc, setDoc] = useState<BagManifestDoc | null>(null);
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
    setDoc(loadManifests());
  }, []);

  const manifests = doc?.manifests ?? [];
  const active = useMemo(
    () => manifests.find((m) => m.id === activeId) ?? manifests[0] ?? null,
    [manifests, activeId],
  );

  // Keep the target box in step with whichever manifest is selected.
  useEffect(() => {
    setTargetDraft(active && active.target !== null ? String(active.target) : "");
  }, [active?.id, active?.target, active]);

  const persist = useCallback((next: BagManifestDoc) => {
    setDoc(next);
    saveManifests(next);
  }, []);

  const updateManifest = useCallback(
    (id: string, patch: Partial<BagManifest>) => {
      if (!doc) return;
      persist({
        ...doc,
        manifests: doc.manifests.map((m) =>
          m.id === id ? { ...m, ...patch } : m,
        ),
        updatedAt: new Date().toISOString(),
      });
    },
    [doc, persist],
  );

  const replaceManifest = useCallback(
    (next: BagManifest) => {
      if (!doc) return;
      persist({
        ...doc,
        manifests: doc.manifests.map((m) => (m.id === next.id ? next : m)),
        updatedAt: new Date().toISOString(),
      });
    },
    [doc, persist],
  );

  const addManifest = useCallback(
    (manifest: BagManifest) => {
      const base = doc ?? loadManifests();
      persist({
        ...base,
        manifests: [manifest, ...base.manifests],
        updatedAt: new Date().toISOString(),
      });
      setActiveId(manifest.id);
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
        // The number in the file name is what gets tracked, so it wins over the
        // heading printed inside the file.
        const fromName = orderNumberFromFilename(file.name);
        const manifest = createManifest(fromName || parsed.title, parsed.items);
        addManifest(manifest);
        setNotice(
          `Loaded "${manifest.orderNumber}" - ${manifest.items.length} items, ${sumQty(manifest.items)} bags. Pricing was dropped.`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Import failed.");
      } finally {
        setLoading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [addManifest],
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
        containerNumber?: string;
      };
      const rows = Array.isArray(session.rows) ? session.rows : [];
      const usable = rows.filter((r) => Number(r.qty) > 0);
      if (usable.length === 0) {
        setError("The Order Editor sheet has no items with bags remaining.");
        return;
      }
      const manifest = createManifest(
        session.title || "Order",
        usable,
        session.containerNumber ?? "",
      );
      addManifest(manifest);
      setNotice(
        `Pulled "${manifest.orderNumber}" from the Order Editor - ${manifest.items.length} items, ${sumQty(manifest.items)} bags.`,
      );
    } catch {
      setError("Could not read the Order Editor sheet.");
    }
  }, [addManifest]);

  /* ------------------------- targets and container ------------------------ */

  const resolved = useMemo(
    () => (active ? resolveManifest(active) : null),
    [active],
  );

  const validation = useMemo(() => {
    if (!active) return null;
    const draft = targetDraft.trim();
    const parsedTarget = draft === "" ? null : Number(draft);
    return checkTarget(active.items, parsedTarget);
  }, [active, targetDraft]);

  const container = useMemo(
    () => (active ? checkContainerNumber(active.containerNumber) : null),
    [active],
  );

  const generate = useCallback(() => {
    if (!active) return;
    const draft = targetDraft.trim();
    const value = draft === "" ? null : Number(draft);
    const check = checkTarget(active.items, value);
    if (!check.ok) {
      setError(check.message ?? "That target cannot be used.");
      return;
    }
    replaceManifest(generateManifest(active, Math.floor(value as number)));
    setError(null);
    setNotice(
      `Generated a manifest of exactly ${value} bags across ${active.items.length} items. It is saved, so re-downloading gives the same figures.`,
    );
  }, [active, targetDraft, replaceManifest]);

  const rerandomize = useCallback(() => {
    if (!active || active.target === null) return;
    if (
      !window.confirm(
        "Re-randomise this manifest?\n\nThe saved distribution will be replaced with a new one totalling the same number of bags. Any copy already sent out will no longer match.",
      )
    ) {
      return;
    }
    replaceManifest(generateManifest(active, active.target, randomSeed()));
    setNotice("Re-randomised - a different split totalling the same number.");
  }, [active, replaceManifest]);

  const reset = useCallback(() => {
    if (!active) return;
    replaceManifest(clearGenerated(active));
    setTargetDraft("");
    setNotice("Cleared - showing the original quantities.");
  }, [active, replaceManifest]);

  const removeManifest = useCallback(() => {
    if (!active || !doc) return;
    if (!window.confirm(`Remove the manifest for "${active.orderNumber}"?`)) return;
    persist({
      ...doc,
      manifests: doc.manifests.filter((m) => m.id !== active.id),
      updatedAt: new Date().toISOString(),
    });
    setActiveId(null);
    setNotice("Manifest removed.");
  }, [active, doc, persist]);

  /* ------------------------------- exports ------------------------------- */

  const download = useCallback(
    async (format: "pdf" | "xlsx") => {
      if (!active || !resolved || !container) return;
      if (!container.ok) {
        setError(container.message ?? "A valid container number is required.");
        return;
      }
      setBusy(format);
      setError(null);
      try {
        const res = await fetch("/api/bag-manifest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orderNumber: active.orderNumber,
            containerNumber: container.value,
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
        a.download = manifestFilename(active.orderNumber, container.value, format);
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
    [active, resolved, container],
  );

  /* -------------------------------- render -------------------------------- */

  const visibleItems = useMemo(() => {
    if (!resolved) return [];
    const q = search.trim().toLowerCase();
    const rows = resolved.items.map((item, i) => ({ item, i }));
    if (!q) return rows;
    return rows.filter(({ item }) => item.name.toLowerCase().includes(q));
  }, [resolved, search]);

  const originalTotal = active ? sumQty(active.items) : 0;
  const hasOrderNumber = (active?.orderNumber ?? "").trim() !== "";
  /** A gentle nudge only - any order number is accepted. */
  const orderNumberLooksOdd =
    hasOrderNumber && !/\d\s*$/.test((active?.orderNumber ?? "").trim());
  const canExport =
    Boolean(container?.ok) &&
    hasOrderNumber &&
    (resolved?.items.length ?? 0) > 0;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-12">
      <header className="mb-8">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
          <ClipboardList className="h-7 w-7 text-brand-600" />
          Order Bag Manifests
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-gray-500">
          A manifest for shippers and customs: order title, container number,
          item names and bag counts. No prices anywhere. Set the total number of
          bags and the quantities are reduced at random to match it exactly.
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
      {doc && manifests.length === 0 && (
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

      {manifests.length > 0 && (
        <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
          {/* Order picker */}
          <aside className="space-y-3">
            <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
              <p className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                Orders
              </p>
              <ul className="space-y-1">
                {manifests.map((m) => {
                  const isActive = active?.id === m.id;
                  return (
                    <li key={m.id}>
                      <button
                        onClick={() => setActiveId(m.id)}
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
                          {m.orderNumber}
                        </span>
                        <span className="block truncate text-xs text-gray-500">
                          {m.containerNumber || "no container"} ·{" "}
                          {m.generated ? (
                            <span className="font-medium text-brand-700">
                              {sumQty(m.generated)} bags
                            </span>
                          ) : (
                            `${sumQty(m.items)} bags`
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

          {/* Active manifest */}
          {active && resolved && validation && container && (
            <section className="space-y-5">
              {/* Order details */}
              <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor="bm-order-no"
                      className="text-[11px] font-medium uppercase tracking-wide text-gray-500"
                    >
                      Order number
                    </label>
                    <input
                      id="bm-order-no"
                      value={active.orderNumber}
                      onChange={(e) =>
                        updateManifest(active.id, {
                          orderNumber: e.target.value,
                        })
                      }
                      placeholder="Sri Lanka 01"
                      className={cn(
                        "mt-1 w-full rounded-lg border bg-transparent px-0 py-1 text-xl font-bold text-gray-900 outline-none transition focus:border-gray-300 focus:bg-gray-50 focus:px-3",
                        active.orderNumber.trim() === ""
                          ? "border-amber-300 bg-amber-50 px-3"
                          : "border-transparent",
                      )}
                    />
                    <p
                      className={cn(
                        "mt-1 text-xs",
                        active.orderNumber.trim() === ""
                          ? "text-amber-700"
                          : "text-gray-500",
                      )}
                    >
                      {active.orderNumber.trim() === ""
                        ? "Required - this is the heading on the manifest. For example Sri Lanka 01."
                        : orderNumberLooksOdd
                          ? "Usually ends with a number, for example Sri Lanka 01."
                          : "The heading on every page of the manifest."}
                    </p>
                  </div>
                  <button
                    onClick={removeManifest}
                    title="Remove this manifest"
                    className="mt-4 rounded-md p-2 text-red-500 transition hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {/* Container number */}
                <div className="mt-4">
                  <label
                    htmlFor="bm-container"
                    className="mb-1 block text-xs font-medium text-gray-600"
                  >
                    Container number
                  </label>
                  <div className="relative sm:w-72">
                    <ContainerIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                    <input
                      id="bm-container"
                      value={active.containerNumber}
                      onChange={(e) =>
                        updateManifest(active.id, {
                          // Stored uppercase, separators stripped as you type.
                          containerNumber: e.target.value
                            .replace(/[\s-]+/g, "")
                            .toUpperCase()
                            .slice(0, 11),
                        })
                      }
                      placeholder="GAOU7441740"
                      className={cn(
                        "w-full rounded-lg border py-2 pl-9 pr-10 font-mono text-sm tracking-wide outline-none transition focus:ring-2",
                        active.containerNumber === ""
                          ? "border-gray-300 focus:border-brand-500 focus:ring-brand-100"
                          : container.ok && container.checkDigitValid
                            ? "border-emerald-300 bg-emerald-50/40 focus:border-emerald-400 focus:ring-emerald-100"
                            : "border-amber-300 bg-amber-50 focus:border-amber-400 focus:ring-amber-100",
                      )}
                    />
                    {active.containerNumber !== "" && (
                      <span className="absolute right-3 top-1/2 -translate-y-1/2">
                        {container.ok && container.checkDigitValid ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <AlertTriangle className="h-4 w-4 text-amber-500" />
                        )}
                      </span>
                    )}
                  </div>
                  <p
                    className={cn(
                      "mt-1 text-xs",
                      active.containerNumber !== "" && !container.checkDigitValid
                        ? "text-amber-700"
                        : "text-gray-500",
                    )}
                  >
                    {active.containerNumber === ""
                      ? "Four letters then seven digits. Required before exporting."
                      : (container.message ??
                        "Valid ISO 6346 number, check digit agrees.")}
                  </p>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-3">
                  <Stat label="Items" value={String(active.items.length)} />
                  <Stat label="Original bags" value={String(originalTotal)} />
                  <Stat
                    label="Bags on manifest"
                    value={String(resolved.total)}
                    highlight={resolved.generated}
                  />
                </div>

                {/* Target */}
                <div className="mt-5 flex flex-wrap items-end gap-3">
                  <div>
                    <label
                      htmlFor="bm-target"
                      className="mb-1 block text-xs font-medium text-gray-600"
                    >
                      Target total bags
                    </label>
                    <div className="relative w-44">
                      <Target className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                      <input
                        id="bm-target"
                        value={targetDraft}
                        onChange={(e) => setTargetDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") generate();
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
                    onClick={generate}
                    disabled={!validation.ok}
                    className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {resolved.generated ? "Regenerate" : "Generate manifest"}
                  </button>

                  {resolved.generated && (
                    <>
                      <button
                        onClick={rerandomize}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                      >
                        <Shuffle className="h-4 w-4" />
                        Re-randomise
                      </button>
                      <button
                        onClick={reset}
                        className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50"
                      >
                        Clear
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

                {resolved.generated && (
                  <p className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      Saved manifest of {resolved.total} bags across{" "}
                      {active.items.length} items -{" "}
                      {originalTotal - resolved.total} removed, every item
                      keeping at least one. Re-downloading reproduces these exact
                      figures.
                    </span>
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
                    No prices on this manifest
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
                        const changed = resolved.generated && was !== item.qty;
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
              <div className="flex flex-wrap items-center justify-end gap-3">
                {!container.ok && (
                  <span className="flex items-center gap-1.5 text-sm text-amber-700">
                    <AlertTriangle className="h-4 w-4" />
                    Add a container number to export
                  </span>
                )}
                <button
                  onClick={() => download("xlsx")}
                  disabled={busy !== null || !canExport}
                  className="inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-white px-5 py-3 text-sm font-semibold text-emerald-700 shadow-sm transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"
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
                  disabled={busy !== null || !canExport}
                  className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-600/25 transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
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

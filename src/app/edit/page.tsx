"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  UploadCloud,
  Loader2,
  AlertTriangle,
  X,
  Plus,
  Trash2,
  Copy,
  Undo2,
  Redo2,
  Search,
  Download,
  Save,
  FolderOpen,
  ShoppingCart,
  RotateCcw,
  EyeOff,
  Eye,
  FileDown,
  CheckCircle2,
} from "lucide-react";
import type { EditableRow, ParsedOrder } from "@/lib/types";
import { computeRowTotal, formatLKR } from "@/lib/types";
import { cn } from "@/lib/cn";

const STORAGE_KEY = "vbuild.orderEditor.v1";

interface SoldEntry {
  id: string;
  name: string;
  bags: number;
  perBag: number;
  amount: number;
  at: string;
}

interface Snapshot {
  rows: EditableRow[];
  soldLog: SoldEntry[];
}

interface SessionFile {
  app: "vbuild-order-editor";
  version: 1;
  title: string;
  rows: EditableRow[];
  soldLog: SoldEntry[];
  savedAt: string;
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `r${Date.now().toString(36)}${idCounter}`;
}

export default function EditPage() {
  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [soldLog, setSoldLog] = useState<SoldEntry[]>([]);
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<null | "updated" | "sales">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [search, setSearch] = useState("");
  const [hideSoldOut, setHideSoldOut] = useState(false);
  const [restored, setRestored] = useState(false);

  const [sellId, setSellId] = useState<string | null>(null);
  const [sellQty, setSellQty] = useState("");

  const pdfInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  const hasSheet = rows.length > 0 || title !== "";

  /* ---------------------------- persistence ---------------------------- */

  // Restore autosaved work on first mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as SessionFile;
        if (Array.isArray(saved.rows) && saved.rows.length > 0) {
          setTitle(saved.title ?? "");
          setRows(saved.rows);
          setSoldLog(Array.isArray(saved.soldLog) ? saved.soldLog : []);
          setRestored(true);
        }
      }
    } catch {
      /* ignore corrupted autosave */
    }
  }, []);

  // Autosave whenever the sheet changes.
  useEffect(() => {
    if (rows.length === 0 && title === "") return;
    const payload: SessionFile = {
      app: "vbuild-order-editor",
      version: 1,
      title,
      rows,
      soldLog,
      savedAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* storage full or unavailable - not fatal */
    }
  }, [title, rows, soldLog]);

  /* ------------------------------ history ------------------------------ */

  const snapshot = useCallback(() => {
    setPast((p) => [...p.slice(-49), { rows, soldLog }]);
    setFuture([]);
  }, [rows, soldLog]);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [{ rows, soldLog }, ...f.slice(0, 49)]);
      setRows(prev.rows);
      setSoldLog(prev.soldLog);
      return p.slice(0, -1);
    });
  }, [rows, soldLog]);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setPast((p) => [...p.slice(-49), { rows, soldLog }]);
      setRows(next.rows);
      setSoldLog(next.soldLog);
      return f.slice(1);
    });
  }, [rows, soldLog]);

  // Keyboard: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  /* ------------------------------ loading ------------------------------ */

  const loadPdf = useCallback(async (file: File) => {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/process", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to read the PDF.");
      const parsed = data as ParsedOrder;
      setTitle(parsed.title);
      setRows(
        parsed.items.map((it) => ({
          id: newId(),
          name: it.name,
          qty: it.qty,
          perBag: it.perBag,
          totalOverride: null,
        })),
      );
      setSoldLog([]);
      setPast([]);
      setFuture([]);
      setRestored(false);
      setNotice(
        `Loaded ${parsed.items.length} items (${parsed.totalQty} bags)` +
          (parsed.totalsMatch
            ? " - totals verified against the PDF."
            : " - warning: totals did not match the PDF, please review."),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSession = useCallback(async (file: File) => {
    setError(null);
    setNotice(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text) as SessionFile;
      if (!Array.isArray(data.rows)) {
        throw new Error("That file is not a valid saved session.");
      }
      setTitle(data.title ?? "");
      setRows(
        data.rows.map((r) => ({
          id: r.id || newId(),
          name: String(r.name ?? ""),
          qty: Number(r.qty) || 0,
          perBag: Number(r.perBag) || 0,
          totalOverride:
            r.totalOverride === null || r.totalOverride === undefined
              ? null
              : Number(r.totalOverride),
        })),
      );
      setSoldLog(Array.isArray(data.soldLog) ? data.soldLog : []);
      setPast([]);
      setFuture([]);
      setRestored(false);
      setNotice(`Session restored (${data.rows.length} items).`);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not read that session file.",
      );
    }
  }, []);

  /* ------------------------------ editing ------------------------------ */

  const updateRow = useCallback(
    (id: string, patch: Partial<EditableRow>) => {
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    },
    [],
  );

  const addRow = useCallback(() => {
    snapshot();
    setRows((rs) => [
      ...rs,
      { id: newId(), name: "", qty: 0, perBag: 0, totalOverride: null },
    ]);
  }, [snapshot]);

  const duplicateRow = useCallback(
    (id: string) => {
      snapshot();
      setRows((rs) => {
        const i = rs.findIndex((r) => r.id === id);
        if (i === -1) return rs;
        const copy = { ...rs[i], id: newId() };
        return [...rs.slice(0, i + 1), copy, ...rs.slice(i + 1)];
      });
    },
    [snapshot],
  );

  const deleteRow = useCallback(
    (id: string) => {
      snapshot();
      setRows((rs) => rs.filter((r) => r.id !== id));
    },
    [snapshot],
  );

  /* -------------------------------- sell -------------------------------- */

  const sellRow = rows.find((r) => r.id === sellId) || null;

  const confirmSell = useCallback(() => {
    if (!sellRow) return;
    const bags = Number(sellQty);
    if (!Number.isFinite(bags) || bags <= 0) {
      setError("Enter how many bags were sold.");
      return;
    }
    if (bags > sellRow.qty) {
      setError(
        `Only ${sellRow.qty} bag(s) of "${sellRow.name}" are in stock.`,
      );
      return;
    }
    snapshot();
    const amount = bags * sellRow.perBag;
    setRows((rs) =>
      rs.map((r) =>
        r.id === sellRow.id
          ? { ...r, qty: r.qty - bags, totalOverride: null }
          : r,
      ),
    );
    setSoldLog((log) => [
      ...log,
      {
        id: newId(),
        name: sellRow.name,
        bags,
        perBag: sellRow.perBag,
        amount,
        at: new Date().toISOString(),
      },
    ]);
    setSellId(null);
    setSellQty("");
    setError(null);
    setNotice(
      `Sold ${bags} bag(s) of ${sellRow.name} for ${formatLKR(amount)}.`,
    );
  }, [sellRow, sellQty, snapshot]);

  /* ------------------------------ derived ------------------------------ */

  const totals = useMemo(() => {
    let bags = 0;
    let grand = 0;
    let overrides = 0;
    for (const r of rows) {
      bags += r.qty;
      grand += computeRowTotal(r);
      if (r.totalOverride !== null) overrides += 1;
    }
    return { bags, grand, overrides };
  }, [rows]);

  const session = useMemo(() => {
    let bags = 0;
    let revenue = 0;
    for (const s of soldLog) {
      bags += s.bags;
      revenue += s.amount;
    }
    return { bags, revenue };
  }, [soldLog]);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (hideSoldOut && r.qty === 0) return false;
      if (q && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, hideSoldOut]);

  /* ------------------------------ exports ------------------------------ */

  const downloadPdf = useCallback(
    async (kind: "updated" | "sales") => {
      setBusy(kind);
      setError(null);
      try {
        const today = new Date().toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        });

        let payloadRows: Array<{
          name: string;
          qty: number;
          perBag: number;
          totalOverride: number | null;
        }>;
        let label: string;
        let subtitle: string;

        if (kind === "updated") {
          if (rows.length === 0) throw new Error("Nothing to export.");
          payloadRows = rows.map((r) => ({
            name: r.name,
            qty: r.qty,
            perBag: r.perBag,
            totalOverride: r.totalOverride,
          }));
          label = "Updated";
          subtitle = `Updated ${today}`;
        } else {
          if (soldLog.length === 0) throw new Error("No sales recorded yet.");
          // Aggregate sales by item + price so the receipt is tidy.
          const map = new Map<
            string,
            { name: string; qty: number; perBag: number }
          >();
          for (const s of soldLog) {
            const key = `${s.name}__${s.perBag}`;
            const found = map.get(key);
            if (found) found.qty += s.bags;
            else map.set(key, { name: s.name, qty: s.bags, perBag: s.perBag });
          }
          payloadRows = Array.from(map.values()).map((r) => ({
            ...r,
            totalOverride: null,
          }));
          label = "Sales";
          subtitle = `Sales recorded ${today}`;
        }

        const res = await fetch("/api/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title || "Order",
            label,
            subtitle,
            rows: payloadRows,
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
        a.download = `${title || "Order"} - ${label}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Download failed.");
      } finally {
        setBusy(null);
      }
    },
    [rows, soldLog, title],
  );

  const saveSession = useCallback(() => {
    const payload: SessionFile = {
      app: "vbuild-order-editor",
      version: 1,
      title,
      rows,
      soldLog,
      savedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title || "Order"} - session.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setNotice("Session file saved. Keep it to resume later.");
  }, [title, rows, soldLog]);

  const clearAll = useCallback(() => {
    if (
      !window.confirm(
        "Clear the current sheet? Download the PDF or save the session first if you need it.",
      )
    ) {
      return;
    }
    setTitle("");
    setRows([]);
    setSoldLog([]);
    setPast([]);
    setFuture([]);
    setSearch("");
    setError(null);
    setNotice(null);
    setRestored(false);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    if (pdfInputRef.current) pdfInputRef.current.value = "";
    if (jsonInputRef.current) jsonInputRef.current.value = "";
  }, []);

  /* -------------------------------- view -------------------------------- */

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
          Order Editor
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-gray-500">
          Upload a sheet, edit any value, record bags as they sell, then download
          the updated PDF. Your work is saved in this browser automatically - no
          database needed.
        </p>
      </header>

      {/* hidden inputs */}
      <input
        ref={pdfInputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) loadPdf(f);
        }}
      />
      <input
        ref={jsonInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) loadSession(f);
        }}
      />

      {/* banners */}
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
      {restored && (
        <Banner tone="info" onClose={() => setRestored(false)}>
          Restored your last unsaved sheet from this browser.
        </Banner>
      )}
      {totals.overrides > 0 && (
        <Banner tone="warn">
          {totals.overrides} row
          {totals.overrides === 1 ? " has" : "s have"} a manually typed total, so
          it no longer equals Quantity x Per Bag. Use the reset arrow in the
          Total cell to recalculate.
        </Banner>
      )}

      {/* empty state */}
      {!hasSheet && (
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
            if (f) loadPdf(f);
          }}
          onClick={() => pdfInputRef.current?.click()}
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
                Reading your sheet...
              </p>
            </>
          ) : (
            <>
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 transition-transform group-hover:scale-105">
                <UploadCloud className="h-8 w-8" />
              </div>
              <p className="mt-5 text-lg font-semibold text-gray-800">
                Drop the order PDF here
              </p>
              <p className="mt-1 text-sm text-gray-500">
                or{" "}
                <span className="font-medium text-brand-600">
                  click to browse
                </span>
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  jsonInputRef.current?.click();
                }}
                className="mt-6 inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                <FolderOpen className="h-4 w-4" />
                Resume a saved session
              </button>
            </>
          )}
        </div>
      )}

      {/* editor */}
      {hasSheet && (
        <div className="animate-fade-in space-y-5">
          {/* title + stats */}
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <label
              htmlFor="sheet-title"
              className="text-xs font-medium uppercase tracking-wide text-gray-500"
            >
              Sheet title
            </label>
            <input
              id="sheet-title"
              value={title}
              onFocus={snapshot}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Sri Lanka Order 3 2026"
              className="mt-1 w-full rounded-lg border border-transparent bg-transparent px-0 py-1 text-xl font-bold text-gray-900 outline-none transition focus:border-gray-300 focus:bg-gray-50 focus:px-3"
            />

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Items" value={rows.length.toString()} />
              <Stat label="Bags in stock" value={totals.bags.toString()} />
              <Stat
                label="Sheet value"
                value={formatLKR(totals.grand)}
                highlight
              />
              <Stat
                label="Sold this session"
                value={`${session.bags} bag${session.bags === 1 ? "" : "s"}`}
                sub={session.revenue > 0 ? formatLKR(session.revenue) : undefined}
              />
            </div>
          </div>

          {/* toolbar */}
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
            <div className="relative min-w-[180px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search items..."
                className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </div>

            <ToolButton onClick={addRow} icon={Plus}>
              Add item
            </ToolButton>
            <ToolButton
              onClick={() => setHideSoldOut((v) => !v)}
              icon={hideSoldOut ? Eye : EyeOff}
            >
              {hideSoldOut ? "Show sold out" : "Hide sold out"}
            </ToolButton>
            <ToolButton onClick={undo} icon={Undo2} disabled={past.length === 0}>
              Undo
            </ToolButton>
            <ToolButton
              onClick={redo}
              icon={Redo2}
              disabled={future.length === 0}
            >
              Redo
            </ToolButton>

            <span className="mx-1 hidden h-6 w-px bg-gray-200 sm:block" />

            <ToolButton onClick={() => pdfInputRef.current?.click()} icon={UploadCloud}>
              New PDF
            </ToolButton>
            <ToolButton onClick={saveSession} icon={Save}>
              Save session
            </ToolButton>
            <ToolButton
              onClick={() => jsonInputRef.current?.click()}
              icon={FolderOpen}
            >
              Load session
            </ToolButton>
            <ToolButton onClick={clearAll} icon={Trash2} danger>
              Clear
            </ToolButton>
          </div>

          {/* table */}
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
            <div className="preview-scroll max-h-[540px] overflow-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 z-10 bg-gray-900 text-white">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold">
                      Item Name
                    </th>
                    <th className="w-24 px-2 py-3 text-center font-semibold">
                      Qty
                    </th>
                    <th className="w-36 px-2 py-3 text-right font-semibold">
                      Per Bag
                    </th>
                    <th className="w-44 px-2 py-3 text-right font-semibold">
                      Total
                    </th>
                    <th className="w-32 px-2 py-3 text-center font-semibold">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length === 0 && (
                    <tr>
                      <td
                        colSpan={5}
                        className="px-4 py-10 text-center text-sm text-gray-500"
                      >
                        No items match this view.
                      </td>
                    </tr>
                  )}
                  {visibleRows.map((r) => {
                    const soldOut = r.qty === 0;
                    return (
                      <tr
                        key={r.id}
                        className={cn(
                          "border-b border-gray-100 transition-colors hover:bg-brand-50/40",
                          soldOut && "bg-gray-50 text-gray-400",
                        )}
                      >
                        <td className="px-4 py-2">
                          <input
                            value={r.name}
                            onFocus={snapshot}
                            onChange={(e) =>
                              updateRow(r.id, { name: e.target.value })
                            }
                            placeholder="Item name"
                            className="w-full rounded-md border border-transparent bg-transparent px-2 py-1.5 text-gray-800 outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100"
                          />
                        </td>
                        <td className="px-2 py-2">
                          <NumberCell
                            value={r.qty}
                            onFocus={snapshot}
                            onCommit={(n) => updateRow(r.id, { qty: n })}
                            className="text-center"
                          />
                        </td>
                        <td className="px-2 py-2">
                          <NumberCell
                            value={r.perBag}
                            onFocus={snapshot}
                            onCommit={(n) => updateRow(r.id, { perBag: n })}
                            className="text-right"
                            prefix="Rs"
                          />
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-1">
                            <NumberCell
                              value={computeRowTotal(r)}
                              onFocus={snapshot}
                              onCommit={(n) =>
                                updateRow(r.id, { totalOverride: n })
                              }
                              className={cn(
                                "text-right",
                                r.totalOverride !== null &&
                                  "border-amber-300 bg-amber-50",
                              )}
                              prefix="Rs"
                            />
                            {r.totalOverride !== null && (
                              <button
                                onClick={() => {
                                  snapshot();
                                  updateRow(r.id, { totalOverride: null });
                                }}
                                title="Recalculate from Quantity x Per Bag"
                                className="rounded-md p-1 text-amber-600 transition hover:bg-amber-100"
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center justify-center gap-1">
                            <IconBtn
                              title="Record a sale"
                              onClick={() => {
                                setSellId(r.id);
                                setSellQty("");
                                setError(null);
                              }}
                              disabled={soldOut}
                            >
                              <ShoppingCart className="h-4 w-4" />
                            </IconBtn>
                            <IconBtn
                              title="Duplicate row"
                              onClick={() => duplicateRow(r.id)}
                            >
                              <Copy className="h-4 w-4" />
                            </IconBtn>
                            <IconBtn
                              title="Delete row"
                              onClick={() => deleteRow(r.id)}
                              danger
                            >
                              <Trash2 className="h-4 w-4" />
                            </IconBtn>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="sticky bottom-0 bg-brand-100 font-bold text-gray-900">
                  <tr>
                    <td className="px-4 py-3">
                      Total
                      {visibleRows.length !== rows.length && (
                        <span className="ml-2 text-xs font-normal text-gray-600">
                          (showing {visibleRows.length} of {rows.length})
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-3 text-center">{totals.bags}</td>
                    <td className="px-2 py-3" />
                    <td className="px-2 py-3 text-right">
                      {formatLKR(totals.grand)}
                    </td>
                    <td className="px-2 py-3" />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* sales log */}
          {soldLog.length > 0 && (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5">
              <div className="mb-3 flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                <h2 className="font-semibold text-emerald-900">
                  Sales this session
                </h2>
              </div>
              <ul className="space-y-1.5 text-sm text-emerald-900">
                {soldLog
                  .slice()
                  .reverse()
                  .map((s) => (
                    <li key={s.id} className="flex justify-between gap-4">
                      <span className="truncate">
                        {s.bags} x {s.name || "Unnamed"}
                      </span>
                      <span className="shrink-0 font-medium">
                        {formatLKR(s.amount)}
                      </span>
                    </li>
                  ))}
              </ul>
              <div className="mt-3 flex justify-between border-t border-emerald-200 pt-3 font-bold text-emerald-900">
                <span>
                  {session.bags} bag{session.bags === 1 ? "" : "s"} sold
                </span>
                <span>{formatLKR(session.revenue)}</span>
              </div>
            </div>
          )}

          {/* downloads */}
          <div className="flex flex-wrap justify-end gap-3">
            {soldLog.length > 0 && (
              <button
                onClick={() => downloadPdf("sales")}
                disabled={busy !== null}
                className="inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-white px-5 py-3 text-sm font-semibold text-emerald-700 shadow-sm transition hover:bg-emerald-50 disabled:opacity-60"
              >
                {busy === "sales" ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <FileDown className="h-5 w-5" />
                )}
                Sales Receipt PDF
              </button>
            )}
            <button
              onClick={() => downloadPdf("updated")}
              disabled={busy !== null || rows.length === 0}
              className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-600/25 transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === "updated" ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Download className="h-5 w-5" />
                  Download Updated PDF
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* sell modal */}
      {sellRow && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-gray-900/40 p-4 backdrop-blur-sm sm:items-center"
          onClick={() => setSellId(null)}
        >
          <div
            className="w-full max-w-sm animate-fade-in rounded-2xl bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-gray-900">Record a sale</h3>
            <p className="mt-1 text-sm text-gray-500">
              {sellRow.name || "Unnamed item"} - {sellRow.qty} bag
              {sellRow.qty === 1 ? "" : "s"} in stock at{" "}
              {formatLKR(sellRow.perBag)} each
            </p>

            <label
              htmlFor="sell-qty"
              className="mt-5 block text-sm font-medium text-gray-700"
            >
              Bags sold
            </label>
            <input
              id="sell-qty"
              type="number"
              min={1}
              max={sellRow.qty}
              value={sellQty}
              autoFocus
              onChange={(e) => setSellQty(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmSell();
                if (e.key === "Escape") setSellId(null);
              }}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-lg font-semibold outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />

            {Number(sellQty) > 0 && (
              <p className="mt-3 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800">
                Sale value:{" "}
                <span className="font-bold">
                  {formatLKR(Number(sellQty) * sellRow.perBag)}
                </span>
                <br />
                Remaining:{" "}
                <span className="font-bold">
                  {Math.max(0, sellRow.qty - Number(sellQty))} bag(s)
                </span>
              </p>
            )}

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setSellId(null)}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmSell}
                className="flex-1 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700"
              >
                Confirm sale
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="mt-16 text-center text-xs text-gray-400">
        Built by VBUILD - Prices in LKR - Your sheet is autosaved in this browser
      </footer>
    </main>
  );
}

/* ---------------------------- small components ---------------------------- */

function NumberCell({
  value,
  onCommit,
  onFocus,
  className,
  prefix,
}: {
  value: number;
  onCommit: (n: number) => void;
  onFocus?: () => void;
  className?: string;
  prefix?: string;
}) {
  const [draft, setDraft] = useState(String(value));

  // Re-sync when the value changes from elsewhere (sale, undo, recalculation)
  // but leave the field alone while the user is mid-edit.
  useEffect(() => {
    if (Number(draft) !== value) setDraft(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="relative">
      {prefix && (
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">
          {prefix}
        </span>
      )}
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        onFocus={onFocus}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          if (raw.trim() === "") {
            onCommit(0);
            return;
          }
          const n = Number(raw);
          if (Number.isFinite(n) && n >= 0) onCommit(n);
        }}
        onBlur={() => {
          const n = Number(draft);
          if (!Number.isFinite(n) || n < 0) setDraft(String(value));
          else setDraft(String(n));
        }}
        className={cn(
          "w-full rounded-md border border-transparent bg-transparent py-1.5 pr-2 font-medium text-gray-900 outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100",
          prefix ? "pl-7" : "pl-2",
          className,
        )}
      />
    </div>
  );
}

function ToolButton({
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
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
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
      {sub && <p className="text-xs font-medium text-emerald-600">{sub}</p>}
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
  const Icon = tone === "error" ? AlertTriangle : tone === "warn" ? AlertTriangle : CheckCircle2;
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

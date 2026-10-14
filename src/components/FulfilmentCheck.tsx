"use client";

/**
 * "Can every request be filled?" - the bag count against every request sheet.
 *
 * Upload the count (one file per container, or the Counter's own count) and any
 * number of request sheets this app printed, and it says whether the lot goes
 * round, which items are short and by how much, which buyers that leaves short,
 * and what is left over. The logic lives in lib/fulfilment.ts; this is the page.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  HelpCircle,
  ListPlus,
  Loader2,
  PackageSearch,
  RotateCcw,
  Trash2,
  UploadCloud,
  Warehouse,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { formatLKR, type ParsedOrder } from "@/lib/types";
import type { Restore } from "@/lib/restoreTypes";
import type { BuyerRequest } from "@/lib/buyerRequest";
import { loadCountDoc } from "@/lib/counter";
import {
  addCheckCount,
  addCheckRequests,
  analyseFulfilment,
  createCheckCount,
  createCheckRequest,
  emptyCheck,
  moveCheckRequest,
  removeCheckCount,
  removeCheckRequest,
  type BuyerResult,
  type CheckCount,
  type CheckRequest,
  type FulfilmentCheck as Check,
  type ItemVerdict,
} from "@/lib/fulfilment";

type Slot = "count" | "requests";

interface Props {
  check: Check;
  /** `undo` names the change when it should be undoable. */
  onChange: (next: Check, undo?: string) => void;
  /** The request lists saved on this page, so they can be checked too. */
  savedRequests: BuyerRequest[];
}

const VERDICT: Record<ItemVerdict, { label: string; chip: string }> = {
  enough: { label: "Enough", chip: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  short: { label: "Short", chip: "bg-amber-50 text-amber-800 border-amber-200" },
  none: { label: "None counted", chip: "bg-red-50 text-red-700 border-red-200" },
  unknown: { label: "Not counted", chip: "bg-violet-50 text-violet-700 border-violet-200" },
};

const countBags = (c: CheckCount) => c.rows.reduce((s, r) => s + (r.counted ?? 0), 0);
const requestOutstanding = (r: CheckRequest) =>
  r.items.reduce((s, i) => s + Math.max(0, i.qty - i.supplied), 0);

export default function FulfilmentCheck({ check, onChange, savedRequests }: Props) {
  const [busy, setBusy] = useState<Slot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<"items" | "buyers" | "spare">("items");
  const [problemsOnly, setProblemsOnly] = useState(true);
  const [dragOver, setDragOver] = useState<Slot | null>(null);
  const countRef = useRef<HTMLInputElement>(null);
  const reqRef = useRef<HTMLInputElement>(null);

  const result = useMemo(() => analyseFulfilment(check), [check]);
  const checkRef = useRef(check);
  checkRef.current = check;
  const { totals } = result;

  /* -------------------------------- uploads ------------------------------- */

  /**
   * Read every file and put each where it belongs. A count dropped on the
   * request side (or the other way round) is recognised and filed correctly
   * rather than refused, since the file says what it is.
   */
  const ingest = useCallback(
    async (files: File[], slot: Slot) => {
      if (files.length === 0) return;
      setBusy(slot);
      setError(null);
      setNotice(null);
      const messages: string[] = [];
      const problems: string[] = [];

      // Read everything first, then apply it to the check as it stands now:
      // a second upload finishing while the first was reading must not
      // overwrite it.
      const replies = await Promise.all(
        files.map(async (file) => {
          try {
            const fd = new FormData();
            fd.append("file", file);
            const res = await fetch("/api/process", { method: "POST", body: fd });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Could not read that file.");
            return { file, data: data as ParsedOrder & { restore?: Restore } };
          } catch (e) {
            return { file, error: e instanceof Error ? e.message : "could not be read" };
          }
        }),
      );

      let next = checkRef.current;
      for (const reply of replies) {
        const { file } = reply;
        const stem = file.name.replace(/\.[^.]+$/, "");
        try {
          if (!("data" in reply) || !reply.data) throw new Error(reply.error);
          const data = reply.data;
          const parsed = data;
          const restore = (data as { restore?: Restore }).restore;

          if (restore?.kind === "requests") {
            const incoming = restore.requests.map((r) =>
              createCheckRequest({
                buyerName: r.buyerName,
                buyerPhone: r.buyerPhone,
                from: file.name,
                items: r.items,
              }),
            );
            const out = addCheckRequests(next, incoming);
            if (out.added + out.replaced === 0) throw new Error("no requested items in it");
            next = out.check;
            messages.push(
              `${file.name}: ${incoming.length} request sheet${incoming.length === 1 ? "" : "s"}` +
                (out.replaced > 0 ? ` (${out.replaced} replaced an older copy)` : "") +
                (slot === "count" ? " - that is a request sheet, so it went under requests" : ""),
            );
            continue;
          }

          if (restore?.kind === "count" || slot === "count") {
            const rows =
              restore?.kind === "count"
                ? restore.rows
                : parsed.items.map((i) => ({ name: i.name, counted: i.qty }));
            const count = createCheckCount(
              stem,
              restore?.kind === "count" ? restore.containerId : "",
              rows,
            );
            if (count.rows.length === 0) throw new Error("no items in it");
            next = addCheckCount(next, count);
            const uncounted = count.rows.filter((r) => r.counted === null).length;
            messages.push(
              `${file.name}: ${countBags(count)} bags counted over ${count.rows.length} items` +
                (uncounted > 0 ? `, ${uncounted} not counted yet` : "") +
                (restore?.kind !== "count" ? " (not a Counter file, so its quantities were read as the count)" : "") +
                (slot === "requests" && restore?.kind === "count" ? " - that is a bag count, so it went under counts" : ""),
            );
            continue;
          }

          // A plain buyer list or order sheet on the request side: one buyer,
          // named after the file.
          const request = createCheckRequest({
            buyerName: stem,
            from: file.name,
            items: parsed.items.map((i) => ({ name: i.name, qty: i.qty, perBag: i.perBag })),
          });
          const out = addCheckRequests(next, [request]);
          if (out.added + out.replaced === 0) throw new Error("no requested items in it");
          next = out.check;
          messages.push(
            `${file.name}: read as one request (${requestOutstanding(request)} bags) - it is not a request sheet from MDN ERP, so check the buyer name`,
          );
        } catch (e) {
          problems.push(`${file.name}: ${e instanceof Error ? e.message : "could not be read"}`);
        }
      }

      if (next !== checkRef.current) onChange(next);
      if (problems.length > 0) setError(problems.join(" · "));
      if (messages.length > 0) setNotice(messages.join(" · "));
      setBusy(null);
      if (countRef.current) countRef.current.value = "";
      if (reqRef.current) reqRef.current.value = "";
    },
    [onChange],
  );

  const takeCounter = useCallback(() => {
    setError(null);
    const doc = loadCountDoc();
    if (doc.rows.length === 0) {
      setError("There is no count on the Counter page yet.");
      return;
    }
    const label =
      [doc.orderNumber, doc.containerId].filter((p) => p.trim() !== "").join(" - ") ||
      "Counter";
    const count = createCheckCount(
      `${label} (Counter)`,
      doc.containerId,
      doc.rows.map((r) => ({ name: r.name, counted: r.touched ? r.counted : null })),
    );
    onChange(addCheckCount(check, count));
    const uncounted = count.rows.filter((r) => r.counted === null).length;
    setNotice(
      `Took the count from the Counter: ${countBags(count)} bags over ${count.rows.length} items` +
        (uncounted > 0 ? `, ${uncounted} not counted yet.` : "."),
    );
  }, [check, onChange]);

  const addSaved = useCallback(() => {
    setError(null);
    const incoming = savedRequests
      .filter((r) => r.items.length > 0)
      .map((r) =>
        createCheckRequest({
          buyerName: r.buyer.name.trim() || "Unnamed buyer",
          buyerPhone: r.buyer.phone,
          from: "Saved on this page",
          items: r.items,
        }),
      );
    if (incoming.length === 0) {
      setError("No request list on this page has any items yet.");
      return;
    }
    const out = addCheckRequests(check, incoming);
    onChange(out.check);
    setNotice(
      `Added ${out.added} saved list${out.added === 1 ? "" : "s"}` +
        (out.replaced > 0 ? `, updated ${out.replaced} already here` : "") +
        ".",
    );
  }, [check, onChange, savedRequests]);

  const dropZone = (slot: Slot) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(slot);
    },
    onDragLeave: () => setDragOver(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      ingest(Array.from(e.dataTransfer.files), slot);
    },
  });

  const hasAnything = check.counts.length > 0 || check.requests.length > 0;

  /* --------------------------------- view --------------------------------- */

  const itemRows = problemsOnly
    ? result.items.filter((i) => i.verdict !== "enough")
    : result.items;

  return (
    <section
      id="fulfilment"
      className="mt-10 scroll-mt-24 rounded-2xl border border-gray-200 bg-white shadow-sm"
    >
      <input
        ref={countRef}
        type="file"
        multiple
        accept=".pdf,.csv,.xlsx,application/pdf,text/csv"
        className="hidden"
        onChange={(e) => ingest(Array.from(e.target.files ?? []), "count")}
      />
      <input
        ref={reqRef}
        type="file"
        multiple
        accept=".pdf,.csv,.xlsx,application/pdf,text/csv"
        className="hidden"
        onChange={(e) => ingest(Array.from(e.target.files ?? []), "requests")}
      />

      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
            <ClipboardCheck className="h-5 w-5 text-brand-600" />
            Can every request be filled?
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-500">
            Upload the bag count and every request sheet. All the requests are put
            against the count together, so two buyers wanting the same item cannot
            both be promised the same bags. Nothing here changes the stockpile, the
            lists above or the count.
          </p>
        </div>
        {hasAnything && (
          <button
            onClick={() => onChange(emptyCheck(), "Fulfilment check cleared")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50"
          >
            <RotateCcw className="h-4 w-4" />
            Start over
          </button>
        )}
      </div>

      <div className="px-5 py-4">
        {error && <Note tone="error" onClose={() => setError(null)}>{error}</Note>}
        {notice && <Note tone="info" onClose={() => setNotice(null)}>{notice}</Note>}

        {/* The two inputs */}
        <div className="grid gap-4 md:grid-cols-2">
          {/* Counts */}
          <div
            {...dropZone("count")}
            className={cn(
              "rounded-xl border-2 border-dashed p-4 transition",
              dragOver === "count" ? "border-brand-400 bg-brand-50/50" : "border-gray-200",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-gray-800">
                <Warehouse className="h-4 w-4 text-brand-600" />
                1. Bag count
              </p>
              <span className="text-xs text-gray-400">
                {check.counts.length > 0
                  ? `${totals.counted} bags`
                  : "xlsx or pdf from the Counter"}
              </span>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Several files add up - one per container, say.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <SlotButton
                onClick={() => countRef.current?.click()}
                busy={busy === "count"}
                icon={<UploadCloud className="h-4 w-4" />}
                primary
              >
                Upload count
              </SlotButton>
              <SlotButton onClick={takeCounter} icon={<PackageSearch className="h-4 w-4" />}>
                Use the Counter&apos;s count
              </SlotButton>
            </div>
            {check.counts.length > 0 && (
              <ul className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-100">
                {check.counts.map((c) => {
                  const uncounted = c.rows.filter((r) => r.counted === null).length;
                  return (
                    <li key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <FileText className="h-4 w-4 shrink-0 text-gray-400" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-gray-800">{c.name}</span>
                        <span className="block text-xs text-gray-500">
                          {countBags(c)} bags · {c.rows.length} items
                          {uncounted > 0 && (
                            <span className="text-violet-700"> · {uncounted} not counted</span>
                          )}
                        </span>
                      </span>
                      <RemoveBtn
                        title="Remove this count"
                        onClick={() =>
                          onChange(removeCheckCount(check, c.id), `${c.name} removed from the check`)
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Request sheets */}
          <div
            {...dropZone("requests")}
            className={cn(
              "rounded-xl border-2 border-dashed p-4 transition",
              dragOver === "requests" ? "border-brand-400 bg-brand-50/50" : "border-gray-200",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-gray-800">
                <ListPlus className="h-4 w-4 text-brand-600" />
                2. Request sheets
              </p>
              <span className="text-xs text-gray-400">
                {check.requests.length > 0
                  ? `${check.requests.length} buyer${check.requests.length === 1 ? "" : "s"}`
                  : "pdf or csv from this page"}
              </span>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Select or drop as many PDF/CSV sheets as you like in one go. When an item is short, the top sheet is served
              first - use the arrows to change the order.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <SlotButton
                onClick={() => reqRef.current?.click()}
                busy={busy === "requests"}
                icon={<UploadCloud className="h-4 w-4" />}
                primary
              >
                Upload sheets (several at once)
              </SlotButton>
              {savedRequests.length > 0 && (
                <SlotButton onClick={addSaved} icon={<ListPlus className="h-4 w-4" />}>
                  Add the {savedRequests.length} list{savedRequests.length === 1 ? "" : "s"} saved here
                </SlotButton>
              )}
            </div>
            {check.requests.length > 0 && (
              <ul className="mt-3 max-h-64 divide-y divide-gray-100 overflow-auto rounded-lg border border-gray-100">
                {check.requests.map((r, i) => (
                  <li key={r.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="w-5 shrink-0 text-center text-xs font-semibold text-gray-400">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-gray-800">{r.buyerName}</span>
                      <span className="block truncate text-xs text-gray-500">
                        {requestOutstanding(r)} bags to go · {r.items.length} items
                        {r.from ? ` · ${r.from}` : ""}
                      </span>
                    </span>
                    <button
                      title="Serve earlier"
                      disabled={i === 0}
                      onClick={() => onChange(moveCheckRequest(check, r.id, -1))}
                      className="rounded-md p-1 text-gray-500 transition hover:bg-gray-100 disabled:opacity-25"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button
                      title="Serve later"
                      disabled={i === check.requests.length - 1}
                      onClick={() => onChange(moveCheckRequest(check, r.id, 1))}
                      className="rounded-md p-1 text-gray-500 transition hover:bg-gray-100 disabled:opacity-25"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </button>
                    <RemoveBtn
                      title="Remove this sheet"
                      onClick={() =>
                        onChange(
                          removeCheckRequest(check, r.id),
                          `${r.buyerName} removed from the check`,
                        )
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* The answer */}
        {!result.ready ? (
          <p className="mt-5 rounded-xl bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
            {check.counts.length === 0 && check.requests.length === 0
              ? "Add a bag count and at least one request sheet to see whether they can all be filled."
              : check.counts.length === 0
                ? "Now add the bag count."
                : check.requests.length === 0
                  ? "Now add the request sheets."
                  : "Every bag on these sheets has already been supplied - there is nothing left to check."}
          </p>
        ) : (
          <>
            <Verdict result={result} />

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label="Bags wanted" value={String(totals.wanted)} />
              <Stat label="Bags counted" value={String(totals.counted)} />
              <Stat label="Can be filled" value={String(totals.coverable)} tone="good" />
              <Stat
                label="Lacking"
                value={String(totals.short)}
                tone={totals.short > 0 ? "bad" : "good"}
              />
              <Stat label="Left over" value={String(totals.spare)} />
            </div>

            {/* Tabs */}
            <div className="mt-5 flex flex-wrap items-center gap-2 border-b border-gray-100">
              <Tab active={view === "items"} onClick={() => setView("items")}>
                By item
                {totals.itemsShort + totals.itemsUnknown > 0 &&
                  ` (${totals.itemsShort + totals.itemsUnknown} to look at)`}
              </Tab>
              <Tab active={view === "buyers"} onClick={() => setView("buyers")}>
                By buyer ({totals.buyersFull}/{totals.sheets} in full)
              </Tab>
              <Tab active={view === "spare"} onClick={() => setView("spare")}>
                Left over ({result.spare.length})
              </Tab>
              {view === "items" && (
                <label className="ml-auto flex items-center gap-2 pb-2 text-xs text-gray-600">
                  <input
                    type="checkbox"
                    checked={problemsOnly}
                    onChange={(e) => setProblemsOnly(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-brand-600"
                  />
                  Only what is lacking
                </label>
              )}
            </div>

            {view === "items" && (
              <div className="preview-scroll mt-3 max-h-[520px] overflow-auto rounded-xl border border-gray-200">
                <table className="w-full border-collapse text-sm">
                  <thead className="sticky top-0 z-10 bg-gray-900 text-white">
                    <tr>
                      <th className="px-3 py-2.5 text-left font-semibold">Item</th>
                      <th className="w-20 px-2 py-2.5 text-center font-semibold">Wanted</th>
                      <th className="w-20 px-2 py-2.5 text-center font-semibold">Counted</th>
                      <th className="w-20 px-2 py-2.5 text-center font-semibold">Lacking</th>
                      <th className="w-28 px-2 py-2.5 text-center font-semibold">Status</th>
                      <th className="px-3 py-2.5 text-left font-semibold">Who wants it (gets / wants)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {itemRows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-sm text-emerald-700">
                          Nothing is lacking - every item wanted is on the count.
                        </td>
                      </tr>
                    )}
                    {itemRows.map((item, idx) => (
                      <tr
                        key={item.key}
                        className={cn("border-b border-gray-100 align-top", idx % 2 === 1 && "bg-gray-50/60")}
                      >
                        <td className="px-3 py-2 font-medium text-gray-800">
                          {item.name}
                          {item.countState === "missing" && (
                            <span className="block text-xs font-normal text-red-600">Not on the count at all</span>
                          )}
                          {item.verdict === "unknown" && (
                            <span className="block text-xs font-normal text-violet-700">
                              On the count but not counted
                              {item.countState === "counted" ? " in every file" : ""} - finish the count to be sure
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-center">{item.wanted}</td>
                        <td className="px-2 py-2 text-center">
                          {item.countState === "counted" ? item.counted : "-"}
                        </td>
                        <td
                          className={cn(
                            "px-2 py-2 text-center font-semibold",
                            item.short > 0 ? "text-red-700" : "text-gray-400",
                          )}
                        >
                          {item.short > 0 ? item.short : "-"}
                        </td>
                        <td className="px-2 py-2 text-center">
                          <span className={cn("whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", VERDICT[item.verdict].chip)}>
                            {VERDICT[item.verdict].label}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-600">
                          {item.demand.map((d) => (
                            <span
                              key={d.requestId}
                              className={cn(
                                "mr-1.5 mb-1 inline-block rounded-md px-1.5 py-0.5",
                                d.allocated < d.wanted ? "bg-red-50 text-red-700" : "bg-gray-100 text-gray-700",
                              )}
                            >
                              {d.buyerName} {d.allocated}/{d.wanted}
                            </span>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {view === "buyers" && (
              <div className="mt-3 space-y-3">
                {result.buyers.map((b) => (
                  <BuyerCard key={b.request.id} buyer={b} />
                ))}
              </div>
            )}

            {view === "spare" && (
              <div className="preview-scroll mt-3 max-h-[420px] overflow-auto rounded-xl border border-gray-200">
                {result.spare.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-gray-500">
                    Nothing is left over - every counted bag is wanted.
                  </p>
                ) : (
                  <table className="w-full border-collapse text-sm">
                    <thead className="sticky top-0 bg-gray-900 text-white">
                      <tr>
                        <th className="px-3 py-2.5 text-left font-semibold">Item</th>
                        <th className="w-28 px-2 py-2.5 text-center font-semibold">Wanted</th>
                        <th className="w-28 px-2 py-2.5 text-center font-semibold">Left over</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.spare.map((s, idx) => (
                        <tr key={s.key} className={cn("border-b border-gray-100", idx % 2 === 1 && "bg-gray-50/60")}>
                          <td className="px-3 py-2 font-medium text-gray-800">
                            {s.name}
                            {s.wanted === 0 && (
                              <span className="ml-2 text-xs font-normal text-gray-400">nobody asked</span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-center text-gray-600">{s.wanted}</td>
                          <td className="px-2 py-2 text-center font-semibold text-gray-900">{s.spare}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/* ---------------------------- small components ---------------------------- */

function Verdict({ result }: { result: ReturnType<typeof analyseFulfilment> }) {
  const { totals } = result;
  if (result.allFulfilled) {
    return (
      <div className="mt-5 flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-800">
        <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0" />
        <div>
          <p className="font-semibold">
            Yes - all {totals.sheets} request{totals.sheets === 1 ? "" : "s"} can be filled in full.
          </p>
          <p className="text-sm">
            {totals.wanted} bags wanted, {totals.counted} counted
            {totals.spare > 0 ? `, ${totals.spare} left over afterwards.` : ", nothing left over."}
          </p>
        </div>
      </div>
    );
  }
  if (totals.short === 0) {
    // Nothing short on the figures, but something wanted was never counted.
    return (
      <div className="mt-5 flex items-start gap-3 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-violet-800">
        <HelpCircle className="mt-0.5 h-6 w-6 shrink-0" />
        <p className="text-sm">
          <span className="font-semibold">Cannot say yet.</span> {totals.itemsUnknown} wanted item
          {totals.itemsUnknown === 1 ? " is" : "s are"} on the count but not counted. Finish counting{" "}
          {totals.itemsUnknown === 1 ? "it" : "them"} and upload the count again.
        </p>
      </div>
    );
  }
  return (
    <div className="mt-5 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-800">
      <XCircle className="mt-0.5 h-6 w-6 shrink-0" />
      <div>
        <p className="font-semibold">
          No - {totals.short} bag{totals.short === 1 ? " is" : "s are"} lacking across{" "}
          {totals.itemsShort + totals.itemsUnknown} item{totals.itemsShort + totals.itemsUnknown === 1 ? "" : "s"}.
        </p>
        <p className="text-sm">
          {totals.buyersFull} of {totals.sheets} buyer{totals.sheets === 1 ? "" : "s"} can be filled in full;{" "}
          {totals.buyersShort} would be short.
          {totals.shortValue > 0 && ` What cannot be supplied is worth ${formatLKR(totals.shortValue)} at the sheets' prices.`}
          {totals.itemsUnknown > 0 &&
            ` ${totals.itemsUnknown === 1 ? "One of those items is" : `${totals.itemsUnknown} of those items are`} not fully counted, so the gap may be smaller.`}
        </p>
      </div>
    </div>
  );
}

function BuyerCard({ buyer }: { buyer: BuyerResult }) {
  const short = buyer.lines.filter((l) => l.short > 0);
  const tone =
    buyer.verdict === "full" || buyer.verdict === "nothing-outstanding"
      ? "border-emerald-200 bg-emerald-50/40"
      : buyer.verdict === "part"
        ? "border-amber-200 bg-amber-50/40"
        : "border-red-200 bg-red-50/40";
  return (
    <div className={cn("rounded-xl border p-4", tone)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-gray-900">
          <span className="mr-2 text-xs font-semibold text-gray-400">#{buyer.position}</span>
          {buyer.request.buyerName}
          {buyer.request.buyerPhone && (
            <span className="ml-2 text-xs font-normal text-gray-500">{buyer.request.buyerPhone}</span>
          )}
        </p>
        <p className="text-sm text-gray-700">
          {buyer.verdict === "nothing-outstanding" ? (
            "Everything already supplied"
          ) : buyer.verdict === "full" ? (
            <span className="font-semibold text-emerald-700">Can be filled in full · {buyer.wanted} bags</span>
          ) : (
            <span className="font-semibold text-red-700">
              Gets {buyer.allocated} of {buyer.wanted} bags · {buyer.short} lacking
              {buyer.shortValue > 0 && ` (${formatLKR(buyer.shortValue)})`}
            </span>
          )}
        </p>
      </div>
      {short.length > 0 && (
        <>
          {buyer.aloneOk && (
            <p className="mt-1 text-xs text-amber-800">
              The count would cover this sheet on its own - it falls short only because sheets above it take the bags first.
            </p>
          )}
          <ul className="mt-2 flex flex-wrap gap-1.5 text-xs">
            {short.map((l) => (
              <li
                key={l.key}
                className={cn(
                  "rounded-md border px-2 py-1",
                  l.verdict === "unknown" ? VERDICT.unknown.chip : "border-red-200 bg-white text-red-700",
                )}
                title={l.lostToQueue ? "Enough on the count for this buyer alone; taken by sheets above" : undefined}
              >
                <span className="font-medium">{l.name}</span>: gets {l.allocated} of {l.wanted}
                {l.lostToQueue && " · taken by sheets above"}
                {l.verdict === "unknown" && " · not counted"}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SlotButton({
  children,
  onClick,
  icon,
  busy,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  icon: React.ReactNode;
  busy?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition disabled:opacity-60",
        primary
          ? "bg-brand-600 text-white hover:bg-brand-700"
          : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
      )}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

function RemoveBtn({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button onClick={onClick} title={title} className="rounded-md p-1 text-red-500 transition hover:bg-red-50">
      <Trash2 className="h-4 w-4" />
    </button>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "-mb-px border-b-2 px-3 pb-2 text-sm font-medium transition",
        active ? "border-brand-600 text-brand-700" : "border-transparent text-gray-500 hover:text-gray-800",
      )}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div
      className={cn(
        "rounded-xl border p-3",
        tone === "bad"
          ? "border-red-200 bg-red-50"
          : tone === "good"
            ? "border-emerald-200 bg-emerald-50"
            : "border-gray-200 bg-gray-50",
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-base font-bold",
          tone === "bad" ? "text-red-800" : tone === "good" ? "text-emerald-800" : "text-gray-900",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function Note({ tone, children, onClose }: { tone: "error" | "info"; children: React.ReactNode; onClose: () => void }) {
  const Icon = tone === "error" ? AlertTriangle : CheckCircle2;
  return (
    <div
      className={cn(
        "mb-4 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm",
        tone === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-brand-200 bg-brand-50 text-brand-800",
      )}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" />
      <span className="flex-1">{children}</span>
      <button onClick={onClose} className="rounded-md p-0.5 hover:bg-black/5" aria-label="Dismiss">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

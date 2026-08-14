"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Database,
  Download,
  Loader2,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import {
  backupStoredData,
  clearStoredData,
  DATA_SECTIONS,
  IDENTITY_LABEL,
  inspectStoredData,
  parseBackupText,
  restoreStoredData,
  type StoredDataReport,
} from "@/lib/appData";
import { cn } from "@/lib/cn";

/**
 * Saved data: what this browser is holding, and how to get rid of it.
 *
 * A page rather than a dialog because the choosing matters. Every section is
 * listed with what is actually in it, when it was last written and the key it
 * lives under, so deleting is a decision made from facts rather than from a
 * warning shouted over the top of whatever you were doing.
 *
 * The order on the page is deliberate: back up, then choose, then delete.
 */
export default function DataPage() {
  const [report, setReport] = useState<StoredDataReport | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [includeIdentity, setIncludeIdentity] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [backedUp, setBackedUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<{
    file: unknown;
    name: string;
    keys: number;
  } | null>(null);

  const refresh = useCallback(() => {
    const next = inspectStoredData();
    setReport(next);
    setChosen(next.sections.filter((s) => s.present).map((s) => s.id));
    setConfirming(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggle = (id: string) => {
    setConfirming(false);
    setChosen((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const selectable = report?.sections.filter((s) => s.present) ?? [];
  const allChosen =
    selectable.length > 0 && selectable.every((s) => chosen.includes(s.id));

  const download = useCallback(() => {
    const backup = backupStoredData();
    if (Object.keys(backup.data).length === 0) {
      setError("There is nothing saved to back up.");
      return;
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `BaleBook backup ${new Date()
      .toISOString()
      .slice(0, 16)
      .replace("T", " ")
      .replace(":", "")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setBackedUp(true);
    setError(null);
    setNotice(
      `Backup downloaded - ${Object.keys(backup.data).length} items, everything this browser is holding.`,
    );
  }, []);

  /** Read a backup, but do not write anything until it is confirmed. */
  const readBackup = useCallback(async (file: File) => {
    setError(null);
    setNotice(null);
    try {
      const parsed = parseBackupText(await file.text());
      const probe = parsed as { app?: string; data?: Record<string, string> };
      if (!parsed || probe.app !== "balebook-backup") {
        throw new Error(
          "That is not a BaleBook backup. Use a file downloaded from this page.",
        );
      }
      const keys = Object.keys(probe.data ?? {}).length;
      if (keys === 0) throw new Error("That backup is empty.");
      setPendingRestore({ file: parsed, name: file.name, keys });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "That file could not be read.",
      );
    }
  }, []);

  const confirmRestore = useCallback(() => {
    if (!pendingRestore) return;
    setRestoring(true);
    const result = restoreStoredData(pendingRestore.file);
    if (result.problem) {
      setRestoring(false);
      setPendingRestore(null);
      setError(result.problem);
      return;
    }
    // Reload so every page picks the restored data up cleanly.
    window.location.reload();
  }, [pendingRestore]);

  const clear = useCallback(() => {
    setWorking(true);
    clearStoredData({ sectionIds: chosen, includeIdentity });
    // Reload rather than resetting state by hand: every page keeps its data in
    // memory and autosaves, so one left open would write it all straight back.
    window.location.reload();
  }, [chosen, includeIdentity]);

  const kb = (bytes: number) =>
    bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} kB`;
  const when = (iso: string | null) => {
    if (!iso) return null;
    const then = new Date(iso);
    const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
    if (days <= 0) return "saved today";
    if (days === 1) return "saved yesterday";
    if (days < 30) return `saved ${days} days ago`;
    return `saved ${then.toISOString().slice(0, 10)}`;
  };

  const count = chosen.length + (includeIdentity ? 1 : 0);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-gray-900">
          <Database className="h-6 w-6 text-brand-600" />
          Saved data
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          Everything BaleBook remembers is stored in this browser, and nowhere
          else. Choose what to delete, and take a backup first if you might want
          it back.
        </p>
      </header>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {notice && !error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {report?.empty ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-10 text-center">
          <Database className="mx-auto h-8 w-8 text-gray-300" />
          <p className="mt-3 font-medium text-gray-900">
            Nothing is saved in this browser yet
          </p>
          <p className="mt-1 text-sm text-gray-500">
            Add an order, a request or an expense and it will show up here.
          </p>
          <div className="mt-4">
            <label className="cursor-pointer text-sm font-medium text-brand-700 hover:underline">
              Restore from a backup file
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) readBackup(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>
      ) : (
        <>
          {/* ------------------------------ backup ------------------------------ */}
          <section className="mb-5 rounded-2xl border border-gray-200 bg-white shadow-sm">
            <div className="border-b border-gray-100 px-5 py-4">
              <h2 className="font-semibold text-gray-900">Backup</h2>
              <p className="mt-0.5 text-xs text-gray-500">
                One file holding everything, exactly as stored. Keep it somewhere
                other than this computer.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 px-5 py-4">
              <button
                onClick={download}
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition",
                  backedUp
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : "border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100",
                )}
              >
                <Download className="h-4 w-4" />
                {backedUp ? "Backup downloaded" : "Download a backup"}
              </button>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50">
                <RotateCcw className="h-4 w-4" />
                Restore from a file
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) readBackup(f);
                    e.target.value = "";
                  }}
                />
              </label>
              <span className="ml-auto self-center text-xs text-gray-400">
                {kb(report?.totalBytes ?? 0)} stored in total
              </span>
            </div>

            {pendingRestore && (
              <div className="animate-fade-in border-t border-amber-200 bg-amber-50/60 px-5 py-4">
                <p className="text-sm font-semibold text-gray-900">
                  Restore {pendingRestore.keys} item
                  {pendingRestore.keys === 1 ? "" : "s"} from{" "}
                  {pendingRestore.name}?
                </p>
                <p className="mt-1 text-xs text-gray-600">
                  This replaces what is in the browser now for each section the
                  file covers. Anything you have added since that backup was taken
                  will be lost.
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => setPendingRestore(null)}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmRestore}
                    disabled={restoring}
                    className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-700 disabled:opacity-60"
                  >
                    {restoring && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {restoring ? "Restoring..." : "Yes, restore it"}
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* ------------------------------ choose ------------------------------ */}
          <section className="mb-5 rounded-2xl border border-gray-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <div>
                <h2 className="font-semibold text-gray-900">
                  Choose what to delete
                </h2>
                <p className="mt-0.5 text-xs text-gray-500">
                  Only sections that have something saved can be selected.
                </p>
              </div>
              <button
                onClick={() => {
                  setConfirming(false);
                  setChosen(allChosen ? [] : selectable.map((s) => s.id));
                }}
                className="shrink-0 text-xs font-medium text-brand-700 hover:underline"
              >
                {allChosen ? "Select none" : "Select all"}
              </button>
            </div>

            <ul className="divide-y divide-gray-100">
              {report?.sections.map((section) => (
                <li key={section.id}>
                  <label
                    className={cn(
                      "flex items-start gap-3 px-5 py-3 transition",
                      section.present
                        ? "cursor-pointer hover:bg-gray-50"
                        : "opacity-45",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={chosen.includes(section.id)}
                      onChange={() => toggle(section.id)}
                      disabled={!section.present}
                      className="mt-1 h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-gray-900">
                          {section.label}
                        </span>
                        {section.page.startsWith("/") && (
                          <Link
                            href={section.page}
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-0.5 text-xs text-gray-400 hover:text-brand-600"
                          >
                            {section.page}
                            <ArrowUpRight className="h-3 w-3" />
                          </Link>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-gray-600">
                        {section.detail}
                        {when(section.savedAt) && (
                          <span className="text-gray-400">
                            {" "}
                            &middot; {when(section.savedAt)}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="shrink-0 pt-0.5 text-xs tabular-nums text-gray-400">
                      {section.bytes > 0 ? kb(section.bytes) : ""}
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            {report?.identity.present && (
              <div className="border-t border-gray-100 bg-amber-50/50 px-5 py-4">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={includeIdentity}
                    onChange={() => {
                      setIncludeIdentity((v) => !v);
                      setConfirming(false);
                    }}
                    className="mt-1 h-4 w-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                  />
                  <span>
                    <span className="block text-sm font-medium text-gray-900">
                      {IDENTITY_LABEL}
                    </span>
                    <span className="mt-0.5 block text-xs text-gray-600">
                      {report.identity.detail}. This is not working data — it is
                      what stops a reference number ever being issued twice, so it
                      is left alone unless you ask. Tick it only to treat this
                      browser as a brand new device.
                    </span>
                  </span>
                </label>
              </div>
            )}

            {report && report.leftovers.length > 0 && (
              <div className="border-t border-gray-100 px-5 py-3">
                <details>
                  <summary className="cursor-pointer text-xs font-medium text-gray-600">
                    {report.leftovers.length} leftover item
                    {report.leftovers.length === 1 ? "" : "s"} from an older
                    version
                  </summary>
                  <ul className="mt-2 space-y-0.5 text-xs text-gray-500">
                    {report.leftovers.map((key) => (
                      <li key={key} className="font-mono">
                        {key}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-gray-400">
                    Swept up when every section is selected.
                  </p>
                </details>
              </div>
            )}
          </section>

          {/* ------------------------------ delete ------------------------------ */}
          <section className="rounded-2xl border border-red-200 bg-white shadow-sm">
            <div className="border-b border-red-100 px-5 py-4">
              <h2 className="font-semibold text-gray-900">Delete</h2>
              <p className="mt-0.5 text-xs text-gray-500">
                This cannot be undone. Only a backup file can bring it back.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 px-5 py-4">
              {confirming ? (
                <>
                  <button
                    onClick={clear}
                    disabled={working}
                    className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-red-700 disabled:opacity-60"
                  >
                    {working ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    {working ? "Deleting..." : "Yes, delete it permanently"}
                  </button>
                  <button
                    onClick={() => setConfirming(false)}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirming(true)}
                  disabled={count === 0}
                  className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-red-700 disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" />
                  {count === 0
                    ? "Nothing selected"
                    : allChosen && includeIdentity
                      ? "Delete everything"
                      : `Delete ${count} selected`}
                </button>
              )}
              {!backedUp && count > 0 && (
                <span className="flex items-center gap-1.5 text-xs text-amber-700">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  No backup taken yet
                </span>
              )}
            </div>
          </section>

          <p className="mt-4 text-center text-xs text-gray-400">
            Clearing your browser&apos;s site data by hand does the same thing,
            but takes reference numbering with it.
          </p>
        </>
      )}
    </main>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Download, Loader2, Trash2, X } from "lucide-react";
import {
  backupStoredData,
  clearStoredData,
  DATA_SECTIONS,
  IDENTITY_LABEL,
  inspectStoredData,
  type StoredDataReport,
} from "@/lib/appData";
import { cn } from "@/lib/cn";

/**
 * Clearing the data this app keeps in the browser.
 *
 * Three things this deliberately does, because the action cannot be undone:
 *
 *   Says what will go, per section, with counts read out of the store rather
 *   than guessed, so an empty section is not confused with a full one.
 *
 *   Offers a backup first, in the same dialog. An accounting tool should not make
 *   losing a year of expenses a one-click affair.
 *
 *   Reloads the page afterwards. Every page keeps its data in React state and
 *   autosaves it, so a page left open would write everything straight back and
 *   the clear would appear not to have worked.
 */
export default function ClearDataButton() {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<StoredDataReport | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [includeIdentity, setIncludeIdentity] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [backedUp, setBackedUp] = useState(false);

  // Read the store each time the dialog opens, never once on mount: another tab
  // may have changed things, and stale counts on a destructive screen are worse
  // than no counts.
  const refresh = useCallback(() => {
    const next = inspectStoredData();
    setReport(next);
    setChosen(next.sections.filter((s) => s.present).map((s) => s.id));
    setIncludeIdentity(false);
    setConfirming(false);
    setBackedUp(false);
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const download = useCallback(() => {
    const backup = backupStoredData();
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
  }, []);

  const clear = useCallback(() => {
    setWorking(true);
    clearStoredData({ sectionIds: chosen, includeIdentity });
    // Reload rather than resetting state by hand: it is the only way to be sure
    // no page is still holding data that it will autosave back.
    window.location.reload();
  }, [chosen, includeIdentity]);

  const toggle = (id: string) =>
    setChosen((prev) => {
      setConfirming(false);
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    });

  const nothingChosen = chosen.length === 0 && !includeIdentity;
  const kb = (bytes: number) =>
    bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} kB`;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Clear the data saved in this browser"
        aria-label="Clear saved data"
        className="ml-1 inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-500 transition hover:bg-red-50 hover:text-red-700"
      >
        <Trash2 className="h-4 w-4" />
        <span className="hidden lg:inline">Clear data</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-gray-900/40 p-4 pt-16 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="animate-fade-in w-full max-w-lg rounded-2xl border border-gray-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-gray-100 px-5 py-4">
              <div>
                <h2 className="font-semibold text-gray-900">Clear saved data</h2>
                <p className="mt-0.5 text-xs text-gray-500">
                  Everything here is stored in this browser only. Clearing it
                  cannot be undone.
                </p>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-5 py-4">
              {report?.empty ? (
                <p className="rounded-lg bg-gray-50 px-3 py-6 text-center text-sm text-gray-500">
                  There is nothing saved in this browser yet.
                </p>
              ) : (
                <>
                  <button
                    onClick={download}
                    className={cn(
                      "mb-4 flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition",
                      backedUp
                        ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                        : "border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100",
                    )}
                  >
                    <Download className="h-4 w-4" />
                    {backedUp
                      ? "Backup downloaded - safe to clear"
                      : "Download a backup first"}
                  </button>

                  <ul className="space-y-1">
                    {report?.sections.map((section) => (
                      <li key={section.id}>
                        <label
                          className={cn(
                            "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition",
                            section.present
                              ? "hover:bg-gray-50"
                              : "opacity-50",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={chosen.includes(section.id)}
                            onChange={() => toggle(section.id)}
                            disabled={!section.present}
                            className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-gray-900">
                              {section.label}
                            </span>
                            <span className="block text-xs text-gray-500">
                              {section.detail}
                            </span>
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-gray-400">
                            {section.bytes > 0 ? kb(section.bytes) : ""}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>

                  {report?.identity.present && (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/70 p-3">
                      <label className="flex cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          checked={includeIdentity}
                          onChange={() => {
                            setIncludeIdentity((v) => !v);
                            setConfirming(false);
                          }}
                          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                        />
                        <span>
                          <span className="block text-sm font-medium text-gray-900">
                            {IDENTITY_LABEL}
                          </span>
                          <span className="block text-xs text-gray-600">
                            {report.identity.detail}. Left alone by default so no
                            reference number can ever be issued twice. Tick this
                            only if you want this browser treated as a brand new
                            device.
                          </span>
                        </span>
                      </label>
                    </div>
                  )}

                  {report && report.leftovers.length > 0 && (
                    <p className="mt-3 text-xs text-gray-500">
                      {report.leftovers.length} leftover item
                      {report.leftovers.length === 1 ? "" : "s"} from an older
                      version will also be swept up when everything is selected.
                    </p>
                  )}

                  {!backedUp && (
                    <p className="mt-3 flex items-start gap-2 text-xs text-amber-700">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      You have not taken a backup. Nothing here is stored
                      anywhere else.
                    </p>
                  )}
                </>
              )}
            </div>

            {!report?.empty && (
              <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
                <button
                  onClick={() => setOpen(false)}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                >
                  Cancel
                </button>
                {confirming ? (
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
                    {working ? "Clearing..." : "Yes, delete it permanently"}
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirming(true)}
                    disabled={nothingChosen}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-red-700 disabled:opacity-40"
                  >
                    Clear{" "}
                    {chosen.length === DATA_SECTIONS.length && includeIdentity
                      ? "everything"
                      : `${chosen.length + (includeIdentity ? 1 : 0)} selected`}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

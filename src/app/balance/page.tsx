"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Scale,
  Plus,
  Trash2,
  Save,
  FolderOpen,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle2,
  X,
  Search,
  TrendingUp,
  Receipt,
  Users,
  Container as ContainerIcon,
  Loader2,
  Sheet as SheetIcon,
  Upload,
  Wallet,
  CalendarClock,
} from "lucide-react";
import {
  addBalanceDue,
  addExpense,
  addTurnover,
  balanceDueStatus,
  balanceDueTotals,
  balanceFilename,
  balanceOutstanding,
  byParty,
  checkBalanceDue,
  createBalanceDue,
  isBalanceOverdue,
  partyNames,
  removeBalanceDue,
  updateBalanceDue,
  balanceToCsv,
  balanceTotals,
  byContainer,
  byPartner,
  checkExpense,
  checkTurnover,
  containerIds,
  createExpense,
  createTurnover,
  emptyBalanceSheet,
  expensesFilename,
  loadBalanceSheet,
  parseBalanceSheet,
  partnerNames,
  removeExpense,
  removeTurnover,
  saveBalanceSheet,
  updateExpense,
  updateTurnover,
  type BalanceSheet,
} from "@/lib/balanceSheet";
import {
  addImportedExpenses,
  markDuplicates,
  newRows,
  type ImportedRow,
  type SkippedRow,
} from "@/lib/expensesImport";
import {
  addImportedBalances,
  markBalanceDuplicates,
  newBalances,
  type ImportedBalance,
} from "@/lib/balancesImport";
import { checkContainerNumber } from "@/lib/container";
import { formatLKR } from "@/lib/types";
import { cn } from "@/lib/cn";

/** A spreadsheet that has been read but not yet accepted onto the sheet. */
interface PendingBase {
  fileName: string;
  sheetName: string;
  skipped: SkippedRow[];
  skippedTotal: number;
}
type PendingImport =
  | (PendingBase & { scope: "expenses"; rows: ImportedRow[] })
  | (PendingBase & { scope: "balances"; rows: ImportedBalance[] });

export default function BalancePage() {
  const [sheet, setSheet] = useState<BalanceSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  /** Which export is being built, so only that button shows a spinner. */
  const [building, setBuilding] = useState<"full" | "expenses" | null>(null);
  const jsonRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const balanceImportRef = useRef<HTMLInputElement>(null);
  /** Which import is reading, so only that button spins. */
  const [importing, setImporting] = useState<"expenses" | "balances" | null>(null);
  /**
   * A read file waiting to be accepted. Nothing is added until it is, so an
   * unexpected file can be looked at and thrown away rather than undone.
   */
  const [pending, setPending] = useState<PendingImport | null>(null);

  // Turnover form
  const [tvContainer, setTvContainer] = useState("");
  const [tvAmount, setTvAmount] = useState("");
  const [tvNote, setTvNote] = useState("");

  // Balance-to-be-paid form
  const [bdParty, setBdParty] = useState("");
  const [bdDirection, setBdDirection] = useState<"payable" | "receivable">("payable");
  const [bdAmount, setBdAmount] = useState("");
  const [bdPaid, setBdPaid] = useState("");
  const [bdContainer, setBdContainer] = useState("");
  const [bdOrder, setBdOrder] = useState("");
  const [bdDue, setBdDue] = useState("");

  // Expense form
  const [exName, setExName] = useState("");
  const [exPartner, setExPartner] = useState("");
  const [exAmount, setExAmount] = useState("");
  const [exContainer, setExContainer] = useState("");

  useEffect(() => {
    setSheet(loadBalanceSheet());
  }, []);

  const persist = useCallback((next: BalanceSheet) => {
    setSheet(next);
    saveBalanceSheet(next);
  }, []);

  /* -------------------------------- derived ------------------------------- */

  const totals = useMemo(
    () => balanceTotals(sheet ?? emptyBalanceSheet()),
    [sheet],
  );
  const containers = useMemo(
    () => byContainer(sheet ?? emptyBalanceSheet()),
    [sheet],
  );
  const partners = useMemo(
    () => byPartner(sheet ?? emptyBalanceSheet()),
    [sheet],
  );
  const dues = useMemo(
    () => balanceDueTotals(sheet ?? emptyBalanceSheet()),
    [sheet],
  );
  const parties = useMemo(
    () => byParty(sheet ?? emptyBalanceSheet()),
    [sheet],
  );
  const knownParties = useMemo(
    () => partyNames(sheet ?? emptyBalanceSheet()),
    [sheet],
  );
  /** Soonest due first, and anything undated last: a deadline outranks a note. */
  const sortedBalances = useMemo(() => {
    if (!sheet) return [];
    return [...sheet.balances].sort(
      (a, b) => (a.dueAt || "9999").localeCompare(b.dueAt || "9999"),
    );
  }, [sheet]);
  const knownPartners = useMemo(
    () => partnerNames(sheet ?? emptyBalanceSheet()),
    [sheet],
  );
  const knownContainers = useMemo(
    () => containerIds(sheet ?? emptyBalanceSheet()),
    [sheet],
  );

  const visibleExpenses = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = sheet?.expenses ?? [];
    if (!q) return list;
    return list.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.partner.toLowerCase().includes(q) ||
        e.containerId.toLowerCase().includes(q),
    );
  }, [sheet, search]);

  /** Container IDs are normalised but not enforced, so this is a nudge only. */
  const tvContainerCheck = useMemo(
    () => checkContainerNumber(tvContainer),
    [tvContainer],
  );
  const exContainerCheck = useMemo(
    () => checkContainerNumber(exContainer),
    [exContainer],
  );

  /* -------------------------------- actions ------------------------------- */

  const submitTurnover = useCallback(() => {
    if (!sheet) return;
    const amount = tvAmount.trim() === "" ? null : Number(tvAmount);
    const check = checkTurnover({ containerId: tvContainer, turnover: amount });
    if (!check.ok) {
      setError(check.message ?? "That entry cannot be added.");
      return;
    }
    persist(
      addTurnover(
        sheet,
        createTurnover({
          containerId: tvContainer,
          turnover: amount,
          note: tvNote,
        }),
      ),
    );
    setTvAmount("");
    setTvNote("");
    setError(null);
    setNotice(
      `Recorded ${formatLKR(amount as number)} turnover for ${checkContainerNumber(tvContainer).value}.`,
    );
  }, [sheet, tvContainer, tvAmount, tvNote, persist]);

  const submitBalance = useCallback(() => {
    if (!sheet) return;
    const amount = bdAmount.trim() === "" ? null : Number(bdAmount);
    const paid = bdPaid.trim() === "" ? 0 : Number(bdPaid);
    const check = checkBalanceDue({ party: bdParty, amount, paid });
    if (!check.ok) {
      setError(check.message ?? "That balance cannot be added.");
      return;
    }
    persist(
      addBalanceDue(
        sheet,
        createBalanceDue({
          party: bdParty,
          direction: bdDirection,
          amount,
          paid,
          containerId: bdContainer,
          orderNumber: bdOrder,
          dueAt: bdDue,
        }),
      ),
    );
    setBdAmount("");
    setBdPaid("");
    setBdDue("");
    // The party, direction and container usually repeat, so they stay put.
    setError(null);
    const left = (amount as number) - paid;
    setNotice(
      `${bdDirection === "receivable" ? "Owed to us by" : "We owe"} ${bdParty.trim()}: ${formatLKR(left)} outstanding.`,
    );
  }, [
    sheet,
    bdParty,
    bdDirection,
    bdAmount,
    bdPaid,
    bdContainer,
    bdOrder,
    bdDue,
    persist,
  ]);

  const submitExpense = useCallback(() => {
    if (!sheet) return;
    const amount = exAmount.trim() === "" ? null : Number(exAmount);
    const check = checkExpense({
      name: exName,
      partner: exPartner,
      amount,
    });
    if (!check.ok) {
      setError(check.message ?? "That expense cannot be added.");
      return;
    }
    persist(
      addExpense(
        sheet,
        createExpense({
          name: exName,
          partner: exPartner,
          amount,
          containerId: exContainer,
        }),
      ),
    );
    setExName("");
    setExAmount("");
    // The partner and container usually repeat, so they are left in place.
    setError(null);
    setNotice(
      `Added ${exName.trim()} at ${formatLKR(amount as number)} for ${exPartner.trim()}.`,
    );
  }, [sheet, exName, exPartner, exAmount, exContainer, persist]);

  /* -------------------------------- files --------------------------------- */

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
    if (!sheet) return;
    downloadBlob(
      new Blob([JSON.stringify(sheet, null, 2)], { type: "application/json" }),
      `Balance sheet ${new Date().toISOString().slice(0, 10)}.json`,
    );
    setNotice("Saved. Keep the file to move the sheet between devices.");
  }, [sheet, downloadBlob]);

  const loadFile = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const parsed = parseBalanceSheet(JSON.parse(await file.text()));
        persist(parsed);
        setNotice(
          `Loaded ${parsed.turnover.length} turnover and ${parsed.expenses.length} expense entries.`,
        );
      } catch {
        setError("That file is not a valid balance sheet.");
      } finally {
        if (jsonRef.current) jsonRef.current.value = "";
      }
    },
    [persist],
  );

  const exportCsv = useCallback(() => {
    if (!sheet || (sheet.expenses.length === 0 && sheet.turnover.length === 0)) {
      setError("There is nothing to export yet.");
      return;
    }
    downloadBlob(
      new Blob([balanceToCsv(sheet)], { type: "text/csv;charset=utf-8" }),
      balanceFilename("csv"),
    );
    setNotice("CSV exported - entries, then the summary and breakdowns.");
  }, [sheet, downloadBlob]);

  /**
   * Read a spreadsheet, but do not add anything yet.
   *
   * Duplicates are worked out here rather than on the server, because this is
   * the side that holds the balance sheet to compare against.
   */
  const importFile = useCallback(
    async (file: File, scope: "expenses" | "balances") => {
      if (!sheet) return;
      setError(null);
      setNotice(null);
      setPending(null);
      setImporting(scope);
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("scope", scope);
        const res = await fetch("/api/balance-import", {
          method: "POST",
          body: fd,
        });
        const data = (await res.json()) as {
          error?: string;
          fileName?: string;
          sheetName?: string;
          rows?: unknown[];
          skipped?: SkippedRow[];
          skippedTotal?: number;
        };
        if (!res.ok) throw new Error(data.error || "Could not read that file.");

        const base = {
          fileName: data.fileName ?? file.name,
          sheetName: data.sheetName ?? "",
          skipped: data.skipped ?? [],
          skippedTotal: data.skippedTotal ?? (data.skipped ?? []).length,
        };
        if (scope === "balances") {
          setPending({
            ...base,
            scope: "balances",
            rows: markBalanceDuplicates(
              (data.rows ?? []) as ImportedBalance[],
              sheet.balances,
            ),
          });
        } else {
          setPending({
            ...base,
            scope: "expenses",
            rows: markDuplicates((data.rows ?? []) as ImportedRow[], sheet.expenses),
          });
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not read that file.",
        );
      } finally {
        setImporting(null);
        // Cleared so picking the same file again still fires onChange.
        if (importRef.current) importRef.current.value = "";
        if (balanceImportRef.current) balanceImportRef.current.value = "";
      }
    },
    [sheet],
  );

  /** Accept a read file: either only the rows that look new, or all of them. */
  const commitImport = useCallback(
    (which: "new" | "all") => {
      if (!sheet || !pending) return;

      const fresh =
        pending.scope === "balances"
          ? newBalances(pending.rows).length
          : newRows(pending.rows).length;

      const result =
        pending.scope === "balances"
          ? addImportedBalances(
              sheet,
              which === "new" ? newBalances(pending.rows) : pending.rows,
              pending.fileName,
            )
          : addImportedExpenses(
              sheet,
              which === "new" ? newRows(pending.rows) : pending.rows,
              pending.fileName,
            );

      const chosenCount = which === "new" ? fresh : pending.rows.length;
      if (chosenCount === 0) {
        setError("There is nothing new in that file to add.");
        return;
      }

      persist(result.sheet);
      setPending(null);
      setError(null);
      const noun = pending.scope === "balances" ? "balance" : "expense";
      const repeats = chosenCount - fresh;
      setNotice(
        `Added ${result.added} ${noun}${result.added === 1 ? "" : "s"} from ${pending.fileName}.` +
          (repeats > 0
            ? ` ${repeats} of them already matched an entry on the sheet.`
            : "") +
          (result.dropped > 0
            ? ` ${result.dropped} did not fit and were left out.`
            : ""),
      );
    },
    [sheet, pending, persist],
  );

  /**
   * Both workbooks are built on the server, because ExcelJS is far too heavy to
   * ship to the browser for a button that is pressed now and then.
   */
  const exportExcel = useCallback(
    async (scope: "full" | "expenses") => {
      if (!sheet) return;
      const nothingToSend =
        scope === "expenses"
          ? sheet.expenses.length === 0
          : sheet.expenses.length === 0 && sheet.turnover.length === 0;
      if (nothingToSend) {
        setError(
          scope === "expenses"
            ? "There are no expenses to export yet."
            : "There is nothing to export yet.",
        );
        return;
      }
      setError(null);
      setBuilding(scope);
      setNotice("Building the spreadsheet...");
      try {
        const res = await fetch("/api/balance-export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, sheet }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error ?? "The spreadsheet could not be built.");
        }
        downloadBlob(
          await res.blob(),
          scope === "expenses"
            ? expensesFilename("xlsx")
            : balanceFilename("xlsx"),
        );
        setNotice(
          scope === "expenses"
            ? "Expenses exported on their own - name, partner and amount, with no turnover or profit in the file."
            : "Excel exported - 5 tabs, and every total is a live formula, so editing an amount updates the rest.",
        );
      } catch (err) {
        setNotice(null);
        setError(
          err instanceof Error
            ? err.message
            : "The spreadsheet could not be built.",
        );
      } finally {
        setBuilding(null);
      }
    },
    [sheet, downloadBlob],
  );

  /* -------------------------------- render -------------------------------- */

  const isEmpty =
    sheet !== null && sheet.expenses.length === 0 && sheet.turnover.length === 0;
  /** The expenses-only export needs expenses, but not any turnover. */
  const noExpenses = sheet === null || sheet.expenses.length === 0;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-12">
      <header className="mb-8">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
          <Scale className="h-7 w-7 text-brand-600" />
          Balance Sheet
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-gray-500">
          What each container brought in, what it cost, and which partner the
          money belongs to.
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
        ref={importRef}
        type="file"
        accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importFile(f, "expenses");
        }}
      />
      <input
        ref={balanceImportRef}
        type="file"
        accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importFile(f, "balances");
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

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Turnover" value={formatLKR(totals.turnover)} />
        <Stat label="Expenses" value={formatLKR(totals.expenses)} />
        <Stat
          label="Net profit"
          value={formatLKR(totals.netProfit)}
          tone={totals.netProfit >= 0 ? "good" : "bad"}
        />
        <Stat
          label="Margin"
          value={
            totals.margin === null ? "-" : `${totals.margin.toFixed(1)}%`
          }
          tone={
            totals.margin === null
              ? undefined
              : totals.margin >= 0
                ? "good"
                : "bad"
          }
        />
      </div>

      {/* Scope note: this is where a balance sheet usually misleads. */}
      {totals.generalExpenses > 0 && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {formatLKR(totals.generalExpenses)} of expenses are not tied to a
          container. They are counted in the net profit above, but not in any
          single container&apos;s profit below.
        </p>
      )}

      {/* ------------------------------ Profit ------------------------------ */}
      <section className="mt-6 rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-5 py-4">
          <h2 className="flex items-center gap-2 font-semibold text-gray-900">
            <TrendingUp className="h-4 w-4 text-brand-600" />
            Profit by container
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Turnover you record, less the expenses tagged to that container.
          </p>
        </div>

        {/* Add turnover */}
        <div className="flex flex-wrap items-end gap-3 border-b border-gray-100 bg-gray-50/60 px-5 py-4">
          <div className="min-w-[190px] flex-1">
            <label
              htmlFor="tv-container"
              className="mb-1 block text-xs font-medium text-gray-600"
            >
              Container ID
            </label>
            <div className="relative">
              <ContainerIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                id="tv-container"
                list="bs-containers"
                value={tvContainer}
                onChange={(e) => setTvContainer(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitTurnover();
                }}
                placeholder="GAOU7441740"
                className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 font-mono text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </div>
          </div>
          <div className="w-40">
            <label
              htmlFor="tv-amount"
              className="mb-1 block text-xs font-medium text-gray-600"
            >
              Turnover (Rs)
            </label>
            <input
              id="tv-amount"
              value={tvAmount}
              onChange={(e) => setTvAmount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitTurnover();
              }}
              inputMode="decimal"
              placeholder="1200000"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>
          <div className="min-w-[150px] flex-1">
            <label
              htmlFor="tv-note"
              className="mb-1 block text-xs font-medium text-gray-600"
            >
              Note
            </label>
            <input
              id="tv-note"
              value={tvNote}
              onChange={(e) => setTvNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitTurnover();
              }}
              placeholder="Optional"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>
          <button
            onClick={submitTurnover}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" />
            Add turnover
          </button>
        </div>
        {tvContainer.trim() !== "" && !tvContainerCheck.checkDigitValid && (
          <p className="px-5 py-2 text-xs text-amber-700">
            {tvContainerCheck.message}
          </p>
        )}

        {containers.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-500">
            No containers yet. Add turnover above, or tag an expense to a
            container below.
          </p>
        ) : (
          <div className="preview-scroll max-h-80 overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-gray-900 text-white">
                <tr>
                  <th className="px-5 py-3 text-left font-semibold">
                    Container
                  </th>
                  <th className="w-36 px-2 py-3 text-right font-semibold">
                    Turnover
                  </th>
                  <th className="w-36 px-2 py-3 text-right font-semibold">
                    Expenses
                  </th>
                  <th className="w-36 px-2 py-3 text-right font-semibold">
                    Profit
                  </th>
                  <th className="w-24 px-2 py-3 text-right font-semibold">
                    Margin
                  </th>
                </tr>
              </thead>
              <tbody>
                {containers.map((row, i) => (
                  <tr
                    key={row.containerId}
                    className={cn(
                      "border-b border-gray-100",
                      i % 2 === 1 && "bg-gray-50/60",
                    )}
                  >
                    <td className="px-5 py-2.5 font-mono text-gray-800">
                      {row.containerId}
                      {row.turnover === 0 && (
                        <span className="ml-2 font-sans text-xs text-amber-600">
                          no turnover yet
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-right text-gray-700">
                      {formatLKR(row.turnover)}
                    </td>
                    <td className="px-2 py-2.5 text-right text-gray-700">
                      {formatLKR(row.expenses)}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-2.5 text-right font-semibold",
                        row.profit >= 0 ? "text-emerald-700" : "text-red-700",
                      )}
                    >
                      {formatLKR(row.profit)}
                    </td>
                    <td className="px-2 py-2.5 text-right text-gray-600">
                      {row.margin === null ? "-" : `${row.margin.toFixed(1)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 bg-brand-100 font-bold text-gray-900">
                <tr>
                  <td className="px-5 py-3">Total</td>
                  <td className="px-2 py-3 text-right">
                    {formatLKR(totals.turnover)}
                  </td>
                  <td className="px-2 py-3 text-right">
                    {formatLKR(totals.attributedExpenses)}
                  </td>
                  <td className="px-2 py-3 text-right">
                    {formatLKR(totals.turnover - totals.attributedExpenses)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* Turnover entries, so a mistake can be taken back out */}
        {(sheet?.turnover.length ?? 0) > 0 && (
          <details className="border-t border-gray-100 px-5 py-3">
            <summary className="cursor-pointer text-xs font-medium text-gray-600">
              {sheet?.turnover.length} turnover entr
              {sheet?.turnover.length === 1 ? "y" : "ies"}
            </summary>
            <ul className="mt-2 space-y-1 text-sm">
              {sheet?.turnover.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center justify-between gap-3 border-b border-gray-50 py-1.5 last:border-0"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="font-mono text-xs text-gray-700">
                      {entry.containerId}
                    </span>
                    <span className="truncate text-xs text-gray-400">
                      {entry.at.slice(0, 10)}
                      {entry.note ? ` · ${entry.note}` : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <input
                      value={entry.turnover}
                      onChange={(e) =>
                        sheet &&
                        persist(
                          updateTurnover(sheet, entry.id, {
                            turnover: Number(e.target.value),
                          }),
                        )
                      }
                      inputMode="decimal"
                      className="w-28 rounded-md border border-transparent px-2 py-1 text-right text-sm outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100"
                    />
                    <button
                      onClick={() =>
                        sheet && persist(removeTurnover(sheet, entry.id))
                      }
                      title="Remove this entry"
                      className="rounded p-1 text-red-500 transition hover:bg-red-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* ------------------------------ Expenses ----------------------------- */}
      <section className="mt-6 rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="relative border-b border-gray-100 px-5 py-4 pr-44">
          <h2 className="flex items-center gap-2 font-semibold text-gray-900">
            <Receipt className="h-4 w-4 text-brand-600" />
            Expenses
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Tag a container to count an expense against its profit. Leave it
            blank for general overhead.
          </p>
          <button
            onClick={() => importRef.current?.click()}
            disabled={importing !== null}
            title="Read expenses from an XLSX or CSV file and add them to this sheet"
            className="absolute right-5 top-4 inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-40"
          >
            {importing === "expenses" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {importing === "expenses" ? "Reading..." : "Import from Excel"}
          </button>
        </div>

        {pending?.scope === "expenses" && (
          <ImportPreview
            pending={pending}
            onAddNew={() => commitImport("new")}
            onAddAll={() => commitImport("all")}
            onCancel={() => setPending(null)}
          />
        )}

        <div className="flex flex-wrap items-end gap-3 border-b border-gray-100 bg-gray-50/60 px-5 py-4">
          <div className="min-w-[160px] flex-1">
            <label
              htmlFor="ex-name"
              className="mb-1 block text-xs font-medium text-gray-600"
            >
              Expense name
            </label>
            <input
              id="ex-name"
              value={exName}
              onChange={(e) => setExName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitExpense();
              }}
              placeholder="Customs duty"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>
          <div className="min-w-[150px] flex-1">
            <label
              htmlFor="ex-partner"
              className="mb-1 block text-xs font-medium text-gray-600"
            >
              Partner
            </label>
            <input
              id="ex-partner"
              list="bs-partners"
              value={exPartner}
              onChange={(e) => setExPartner(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitExpense();
              }}
              placeholder="Partner name"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>
          <div className="w-36">
            <label
              htmlFor="ex-amount"
              className="mb-1 block text-xs font-medium text-gray-600"
            >
              Amount (Rs)
            </label>
            <input
              id="ex-amount"
              value={exAmount}
              onChange={(e) => setExAmount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitExpense();
              }}
              inputMode="decimal"
              placeholder="85000"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>
          <div className="w-44">
            <label
              htmlFor="ex-container"
              className="mb-1 block text-xs font-medium text-gray-600"
            >
              Container{" "}
              <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <input
              id="ex-container"
              list="bs-containers"
              value={exContainer}
              onChange={(e) => setExContainer(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitExpense();
              }}
              placeholder="General"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>
          <button
            onClick={submitExpense}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" />
            Add expense
          </button>
        </div>
        {exContainer.trim() !== "" && !exContainerCheck.checkDigitValid && (
          <p className="px-5 py-2 text-xs text-amber-700">
            {exContainerCheck.message}
          </p>
        )}

        {(sheet?.expenses.length ?? 0) > 0 && (
          <div className="border-b border-gray-100 px-5 py-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search expenses, partners or containers..."
                className="w-full rounded-lg border border-gray-300 py-1.5 pl-9 pr-3 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </div>
          </div>
        )}

        {(sheet?.expenses.length ?? 0) === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-500">
            No expenses recorded yet.
          </p>
        ) : (
          <div className="preview-scroll max-h-96 overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-gray-900 text-white">
                <tr>
                  <th className="px-5 py-3 text-left font-semibold">Expense</th>
                  <th className="w-40 px-2 py-3 text-left font-semibold">
                    Partner
                  </th>
                  <th className="w-36 px-2 py-3 text-left font-semibold">
                    Container
                  </th>
                  <th className="w-36 px-2 py-3 text-right font-semibold">
                    Amount
                  </th>
                  <th className="w-10 px-2 py-3" />
                </tr>
              </thead>
              <tbody>
                {visibleExpenses.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-5 py-8 text-center text-sm text-gray-500"
                    >
                      Nothing matches that search.
                    </td>
                  </tr>
                )}
                {visibleExpenses.map((expense, i) => (
                  <tr
                    key={expense.id}
                    className={cn(
                      "border-b border-gray-100",
                      i % 2 === 1 && "bg-gray-50/60",
                    )}
                  >
                    <td className="px-5 py-2">
                      <input
                        value={expense.name}
                        onChange={(e) =>
                          sheet &&
                          persist(
                            updateExpense(sheet, expense.id, {
                              name: e.target.value,
                            }),
                          )
                        }
                        className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 font-medium text-gray-800 outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100"
                      />
                      <span className="block px-2 text-xs text-gray-400">
                        {expense.at.slice(0, 10)}
                        {expense.note ? ` · ${expense.note}` : ""}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <input
                        value={expense.partner}
                        list="bs-partners"
                        onChange={(e) =>
                          sheet &&
                          persist(
                            updateExpense(sheet, expense.id, {
                              partner: e.target.value,
                            }),
                          )
                        }
                        className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-gray-700 outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        value={expense.containerId}
                        list="bs-containers"
                        placeholder="General"
                        onChange={(e) =>
                          sheet &&
                          persist(
                            updateExpense(sheet, expense.id, {
                              containerId: e.target.value.toUpperCase(),
                            }),
                          )
                        }
                        className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 font-mono text-xs text-gray-700 outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        value={expense.amount}
                        onChange={(e) =>
                          sheet &&
                          persist(
                            updateExpense(sheet, expense.id, {
                              amount: Number(e.target.value),
                            }),
                          )
                        }
                        inputMode="decimal"
                        className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-right font-medium text-gray-900 outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100"
                      />
                    </td>
                    <td className="px-2 py-2 text-center">
                      <button
                        onClick={() =>
                          sheet && persist(removeExpense(sheet, expense.id))
                        }
                        title="Remove this expense"
                        className="rounded p-1.5 text-red-500 transition hover:bg-red-50"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 bg-brand-100 font-bold text-gray-900">
                <tr>
                  <td className="px-5 py-3">
                    Total
                    {visibleExpenses.length !==
                      (sheet?.expenses.length ?? 0) && (
                      <span className="ml-2 text-xs font-normal text-gray-600">
                        (showing {visibleExpenses.length} of{" "}
                        {sheet?.expenses.length})
                      </span>
                    )}
                  </td>
                  <td colSpan={2} />
                  <td className="px-2 py-3 text-right">
                    {formatLKR(totals.expenses)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {/* --------------------------- Balances to pay -------------------------- */}
      <section className="mt-6 rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="relative border-b border-gray-100 px-5 py-4 pr-44">
          <h2 className="flex items-center gap-2 font-semibold text-gray-900">
            <Wallet className="h-4 w-4 text-brand-600" />
            Balances to be paid
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            What is still outstanding, either way round. Record the total and how
            much has been paid; what is left is worked out for you.
          </p>
          <button
            onClick={() => balanceImportRef.current?.click()}
            disabled={importing !== null}
            title="Read balances from an XLSX or CSV file - use this to bring in previous balances"
            className="absolute right-5 top-4 inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-40"
          >
            {importing === "balances" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {importing === "balances" ? "Reading..." : "Import from Excel"}
          </button>
        </div>

        {pending?.scope === "balances" && (
          <ImportPreview
            pending={pending}
            onAddNew={() => commitImport("new")}
            onAddAll={() => commitImport("all")}
            onCancel={() => setPending(null)}
          />
        )}

        {/* Position, kept apart from the profit figures at the top of the page */}
        <div className="grid grid-cols-2 gap-3 border-b border-gray-100 px-5 py-4 sm:grid-cols-4">
          <Stat label="Still to pay" value={formatLKR(dues.payableOutstanding)} />
          <Stat
            label="Still to receive"
            value={formatLKR(dues.receivableOutstanding)}
          />
          <Stat
            label="Net position"
            value={formatLKR(dues.net)}
            tone={dues.net >= 0 ? "good" : "bad"}
          />
          <Stat
            label="Overdue"
            value={
              dues.overdueCount === 0
                ? "-"
                : `${formatLKR(dues.overdueAmount)} (${dues.overdueCount})`
            }
            tone={dues.overdueCount > 0 ? "bad" : undefined}
          />
        </div>

        {/* Add a balance */}
        <div className="border-b border-gray-100 px-5 py-4">
          <div className="grid gap-2 sm:grid-cols-12">
            <input
              value={bdParty}
              onChange={(e) => setBdParty(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitBalance()}
              placeholder="Who it is with"
              list="bs-parties"
              maxLength={60}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500 sm:col-span-3"
            />
            <select
              value={bdDirection}
              onChange={(e) =>
                setBdDirection(e.target.value === "receivable" ? "receivable" : "payable")
              }
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500 sm:col-span-2"
            >
              <option value="payable">We owe</option>
              <option value="receivable">Owed to us</option>
            </select>
            <input
              value={bdAmount}
              onChange={(e) => setBdAmount(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitBalance()}
              placeholder="Total"
              type="number"
              min="0"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500 sm:col-span-2"
            />
            <input
              value={bdPaid}
              onChange={(e) => setBdPaid(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitBalance()}
              placeholder="Paid so far"
              type="number"
              min="0"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500 sm:col-span-2"
            />
            <input
              value={bdDue}
              onChange={(e) => setBdDue(e.target.value)}
              type="date"
              title="Due date, if there is one"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500 sm:col-span-3"
            />
            <input
              value={bdContainer}
              onChange={(e) => setBdContainer(e.target.value.toUpperCase())}
              placeholder="Container (optional)"
              list="bs-containers"
              className="rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500 sm:col-span-4"
            />
            <input
              value={bdOrder}
              onChange={(e) => setBdOrder(e.target.value)}
              placeholder="Order number (optional)"
              maxLength={80}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500 sm:col-span-5"
            />
            <button
              onClick={submitBalance}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 sm:col-span-3"
            >
              <Plus className="h-4 w-4" />
              Add balance
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Leave <span className="font-medium">Paid so far</span> empty for a
            balance nothing has been paid against. These figures are a position,
            not profit &mdash; they are deliberately left out of the net profit
            above, since the expense behind one may already be recorded.
          </p>
        </div>

        {/* The ledger */}
        {sortedBalances.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-500">
            Nothing outstanding. Add a balance above, or bring previous balances
            in with <span className="font-medium">Import from Excel</span>.
          </p>
        ) : (
          <div className="preview-scroll overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-gray-100 bg-gray-50/70 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Party</th>
                  <th className="px-2 py-2 font-medium">Direction</th>
                  <th className="px-2 py-2 text-right font-medium">Total</th>
                  <th className="px-2 py-2 text-right font-medium">Paid</th>
                  <th className="px-2 py-2 text-right font-medium">Outstanding</th>
                  <th className="px-2 py-2 font-medium">Due</th>
                  <th className="px-2 py-2 font-medium">Container</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sortedBalances.map((balance) => {
                  const left = balanceOutstanding(balance);
                  const overdue = isBalanceOverdue(balance);
                  const status = balanceDueStatus(balance);
                  return (
                    <tr key={balance.id} className="hover:bg-gray-50/60">
                      <td className="px-4 py-2">
                        <input
                          value={balance.party}
                          list="bs-parties"
                          onChange={(e) =>
                            sheet &&
                            persist(
                              updateBalanceDue(sheet, balance.id, {
                                party: e.target.value,
                              }),
                            )
                          }
                          className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 font-medium text-gray-900 outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <select
                          value={balance.direction}
                          onChange={(e) =>
                            sheet &&
                            persist(
                              updateBalanceDue(sheet, balance.id, {
                                direction:
                                  e.target.value === "receivable"
                                    ? "receivable"
                                    : "payable",
                              }),
                            )
                          }
                          className="w-full rounded-md border border-transparent bg-transparent px-1 py-1 text-xs text-gray-700 outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white"
                        >
                          <option value="payable">We owe</option>
                          <option value="receivable">Owed to us</option>
                        </select>
                      </td>
                      <td className="px-2 py-2 text-right">
                        <input
                          value={balance.amount}
                          type="number"
                          min="0"
                          onChange={(e) =>
                            sheet &&
                            persist(
                              updateBalanceDue(sheet, balance.id, {
                                amount: Number(e.target.value),
                              }),
                            )
                          }
                          className="w-28 rounded-md border border-transparent bg-transparent px-2 py-1 text-right tabular-nums text-gray-700 outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100"
                        />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <input
                          value={balance.paid}
                          type="number"
                          min="0"
                          onChange={(e) =>
                            sheet &&
                            persist(
                              updateBalanceDue(sheet, balance.id, {
                                paid: Number(e.target.value),
                              }),
                            )
                          }
                          className="w-28 rounded-md border border-transparent bg-transparent px-2 py-1 text-right tabular-nums text-gray-500 outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100"
                        />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <span
                          className={cn(
                            "tabular-nums font-semibold",
                            left === 0
                              ? "text-emerald-700"
                              : overdue
                                ? "text-red-700"
                                : "text-gray-900",
                          )}
                        >
                          {formatLKR(left)}
                        </span>
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-400">
                          {left === 0 ? "settled" : status === "part-paid" ? "part" : ""}
                        </span>
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-1">
                          <input
                            value={balance.dueAt}
                            type="date"
                            onChange={(e) =>
                              sheet &&
                              persist(
                                updateBalanceDue(sheet, balance.id, {
                                  dueAt: e.target.value,
                                }),
                              )
                            }
                            className="w-32 rounded-md border border-transparent bg-transparent px-1 py-1 text-xs text-gray-600 outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white"
                          />
                          {overdue && (
                            <span title="Overdue" className="shrink-0">
                              <CalendarClock className="h-3.5 w-3.5 text-red-600" />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <input
                          value={balance.containerId}
                          list="bs-containers"
                          placeholder="-"
                          onChange={(e) =>
                            sheet &&
                            persist(
                              updateBalanceDue(sheet, balance.id, {
                                containerId: e.target.value.toUpperCase(),
                              }),
                            )
                          }
                          className="w-32 rounded-md border border-transparent bg-transparent px-2 py-1 font-mono text-xs text-gray-700 outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100"
                        />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <button
                          onClick={() =>
                            sheet && persist(removeBalanceDue(sheet, balance.id))
                          }
                          title="Remove this balance"
                          className="rounded-md p-1 text-gray-400 transition hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Who it is with */}
        {parties.length > 0 && (
          <div className="border-t border-gray-100 px-5 py-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
              By party
            </p>
            <ul className="space-y-1 text-sm">
              {parties.map((row) => (
                <li
                  key={row.party}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2"
                >
                  <span className="font-medium text-gray-900">
                    {row.party}
                    {row.overdueCount > 0 && (
                      <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                        {row.overdueCount} overdue
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-gray-600">
                    {row.payableOutstanding > 0 && (
                      <>we owe {formatLKR(row.payableOutstanding)}</>
                    )}
                    {row.payableOutstanding > 0 && row.receivableOutstanding > 0 && " · "}
                    {row.receivableOutstanding > 0 && (
                      <>owed to us {formatLKR(row.receivableOutstanding)}</>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ------------------------------ Partners ----------------------------- */}
      {partners.length > 0 && (
        <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 flex items-center gap-2 font-semibold text-gray-900">
            <Users className="h-4 w-4 text-brand-600" />
            Expenses by partner
          </h2>
          <ul className="space-y-2">
            {partners.map((row) => (
              <li key={row.partner}>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate font-medium text-gray-800">
                    {row.partner}
                    <span className="ml-2 text-xs font-normal text-gray-400">
                      {row.count} entr{row.count === 1 ? "y" : "ies"}
                    </span>
                  </span>
                  <span className="shrink-0 font-medium text-gray-900">
                    {formatLKR(row.expenses)}
                    {row.share !== null && (
                      <span className="ml-2 text-xs font-normal text-gray-400">
                        {row.share.toFixed(1)}%
                      </span>
                    )}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full bg-brand-500"
                    style={{ width: `${row.share ?? 0}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Shared suggestion lists */}
      <datalist id="bs-parties">
        {knownParties.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <datalist id="bs-partners">
        {knownPartners.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <datalist id="bs-containers">
        {knownContainers.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      {/* Files */}
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <button
          onClick={() => jsonRef.current?.click()}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
        >
          <FolderOpen className="h-4 w-4" />
          Load file
        </button>
        <button
          onClick={saveFile}
          disabled={isEmpty}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-40"
        >
          <Save className="h-4 w-4" />
          Save to file
        </button>
        <button
          onClick={exportCsv}
          disabled={isEmpty || building !== null}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-40"
        >
          <FileSpreadsheet className="h-4 w-4" />
          Export CSV
        </button>
        <button
          onClick={() => exportExcel("expenses")}
          disabled={noExpenses || building !== null}
          title="One tab of expense name, partner and amount - no turnover or profit in the file"
          className="inline-flex items-center gap-2 rounded-lg border border-emerald-300 bg-white px-4 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:opacity-40"
        >
          {building === "expenses" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Receipt className="h-4 w-4" />
          )}
          {building === "expenses" ? "Building..." : "Expenses only"}
        </button>
        <button
          onClick={() => exportExcel("full")}
          disabled={isEmpty || building !== null}
          title="A workbook of 5 tabs where every total is a live formula"
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-40"
        >
          {building === "full" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <SheetIcon className="h-4 w-4" />
          )}
          {building === "full" ? "Building..." : "Export Excel"}
        </button>
      </div>
      <p className="mt-2 text-right text-xs text-gray-400">
        <span className="font-medium text-gray-500">Expenses only</span> gives one
        tab of expense name, partner and amount - no turnover, profit or margin in
        the file, so it can be shared as it is.{" "}
        <span className="font-medium text-gray-500">Export Excel</span> gives the
        whole sheet across 5 tabs. In both, amounts are the only typed numbers and
        every total is a live formula over them, so editing an amount in Excel
        updates the rest.
      </p>

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
  tone?: "good" | "bad";
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border p-4 shadow-sm",
        tone === "good"
          ? "border-emerald-200 bg-emerald-50"
          : tone === "bad"
            ? "border-red-200 bg-red-50"
            : "border-gray-200 bg-white",
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 truncate text-lg font-bold",
          tone === "good"
            ? "text-emerald-800"
            : tone === "bad"
              ? "text-red-800"
              : "text-gray-900",
        )}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * What was read from a spreadsheet, before any of it is accepted.
 *
 * Both halves are shown deliberately: the rows that will be added, and the rows
 * that will not be, with the reason for each. A row that was skipped is the one
 * thing an importer must never hide, because it looks exactly like a row that
 * was never in the file.
 */
function ImportPreview({
  pending,
  onAddNew,
  onAddAll,
  onCancel,
}: {
  pending: PendingImport;
  onAddNew: () => void;
  onAddAll: () => void;
  onCancel: () => void;
}) {
  const fresh = pending.rows.filter((r) => !r.duplicate).length;
  const repeats = pending.rows.length - fresh;
  const noun = pending.scope === "balances" ? "balance" : "expense";

  return (
    <div className="animate-fade-in border-b border-amber-200 bg-amber-50/60 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-900">
            Read {pending.rows.length} {noun}
            {pending.rows.length === 1 ? "" : "s"} from {pending.fileName}
            {pending.sheetName ? ` (${pending.sheetName})` : ""}
          </p>
          <p className="mt-0.5 text-xs text-gray-600">
            {fresh} new
            {repeats > 0 && `, ${repeats} already matching an entry here`}
            {pending.skippedTotal > 0 &&
              `, ${pending.skippedTotal} row${pending.skippedTotal === 1 ? "" : "s"} skipped`}
            . Nothing has been added yet.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-50"
          >
            Cancel
          </button>
          {repeats > 0 && (
            <button
              onClick={onAddAll}
              title="Add every row, including the ones that match an entry already here"
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-50"
            >
              Add all {pending.rows.length}
            </button>
          )}
          <button
            onClick={onAddNew}
            disabled={fresh === 0}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-40"
          >
            Add {fresh} new
          </button>
        </div>
      </div>

      <div className="preview-scroll mt-3 max-h-56 overflow-auto rounded-lg border border-amber-200 bg-white">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-gray-50 text-gray-500">
            <tr>
              <th className="px-3 py-2 font-medium">Row</th>
              <th className="px-3 py-2 font-medium">
                {pending.scope === "balances" ? "Party" : "Expense"}
              </th>
              {pending.scope === "balances" ? (
                <>
                  <th className="px-3 py-2 font-medium">Direction</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 text-right font-medium">Paid</th>
                  <th className="px-3 py-2 text-right font-medium">Outstanding</th>
                  <th className="px-3 py-2 font-medium">Due</th>
                </>
              ) : (
                <>
                  <th className="px-3 py-2 font-medium">Partner</th>
                  <th className="px-3 py-2 font-medium">Container</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {pending.scope === "balances"
              ? pending.rows.map((row, i) => (
                  <tr
                    key={`${row.row}-${i}`}
                    className={row.duplicate ? "bg-gray-50" : ""}
                  >
                    <td className="px-3 py-1.5 text-gray-400">{row.row}</td>
                    <td className="px-3 py-1.5 text-gray-900">
                      {row.party}
                      {row.duplicate && (
                        <span className="ml-2 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                          already here
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-gray-700">
                      {row.direction === "receivable" ? "Owed to us" : "We owe"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">
                      {formatLKR(row.amount)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">
                      {row.paid > 0 ? formatLKR(row.paid) : "-"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-medium text-gray-900">
                      {formatLKR(row.amount - row.paid)}
                    </td>
                    <td className="px-3 py-1.5 text-gray-500">
                      {row.dueAt || "-"}
                    </td>
                  </tr>
                ))
              : pending.rows.map((row, i) => (
                  <tr
                    key={`${row.row}-${i}`}
                    className={row.duplicate ? "bg-gray-50" : ""}
                  >
                    <td className="px-3 py-1.5 text-gray-400">{row.row}</td>
                    <td className="px-3 py-1.5 text-gray-900">
                      {row.name}
                      {row.duplicate && (
                        <span className="ml-2 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                          already here
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-gray-700">{row.partner}</td>
                    <td className="px-3 py-1.5 text-gray-500">
                      {row.containerId || "general"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-900">
                      {formatLKR(row.amount)}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>

      {pending.skipped.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium text-gray-600">
            {pending.skippedTotal} row
            {pending.skippedTotal === 1 ? "" : "s"} skipped - see why
          </summary>
          <ul className="preview-scroll mt-2 max-h-40 space-y-1 overflow-auto text-xs text-gray-600">
            {pending.skipped.map((s, i) => (
              <li key={`${s.row}-${i}`} className="rounded bg-white/70 px-2 py-1">
                <span className="text-gray-400">Row {s.row}:</span> {s.reason}
                {s.detail && (
                  <span className="text-gray-400"> - {s.detail}</span>
                )}
              </li>
            ))}
          </ul>
          {pending.skippedTotal > pending.skipped.length && (
            <p className="mt-1 text-xs text-gray-400">
              Showing the first {pending.skipped.length}.
            </p>
          )}
        </details>
      )}
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

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
} from "lucide-react";
import {
  addExpense,
  addTurnover,
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
import { checkContainerNumber } from "@/lib/container";
import { formatLKR } from "@/lib/types";
import { cn } from "@/lib/cn";

export default function BalancePage() {
  const [sheet, setSheet] = useState<BalanceSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const jsonRef = useRef<HTMLInputElement>(null);

  // Turnover form
  const [tvContainer, setTvContainer] = useState("");
  const [tvAmount, setTvAmount] = useState("");
  const [tvNote, setTvNote] = useState("");

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
      `Balance sheet ${new Date().toISOString().slice(0, 10)}.csv`,
    );
    setNotice("CSV exported - entries, then the summary and breakdowns.");
  }, [sheet, downloadBlob]);

  /* -------------------------------- render -------------------------------- */

  const isEmpty =
    sheet !== null && sheet.expenses.length === 0 && sheet.turnover.length === 0;

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
        <div className="border-b border-gray-100 px-5 py-4">
          <h2 className="flex items-center gap-2 font-semibold text-gray-900">
            <Receipt className="h-4 w-4 text-brand-600" />
            Expenses
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Tag a container to count an expense against its profit. Leave it
            blank for general overhead.
          </p>
        </div>

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
          disabled={isEmpty}
          className="inline-flex items-center gap-2 rounded-lg border border-emerald-300 bg-white px-4 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:opacity-40"
        >
          <FileSpreadsheet className="h-4 w-4" />
          Export CSV
        </button>
      </div>

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

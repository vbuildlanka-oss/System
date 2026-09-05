"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarPlus,
  CheckCircle2,
  ChevronDown,
  FileText,
  Loader2,
  Plus,
  Settings2,
  Sheet as SheetIcon,
  Trash2,
  Users,
  Wallet,
  X,
} from "lucide-react";
import {
  addField,
  addMonth,
  addRow,
  DEFAULT_RATES,
  EMPLOYER_MAX,
  FIELD_LABEL_MAX,
  isMonthReady,
  loadPayrollDoc,
  MAX_FIELDS,
  MAX_ROWS,
  missingTins,
  monthKeyOf,
  monthLabel,
  monthsNewestFirst,
  monthTotals,
  NAME_MAX,
  NOTE_MAX,
  overDeductedNames,
  payslipFilename,
  removeField,
  removeMonth,
  removeRow,
  renameField,
  rowFigures,
  savePayrollDoc,
  setEmployer,
  setMonthNote,
  setPaidOn,
  setRates,
  setRowExtra,
  setRowMoney,
  setRowOverride,
  setRowText,
  TIN_MAX,
  type PayrollDoc,
  type PayrollRow,
} from "@/lib/payroll";
import { formatLKR, LIMITS } from "@/lib/types";
import { cn } from "@/lib/cn";

/**
 * Wages.
 *
 * The page is arranged around the one distinction that matters in Sri Lankan
 * payroll and that no amount of care in the arithmetic will save you from if the
 * screen muddles it: the employee's 8% EPF comes off the wage, while the
 * employer's 12% EPF and the 3% ETF do not. So the deductions and the company's
 * contributions are in separate blocks with a heading over each, and the net
 * figure sits at the end of the deductions - never after the employer's columns.
 *
 * A month is opened rather than created from nothing: the staff come forward from
 * last month, and only the figures that change get typed.
 */

type Building = "month" | "year" | "payslips" | string | null;

export default function PayrollPage() {
  const [doc, setDoc] = useState<PayrollDoc | null>(null);
  const [monthId, setMonthId] = useState<string>("");
  const [building, setBuilding] = useState<Building>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newMonth, setNewMonth] = useState<string>(monthKeyOf());
  const [fieldLabel, setFieldLabel] = useState("");
  const [fieldKind, setFieldKind] = useState<"allowance" | "deduction">(
    "deduction",
  );
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const loaded = loadPayrollDoc();
    setDoc(loaded);
    const newest = monthsNewestFirst(loaded)[0];
    if (newest) setMonthId(newest.id);
  }, []);

  const persist = useCallback((next: PayrollDoc) => {
    setDoc(next);
    savePayrollDoc(next);
  }, []);

  const month = useMemo(
    () => doc?.months.find((m) => m.id === monthId) ?? null,
    [doc, monthId],
  );

  const totals = useMemo(
    () => (doc && month ? monthTotals(month, doc.fields, doc.rates) : null),
    [doc, month],
  );

  const allowances = useMemo(
    () => doc?.fields.filter((f) => f.kind === "allowance") ?? [],
    [doc],
  );
  const deductions = useMemo(
    () => doc?.fields.filter((f) => f.kind === "deduction") ?? [],
    [doc],
  );

  const impossible = useMemo(
    () => (doc && month ? overDeductedNames(month, doc.fields, doc.rates) : []),
    [doc, month],
  );
  const ready = doc && month ? isMonthReady(month, doc.fields, doc.rates) : false;

  /* ------------------------------- downloads ------------------------------- */

  const download = useCallback(
    async (
      scope: "month" | "year" | "payslips" | "payslip",
      options: { rowId?: string; filename: string; tag: Building },
    ) => {
      if (!doc || !month) return;
      setBuilding(options.tag);
      setError(null);
      try {
        const res = await fetch("/api/payroll-export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            doc,
            scope,
            monthId: month.id,
            rowId: options.rowId,
            year: month.month.slice(0, 4),
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error ?? "The file could not be built.");
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = options.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setNotice(`Downloaded ${options.filename}.`);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "The file could not be built.",
        );
      } finally {
        setBuilding(null);
      }
    },
    [doc, month],
  );

  /* --------------------------------- months -------------------------------- */

  const openMonth = useCallback(() => {
    if (!doc) return;
    const result = addMonth(doc, newMonth);
    if (result.month === null) {
      setError(result.problem);
      return;
    }
    persist(result.doc);
    setMonthId(result.month.id);
    setError(null);
    setNotice(
      result.month.rows.length > 0
        ? `${monthLabel(result.month.month)} opened with ${result.month.rows.length} ${
            result.month.rows.length === 1 ? "person" : "people"
          } carried forward. Deductions start empty.`
        : `${monthLabel(result.month.month)} opened. Add the people on the payroll.`,
    );
  }, [doc, newMonth, persist]);

  const dropMonth = useCallback(() => {
    if (!doc || !month) return;
    const next = removeMonth(doc, month.id);
    persist(next);
    setMonthId(monthsNewestFirst(next)[0]?.id ?? "");
    setNotice(`${monthLabel(month.month)} removed.`);
  }, [doc, month, persist]);

  /* --------------------------------- fields -------------------------------- */

  const createField = useCallback(() => {
    if (!doc) return;
    const result = addField(doc, fieldLabel, fieldKind);
    if (result.field === null) {
      setError(result.problem);
      return;
    }
    persist(result.doc);
    setFieldLabel("");
    setError(null);
    setNotice(
      `"${result.field.label}" added as ${
        result.field.kind === "allowance" ? "an allowance" : "a deduction"
      }. It is a column on every month.`,
    );
  }, [doc, fieldKind, fieldLabel, persist]);

  if (doc === null) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8">
        <p className="text-sm text-gray-500">Loading payroll…</p>
      </main>
    );
  }

  const months = monthsNewestFirst(doc);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
          <Wallet className="h-6 w-6 text-brand-600" />
          Payroll
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-gray-600">
          One wage sheet a month. Type the gross salary and anything withheld —
          EPF, ETF and the net figure are worked out. Download the month as a
          spreadsheet, or a payslip for one person.
        </p>
      </header>

      {error && (
        <div className="mb-4 flex animate-fade-in items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {notice && !error && (
        <div className="mb-4 flex animate-fade-in items-start gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ------------------------------ the month ------------------------------ */}
      <section className="mb-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Month</span>
            <select
              value={monthId}
              onChange={(e) => setMonthId(e.target.value)}
              className="min-w-[11rem] rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
            >
              {months.length === 0 && <option value="">No months yet</option>}
              {months.map((m) => (
                <option key={m.id} value={m.id}>
                  {monthLabel(m.month)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">
              Open another month
            </span>
            <div className="flex items-center gap-2">
              <input
                type="month"
                value={newMonth}
                onChange={(e) => setNewMonth(e.target.value)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              />
              <button
                onClick={openMonth}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
              >
                <CalendarPlus className="h-4 w-4" />
                Open
              </button>
            </div>
          </label>

          {month && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">Paid on</span>
              <input
                type="date"
                value={month.paidOn}
                onChange={(e) => persist(setPaidOn(doc, month.id, e.target.value))}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              />
            </label>
          )}

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setShowSettings((was) => !was)}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
            >
              <Settings2 className="h-4 w-4" />
              Rates &amp; columns
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  showSettings && "rotate-180",
                )}
              />
            </button>
            {month && (
              <button
                onClick={dropMonth}
                title="Remove this month from the payroll"
                className="rounded-lg p-2 text-gray-300 transition hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {month && (
          <input
            value={month.note}
            onChange={(e) => persist(setMonthNote(doc, month.id, e.target.value))}
            maxLength={NOTE_MAX}
            placeholder="A note about this month, printed on the spreadsheet"
            className="mt-3 w-full rounded-lg border border-transparent bg-gray-50 px-3 py-2 text-sm outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-1 focus:ring-brand-500"
          />
        )}
      </section>

      {/* ----------------------------- settings ----------------------------- */}
      {showSettings && (
        <section className="mb-4 animate-fade-in rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Employer</h2>
              <p className="mt-1 text-xs text-gray-500">
                Printed at the top of every payslip.
              </p>
              <input
                value={doc.employer}
                onChange={(e) => persist(setEmployer(doc, e.target.value))}
                maxLength={EMPLOYER_MAX}
                placeholder="Your company name"
                className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              />

              <h2 className="mt-4 text-sm font-semibold text-gray-900">Rates</h2>
              <p className="mt-1 text-xs text-gray-500">
                The statutory figures are {DEFAULT_RATES.epfEmployee}% employee
                EPF, {DEFAULT_RATES.epfEmployer}% employer EPF and{" "}
                {DEFAULT_RATES.etf}% ETF.
              </p>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {(
                  [
                    ["epfEmployee", "EPF employee"],
                    ["epfEmployer", "EPF employer"],
                    ["etf", "ETF"],
                  ] as Array<["epfEmployee" | "epfEmployer" | "etf", string]>
                ).map(([key, label]) => (
                  <label key={key} className="flex flex-col gap-1">
                    <span className="text-xs text-gray-500">{label}</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.5}
                        value={doc.rates[key]}
                        onChange={(e) =>
                          persist(setRates(doc, { [key]: e.target.value }))
                        }
                        className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-right text-sm tabular-nums outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                      />
                      <span className="text-xs text-gray-400">%</span>
                    </div>
                  </label>
                ))}
              </div>
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Only the employee&apos;s EPF is taken off a wage. The
                employer&apos;s EPF and the ETF are the company&apos;s own cost —
                ETF may not lawfully be deducted from anybody&apos;s pay, so
                neither is subtracted from the net figure.
              </p>
            </div>

            <div>
              <h2 className="text-sm font-semibold text-gray-900">
                Extra columns
              </h2>
              <p className="mt-1 text-xs text-gray-500">
                Add your own — PAYE, a transport allowance, a salary advance.
                Each becomes a column on every month and a line on the payslip.
                {doc.fields.length}/{MAX_FIELDS} used.
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  value={fieldLabel}
                  onChange={(e) => setFieldLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createField();
                  }}
                  maxLength={FIELD_LABEL_MAX}
                  placeholder="Column name"
                  className="min-w-[9rem] flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                />
                <select
                  value={fieldKind}
                  onChange={(e) =>
                    setFieldKind(e.target.value as "allowance" | "deduction")
                  }
                  className="rounded-lg border border-gray-300 px-2 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                >
                  <option value="deduction">Deduction</option>
                  <option value="allowance">Allowance</option>
                </select>
                <button
                  onClick={createField}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
                >
                  <Plus className="h-4 w-4" />
                  Add
                </button>
              </div>

              <ul className="mt-3 space-y-1.5">
                {doc.fields.length === 0 && (
                  <li className="text-xs text-gray-400">
                    No extra columns yet.
                  </li>
                )}
                {doc.fields.map((field) => (
                  <li key={field.id} className="flex items-center gap-2">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                        field.kind === "allowance"
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-amber-50 text-amber-700",
                      )}
                    >
                      {field.kind === "allowance" ? "Pay" : "Deduct"}
                    </span>
                    <input
                      value={field.label}
                      onChange={(e) =>
                        persist(renameField(doc, field.id, e.target.value))
                      }
                      maxLength={FIELD_LABEL_MAX}
                      className="min-w-0 flex-1 rounded border border-transparent px-2 py-1 text-sm outline-none transition hover:border-gray-200 focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                    />
                    <button
                      onClick={() => {
                        persist(removeField(doc, field.id));
                        setNotice(
                          `"${field.label}" removed, along with every figure that was in it.`,
                        );
                      }}
                      title="Remove this column and its figures"
                      className="rounded p-1 text-gray-300 transition hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      {/* ------------------------------- no month ------------------------------ */}
      {!month && (
        <section className="rounded-2xl border-2 border-dashed border-gray-300 bg-white/70 px-6 py-16 text-center">
          <Users className="mx-auto h-10 w-10 text-gray-300" />
          <p className="mt-3 text-sm font-medium text-gray-700">
            No payroll yet
          </p>
          <p className="mt-1 text-sm text-gray-500">
            Pick a month above and open it. The following months carry the same
            people forward.
          </p>
        </section>
      )}

      {/* -------------------------------- totals ------------------------------ */}
      {month && totals && (
        <section className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              label: "People",
              value: String(totals.people),
              sub: `${missingTins(month)} without a TIN`,
            },
            {
              label: "Wages to staff",
              value: formatLKR(totals.net),
              sub: "net of deductions",
              strong: true,
            },
            {
              label: "EPF to remit",
              value: formatLKR(totals.epfRemittance),
              sub: `${formatLKR(totals.epfEmployee)} employee + ${formatLKR(totals.epfEmployer)} employer`,
            },
            {
              label: "ETF to remit",
              value: formatLKR(totals.etf),
              sub: "employer only",
            },
          ].map((card) => (
            <div
              key={card.label}
              className={cn(
                "rounded-2xl border bg-white p-4 shadow-sm",
                card.strong ? "border-brand-200 bg-brand-50/40" : "border-gray-200",
              )}
            >
              <p className="text-xs font-medium text-gray-500">{card.label}</p>
              <p className="mt-1 text-lg font-bold tabular-nums text-gray-900">
                {card.value}
              </p>
              <p className="mt-0.5 text-xs text-gray-500">{card.sub}</p>
            </div>
          ))}
        </section>
      )}

      {impossible.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <p className="flex items-start gap-2 font-medium">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {impossible.length === 1
              ? `${impossible[0]} has more deducted than earned.`
              : `${impossible.length} people have more deducted than earned.`}
          </p>
          <p className="mt-1 pl-6 text-xs text-amber-800">
            Payslips cannot be produced while a net wage is negative, because a
            payslip is a promise to pay. Check the deductions on the highlighted
            rows.
          </p>
        </div>
      )}

      {/* -------------------------------- the grid ---------------------------- */}
      {month && doc && (
        <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[64rem] text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2 font-semibold">Name</th>
                  <th className="px-3 py-2 font-semibold">TIN</th>
                  <th className="px-3 py-2 text-right font-semibold">Gross</th>
                  {allowances.map((f) => (
                    <th
                      key={f.id}
                      className="px-3 py-2 text-right font-semibold text-emerald-700"
                    >
                      {f.label}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-semibold">
                    EPF {doc.rates.epfEmployee}%
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">Other</th>
                  {deductions.map((f) => (
                    <th
                      key={f.id}
                      className="px-3 py-2 text-right font-semibold text-amber-700"
                    >
                      {f.label}
                    </th>
                  ))}
                  <th className="bg-brand-50/60 px-3 py-2 text-right font-semibold text-brand-700">
                    Net salary
                  </th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-400">
                    EPF {doc.rates.epfEmployer}%
                  </th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-400">
                    ETF {doc.rates.etf}%
                  </th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {month.rows.map((row, i) => (
                  <Row
                    key={row.id}
                    row={row}
                    index={i}
                    doc={doc}
                    monthId={month.id}
                    persist={persist}
                    building={building}
                    onPayslip={() =>
                      download("payslip", {
                        rowId: row.id,
                        filename: payslipFilename(row.name, month.month),
                        tag: row.id,
                      })
                    }
                  />
                ))}
                {month.rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={8 + doc.fields.length}
                      className="px-3 py-8 text-center text-sm text-gray-500"
                    >
                      Nobody on this month&apos;s payroll yet.
                    </td>
                  </tr>
                )}
              </tbody>
              {totals && month.rows.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-brand-200 bg-brand-50/40 font-semibold">
                    <td className="px-3 py-2.5" colSpan={2}>
                      Total — {totals.people}{" "}
                      {totals.people === 1 ? "person" : "people"}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {formatLKR(totals.gross)}
                    </td>
                    {allowances.map((f) => (
                      <td key={f.id} className="px-3 py-2.5 text-right tabular-nums">
                        {formatLKR(
                          month.rows.reduce(
                            (sum, r) => sum + (r.extras[f.id] ?? 0),
                            0,
                          ),
                        )}
                      </td>
                    ))}
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {formatLKR(totals.epfEmployee)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {formatLKR(totals.otherDeductions)}
                    </td>
                    {deductions.map((f) => (
                      <td key={f.id} className="px-3 py-2.5 text-right tabular-nums">
                        {formatLKR(
                          month.rows.reduce(
                            (sum, r) => sum + (r.extras[f.id] ?? 0),
                            0,
                          ),
                        )}
                      </td>
                    ))}
                    <td className="bg-brand-100/60 px-3 py-2.5 text-right tabular-nums text-brand-900">
                      {formatLKR(totals.net)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-400">
                      {formatLKR(totals.epfEmployer)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-400">
                      {formatLKR(totals.etf)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-3 py-3">
            <button
              onClick={() => {
                if (month.rows.length >= MAX_ROWS) {
                  setError(`That is as many people as one month can hold (${MAX_ROWS}).`);
                  return;
                }
                persist(addRow(doc, month.id));
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
            >
              <Plus className="h-4 w-4" />
              Add someone
            </button>
            <p className="text-xs text-gray-400">
              The two greyed columns are the company&apos;s contributions. They
              are not deducted from anybody&apos;s pay.
            </p>
          </div>
        </section>
      )}

      {/* ------------------------------- downloads ---------------------------- */}
      {month && (
        <section className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={() =>
              download("month", {
                filename: `${doc.employer ? `${doc.employer} - ` : ""}Payroll - ${monthLabel(month.month)}.xlsx`,
                tag: "month",
              })
            }
            disabled={building !== null || month.rows.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-40"
          >
            {building === "month" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <SheetIcon className="h-4 w-4" />
            )}
            {building === "month" ? "Building…" : "This month"}
          </button>

          <button
            onClick={() =>
              download("year", {
                filename: `${doc.employer ? `${doc.employer} - ` : ""}Payroll ${month.month.slice(0, 4)}.xlsx`,
                tag: "year",
              })
            }
            disabled={building !== null}
            title="Every month of this year on its own tab, with a summary for the annual returns"
            className="inline-flex items-center gap-2 rounded-lg border border-emerald-300 bg-white px-4 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:opacity-40"
          >
            {building === "year" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <SheetIcon className="h-4 w-4" />
            )}
            {building === "year" ? "Building…" : `All of ${month.month.slice(0, 4)}`}
          </button>

          <button
            onClick={() =>
              download("payslips", {
                filename: `Payslips - ${monthLabel(month.month)} - office copy.pdf`,
                tag: "payslips",
              })
            }
            disabled={building !== null || !ready}
            title="Every payslip in one file, for the office folder"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:opacity-40"
          >
            {building === "payslips" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileText className="h-4 w-4" />
            )}
            {building === "payslips" ? "Building…" : "All payslips"}
          </button>

          <p className="text-xs text-gray-400">
            {ready
              ? "Individual payslips download from the row. The office copy holds everybody, so it is not the one to hand out."
              : "Payslips need every row named and no negative wage."}
          </p>
        </section>
      )}
    </main>
  );
}

/* ---------------------------------- a row --------------------------------- */

function Row({
  row,
  index,
  doc,
  monthId,
  persist,
  building,
  onPayslip,
}: {
  row: PayrollRow;
  index: number;
  doc: PayrollDoc;
  monthId: string;
  persist: (next: PayrollDoc) => void;
  building: Building;
  onPayslip: () => void;
}) {
  const figures = rowFigures(row, doc.fields, doc.rates);
  const allowances = doc.fields.filter((f) => f.kind === "allowance");
  const deductions = doc.fields.filter((f) => f.kind === "deduction");

  const cell =
    "w-24 rounded-md border border-transparent bg-transparent px-2 py-1 text-right tabular-nums outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-1 focus:ring-brand-500";

  return (
    <tr
      className={cn(
        "border-b border-gray-100 transition-colors hover:bg-brand-50/40",
        index % 2 === 1 && "bg-gray-50/60",
        figures.overDeducted && "bg-amber-50/70 hover:bg-amber-50",
      )}
    >
      <td className="px-3 py-1.5">
        <input
          value={row.name}
          onChange={(e) =>
            persist(setRowText(doc, monthId, row.id, "name", e.target.value))
          }
          maxLength={NAME_MAX}
          placeholder="Full name"
          className="w-40 rounded-md border border-transparent px-2 py-1 outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-1 focus:ring-brand-500"
        />
      </td>
      <td className="px-3 py-1.5">
        <input
          value={row.tin}
          onChange={(e) =>
            persist(setRowText(doc, monthId, row.id, "tin", e.target.value))
          }
          maxLength={TIN_MAX}
          placeholder="TIN"
          className="w-28 rounded-md border border-transparent px-2 py-1 tabular-nums outline-none transition hover:border-gray-200 focus:border-brand-500 focus:bg-white focus:ring-1 focus:ring-brand-500"
        />
      </td>
      <td className="px-3 py-1.5 text-right">
        <input
          type="number"
          min={0}
          step={500}
          value={row.gross === 0 ? "" : row.gross}
          placeholder="0"
          aria-label={`Gross salary for ${row.name || "this person"}`}
          onChange={(e) =>
            persist(setRowMoney(doc, monthId, row.id, "gross", e.target.value))
          }
          className={cell}
        />
      </td>

      {allowances.map((f) => (
        <td key={f.id} className="px-3 py-1.5 text-right">
          <input
            type="number"
            min={0}
            step={500}
            value={row.extras[f.id] ? row.extras[f.id] : ""}
            placeholder="0"
            aria-label={`${f.label} for ${row.name || "this person"}`}
            onChange={(e) =>
              persist(setRowExtra(doc, monthId, row.id, f.id, e.target.value))
            }
            className={cell}
          />
        </td>
      ))}

      {/* The employee's EPF: worked out, but typeable for a probation month. */}
      <td className="px-3 py-1.5 text-right">
        <input
          type="number"
          min={0}
          step={100}
          value={figures.epfEmployee === 0 ? "" : figures.epfEmployee}
          aria-label={`EPF deducted from ${row.name || "this person"}`}
          title={
            figures.overridden.epfEmployee
              ? "Typed in for this month. Clear it to go back to the rate."
              : `Worked out at ${doc.rates.epfEmployee}% of gross. Type over it if this month is different.`
          }
          onChange={(e) =>
            persist(
              setRowOverride(
                doc,
                monthId,
                row.id,
                "epfEmployee",
                e.target.value,
              ),
            )
          }
          className={cn(
            cell,
            figures.overridden.epfEmployee &&
              "border-blue-200 bg-blue-50/60 text-blue-900",
          )}
        />
      </td>

      <td className="px-3 py-1.5 text-right">
        <input
          type="number"
          min={0}
          step={500}
          value={row.otherDeductions === 0 ? "" : row.otherDeductions}
          placeholder="0"
          aria-label={`Other deductions for ${row.name || "this person"}`}
          onChange={(e) =>
            persist(
              setRowMoney(doc, monthId, row.id, "otherDeductions", e.target.value),
            )
          }
          className={cell}
        />
      </td>

      {deductions.map((f) => (
        <td key={f.id} className="px-3 py-1.5 text-right">
          <input
            type="number"
            min={0}
            step={500}
            value={row.extras[f.id] ? row.extras[f.id] : ""}
            placeholder="0"
            aria-label={`${f.label} for ${row.name || "this person"}`}
            onChange={(e) =>
              persist(setRowExtra(doc, monthId, row.id, f.id, e.target.value))
            }
            className={cell}
          />
        </td>
      ))}

      <td
        className={cn(
          "bg-brand-50/60 px-3 py-2 text-right font-semibold tabular-nums",
          figures.overDeducted ? "text-red-700" : "text-brand-900",
        )}
      >
        {formatLKR(figures.net)}
      </td>

      <td className="px-3 py-2 text-right tabular-nums text-gray-400">
        {formatLKR(figures.epfEmployer)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-gray-400">
        {formatLKR(figures.etf)}
      </td>

      <td className="whitespace-nowrap px-2 py-1.5 text-right">
        <button
          onClick={onPayslip}
          disabled={building !== null || row.name.trim() === "" || figures.overDeducted}
          title={
            row.name.trim() === ""
              ? "Give this person a name first"
              : figures.overDeducted
                ? "The net wage is negative, so there is no payslip to give"
                : "Download this payslip"
          }
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-brand-700 transition hover:bg-brand-50 disabled:opacity-30"
        >
          {building === row.id ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileText className="h-3.5 w-3.5" />
          )}
          Payslip
        </button>
        <button
          onClick={() => persist(removeRow(doc, monthId, row.id))}
          title="Take this person off the month"
          className="ml-1 rounded-md p-1 text-gray-300 transition hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}

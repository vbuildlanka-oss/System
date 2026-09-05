/**
 * Wages, month by month.
 *
 * The shape of this file is decided by one piece of Sri Lankan payroll law that
 * is easy to get wrong, and expensive when you do:
 *
 *   EPF is 8% from the employee and 12% from the employer.
 *   ETF is 3% from the employer ONLY, and may not be deducted from wages.
 *
 * So ETF never touches net pay. It is an employer cost that is reported beside
 * the wage, not a deduction from it. Plenty of salary calculators online say
 * "net salary after EPF and ETF", and following them would quietly underpay
 * every employee by 3% of gross every month while also being unlawful. The
 * arithmetic here is arranged so that mistake is not expressible: `net` is built
 * from the employee's deductions alone, and the employer's contributions are
 * computed into a separate field that nothing subtracts.
 *
 * Everything else follows from wages being a monthly ritual with the same people
 * in it. A month is seeded from the month before, so nobody retypes twenty names
 * and TINs; the figures that vary - deductions, advances - come back empty, so a
 * stale number is never mistaken for this month's.
 */

import { readLocal, writeLocal } from "./storage";
import { clampNumber, LIMITS } from "./types";
import { sanitizeLine } from "./buyer";

export const PAYROLL_KEY = "balebook.payroll.v1";
export const PAYROLL_VERSION = 1;

/** People on one month's payroll. The same ceiling every document uses. */
export const MAX_ROWS = LIMITS.rows;
/** Months kept. Twenty years of wages is more history than anyone needs open. */
export const MAX_MONTHS = 240;
/**
 * Extra columns. Capped because every one of them widens the spreadsheet and
 * adds a line to every payslip, and a payslip nobody can read is not a payslip.
 */
export const MAX_FIELDS = 12;

export const NAME_MAX = 80;
export const TIN_MAX = 30;
export const FIELD_LABEL_MAX = 40;
export const NOTE_MAX = 160;
export const EMPLOYER_MAX = 80;

/** The statutory rates, and what they are called on a payslip. */
export const DEFAULT_RATES: PayrollRates = {
  epfEmployee: 8,
  epfEmployer: 12,
  etf: 3,
};

/* ---------------------------------- types --------------------------------- */

export interface PayrollRates {
  /** Percent of the EPF base taken off the employee's pay. */
  epfEmployee: number;
  /** Percent the employer adds on top. Not a deduction. */
  epfEmployer: number;
  /** Percent the employer pays to the trust fund. Never a deduction. */
  etf: number;
}

/**
 * A column somebody added themselves.
 *
 * An allowance is money paid; a deduction is money withheld. Nothing else about
 * a field is configurable, because the two kinds are the only thing the
 * arithmetic needs to know.
 */
export interface PayrollField {
  id: string;
  label: string;
  kind: "allowance" | "deduction";
}

/**
 * Figures that would normally be worked out from the rates, but were typed in
 * instead. Somebody on probation, a mid-month joiner or a no-pay stretch all
 * break the percentage, and a payroll that cannot express that gets edited in
 * Excel afterwards - at which point the sheet and this app disagree.
 *
 * `null` means "work it out"; a number means "this, exactly".
 */
export interface PayrollOverrides {
  epfEmployee: number | null;
  epfEmployer: number | null;
  etf: number | null;
}

export interface PayrollRow {
  id: string;
  name: string;
  /** Taxpayer Identification Number. Printed on the payslip as given. */
  tin: string;
  /** Contractual monthly pay, and the base the EPF percentages apply to. */
  gross: number;
  /** Anything withheld that has no column of its own. */
  otherDeductions: number;
  /** Values for the user-defined columns, keyed by field id. */
  extras: Record<string, number>;
  overrides: PayrollOverrides;
  note: string;
}

export interface PayrollMonth {
  id: string;
  /** "YYYY-MM". One payroll run per calendar month. */
  month: string;
  /** "YYYY-MM-DD", or "" while wages are still being prepared. */
  paidOn: string;
  rows: PayrollRow[];
  note: string;
}

export interface PayrollDoc {
  app: "balebook-payroll";
  version: number;
  /** Whose payroll it is. Printed at the top of every payslip. */
  employer: string;
  rates: PayrollRates;
  fields: PayrollField[];
  months: PayrollMonth[];
  updatedAt: string;
}

/* ------------------------------- construction ----------------------------- */

let seq = 0;
function uid(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}`;
}

export function emptyPayrollDoc(): PayrollDoc {
  return {
    app: "balebook-payroll",
    version: PAYROLL_VERSION,
    employer: "",
    rates: { ...DEFAULT_RATES },
    fields: [],
    months: [],
    updatedAt: new Date().toISOString(),
  };
}

function touch(doc: PayrollDoc, patch: Partial<PayrollDoc>): PayrollDoc {
  return { ...doc, ...patch, updatedAt: new Date().toISOString() };
}

/** Round to the cent. Percentages of a salary rarely land on one. */
export function money(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

export function createRow(input: {
  name?: unknown;
  tin?: unknown;
  gross?: unknown;
  otherDeductions?: unknown;
  extras?: unknown;
  overrides?: unknown;
  note?: unknown;
}): PayrollRow {
  const rawExtras =
    input.extras !== null && typeof input.extras === "object"
      ? (input.extras as Record<string, unknown>)
      : {};
  const extras: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawExtras)) {
    extras[String(key)] = money(clampNumber(value, LIMITS.money));
  }

  const rawOverrides =
    input.overrides !== null && typeof input.overrides === "object"
      ? (input.overrides as Record<string, unknown>)
      : {};

  return {
    id: uid("pr"),
    name: sanitizeLine(input.name, NAME_MAX),
    tin: sanitizeLine(input.tin, TIN_MAX),
    gross: money(clampNumber(input.gross, LIMITS.money)),
    otherDeductions: money(clampNumber(input.otherDeductions, LIMITS.money)),
    extras,
    overrides: {
      epfEmployee: readOverride(rawOverrides.epfEmployee),
      epfEmployer: readOverride(rawOverrides.epfEmployer),
      etf: readOverride(rawOverrides.etf),
    },
    note: sanitizeLine(input.note, NOTE_MAX),
  };
}

/** An override is a number or nothing. "" and null both mean "work it out". */
function readOverride(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return money(Math.min(n, LIMITS.money));
}

/* ---------------------------------- months -------------------------------- */

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * A real calendar date, "YYYY-MM-DD".
 *
 * Shape alone is not enough: "2026-13-99" and "2026-02-30" are both the right
 * shape and neither is a day. A paid-on date is printed on the wage sheet, so a
 * date that does not exist has no business getting that far.
 */
export function isDateKey(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** "YYYY-MM" for a date, or for now. */
export function monthKeyOf(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** True for a well-formed "YYYY-MM" with a real month number. */
export function isMonthKey(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

/** "2026-08" -> "August 2026". Written out, not localised, so it is stable. */
export function monthLabel(month: string): string {
  if (!isMonthKey(month)) return "Unknown month";
  const [year, m] = month.split("-");
  return `${MONTH_NAMES[Number(m) - 1]} ${year}`;
}

/** Newest month first, which is the one being worked on. */
export function monthsNewestFirst(doc: PayrollDoc): PayrollMonth[] {
  return [...doc.months].sort((a, b) => b.month.localeCompare(a.month));
}

export function findMonth(
  doc: PayrollDoc,
  monthId: string,
): PayrollMonth | null {
  return doc.months.find((m) => m.id === monthId) ?? null;
}

export interface AddMonthResult {
  doc: PayrollDoc;
  month: PayrollMonth | null;
  /** Why nothing was added, if nothing was. */
  problem: string;
}

/**
 * Open a month, carrying the staff forward.
 *
 * Names, TINs and gross pay come across, because those are the same in March as
 * they were in February. Deductions and advances do not: those are findings about
 * one particular month, and carrying them would put last month's advance into
 * this month's payslip where nobody would notice it.
 */
export function addMonth(doc: PayrollDoc, month: string): AddMonthResult {
  if (!isMonthKey(month)) {
    return { doc, month: null, problem: "That is not a month." };
  }
  if (doc.months.some((m) => m.month === month)) {
    return {
      doc,
      month: null,
      problem: `${monthLabel(month)} is already on the payroll.`,
    };
  }
  if (doc.months.length >= MAX_MONTHS) {
    return {
      doc,
      month: null,
      problem: `That is as many months as this can hold (${MAX_MONTHS}).`,
    };
  }

  // The latest month that is earlier than this one, so opening a missed month
  // out of order still copies from the month before it rather than from ahead.
  const earlier = doc.months
    .filter((m) => m.month < month)
    .sort((a, b) => b.month.localeCompare(a.month))[0];

  const rows: PayrollRow[] = (earlier?.rows ?? []).map((row) =>
    createRow({ name: row.name, tin: row.tin, gross: row.gross }),
  );

  const fresh: PayrollMonth = {
    id: uid("pm"),
    month,
    paidOn: "",
    rows,
    note: "",
  };
  return {
    doc: touch(doc, { months: [...doc.months, fresh] }),
    month: fresh,
    problem: "",
  };
}

export function removeMonth(doc: PayrollDoc, monthId: string): PayrollDoc {
  return touch(doc, { months: doc.months.filter((m) => m.id !== monthId) });
}

function mapMonth(
  doc: PayrollDoc,
  monthId: string,
  fn: (month: PayrollMonth) => PayrollMonth,
): PayrollDoc {
  return touch(doc, {
    months: doc.months.map((m) => (m.id === monthId ? fn(m) : m)),
  });
}

export function setPaidOn(
  doc: PayrollDoc,
  monthId: string,
  paidOn: string,
): PayrollDoc {
  const clean = isDateKey(paidOn) ? String(paidOn) : "";
  return mapMonth(doc, monthId, (m) => ({ ...m, paidOn: clean }));
}

export function setMonthNote(
  doc: PayrollDoc,
  monthId: string,
  note: string,
): PayrollDoc {
  return mapMonth(doc, monthId, (m) => ({
    ...m,
    note: sanitizeLine(note, NOTE_MAX),
  }));
}

/* ----------------------------------- rows --------------------------------- */

export function addRow(
  doc: PayrollDoc,
  monthId: string,
  input: { name?: string; tin?: string; gross?: number } = {},
): PayrollDoc {
  const month = findMonth(doc, monthId);
  if (!month || month.rows.length >= MAX_ROWS) return doc;
  return mapMonth(doc, monthId, (m) => ({
    ...m,
    rows: [...m.rows, createRow(input)],
  }));
}

export function removeRow(
  doc: PayrollDoc,
  monthId: string,
  rowId: string,
): PayrollDoc {
  return mapMonth(doc, monthId, (m) => ({
    ...m,
    rows: m.rows.filter((r) => r.id !== rowId),
  }));
}

function mapRow(
  doc: PayrollDoc,
  monthId: string,
  rowId: string,
  fn: (row: PayrollRow) => PayrollRow,
): PayrollDoc {
  return mapMonth(doc, monthId, (m) => ({
    ...m,
    rows: m.rows.map((r) => (r.id === rowId ? fn(r) : r)),
  }));
}

export function setRowText(
  doc: PayrollDoc,
  monthId: string,
  rowId: string,
  field: "name" | "tin" | "note",
  value: string,
): PayrollDoc {
  const max =
    field === "name" ? NAME_MAX : field === "tin" ? TIN_MAX : NOTE_MAX;
  return mapRow(doc, monthId, rowId, (r) => ({
    ...r,
    [field]: sanitizeLine(value, max),
  }));
}

export function setRowMoney(
  doc: PayrollDoc,
  monthId: string,
  rowId: string,
  field: "gross" | "otherDeductions",
  value: unknown,
): PayrollDoc {
  return mapRow(doc, monthId, rowId, (r) => ({
    ...r,
    [field]: money(clampNumber(value, LIMITS.money)),
  }));
}

export function setRowExtra(
  doc: PayrollDoc,
  monthId: string,
  rowId: string,
  fieldId: string,
  value: unknown,
): PayrollDoc {
  return mapRow(doc, monthId, rowId, (r) => ({
    ...r,
    extras: { ...r.extras, [fieldId]: money(clampNumber(value, LIMITS.money)) },
  }));
}

export function setRowOverride(
  doc: PayrollDoc,
  monthId: string,
  rowId: string,
  which: keyof PayrollOverrides,
  value: unknown,
): PayrollDoc {
  return mapRow(doc, monthId, rowId, (r) => ({
    ...r,
    overrides: { ...r.overrides, [which]: readOverride(value) },
  }));
}

/* ---------------------------------- fields -------------------------------- */

export interface AddFieldResult {
  doc: PayrollDoc;
  field: PayrollField | null;
  problem: string;
}

export function addField(
  doc: PayrollDoc,
  label: string,
  kind: "allowance" | "deduction",
): AddFieldResult {
  const clean = sanitizeLine(label, FIELD_LABEL_MAX);
  if (clean === "") {
    return { doc, field: null, problem: "Give the column a name." };
  }
  if (doc.fields.length >= MAX_FIELDS) {
    return {
      doc,
      field: null,
      problem: `That is as many extra columns as a payslip can carry (${MAX_FIELDS}).`,
    };
  }
  // One column per name, or a payslip would show two lines that read the same.
  if (
    doc.fields.some(
      (f) => f.label.toLowerCase() === clean.toLowerCase(),
    )
  ) {
    return { doc, field: null, problem: `There is already a "${clean}" column.` };
  }
  const field: PayrollField = { id: uid("pf"), label: clean, kind };
  return {
    doc: touch(doc, { fields: [...doc.fields, field] }),
    field,
    problem: "",
  };
}

export function renameField(
  doc: PayrollDoc,
  fieldId: string,
  label: string,
): PayrollDoc {
  const clean = sanitizeLine(label, FIELD_LABEL_MAX);
  if (clean === "") return doc;
  return touch(doc, {
    fields: doc.fields.map((f) => (f.id === fieldId ? { ...f, label: clean } : f)),
  });
}

/**
 * Drop a column, and every figure that was in it.
 *
 * The values go too. Leaving them behind would mean a deduction that is no
 * longer shown anywhere is still sitting in the file, ready to reappear the day
 * somebody adds a column with the same id.
 */
export function removeField(doc: PayrollDoc, fieldId: string): PayrollDoc {
  return touch(doc, {
    fields: doc.fields.filter((f) => f.id !== fieldId),
    months: doc.months.map((m) => ({
      ...m,
      rows: m.rows.map((r) => {
        const extras = { ...r.extras };
        delete extras[fieldId];
        return { ...r, extras };
      }),
    })),
  });
}

export function setRates(doc: PayrollDoc, patch: Partial<PayrollRates>): PayrollDoc {
  const rate = (value: unknown, fallback: number): number => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    // A contribution over the whole salary is a typo, not a policy.
    return Math.round(Math.min(n, 100) * 100) / 100;
  };
  return touch(doc, {
    rates: {
      epfEmployee:
        patch.epfEmployee === undefined
          ? doc.rates.epfEmployee
          : rate(patch.epfEmployee, doc.rates.epfEmployee),
      epfEmployer:
        patch.epfEmployer === undefined
          ? doc.rates.epfEmployer
          : rate(patch.epfEmployer, doc.rates.epfEmployer),
      etf: patch.etf === undefined ? doc.rates.etf : rate(patch.etf, doc.rates.etf),
    },
  });
}

export function setEmployer(doc: PayrollDoc, employer: string): PayrollDoc {
  return touch(doc, { employer: sanitizeLine(employer, EMPLOYER_MAX) });
}

/* --------------------------------- figures -------------------------------- */

export interface RowFigures {
  /** Everything paid: gross plus the allowance columns. */
  earnings: number;
  allowances: number;
  /**
   * What the EPF percentages are applied to.
   *
   * Gross only. Allowances are left out, because whether a given allowance is
   * EPF-liable depends on what it is, and guessing would be worse than the rule
   * being plain: if an allowance attracts EPF, it belongs in gross.
   */
  epfBase: number;
  /** Taken off the employee. The only contribution that reduces net pay. */
  epfEmployee: number;
  /** Paid by the employer on top. Never subtracted from a wage. */
  epfEmployer: number;
  /** Paid by the employer. Never subtracted from a wage. */
  etf: number;
  /** The "Other deductions" column. */
  otherDeductions: number;
  /** Everything in a deduction column somebody added. */
  customDeductions: number;
  /** epfEmployee + otherDeductions + customDeductions. */
  totalDeductions: number;
  net: number;
  /** What the employee costs: earnings plus the employer's two contributions. */
  employerCost: number;
  /** True when the deductions come to more than the pay. */
  overDeducted: boolean;
  /** Set where a figure was typed in rather than worked out. */
  overridden: { epfEmployee: boolean; epfEmployer: boolean; etf: boolean };
}

function percentOf(base: number, percent: number): number {
  return money((base * percent) / 100);
}

export function rowFigures(
  row: PayrollRow,
  fields: PayrollField[],
  rates: PayrollRates,
): RowFigures {
  let allowances = 0;
  let customDeductions = 0;
  for (const field of fields) {
    const value = money(clampNumber(row.extras[field.id], LIMITS.money));
    if (field.kind === "allowance") allowances += value;
    else customDeductions += value;
  }
  allowances = money(allowances);
  customDeductions = money(customDeductions);

  const epfBase = row.gross;
  const epfEmployee =
    row.overrides.epfEmployee ?? percentOf(epfBase, rates.epfEmployee);
  const epfEmployer =
    row.overrides.epfEmployer ?? percentOf(epfBase, rates.epfEmployer);
  const etf = row.overrides.etf ?? percentOf(epfBase, rates.etf);

  const earnings = money(row.gross + allowances);
  const totalDeductions = money(
    epfEmployee + row.otherDeductions + customDeductions,
  );
  // ETF and the employer's EPF are deliberately absent from this line. They are
  // the company's cost, not the employee's, and subtracting either would be
  // both wrong arithmetic and an unlawful deduction.
  const net = money(earnings - totalDeductions);

  return {
    earnings,
    allowances,
    epfBase,
    epfEmployee,
    epfEmployer,
    etf,
    otherDeductions: row.otherDeductions,
    customDeductions,
    totalDeductions,
    net,
    employerCost: money(earnings + epfEmployer + etf),
    overDeducted: net < 0,
    overridden: {
      epfEmployee: row.overrides.epfEmployee !== null,
      epfEmployer: row.overrides.epfEmployer !== null,
      etf: row.overrides.etf !== null,
    },
  };
}

export interface MonthTotals {
  people: number;
  gross: number;
  allowances: number;
  earnings: number;
  epfEmployee: number;
  epfEmployer: number;
  etf: number;
  otherDeductions: number;
  customDeductions: number;
  totalDeductions: number;
  net: number;
  employerCost: number;
  /** EPF employee + EPF employer, which is what gets remitted as one payment. */
  epfRemittance: number;
}

export function monthTotals(
  month: PayrollMonth,
  fields: PayrollField[],
  rates: PayrollRates,
): MonthTotals {
  const totals: MonthTotals = {
    people: month.rows.length,
    gross: 0,
    allowances: 0,
    earnings: 0,
    epfEmployee: 0,
    epfEmployer: 0,
    etf: 0,
    otherDeductions: 0,
    customDeductions: 0,
    totalDeductions: 0,
    net: 0,
    employerCost: 0,
    epfRemittance: 0,
  };
  for (const row of month.rows) {
    const f = rowFigures(row, fields, rates);
    totals.gross = money(totals.gross + row.gross);
    totals.allowances = money(totals.allowances + f.allowances);
    totals.earnings = money(totals.earnings + f.earnings);
    totals.epfEmployee = money(totals.epfEmployee + f.epfEmployee);
    totals.epfEmployer = money(totals.epfEmployer + f.epfEmployer);
    totals.etf = money(totals.etf + f.etf);
    totals.otherDeductions = money(totals.otherDeductions + f.otherDeductions);
    totals.customDeductions = money(totals.customDeductions + f.customDeductions);
    totals.totalDeductions = money(totals.totalDeductions + f.totalDeductions);
    totals.net = money(totals.net + f.net);
    totals.employerCost = money(totals.employerCost + f.employerCost);
  }
  totals.epfRemittance = money(totals.epfEmployee + totals.epfEmployer);
  return totals;
}

/** Total of one added column across a month, for the spreadsheet's total row. */
export function fieldTotal(
  month: PayrollMonth,
  fieldId: string,
): number {
  return money(
    month.rows.reduce(
      (sum, row) => sum + money(clampNumber(row.extras[fieldId], LIMITS.money)),
      0,
    ),
  );
}

/* -------------------------------- readiness ------------------------------- */

/** People with no name. A payslip has to be addressed to somebody. */
export function missingNames(month: PayrollMonth): number {
  return month.rows.filter((r) => r.name.trim() === "").length;
}

/** People whose deductions exceed their pay, who cannot be paid as recorded. */
export function overDeductedNames(
  month: PayrollMonth,
  fields: PayrollField[],
  rates: PayrollRates,
): string[] {
  return month.rows
    .filter((r) => rowFigures(r, fields, rates).overDeducted)
    .map((r) => r.name || "(unnamed)");
}

/** People with no TIN. Worth saying, but it does not stop a payslip. */
export function missingTins(month: PayrollMonth): number {
  return month.rows.filter((r) => r.tin.trim() === "").length;
}

/**
 * Whether this month can be paid out.
 *
 * A negative net is a hard stop rather than a warning: it means the deductions
 * were entered wrong, and a payslip promising a negative wage is not a document
 * anybody should be able to hand over.
 */
export function isMonthReady(
  month: PayrollMonth,
  fields: PayrollField[],
  rates: PayrollRates,
): boolean {
  return (
    month.rows.length > 0 &&
    missingNames(month) === 0 &&
    overDeductedNames(month, fields, rates).length === 0
  );
}

/* ------------------------------- persistence ------------------------------ */

function parseRates(input: unknown): PayrollRates {
  const raw = (input ?? {}) as Record<string, unknown>;
  const rate = (value: unknown, fallback: number): number => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.round(Math.min(n, 100) * 100) / 100;
  };
  return {
    epfEmployee: rate(raw.epfEmployee, DEFAULT_RATES.epfEmployee),
    epfEmployer: rate(raw.epfEmployer, DEFAULT_RATES.epfEmployer),
    etf: rate(raw.etf, DEFAULT_RATES.etf),
  };
}

export function parsePayrollDoc(input: unknown): PayrollDoc {
  const raw = (input ?? {}) as Record<string, unknown>;

  const rawFields = Array.isArray(raw.fields) ? raw.fields : [];
  const fields: PayrollField[] = [];
  for (const entry of rawFields.slice(0, MAX_FIELDS)) {
    const f = (entry ?? {}) as Record<string, unknown>;
    const label = sanitizeLine(f.label, FIELD_LABEL_MAX);
    if (label === "") continue;
    const id = sanitizeLine(f.id, 60) || uid("pf");
    // Anything that is not a deduction is money paid, which is the safer
    // reading: an unknown kind must not silently take money off somebody.
    fields.push({ id, label, kind: f.kind === "deduction" ? "deduction" : "allowance" });
  }

  const knownFieldIds = new Set(fields.map((f) => f.id));

  const rawMonths = Array.isArray(raw.months) ? raw.months : [];
  const months: PayrollMonth[] = [];
  const seenMonths = new Set<string>();
  for (const entry of rawMonths.slice(0, MAX_MONTHS)) {
    const m = (entry ?? {}) as Record<string, unknown>;
    const month = String(m.month ?? "");
    if (!isMonthKey(month) || seenMonths.has(month)) continue;
    seenMonths.add(month);

    const rawRows = Array.isArray(m.rows) ? m.rows : [];
    const rows: PayrollRow[] = rawRows.slice(0, MAX_ROWS).map((rowEntry) => {
      const r = (rowEntry ?? {}) as Record<string, unknown>;
      const built = createRow(r);
      // Values for columns that no longer exist are dropped, so a deleted
      // column cannot come back to life with its old figures attached.
      const extras: Record<string, number> = {};
      for (const [key, value] of Object.entries(built.extras)) {
        if (knownFieldIds.has(key)) extras[key] = value;
      }
      return {
        ...built,
        extras,
        id: sanitizeLine(r.id, 60) || built.id,
      };
    });

    months.push({
      id: sanitizeLine(m.id, 60) || uid("pm"),
      month,
      paidOn: isDateKey(m.paidOn) ? String(m.paidOn) : "",
      rows,
      note: sanitizeLine(m.note, NOTE_MAX),
    });
  }

  return {
    app: "balebook-payroll",
    version: Number(raw.version) || PAYROLL_VERSION,
    employer: sanitizeLine(raw.employer, EMPLOYER_MAX),
    rates: parseRates(raw.rates),
    fields,
    months,
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
  };
}

export function loadPayrollDoc(): PayrollDoc {
  if (typeof window === "undefined") return emptyPayrollDoc();
  try {
    const raw = readLocal(PAYROLL_KEY);
    if (!raw) return emptyPayrollDoc();
    return parsePayrollDoc(JSON.parse(raw));
  } catch {
    return emptyPayrollDoc();
  }
}

export function savePayrollDoc(doc: PayrollDoc): void {
  writeLocal(PAYROLL_KEY, JSON.stringify(doc));
}

/* -------------------------------- filenames ------------------------------- */

function clean(value: string): string {
  return value.replace(/[^\w\d\- ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** `Payroll - August 2026.xlsx`, or the whole year when no month is given. */
export function payrollFilename(
  month: string | null,
  ext = "xlsx",
  employer = "",
): string {
  const who = clean(employer);
  const what = month === null ? "Payroll" : `Payroll - ${monthLabel(month)}`;
  const stem = who === "" ? what : `${who} - ${what}`;
  return `${stem}.${ext.replace(/[^\w]+/g, "")}`;
}

/** `Payroll - 2026 - Year.xlsx` for the twelve-month workbook. */
export function payrollYearFilename(
  year: string,
  ext = "xlsx",
  employer = "",
): string {
  const who = clean(employer);
  const what = `Payroll ${clean(year) || "Year"}`;
  const stem = who === "" ? what : `${who} - ${what}`;
  return `${stem}.${ext.replace(/[^\w]+/g, "")}`;
}

/** `Payslip - Nimal Perera - August 2026.pdf`. */
export function payslipFilename(
  name: string,
  month: string,
  ext = "pdf",
): string {
  const who = clean(name) || "Employee";
  return `Payslip - ${who} - ${monthLabel(month)}.${ext.replace(/[^\w]+/g, "")}`;
}

/**
 * `Payslips - August 2026 - office copy.pdf`.
 *
 * The name says what it is, because this one file holds everybody's pay and must
 * not be sent to a person by mistake.
 */
export function payslipsFilename(month: string, ext = "pdf"): string {
  return `Payslips - ${monthLabel(month)} - office copy.${ext.replace(/[^\w]+/g, "")}`;
}

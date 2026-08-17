/**
 * The balance sheet: what went out, what came in, and what is left.
 *
 * Two kinds of entry:
 *
 *   EXPENSES  a name, the partner it belongs to, and an amount. An expense may
 *             optionally be tied to a container, which is what makes profit per
 *             container possible.
 *
 *   TURNOVER  a container ID and what that container brought in.
 *
 * The arithmetic is deliberately explicit about scope, because that is where a
 * balance sheet misleads people. An expense with no container is general
 * overhead: it counts towards the net profit for the business but NOT towards
 * any single container's profit, since attributing it to one container would be
 * a guess. Both figures are reported separately rather than blended.
 *
 * Nothing is stored that can be derived. Totals, profits and margins are always
 * recomputed from the entries, so a figure can never drift from the rows it came
 * from.
 */

import { readLocal, writeLocal } from "./storage";
import { clampNumber, LIMITS } from "./types";
import { sanitizeLine } from "./buyer";
import { normalizeContainerNumber } from "./container";

export const BALANCE_KEY = "balebook.balanceSheet.v1";
export const BALANCE_VERSION = 1;
/** Enough for years of trading without the browser store growing unbounded. */
export const MAX_ENTRIES = 2000;

/* --------------------------------- model --------------------------------- */

export interface Expense {
  id: string;
  /** What it was for, e.g. "Customs duty". */
  name: string;
  /** Which partner it belongs to. */
  partner: string;
  /** Amount in LKR. */
  amount: number;
  /**
   * Container this expense belongs to, or "" for general overhead.
   * Only attributed expenses affect a container's profit.
   */
  containerId: string;
  /** ISO date, used for ordering and the CSV. */
  at: string;
  note: string;
}

export interface TurnoverEntry {
  id: string;
  /** The container that earned it. */
  containerId: string;
  /** What it brought in, in LKR. */
  turnover: number;
  at: string;
  note: string;
}

/**
 * Which way an outstanding balance points.
 *
 * Both directions exist because "balance to be paid" is asked in both: money
 * still owed to a partner or supplier, and money a buyer still owes. Keeping them
 * in one ledger with a direction means the two never have to be reconciled
 * against each other by hand.
 */
export type BalanceDirection = "payable" | "receivable";

/**
 * An amount still outstanding.
 *
 * Deliberately NOT tied to an expense. Its first job is to carry forward what was
 * already owed before any of this was written down, which has no expense behind
 * it. That independence is also why an outstanding balance is kept out of the
 * profit arithmetic: an expense already recorded and a balance recording what is
 * left to pay on it would otherwise count the same money twice. See
 * balanceDueTotals.
 */
export interface BalanceDue {
  id: string;
  /** Who it is with - a partner, a supplier or a buyer. */
  party: string;
  direction: BalanceDirection;
  /** The whole amount agreed. */
  amount: number;
  /** How much of it has been settled so far. */
  paid: number;
  /** Container it relates to, or "" when it stands on its own. */
  containerId: string;
  /** Order number it relates to, or "". */
  orderNumber: string;
  /** ISO date it falls due, or "" when there is no date. */
  dueAt: string;
  /** ISO date it was recorded. */
  at: string;
  note: string;
}

export interface BalanceSheet {
  app: "balebook-balance-sheet";
  version: number;
  expenses: Expense[];
  turnover: TurnoverEntry[];
  /** Outstanding balances. Absent on documents saved before this existed. */
  balances: BalanceDue[];
  updatedAt: string;
}

export function emptyBalanceSheet(): BalanceSheet {
  return {
    app: "balebook-balance-sheet",
    version: BALANCE_VERSION,
    expenses: [],
    turnover: [],
    balances: [],
    updatedAt: new Date().toISOString(),
  };
}

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

/* ------------------------------ construction ------------------------------ */

export const EXPENSE_NAME_MAX = 80;
export const PARTNER_MAX = 60;
export const NOTE_MAX = 120;

export function createExpense(input: {
  name?: unknown;
  partner?: unknown;
  amount?: unknown;
  containerId?: unknown;
  note?: unknown;
  at?: unknown;
}): Expense {
  return {
    id: uid("ex"),
    name: sanitizeLine(input.name, EXPENSE_NAME_MAX),
    partner: sanitizeLine(input.partner, PARTNER_MAX),
    amount: clampNumber(input.amount, LIMITS.money),
    containerId: normalizeContainerNumber(input.containerId),
    at: isoOrNow(input.at),
    note: sanitizeLine(input.note, NOTE_MAX),
  };
}

export function createTurnover(input: {
  containerId?: unknown;
  turnover?: unknown;
  note?: unknown;
  at?: unknown;
}): TurnoverEntry {
  return {
    id: uid("tv"),
    containerId: normalizeContainerNumber(input.containerId),
    turnover: clampNumber(input.turnover, LIMITS.money),
    at: isoOrNow(input.at),
    note: sanitizeLine(input.note, NOTE_MAX),
  };
}

export const PARTY_MAX = 60;
export const ORDER_NUMBER_MAX = 80;

/**
 * A date with no time on it, e.g. "2026-08-20", or "" when there is none.
 *
 * Due dates are compared against each other and against today, so the time of
 * day is noise: an amount due "on the 20th" is not due at midnight.
 */
function isoDateOrEmpty(value: unknown): string {
  if (typeof value === "number" || value instanceof Date) {
    const time = new Date(value as never).getTime();
    return Number.isNaN(time) ? "" : new Date(time).toISOString().slice(0, 10);
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return "";
  const time = Date.parse(text);
  return Number.isNaN(time) ? "" : new Date(time).toISOString().slice(0, 10);
}

export function createBalanceDue(input: {
  party?: unknown;
  direction?: unknown;
  amount?: unknown;
  paid?: unknown;
  containerId?: unknown;
  orderNumber?: unknown;
  dueAt?: unknown;
  note?: unknown;
  at?: unknown;
}): BalanceDue {
  return {
    id: uid("bd"),
    party: sanitizeLine(input.party, PARTY_MAX),
    // Anything unrecognised is read as money we owe, which is what "balance to
    // be paid" means unless it says otherwise.
    direction: input.direction === "receivable" ? "receivable" : "payable",
    amount: clampNumber(input.amount, LIMITS.money),
    paid: clampNumber(input.paid, LIMITS.money),
    containerId: normalizeContainerNumber(input.containerId),
    orderNumber: sanitizeLine(input.orderNumber, ORDER_NUMBER_MAX),
    dueAt: isoDateOrEmpty(input.dueAt),
    at: isoOrNow(input.at),
    note: sanitizeLine(input.note, NOTE_MAX),
  };
}

function isoOrNow(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString();
}

/* -------------------------------- validation ------------------------------ */

export interface ExpenseCheck {
  ok: boolean;
  message?: string;
}

/**
 * An expense is only worth recording with a name and an amount. The partner is
 * required too: an unattributed expense makes the per-partner breakdown lie by
 * omission.
 */
export function checkExpense(input: {
  name: string;
  partner: string;
  amount: number | null;
}): ExpenseCheck {
  if (input.name.trim() === "") {
    return { ok: false, message: "Give the expense a name." };
  }
  if (input.partner.trim() === "") {
    return { ok: false, message: "Say which partner this expense belongs to." };
  }
  if (input.amount === null || Number.isNaN(input.amount)) {
    return { ok: false, message: "Enter the amount." };
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, message: "The amount must be more than nothing." };
  }
  if (input.amount > LIMITS.money) {
    return { ok: false, message: "That amount is unrealistically large." };
  }
  return { ok: true };
}

export function checkTurnover(input: {
  containerId: string;
  turnover: number | null;
}): ExpenseCheck {
  if (input.containerId.trim() === "") {
    return { ok: false, message: "Enter the container ID." };
  }
  if (input.turnover === null || Number.isNaN(input.turnover)) {
    return { ok: false, message: "Enter the turnover." };
  }
  if (!Number.isFinite(input.turnover) || input.turnover <= 0) {
    return { ok: false, message: "The turnover must be more than nothing." };
  }
  if (input.turnover > LIMITS.money) {
    return { ok: false, message: "That turnover is unrealistically large." };
  }
  return { ok: true };
}

/**
 * A balance needs somebody to settle it with and an amount to settle.
 *
 * Paid is refused when it exceeds the total. It is almost always a typo, and
 * accepting it would leave a negative balance that reads as money owed the other
 * way - a wrong number that looks like a fact.
 */
export function checkBalanceDue(input: {
  party: string;
  amount: number | null;
  paid?: number | null;
}): ExpenseCheck {
  if (input.party.trim() === "") {
    return { ok: false, message: "Say who this balance is with." };
  }
  if (input.amount === null || Number.isNaN(input.amount)) {
    return { ok: false, message: "Enter the total amount." };
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, message: "The amount must be more than nothing." };
  }
  if (input.amount > LIMITS.money) {
    return { ok: false, message: "That amount is unrealistically large." };
  }

  const paid = input.paid ?? 0;
  if (paid !== null && Number.isNaN(paid)) {
    return { ok: false, message: "Enter how much has been paid, or leave it at 0." };
  }
  if (!Number.isFinite(paid) || paid < 0) {
    return { ok: false, message: "Paid cannot be less than nothing." };
  }
  if (paid > input.amount) {
    return {
      ok: false,
      message: "Paid is more than the total. Raise the total, or lower what was paid.",
    };
  }
  return { ok: true };
}

/* ----------------------------- balances due ------------------------------- */

/** What is left to settle. Never negative, whatever is in the stored figures. */
export function balanceOutstanding(balance: BalanceDue): number {
  return Math.max(0, balance.amount - balance.paid);
}

export type BalanceDueStatus = "settled" | "part-paid" | "unpaid";

export function balanceDueStatus(balance: BalanceDue): BalanceDueStatus {
  if (balanceOutstanding(balance) === 0) return "settled";
  return balance.paid > 0 ? "part-paid" : "unpaid";
}

/** Today, as a plain date, so a due date can be compared without a clock. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Past its due date with something still outstanding.
 *
 * A balance due today is not overdue, and one with no due date never is - an
 * undated balance is a note to self, not a deadline.
 */
export function isBalanceOverdue(balance: BalanceDue, today = todayIso()): boolean {
  if (balance.dueAt === "") return false;
  if (balanceOutstanding(balance) === 0) return false;
  return balance.dueAt < today;
}

export interface BalanceDueTotals {
  /** Everything agreed, by direction. */
  payable: number;
  receivable: number;
  /** What is left to settle, by direction. */
  payableOutstanding: number;
  receivableOutstanding: number;
  /** Settled so far, both directions together. */
  paid: number;
  /**
   * Owed to us less what we owe. Positive means more is coming in than going
   * out. This is a position, not profit: see the note on BalanceDue.
   */
  net: number;
  overdueAmount: number;
  overdueCount: number;
  settledCount: number;
  count: number;
}

/**
 * The state of the ledger.
 *
 * Kept apart from balanceTotals on purpose. An outstanding balance is not an
 * expense: the expense may already be recorded, in which case adding the balance
 * to it would count the same money twice, and it may equally be for something
 * from before any of this was written down. So nothing here touches net profit,
 * and the page reports the two side by side rather than merging them.
 */
export function balanceDueTotals(
  sheet: BalanceSheet,
  today = todayIso(),
): BalanceDueTotals {
  const totals: BalanceDueTotals = {
    payable: 0,
    receivable: 0,
    payableOutstanding: 0,
    receivableOutstanding: 0,
    paid: 0,
    net: 0,
    overdueAmount: 0,
    overdueCount: 0,
    settledCount: 0,
    count: sheet.balances.length,
  };

  for (const balance of sheet.balances) {
    const left = balanceOutstanding(balance);
    totals.paid += Math.min(balance.paid, balance.amount);

    if (balance.direction === "receivable") {
      totals.receivable += balance.amount;
      totals.receivableOutstanding += left;
    } else {
      totals.payable += balance.amount;
      totals.payableOutstanding += left;
    }

    if (left === 0) totals.settledCount += 1;
    if (isBalanceOverdue(balance, today)) {
      totals.overdueAmount += left;
      totals.overdueCount += 1;
    }
  }

  totals.net = totals.receivableOutstanding - totals.payableOutstanding;
  return totals;
}

export interface PartyResult {
  party: string;
  payableOutstanding: number;
  receivableOutstanding: number;
  /** Owed to us less what we owe, for this party alone. */
  net: number;
  overdueCount: number;
  count: number;
}

/**
 * One row per party, biggest outstanding first.
 *
 * A party that is owed money and owes money appears once, with both figures, so
 * the two can be seen against each other instead of in separate lists.
 */
export function byParty(sheet: BalanceSheet, today = todayIso()): PartyResult[] {
  const map = new Map<string, PartyResult>();

  for (const balance of sheet.balances) {
    const key = balance.party.trim() || "Unassigned";
    let row = map.get(key);
    if (!row) {
      row = {
        party: key,
        payableOutstanding: 0,
        receivableOutstanding: 0,
        net: 0,
        overdueCount: 0,
        count: 0,
      };
      map.set(key, row);
    }
    const left = balanceOutstanding(balance);
    if (balance.direction === "receivable") row.receivableOutstanding += left;
    else row.payableOutstanding += left;
    if (isBalanceOverdue(balance, today)) row.overdueCount += 1;
    row.count += 1;
  }

  const rows = Array.from(map.values());
  for (const row of rows) {
    row.net = row.receivableOutstanding - row.payableOutstanding;
  }
  return rows.sort(
    (a, b) =>
      b.payableOutstanding + b.receivableOutstanding -
        (a.payableOutstanding + a.receivableOutstanding) ||
      a.party.localeCompare(b.party),
  );
}

/** Parties already on the ledger, for autocomplete. */
export function partyNames(sheet: BalanceSheet): string[] {
  const names = new Set<string>();
  for (const balance of sheet.balances) {
    if (balance.party !== "") names.add(balance.party);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/* -------------------------------- totals --------------------------------- */

export interface BalanceTotals {
  turnover: number;
  expenses: number;
  /** Turnover less every expense, general overhead included. */
  netProfit: number;
  /** Net profit as a percentage of turnover, or null when nothing came in. */
  margin: number | null;
  /** Expenses tied to a container. */
  attributedExpenses: number;
  /** Expenses not tied to any container. */
  generalExpenses: number;
}

export function balanceTotals(sheet: BalanceSheet): BalanceTotals {
  const turnover = sheet.turnover.reduce((s, t) => s + t.turnover, 0);

  let attributed = 0;
  let general = 0;
  for (const expense of sheet.expenses) {
    if (expense.containerId === "") general += expense.amount;
    else attributed += expense.amount;
  }
  const expenses = attributed + general;

  return {
    turnover,
    expenses,
    netProfit: turnover - expenses,
    margin: turnover > 0 ? ((turnover - expenses) / turnover) * 100 : null,
    attributedExpenses: attributed,
    generalExpenses: general,
  };
}

/* ---------------------------- per-container view --------------------------- */

export interface ContainerResult {
  containerId: string;
  turnover: number;
  /** Only expenses tagged with this container. */
  expenses: number;
  profit: number;
  margin: number | null;
  expenseCount: number;
}

/**
 * Profit for each container, from expenses tagged to it only.
 *
 * A container appears if it has turnover, expenses, or both, so a container that
 * has cost money but not yet earned any is still visible rather than hidden.
 */
export function byContainer(sheet: BalanceSheet): ContainerResult[] {
  const map = new Map<string, ContainerResult>();

  const slot = (containerId: string): ContainerResult => {
    const found = map.get(containerId);
    if (found) return found;
    const created: ContainerResult = {
      containerId,
      turnover: 0,
      expenses: 0,
      profit: 0,
      margin: null,
      expenseCount: 0,
    };
    map.set(containerId, created);
    return created;
  };

  for (const entry of sheet.turnover) slot(entry.containerId).turnover += entry.turnover;
  for (const expense of sheet.expenses) {
    if (expense.containerId === "") continue;
    const row = slot(expense.containerId);
    row.expenses += expense.amount;
    row.expenseCount += 1;
  }

  return Array.from(map.values())
    .map((row) => ({
      ...row,
      profit: row.turnover - row.expenses,
      margin: row.turnover > 0 ? ((row.turnover - row.expenses) / row.turnover) * 100 : null,
    }))
    .sort((a, b) => a.containerId.localeCompare(b.containerId));
}

/* ----------------------------- per-partner view ---------------------------- */

export interface PartnerResult {
  partner: string;
  expenses: number;
  count: number;
  /** Share of all expenses, as a percentage. */
  share: number | null;
}

export function byPartner(sheet: BalanceSheet): PartnerResult[] {
  const map = new Map<string, PartnerResult>();
  let total = 0;

  for (const expense of sheet.expenses) {
    const key = expense.partner.trim() || "Unassigned";
    const found = map.get(key);
    if (found) {
      found.expenses += expense.amount;
      found.count += 1;
    } else {
      map.set(key, { partner: key, expenses: expense.amount, count: 1, share: null });
    }
    total += expense.amount;
  }

  return Array.from(map.values())
    .map((row) => ({
      ...row,
      share: total > 0 ? (row.expenses / total) * 100 : null,
    }))
    .sort((a, b) => b.expenses - a.expenses);
}

/** Partner names already used, for quick re-entry. */
export function partnerNames(sheet: BalanceSheet): string[] {
  const names = new Set<string>();
  for (const expense of sheet.expenses) {
    const name = expense.partner.trim();
    if (name !== "") names.add(name);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/** Container IDs already used anywhere on the sheet. */
export function containerIds(sheet: BalanceSheet): string[] {
  const ids = new Set<string>();
  for (const entry of sheet.turnover) {
    if (entry.containerId !== "") ids.add(entry.containerId);
  }
  for (const expense of sheet.expenses) {
    if (expense.containerId !== "") ids.add(expense.containerId);
  }
  return Array.from(ids).sort((a, b) => a.localeCompare(b));
}

/* -------------------------------- mutation -------------------------------- */

function touch(sheet: BalanceSheet, patch: Partial<BalanceSheet>): BalanceSheet {
  return { ...sheet, ...patch, updatedAt: new Date().toISOString() };
}

export function addExpense(sheet: BalanceSheet, expense: Expense): BalanceSheet {
  return touch(sheet, {
    expenses: [expense, ...sheet.expenses].slice(0, MAX_ENTRIES),
  });
}

export function removeExpense(sheet: BalanceSheet, id: string): BalanceSheet {
  return touch(sheet, { expenses: sheet.expenses.filter((e) => e.id !== id) });
}

export function updateExpense(
  sheet: BalanceSheet,
  id: string,
  patch: Partial<Omit<Expense, "id">>,
): BalanceSheet {
  return touch(sheet, {
    expenses: sheet.expenses.map((e) =>
      e.id === id
        ? {
            ...e,
            ...patch,
            name:
              patch.name === undefined
                ? e.name
                : sanitizeLine(patch.name, EXPENSE_NAME_MAX),
            partner:
              patch.partner === undefined
                ? e.partner
                : sanitizeLine(patch.partner, PARTNER_MAX),
            amount:
              patch.amount === undefined
                ? e.amount
                : clampNumber(patch.amount, LIMITS.money),
            containerId:
              patch.containerId === undefined
                ? e.containerId
                : normalizeContainerNumber(patch.containerId),
          }
        : e,
    ),
  });
}

export function addTurnover(
  sheet: BalanceSheet,
  entry: TurnoverEntry,
): BalanceSheet {
  return touch(sheet, {
    turnover: [entry, ...sheet.turnover].slice(0, MAX_ENTRIES),
  });
}

export function removeTurnover(sheet: BalanceSheet, id: string): BalanceSheet {
  return touch(sheet, { turnover: sheet.turnover.filter((t) => t.id !== id) });
}

export function updateTurnover(
  sheet: BalanceSheet,
  id: string,
  patch: Partial<Omit<TurnoverEntry, "id">>,
): BalanceSheet {
  return touch(sheet, {
    turnover: sheet.turnover.map((t) =>
      t.id === id
        ? {
            ...t,
            ...patch,
            containerId:
              patch.containerId === undefined
                ? t.containerId
                : normalizeContainerNumber(patch.containerId),
            turnover:
              patch.turnover === undefined
                ? t.turnover
                : clampNumber(patch.turnover, LIMITS.money),
          }
        : t,
    ),
  });
}

export function addBalanceDue(
  sheet: BalanceSheet,
  balance: BalanceDue,
): BalanceSheet {
  return touch(sheet, {
    balances: [balance, ...sheet.balances].slice(0, MAX_ENTRIES),
  });
}

export function removeBalanceDue(sheet: BalanceSheet, id: string): BalanceSheet {
  return touch(sheet, { balances: sheet.balances.filter((b) => b.id !== id) });
}

export function updateBalanceDue(
  sheet: BalanceSheet,
  id: string,
  patch: Partial<Omit<BalanceDue, "id">>,
): BalanceSheet {
  return touch(sheet, {
    balances: sheet.balances.map((b) =>
      b.id === id
        ? {
            ...b,
            ...patch,
            // Re-sanitised on the way in, so an edit cannot put something in the
            // ledger that could not have been typed there in the first place.
            party: patch.party === undefined ? b.party : sanitizeLine(patch.party, PARTY_MAX),
            amount:
              patch.amount === undefined ? b.amount : clampNumber(patch.amount, LIMITS.money),
            paid: patch.paid === undefined ? b.paid : clampNumber(patch.paid, LIMITS.money),
            containerId:
              patch.containerId === undefined
                ? b.containerId
                : normalizeContainerNumber(patch.containerId),
            orderNumber:
              patch.orderNumber === undefined
                ? b.orderNumber
                : sanitizeLine(patch.orderNumber, ORDER_NUMBER_MAX),
            dueAt: patch.dueAt === undefined ? b.dueAt : isoDateOrEmpty(patch.dueAt),
            note: patch.note === undefined ? b.note : sanitizeLine(patch.note, NOTE_MAX),
          }
        : b,
    ),
  });
}

/** Record a payment against a balance, never taking it past the total. */
export function settleBalanceDue(
  sheet: BalanceSheet,
  id: string,
  payment: number,
): BalanceSheet {
  const balance = sheet.balances.find((b) => b.id === id);
  if (!balance) return sheet;
  const added = clampNumber(payment, LIMITS.money);
  return updateBalanceDue(sheet, id, {
    paid: Math.min(balance.amount, balance.paid + added),
  });
}

/* ------------------------------ persistence ------------------------------- */

export function parseBalanceSheet(input: unknown): BalanceSheet {
  const raw = (input ?? {}) as Record<string, unknown>;
  const rawExpenses = Array.isArray(raw.expenses) ? raw.expenses : [];
  const rawTurnover = Array.isArray(raw.turnover) ? raw.turnover : [];

  const expenses: Expense[] = rawExpenses
    .slice(0, MAX_ENTRIES)
    .map((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      const built = createExpense(e);
      return { ...built, id: String(e.id ?? built.id) };
    })
    // A nameless or free expense is noise, not data.
    .filter((e) => e.name !== "" && e.amount > 0);

  const turnover: TurnoverEntry[] = rawTurnover
    .slice(0, MAX_ENTRIES)
    .map((entry) => {
      const t = (entry ?? {}) as Record<string, unknown>;
      const built = createTurnover(t);
      return { ...built, id: String(t.id ?? built.id) };
    })
    .filter((t) => t.containerId !== "" && t.turnover > 0);

  // Absent on documents saved before balances existed, so a missing field is
  // read as an empty ledger rather than as a broken document.
  const rawBalances = Array.isArray(raw.balances) ? raw.balances : [];
  const balances: BalanceDue[] = rawBalances
    .slice(0, MAX_ENTRIES)
    .map((entry) => {
      const b = (entry ?? {}) as Record<string, unknown>;
      const built = createBalanceDue(b);
      return { ...built, id: String(b.id ?? built.id) };
    })
    // Nobody to chase, or nothing to chase them for, is noise rather than data.
    .filter((b) => b.party !== "" && b.amount > 0);

  return {
    app: "balebook-balance-sheet",
    version: Number(raw.version) || BALANCE_VERSION,
    expenses,
    turnover,
    balances,
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
  };
}

export function loadBalanceSheet(): BalanceSheet {
  if (typeof window === "undefined") return emptyBalanceSheet();
  try {
    const raw = readLocal(BALANCE_KEY);
    if (!raw) return emptyBalanceSheet();
    return parseBalanceSheet(JSON.parse(raw));
  } catch {
    return emptyBalanceSheet();
  }
}

export function saveBalanceSheet(sheet: BalanceSheet): void {
  writeLocal(BALANCE_KEY, JSON.stringify(sheet));
}

/* --------------------------------- export --------------------------------- */

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The name of an export. Dated, so a folder of them sorts into order on its own
 * and one export never quietly overwrites another.
 */
export function datedFilename(
  label: string,
  ext: string,
  on: Date = new Date(),
): string {
  const safe = Number.isNaN(on.getTime()) ? new Date() : on;
  // The time is in the name, not just the date. Two exports on the same day
  // would otherwise both be "<label> <date>.xlsx", and the browser would save
  // the second as "... (1).xlsx" - leaving the older file sitting under the
  // obvious name, which is exactly how a stale sheet gets opened by mistake.
  const stamp = safe.toISOString().slice(0, 16).replace("T", " ").replace(":", "");
  return `${label} ${stamp}.${ext.replace(/[^\w]+/g, "")}`;
}

/** The whole sheet: turnover, expenses, profit. */
export function balanceFilename(ext: string, on: Date = new Date()): string {
  return datedFilename("Balance Sheet", ext, on);
}

/** The expenses on their own, named so it cannot be mistaken for the full sheet. */
export function expensesFilename(ext: string, on: Date = new Date()): string {
  return datedFilename("Expenses", ext, on);
}

/**
 * One CSV holding both halves of the sheet, then the summary, so it opens as a
 * readable statement rather than needing two files stitched together.
 */
export function balanceToCsv(sheet: BalanceSheet): string {
  const lines: string[] = [];
  const totals = balanceTotals(sheet);

  lines.push(["Section", "Date", "Container", "Detail", "Partner", "Amount"].map(csvCell).join(","));

  for (const entry of [...sheet.turnover].sort((a, b) => a.at.localeCompare(b.at))) {
    lines.push(
      ["Turnover", entry.at.slice(0, 10), entry.containerId, entry.note, "", entry.turnover]
        .map(csvCell)
        .join(","),
    );
  }
  for (const expense of [...sheet.expenses].sort((a, b) => a.at.localeCompare(b.at))) {
    lines.push(
      [
        "Expense",
        expense.at.slice(0, 10),
        expense.containerId || "(general)",
        expense.name,
        expense.partner,
        expense.amount,
      ]
        .map(csvCell)
        .join(","),
    );
  }

  lines.push("");
  lines.push([csvCell("Total turnover"), "", "", "", "", totals.turnover].join(","));
  lines.push([csvCell("Total expenses"), "", "", "", "", totals.expenses].join(","));
  lines.push([csvCell("Net profit"), "", "", "", "", totals.netProfit].join(","));

  lines.push("");
  lines.push(["Container", "Turnover", "Expenses", "Profit"].map(csvCell).join(","));
  for (const row of byContainer(sheet)) {
    lines.push(
      [row.containerId, row.turnover, row.expenses, row.profit].map(csvCell).join(","),
    );
  }
  if (totals.generalExpenses > 0) {
    lines.push(
      [csvCell("(general, not per container)"), "", totals.generalExpenses, ""].join(","),
    );
  }

  lines.push("");
  lines.push(["Partner", "Expenses", "Entries"].map(csvCell).join(","));
  for (const row of byPartner(sheet)) {
    lines.push([row.partner, row.expenses, row.count].map(csvCell).join(","));
  }

  // Balances get a block of their own rather than being squeezed into the rows
  // above: they have a total, a paid figure and a due date, and none of those fit
  // the shape of an expense. The heading is the one the importer reads back.
  if (sheet.balances.length > 0) {
    const dues = balanceDueTotals(sheet);
    lines.push("");
    lines.push(
      ["Party", "Direction", "Total", "Paid", "Outstanding", "Due", "Container", "Order number", "Status"]
        .map(csvCell)
        .join(","),
    );
    for (const balance of [...sheet.balances].sort((a, b) =>
      (a.dueAt || "9999").localeCompare(b.dueAt || "9999"),
    )) {
      lines.push(
        [
          balance.party,
          balance.direction === "receivable" ? "Owed to us" : "We owe",
          balance.amount,
          balance.paid,
          balanceOutstanding(balance),
          balance.dueAt,
          balance.containerId,
          balance.orderNumber,
          isBalanceOverdue(balance) ? "overdue" : balanceDueStatus(balance),
        ]
          .map(csvCell)
          .join(","),
      );
    }
    lines.push("");
    lines.push([csvCell("Still to pay"), "", "", "", dues.payableOutstanding].join(","));
    lines.push([csvCell("Still to receive"), "", "", "", dues.receivableOutstanding].join(","));
    lines.push([csvCell("Net position"), "", "", "", dues.net].join(","));
  }

  return lines.join("\n");
}

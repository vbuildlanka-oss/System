/**
 * What a file this app generated turns back into when it is uploaded again.
 *
 * Deliberately a module with no imports, like labels.ts: pages need these types
 * and the messages below, and the reader that produces them (restore.ts) pulls in
 * the spreadsheet library, which must stay out of the browser bundle.
 *
 * The point of the whole thing: every download is also a backup. Upload last
 * month's count sheet, payroll workbook or calculation and the page it came from
 * picks up where it left off - counts as counts, markups as markups - instead of
 * treating it as a fresh supplier order and throwing half of it away.
 *
 * Supplier files never produce a restore. Recognising one of ours depends on
 * things only this app prints: the BALEBOOK wordmark on a PDF, or the exact
 * sheet names and column headings of its own workbooks and CSVs.
 */

export interface RestoredCountRow {
  name: string;
  /** null when the sheet listed the item with an empty cell: not counted. */
  counted: number | null;
}

export interface RestoredLot {
  name: string;
  bags: number;
  perBag: number;
  source: string;
  /** "YYYY-MM-DD", or "" when the file did not say. */
  addedOn: string;
}

export interface RestoredRequestItem {
  name: string;
  qty: number;
  supplied: number;
  perBag: number;
  note: string;
}

export interface RestoredRequest {
  buyerName: string;
  buyerPhone: string;
  notes: string;
  items: RestoredRequestItem[];
}

export interface RestoredCalcRow {
  name: string;
  qty: number;
  costPerBag: number;
  markup: number;
  fast: boolean;
}

export interface RestoredPayrollRow {
  name: string;
  tin: string;
  gross: number;
  otherDeductions: number;
  /** Added column values, keyed by the column's heading. */
  extras: Record<string, number>;
  /** A contribution that did not match the rate, so was typed in. */
  overrides: {
    epfEmployee: number | null;
    epfEmployer: number | null;
    etf: number | null;
  };
  note: string;
}

export interface RestoredPayrollMonth {
  /** "YYYY-MM". */
  month: string;
  paidOn: string;
  rows: RestoredPayrollRow[];
}

export interface RestoredPayroll {
  employer: string;
  rates: { epfEmployee: number; epfEmployer: number; etf: number } | null;
  fields: Array<{ label: string; kind: "allowance" | "deduction" }>;
  months: RestoredPayrollMonth[];
}

export interface RestoredSheetBuyer {
  name: string;
  phone: string;
  refNo: string;
}

export type Restore =
  /** A buyer's price list. Its prices include the markup, so they are not costs. */
  | { kind: "buyer-price-list"; orderNumber: string }
  | {
      kind: "count";
      orderNumber: string;
      containerId: string;
      rows: RestoredCountRow[];
    }
  | {
      kind: "manifest";
      orderNumber: string;
      containerNumber: string;
    }
  | { kind: "calculation"; orderNumber: string; rows: RestoredCalcRow[] }
  | { kind: "stockpile"; lots: RestoredLot[]; detailed: boolean }
  | { kind: "requests"; requests: RestoredRequest[] }
  | { kind: "payroll"; payroll: RestoredPayroll }
  /** An order sheet this app printed: updated sheet, sales receipt. */
  | { kind: "sheet"; buyer: RestoredSheetBuyer | null };

export type RestoreKind = Restore["kind"];

/** Where each kind of file belongs, for telling someone they are on the wrong page. */
export const RESTORE_HOME: Record<RestoreKind, { href: string; page: string; what: string }> = {
  "buyer-price-list": { href: "/", page: "Price List", what: "a buyer's price list" },
  count: { href: "/counter", page: "Counter", what: "a bag count" },
  manifest: { href: "/bag-manifests", page: "Bag Manifests", what: "a bag manifest" },
  calculation: { href: "/calculation", page: "Calculation", what: "a markup calculation" },
  stockpile: { href: "/stockpile", page: "Stockpile", what: "a stockpile export" },
  requests: { href: "/requests", page: "Requests", what: "a buyer request list" },
  payroll: { href: "/payroll", page: "Payroll", what: "a payroll workbook" },
  sheet: { href: "/edit", page: "Order Editor", what: "an order sheet" },
};

/**
 * A sentence for a file that belongs to a different page, or "" when it is
 * welcome here. Only used where the file has nothing this page can use - a
 * manifest uploaded to the Counter is a perfectly good list to count against.
 */
export function wrongPageMessage(restore: Restore | undefined, here: string): string {
  if (!restore) return "";
  const home = RESTORE_HOME[restore.kind];
  if (home.href === here) return "";
  return `That is ${home.what} from BaleBook. Upload it on the ${home.page} page to restore it.`;
}

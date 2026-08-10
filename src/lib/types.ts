export interface OrderItem {
  name: string;
  qty: number;
  /** Original per-bag price from the uploaded order (in LKR). */
  perBag: number;
}

export interface ParsedOrder {
  /** Title from the top of the sheet, e.g. "Sri Lanka Order 3 2026". */
  title: string;
  items: OrderItem[];
  /** Sum of qty across all items. */
  totalQty: number;
  /** Sum of (qty * perBag) computed from the parsed rows. */
  computedTotal: number;
  /** The grand total printed on the source PDF, if we could read it. */
  printedTotal: number | null;
  /**
   * True when the printed total matches our computed total (within Rs 1).
   * When false, the UI warns the user that parsing may be incomplete.
   */
  totalsMatch: boolean;
}

/** A single row after the buyer markup has been applied. */
export interface BuyerRow {
  name: string;
  qty: number;
  perBag: number;
  total: number;
}

export interface BuyerPriceList {
  title: string;
  markup: number;
  rows: BuyerRow[];
  totalQty: number;
  grandTotal: number;
}

/** Apply a flat per-bag markup and recalculate every total. */
export function buildBuyerPriceList(
  order: Pick<ParsedOrder, "title" | "items">,
  markup: number,
): BuyerPriceList {
  let totalQty = 0;
  let grandTotal = 0;
  const rows: BuyerRow[] = order.items.map((item) => {
    const perBag = item.perBag + markup;
    const total = item.qty * perBag;
    totalQty += item.qty;
    grandTotal += total;
    return { name: item.name, qty: item.qty, perBag, total };
  });
  return { title: order.title, markup, rows, totalQty, grandTotal };
}

/** Format a number as "Rs1,234,567.00". */
export function formatLKR(value: number): string {
  return (
    "Rs" +
    value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

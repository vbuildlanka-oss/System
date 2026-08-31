# Plan: count in the warehouse, price it afterwards

Written up so it is not lost. Nothing in this plan has been built yet.

## Why

We do not know which container will be cleared first, so a workflow that starts
from a container's order sheet does not fit. The count has to come first:

```
  warehouse                    office
  ─────────                    ──────
  Counter                      Buyer Price List
  name the container           upload the count PDF
  count the bag types          assign the original price per item
  export PDF  ──────────────►  add the markup as usual
                               download the buyer's copy
```

The Buyer Price List must keep doing exactly what it does today for a normal
order PDF with all its columns. Reading a count PDF is an **additional** input,
not a replacement.

## Part 1 — the Counter exports a PDF as well as Excel

| | |
|---|---|
| New | `src/lib/counterPdf.tsx` |
| Change | `src/app/api/count-export/route.ts` — take `format: "pdf" \| "xlsx"` |
| Change | `src/app/counter/page.tsx` — a second download button |

`/api/bag-manifest` already serves both formats from one route; copy that shape.

**The layout is a contract, not a design choice.** This PDF gets uploaded back and
parsed, so it must be readable by `parseOrder.ts`:

- Two columns, `Item` and `Count`, matching the spreadsheet.
- It **must** print a `Total <bags>` line. `parseOrder.ts` has a separate path for
  quantity-only lists (no prices), and that path resolves ambiguous rows — is
  `Anorak 29` the item "Anorak 2" with 9 bags, or "Anorak" with 29? — by making the
  quantities add up to the printed total. Without the total line, every item whose
  name ends in a digit is a coin toss. `Anorak 2`, `Anorak #2` and `Blanket 3` are
  all real items on these lists.
- The total line must match `/^Total\s*(\d+)$/i`.
- No prices, and no heading or footer line ending in a digit, or the parser will try
  to read it as an item.

**Decision to make:** items nobody counted. Recommendation: leave them out of the
PDF entirely — the PDF is the count being handed over — and state the number in a
footer sentence that does not end in a digit, so the parser ignores it. The
spreadsheet keeps listing them with an empty cell, as it does now.

Filename: `<Order> - <Container> - Bag Count.pdf`.

## Part 2 — the Buyer Price List takes a count and lets you price it

| | |
|---|---|
| Change | `src/app/page.tsx` |
| New | `src/lib/priceBook.ts` |
| Change | `src/lib/appData.ts` — register the two new stores |

No parser change is needed. `/api/process` already returns `perBag: 0` for a
quantity-only list, and the page already notices missing prices.

1. **An editable `Cost / bag` column.** Always editable, for correcting a figure on
   a normal order sheet too.
2. **When prices are missing, say so and block the download.** "12 items still need
   a price." Downloading with a zero cost would hand the buyer a price equal to the
   markup alone — the one mistake this page must never make. A loud banner is not
   enough; disable the button and list what is missing.
3. **The markup is untouched.** Selling stays `cost + markup`, and everything
   downstream — `buildBuyerPriceList`, the buyer PDF, the reference number — works
   as it does today.
4. **Persist the sheet in progress.** New key `balebook.priceList.v1`. Eighty-five
   typed prices must survive a refresh or a dropped connection; losing them would be
   worse than not having the feature.

### The price book — the part that saves the most time

New store `balebook.priceBook.v1`: `normalizeItemKey(name)` → the last cost used for
that item.

- On upload, auto-fill every item we have priced before.
- Mark auto-filled prices differently from typed ones, so it is obvious what came
  from memory and what was decided now.
- Update the book when a price list is downloaded.

The second count onwards, most of the sheet fills itself. Without this, every count
means retyping eighty-five prices, and the feature will not get used.

## What must not change

- A full order PDF parses exactly as now: 85 items, 733 bags, totals verified.
- The buyer PDF carries no cost, no markup and no container. Enforced by
  `verify-shipment.ts` and `verify-calculation.ts`, which read the PDF's text back.
- The count spreadsheet stays two columns with no prices.
- The request-layout fix in `parseOrder.ts` stays — it is what stops `Anorak210`.
- **Only `/` and `/counter` are touched.** Bag Manifests, Balance Sheet,
  Calculation, Requests, Stockpile, Order Editor and Saved Data are left alone.
- Never import a label or helper from an ExcelJS or `@react-pdf` module into client
  code. That mistake has cost 260 kB of browser bundle twice; `src/lib/labels.ts`
  exists precisely to avoid it.

## Tests

New `scripts/verify-count-to-price.ts`, the round trip end to end:

- Build a count PDF, read it with `parseOrderPdf`, and check the names and
  quantities come back exactly, with no prices.
- Items whose names end in digits survive: `Anorak 2`, `Anorak #2`, `Blanket 3`.
  This is the check that justifies the total line.
- Assigning costs gives `selling = cost + markup` and the right grand total.
- The download is refused while any item lacks a price.
- The price book fills a second upload and records prices on download.
- The buyer PDF still carries no cost, markup or container.

Also extend `verify-counter.ts` for the PDF format, and `verify-appdata.ts` for the
new stores — its section and key counts are asserted exactly and will fail until
updated (8 sections → 10, 11 keys → 13).

## Order of work

1. Counter PDF + the round-trip test. Proves the loop closes before any UI is built.
2. Price list: cost column, the block, persistence.
3. The price book.
4. Suites green, README, push.

Steps 1 and 2 are independently useful. If credits run short, stop after 2 — the
feature works, it is just slower to use.

## Housekeeping found on 31 Aug

`src/app/bag-lists/` and `src/app/api/bag-list/` were untracked leftovers of the
original "Order Bag Lists" work, superseded by `/bag-manifests`. They imported
`@/lib/bagList*`, which no longer exists, and **broke `npm run build`**. Deleted;
they were never in the repo, so nothing tracked changed. `webapp/` is a similar
leftover scaffold, still untracked and left alone.

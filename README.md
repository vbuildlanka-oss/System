# BaleBook

Order sheets, sales and stockpile tracking for a clothing import business.
Everything runs on PDF and JSON files, so there is no database to maintain.

Built with Next.js, TypeScript and Tailwind CSS.

---

## 1. Price List (`/`)

Upload a supplier order PDF, add a per-bag markup (default **Rs 2,000**), preview
the recalculated table, and download a clean, buyer-ready price list PDF.

- **Upload** an order PDF (drag & drop or browse)
- **Automatic parsing** of Item / Quantity / Per Bag / Total rows
- **Markup** added to every per-bag price (editable, defaults to Rs 2,000) with
  all line totals and the grand total recalculated instantly
- **Live preview** table before you download
- **Validation**: the app compares its computed total against the total printed
  on the source PDF and warns you if they don't match
- **Buyer details**: name and phone are printed at the top of the PDF, with an
  auto-numbered (editable) reference
- **Download** a branded, multi-page PDF

## 2. Order Editor (`/edit`)

Upload a sheet, edit it as bags sell, then download the updated PDF. Use this to
keep a live sheet as customers buy.

- **Edit any value** inline: item name, quantity, per-bag price, and total
- **Total is auto-calculated** (Qty x Per Bag). Type into the Total cell to
  override it — the row is flagged amber and a reset arrow restores the
  calculation, so a manual figure is never silently hidden
- **Record a sale**: enter bags sold, stock is reduced (never below zero) and the
  sale is logged with its value
- **Add / duplicate / delete** rows, **search**, and **hide sold-out** items
- **Undo / redo** everything, including sales (`Ctrl/Cmd+Z`)
- **Autosave** to your browser, so a refresh never loses work
- **Save session** as a `.json` file and reload it later to resume
- **Download** an *Updated* sheet PDF, plus an optional *Sales Receipt* PDF for
  the bags sold in the session

### Buyers

Both pages have a buyer section (name + phone), printed on the PDF as a
**PREPARED FOR** block alongside a **REFERENCE** number.

- **Phone validation** understands Sri Lankan formats (`0771234567`,
  `077 123 4567`, `+94 77 123 4567`, `771234567`) and normalises them to
  `+94 77 123 4567`. International numbers are accepted with a leading `+`.
- If a number isn't recognised, you get a gentle warning but it is still printed
  **exactly as you typed it** — the app never silently rewrites your input.
- A **WhatsApp button** appears next to any valid number for one-tap messaging.
- **Recent buyers** are remembered in your browser, so regulars can be picked
  from a dropdown instead of retyped.
- In the editor, each **sale is attributed to a buyer** (defaulting to the sheet
  buyer). When several buyers bought in one session you can generate a
  **receipt for a single buyer**.
- Buyer input is sanitised server-side (control characters stripped, length
  capped) so a bad paste can never break the PDF.

## 3. Stockpile (`/stockpile`)

When sales are slow, leftover bags don't disappear — they get set aside and
mixed with leftovers from earlier orders. The stockpile is that carried-forward
inventory.

- **Send leftovers straight from the editor** — one click moves every remaining
  bag into the stockpile, tagged with the order it came from, and clears the
  sheet so nothing is counted twice (undoable).
- **Batch tracking** — the same item can arrive from several orders at different
  prices. Each batch keeps its own price, source and date:

  ```
  Blanket
    +- 12 bags @ Rs20,000  from "Order 3"  added 95 days ago
    +-  5 bags @ Rs22,000  from "Order 4"  added  8 days ago
  ```

- **Ageing view** — a breakdown bar splits your bags into under 30 / 30-59 /
  60-89 / 90+ days. Click any band to filter the table. Dead stock (90+ days)
  raises a warning with the cash value sitting idle.
- **FIFO withdrawals** — removing bags takes the oldest batch first, and shows
  you exactly which batches will be drawn and what they're worth before you
  confirm. Stock can never go negative.
- **Automatic item merging** — `Anorak #2` from one order lands on the existing
  `Anorak 2`, so leftovers combine instead of fragmenting. Genuinely different
  grades stay separate, and anything ambiguous (`Ladies Tshirt` vs
  `Ladies Tshirts`) is left for you to merge manually.
- **Exports** — a *Stockpile* PDF stock sheet, and a CSV with one row per batch
  (item, bags, price, source, date, age) for spreadsheet work.
- **Movement history** — every addition and removal is logged, newest first,
  capped at 300 entries so the file stays small.
- **Tidy up** drops emptied items; **Clear all** wipes the stockpile after
  confirming exactly how many bags and how much value will be lost.
- **Storage**: one JSON document, autosaved in the browser and downloadable.
  Totals, averages and ages are always *calculated* from the batches, never
  stored, so nothing can drift out of sync. A stockpile of 71 items / 94 batches
  / 245 bags is under 30 KB.

---

## Deploy to Vercel (1-click)

This app lives at the repository root, so Vercel auto-detects it as a Next.js
project — no configuration needed.

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import this GitHub repository (`vbuildlanka-oss/System`)
3. Click **Deploy** — that's it.

Vercel will build with `next build` and serve it on a free `*.vercel.app` URL.

---

## Run locally

```bash
npm install
npm run dev      # http://localhost:3000
```

Production build:

```bash
npm run build
npm run start
```

End-to-end checks against the sample orders in `sample-orders/`:

```bash
npx tsx scripts/e2e.ts               # price list: parsing + markup
npx tsx scripts/verify-edit.ts       # editor: edits, sales, overrides, exports
npx tsx scripts/verify-buyer.ts      # buyers: phone formats, sanitising, PDF block
npx tsx scripts/verify-stockpile.ts  # stockpile: batches, FIFO, ageing, files
npx tsx scripts/verify-api.ts        # API routes: every success and failure path
```

---

## How it works

| Step | File |
|------|------|
| Parse the uploaded PDF | `src/lib/parseOrder.ts` |
| Apply markup + recompute totals | `src/lib/types.ts` (`buildBuyerPriceList`) |
| Editable rows + totals | `src/lib/types.ts` (`buildSheetFromRows`) |
| Buyer validation + memory | `src/lib/buyer.ts` |
| Buyer input UI | `src/components/BuyerFields.tsx` |
| Stockpile model + FIFO + ageing | `src/lib/stockpile.ts` |
| Stockpile UI | `src/app/stockpile/page.tsx` |
| Render any PDF | `src/lib/buyerPdf.tsx` (`renderSheetPdf`) |
| Upload / parse endpoint | `src/app/api/process/route.ts` |
| Price list download endpoint | `src/app/api/generate/route.ts` |
| Edited sheet download endpoint | `src/app/api/export/route.ts` |
| Price List UI | `src/app/page.tsx` |
| Order Editor UI | `src/app/edit/page.tsx` |

Sample supplier orders used for testing are in `sample-orders/`.

---

Built by **Lathurshan**.

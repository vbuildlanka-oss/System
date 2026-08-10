# VBUILD — Order Tools

Two tools for managing clothing import order sheets, both driven by PDF files —
no database required.

Built with Next.js + TypeScript + Tailwind CSS. 100% free tooling.

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
- **Download** a branded, multi-page PDF authored by VBUILD

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
npx tsx scripts/e2e.ts          # price list: parsing + markup
npx tsx scripts/verify-edit.ts  # editor: edits, sales, overrides, exports
```

---

## How it works

| Step | File |
|------|------|
| Parse the uploaded PDF | `src/lib/parseOrder.ts` |
| Apply markup + recompute totals | `src/lib/types.ts` (`buildBuyerPriceList`) |
| Editable rows + totals | `src/lib/types.ts` (`buildSheetFromRows`) |
| Render any PDF | `src/lib/buyerPdf.tsx` (`renderSheetPdf`) |
| Upload / parse endpoint | `src/app/api/process/route.ts` |
| Price list download endpoint | `src/app/api/generate/route.ts` |
| Edited sheet download endpoint | `src/app/api/export/route.ts` |
| Price List UI | `src/app/page.tsx` |
| Order Editor UI | `src/app/edit/page.tsx` |

Sample supplier orders used for testing are in `sample-orders/`.

---

Built by **VBUILD**. Prices in LKR.

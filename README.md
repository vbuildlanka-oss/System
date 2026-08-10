# VBUILD — Buyer Price List Generator

Upload a supplier order PDF, add a per-bag markup (default **Rs 2,000**), preview
the recalculated table, and download a clean, buyer-ready price list PDF.

Built with Next.js + TypeScript + Tailwind CSS. 100% free tooling.

---

## Features

- **Upload** an order PDF (drag & drop or browse)
- **Automatic parsing** of Item / Quantity / Per Bag / Total rows
- **Markup** added to every per-bag price (editable, defaults to Rs 2,000) with
  all line totals and the grand total recalculated instantly
- **Live preview** table before you download
- **Validation**: the app compares its computed total against the total printed
  on the source PDF and warns you if they don't match
- **Download** a branded, multi-page PDF authored by VBUILD

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

End-to-end check against the sample orders in `sample-orders/`:

```bash
npx tsx scripts/e2e.ts
```

---

## How it works

| Step | File |
|------|------|
| Parse the uploaded PDF | `src/lib/parseOrder.ts` |
| Apply markup + recompute totals | `src/lib/types.ts` (`buildBuyerPriceList`) |
| Render the buyer PDF | `src/lib/buyerPdf.tsx` |
| Upload / parse endpoint | `src/app/api/process/route.ts` |
| Generate / download endpoint | `src/app/api/generate/route.ts` |
| UI | `src/app/page.tsx` |

Sample supplier orders used for testing are in `sample-orders/`.

---

Built by **VBUILD**. Prices in LKR.

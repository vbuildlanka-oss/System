# BaleBook

Order sheets, bag manifests, sales and stockpile tracking for a clothing import
business. Everything runs on files, so there is no database to maintain.

There is no login: the app is single-user and all state lives in the browser.

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
- **Order number**, read out of the uploaded file's name and editable. It
  headlines the buyer's copy and names the download
  (`Sri Lanka Order 03 - Buyer Price List.pdf`), so a file can be matched back to
  its order at a glance. If the file name also contains a container ID, it is
  removed before the order number is read — otherwise the container's digits would
  be taken as the order number.
- **The buyer never sees a container ID.** This document goes out, so the
  container is kept off it: not in the heading, not in the file name, and ignored
  if one is sent to the route. The suite reads the generated PDF's text back and
  fails if it appears.
- **Buyer details**: name and phone are printed at the top of the PDF, with an
  auto-numbered (editable) reference
- **Download** a branded, multi-page PDF

## 2. Order Editor (`/edit`)

Upload a sheet, edit it as bags sell, then download the updated PDF. Use this to
keep a live sheet as customers buy.

- **Several files open at once.** Opening a file adds a tab rather than replacing
  what is already there. Each tab keeps its own rows, sales, buyer and reference,
  shows its bag count, and can be closed on its own. A sheet opened from a file
  takes its name from the file name (see the order number note below).

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

## 3. Order Bag Manifests (`/bag-manifests`)

A manifest for shippers and customs: order title, container number, item names
and bag counts. No pricing anywhere.

- **Sources**: upload a **PDF, CSV or XLSX** order, or pull the sheet currently
  open in the Order Editor.
- **Pricing is dropped at import**, not hidden at render, so no code path can
  put a price on a manifest.
- **Order number** (e.g. `Sri Lanka 01`) is the heading of the document. It
  replaced a separate order title, and is required before exporting.
- **Container number** is validated ISO 6346 style — four letters then seven
  digits — and stored uppercase, with spaces and dashes stripped as you type. The
  check digit is verified and a mismatch is *flagged but not blocked*, since a
  container exists with whatever number is stamped on it. A valid container
  number is required before either export is enabled.
- **Set a target total** and the per-item quantities are reduced at random until
  they sum to *exactly* that figure, with **every item keeping at least one
  bag**. Each removed bag is drawn from a line with probability proportional to
  how many it can spare, so a line of 62 gives up more than a line of 3 and the
  shape of the order survives.
- **The generated distribution is saved**, so re-downloading reproduces the same
  document. **Re-randomise** is a separate, confirmed action that replaces it.
- **Several orders at once**, each with its own container number and target
  (e.g. Order 3 → 520, Order 4 → 515), picked from the sidebar.
- **Validation**: the target must be a whole number, at least the item count
  (one bag each) and no more than the order's current total, since quantities
  are only ever reduced.
- **Exports** `.xlsx` and `.pdf` with identical data, named
  `<Order Title> - <Container Number> - Bags.<ext>`. In the spreadsheet the Total
  is a **live `=SUM(B4:Bn)` formula**, not a hardcoded number, and in the PDF the
  heading and table header repeat on every page:

  ```
  row 1        Sri Lanka 01                  <- the order number, the heading
  row 2        Container Number: GAOU7441740
  row 3        Item Name | Quantity
  row 4..88    the items
  row 89       Total     | =SUM(B4:B88)
  ```

## 4. Buyer Requests (`/requests`)

What each buyer has asked for, and whether you can fill it from the stockpile
right now.

- **Pick items rather than typing them.** Uploaded container files and the
  stockpile form one searchable catalogue showing available bags, the file each
  item came from, and its price. Each row has a bags box and an Add button;
  picking something already on the list raises that line instead of duplicating
  it. Anything not in a file can still be typed in by hand.
- **Upload their list** as a PDF, CSV or XLSX. A plain list of items and
  quantities works, and so does a priced order sheet. Names, quantities and
  prices stay editable in place, so anything read wrongly from a file can be
  corrected.
- **Pricing.** Each line has a price per bag, pre-filled from the file it was
  picked from where that file had prices. Line and grand totals are derived, so
  they cannot drift from the rows. Order value, supplied value and still to
  invoice are all shown, and a line with no price yet is flagged so a part-priced
  total is not mistaken for the whole order.
- **Download PDF** — buyer, phone, items with wanted / supplied / to go / per bag
  / total, and a grand total. Unpriced lines print as a dash.
- One list per buyer, each line holding the item, bags wanted, and bags supplied
  so far. **Outstanding is always derived** from those two, so a line cannot
  disagree with itself.
- **Check against whatever holds the bags.** Most stock is in a container rather
  than the stockpile, so container and order files can be uploaded as
  availability sources. A selector switches between the stockpile, any one
  container, or everything added together.
- **Live availability**, matched on the same normalised name the stockpile uses —
  so `Anorak #2` on a buyer's list finds `Anorak 2` wherever the bags are. Each
  line reads **in stock**, **part only**, **none**, or **supplied**.
- Supplying against the **stockpile** withdraws the bags. Supplying against a
  **container file** only records it — the file is a record of what shipped, so
  it is left alone.
- **Supply from stock in one step**: the bags leave the stockpile (oldest batch
  first) and are recorded against the request together, so the two can't drift
  apart. The withdrawal is logged against the buyer's name. If the numbers don't
  work it refuses before changing anything.
- Supplied can never exceed what was asked for, or go below zero.
- All lists live in one JSON document: autosaved in the browser, **saveable as a
  file** to move between devices, plus a CSV with one row per requested line.

Availability is a snapshot, not a reservation — two buyers wanting the same item
will both see the same stock figure.

## 5. Stockpile (`/stockpile`)

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

## 6. Balance Sheet (`/balance`)

What each container brought in, what it cost, and which partner the money
belongs to.

- **Expenses** — an expense name, the **partner** it belongs to, and the amount.
  The partner is required: an unattributed expense would make the per-partner
  breakdown lie by omission.
- **Profit by container** — record a **container ID** and its **turnover**, and
  each container's profit, margin and costs are worked out for you.
- **Two scopes, kept apart.** An expense can optionally be tagged to a container.
  That is what makes per-container profit possible, without forcing you to guess
  where overhead belongs:

  | | Counts turnover | Counts tagged expenses | Counts untagged (general) expenses |
  |---|---|---|---|
  | **Net profit** (top of page) | yes | yes | **yes** |
  | **Profit for one container** | that container's | that container's | **no** |

  Leave the container blank and the expense is general overhead: it reduces the
  net profit but is never silently attributed to a single container. Whenever any
  general overhead exists, the page says so in plain words, and the CSV gives it
  its own labelled line.
- **A container that has cost money but earned nothing yet is still listed**,
  showing the loss so far rather than hiding until the first sale.
- **Expenses by partner** — totals, entry counts and each partner's share of all
  spending, as a bar.
- **Edit in place** — every name, partner, container and amount is editable
  directly in the table, and every figure above re-derives as you type. Partner
  and container fields suggest what you have already used.
- **Search** across expense names, partners and container IDs.
- **Validation**: an entry needs a name, a partner and an amount above zero;
  container IDs are normalised to uppercase (`gaou 744174-0` → `GAOU7441740`) and
  a bad ISO 6346 check digit raises a warning without blocking you — it is a
  bookkeeping label, not an export.
- **Balances to be paid** — a ledger of what is still outstanding, in both
  directions: money you still owe a partner or supplier, and money a buyer still
  owes you. Record the **total** and **how much has been paid**; what is left is
  worked out for you, never typed.

  - **Both directions in one ledger**, so the two are never reconciled by hand. A
    party who is both owed and owing appears once, with both figures.
  - **Overdue** means past its date with something still left. A balance due today
    is not overdue, one with no date never is, and a settled one never is however
    late it was paid.
  - **Not profit.** Outstanding balances are deliberately absent from the net
    profit: the expense behind one may already be recorded, and counting both
    would count the same money twice. They are reported as a *position* —
    still to pay, still to receive, net — alongside the profit, never inside it.
  - **Carry previous balances in** with **Import from Excel**. Fill in the
    **Balances** tab of an export, or type your own sheet: `Party`, plus a
    `Total`/`Balance`/`Outstanding` column, plus any of `Paid`, `Due` or
    `Direction`. `Rs 150,000.00` and `1 250` both read as money, and dates are
    understood.
  - **A sheet of expenses cannot be imported as debts.** "Partner" is a party and
    "Amount" is an amount, so an expenses sheet would otherwise satisfy a naive
    test and turn every expense into a debt. A balances sheet has to carry
    something only a balances sheet has, and if it does not, the reply says so.
  - Everything skipped is listed with its reason — a credit in brackets, a paid
    figure larger than the total, a row already settled.
  - **Download them on their own** with **Balances only**, or the button on the
    section itself: one tab, `Balances to be paid <date> <time>.xlsx`. What we owe
    comes first, soonest due at the top. `Outstanding`, `Status` and the position
    are formulas — edit a `Paid` figure and the row flips to *settled*, the totals
    move and the per-party rows follow. Overdue is judged against the day the file
    is opened, not the day it was made. It carries no turnover, expense or profit
    figure, and it can be edited and uploaded straight back.

- **Excel export** — a six-tab workbook, and every figure on it is a live
  formula:

  | Tab | What it holds |
  |---|---|
  | Summary | turnover, expenses split into attributed and overhead, net profit, margin, counts |
  | Profit by Container | turnover, cost, profit and margin per container, then a labelled overhead row and a net total |
  | Expenses | one row per expense — date, name, partner, container, amount, note |
  | Turnover | one row per turnover entry |
  | By Partner | spend, entry count and share for each partner |
  | Balances | what is outstanding — `Outstanding` is `Total - Paid`, live |

  Amounts are typed on the **Expenses** and **Turnover** tabs only. Everything
  else is `SUMIF`, `COUNTIF` and arithmetic over those two tabs, so changing an
  amount in Excel re-derives the summary, both profit scopes and the partner
  breakdown. Re-tag an expense to a container in the spreadsheet and it moves out
  of overhead and into that container's profit on recalculation. No total can
  ever sit there disagreeing with the rows above it.

  Entries are written oldest-first, so the workbook reads as a ledger even though
  the page lists the newest entry at the top for typing. Money cells show losses
  in red, dates are real dates, and the entry tabs come with filters on.
  Every formula also carries a cached answer, so totals are visible in Google
  Sheets, LibreOffice and mail preview panes that do not recalculate on open.
- **Expenses-only export** — a second button giving a one-tab workbook of
  **expense name, partner, container and amount**. It carries no turnover, profit
  or margin, so what the containers earned stays out of it. Rows are grouped so
  each partner's expenses sit together, with a live total and a live per-partner
  block below. Saved as `Expenses <date>.xlsx`, so it can never be mistaken for
  the full sheet.
- **Expenses import** — **Import from Excel** on the Expenses section reads an
  `.xlsx` or `.csv` back in, so the round trip works: export, add rows in Excel,
  upload, and the new rows land on the sheet.

  Two rules run through the importer:

  - **Nothing is imported that is not clearly an expense.** The exported sheet has
    a Total row and a per-partner block below the entries, and a naive reader
    would add those back as expenses called "Total" and "Anton". The per-partner
    block ends the read; a Total row is stepped over, so a row typed *below* it is
    still found.
  - **Nothing is dropped silently.** Every row that is not imported is listed with
    the reason — no name, no amount, no partner, a zero, a bracketed credit, or an
    amount beyond the cap.

  Nothing is added until you accept it. The preview shows what will be added,
  which rows already match an entry on the sheet, and everything skipped. Repeats
  are **counted, not just matched**: if the sheet has one 5,000 freight charge and
  the file has two, the second is genuinely new. You choose **Add new only** or
  **Add all**.

  Columns are found by their heading, in any order, so a sheet someone else typed
  works too — `Paid by`, `Description`, `Amount (LKR)`, `Container No.` are all
  understood. `Rs 150,000.00`, `1 250` and a plain number all read as money.
  Uploading the **whole** five-tab workbook works as well: its Expenses tab is
  found rather than failing on Summary. `(general)` comes back as no container, so
  overhead never acquires one on the way through.
- **CSV export** — the same sheet as one flat file: both halves, then the
  summary, per-container and per-partner blocks.
- **Storage**: one JSON document, autosaved in the browser and downloadable.
  Totals, profits and margins are always *calculated* from the entries, never
  stored, so a figure can never drift from the rows it came from.

---

## 7. Calculation (`/calculation`) &mdash; private

Working out the markup item by item. The markup **is** the profit, and a fast
moving item does not carry the same markup as something that sits in the
warehouse.

- **Upload the requested bags** &mdash; a PDF, CSV or XLSX. A request list printed
  by this app works too: its layout puts three counts between the item name and
  the money, which is read properly rather than leaving them stuck to the name.
- **One markup across every bag**, then **change it per item** where it needs to
  be. An item you set by hand is remembered as such, so changing the figure
  applied across the board leaves it alone &mdash; a change of mind about the base
  never undoes an afternoon of per-item work.
- **Mark the fast movers** and reprice them as a group in one go. The summary
  splits bags and profit between fast and steady, since that is what a markup
  follows.
- **See what it makes**: what the bags cost, the profit on the markup, what it
  sells for, and the markup per bag on average.
- **Download a spreadsheet** where bags, cost and markup are the only typed
  figures. Selling prices, line totals, profit and the fast/steady split are
  formulas, so you can try a markup in Excel and watch the order re-price.

> **This page is private, and nothing else can see it.** It is the only place a
> cost or a markup appears. No other page or route reads the calculation, and the
> buyer's price list, bag manifests, requests and the balance sheet carry no
> markup, cost or profit-from-markup figure &mdash; the buyer sees one price per
> bag, the selling price, and nothing behind it. All of that is enforced by the
> suite, which reads the generated buyer PDF back as text and fails if a cost, a
> markup or even the word appears. The download is named
> `... Markup Calculation INTERNAL.xlsx`, so a wrong attachment is caught by eye.

---

## 8. Counter (`/counter`)

Counting the bags in a warehouse. Upload the buyer list to get the items, name the
container, then search and tally each item up from zero.

- **Type, then press Enter.** The search box stays focused and Enter adds one to the
  best match, so counting is three letters and a keypress rather than hunting
  through a list with your hands full. The exact name always ranks first.
- **Big targets** for one-handed use: plus, minus, `+5`, `+10`, `+25`, or type the
  figure straight in. A count can never go below zero.
- **Every count starts at zero.** Pre-filling what the list expects would turn a
  count into a confirmation, and a confirmation is what you get when nobody really
  counted.
- **Counted none is not the same as not counted.** Tapping up and back down leaves a
  real finding of zero; an item nobody reached says so, on the page and on the
  sheet. That is what stops a half-finished count reading as a complete one.
- **Add what you find on the floor** — items that were never on the list. They are
  marked as such, and a name already present is never added twice, so a count can
  never be split across two rows for one item.
- **Progress** as you go: bags counted against expected, how many items are left,
  and how many are short, over or matched. Filters for *not counted* and
  *doesn't match* to finish off.
- **Saved as you go.** A count takes hours, so every tap is written down and it
  appears in backups and on the Saved Data page.
- **Download the count** — `<Order> - <Container> - Bag Count.xlsx`. Just two
  columns, **Item and Count**, with a live total. What the list expected and whether
  it matches stay on the page: this sheet is the tally itself, and printing the
  expected quantities onto it would hand them to whoever did the counting. An item
  nobody reached is listed with an **empty** cell rather than a zero, and the total
  leaves it out. **There are no prices on the sheet** either — the list it came from
  had a per-bag price beside every quantity, and none of it crosses over.

---

## 9. Saved Data (`/data`)

Everything this app remembers lives in your browser. **Saved data** in the top
bar, reachable from every page, shows what is stored and lets you choose what to
delete. Back up, choose, delete — in that order down the page.

- **It tells you what will go**, section by section, with counts read out of the
  store — "4 expenses, 2 turnover entries", "3 items, 1 movement" — plus when it
  was last saved, its size, and the key it lives under. A full section is never
  mistaken for an empty one, and data that will not parse is reported as
  unreadable rather than as absent. Tick only the sections you want, or select
  all. Each row links to the page it belongs to.
- **Restore from a backup**, so the backup is worth taking. The file has to be one
  of ours or it is refused, and every key in it is checked against this app's own
  prefixes before being written — a hand-edited file cannot reach data belonging
  to anything else on the domain. Restoring replaces a section rather than merging
  into it, and says so before it runs.
- **Backup first, in the same dialog.** One button downloads every stored key
  exactly as saved, including keys this version no longer uses, so a later version
  can still read it. Restoring that file brings every section back.
- **Reference numbering is left alone by default.** A reference is the device tag,
  the date and a counter. Wiping the counter while keeping the tag would restart it
  at `001` for today and could reprint a reference already on a document that has
  gone out — so those keys are separate, opt-in, and only ever cleared *together*.
  A fresh tag cannot reproduce anything issued under the old one, which is what
  makes clearing them safe.
- **Old keys go too.** Reads fall back to pre-rename keys and copy the data
  forward, so clearing only the current key would make everything reappear on the
  next load. Every legacy copy is deleted, and a full clear also sweeps stray keys
  from older versions.
- **Nothing else on the domain is touched** — only keys under this app's own
  prefixes.
- **The page reloads afterwards.** Each page holds its data in memory and
  autosaves, so a page left open would write everything straight back.

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
npx tsx scripts/verify-bag-manifest.ts  # manifests: containers, reduction, exports
npx tsx scripts/verify-refno.ts         # references: device tags, uniqueness
npx tsx scripts/verify-request.ts       # buyer requests: matching, supplying, files
npx tsx scripts/verify-balance.ts       # balance sheet: profit scopes, workbooks, import
npx tsx scripts/verify-appdata.ts       # saved data: listing, backup, clearing
npx tsx scripts/verify-shipment.ts      # order number + container: names, files, privacy
npx tsx scripts/verify-dues.ts          # balances to be paid: position, workbook, import
npx tsx scripts/verify-calculation.ts   # markup per item, and that it never leaves the page
npx tsx scripts/verify-counter.ts       # warehouse count: tallies, two-column sheet
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
| Manifest model + reduction | `src/lib/bagManifest.ts` |
| Container number validation | `src/lib/container.ts` |
| Manifest PDF / spreadsheet | `src/lib/bagManifestPdf.tsx`, `src/lib/bagManifestXlsx.ts` |
| CSV + XLSX order parsing | `src/lib/parseTabular.ts` |
| Manifest download endpoint | `src/app/api/bag-manifest/route.ts` |
| Manifest UI | `src/app/bag-manifests/page.tsx` |
| Buyer requests + stock matching | `src/lib/buyerRequest.ts` |
| Buyer requests UI | `src/app/requests/page.tsx` |
| Render any PDF | `src/lib/buyerPdf.tsx` (`renderSheetPdf`) |
| Upload / parse endpoint | `src/app/api/process/route.ts` |
| Price list download endpoint | `src/app/api/generate/route.ts` |
| Edited sheet download endpoint | `src/app/api/export/route.ts` |
| Price List UI | `src/app/page.tsx` |
| Order Editor UI | `src/app/edit/page.tsx` |

Sample supplier orders used for testing are in `sample-orders/`.

---

Built by **Lathurshan**.

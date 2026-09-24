# 📦 Shipping Label Cleaner

A small React (Vite) web tool that takes your Amazon "label + tax invoice" PDF,
**removes the invoices**, and packs the **shipping labels 4 per A4 page** so you
waste no paper. It can also print the tax invoices (bills) — for Amazon, 4 per
page at actual size or 2 per page bigger. Everything runs in your browser — the
PDF is never uploaded.

## How it works
Each Amazon page is a 2×2 grid: shipping labels on the **left**, tax invoices on
the **right** (2 orders per page). The tool keeps only the left column and
re-lays the labels 2 columns × 2 rows on fresh A4 pages.
So a 3-page PDF (6 labels + 6 invoices) → **1.5 A4 pages** of labels.
Labels and invoices are found automatically from the PDF itself, so a page with
only one order (empty bottom half) never produces a blank label or bill.

**Amazon bills, 2 per page:** each bill is a portrait quarter of the Amazon
page, so upright it would be no bigger on half an A4. It's turned 90° instead,
filling the half (~1.3× bigger); cut on the dashed line, turn each half a
quarter clockwise and the bill reads upright. Verified on a real 3-order PDF:
3 bills → 2 pages (2 + 1), in label order.

## Run it
```bash
cd ~/Desktop/label-tool
npm install      # first time only
npm run dev      # then open the printed http://localhost:5173 link
```

1. Drag your Amazon PDF onto the drop area (or click to browse).
2. Check the live preview on the right.
3. If a sliver of invoice still shows, or a label is clipped, nudge the
   **Label width** slider. 50% suits most Amazon sheets.
4. **What to export** → *Bills only* (or *Labels, then bills*) prints the tax
   invoices too. For Amazon you can pick **4 per page** (one bill per quarter,
   actual size) or **2 per page** (each bill turned sideways to fill half the
   page, ~1.3× bigger — cut on the dashed middle line and each half is one
   upright bill).
5. **Which orders to print** (Amazon, shown whenever the PDF has 2+ orders,
   right under *What to export*): every order is a numbered button — 1, 2, 3… —
   with its SKU and order number. Tap a number to leave that order out (or back
   in); *Select all* / *Clear*. It works with every export option: a ticked
   order prints its label and/or bill, and they print in number order. With
   several PDFs the numbering carries on across files in upload order.
6. Click **Download labels PDF** → saves `<yourfile>_labels.pdf`.

## Make a standalone version (optional)
```bash
npm run build    # outputs a static site in dist/
npm run preview  # serve the built version locally to check it
```
The `dist/` folder is fully self-contained and can be hosted anywhere.

## Files
- `src/labels.js` — the PDF crop + pack logic (pdf-lib); `placeTwoUpRotated`
  is the Amazon 2-bills-per-page layout.
- `src/layout.js` — auto-detects each Amazon label/invoice box (pdf.js), and
  reads each invoice's order number + SKU for the order picker.
- `src/App.jsx`   — the UI.
- `make-test-pdf.mjs` + `sample-amazon.pdf` — a fake Amazon PDF for testing.

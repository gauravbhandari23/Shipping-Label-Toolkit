# 📦 Shipping Label Cleaner

A small React (Vite) web tool that takes your Amazon "label + tax invoice" PDF,
**removes the invoices**, and packs the **shipping labels 4 per A4 page** so you
waste no paper. Everything runs in your browser — the PDF is never uploaded.

## How it works
Each Amazon page is a 2×2 grid: shipping labels on the **left**, tax invoices on
the **right** (2 orders per page). The tool keeps only the left column and
re-lays the labels 2 columns × 2 rows on fresh A4 pages.
So a 3-page PDF (6 labels + 6 invoices) → **1.5 A4 pages** of labels.

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
4. Click **Download labels PDF** → saves `<yourfile>_labels.pdf`.

## Make a standalone version (optional)
```bash
npm run build    # outputs a static site in dist/
npm run preview  # serve the built version locally to check it
```
The `dist/` folder is fully self-contained and can be hosted anywhere.

## Files
- `src/labels.js` — the PDF crop + pack logic (pdf-lib).
- `src/App.jsx`   — the UI.
- `make-test-pdf.mjs` + `sample-amazon.pdf` — a fake Amazon PDF for testing.

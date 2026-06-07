import { PDFDocument, rgb } from 'pdf-lib'

// 72 PDF points = 1 inch = 25.4 mm.
const MM = 72 / 25.4

// Default template: Avery L7169 / J8169 — sold in India as "A4 ST4".
// A4 page, 4 labels (2 cols x 2 rows), each 99.1 x 139 mm. All values in mm.
export const DEFAULT_SHEET = {
  pageW: 210,
  pageH: 297,
  cols: 2,
  rows: 2,
  labelW: 99.1,
  labelH: 139,
  marginTop: 8.5, // sheet edge -> top of first row
  marginLeft: 5.85, // sheet edge -> left of first column
  gapX: 0, // horizontal gap between columns
  gapY: 0, // vertical gap between rows
}

// Flipkart: 1 order per page, label on TOP, invoice on BOTTOM. The crop is
// given as fractions of the page measured FROM THE TOP-LEFT corner. Default is
// a safe full-width top crop (nothing gets cut off); the user tightens it.
// Measured from a real Flipkart "label + invoice" PDF (A4). The label box sits
// in the upper-middle; values are fractions from the top-left corner.
export const FLIPKART_CROP = {
  left: 0.31, // fraction from left edge where the label starts
  right: 0.69, // fraction from left edge where the label ends
  top: 0.03, // fraction from top edge where the label starts
  bottom: 0.46, // fraction from top edge where the label ends (the dashed cut line)
}

/**
 * Build a labels PDF from an Amazon or Flipkart "label + invoice" PDF, laid out
 * to match a pre-cut sticker sheet (default: A4 ST4 / Avery L7169, 4 per sheet).
 *
 * Source layouts:
 *   amazon   — 2 orders per page in a 2x2 grid: labels = LEFT column, invoices = RIGHT column.
 *   flipkart — 1 order per page: label on TOP, invoice on BOTTOM (split by a horizontal line).
 *
 * @param {ArrayBuffer} arrayBuffer  raw bytes of the uploaded PDF
 * @param {object} options
 * @param {'amazon'|'flipkart'} options.source  which marketplace layout (default 'amazon')
 * @param {number}  options.splitRatio    [amazon] fraction of page width that is the label (default 0.5)
 * @param {object}  options.flipkartCrop  [flipkart] crop box as top-left fractions (see FLIPKART_CROP)
 * @param {number}  options.innerPad      mm of breathing room inside each sticker (default 2)
 * @param {boolean} options.showOutlines  draw a thin border at each label position (for test prints)
 * @param {boolean} options.includeBills  if true, also output the bills after the labels
 * @param {boolean} options.billsOnly     if true, output ONLY the bills (no labels)
 * @param {object}  options.sheet         label-sheet template in mm (see DEFAULT_SHEET)
 * @param {number}  options.startSlot     first sticker position to fill on the first sheet,
 *                                        counting left-to-right, top-to-bottom (0 = top-left).
 *                                        Lets you skip stickers you've already peeled off.
 * @param {Array}   options.layout        [amazon] auto-detected content boxes per page
 *                                        ([{labels:[Box], bills:[Box]}], Box in PDF points).
 *                                        When given, used instead of fixed crop fractions so
 *                                        nothing is clipped on any Amazon template.
 * @returns {Promise<{bytes: Uint8Array, labelCount, billCount, sheetCount}>}
 */
export async function buildLabelPdf(arrayBuffer, options = {}) {
  const {
    source = 'amazon',
    splitRatio = 0.5,
    flipkartCrop = FLIPKART_CROP,
    innerPad = 1,
    showOutlines = false,
    includeBills = false,
    billsOnly = false,
    sheet = DEFAULT_SHEET,
    startSlot = 0,
    layout = null,
  } = options

  const wantLabels = !billsOnly
  const wantBills = includeBills || billsOnly

  const src = await PDFDocument.load(arrayBuffer)
  const out = await PDFDocument.create()
  const srcPages = src.getPages()

  if (srcPages.length === 0) {
    throw new Error('The PDF has no pages.')
  }

  // 1. Collect the label regions (and optionally the bill regions).
  const labelRegions = []
  const billRegions = []

  if (source === 'flipkart') {
    const c = flipkartCrop
    for (const page of srcPages) {
      const { width, height } = page.getSize()
      // Convert top-left fractions to PDF coords (origin bottom-left).
      labelRegions.push({
        page,
        left: c.left * width,
        right: c.right * width,
        top: height * (1 - c.top),
        bottom: height * (1 - c.bottom),
      })
      if (wantBills) {
        // Invoice = everything below the cut line, full width.
        billRegions.push({
          page,
          left: 0,
          right: width,
          top: height * (1 - c.bottom),
          bottom: 0,
        })
      }
    }
  } else if (layout && layout.length === srcPages.length) {
    // amazon, auto-detected: use the exact ink bounds measured per quadrant.
    // This never clips the top and keeps every label tight & aligned, whatever
    // the Amazon template's margins happen to be.
    srcPages.forEach((page, i) => {
      const entry = layout[i] || { labels: [], bills: [] }
      for (const b of entry.labels) {
        labelRegions.push({ page, left: b.left, right: b.right, top: b.top, bottom: b.bottom })
      }
      if (wantBills) {
        for (const b of entry.bills) {
          billRegions.push({ page, left: b.left, right: b.right, top: b.top, bottom: b.bottom })
        }
      }
    })
  } else {
    // amazon fallback (detection unavailable): split each page into a 2x2 grid
    // by fixed fractions. Labels = left column, invoices = right column.
    const A1 = { top: 0.0, bottom: 0.5 } // label, order 1 (upper half)
    const A2 = { top: 0.5, bottom: 1.0 } // label, order 2 (lower half)
    for (const page of srcPages) {
      const { width, height } = page.getSize()
      const labelW = width * splitRatio
      labelRegions.push({ page, left: 0, right: labelW, top: height * (1 - A1.top), bottom: height * (1 - A1.bottom) })
      labelRegions.push({ page, left: 0, right: labelW, top: height * (1 - A2.top), bottom: height * (1 - A2.bottom) })
      if (wantBills) {
        billRegions.push({ page, left: labelW, right: width, top: height, bottom: height * 0.5 })
        billRegions.push({ page, left: labelW, right: width, top: height * 0.5, bottom: 0 })
      }
    }
  }

  // 2. Place labels onto sticker sheets (unless we only want bills). The
  //    startSlot lets the user skip stickers already peeled off the first sheet.
  if (wantLabels) {
    await placeOnSheets(out, labelRegions, sheet, innerPad, showOutlines, startSlot)
  }

  // 3. Output the bills. Amazon invoices are half-page and pack 4 to a sticker
  //    sheet nicely. Flipkart invoices are full-width, so we stack 2 whole
  //    invoices per A4 page — each bill is always kept whole on one page, never
  //    split across two pages.
  //    Bills are NOT affected by startSlot — that only skips already-used
  //    stickers on the physical label sheet. Bills always pack tight from the
  //    top so they stay readable and don't waste paper.
  if (wantBills && billRegions.length) {
    if (source === 'flipkart') {
      await placeStacked(out, billRegions, 2)
    } else {
      await placeOnSheets(out, billRegions, sheet, innerPad, showOutlines)
    }
  }

  const bytes = await out.save()
  return {
    bytes,
    labelCount: wantLabels ? labelRegions.length : 0,
    billCount: wantBills ? billRegions.length : 0,
    sheetCount: out.getPageCount(),
  }
}

/**
 * Pack source regions onto sticker sheets defined by `sheet` (mm). Each region
 * is fitted inside its sticker rectangle (minus innerPad), preserving aspect
 * ratio and centered. Always starts a fresh page, so labels and bills stay on
 * separate sheets.
 */
async function placeOnSheets(out, regions, sheet, innerPad, showOutlines, startSlot = 0) {
  const perPage = sheet.cols * sheet.rows
  const pageW = sheet.pageW * MM
  const pageH = sheet.pageH * MM
  const labelW = sheet.labelW * MM
  const labelH = sheet.labelH * MM
  const mTop = sheet.marginTop * MM
  const mLeft = sheet.marginLeft * MM
  const gapX = sheet.gapX * MM
  const gapY = sheet.gapY * MM
  const pad = innerPad * MM

  // Offset every label by the chosen start position so the first one lands in
  // the spot the user picked (skipping any stickers already peeled off).
  const offset = ((startSlot % perPage) + perPage) % perPage

  let outPage = null
  for (let k = 0; k < regions.length; k++) {
    const globalSlot = offset + k
    const slot = globalSlot % perPage
    if (k === 0 || slot === 0) outPage = out.addPage([pageW, pageH])

    const col = slot % sheet.cols
    const row = Math.floor(slot / sheet.cols) // row 0 = top

    // Sticker rectangle, in PDF coords (origin bottom-left).
    const cellLeft = mLeft + col * (labelW + gapX)
    const cellTopFromTop = mTop + row * (labelH + gapY)
    const cellBottom = pageH - cellTopFromTop - labelH

    if (showOutlines) {
      outPage.drawRectangle({
        x: cellLeft,
        y: cellBottom,
        width: labelW,
        height: labelH,
        borderColor: rgb(0.8, 0.8, 0.8),
        borderWidth: 0.5,
      })
    }

    const r = regions[k]
    // embedPage with a bounding box clips everything outside it — this isolates
    // one quadrant. Result is crisp vector, not a rasterized image.
    const embedded = await out.embedPage(r.page, {
      left: r.left,
      bottom: r.bottom,
      right: r.right,
      top: r.top,
    })

    const regW = r.right - r.left
    const regH = r.top - r.bottom

    // Fit the artwork inside the sticker (minus padding), keeping aspect ratio.
    const availW = labelW - pad * 2
    const availH = labelH - pad * 2
    const scale = Math.min(availW / regW, availH / regH)
    const drawW = regW * scale
    const drawH = regH * scale
    const x = cellLeft + (labelW - drawW) / 2
    // Top-align inside the sticker so labels in the same row line up exactly.
    const y = cellBottom + labelH - drawH - pad

    outPage.drawPage(embedded, { x, y, width: drawW, height: drawH })
  }
}

/**
 * Stack `rows` regions per A4 page (full width, divided into horizontal bands),
 * each region fitted whole inside its band. A single region is always contained
 * in one band on one page — never split across pages. Used for Flipkart bills.
 */
async function placeStacked(out, regions, rows, startBand = 0) {
  const pageW = 210 * MM
  const pageH = 297 * MM
  const margin = 8 * MM
  const bandH = pageH / rows
  const offset = ((startBand % rows) + rows) % rows

  let page = null
  for (let k = 0; k < regions.length; k++) {
    const slot = (offset + k) % rows
    if (k === 0 || slot === 0) page = out.addPage([pageW, pageH])

    const r = regions[k]
    const embedded = await out.embedPage(r.page, {
      left: r.left,
      bottom: r.bottom,
      right: r.right,
      top: r.top,
    })
    const regW = r.right - r.left
    const regH = r.top - r.bottom

    const bandBottom = pageH - (slot + 1) * bandH // slot 0 = top band
    const availW = pageW - margin * 2
    const availH = bandH - margin * 2
    const scale = Math.min(availW / regW, availH / regH)
    const drawW = regW * scale
    const drawH = regH * scale
    const x = (pageW - drawW) / 2
    const y = bandBottom + (bandH - drawH) / 2
    page.drawPage(embedded, { x, y, width: drawW, height: drawH })
  }
}

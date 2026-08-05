import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib'
import { encodeBarcode, QUIET_MODULES } from './barcode'

// 72 PDF points = 1 inch = 25.4 mm.
const MM = 72 / 25.4

// Extra clearance (mm) between a sticker's top edge and the label artwork, on
// top of the regular inner padding — keeps the bottom row from hugging the
// horizontal cut line. The label shrinks to fit, so it never overflows.
const TOP_GAP = 2

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

// Myntra: 1 shipping label per page, no invoice. The label is a full-page image
// with a blank right margin, so the default crop just trims that margin. Same
// top-left fraction format as FLIPKART_CROP; the user can fine-tune it.
export const MYNTRA_CROP = {
  left: 0.0,
  right: 0.86, // trim the blank right margin
  top: 0.0,
  bottom: 1.0,
}

// Your own labels: 1 per page, invoice details printed on the label itself.
// These are normally trimmed to their measured artwork box (see own.js), so
// this whole-page crop is only the fallback for when that measurement fails —
// and the manual starting point if you'd rather trim by hand.
export const OWN_CROP = {
  left: 0.0,
  right: 1.0,
  top: 0.0,
  bottom: 1.0,
}

// How far (mm) your own labels sit from the OUTER edge of the paper — left
// column from the left edge, right column from the right. Measured from the
// paper rather than the sticker grid, which is what closes the outer gap up:
// the grid's own margin is 5.85mm, and pulling the label out to here both
// shrinks that gap and hands the difference to the centre cut. 3mm is about as
// close to the edge as a printer will go before it starts clipping.
export const OWN_EDGE_MARGIN = 3

/**
 * Build a labels PDF from an Amazon or Flipkart "label + invoice" PDF, laid out
 * to match a pre-cut sticker sheet (default: A4 ST4 / Avery L7169, 4 per sheet).
 *
 * Source layouts:
 *   amazon   — 2 orders per page in a 2x2 grid: labels = LEFT column, invoices = RIGHT column.
 *   flipkart — 1 order per page: label on TOP, invoice on BOTTOM (split by a horizontal line).
 *   myntra   — 1 label per page, NO invoice; the whole page is the label (crop trims margins).
 *   own      — your own label: 1 per page, NO separate invoice (it's on the label);
 *              cropped to the artwork box measured by own.js, since the page is
 *              usually 4x6in with the label filling only its top part.
 *
 * @param {ArrayBuffer} arrayBuffer  raw bytes of the uploaded PDF
 * @param {object} options
 * @param {'amazon'|'flipkart'|'myntra'|'own'} options.source  which layout (default 'amazon')
 * @param {number}  options.splitRatio    [amazon] fraction of page width that is the label (default 0.5)
 * @param {object}  options.flipkartCrop  [flipkart/myntra/own] crop box as top-left fractions
 * @param {number}  options.innerPad      mm of breathing room inside each sticker (default 2)
 * @param {boolean} options.showOutlines  draw a thin border at each label position (for test prints)
 * @param {boolean} options.includeBills  if true, also output the bills after the labels
 * @param {boolean} options.billsOnly     if true, output ONLY the bills (no labels)
 * @param {object}  options.sheet         label-sheet template in mm (see DEFAULT_SHEET)
 * @param {number}  options.startSlot     first sticker position to fill on the first sheet,
 *                                        counting left-to-right, top-to-bottom (0 = top-left).
 *                                        Lets you skip stickers you've already peeled off.
 * @param {Array}   options.layout        auto-detected content boxes per page, used instead of
 *                                        fixed crop fractions so nothing is clipped. Shape depends
 *                                        on the source: [amazon] [{labels:[Box], bills:[Box]}],
 *                                        [own] [Box] — one artwork box per page. Box is in PDF points.
 * @returns {Promise<{bytes: Uint8Array, labelCount, billCount, sheetCount}>}
 */
export async function buildLabelPdf(arrayBuffer, options = {}) {
  const { source = 'amazon', splitRatio = 0.5, flipkartCrop = FLIPKART_CROP, layout = null, ...rest } = options
  return buildCombinedLabelPdf([{ arrayBuffer, source, splitRatio, flipkartCrop, layout }], rest)
}

/**
 * Build one output PDF from MANY source PDFs at once. Each item carries its own
 * marketplace + crop/layout, so a batch can even mix Amazon/Flipkart/Myntra.
 * Labels from every file are packed together onto the sticker sheets; bills are
 * grouped by their source so each marketplace's invoices lay out correctly.
 *
 * @param {Array<{arrayBuffer, source, role?, splitRatio?, flipkartCrop?, layout?}>} items
 *        `role` only applies to Myntra, whose label and invoice arrive as two
 *        separate PDFs: 'bill' marks the file as an invoice, anything else (the
 *        default) treats it as a shipping label.
 * @param {object} options  shared layout options (innerPad, showOutlines,
 *        includeBills, billsOnly, pairs, sheet, startSlot, hAlign, outwardX)
 * @returns {Promise<{bytes, labelCount, billCount, sheetCount}>}
 */
export async function buildCombinedLabelPdf(items, options = {}) {
  const {
    innerPad = 1,
    showOutlines = false,
    includeBills = false,
    billsOnly = false,
    pairs = false,
    sheet = DEFAULT_SHEET,
    startSlot = 0,
    hAlign = 'center', // 'center' | 'outer' (push labels to the outer column edge)
    outwardX = 0, // mm to shift each label AWAY from the sheet's centre line
  } = options

  const wantLabels = pairs || !billsOnly
  const wantBills = pairs || includeBills || billsOnly

  const out = await PDFDocument.create()
  const allLabels = []
  const allBills = []
  const flipkartBills = [] // full-width invoices stack 2 per page
  const stickerBills = [] // Amazon half-page invoices pack onto sticker sheets
  const myntraBills = [] // whole-page tax invoices, one per A4

  for (const item of items) {
    const src = await PDFDocument.load(item.arrayBuffer)
    const srcPages = src.getPages()
    if (!srcPages.length) continue
    const source = item.source || 'amazon'
    const { labelRegions, billRegions } = collectRegions(srcPages, {
      source,
      role: item.role || 'label',
      splitRatio: item.splitRatio ?? 0.5,
      flipkartCrop: item.flipkartCrop || FLIPKART_CROP,
      layout: item.layout || null,
      wantBills,
    })
    allLabels.push(...labelRegions)
    allBills.push(...billRegions)
    if (source === 'flipkart') flipkartBills.push(...billRegions)
    else if (source === 'myntra') myntraBills.push(...billRegions)
    else stickerBills.push(...billRegions)
  }

  if (!allLabels.length && !allBills.length) {
    throw new Error('No pages found in the PDF(s).')
  }

  if (pairs) {
    await placePairs(out, allLabels, allBills, 2)
  } else {
    if (wantLabels) {
      await placeOnSheets(out, allLabels, sheet, innerPad, showOutlines, startSlot, hAlign, outwardX)
    }
    if (wantBills) {
      // Myntra invoices go first among the bills so they line up 1:1 with the
      // label order the sheets were just packed in. They pack 4-up on the same
      // grid as the labels, always from the top-left — startSlot only exists to
      // skip stickers already peeled off a sheet, and these print on plain
      // paper, so honouring it here would just waste a corner of every page.
      if (myntraBills.length) await placeOnSheets(out, myntraBills, sheet, innerPad, showOutlines, 0)
      if (flipkartBills.length) await placeStacked(out, flipkartBills, 2, startSlot % 2)
      if (stickerBills.length) await placeOnSheets(out, stickerBills, sheet, innerPad, showOutlines, startSlot)
    }
  }

  const bytes = await out.save()
  return {
    bytes,
    labelCount: wantLabels ? allLabels.length : 0,
    billCount: wantBills ? allBills.length : 0,
    sheetCount: out.getPageCount(),
  }
}

/**
 * Collect the label (and optional bill) crop regions for one source PDF,
 * per its marketplace layout. Regions reference the source pages directly.
 */
function collectRegions(srcPages, { source, role, splitRatio, flipkartCrop, layout, wantBills }) {
  const labelRegions = []
  const billRegions = []

  if (source === 'own') {
    // Your own label: 1 per page, no separate invoice (the bill is printed on
    // the label). The page is usually 4x6in with the artwork filling only its
    // top part, so we crop to the measured artwork box — otherwise the empty
    // paper below would be scaled onto the sticker too and shrink the label.
    // `layout[i]` is that box for page i; if it couldn't be measured we fall
    // back to the crop fractions.
    const c = flipkartCrop
    // Printed at its true size, pinned near the outer edge of the paper. These
    // labels are nearly as wide as a sticker, so scaling one up to fill it left
    // the inner edge a millimetre off the centre cut — and a shipping label is
    // meant to print at 100% anyway, so its barcodes keep the size they were
    // drawn at. Placing it against the paper edge instead of the sticker grid
    // closes up the outer gap, and every millimetre saved there becomes
    // clearance at the centre cut.
    const fit = { maxScale: 1, hAlign: 'outer', edgeMargin: OWN_EDGE_MARGIN }
    srcPages.forEach((page, i) => {
      const box = layout && layout[i]
      if (box && typeof box.left === 'number') {
        labelRegions.push({ page, left: box.left, right: box.right, top: box.top, bottom: box.bottom, ...fit })
      } else {
        const { width, height } = page.getSize()
        labelRegions.push({ page, left: c.left * width, right: c.right * width, top: height * (1 - c.top), bottom: height * (1 - c.bottom), ...fit })
      }
    })
  } else if (source === 'myntra') {
    // Label and invoice arrive as separate PDFs, 1 page each. An invoice is
    // taken whole (it's already a full A4 of content); a label gets the crop
    // that trims its blank page margins.
    const c = flipkartCrop
    for (const page of srcPages) {
      const { width, height } = page.getSize()
      if (role === 'bill') {
        if (wantBills) billRegions.push({ page, left: 0, right: width, top: height, bottom: 0 })
      } else {
        labelRegions.push({ page, left: c.left * width, right: c.right * width, top: height * (1 - c.top), bottom: height * (1 - c.bottom) })
      }
    }
  } else if (source === 'flipkart') {
    const c = flipkartCrop
    for (const page of srcPages) {
      const { width, height } = page.getSize()
      labelRegions.push({ page, left: c.left * width, right: c.right * width, top: height * (1 - c.top), bottom: height * (1 - c.bottom) })
      if (wantBills) {
        billRegions.push({ page, left: 0, right: width, top: height * (1 - c.bottom), bottom: 0 })
      }
    }
  } else if (layout && layout.length === srcPages.length) {
    // amazon, auto-detected: exact ink bounds per quadrant (never clips the top).
    srcPages.forEach((page, i) => {
      const entry = layout[i] || { labels: [], bills: [] }
      for (const b of entry.labels) labelRegions.push({ page, left: b.left, right: b.right, top: b.top, bottom: b.bottom })
      if (wantBills) for (const b of entry.bills) billRegions.push({ page, left: b.left, right: b.right, top: b.top, bottom: b.bottom })
    })
  } else {
    // amazon fallback (no detection): split each page into a 2x2 grid by fractions.
    const A1 = { top: 0.0, bottom: 0.5 }
    const A2 = { top: 0.5, bottom: 1.0 }
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

  return { labelRegions, billRegions }
}

/**
 * Pack source regions onto sticker sheets defined by `sheet` (mm). Each region
 * is fitted inside its sticker rectangle (minus innerPad), preserving aspect
 * ratio and centered. Always starts a fresh page, so labels and bills stay on
 * separate sheets.
 *
 * `outwardX` (mm) shifts each label away from the sheet's centre line — left
 * column further left, right column further right. A label that nearly fills
 * its sticker sits only a millimetre from the centre cut, so a slightly
 * off-register printer can drop it across the line; this buys back clearance
 * on BOTH columns at once. Shifting every label the same way instead would
 * only help one of them and push the other into the cut.
 */
async function placeOnSheets(out, regions, sheet, innerPad, showOutlines, startSlot = 0, hAlign = 'center', outwardX = 0) {
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
    // A region may cap its own scale (maxScale: 1 = never enlarge, print at the
    // size it was drawn) and pick its own alignment, whatever the batch default.
    const availW = labelW - pad * 2
    const availH = labelH - pad * 2 - TOP_GAP * MM
    const scale = Math.min(availW / regW, availH / regH, r.maxScale ?? Infinity)
    const drawW = regW * scale
    const drawH = regH * scale
    // Horizontal placement. 'center' centers in the sticker; 'outer' pushes the
    // label toward the OUTER edge of its column (left column → left, right
    // column → right) so narrow labels don't crowd the centre cut line.
    const leftHalf = col < sheet.cols / 2
    const align = r.hAlign || hAlign
    let x
    if (align === 'outer' && r.edgeMargin != null) {
      // Measured off the paper's outer edge, not the sticker grid — the grid's
      // margin is the gap being closed, so it can't be the thing we measure from.
      const edge = r.edgeMargin * MM
      x = leftHalf ? edge : pageW - edge - drawW
    } else if (align === 'outer') {
      x = leftHalf ? cellLeft + pad : cellLeft + labelW - drawW - pad
    } else {
      x = cellLeft + (labelW - drawW) / 2
    }
    if (outwardX) {
      // Away from the centre line, then kept on the paper — a nudge big enough
      // to run a label off the sheet would just clip it.
      x += (leftHalf ? -1 : 1) * outwardX * MM
      x = Math.max(0, Math.min(pageW - drawW, x))
    }
    // Top-align inside the sticker so labels in the same row line up exactly.
    const y = cellBottom + labelH - drawH - pad - TOP_GAP * MM

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

/**
 * Build a sheet of repeated TEXT stickers (no source PDF needed). Prints `text`
 * `count` times onto the same sticker grid used for labels, flowing onto a new
 * A4 sheet every cols*rows stickers. `startSlot` skips already-used stickers, so
 * you can print onto just one part of a partly-used sheet.
 *
 * @returns {Promise<{bytes: Uint8Array, labelCount, sheetCount}>}
 */
export async function buildTextLabelPdf(options = {}) {
  const {
    text = '',
    count = 1,
    entries = null, // [{text, count}] — different sizes/texts, grouped in order
    fontSize = 1000, // upper cap; text auto-sizes to fill the cell up to this
    bold = true,
    align = 'center',
    sheet = DEFAULT_SHEET,
    startSlot = 0,
    showOutlines = false,
    innerPad = 1.5,
  } = options

  const out = await PDFDocument.create()
  const font = await out.embedFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica)

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
  const offset = ((startSlot % perPage) + perPage) % perPage

  // Build the flat list of label texts. With `entries`, each size's text is
  // repeated its count times, kept grouped in the order given.
  const items =
    entries && entries.length
      ? entries.flatMap((e) => Array(Math.max(0, Math.floor(e.count || 0))).fill(String(e.text ?? '')))
      : Array(Math.max(0, Math.floor(count))).fill(text)
  const n = items.length

  // Auto-size: pick the largest font (capped at fontSize) at which EVERY label
  // still fits its cell. Bigger cells / less padding → bigger text; small cells
  // shrink the text so it never overflows or overlaps.
  const availW = labelW - pad * 2
  const availH = labelH - pad * 2
  const cap = Math.max(4, Math.min(fontSize, Math.ceil(availH)))
  let drawSize = cap
  for (const t of new Set(items)) {
    drawSize = Math.min(drawSize, fitFontSize(font, t, cap, availW, availH))
  }

  // Fill one label per cell, row by row (left→right, top→bottom), flowing onto a
  // new A4 every cols*rows cells. startSlot skips already-used cells.
  let page = null
  for (let k = 0; k < n; k++) {
    const slot = (offset + k) % perPage
    if (k === 0 || slot === 0) page = out.addPage([pageW, pageH])

    const col = slot % sheet.cols
    const row = Math.floor(slot / sheet.cols)
    const cellLeft = mLeft + col * (labelW + gapX)
    const cellBottom = pageH - (mTop + row * (labelH + gapY)) - labelH

    if (showOutlines) {
      page.drawRectangle({ x: cellLeft, y: cellBottom, width: labelW, height: labelH, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 0.5 })
    }
    try {
      drawCenteredText(page, font, items[k], drawSize, align, cellLeft + pad, cellBottom + pad, labelW - pad * 2, labelH - pad * 2)
    } catch {
      throw new Error('That text has characters this label font can’t print yet (e.g. Hindi). Use English letters, numbers and symbols.')
    }
  }

  const bytes = await out.save()
  return { bytes, labelCount: n, sheetCount: out.getPageCount() }
}

// Widest a single barcode module (the "X dimension") is allowed to get. Without
// a cap, a short code would blow up to bars several mm wide on a big sticker —
// legal, but it wastes the sticker and looks wrong. 1 mm is the top of the
// usual X-dimension range.
const MAX_MODULE_MM = 1

/**
 * Build a sheet of BARCODE stickers. Each entry is a value + how many copies to
 * print; they're packed onto the same sticker grid the other modes use.
 *
 * Bars are drawn as vector rectangles, so they stay razor-sharp at any size —
 * which is what a scanner needs.
 *
 * @param {object} options
 * @param {Array}   options.entries       [{text, count}] — value and how many copies
 * @param {string}  options.symbology     'code128' (default) | 'code39'
 * @param {boolean} options.showText      print the value under the bars (default true)
 * @param {boolean} options.bold          bold the caption
 * @param {object}  options.sheet         sticker template in mm (see DEFAULT_SHEET)
 * @param {number}  options.startSlot     first sticker position to fill
 * @param {boolean} options.showOutlines  draw a thin border at each position
 * @param {number}  options.innerPad      mm of quiet space inside each sticker
 * @param {number}  options.barHeightPct  bar height as a % of the usable sticker height
 * @returns {Promise<{bytes: Uint8Array, labelCount, sheetCount}>}
 */
export async function buildBarcodeLabelPdf(options = {}) {
  const {
    entries = [],
    symbology = 'code128',
    showText = true,
    bold = false,
    sheet = DEFAULT_SHEET,
    startSlot = 0,
    showOutlines = false,
    innerPad = 2,
    barHeightPct = 55,
  } = options

  const out = await PDFDocument.create()
  const font = await out.embedFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica)

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
  const offset = ((startSlot % perPage) + perPage) % perPage

  // One sticker per copy, each entry's copies kept together in the order given.
  const items = entries.flatMap((e) =>
    Array(Math.max(0, Math.floor(e.count || 0))).fill(String(e.text ?? '')),
  )
  const n = items.length
  if (!n) return { bytes: await out.save(), labelCount: 0, sheetCount: 0 }

  // Encode up front so a bad character fails before we draw anything.
  const encoded = new Map()
  for (const t of new Set(items)) encoded.set(t, encodeBarcode(t, symbology))

  const availW = labelW - pad * 2
  const availH = labelH - pad * 2
  const quiet = QUIET_MODULES[symbology] ?? 10
  const gapUnderBars = 1.2 * MM
  const barH = Math.max(0, availH * (Math.min(100, Math.max(10, barHeightPct)) / 100))
  const textBox = showText ? Math.max(0, availH - barH - gapUnderBars) : 0

  // One caption size for every sticker, so the whole sheet reads evenly.
  let capSize = Math.min(textBox / 1.15, 40)
  if (showText && capSize >= 4) {
    for (const t of new Set(items)) capSize = Math.min(capSize, fitFontSize(font, t, capSize, availW, textBox))
  }
  const capH = showText && capSize >= 4 ? capSize * 1.15 : 0

  let page = null
  for (let k = 0; k < n; k++) {
    const slot = (offset + k) % perPage
    if (k === 0 || slot === 0) page = out.addPage([pageW, pageH])

    const col = slot % sheet.cols
    const row = Math.floor(slot / sheet.cols)
    const cellLeft = mLeft + col * (labelW + gapX)
    const cellBottom = pageH - (mTop + row * (labelH + gapY)) - labelH

    if (showOutlines) {
      page.drawRectangle({ x: cellLeft, y: cellBottom, width: labelW, height: labelH, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 0.5 })
    }

    const bits = encoded.get(items[k])
    if (!bits) continue

    // Fit the symbol (plus its quiet zones) across the sticker, capped so the
    // bars of a short code don't balloon.
    const totalModules = bits.length + quiet * 2
    const moduleW = Math.min(availW / totalModules, MAX_MODULE_MM * MM)
    const drawW = moduleW * totalModules

    // Centre the bars + caption block vertically inside the sticker.
    const blockH = barH + (capH ? gapUnderBars + capH : 0)
    const blockBottom = cellBottom + pad + (availH - blockH) / 2
    const barsBottom = blockBottom + (capH ? gapUnderBars + capH : 0)
    const barsLeft = cellLeft + pad + (availW - drawW) / 2 + quiet * moduleW

    drawBars(page, bits, barsLeft, barsBottom, moduleW, barH)

    if (capH) {
      drawCenteredText(page, font, items[k], capSize, 'center', cellLeft + pad, blockBottom, availW, capH)
    }
  }

  const bytes = await out.save()
  return { bytes, labelCount: n, sheetCount: out.getPageCount() }
}

/**
 * Build a sheet of LOGO stickers: one image repeated onto the same sticker grid
 * the other modes use. Pair it with `gridSheet`-style templates to tile many
 * small logos inside each pre-cut part.
 *
 * @param {object} options
 * @param {Uint8Array} options.imageBytes  the logo, as PNG or JPEG bytes
 * @param {'png'|'jpg'} options.imageType  which of the two it is
 * @param {number}  options.count          how many stickers to print
 * @param {number}  options.sizePct        how much of each sticker the logo fills (10-100)
 * @param {boolean} options.rotate         turn the logo 90° (a wide logo down a tall sticker)
 * @param {object}  options.sheet          sticker template in mm (see DEFAULT_SHEET)
 * @param {number}  options.startSlot      first sticker position to fill
 * @param {boolean} options.showOutlines   draw a thin border at each position
 * @param {number}  options.innerPad       mm of clear space inside each sticker
 * @returns {Promise<{bytes: Uint8Array, labelCount, sheetCount}>}
 */
export async function buildLogoLabelPdf(options = {}) {
  const {
    imageBytes = null,
    imageType = 'png',
    count = 1,
    sizePct = 100,
    rotate = false,
    sheet = DEFAULT_SHEET,
    startSlot = 0,
    showOutlines = false,
    innerPad = 3,
  } = options

  const out = await PDFDocument.create()
  const n = Math.max(0, Math.floor(count))
  if (!imageBytes || !n) return { bytes: await out.save(), labelCount: 0, sheetCount: 0 }

  let img
  try {
    img = imageType === 'jpg' ? await out.embedJpg(imageBytes) : await out.embedPng(imageBytes)
  } catch {
    throw new Error('That image couldn’t be read. Try a PNG or JPG export of your logo.')
  }

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
  const offset = ((startSlot % perPage) + perPage) % perPage
  const pct = Math.min(100, Math.max(5, sizePct)) / 100

  const availW = Math.max(0, labelW - pad * 2)
  const availH = Math.max(0, labelH - pad * 2)
  // Upright, the logo fills the sticker the usual way. Turned, it's the SWAPPED
  // box that has to fit — a 5:1 wide logo becomes 1:5 tall — so the fit is run
  // against the flipped dimensions and the drawn size read back the other way.
  const scale = rotate
    ? Math.min(availH / img.width, availW / img.height) * pct
    : Math.min(availW / img.width, availH / img.height) * pct
  const drawW = img.width * scale
  const drawH = img.height * scale
  // What the logo takes up on the page once it's been turned.
  const visW = rotate ? drawH : drawW
  const visH = rotate ? drawW : drawH

  let page = null
  for (let k = 0; k < n; k++) {
    const slot = (offset + k) % perPage
    if (k === 0 || slot === 0) page = out.addPage([pageW, pageH])

    const col = slot % sheet.cols
    const row = Math.floor(slot / sheet.cols)
    const cellLeft = mLeft + col * (labelW + gapX)
    const cellBottom = pageH - (mTop + row * (labelH + gapY)) - labelH

    if (showOutlines) {
      page.drawRectangle({ x: cellLeft, y: cellBottom, width: labelW, height: labelH, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 0.5 })
    }

    // Centre the logo in the sticker, on both axes.
    const x = cellLeft + pad + (availW - visW) / 2
    const y = cellBottom + pad + (availH - visH) / 2
    if (rotate) {
      // drawImage turns the image about its bottom-left corner, so that corner
      // has to start a full visual width to the right of where it ends up.
      page.drawImage(img, { x: x + visW, y, width: drawW, height: drawH, rotate: degrees(90) })
    } else {
      page.drawImage(img, { x, y, width: drawW, height: drawH })
    }
  }

  const bytes = await out.save()
  return { bytes, labelCount: n, sheetCount: out.getPageCount() }
}

/**
 * Draw a module string ('1' = bar, '0' = space) as black rectangles, one per run
 * of bars, starting at (x, y) and growing right. Vector output — no blur.
 */
function drawBars(page, bits, x, y, moduleW, height) {
  let i = 0
  while (i < bits.length) {
    if (bits[i] === '1') {
      let run = 1
      while (bits[i + run] === '1') run++
      page.drawRectangle({
        x: x + i * moduleW,
        y,
        width: run * moduleW,
        height,
        color: rgb(0, 0, 0),
      })
      i += run
    } else {
      i++
    }
  }
}

/**
 * Largest font size (≤ requested) at which `text` fits inside a w×h box, after
 * word-wrapping. Steps down from the requested size to a small floor.
 */
function fitFontSize(font, text, requested, w, h) {
  if (!text || !text.trim() || w <= 0 || h <= 0) return requested
  const MIN = 4
  let size = Math.max(MIN, requested)
  while (size > MIN) {
    const lines = wrapLines(font, text, size, w)
    const totalH = lines.length * size * 1.25
    const widest = Math.max(0, ...lines.map((l) => font.widthOfTextAtSize(l, size)))
    if (totalH <= h && widest <= w) break
    size -= 1
  }
  return size
}

/** Wrap `text` into lines that fit `maxWidth`, honoring explicit newlines. */
function wrapLines(font, text, fontSize, maxWidth) {
  const lines = []
  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) {
      lines.push('')
      continue
    }
    let line = words[0]
    for (let i = 1; i < words.length; i++) {
      const test = line + ' ' + words[i]
      if (font.widthOfTextAtSize(test, fontSize) <= maxWidth) line = test
      else {
        lines.push(line)
        line = words[i]
      }
    }
    lines.push(line)
  }
  return lines
}

/** Draw wrapped text centered vertically and (by default) horizontally in a box. */
function drawCenteredText(page, font, text, fontSize, align, x, y, w, h) {
  if (!text || !text.trim()) return
  const lines = wrapLines(font, text, fontSize, w)
  const lineHeight = fontSize * 1.25
  const totalH = lines.length * lineHeight
  // Baseline of the first (top) line so the whole block is vertically centered.
  let cursorY = y + h / 2 + totalH / 2 - lineHeight + (lineHeight - fontSize) / 2
  for (const line of lines) {
    const tw = font.widthOfTextAtSize(line, fontSize)
    const tx = align === 'left' ? x : x + (w - tw) / 2
    page.drawText(line, { x: tx, y: cursorY, size: fontSize, font, color: rgb(0, 0, 0) })
    cursorY -= lineHeight
  }
}

/**
 * Keep each order together: label on the LEFT, its invoice on the RIGHT, both
 * fitted side by side in one row, `rowsPerPage` orders stacked per A4 page.
 * `labels[i]` is paired with `bills[i]`. Either side may be missing (null) — the
 * other is still placed.
 */
async function placePairs(out, labels, bills, rowsPerPage = 2) {
  const pageW = 210 * MM
  const pageH = 297 * MM
  const margin = 6 * MM
  const gap = 5 * MM // space between the label and the bill
  const rowH = pageH / rowsPerPage
  const cellW = (pageW - margin * 2 - gap) / 2
  const cellH = rowH - margin * 2
  const n = Math.max(labels.length, bills.length)

  let page = null
  for (let i = 0; i < n; i++) {
    const slot = i % rowsPerPage
    if (slot === 0) page = out.addPage([pageW, pageH])
    const rowBottom = pageH - (slot + 1) * rowH // slot 0 = top row
    const cellBottom = rowBottom + margin
    // Label fills the left cell, invoice the right cell.
    await drawFitted(out, page, labels[i], margin, cellBottom, cellW, cellH)
    await drawFitted(out, page, bills[i], margin + cellW + gap, cellBottom, cellW, cellH)
  }
}

/**
 * Embed a source region and draw it fitted (aspect-preserved) into the target
 * rectangle [x, y, w, h], centered horizontally and top-aligned. No-op if the
 * region is missing.
 */
async function drawFitted(out, page, region, x, y, w, h) {
  if (!region) return
  const embedded = await out.embedPage(region.page, {
    left: region.left,
    bottom: region.bottom,
    right: region.right,
    top: region.top,
  })
  const regW = region.right - region.left
  const regH = region.top - region.bottom
  const scale = Math.min(w / regW, h / regH)
  const drawW = regW * scale
  const drawH = regH * scale
  const dx = x + (w - drawW) / 2
  const dy = y + h - drawH // top-align
  page.drawPage(embedded, { x: dx, y: dy, width: drawW, height: drawH })
}

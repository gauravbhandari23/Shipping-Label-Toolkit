import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

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

// Myntra: 1 shipping label per page, no invoice. The label is a full-page image
// with a blank right margin, so the default crop just trims that margin. Same
// top-left fraction format as FLIPKART_CROP; the user can fine-tune it.
export const MYNTRA_CROP = {
  left: 0.0,
  right: 0.86, // trim the blank right margin
  top: 0.0,
  bottom: 1.0,
}

/**
 * Build a labels PDF from an Amazon or Flipkart "label + invoice" PDF, laid out
 * to match a pre-cut sticker sheet (default: A4 ST4 / Avery L7169, 4 per sheet).
 *
 * Source layouts:
 *   amazon   — 2 orders per page in a 2x2 grid: labels = LEFT column, invoices = RIGHT column.
 *   flipkart — 1 order per page: label on TOP, invoice on BOTTOM (split by a horizontal line).
 *   myntra   — 1 label per page, NO invoice; the whole page is the label (crop trims margins).
 *
 * @param {ArrayBuffer} arrayBuffer  raw bytes of the uploaded PDF
 * @param {object} options
 * @param {'amazon'|'flipkart'|'myntra'} options.source  which marketplace layout (default 'amazon')
 * @param {number}  options.splitRatio    [amazon] fraction of page width that is the label (default 0.5)
 * @param {object}  options.flipkartCrop  [flipkart/myntra] crop box as top-left fractions
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
  const { source = 'amazon', splitRatio = 0.5, flipkartCrop = FLIPKART_CROP, layout = null, ...rest } = options
  return buildCombinedLabelPdf([{ arrayBuffer, source, splitRatio, flipkartCrop, layout }], rest)
}

/**
 * Build one output PDF from MANY source PDFs at once. Each item carries its own
 * marketplace + crop/layout, so a batch can even mix Amazon/Flipkart/Myntra.
 * Labels from every file are packed together onto the sticker sheets; bills are
 * grouped by their source so each marketplace's invoices lay out correctly.
 *
 * @param {Array<{arrayBuffer, source, splitRatio?, flipkartCrop?, layout?}>} items
 * @param {object} options  shared layout options (innerPad, showOutlines,
 *        includeBills, billsOnly, pairs, sheet, startSlot)
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
  } = options

  const wantLabels = pairs || !billsOnly
  const wantBills = pairs || includeBills || billsOnly

  const out = await PDFDocument.create()
  const allLabels = []
  const allBills = []
  const flipkartBills = [] // full-width invoices stack 2 per page
  const stickerBills = [] // Amazon half-page invoices pack onto sticker sheets

  for (const item of items) {
    const src = await PDFDocument.load(item.arrayBuffer)
    const srcPages = src.getPages()
    if (!srcPages.length) continue
    const source = item.source || 'amazon'
    const { labelRegions, billRegions } = collectRegions(srcPages, {
      source,
      splitRatio: item.splitRatio ?? 0.5,
      flipkartCrop: item.flipkartCrop || FLIPKART_CROP,
      layout: item.layout || null,
      wantBills,
    })
    allLabels.push(...labelRegions)
    allBills.push(...billRegions)
    if (source === 'flipkart') flipkartBills.push(...billRegions)
    else stickerBills.push(...billRegions)
  }

  if (!allLabels.length && !allBills.length) {
    throw new Error('No pages found in the PDF(s).')
  }

  if (pairs) {
    await placePairs(out, allLabels, allBills, 2)
  } else {
    if (wantLabels) {
      await placeOnSheets(out, allLabels, sheet, innerPad, showOutlines, startSlot)
    }
    if (wantBills) {
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
function collectRegions(srcPages, { source, splitRatio, flipkartCrop, layout, wantBills }) {
  const labelRegions = []
  const billRegions = []

  if (source === 'myntra') {
    // 1 shipping label per page, no invoice. Crop trims the page margins.
    const c = flipkartCrop
    for (const page of srcPages) {
      const { width, height } = page.getSize()
      labelRegions.push({ page, left: c.left * width, right: c.right * width, top: height * (1 - c.top), bottom: height * (1 - c.bottom) })
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

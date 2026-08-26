import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { createWorker } from 'tesseract.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

/**
 * Myntra label ↔ bill pairing.
 *
 * Myntra hands you the shipping label and the tax invoice as SEPARATE PDFs, and
 * the two share no machine-readable key: the label carries a Code128 tracking
 * number plus a DataMatrix of routing codes, the bill a Code128 PacketID plus a
 * UPI QR — none of which overlap. Both documents are also a single flattened
 * image with no text layer, so nothing can be read straight out of the PDF.
 *
 * What they DO share is the buyer: the same name and the same delivery address
 * are printed on both. So we OCR the buyer block off each page and match on
 * that. Pincode alone isn't enough (many orders land in one pincode), so it
 * only acts as a hard filter and the street address decides the pairing.
 */

// Rendered width (px) fed to OCR. Normalises label pages (~327 DPI source) and
// invoice pages (~637 DPI source) to the same working size, so one set of
// thresholds fits both.
const TARGET_W = 1700
// Only the top slice of the page is OCR'd — the buyer block sits at ~20-35% on
// labels and ~24-32% on invoices. Skipping the rest keeps OCR fast.
const TOP_FRACTION = 0.45

// An invoice page embeds a much larger image than a label page (~37.9M px vs
// ~10.0M px on Myntra's own exports). Only used when OCR can't classify.
const BILL_MIN_PIXELS = 20_000_000

let workerPromise = null

/** Lazily start one shared OCR worker and keep it for the session. */
function getOcrWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng').catch((e) => {
      workerPromise = null
      throw e
    })
  }
  return workerPromise
}

/** Shut the OCR worker down (frees its memory). Safe to call any time. */
export async function disposeOcr() {
  const p = workerPromise
  workerPromise = null
  if (!p) return
  try {
    const w = await p
    await w.terminate()
  } catch {
    /* ignore */
  }
}

/**
 * Read one Myntra PDF: work out whether it's a shipping label or a tax invoice,
 * and pull the buyer's name / address / pincode off it.
 *
 * @param {ArrayBuffer} arrayBuffer  a COPY of the PDF bytes (pdf.js detaches it)
 * @returns {Promise<{role, name, address, pincode, text, ocrFailed}>}
 */
export async function readMyntraDoc(arrayBuffer) {
  const { canvas, imagePixels } = await renderTopSlice(arrayBuffer)

  let text = ''
  let ocrFailed = false
  try {
    const worker = await getOcrWorker()
    const { data } = await worker.recognize(canvas)
    text = data?.text || ''
  } catch (e) {
    console.warn('[Rangrooh] OCR failed for a Myntra page:', e)
    ocrFailed = true
  }

  const parsed = parseBuyerBlock(text)
  // OCR wording decides the role; fall back to the page's image size if the
  // text was too poor to tell (or OCR never ran).
  const role = parsed.role || (imagePixels >= BILL_MIN_PIXELS ? 'bill' : 'label')
  return { ...parsed, role, text, ocrFailed }
}

/**
 * Render the top slice of page 1 to a canvas, and report the size of the
 * biggest image drawn on that page (the classification fallback).
 */
async function renderTopSlice(arrayBuffer) {
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  try {
    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const scale = Math.min(4, Math.max(1, TARGET_W / base.width))
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    // A short canvas simply clips the bottom — pdf.js draws from the top-left,
    // so what survives is exactly the slice we want.
    canvas.height = Math.ceil(viewport.height * TOP_FRACTION)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport, canvas }).promise

    const imagePixels = await biggestImagePixels(page)
    page.cleanup?.()
    return { canvas, imagePixels }
  } finally {
    if (typeof doc.destroy === 'function') await doc.destroy()
  }
}

/** Pixel count of the largest image XObject painted on the page (0 if none). */
async function biggestImagePixels(page) {
  try {
    const OPS = pdfjsLib.OPS
    const imgOps = [OPS.paintImageXObject, OPS.paintJpegXObject, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObject]
    const opList = await page.getOperatorList()
    let best = 0
    for (let i = 0; i < opList.fnArray.length; i++) {
      if (!imgOps.includes(opList.fnArray[i])) continue
      const args = opList.argsArray[i]
      const w = Number(args?.[1]) || 0
      const h = Number(args?.[2]) || 0
      best = Math.max(best, w * h)
    }
    return best
  } catch {
    return 0
  }
}

// Right-hand column text that OCR interleaves into the buyer block.
const NOISE = /^(customer\s*type|bill\s*from|ship\s*from|gstin|place\s*of\s*supply|nature\s*of)/i

/**
 * Pull the buyer's name, address and pincode out of an OCR'd page, and work out
 * which kind of document it came from.
 *
 * The buyer block is bounded by fixed wording on each layout:
 *   invoice — between "Bill to / Ship to:" and "Bill From:"
 *   label   — between "Buyer's Name And Address" and "If undelivered"
 * Those bounds matter: both pages also print the SELLER's Jaipur address
 * (pincode 302018), and without them we'd match every order to every other.
 */
function parseBuyerBlock(text) {
  const flat = String(text || '').replace(/\r/g, '')
  const lower = flat.toLowerCase()

  let role = null
  if (/tax\s*invoice|packet\s*?id|gstin\s*number/.test(lower)) role = 'bill'
  else if (/undelivered|buyer.{0,3}s?\s*name\s*and\s*address|buyer\s*declaration/.test(lower)) role = 'label'

  const at = (re) => {
    const m = lower.match(re)
    return m ? m.index + m[0].length : -1
  }
  const upto = (re, from) => {
    const m = lower.slice(from).match(re)
    return m ? from + m.index : -1
  }

  let start = -1
  let end = -1
  if (role === 'bill') {
    start = at(/bill\s*to\s*\/?\s*ship\s*to\s*:?/)
    if (start >= 0) end = upto(/bill\s*from/, start)
  } else {
    start = at(/buyer.{0,3}s?\s*name\s*and\s*address\s*:?/)
    if (start >= 0) end = upto(/if\s*undelivered/, start)
  }

  const window = start >= 0 ? flat.slice(start, end > start ? end : undefined) : flat
  const lines = window
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l))

  const name = lines[0] || ''
  const address = lines.slice(1).join(' ')
  // 6-digit runs only; the first one inside the buyer block is the delivery
  // pincode (the seller's sits outside the window).
  const pin = window.match(/\b(\d{6})\b/)

  return { name, address, pincode: pin ? pin[1] : '' }
}

// Words that appear on nearly every address and so carry no matching signal.
const STOPWORDS = new Set([
  'india', 'near', 'no', 'nos', 'house', 'flat', 'plot', 'the', 'and', 'street',
  'road', 'sector', 'floor', 'block', 'phase', 'nagar', 'colony', 'opp', 'behind',
])

function tokenise(s) {
  return (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    // 6-digit runs are the pincode, which is scored separately — counting it
    // here too would let everyone in one pincode look alike.
    (t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d{6}$/.test(t),
  )
}

/** Overlap of two token lists, 0..1, relative to the smaller set. */
function overlap(a, b) {
  const A = new Set(a)
  const B = new Set(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const t of A) if (B.has(t)) hit++
  return hit / Math.min(A.size, B.size)
}

/**
 * How strongly one label matches one bill, out of 100. Returns -1 when the two
 * pincodes are both known and different — a hard "not this one", so a busy
 * pincode can never pull in an order from somewhere else.
 *
 * The street address carries most of the weight: a shared pincode is worth
 * little on its own (thousands of orders share one), so it only tops up a match
 * the address already supports.
 */
function scorePair(label, bill) {
  if (label.pincode && bill.pincode && label.pincode !== bill.pincode) return -1
  let score = 0
  score += overlap(
    tokenise(`${label.name} ${label.address}`),
    tokenise(`${bill.name} ${bill.address}`),
  ) * 60
  score += overlap(tokenise(label.name), tokenise(bill.name)) * 20
  if (label.pincode && bill.pincode && label.pincode === bill.pincode) score += 20
  return score
}

// Below this a pairing isn't trustworthy enough to print. Low enough that a
// smudged scan still matches its own bill, high enough that two different
// orders sharing a pincode never do.
const MATCH_FLOOR = 50
// Two candidates this close apart can't be told apart — flag instead of guess.
const AMBIGUOUS_GAP = 8

/**
 * Put the labels in the order they were downloaded, oldest first.
 *
 * `lastModified` is the file's save time, which for a downloaded file is the
 * moment the download finished writing. It survives a normal download and a
 * normal copy, but a zip/unzip, a cloud sync or a "save as" rewrites every file
 * to the same instant — so when the batch carries no usable spread of times,
 * fall back to the order the files were dropped in.
 *
 * @returns {{ordered: Array, orderedBy: 'time'|'upload'}}
 */
function orderByDownload(labels) {
  const times = labels.map((l) => Number(l.doc?.lastModified))
  const usable =
    times.every((t) => Number.isFinite(t) && t > 0) &&
    // All-identical means the timestamps were rewritten in bulk and carry no
    // ordering. A single label needs no ordering either way.
    (labels.length < 2 || new Set(times).size > 1)
  if (!usable) return { ordered: labels, orderedBy: 'upload' }

  // Stable, so two downloads that landed in the same millisecond keep the
  // order they were dropped in.
  const ordered = labels
    .map((label, i) => ({ label, t: times[i] }))
    .sort((a, b) => a.t - b.t)
    .map((e) => e.label)
  return { ordered, orderedBy: 'time' }
}

/**
 * Pair labels with bills on buyer name + address. Greedy best-first: the
 * strongest pair in the whole batch is taken, then the next strongest among
 * what's left, and so on.
 *
 * Download time decides the print ORDER, the address decides the PAIRING — two
 * separate jobs. A bill's own download time is never consulted; it simply
 * follows whichever label it matched.
 *
 * @param {Array} labels  entries from readMyntraDoc, role 'label'
 * @param {Array} bills   entries from readMyntraDoc, role 'bill'
 * @returns {{pairs, unmatchedLabels, unmatchedBills, orderedBy}}  pairs are
 *          {label, bill, score, ambiguous}, oldest download first.
 */
export function pairMyntraDocs(labels, bills) {
  const { ordered, orderedBy } = orderByDownload(labels)

  const candidates = []
  for (const label of ordered) {
    for (const bill of bills) {
      const score = scorePair(label, bill)
      if (score >= MATCH_FLOOR) candidates.push({ label, bill, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score)

  // Work out ambiguity BEFORE assigning anything: if a label has two bills that
  // score within a whisker of each other (the same buyer ordering twice to one
  // address), every document involved is doubtful — not just whichever one the
  // greedy pass happens to reach first.
  const contested = new Set()
  for (const side of ['label', 'bill']) {
    const byDoc = new Map()
    for (const c of candidates) {
      const key = c[side]
      if (!byDoc.has(key)) byDoc.set(key, [])
      byDoc.get(key).push(c)
    }
    for (const [doc, list] of byDoc) {
      if (list.length > 1 && list[0].score - list[1].score < AMBIGUOUS_GAP) contested.add(doc)
    }
  }

  const usedLabels = new Set()
  const usedBills = new Set()
  const pairs = []
  for (const c of candidates) {
    if (usedLabels.has(c.label) || usedBills.has(c.bill)) continue
    usedLabels.add(c.label)
    usedBills.add(c.bill)
    pairs.push({ ...c, ambiguous: contested.has(c.label) || contested.has(c.bill) })
  }

  // Print in download order rather than match strength — that's the order the
  // sheets come out in, and match strength means nothing to whoever's holding
  // them.
  pairs.sort((a, b) => ordered.indexOf(a.label) - ordered.indexOf(b.label))

  return {
    pairs,
    orderedBy,
    unmatchedLabels: ordered.filter((l) => !usedLabels.has(l)),
    unmatchedBills: bills.filter((b) => !usedBills.has(b)),
  }
}

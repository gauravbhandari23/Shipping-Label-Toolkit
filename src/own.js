import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

/**
 * Your OWN shipping labels — the ones your store prints itself (Shiprocket /
 * Delhivery manifests and the like), as opposed to a marketplace's.
 *
 * These come out of an HTML-to-PDF printer, so unlike the marketplace PDFs they
 * are live text and vector rules, not a flattened image. Two things follow:
 *
 *   • The page is usually 4x6in but the artwork only fills the TOP of it — the
 *     rest is empty paper. Dropped straight onto a sticker as-is, the label
 *     would be shrunk to fit that empty space too and come out far too small.
 *   • Every edge of the label is drawn as a real path, so the exact artwork box
 *     can be measured off the page without rendering anything.
 *
 * So we measure the ink and hand back that box; the sheet builder then crops to
 * it and each label fills its quarter of the A4 properly.
 */

// Breathing room (PDF points) left around the measured ink, so the label's own
// border line can't be shaved off by rounding.
const PAD = 2
// A filled path this light is page background, not artwork. wkhtmltopdf paints
// a big white block behind the label; counted as ink it would stretch the box
// out to the full page and undo the whole point of measuring.
const BG_LEVEL = 0.94
// A path covering this much of the page is the page itself (background fill or
// the clip box), whatever colour it claims to be.
const BG_AREA_FRAC = 0.92
// Sanity floor: real artwork covers a decent part of the page. Anything smaller
// means the measurement went wrong, and a wrong crop is worse than none.
const MIN_INK_FRAC = 0.2

/**
 * Phrases this label layout prints that a marketplace label doesn't. Two or
 * more of them together is a solid identification — single ones aren't, since
 * "routing code" and "if undelivered" also show up on courier labels from
 * Flipkart and friends.
 */
const OWN_MARKERS = [
  /rto\s*routing\s*code/,
  /collectable\s*amount/,
  /ewaybill\s*no/,
  /shipped\s*by\s*\(?\s*if\s*undelivered/,
  /order\s*total\s*:/,
  /auto\s*generated\s*label/,
]
const MIN_MARKERS = 2

/** True if page text reads like one of your own labels. */
export function isOwnLabelText(text) {
  const t = String(text || '').toLowerCase()
  let hits = 0
  for (const re of OWN_MARKERS) if (re.test(t)) hits++
  return hits >= MIN_MARKERS
}

/**
 * Measure the artwork box on every page of your own label PDF, WITHOUT
 * rendering it: walk the operator list tracking the transform, collect the
 * boxes of everything drawn (paths, images, text), throw away the page
 * background, and take the union.
 *
 * @param {ArrayBuffer} arrayBuffer  a COPY of the PDF bytes (pdf.js detaches it)
 * @returns {Promise<Array<{left, bottom, right, top}>|null>}  one box per page in
 *          PDF points (origin bottom-left), or null if it couldn't be measured
 *          so the caller can fall back to a plain crop.
 */
export async function analyzeOwnLayout(arrayBuffer) {
  try {
    const OPS = pdfjsLib.OPS
    if (!OPS) return null
    const IMG_OPS = [
      OPS.paintImageXObject,
      OPS.paintJpegXObject,
      OPS.paintImageXObjectRepeat,
      OPS.paintInlineImageXObject,
    ]

    const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
    const out = []

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const [x0, y0, x1, y1] = page.view
      const pw = x1 - x0
      const ph = y1 - y0
      const pageArea = pw * ph
      const boxes = []

      const add = (l, b, r, t) => {
        if (![l, b, r, t].every(Number.isFinite)) return
        // Clip to the page: an off-page mark is never part of the label.
        const box = {
          l: Math.max(x0, l),
          b: Math.max(y0, b),
          r: Math.min(x1, r),
          t: Math.min(y1, t),
        }
        if (box.r <= box.l || box.t <= box.b) return
        if ((box.r - box.l) * (box.t - box.b) >= pageArea * BG_AREA_FRAC) return // page-sized = background
        boxes.push(box)
      }

      // --- Everything drawn, with the transform tracked by hand ---
      const opList = await page.getOperatorList()
      let ctm = [1, 0, 0, 1, 0, 0]
      let light = false // is the current fill colour page-background pale?
      const stack = []
      for (let k = 0; k < opList.fnArray.length; k++) {
        const fn = opList.fnArray[k]
        const args = opList.argsArray[k]
        if (fn === OPS.save) {
          stack.push([ctm.slice(), light])
        } else if (fn === OPS.restore) {
          const prev = stack.pop()
          if (prev) [ctm, light] = prev
        } else if (fn === OPS.transform) {
          ctm = multiply(ctm, args)
        } else if (fn === OPS.setFillRGBColor) {
          light = isLight(args)
        } else if (IMG_OPS.includes(fn)) {
          // The image fills the unit square, transformed by the current matrix.
          const c = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)]
          add(...spread(c))
        } else if (fn === OPS.constructPath) {
          // pdf.js hands us the path's own bounding box [minX, minY, maxX, maxY]
          // in path space — put it through the transform to land on the page.
          const mm = args && args[2]
          if (light || !mm || mm.length < 4) continue
          const c = [
            apply(ctm, mm[0], mm[1]),
            apply(ctm, mm[2], mm[1]),
            apply(ctm, mm[0], mm[3]),
            apply(ctm, mm[2], mm[3]),
          ]
          add(...spread(c))
        }
      }

      // --- Text ---
      const tc = await page.getTextContent()
      for (const it of tc.items) {
        const tr = it.transform
        // Blank items are pdf.js's spacing markers between runs: they carry a
        // made-up width that can reach well past the page edge.
        if (!tr || !String(it.str || '').trim()) continue
        add(tr[4], tr[5], tr[4] + (it.width || 0), tr[5] + (it.height || 0))
      }

      page.cleanup?.()
      if (!boxes.length) {
        if (typeof doc.destroy === 'function') await doc.destroy()
        return null
      }

      const ink = {
        left: Math.max(x0, Math.min(...boxes.map((b) => b.l)) - PAD),
        bottom: Math.max(y0, Math.min(...boxes.map((b) => b.b)) - PAD),
        right: Math.min(x1, Math.max(...boxes.map((b) => b.r)) + PAD),
        top: Math.min(y1, Math.max(...boxes.map((b) => b.t)) + PAD),
      }
      if (ink.right - ink.left < pw * MIN_INK_FRAC || ink.top - ink.bottom < ph * MIN_INK_FRAC) {
        if (typeof doc.destroy === 'function') await doc.destroy()
        return null
      }
      out.push(ink)
    }

    if (typeof doc.destroy === 'function') await doc.destroy()
    if (!out.length) return null
    console.info(
      '[Rangrooh] own-label trim:',
      out.map((b) => `${Math.round(b.right - b.left)}x${Math.round(b.top - b.bottom)}pt`).join(', '),
    )
    return out
  } catch (e) {
    console.warn('[Rangrooh] own-label trim failed — using the whole page:', e)
    return null
  }
}

/** Corners -> (left, bottom, right, top). */
function spread(corners) {
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/**
 * Is this fill colour near-white? pdf.js gives either a CSS hex string or raw
 * 0-255 components, depending on the operator, so both are handled.
 */
function isLight(args) {
  if (!args || !args.length) return false
  const a = args[0]
  let rgb
  if (typeof a === 'string') {
    const m = /^#?([0-9a-f]{6})$/i.exec(a.trim())
    if (!m) return false
    const n = parseInt(m[1], 16)
    rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  } else {
    rgb = [Number(args[0]), Number(args[1]), Number(args[2])]
    if (!rgb.every(Number.isFinite)) return false
  }
  return rgb.every((v) => v / 255 >= BG_LEVEL)
}

// 2x3 affine matrix helpers ([a,b,c,d,e,f], PDF convention).
function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}
function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

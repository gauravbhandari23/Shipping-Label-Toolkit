import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

// Breathing room (PDF points) added around each detected box.
const PAD = 3
// An image counts as a "label" only if it covers at least this fraction of the
// page in BOTH dimensions — filters out logos, barcodes and other small marks.
const MIN_LABEL_FRAC = 0.2

/**
 * Detect the label and invoice regions on an Amazon "label + invoice" sheet
 * WITHOUT rendering the page. On these sheets each shipping label is a single
 * flattened image (left column) and each tax invoice is live text (right
 * column). So we:
 *   • read the operator list and track the transform to find the big label
 *     images and their exact placement (this needs no image decoding, so the
 *     JBig2/WASM barcode issues never come into play);
 *   • read the text content to bound each invoice.
 * The number of big label images tells us whether the sheet holds one order or
 * two, so empty halves never become phantom labels.
 *
 * @param {ArrayBuffer} arrayBuffer  a COPY of the PDF bytes (pdf.js detaches it)
 * @returns {Promise<Array<{labels: Box[], bills: Box[]}>|null>}  per page;
 *          Box = {left, bottom, right, top} in PDF points (origin bottom-left).
 *          null if detection fails so the caller can fall back.
 */
export async function analyzeAmazonLayout(arrayBuffer) {
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
      const midX = x0 + pw / 2
      const midY = y0 + ph / 2

      // --- 1. Image boxes from the operator list (transform-tracked) ---
      const opList = await page.getOperatorList()
      let ctm = [1, 0, 0, 1, 0, 0]
      const stack = []
      const images = []
      for (let k = 0; k < opList.fnArray.length; k++) {
        const fn = opList.fnArray[k]
        if (fn === OPS.save) {
          stack.push(ctm.slice())
        } else if (fn === OPS.restore) {
          ctm = stack.pop() || [1, 0, 0, 1, 0, 0]
        } else if (fn === OPS.transform) {
          ctm = multiply(ctm, opList.argsArray[k])
        } else if (IMG_OPS.includes(fn)) {
          // The image fills the unit square, transformed by the current matrix.
          const corners = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)]
          const xs = corners.map((c) => c[0])
          const ys = corners.map((c) => c[1])
          images.push({ l: Math.min(...xs), r: Math.max(...xs), b: Math.min(...ys), t: Math.max(...ys) })
        }
      }

      // Big images in the LEFT column are the shipping labels (top one first).
      const labelImgs = images
        .filter((im) => im.r - im.l > pw * MIN_LABEL_FRAC && im.t - im.b > ph * MIN_LABEL_FRAC && (im.l + im.r) / 2 < midX)
        .sort((a, b) => b.t - a.t)

      // --- 2. Invoice bounds from text (+ small right-column images: logo) ---
      const tc = await page.getTextContent()
      const rightRects = []
      for (const it of tc.items) {
        const tr = it.transform
        if (!tr) continue
        const e = tr[4]
        const f = tr[5]
        const w = it.width || 0
        const h = it.height || 0
        if (e + w / 2 > midX) rightRects.push({ l: e, r: e + w, b: f, t: f + h })
      }
      for (const im of images) {
        if (!labelImgs.includes(im) && (im.l + im.r) / 2 > midX) rightRects.push(im)
      }

      let billRects
      if (labelImgs.length >= 2) {
        // Two orders: split the right column at the midline into two invoices.
        billRects = [
          union(rightRects.filter((r) => (r.b + r.t) / 2 > midY)),
          union(rightRects.filter((r) => (r.b + r.t) / 2 <= midY)),
        ]
      } else {
        // One order: the whole right-column block is a single invoice.
        billRects = [union(rightRects)]
      }

      const clamp = (im) =>
        im && {
          left: Math.max(x0, im.l - PAD),
          right: Math.min(x1, im.r + PAD),
          bottom: Math.max(y0, im.b - PAD),
          top: Math.min(y1, im.t + PAD),
        }

      out.push({
        labels: labelImgs.map(clamp).filter(Boolean),
        bills: billRects.map(clamp).filter(Boolean),
      })
      page.cleanup?.()
    }

    if (typeof doc.destroy === 'function') await doc.destroy()
    if (!out.some((p) => p.labels.length)) return null
    console.info('[Rangrooh] label auto-detect: labels per page =', out.map((p) => p.labels.length))
    return out
  } catch (e) {
    console.warn('[Rangrooh] label auto-detect failed — using fallback crop:', e)
    return null
  }
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
function union(rects) {
  const r = rects.filter(Boolean)
  if (!r.length) return null
  return {
    l: Math.min(...r.map((b) => b.l)),
    r: Math.max(...r.map((b) => b.r)),
    b: Math.min(...r.map((b) => b.b)),
    t: Math.max(...r.map((b) => b.t)),
  }
}

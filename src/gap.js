/**
 * Some marketplaces (Amazon, Myntra) print their shipping label as ONE
 * flattened image, and that image has a big blank band baked into the middle
 * of it — dead space between two data blocks (e.g. Amazon's seller/invoice
 * table and its routing-code table) that wastes room on a small sticker.
 * There's no PDF structure to read this from (it's raster, not live text/
 * vector — see layout.js and myntra.js), so it has to be found by rendering
 * the region and looking for a blank run of rows.
 *
 * Deliberately conservative: only reports a band that's both far bigger than
 * ordinary line-spacing AND sits well clear of the very top/bottom edges
 * (normal margin, not a "gap"). A label with no such dead zone — or one this
 * can't confidently read — is left completely alone; the caller should treat
 * a null return as "print the region as one piece, like before."
 *
 * @param {HTMLCanvasElement} canvas   rendering of just the region to scan
 * @param {number} regionTop           PDF y (points) of the region's top edge
 * @param {number} regionBottom        PDF y (points) of the region's bottom edge
 * @returns {{top: number, bottom: number}|null}  PDF y bounds of the gap
 *          (top > bottom), or null if no confident gap was found
 */
export function findContentGap(canvas, regionTop, regionBottom) {
  const MIN_GAP_PT = 12 // smaller than this is normal line-spacing, not a dead zone
  const MARGIN_FRAC = 0.06 // ignore blank runs touching the very top/bottom
  const DOMINANCE_RATIO = 2.5 // the gap must dwarf the next-biggest blank run

  const width = canvas.width
  const height = canvas.height
  if (!width || !height || regionTop <= regionBottom) return null

  let data
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    data = ctx.getImageData(0, 0, width, height).data
  } catch {
    return null // e.g. a tainted canvas — never let this break label output
  }

  const rowIsBlank = new Array(height)
  for (let y = 0; y < height; y++) {
    let blank = true
    const rowStart = y * width * 4
    for (let x = 0; x < width; x++) {
      const i = rowStart + x * 4
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
        blank = false
        break
      }
    }
    rowIsBlank[y] = blank
  }

  const margin = Math.round(height * MARGIN_FRAC)
  const bands = []
  let i = margin
  while (i < height - margin) {
    if (rowIsBlank[i]) {
      let j = i
      while (j < height - margin && rowIsBlank[j]) j++
      // A band that starts exactly at the margin edge (or runs all the way
      // to the far one) was cut off by the exclusion window, not by real
      // content — it may well continue into the ordinary top/bottom margin
      // this is deliberately not scanning, so it's not a confirmed INTERNAL
      // gap and gets skipped rather than risking a cut into normal margin.
      if (i > margin && j < height - margin) bands.push([i, j])
      i = j
    } else {
      i++
    }
  }
  if (!bands.length) return null
  bands.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))

  const pxPerPt = height / (regionTop - regionBottom)
  const [top, bottom] = bands[0]
  const gapPt = (bottom - top) / pxPerPt
  if (gapPt < MIN_GAP_PT) return null
  if (bands.length > 1) {
    const secondPt = (bands[1][1] - bands[1][0]) / pxPerPt
    if (gapPt < secondPt * DOMINANCE_RATIO) return null
  }

  return {
    top: regionTop - top / pxPerPt,
    bottom: regionTop - bottom / pxPerPt,
  }
}

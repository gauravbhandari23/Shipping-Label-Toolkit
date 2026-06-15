import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

/**
 * Read the text of the first page and guess the marketplace.
 * Returns 'amazon', 'flipkart', or null if it can't tell.
 *
 * Note: pdf.js detaches the buffer it's given, so pass a COPY (buffer.slice(0))
 * if you still need the original for generating output.
 */
export async function detectMarketplace(arrayBuffer) {
  try {
    const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
    // Scan the first couple of pages — enough to find the brand markers.
    const pagesToScan = Math.min(doc.numPages, 2)
    let text = ''
    for (let i = 1; i <= pagesToScan; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      text += ' ' + tc.items.map((it) => it.str).join(' ')
    }
    if (typeof doc.destroy === 'function') await doc.destroy()
    const raw = text
    text = text.toLowerCase()

    // Explicit brand wins first (Myntra before Flipkart — both can use Ekart).
    if (/myntra/.test(text)) return 'myntra'

    const isFlipkart = /flipkart|shopsy|e-kart|ekart|fmpp/.test(text)
    const isAmazon = /amazon|asspl|atspl/.test(text)

    if (isFlipkart && !isAmazon) return 'flipkart'
    if (isAmazon && !isFlipkart) return 'amazon'
    if (isFlipkart && isAmazon) return /flipkart|shopsy/.test(text) ? 'flipkart' : 'amazon'

    // Myntra labels are a single full-page IMAGE with no extractable text, so a
    // near-empty page (no Amazon/Flipkart markers) is almost certainly Myntra.
    if (raw.trim().length < 20) return 'myntra'
    return null
  } catch {
    return null
  }
}

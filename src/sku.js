/**
 * Shared between myntra.js (OCR'd text) and layout.js (Amazon's live PDF
 * text). Every Rangrooh item line — on both marketplaces — carries its own
 * variant code in parentheses right after the product description, e.g.
 * Myntra: "RANHKRTI142525973(R-007-CO-B-BL-S) - Rangrooh ... Size: S"
 * Amazon: "... B0H4BTQ1Y6 ( RRC-001-CO-C-RED-L )"
 * Requiring 3+ hyphen-separated segments keeps this from firing on stray
 * parenthetical text elsewhere on the page (only variant codes are shaped
 * like this).
 */
const VARIANT_RE = /\(([^()]{3,60})\)/g

/** Pull every distinct variant code out of a block of invoice text, in order. */
export function extractVariantCodes(text) {
  const flat = String(text || '')
  const seen = new Set()
  const found = []
  let m
  while ((m = VARIANT_RE.exec(flat))) {
    const raw = m[1].trim()
    if (/^[A-Za-z0-9]+(-[A-Za-z0-9]+){2,}$/.test(raw)) {
      const code = raw.toUpperCase()
      if (!seen.has(code)) {
        seen.add(code)
        found.push(code)
      }
    }
  }
  return found
}

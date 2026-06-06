// Generates a fake "Amazon" PDF (3 pages, 2 orders each) that mirrors the real
// layout: shipping label on the LEFT, tax invoice on the RIGHT. Used only to
// verify the cropping/packing logic — not part of the app.
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { writeFileSync } from 'node:fs'

const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.HelveticaBold)
const A4 = [595.28, 841.89]

function quadrant(page, x, y, w, h, color, title, sub) {
  page.drawRectangle({ x: x + 6, y: y + 6, width: w - 12, height: h - 12, color })
  page.drawText(title, { x: x + 18, y: y + h - 30, size: 14, font, color: rgb(0, 0, 0) })
  page.drawText(sub, { x: x + 18, y: y + h - 50, size: 9, font, color: rgb(0.2, 0.2, 0.2) })
}

let order = 1
for (let p = 0; p < 3; p++) {
  const page = doc.addPage(A4)
  const [w, h] = A4
  const hw = w / 2
  const hh = h / 2
  // top row
  quadrant(page, 0, hh, hw, hh, rgb(0.85, 0.95, 0.85), `LABEL #${order}`, `AWB 3697-${1000 + order}`)
  quadrant(page, hw, hh, hw, hh, rgb(0.97, 0.85, 0.85), `INVOICE #${order}`, 'Tax Invoice — REMOVE ME')
  order++
  // bottom row
  quadrant(page, 0, 0, hw, hh, rgb(0.85, 0.95, 0.85), `LABEL #${order}`, `AWB 3697-${1000 + order}`)
  quadrant(page, hw, 0, hw, hh, rgb(0.97, 0.85, 0.85), `INVOICE #${order}`, 'Tax Invoice — REMOVE ME')
  order++
}

writeFileSync('sample-amazon.pdf', await doc.save())
console.log('wrote sample-amazon.pdf (3 pages, 6 labels + 6 invoices)')

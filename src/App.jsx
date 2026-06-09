import { useState, useEffect, useCallback, useRef } from 'react'
import { buildLabelPdf, buildTextLabelPdf, DEFAULT_SHEET, FLIPKART_CROP } from './labels'
import { detectMarketplace } from './detect'
import { analyzeAmazonLayout } from './layout'
import logo from './assets/rangrooh-logo.png'

// A page-filling grid: divides the A4 into totalCols×totalRows even cells with a
// small uniform margin. Used for dense text-label sheets (cut by hand). With
// totalCols/totalRows = 2×(per-part), the centre grid lines land on the 4
// pre-cut boundaries, so it also lines up with an ST4 sheet.
function gridSheet(totalCols, totalRows, margin) {
  const gap = 0
  return {
    pageW: 210,
    pageH: 297,
    cols: totalCols,
    rows: totalRows,
    labelW: (210 - margin * 2 - (totalCols - 1) * gap) / totalCols,
    labelH: (297 - margin * 2 - (totalRows - 1) * gap) / totalRows,
    marginTop: margin,
    marginLeft: margin,
    gapX: gap,
    gapY: gap,
  }
}

// Quick presets for how many small labels to tile INSIDE each pre-cut part.
const GRID_PRESETS = [
  [2, 2],
  [2, 3],
  [2, 5],
  [3, 5],
]

export default function App() {
  const [mode, setMode] = useState('pdf') // 'pdf' | 'text'
  const [fileName, setFileName] = useState('')
  const [buffer, setBuffer] = useState(null)
  const [pdfUrl, setPdfUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [stats, setStats] = useState(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('rangrooh-theme') || 'light'
    } catch {
      return 'light'
    }
  })

  // PDF-mode controls
  const [source, setSource] = useState('amazon')
  const [detected, setDetected] = useState(null) // 'amazon' | 'flipkart' | null
  const [locked, setLocked] = useState(false) // lock the marketplace to the detected one
  const [splitPct, setSplitPct] = useState(50)
  const [crop, setCrop] = useState(FLIPKART_CROP) // fractions
  const [innerPad, setInnerPad] = useState(1)
  const [showOutlines, setShowOutlines] = useState(false)
  const [output, setOutput] = useState('labels') // 'labels' | 'pairs' | 'both' | 'bills'
  const [sheet, setSheet] = useState(DEFAULT_SHEET)
  const [startSlot, setStartSlot] = useState(0) // first sticker position to fill
  const [layout, setLayout] = useState(null) // auto-detected Amazon content boxes

  // Text-mode controls
  const [sizes, setSizes] = useState([{ text: 'S', count: 20 }]) // [{text, count}]
  const [bold, setBold] = useState(true)
  const [align, setAlign] = useState('center')
  const [textLayout, setTextLayout] = useState('st4') // 'st4' (1 per part) | 'grid' (sub-grid per part)
  const [gridCols, setGridCols] = useState(2)
  const [gridRows, setGridRows] = useState(5)
  const [textPad, setTextPad] = useState(1.5)
  const [gridMargin, setGridMargin] = useState(5) // mm — page margin for the dense grid

  const lastBytes = useRef(null)
  const fileInput = useRef(null)
  const perPage = sheet.cols * sheet.rows

  // Apply + persist the theme.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('rangrooh-theme', theme)
    } catch {
      /* ignore */
    }
  }, [theme])

  const clearPreview = () => {
    setStats(null)
    lastBytes.current = null
    setPdfUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return ''
    })
  }

  const handleFile = useCallback(async (file) => {
    if (!file) return
    const isPdf =
      file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    if (!isPdf) {
      setError('Please choose a PDF file.')
      return
    }
    setError('')
    setFileName(file.name)
    const buf = await file.arrayBuffer()
    setBuffer(buf)

    // Auto-detect the marketplace and lock to it. pdf.js detaches the buffer it
    // reads, so hand it a copy and keep the original for generating output.
    const mp = await detectMarketplace(buf.slice(0))
    setDetected(mp)
    if (mp) {
      setSource(mp)
      setLocked(true)
    } else {
      setLocked(false)
    }

    // For Amazon, measure the real content bounds of each label/invoice so the
    // crop never clips the top and stays tight on any template.
    if (mp === 'amazon' || mp === null) {
      const lay = await analyzeAmazonLayout(buf.slice(0))
      setLayout(lay)
    } else {
      setLayout(null)
    }
  }, [])

  const generate = useCallback(async () => {
    // --- Text-label mode ---
    if (mode === 'text') {
      const entries = sizes
        .map((s) => ({ text: s.text.trim(), count: Math.max(0, Math.floor(Number(s.count) || 0)) }))
        .filter((s) => s.text && s.count > 0)
      if (!entries.length) {
        clearPreview()
        return
      }
      setBusy(true)
      setError('')
      try {
        const isGrid = textLayout === 'grid'
        const textSheet = isGrid ? gridSheet(2 * gridCols, 2 * gridRows, gridMargin) : sheet
        const { bytes, labelCount, sheetCount } = await buildTextLabelPdf({
          entries,
          bold,
          align,
          sheet: textSheet,
          startSlot: isGrid ? 0 : Math.min(startSlot, perPage - 1),
          showOutlines,
          innerPad: Number(textPad),
        })
        lastBytes.current = bytes
        setStats({ labelCount, billCount: 0, sheetCount })
        const blob = new Blob([bytes], { type: 'application/pdf' })
        const url = URL.createObjectURL(blob)
        setPdfUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return url
        })
      } catch (e) {
        console.error(e)
        setError(e.message || 'Could not make the labels.')
        setStats(null)
      } finally {
        setBusy(false)
      }
      return
    }

    // --- PDF mode ---
    if (!buffer) {
      clearPreview()
      return
    }
    setBusy(true)
    setError('')
    try {
      const { bytes, labelCount, billCount, sheetCount } = await buildLabelPdf(
        buffer.slice(0),
        {
          source,
          splitRatio: splitPct / 100,
          flipkartCrop: crop,
          innerPad: Number(innerPad),
          showOutlines,
          includeBills: output === 'both',
          billsOnly: output === 'bills',
          pairs: output === 'pairs',
          sheet,
          startSlot: Math.min(startSlot, perPage - 1),
          layout: source === 'amazon' ? layout : null,
        },
      )
      lastBytes.current = bytes
      setStats({ labelCount, billCount, sheetCount })
      const blob = new Blob([bytes], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      setPdfUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return url
      })
    } catch (e) {
      console.error(e)
      setError('Could not process this PDF: ' + e.message)
      setStats(null)
    } finally {
      setBusy(false)
    }
  }, [mode, sizes, bold, align, textLayout, gridCols, gridRows, textPad, gridMargin, buffer, source, splitPct, crop, innerPad, showOutlines, output, sheet, startSlot, layout, perPage])

  // Regenerate whenever any input changes.
  useEffect(() => {
    generate()
  }, [generate])

  // Reset only the settings — keeps the loaded PDF / typed text.
  const resetSettings = () => {
    setSplitPct(50)
    setCrop(FLIPKART_CROP)
    setInnerPad(1)
    setShowOutlines(false)
    setOutput('labels')
    setSheet(DEFAULT_SHEET)
    setStartSlot(0)
    setBold(true)
    setAlign('center')
    setTextLayout('st4')
    setGridCols(2)
    setGridRows(5)
    setTextPad(1.5)
    setGridMargin(5)
  }

  // Clear everything and start fresh.
  const clearAll = () => {
    clearPreview()
    setFileName('')
    setBuffer(null)
    setError('')
    setSource('amazon')
    setDetected(null)
    setLocked(false)
    setLayout(null)
    setSizes([{ text: 'S', count: 20 }])
    resetSettings()
    if (fileInput.current) fileInput.current.value = ''
  }

  const download = () => {
    if (!lastBytes.current) return
    const blob = new Blob([lastBytes.current], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const base =
      mode === 'text'
        ? (sizes.find((s) => s.text.trim())?.text || 'text')
            .trim()
            .slice(0, 24)
            .replace(/[^\w-]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'text-labels'
        : fileName.replace(/\.pdf$/i, '') || 'labels'
    a.href = url
    a.download = base + '_labels.pdf'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    handleFile(file)
  }

  const setSheetField = (key, value) =>
    setSheet((s) => ({ ...s, [key]: Number(value) }))

  // Crop is stored as fractions (0..1); the UI works in whole percent.
  const setCropPct = (key, pct) =>
    setCrop((c) => ({ ...c, [key]: Number(pct) / 100 }))

  const cropFields = [
    ['top', 'Top edge (%)'],
    ['bottom', 'Cut line / bottom (%)'],
    ['left', 'Left edge (%)'],
    ['right', 'Right edge (%)'],
  ]

  const sheetFields = [
    ['labelW', 'Label width (mm)'],
    ['labelH', 'Label height (mm)'],
    ['marginTop', 'Top margin (mm)'],
    ['marginLeft', 'Left margin (mm)'],
    ['gapX', 'Gap between columns (mm)'],
    ['gapY', 'Gap between rows (mm)'],
  ]

  // Stickers per page for the text mode depends on the chosen layout.
  const textPerPage = textLayout === 'grid' ? perPage * gridCols * gridRows : perPage
  const sheetsFor = (k) => Math.max(1, Math.ceil(k / textPerPage))

  // Size-list helpers (each row = one size/text + its own count).
  const totalQty = sizes.reduce((a, s) => a + Math.max(0, Math.floor(Number(s.count) || 0)), 0)
  const updateSize = (i, key, val) =>
    setSizes((arr) => arr.map((s, j) => (j === i ? { ...s, [key]: val } : s)))
  const addSize = () => setSizes((arr) => [...arr, { text: '', count: 10 }])
  const removeSize = (i) =>
    setSizes((arr) => (arr.length > 1 ? arr.filter((_, j) => j !== i) : arr))

  // Shared: the start-position picker (which sticker to start on).
  const startPositionPicker = (
    <div className="ctrl">
      <span className="ctrl__label">Start position on the sheet</span>
      <div
        className="slotgrid"
        style={{
          gridTemplateColumns: `repeat(${sheet.cols}, 1fr)`,
          aspectRatio: `${sheet.cols * sheet.labelW} / ${sheet.rows * sheet.labelH}`,
        }}
      >
        {Array.from({ length: perPage }).map((_, i) => {
          const used = i < startSlot
          const isStart = i === startSlot
          return (
            <button
              key={i}
              type="button"
              className={'slot' + (isStart ? ' slot--start' : '') + (used ? ' slot--used' : '')}
              onClick={() => setStartSlot(i)}
              title={
                used
                  ? 'Skipped (already used)'
                  : isStart
                    ? 'First sticker goes here'
                    : `Fills after the start (#${i - startSlot + 1})`
              }
            >
              {used ? '✕' : i - startSlot + 1}
            </button>
          )
        })}
      </div>
      <small className="hint">
        Already peeled some stickers off this sheet? Click the first empty spot —
        output starts there and fills onward. Crossed-out spots are skipped.
      </small>
    </div>
  )

  // Shared: fine-tune the sheet grid / margins.
  const fineTuneControls = (
    <>
      <button type="button" className="adv-toggle" onClick={() => setShowAdvanced((v) => !v)}>
        {showAdvanced ? '▾' : '▸'} Fine-tune sheet size &amp; margins
      </button>
      {showAdvanced && (
        <div className="field-grid field-grid--adv">
          {[['cols', 'Columns'], ['rows', 'Rows']].map(([key, label]) => (
            <label key={key} className="field">
              <span>{label}</span>
              <input
                type="number"
                min="1"
                step="1"
                value={sheet[key]}
                onChange={(e) => setSheetField(key, Math.max(1, Math.round(Number(e.target.value) || 1)))}
              />
            </label>
          ))}
          {sheetFields.map(([key, label]) => (
            <label key={key} className="field">
              <span>{label}</span>
              <input
                type="number"
                step="0.1"
                value={sheet[key]}
                onChange={(e) => setSheetField(key, e.target.value)}
              />
            </label>
          ))}
          <p className="field-note">
            Defaults match A4 ST4 / Avery L7169. Turn on outlines, print on plain
            paper, and hold it against a blank sticker sheet to check alignment.
          </p>
        </div>
      )}
    </>
  )

  const showDownload = mode === 'text' ? true : !!buffer

  return (
    <div className="app">
      <header className="nav">
        <div className="nav__brand">
          <img className="nav__logo" src={logo} alt="Rangrooh" />
          <span className="nav__divider" aria-hidden="true" />
          <span className="nav__tag">Shipping Label Toolkit</span>
        </div>
        <button
          type="button"
          className="theme-toggle"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label="Toggle dark mode"
        >
          {theme === 'dark' ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
              <path
                d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M20 14.5A8 8 0 0 1 9.5 4 7 7 0 1 0 20 14.5Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            </svg>
          )}
          <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
        </button>
      </header>

      <section className="hero">
        <span className="hero__pill">Amazon · Flipkart · A4 ST4 sticker sheets</span>
        <h1>Print clean labels in seconds.</h1>
        <p>
          Turn an Amazon or Flipkart invoice PDF into tidy shipping labels on A4
          sticker sheets — or print your own repeated text labels. Everything runs
          in your browser; nothing is ever uploaded.
        </p>
      </section>

      <main className="grid">
        <div className="col col--left">
          {/* Mode toggle */}
          <div className="card mode-card">
            <div className="seg">
              {[
                ['pdf', 'From a PDF'],
                ['text', 'Text labels'],
              ].map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  className={'seg__btn' + (mode === val ? ' seg__btn--on' : '')}
                  onClick={() => setMode(val)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* ---------------- PDF MODE ---------------- */}
          {mode === 'pdf' && (
            <>
              {/* Step 1 — Upload */}
              <div className="card">
                <div className="card__head">
                  <span className="step">1</span>
                  <h2>Upload your PDF</h2>
                </div>
                <div
                  className={'drop' + (dragging ? ' drop--active' : '') + (fileName ? ' drop--has' : '')}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragging(true)
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                  onClick={() => fileInput.current?.click()}
                >
                  <input
                    ref={fileInput}
                    type="file"
                    accept="application/pdf,.pdf"
                    hidden
                    onChange={(e) => handleFile(e.target.files?.[0])}
                  />
                  <div className="drop__icon" aria-hidden="true">
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                      <path d="M12 16V4m0 0 4 4m-4-4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  </div>
                  <div className="drop__title">
                    {fileName ? fileName : 'Drop your Amazon or Flipkart PDF here'}
                  </div>
                  <div className="drop__hint">
                    {fileName ? 'Click to choose a different file' : 'or click to browse'}
                  </div>
                </div>

                {error && <div className="error">{error}</div>}
              </div>

              {/* Step 2 — Settings */}
              {buffer && (
                <div className="card">
                  <div className="card__head">
                    <span className="step">2</span>
                    <h2>Adjust &amp; review</h2>
                  </div>

                  <div className="controls">
                    <div className="ctrl">
                      <span className="ctrl__label">Marketplace</span>
                      <div className="seg">
                        {['amazon', 'flipkart'].map((mp) => {
                          const blocked = locked && detected !== mp
                          return (
                            <button
                              key={mp}
                              type="button"
                              className={
                                'seg__btn' +
                                (source === mp ? ' seg__btn--on' : '') +
                                (blocked ? ' seg__btn--blocked' : '')
                              }
                              disabled={blocked}
                              onClick={() => !blocked && setSource(mp)}
                              title={blocked ? 'This PDF was detected as a different marketplace' : ''}
                            >
                              {mp === 'amazon' ? 'Amazon' : 'Flipkart'}
                              {blocked ? ' 🔒' : ''}
                            </button>
                          )
                        })}
                      </div>
                      {detected ? (
                        <small className="hint hint--ok">
                          Detected a <b>{detected === 'amazon' ? 'Amazon' : 'Flipkart'}</b> PDF —
                          locked to it.{' '}
                          <button type="button" className="linkbtn" onClick={() => setLocked(false)}>
                            Wrong? Unlock
                          </button>
                        </small>
                      ) : (
                        <small className="hint">
                          {fileName
                            ? "Couldn't auto-detect — choose the marketplace."
                            : 'Amazon = 2 orders per page (label left). Flipkart = 1 per page (label top).'}
                        </small>
                      )}
                    </div>

                    {source === 'amazon' ? (
                      <label className="ctrl">
                        <span className="ctrl__label">
                          Label width <b className="val">{splitPct}%</b>
                        </span>
                        <input
                          type="range"
                          min="30"
                          max="60"
                          value={splitPct}
                          onChange={(e) => setSplitPct(Number(e.target.value))}
                        />
                        <small className="hint">
                          Slide left if the invoice still shows; right if the label is
                          cut off. 50% suits most Amazon sheets.
                        </small>
                      </label>
                    ) : (
                      <div className="ctrl">
                        <span className="ctrl__label">Flipkart label crop</span>
                        <div className="field-grid">
                          {cropFields.map(([key, label]) => (
                            <label key={key} className="field">
                              <span>{label}</span>
                              <input
                                type="number"
                                min="0"
                                max="100"
                                step="1"
                                value={Math.round(crop[key] * 100)}
                                onChange={(e) => setCropPct(key, e.target.value)}
                              />
                            </label>
                          ))}
                        </div>
                        <small className="hint">
                          The label sits above the dashed line. Lower the <b>cut line</b>{' '}
                          to include more; raise the <b>left/right</b> edges to trim
                          whitespace and enlarge the label.
                        </small>
                      </div>
                    )}

                    <label className="ctrl">
                      <span className="ctrl__label">
                        Padding inside each sticker <b className="val">{innerPad} mm</b>
                      </span>
                      <input
                        type="range"
                        min="0"
                        max="8"
                        step="0.5"
                        value={innerPad}
                        onChange={(e) => setInnerPad(Number(e.target.value))}
                      />
                    </label>

                    {output !== 'pairs' && startPositionPicker}

                    <div className="ctrl">
                      <span className="ctrl__label">What to export</span>
                      <div className="seg seg--grid">
                        {[
                          ['labels', 'Labels only'],
                          ['pairs', 'Label + bill'],
                          ['both', 'Labels, then bills'],
                          ['bills', 'Bills only'],
                        ].map(([val, label]) => (
                          <button
                            key={val}
                            type="button"
                            className={'seg__btn' + (output === val ? ' seg__btn--on' : '')}
                            onClick={() => setOutput(val)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <small className="hint">
                        {output === 'labels'
                          ? 'Only the shipping labels, packed on sticker sheets.'
                          : output === 'pairs'
                            ? 'Each order kept together — label on the left, its bill on the right, 2 per page.'
                            : output === 'both'
                              ? `Labels first, then the bills (${source === 'flipkart' ? '2' : '4'} per page, each kept whole).`
                              : `Only the bills (${source === 'flipkart' ? '2' : '4'} per page, each kept whole) — no labels.`}
                      </small>
                    </div>

                    {output !== 'bills' && output !== 'pairs' && (
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={showOutlines}
                          onChange={(e) => setShowOutlines(e.target.checked)}
                        />
                        <span className="switch__track" />
                        <span className="switch__text">Show label outlines (for a test print)</span>
                      </label>
                    )}

                    {fineTuneControls}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ---------------- TEXT MODE ---------------- */}
          {mode === 'text' && (
            <div className="card">
              <div className="card__head">
                <span className="step">1</span>
                <h2>Your text labels</h2>
              </div>

              <div className="controls">
                <div className="ctrl">
                  <span className="ctrl__label">Sizes / text — and how many of each</span>
                  <div className="sizelist">
                    <div className="sizerow sizerow--head">
                      <span>Text</span>
                      <span>Qty</span>
                      <span />
                    </div>
                    {sizes.map((s, i) => (
                      <div className="sizerow" key={i}>
                        <input
                          className="textinput"
                          type="text"
                          placeholder="e.g. S"
                          value={s.text}
                          onChange={(e) => updateSize(i, 'text', e.target.value)}
                        />
                        <input
                          className="numinput"
                          type="number"
                          min="0"
                          max="2000"
                          value={s.count}
                          onChange={(e) => updateSize(i, 'count', Math.max(0, Math.min(2000, Math.round(Number(e.target.value) || 0))))}
                        />
                        <button
                          type="button"
                          className="rowdel"
                          onClick={() => removeSize(i)}
                          disabled={sizes.length === 1}
                          title="Remove this size"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  <button type="button" className="addrow" onClick={addSize}>
                    + Add size
                  </button>
                  <small className="hint">
                    <b>{totalQty}</b> stickers → <b>{sheetsFor(totalQty)}</b> sheet
                    {sheetsFor(totalQty) > 1 ? 's' : ''} ({textPerPage} per A4). Each size is
                    grouped together.
                  </small>
                </div>

                <div className="ctrl">
                  <span className="ctrl__label">Layout</span>
                  <div className="seg">
                    {[
                      ['st4', '1 per part'],
                      ['grid', 'Grid in each part'],
                    ].map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        className={'seg__btn' + (textLayout === val ? ' seg__btn--on' : '')}
                        onClick={() => setTextLayout(val)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {textLayout === 'st4' ? (
                    <small className="hint">
                      One label on each of the 4 pre-cut stickers (99 × 139 mm).
                    </small>
                  ) : (
                    <small className="hint">
                      Fills the whole A4 with an even grid (its centre lines line up
                      with your 4 pre-cut stickers). Lower the margin to fit more.
                    </small>
                  )}
                </div>

                {textLayout === 'grid' && (
                  <div className="ctrl">
                    <span className="ctrl__label">Labels in each pre-cut part</span>
                    <div className="field-grid">
                      <label className="field">
                        <span>Columns</span>
                        <input
                          type="number"
                          min="1"
                          max="12"
                          value={gridCols}
                          onChange={(e) => setGridCols(Math.max(1, Math.min(12, Math.round(Number(e.target.value) || 1))))}
                        />
                      </label>
                      <label className="field">
                        <span>Rows</span>
                        <input
                          type="number"
                          min="1"
                          max="20"
                          value={gridRows}
                          onChange={(e) => setGridRows(Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 1))))}
                        />
                      </label>
                    </div>
                    <div className="presets">
                      {GRID_PRESETS.map(([c, r]) => (
                        <button
                          key={`${c}x${r}`}
                          type="button"
                          className={'preset' + (gridCols === c && gridRows === r ? ' preset--on' : '')}
                          onClick={() => {
                            setGridCols(c)
                            setGridRows(r)
                          }}
                        >
                          {perPage * c * r} <span>({c}×{r}/part)</span>
                        </button>
                      ))}
                    </div>
                    <small className="hint">
                      {gridCols} × {gridRows} = <b>{gridCols * gridRows}</b> per part →{' '}
                      <b>{textPerPage}</b> per full A4. Fills top-to-bottom.
                    </small>
                  </div>
                )}

                {textLayout === 'grid' && (
                  <label className="ctrl">
                    <span className="ctrl__label">
                      Page margin <b className="val">{gridMargin} mm</b>
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="15"
                      step="0.5"
                      value={gridMargin}
                      onChange={(e) => setGridMargin(Number(e.target.value))}
                    />
                    <small className="hint">Lower it to use more of the page and fit bigger / more stickers.</small>
                  </label>
                )}

                <label className="ctrl">
                  <span className="ctrl__label">
                    Padding around text <b className="val">{textPad} mm</b>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="6"
                    step="0.5"
                    value={textPad}
                    onChange={(e) => setTextPad(Number(e.target.value))}
                  />
                  <small className="hint">
                    Text auto-sizes to fill each sticker. For bigger text, use fewer
                    columns/rows or lower this padding.
                  </small>
                </label>

                <div className="ctrl">
                  <span className="ctrl__label">Align</span>
                  <div className="seg">
                    {[
                      ['left', 'Left'],
                      ['center', 'Center'],
                    ].map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        className={'seg__btn' + (align === val ? ' seg__btn--on' : '')}
                        onClick={() => setAlign(val)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="switch">
                  <input type="checkbox" checked={bold} onChange={(e) => setBold(e.target.checked)} />
                  <span className="switch__track" />
                  <span className="switch__text">Bold text</span>
                </label>

                {textLayout === 'st4' && startPositionPicker}

                <label className="switch">
                  <input
                    type="checkbox"
                    checked={showOutlines}
                    onChange={(e) => setShowOutlines(e.target.checked)}
                  />
                  <span className="switch__track" />
                  <span className="switch__text">
                    {textLayout === 'grid' ? 'Show cut lines' : 'Show outlines (for a test print)'}
                  </span>
                </label>

                {textLayout === 'st4' && fineTuneControls}

                {error && <div className="error">{error}</div>}
              </div>
            </div>
          )}

          {/* Download (shared) */}
          {showDownload && (
            <div className="card card--cta">
              <div className="cta__row">
                <button className="btn btn--primary" onClick={download} disabled={busy || !pdfUrl}>
                  {busy ? (
                    'Processing…'
                  ) : (
                    <>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                        <path d="M12 4v12m0 0 4-4m-4 4-4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M5 20h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                      </svg>
                      Download labels PDF
                    </>
                  )}
                </button>
                <button
                  className="btn btn--ghost"
                  onClick={resetSettings}
                  type="button"
                  title="Put all settings back to default"
                >
                  Reset
                </button>
              </div>

              {stats && (
                <div className="stats">
                  <b>{stats.labelCount}</b> {mode === 'text' ? 'stickers' : 'labels'}
                  {stats.billCount > 0 ? (
                    <>
                      {' '}+ <b>{stats.billCount}</b> bills
                    </>
                  ) : null}{' '}
                  → <b>{stats.sheetCount}</b> sheet{stats.sheetCount > 1 ? 's' : ''}
                </div>
              )}

              <button className="clear" onClick={clearAll} type="button">
                Clear &amp; start new
              </button>
            </div>
          )}
        </div>

        <div className="col col--right">
          <div className="card preview-card">
            <div className="card__head card__head--preview">
              <h2>Preview</h2>
              {mode === 'pdf' && fileName && <span className="filechip">{fileName}</span>}
            </div>
            <div className="preview">
              {pdfUrl ? (
                <iframe title="preview" src={pdfUrl} />
              ) : (
                <div className="preview__empty">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
                    <rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                  <p>
                    {mode === 'text'
                      ? 'Type your text and it will preview here.'
                      : 'Your finished labels will preview here.'}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      <footer className="foot">
        <span>© Rangrooh</span>
        <span className="foot__dot">·</span>
        <span>Runs entirely in your browser — your PDFs are never uploaded.</span>
      </footer>
    </div>
  )
}

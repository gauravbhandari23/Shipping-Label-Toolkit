import { useState, useEffect, useCallback, useRef } from 'react'
import { buildLabelPdf, DEFAULT_SHEET, FLIPKART_CROP } from './labels'
import { detectMarketplace } from './detect'
import logo from './assets/rangrooh-logo.png'

export default function App() {
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

  // Controls
  const [source, setSource] = useState('amazon')
  const [detected, setDetected] = useState(null) // 'amazon' | 'flipkart' | null
  const [locked, setLocked] = useState(false) // lock the marketplace to the detected one
  const [splitPct, setSplitPct] = useState(50)
  const [crop, setCrop] = useState(FLIPKART_CROP) // fractions
  const [innerPad, setInnerPad] = useState(1)
  const [showOutlines, setShowOutlines] = useState(false)
  const [output, setOutput] = useState('labels') // 'labels' | 'both' | 'bills'
  const [sheet, setSheet] = useState(DEFAULT_SHEET)

  const lastBytes = useRef(null)
  const fileInput = useRef(null)

  // Apply + persist the theme.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('rangrooh-theme', theme)
    } catch {
      /* ignore */
    }
  }, [theme])

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
  }, [])

  const generate = useCallback(async () => {
    if (!buffer) return
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
          sheet,
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
  }, [buffer, source, splitPct, crop, innerPad, showOutlines, output, sheet])

  // Regenerate whenever the file or any control changes.
  useEffect(() => {
    generate()
  }, [generate])

  // Reset only the settings you changed — keeps the same PDF loaded.
  const resetSettings = () => {
    setSplitPct(50)
    setCrop(FLIPKART_CROP)
    setInnerPad(1)
    setShowOutlines(false)
    setOutput('labels')
    setSheet(DEFAULT_SHEET)
  }

  // Clear everything and start fresh with a new file.
  const clearAll = () => {
    setPdfUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return ''
    })
    setFileName('')
    setBuffer(null)
    setStats(null)
    setError('')
    setSource('amazon')
    setDetected(null)
    setLocked(false)
    resetSettings()
    lastBytes.current = null
    if (fileInput.current) fileInput.current.value = ''
  }

  const download = () => {
    if (!lastBytes.current) return
    const blob = new Blob([lastBytes.current], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const base = fileName.replace(/\.pdf$/i, '') || 'labels'
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

  // Flipkart crop edges shown to the user, as percent of the page.
  const cropFields = [
    ['top', 'Top edge (%)'],
    ['bottom', 'Cut line / bottom (%)'],
    ['left', 'Left edge (%)'],
    ['right', 'Right edge (%)'],
  ]

  // mm fields shown in the "fine-tune sheet" section.
  const sheetFields = [
    ['labelW', 'Label width (mm)'],
    ['labelH', 'Label height (mm)'],
    ['marginTop', 'Top margin (mm)'],
    ['marginLeft', 'Left margin (mm)'],
    ['gapX', 'Gap between columns (mm)'],
    ['gapY', 'Gap between rows (mm)'],
  ]

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
        <h1>Print clean shipping labels in seconds.</h1>
        <p>
          Drop your Amazon or Flipkart invoice PDF. Rangrooh removes the tax
          invoice and arranges your labels onto A4 sticker sheets — 4 per page,
          99.1 × 139 mm. It auto-detects the marketplace, and nothing ever leaves
          your computer.
        </p>
      </section>

      <main className="grid">
        <div className="col col--left">
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

                <div className="ctrl">
                  <span className="ctrl__label">What to export</span>
                  <div className="seg seg--three">
                    {[
                      ['labels', 'Labels'],
                      ['both', 'Labels + bills'],
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
                      : output === 'both'
                        ? `Labels first, then the bills (${source === 'flipkart' ? '2' : '4'} per page, each kept whole).`
                        : `Only the bills (${source === 'flipkart' ? '2' : '4'} per page, each kept whole) — no labels.`}
                  </small>
                </div>

                {output !== 'bills' && (
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

                <button
                  type="button"
                  className="adv-toggle"
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  {showAdvanced ? '▾' : '▸'} Fine-tune sheet size &amp; margins
                </button>

                {showAdvanced && (
                  <div className="field-grid field-grid--adv">
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
                      Defaults match A4 ST4 / Avery L7169. Turn on outlines, print
                      on plain paper, and hold it against a blank sticker sheet to
                      check alignment.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 3 — Download */}
          {buffer && (
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
                  title="Put all settings back to default (keeps your PDF)"
                >
                  Reset
                </button>
              </div>

              {stats && (
                <div className="stats">
                  <b>{stats.labelCount}</b> labels
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
              {fileName && <span className="filechip">{fileName}</span>}
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
                  <p>Your finished labels will preview here.</p>
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

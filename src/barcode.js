// Barcode encoders. Pure JS, no dependencies — everything stays in the browser.
//
// Each encoder returns a MODULE STRING: '1' = black bar module, '0' = white
// space module, all the same width. The PDF drawer turns runs of '1's into
// black rectangles, so the output is crisp vector art at any size.

// ---------------------------------------------------------------- Code 128 --
// The 107 Code 128 symbols (values 0–102, then Start A/B/C = 103/104/105 and
// Stop = 106). Each is 11 modules wide; Stop is 13 (it carries the trailing bar).
const CODE128_PATTERNS = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100',
  '10001001100', '10011001000', '10011000100', '10001100100', '11001001000',
  '11001000100', '11000100100', '10110011100', '10011011100', '10011001110',
  '10111001100', '10011101100', '10011100110', '11001110010', '11001011100',
  '11001001110', '11011100100', '11001110100', '11101101110', '11101001100',
  '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000',
  '10001000110', '10110001000', '10001101000', '10001100010', '11010001000',
  '11000101000', '11000100010', '10110111000', '10110001110', '10001101110',
  '10111011000', '10111000110', '10001110110', '11101110110', '11010001110',
  '11000101110', '11011101000', '11011100010', '11011101110', '11101011000',
  '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000', '10100001100',
  '10010110000', '10010000110', '10000101100', '10000100110', '10110010000',
  '10110000100', '10011010000', '10011000010', '10000110100', '10000110010',
  '11000010010', '11001010000', '11110111010', '11000010100', '10001111010',
  '10100111100', '10010111100', '10010011110', '10111100100', '10011110100',
  '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
  '11011110110', '11110110110', '10101111000', '10100011110', '10001011110',
  '10111101000', '10111100010', '11110101000', '11110100010', '10111011110',
  '10111101110', '11101011110', '11110101110', '11010000100', '11010010000',
  '11010011100', '1100011101011',
]

const START_B = 104
const START_C = 105
const STOP = 106
const CODE_B = 100 // switch C -> B
const CODE_C = 99 // switch B -> C

/**
 * Encode `value` as Code 128 and return its module string.
 *
 * Auto-switches between Code B (printable ASCII 32–126) and Code C, which packs
 * two digits into one symbol. Long digit runs therefore come out roughly half as
 * wide, which means fatter bars on a small sticker and an easier scan.
 */
export function code128(value) {
  const s = String(value)
  if (!s.length) return ''
  if (!/^[\x20-\x7e]+$/.test(s)) {
    throw new Error('Code 128 supports English letters, digits, spaces and basic symbols only.')
  }

  // How many digits run from position k.
  const digitRun = (k) => {
    let n = 0
    while (k + n < s.length && s[k + n] >= '0' && s[k + n] <= '9') n++
    return n
  }

  const codes = []
  let i = 0
  let inC

  // Start in C when the value opens with 4+ digits (or is just a digit pair).
  const lead = digitRun(0)
  inC = lead >= 4 || (lead >= 2 && lead === s.length)
  codes.push(inC ? START_C : START_B)

  while (i < s.length) {
    if (inC) {
      const run = digitRun(i)
      for (let p = Math.floor(run / 2); p > 0; p--) {
        codes.push(Number(s.slice(i, i + 2)))
        i += 2
      }
      if (i < s.length) {
        codes.push(CODE_B) // a non-digit, or one odd digit left over
        inC = false
      }
    } else {
      const run = digitRun(i)
      // Switching costs one symbol, so it only pays off for a long enough run:
      // 4 digits when the run ends the value (no switch back), 6 mid-value.
      const need = i + run === s.length ? 4 : 6
      if (run >= need) {
        if (run % 2) codes.push(s.charCodeAt(i++) - 32) // keep the pairs aligned
        codes.push(CODE_C)
        inC = true
      } else {
        codes.push(s.charCodeAt(i++) - 32)
      }
    }
  }

  // Mod-103 checksum: start value + each symbol weighted by its 1-based position.
  let sum = codes[0]
  for (let k = 1; k < codes.length; k++) sum += codes[k] * k

  return [...codes, sum % 103, STOP].map((v) => CODE128_PATTERNS[v]).join('')
}

// ----------------------------------------------------------------- Code 39 --
// 9 elements per character (5 bars, 4 spaces), 3 of them wide. 'n' = narrow,
// 'w' = wide. Characters are separated by one narrow space; '*' brackets the code.
const CODE39_PATTERNS = {
  '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn',
  '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw',
  '8': 'wnnwnnwnn', '9': 'nnwwnnwnn', A: 'wnnnnwnnw', B: 'nnwnnwnnw',
  C: 'wnwnnwnnn', D: 'nnnnwwnnw', E: 'wnnnwwnnn', F: 'nnwnwwnnn',
  G: 'nnnnnwwnw', H: 'wnnnnwwnn', I: 'nnwnnwwnn', J: 'nnnnwwwnn',
  K: 'wnnnnnnww', L: 'nnwnnnnww', M: 'wnwnnnnwn', N: 'nnnnwnnww',
  O: 'wnnnwnnwn', P: 'nnwnwnnwn', Q: 'nnnnnnwww', R: 'wnnnnnwwn',
  S: 'nnwnnnwwn', T: 'nnnnwnwwn', U: 'wwnnnnnnw', V: 'nwwnnnnnw',
  W: 'wwwnnnnnn', X: 'nwnnwnnnw', Y: 'wwnnwnnnn', Z: 'nwwnwnnnn',
  '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', $: 'nwnwnwnnn',
  '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn',
}

// Wide bars are 3× a narrow one (within the 2:1–3:1 the spec allows) — the
// higher ratio prints more reliably at small sizes.
const WIDE = 3

/**
 * Encode `value` as Code 39 and return its module string. Code 39 is
 * uppercase-only; lowercase letters are upper-cased automatically.
 */
export function code39(value) {
  const s = String(value).toUpperCase()
  if (!s.length) return ''
  for (const ch of s) {
    if (ch === '*' || !(ch in CODE39_PATTERNS)) {
      throw new Error(`Code 39 can't print "${ch}". Use A–Z, 0–9, space or - . $ / + %`)
    }
  }

  const charBits = (ch) =>
    CODE39_PATTERNS[ch]
      .split('')
      .map((w, i) => (i % 2 === 0 ? '1' : '0').repeat(w === 'w' ? WIDE : 1))
      .join('')

  // *DATA* with a narrow space between every character.
  return ['*', ...s, '*'].map(charBits).join('0')
}

/** Quiet zone (blank margin) each side, in modules, per symbology. */
export const QUIET_MODULES = { code128: 10, code39: 10 }

export const SYMBOLOGIES = {
  code128: { label: 'Code 128', encode: code128 },
  code39: { label: 'Code 39', encode: code39 },
}

/** Encode `value` with the named symbology. Returns the module string. */
export function encodeBarcode(value, symbology = 'code128') {
  const s = SYMBOLOGIES[symbology] || SYMBOLOGIES.code128
  return s.encode(value)
}

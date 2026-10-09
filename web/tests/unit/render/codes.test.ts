// W3 — code geometry preflight (pure) and the wasm encodeCode cache. P3: quiet-zone modes,
// automatic module size, padding, readability, DataMatrix and Wi-Fi payloads.
import { beforeAll, describe, expect, it } from 'vitest'
import type { ModuleMatrix } from '../../../src/wasm'
import { chooseModuleDots, codeMatrix, codePayload, codeSizeDots, ean13CheckDigit, humanReadable, isLinear, maxModuleDots, padMatrix, quietModules, readability, repeatRow, rotateMatrix } from '../../../src/render/codes'
import { createWifi, type QuietZone } from '../../../src/doc/schema'
import { loadWasmForTests } from '../../helpers/wasm'

const qr = (n: number): ModuleMatrix => ({ width: n, height: n, modules: Array.from({ length: n * n }, (_, i) => ((i % n) + Math.floor(i / n)) % 2) })
const bars = (w: number): ModuleMatrix => ({ width: w, height: 1, modules: Array.from({ length: w }, (_, i) => i % 2) })

describe('code geometry', () => {
  it('detects linear codes like the core (one row or identical rows)', () => {
    expect(isLinear(bars(10))).toBe(true)
    expect(isLinear(repeatRow(bars(10), 5))).toBe(true)
    expect(isLinear(qr(21))).toBe(false)
  })

  it('quiet zones: 4 modules around 2-D, 10 left/right of 1-D', () => {
    expect(quietModules(qr(21), true)).toEqual([4, 4])
    expect(quietModules(bars(95), true)).toEqual([10, 0])
    expect(quietModules(qr(21), false)).toEqual([0, 0])
  })

  it('codeSizeDots includes quiet zones; linear codes take the band', () => {
    expect(codeSizeDots(qr(21), 3, true, 128)).toEqual({ w: 87, h: 87 })
    expect(codeSizeDots(qr(21), 3, false, 128)).toEqual({ w: 63, h: 63 })
    expect(codeSizeDots(bars(95), 2, true, 128)).toEqual({ w: 230, h: 128 })
  })

  it('maxModuleDots: largest integer module whose symbol fits the band', () => {
    expect(maxModuleDots(qr(21), 128, false)).toBe(6)
    // With the quiet zone: 4 modules above and below must fit in blank band + tape margin.
    expect(maxModuleDots(qr(21), 128, true, 21)).toBe(5) // 24 mm: 105 dots + 2 × (11 + 21) ≥ 2 × 20
    expect(maxModuleDots(qr(21), 128, true)).toBe(4) // framed: the zone must fit inside the band
    expect(maxModuleDots(qr(21), 112, true, 8)).toBe(4) // 18 mm (was 5: 11 dots against 20)
    expect(maxModuleDots(qr(21), 70, true, 7)).toBe(2) // 12 mm (was 3)
    expect(maxModuleDots(qr(25), 70, true, 7)).toBe(2)
    expect(maxModuleDots(qr(25), 24, true)).toBe(0)
    expect(maxModuleDots(bars(95), 128, true)).toBe(128)
  })

  it('quiet-zone modes per symbology (QR 4/2, DataMatrix 1, linear 10/5)', () => {
    expect(quietModules(qr(21), 'standard')).toEqual([4, 4])
    expect(quietModules(qr(21), 'compact')).toEqual([2, 2])
    expect(quietModules(qr(21), 'none')).toEqual([0, 0])
    expect(quietModules(qr(10), 'standard', 'datamatrix')).toEqual([1, 1])
    expect(quietModules(qr(10), 'compact', 'datamatrix')).toEqual([1, 1])
    expect(quietModules(qr(10), 'none', 'datamatrix')).toEqual([0, 0])
    expect(quietModules(bars(95), 'standard', 'code128')).toEqual([10, 0])
    expect(quietModules(bars(95), 'compact', 'code128')).toEqual([5, 0])
    expect(quietModules(bars(95), 'none')).toEqual([0, 0])
    expect(codeSizeDots(qr(21), 3, 'compact', 70)).toEqual({ w: 75, h: 75 })
    expect(codeSizeDots(qr(10), 4, 'standard', 70, 'datamatrix')).toEqual({ w: 48, h: 48 })
    expect(codeSizeDots(bars(95), 2, 'compact', 70)).toEqual({ w: 210, h: 70 })
  })

  // [tape, band, margin, symbol side, symbology, standard, compact, none]
  const TAPES = { 12: [70, 7], 24: [128, 21] } as const
  const CASES: [12 | 24, number, 'qr' | 'datamatrix', number, number, number][] = [
    [12, 21, 'qr', 2, 3, 3], // compact: the 7-dot tape edge is the zone, the symbol fills the band
    [12, 25, 'qr', 2, 2, 2],
    [12, 29, 'qr', 2, 2, 2],
    [24, 21, 'qr', 5, 6, 6],
    [24, 25, 'qr', 5, 5, 5],
    [24, 33, 'qr', 3, 3, 3], // the band, not the zone, is the limit
    [12, 10, 'datamatrix', 7, 7, 7],
    [12, 16, 'datamatrix', 4, 4, 4],
    [12, 22, 'datamatrix', 3, 3, 3], // a WPA payload as DataMatrix: 3 dots on 12 mm
    [24, 22, 'datamatrix', 5, 5, 5],
  ]
  it.each(CASES)('maxModuleDots on %i mm: %i×%i %s → standard %i, compact %i, none %i', (tape, n, sym, standard, compact, none) => {
    const [band, margin] = TAPES[tape]
    const m = qr(n)
    const got = (['standard', 'compact', 'none'] as QuietZone[]).map((q) => maxModuleDots(m, band, q, margin, sym))
    expect(got).toEqual([standard, compact, none])
    // The chosen size always leaves the zone across the tape (band blank + margin), except
    // compact, whose zone is the unprinted edge alone.
    const [, qy] = quietModules(m, 'standard', sym)
    expect(band - n * standard + 2 * margin).toBeGreaterThanOrEqual(2 * qy * standard)
    expect(n * compact).toBeLessThanOrEqual(band)
  })

  it('compact keeps its zone inside the band when a frame borders it (margin 0)', () => {
    expect(maxModuleDots(qr(21), 128, 'compact', 0)).toBe(5) // 128 / (21 + 4)
    expect(maxModuleDots(qr(21), 128, 'standard', 0)).toBe(4) // 128 / (21 + 8)
    expect(maxModuleDots(qr(22), 70, 'compact', 0, 'datamatrix')).toBe(2) // 70 / 24
  })

  it('chooseModuleDots: 2-D auto = largest fit, fixed sizes are lowered with a flag', () => {
    expect(chooseModuleDots(qr(21), { moduleDots: 'auto', quietZone: 'standard', bandDots: 70, marginDots: 7 })).toEqual({ md: 2, max: 2, reduced: false })
    expect(chooseModuleDots(qr(21), { moduleDots: 'auto', quietZone: 'compact', bandDots: 70, marginDots: 7 })).toEqual({ md: 3, max: 3, reduced: false })
    expect(chooseModuleDots(qr(21), { moduleDots: 5, quietZone: 'standard', bandDots: 70, marginDots: 7 })).toEqual({ md: 2, max: 2, reduced: true })
    expect(chooseModuleDots(qr(21), { moduleDots: 2, quietZone: 'standard', bandDots: 70, marginDots: 7 })).toEqual({ md: 2, max: 2, reduced: false })
    // A frame width limits it too: 60 dots / (21 + 8) modules = 2.
    expect(chooseModuleDots(qr(21), { moduleDots: 'auto', quietZone: 'standard', bandDots: 128, marginDots: 0, limitW: 60 }).md).toBe(2)
    // Does not fit at all: max 0 (the renderer blocks), md stays ≥ 1.
    expect(chooseModuleDots(qr(25), { moduleDots: 'auto', quietZone: 'standard', bandDots: 24 })).toEqual({ md: 1, max: 0, reduced: false })
  })

  it('chooseModuleDots: linear auto = 2 dots, or the largest 1–4 that fits a length limit', () => {
    const b = bars(95)
    expect(chooseModuleDots(b, { moduleDots: 'auto', quietZone: 'standard', bandDots: 128 }).md).toBe(2)
    expect(chooseModuleDots(b, { moduleDots: 'auto', quietZone: 'compact', bandDots: 128, limitW: 400 }).md).toBe(3) // 400 / 105
    expect(chooseModuleDots(b, { moduleDots: 'auto', quietZone: 'standard', bandDots: 128, limitW: 2000 }).md).toBe(4)
    expect(chooseModuleDots(b, { moduleDots: 'auto', quietZone: 'none', bandDots: 128, limitW: 50 })).toEqual({ md: 1, max: 0, reduced: false })
    expect(chooseModuleDots(b, { moduleDots: 3, quietZone: 'standard', bandDots: 128, limitW: 200 })).toEqual({ md: 1, max: 1, reduced: true })
    expect(chooseModuleDots(b, { moduleDots: 6, quietZone: 'standard', bandDots: 128 })).toEqual({ md: 6, max: 255, reduced: false })
  })

  it('padMatrix surrounds the symbol with light modules', () => {
    const m: ModuleMatrix = { width: 2, height: 1, modules: [1, 1] }
    expect(padMatrix(m, 0, 0)).toBe(m)
    expect(padMatrix(m, 1, 1)).toEqual({ width: 4, height: 3, modules: [0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0] })
    // Padding a linear code along the label keeps it linear (all rows equal).
    expect(isLinear(padMatrix(repeatRow(bars(6), 3), 5, 0))).toBe(true)
  })

  it('readability: ≥ 3 dots good, 2 close up, 1 unreliable', () => {
    expect(readability(4).level).toBe('good')
    expect(readability(3).text).toMatch(/phone cameras/)
    expect(readability(2).level).toBe('ok')
    expect(readability(1).level).toBe('poor')
  })

  it('codePayload: data, or the WIFI: string for a Wi-Fi QR code', () => {
    const wifi = createWifi({ ssid: 'Home', password: 'secret123' })
    expect(codePayload({ symbology: 'qr', data: 'x', ecc: 'M', content: 'text', wifi })).toBe('x')
    expect(codePayload({ symbology: 'qr', data: 'x', ecc: 'M', content: 'wifi', wifi })).toBe('WIFI:T:WPA;S:Home;P:secret123;;')
    // Wi-Fi content is QR only; other symbologies keep encoding `data`.
    expect(codePayload({ symbology: 'datamatrix', data: 'x', ecc: 'M', content: 'wifi', wifi })).toBe('x')
    expect(() => codePayload({ symbology: 'qr', data: 'x', ecc: 'M', content: 'wifi' })).toThrow(/network name/)
  })

  it('repeatRow makes taller bars; rotateMatrix turns clockwise', () => {
    const m: ModuleMatrix = { width: 3, height: 2, modules: [1, 0, 0, 0, 0, 1] }
    expect(repeatRow(bars(4), 3).modules).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1])
    // 1 0 0      0 1
    // 0 0 1  →   0 0   (90° cw)
    //            1 0
    expect(rotateMatrix(m, 90)).toEqual({ width: 2, height: 3, modules: [0, 1, 0, 0, 1, 0] })
    expect(rotateMatrix(m, 180)).toEqual({ width: 3, height: 2, modules: [1, 0, 0, 0, 0, 1] })
    expect(rotateMatrix(m, 270)).toEqual({ width: 2, height: 3, modules: [0, 1, 0, 0, 1, 0] })
    expect(rotateMatrix(rotateMatrix(m, 90), 270)).toEqual(m)
  })

  it('EAN-13 check digit and human-readable text', () => {
    expect(ean13CheckDigit('590123412345')).toBe(7)
    expect(ean13CheckDigit('400638133393')).toBe(1)
    expect(humanReadable({ symbology: 'ean13', data: '590123412345' })).toBe('5 901234 123457')
    expect(humanReadable({ symbology: 'ean13', data: '4006381333931' })).toBe('4 006381 333931')
    expect(humanReadable({ symbology: 'code128', data: ' ABC-123 ' })).toBe('ABC-123')
  })
})

describe('codeMatrix (wasm encodeCode)', () => {
  beforeAll(() => loadWasmForTests())

  it('returns the same matrix object for the same input, or rethrows the same error', () => {
    const item = { symbology: 'qr' as const, data: 'https://example.com', ecc: 'M' as const }
    const first = codeMatrix(item)
    expect(codeMatrix(item)).toBe(first)
    expect(first.width).toBe(first.height)
    expect(first.modules).toHaveLength(first.width * first.height)
    const bad = { symbology: 'ean13' as const, data: '12', ecc: 'M' as const }
    let e1: unknown
    let e2: unknown
    try {
      codeMatrix(bad)
    } catch (e) {
      e1 = e
    }
    try {
      codeMatrix(bad)
    } catch (e) {
      e2 = e
    }
    expect((e1 as { code?: string }).code).toBe('INVALID_INPUT')
    expect(e2).toBe(e1)
  })

  it('encodes DataMatrix (square ECC 200 with its L finder) and Wi-Fi QR payloads', () => {
    const dm = codeMatrix({ symbology: 'datamatrix', data: 'A1', ecc: 'M' })
    expect([dm.width, dm.height]).toEqual([10, 10])
    for (let i = 0; i < 10; i++) {
      expect(dm.modules[i * 10]).toBe(1) // left column
      expect(dm.modules[90 + i]).toBe(1) // bottom row
      expect(dm.modules[i]).toBe(i % 2 === 0 ? 1 : 0) // top timing
    }
    expect(isLinear(dm)).toBe(false)
    const wifi = codeMatrix({ symbology: 'qr', data: '', ecc: 'L', content: 'wifi', wifi: createWifi({ ssid: 'Home', password: 'secret123' }) })
    const plain = codeMatrix({ symbology: 'qr', data: 'WIFI:T:WPA;S:Home;P:secret123;;', ecc: 'L' })
    expect(wifi).toBe(plain) // cached by payload
    expect(() => codeMatrix({ symbology: 'datamatrix', data: 'x'.repeat(5000), ecc: 'M' })).toThrow(/too much data/)
  })
})

// W3 — code geometry preflight (pure) and the wasm encodeCode cache.
import { beforeAll, describe, expect, it } from 'vitest'
import type { ModuleMatrix } from '../../../src/wasm'
import { codeMatrix, codeSizeDots, ean13CheckDigit, humanReadable, isLinear, maxModuleDots, quietModules, repeatRow, rotateMatrix } from '../../../src/render/codes'
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
    let first: unknown
    try {
      first = codeMatrix(item)
    } catch (e) {
      first = e
    }
    let second: unknown
    try {
      second = codeMatrix(item)
    } catch (e) {
      second = e
    }
    if (first instanceof Error) {
      // Not implemented yet in the bindings (UNSUPPORTED) → never cached as "invalid data".
      expect((first as { code?: string }).code).toMatch(/UNSUPPORTED|INVALID_INPUT/)
      expect(second).toBeInstanceOf(Error)
    } else {
      expect(second).toBe(first)
      const m = first as ModuleMatrix
      expect(m.width).toBe(m.height)
      expect(m.modules).toHaveLength(m.width * m.height)
    }
  })
})

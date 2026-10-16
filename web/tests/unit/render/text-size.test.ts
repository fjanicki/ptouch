// Quick text sizes (docs/FONTS-AND-SIZE-PLAN.md §3): fractions of the band, whole dots, stored as
// mm sizes that round-trip through mmToDots.
import { describe, expect, it } from 'vitest'
import { MIN_READABLE_DOTS, MIN_READABLE_MM, defaultSizeOf, minReadableDots, emDotsToPt, estimateLabelMm, matchQuickSize, quickTextSizes } from '../../../src/render/text-size'
import { mmToDots } from '../../../src/render/units'

const BANDS = { 3.5: 24, 6: 32, 9: 50, 12: 70, 18: 112, 24: 128 } as const

describe('quickTextSizes', () => {
  it('XS S M L are ¼ ⅓ ½ ¾ of the band in whole dots, then Fit', () => {
    const q = quickTextSizes(70, 180)
    expect(q.map((s) => s.label)).toEqual(['XS', 'S', 'M', 'L', 'Fit'])
    // WCAG 2.5.3: each accessible name starts with the visible text.
    for (const s of q) expect(s.name.startsWith(s.label), s.name).toBe(true)
    expect(q.map((s) => s.dots)).toEqual([18, 23, 35, 53, 70])
    expect(q[4]?.size).toEqual({ mode: 'fit' })
    expect(q[2]?.size).toEqual({ mode: 'mm', mm: 4.94 })
  })

  it.each(Object.entries(BANDS))('%s mm tape: every fixed size round-trips to its dots and fits the band', (_w, band) => {
    const q = quickTextSizes(band, 180)
    for (const s of q) {
      if (s.size.mode === 'mm') expect(mmToDots(s.size.mm, 180), s.id).toBe(s.dots)
      expect(s.dots).toBeLessThanOrEqual(band)
      expect(s.tooSmall).toBe(s.dots < MIN_READABLE_DOTS)
      expect(matchQuickSize(s.size, band, 180)).toBe(s.id === 'xs' && q[1]?.dots === s.dots ? 'xs' : s.id)
    }
  })

  it('flags sizes below 2 mm on narrow tape', () => {
    expect(quickTextSizes(32, 180).filter((s) => s.tooSmall).map((s) => s.id)).toEqual(['xs', 's'])
    expect(quickTextSizes(128, 180).some((s) => s.tooSmall)).toBe(false)
  })

  it('the readable minimum is 2 mm at any dpi: 14 dots at 180 dpi, 28 at 360 (docs/MODELS-PLAN.md §3.10)', () => {
    expect(MIN_READABLE_MM).toBe(2)
    expect(MIN_READABLE_DOTS).toBe(14)
    expect(minReadableDots(180)).toBe(14)
    expect(minReadableDots(360)).toBe(28)
    // PT-P910BT 6 mm (64 dots at 360 dpi = 4.5 mm, like 32 dots at 180 dpi): the same sizes flagged.
    expect(quickTextSizes(64, 360).filter((s) => s.tooSmall).map((s) => s.id)).toEqual(['xs', 's'])
    // …at the same physical sizes, within one 180 dpi dot (the finer head rounds differently).
    const fine = quickTextSizes(64, 360)
    quickTextSizes(32, 180).forEach((s, i) => {
      const f = fine[i]?.size
      if (s.size.mode === 'mm' && f?.mode === 'mm') expect(Math.abs(f.mm - s.size.mm), s.id).toBeLessThan(25.4 / 180)
      else expect(f).toEqual(s.size)
    })
    // 3.5 mm on a 360 dpi head (48 dots = 3.4 mm): XS–M are below 2 mm.
    expect(quickTextSizes(48, 360).filter((s) => s.tooSmall).map((s) => s.id)).toEqual(['xs', 's', 'm'])
  })

  it('360 dpi bands (PT-P910BT): quick sizes round-trip and M is half the band', () => {
    for (const band of [48, 64, 106, 150, 234, 320, 454]) {
      const q = quickTextSizes(band, 360)
      for (const s of q) {
        if (s.size.mode === 'mm') expect(mmToDots(s.size.mm, 360), `${band} ${s.id}`).toBe(s.dots)
        expect(s.tooSmall).toBe(s.dots < minReadableDots(360))
        expect(matchQuickSize(s.size, band, 360)).toBe(s.id === 'xs' && q[1]?.dots === s.dots ? 'xs' : s.id)
      }
    }
    // 36 mm: M is 227 dots = 16.02 mm; 24 mm on a P910BT (320 dots): 160 dots = 11.29 mm.
    expect(quickTextSizes(454, 360)[2]?.size).toEqual({ mode: 'mm', mm: 16.02 })
    expect(quickTextSizes(320, 360)[2]?.size).toEqual({ mode: 'mm', mm: 11.29 })
  })

  it('matchQuickSize: other sizes are not a quick size', () => {
    expect(matchQuickSize({ mode: 'mm', mm: 6 }, 70, 180)).toBeUndefined()
    expect(matchQuickSize({ mode: 'pt', pt: 12 }, 70, 180)).toBeUndefined()
    expect(matchQuickSize({ mode: 'fit' }, 70, 180)).toBe('fit')
  })
})

describe('"Use for new text" and length readouts', () => {
  it('emDotsToPt: 2.5 dots per point at 180 dpi, to half points, within 4–144 pt', () => {
    expect(emDotsToPt(30, 180)).toBe(12)
    expect(emDotsToPt(31, 180)).toBe(12.5)
    expect(emDotsToPt(2, 180)).toBe(4)
    expect(emDotsToPt(1000, 180)).toBe(144)
    expect(emDotsToPt(Number.NaN, 180)).toBe(12)
  })

  it('defaultSizeOf: Fit, M and S stay relative to the tape; other sizes become points', () => {
    const q = quickTextSizes(70, 180)
    const size = (id: string) => q.find((s) => s.id === id)!.size
    expect(defaultSizeOf({ mode: 'fit' }, 70, 180, 0)).toBe('fit')
    expect(defaultSizeOf(size('m'), 70, 180, 40)).toBe('half')
    expect(defaultSizeOf(size('s'), 70, 180, 26)).toBe('third')
    expect(defaultSizeOf({ mode: 'pt', pt: 9 }, 70, 180, 22.5)).toEqual({ pt: 9 })
    // XS, L and any other mm size: their measured em in points.
    expect(defaultSizeOf(size('xs'), 70, 180, 20)).toEqual({ pt: 8 })
    expect(defaultSizeOf({ mode: 'mm', mm: 6 }, 70, 180, 47)).toEqual({ pt: 19 })
  })

  it('estimateLabelMm adds the change of the text length, not below the printer minimum', () => {
    // 141.7 dots = 20 mm at 180 dpi.
    expect(estimateLabelMm(40, 300, 300, 180)).toBe(40)
    expect(estimateLabelMm(40, 300, 158.3, 180, 4.4)).toBeCloseTo(20, 1)
    expect(estimateLabelMm(10, 100, 0, 180, 4.4)).toBe(4.4)
    expect(estimateLabelMm(40, 300, 600, 180, 4.4, 50)).toBe(50) // fixed length
  })
})

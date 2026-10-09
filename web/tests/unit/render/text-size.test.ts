// Quick text sizes (docs/FONTS-AND-SIZE-PLAN.md §3): fractions of the band, whole dots, stored as
// mm sizes that round-trip through mmToDots.
import { describe, expect, it } from 'vitest'
import { MIN_READABLE_DOTS, defaultSizeOf, emDotsToPt, estimateLabelMm, matchQuickSize, quickTextSizes } from '../../../src/render/text-size'
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

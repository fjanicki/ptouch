// New text blocks: the user's default font and size (docs/FONTS-AND-SIZE-PLAN.md §3).
import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS } from '../../../src/doc/persist-prefs'
import { FALLBACK_BAND_DOTS, fallbackBand, isBandSize, newTextDefaults, resolveDefaultTextSize, retapeTextSize } from '../../../src/ui/state/text-defaults'
import { matchQuickSize, quickTextSizes } from '../../../src/render/text-size'
import { mmToDots } from '../../../src/render/units'

/** The PT-P710BT's widths (FALLBACK_BAND_DOTS has no 36 mm). */
const P710_WIDTHS = [3.5, 6, 9, 12, 18, 24] as const

describe('default size of new text', () => {
  it("'auto' fits narrow tape and uses half the band from 12 mm", () => {
    for (const w of P710_WIDTHS) {
      const band = FALLBACK_BAND_DOTS[w]
      const s = resolveDefaultTextSize('auto', w, band, 180)
      if (w < 12) expect(s, `${w} mm`).toEqual({ mode: 'fit' })
      else expect(s.mode === 'mm' && mmToDots(s.mm, 180), `${w} mm`).toBe(Math.round(band / 2))
    }
  })

  it('fit, half, third and a point size', () => {
    expect(resolveDefaultTextSize('fit', 24, 128, 180)).toEqual({ mode: 'fit' })
    expect(resolveDefaultTextSize('half', 6, 32, 180)).toEqual({ mode: 'mm', mm: 2.26 })
    const third = resolveDefaultTextSize('third', 24, 128, 180)
    expect(third.mode === 'mm' && mmToDots(third.mm, 180)).toBe(43)
    expect(resolveDefaultTextSize({ pt: 14 }, 3.5, 24, 180)).toEqual({ mode: 'pt', pt: 14 })
  })

  it('font: the preferred family, at the nearest weight it has', () => {
    expect(newTextDefaults(DEFAULT_PREFS, 12, 70, 180)).toEqual({ fontFamily: 'fira-sans', fontWeight: 600, size: { mode: 'mm', mm: 4.94 } })
    const atk = newTextDefaults({ defaultFont: { family: 'atkinson-hyperlegible', weight: 600 }, defaultTextSize: 'fit' }, 9, 50, 180)
    expect(atk).toEqual({ fontFamily: 'atkinson-hyperlegible', fontWeight: 700, size: { mode: 'fit' } })
  })

  it('the PT-P710BT bands per tape width, and the PT-P910BT’s for 36 mm', () => {
    expect(FALLBACK_BAND_DOTS).toEqual({ 3.5: 24, 6: 32, 9: 50, 12: 70, 18: 112, 24: 128 })
    expect(fallbackBand(24)).toEqual({ bandDots: 128, dpi: 180 })
    expect(fallbackBand(36)).toEqual({ bandDots: 454, dpi: 360 })
  })

  it('a quick size keeps its name when the resolution changes too (360 → 180 dpi)', () => {
    const m36 = quickTextSizes(454, 360).find((q) => q.id === 'm')!.size
    const m24 = retapeTextSize(m36, 454, 128, 360, undefined, 180)
    expect(matchQuickSize(m24, 128, 180)).toBe('m')
  })
})

describe('text sizes when the tape width changes', () => {
  const B = FALLBACK_BAND_DOTS

  it('a quick size stays the same quick size (M on 24 mm → M on 12 mm, not 9 mm tall text)', () => {
    const m24 = resolveDefaultTextSize('half', 24, B[24], 180)
    expect(m24).toEqual({ mode: 'mm', mm: 9.03 })
    const m12 = retapeTextSize(m24, B[24], B[12], 180)
    expect(matchQuickSize(m12, B[12], 180)).toBe('m')
    expect(m12.mode === 'mm' && mmToDots(m12.mm, 180)).toBe(35)
    for (const id of ['xs', 's', 'm', 'l'] as const) {
      for (const from of P710_WIDTHS) {
        for (const to of P710_WIDTHS) {
          const size = quickTextSizes(B[from], 180).find((q) => q.id === id)?.size ?? { mode: 'fit' }
          expect(matchQuickSize(size, B[from], 180)).toBe(id)
          expect(matchQuickSize(retapeTextSize(size, B[from], B[to], 180), B[to], 180), `${id} ${from} → ${to}`).toBe(id)
        }
      }
    }
  })

  it('fit, point sizes and other fixed sizes are kept', () => {
    expect(retapeTextSize({ mode: 'fit' }, B[24], B[9], 180)).toEqual({ mode: 'fit' })
    expect(retapeTextSize({ mode: 'pt', pt: 12 }, B[24], B[9], 180)).toEqual({ mode: 'pt', pt: 12 })
    const own = { mode: 'mm', mm: 7 } as const
    expect(retapeTextSize(own, B[24], B[12], 180)).toBe(own)
  })

  it('an untouched label: text with the old default gets the new tape’s default (auto: M on 24 mm → Fit on 9 mm)', () => {
    const from = resolveDefaultTextSize('auto', 24, B[24], 180)
    const to = resolveDefaultTextSize('auto', 9, B[9], 180)
    expect(retapeTextSize(from, B[24], B[9], 180, { from, to })).toEqual({ mode: 'fit' })
    const to12 = resolveDefaultTextSize('auto', 12, B[12], 180)
    expect(retapeTextSize(from, B[24], B[12], 180, { from, to: to12 })).toEqual(to12)
    // Not the default any more: the ordinary rule.
    expect(retapeTextSize({ mode: 'pt', pt: 20 }, B[24], B[9], 180, { from, to })).toEqual({ mode: 'pt', pt: 20 })
  })

  it('finds the band a size was made in: M of the PT-P710BT 24 mm band is no size of the PT-P910BT one', () => {
    const m180 = resolveDefaultTextSize('auto', 24, B[24], 180) // 64 of 128 dots: 9.03 mm
    expect(isBandSize(m180, B[24], 180)).toBe(true)
    // The PT-P910BT's 24 mm band is 320 dots at 360 dpi: 9.03 mm is 128 dots, not a quick size.
    expect(isBandSize(m180, 320, 360)).toBe(false)
    expect(isBandSize(m180, 320, 360, resolveDefaultTextSize('auto', 24, 320, 360))).toBe(false)
    expect(isBandSize(m180, 320, 360, m180)).toBe(true) // the default given there
    expect(isBandSize({ mode: 'fit' }, 320, 360)).toBe(true)
    expect(isBandSize({ mode: 'mm', mm: 7 }, B[24], 180)).toBe(false)
    // Measured in the band it was made in, M follows to M of the 36 mm 360 dpi band (16.02 mm).
    const m36 = retapeTextSize(m180, B[24], 454, 180, { from: m180, to: resolveDefaultTextSize('auto', 36, 454, 360) }, 360)
    expect(m36).toEqual(resolveDefaultTextSize('auto', 36, 454, 360))
    expect(m36.mode === 'mm' && m36.mm).toBeCloseTo(16.02, 2)
  })
})

// New text blocks: the user's default font and size (docs/FONTS-AND-SIZE-PLAN.md §3).
import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS } from '../../../src/doc/persist-prefs'
import { TAPE_WIDTHS_MM } from '../../../src/doc/schema'
import { FALLBACK_BAND_DOTS, newTextDefaults, resolveDefaultTextSize, retapeTextSize } from '../../../src/ui/state/text-defaults'
import { matchQuickSize, quickTextSizes } from '../../../src/render/text-size'
import { mmToDots } from '../../../src/render/units'

describe('default size of new text', () => {
  it("'auto' fits narrow tape and uses half the band from 12 mm", () => {
    for (const w of TAPE_WIDTHS_MM) {
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

  it('the PT-P710BT bands per tape width', () => {
    expect(FALLBACK_BAND_DOTS).toEqual({ 3.5: 24, 6: 32, 9: 50, 12: 70, 18: 112, 24: 128 })
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
      for (const from of TAPE_WIDTHS_MM) {
        for (const to of TAPE_WIDTHS_MM) {
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
})

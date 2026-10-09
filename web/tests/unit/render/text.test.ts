// W3 — text block layout and auto-fit with a deterministic fake font (no canvas in node).
import { describe, expect, it } from 'vitest'
import { fitTextBlock, invertPadding, layoutLines, pixelScaleFor, ptToPx, sizeTextBlock, splitLines, type FaceMetrics, type MeasureFn, type TextSizing } from '../../../src/render/text'

/** Fake proportional font: 0.6 em advance, caps/ascenders 0.72 em, x-height 0.5, descenders 0.22. */
const measure: MeasureFn = (text, px) => {
  const asc = /[A-Z0-9bdfhklt]/.test(text) ? 0.72 : 0.5
  const desc = /[gjpqy]/.test(text) ? 0.22 : 0
  const advance = 0.6 * px * text.length
  return { advance, left: 0, right: advance, ascent: asc * px, descent: desc * px }
}
const FACE: FaceMetrics = { cap: 0.7, desc: 0.2 }

describe('text layout', () => {
  it('splits lines on \\n and \\r\\n', () => {
    expect(splitLines('a\r\nb\nc')).toEqual(['a', 'b', 'c'])
    expect(splitLines('')).toEqual([''])
  })

  it('fit: single line of caps fills the available height exactly', () => {
    const b = fitTextBlock(['HELLO'], FACE, 1.2, 'center', measure, { fit: true, availPx: 384 })
    expect(b.height).toBeCloseTo(384, 3)
    expect(b.fontPx).toBeCloseTo(384 / 0.72, 3)
    expect(b.width).toBeCloseTo(0.6 * b.fontPx * 5, 3)
    expect(b.lines[0]?.baseline).toBeCloseTo(384, 3)
  })

  it('fit: descenders make the text smaller but still fit', () => {
    const caps = fitTextBlock(['HELLO'], FACE, 1.2, 'center', measure, { fit: true, availPx: 384 })
    const desc = fitTextBlock(['Hello g'], FACE, 1.2, 'center', measure, { fit: true, availPx: 384 })
    expect(desc.fontPx).toBeLessThan(caps.fontPx)
    expect(desc.height).toBeLessThanOrEqual(384 + 1e-6)
    expect(desc.height).toBeGreaterThan(383)
  })

  it('fit: two lines share the band with the line height', () => {
    const b = fitTextBlock(['AB', 'CD'], FACE, 1.2, 'center', measure, { fit: true, availPx: 300 })
    // top 0.72 + pitch 1.2 × 0.9 = 1.8 em
    expect(b.fontPx).toBeCloseTo(300 / 1.8, 3)
    expect(b.height).toBeCloseTo(300, 3)
    expect((b.lines[1]?.baseline ?? 0) - (b.lines[0]?.baseline ?? 0)).toBeCloseTo(1.2 * 0.9 * b.fontPx, 3)
  })

  it('pt: the em size is the point size (1 pt = 2.5 dots at 180 dpi), per line', () => {
    expect(ptToPx(12, 180)).toBe(30)
    expect(ptToPx(12, 180, 3)).toBe(90)
    expect(ptToPx(7.2, 360)).toBeCloseTo(36, 9)
    const one = fitTextBlock(['HELLO'], FACE, 1.2, 'center', measure, { fit: false, emPx: 90 })
    expect(one.fontPx).toBe(90)
    expect(one.lineBox).toBeCloseTo(0.9 * 90, 6)
    // Lines keep the em size (unlike mm, which is the height of the whole block).
    const two = fitTextBlock(['A', 'B'], FACE, 1.5, 'center', measure, { fit: false, emPx: 90 })
    expect(two.fontPx).toBe(90)
    expect(two.height).toBeCloseTo(one.height + 1.5 * 0.9 * 90, 6)
  })

  it('mm: block height is the cap-to-descender height from font metrics', () => {
    const one = fitTextBlock(['HELLO'], FACE, 1.2, 'center', measure, { fit: false, targetPx: 90 })
    expect(one.fontPx).toBeCloseTo(100, 6)
    expect(one.lineBox).toBeCloseTo(90, 6)
    // Same size whatever the letters (stable while typing).
    expect(fitTextBlock(['gggg'], FACE, 1.2, 'center', measure, { fit: false, targetPx: 90 }).fontPx).toBeCloseTo(100, 6)
    const two = fitTextBlock(['A', 'B'], FACE, 1.5, 'center', measure, { fit: false, targetPx: 90 })
    expect(two.fontPx).toBeCloseTo(90 / (0.9 * 2.5), 6)
  })

  it('aligns lines inside the block', () => {
    const lines = ['WIDE LINE', 'X']
    const x = (align: 'start' | 'center' | 'end') => layoutLines(lines, 100, FACE, 1, align, measure, false).lines[1]?.x
    const wide = 0.6 * 100 * 9
    const narrow = 0.6 * 100
    expect(x('start')).toBe(0)
    expect(x('center')).toBe(Math.round((wide - narrow) / 2))
    expect(x('end')).toBeCloseTo(wide - narrow, 6)
  })

  it('blank lines still take a line pitch; an all-blank block has no width', () => {
    const b = layoutLines(['A', '', 'B'], 100, FACE, 1, 'start', measure, false)
    expect(b.lines.map((l) => Math.round(l.baseline))).toEqual([72, 162, 252])
    expect(layoutLines(['  '], 100, FACE, 1, 'start', measure, false).width).toBe(0)
  })

  it('invert padding scales with the band, at least one dot', () => {
    expect(invertPadding(384, 0, 3).v).toBe(30)
    expect(invertPadding(72, 0, 3).v).toBe(7)
    expect(invertPadding(3, 0, 3).v).toBe(3)
    expect(invertPadding(384, 200, 3).h).toBe(50)
  })
})

/** Fake pixel font on a 10-pixel em: every extent is a whole number of design pixels (0.1 em). */
const pixelMeasure: MeasureFn = (text, px) => {
  const desc = /[gjpqy]/.test(text) ? 0.2 : 0
  const advance = 0.6 * px * text.length
  return { advance, left: 0, right: advance - 0.1 * px, ascent: 0.7 * px, descent: desc * px }
}
const PIXEL_FACE: FaceMetrics = { cap: 0.7, desc: 0.2 }
const sizing = (patch: Partial<TextSizing> = {}): TextSizing => ({ size: { mode: 'fit' }, align: 'center', invert: false, lineHeight: 1.1, ...patch })
const multipleOf = (v: number, m: number) => Math.abs(v / m - Math.round(v / m)) < 1e-6

describe('sizeTextBlock (shared by the renderer and the quick size estimates)', () => {
  const env = { bandPx: 70 * 3, f: 3, dpi: 180 }

  it('fit / mm / pt give the same blocks as fitTextBlock', () => {
    const fit = sizeTextBlock(['HELLO'], FACE, sizing(), measure, env)
    expect(fit.block).toEqual(fitTextBlock(['HELLO'], FACE, 1.1, 'center', measure, { fit: true, availPx: 210 }))
    expect(fit.reduced).toBe(false)
    expect(fit.pixelScale).toBeUndefined()
    const pt = sizeTextBlock(['HELLO'], FACE, sizing({ size: { mode: 'pt', pt: 12 } }), measure, env)
    expect(pt.block.fontPx).toBe(90)
    const mm = sizeTextBlock(['HELLO'], FACE, sizing({ size: { mode: 'mm', mm: 5 } }), measure, env)
    expect(mm.block.lineBox).toBeCloseTo((5 * 180 * 3) / 25.4, 6)
    expect(mm.wPx).toBe(mm.block.width)
    expect(mm.hPx).toBe(mm.block.height)
  })

  it('a fixed size taller than the band is reduced to it; fit never is', () => {
    const tall = sizeTextBlock(['Hxg'], FACE, sizing({ size: { mode: 'mm', mm: 15 } }), measure, env)
    expect(tall.reduced).toBe(true)
    expect(Math.ceil(tall.hPx / 3 - 1e-6)).toBeLessThanOrEqual(70)
    expect(tall.hPx).toBeGreaterThan(69 * 3)
    const ok = sizeTextBlock(['Hxg'], FACE, sizing({ size: { mode: 'mm', mm: 9 } }), measure, env)
    expect(ok.reduced).toBe(false)
    expect(sizeTextBlock(['A', 'B', 'C'], FACE, sizing(), measure, env).reduced).toBe(false)
    // Inverted: the padding counts too.
    const inv = sizeTextBlock(['Hxg'], FACE, sizing({ size: { mode: 'pt', pt: 40 }, invert: true }), measure, env)
    expect(inv.reduced).toBe(true)
    expect(Math.ceil(inv.hPx / 3 - 1e-6)).toBeLessThanOrEqual(70)
  })

  it('clipTall (labels from schema 2) keeps v1: a fixed size taller than the band is not reduced', () => {
    const v1 = sizeTextBlock(['Hxg'], FACE, sizing({ size: { mode: 'mm', mm: 15 }, clipTall: true }), measure, env)
    expect(v1.reduced).toBe(false)
    expect(v1.block.lineBox).toBeCloseTo((15 * 180 * 3) / 25.4, 6)
    expect(v1.hPx).toBeGreaterThan(70 * 3)
    // Inverted: the padding may run past the band, as in v1.
    const inv = sizeTextBlock(['Hxg'], FACE, sizing({ size: { mode: 'mm', mm: 9 }, invert: true, clipTall: true }), measure, env)
    const invNow = sizeTextBlock(['Hxg'], FACE, sizing({ size: { mode: 'mm', mm: 9 }, invert: true }), measure, env)
    expect(inv.reduced).toBe(false)
    expect(inv.block.lineBox).toBeCloseTo((9 * 180 * 3) / 25.4, 6)
    expect(invNow.block.lineBox).toBeLessThan(inv.block.lineBox)
  })

  it('scale shrinks every size by that factor; a frame width shrinks to fit', () => {
    const one = sizeTextBlock(['HELLO'], FACE, sizing({ size: { mode: 'pt', pt: 12 } }), measure, env)
    const half = sizeTextBlock(['HELLO'], FACE, sizing({ size: { mode: 'pt', pt: 12 } }), measure, { ...env, scale: 0.5 })
    expect(half.block.fontPx).toBeCloseTo(one.block.fontPx / 2, 6)
    expect(half.wPx).toBeCloseTo(one.wPx / 2, 6)
    const fitHalf = sizeTextBlock(['HELLO'], FACE, sizing(), measure, { ...env, scale: 0.5 })
    expect(fitHalf.block.height).toBeCloseTo(105, 3)
    const framed = sizeTextBlock(['HELLO'], FACE, sizing(), measure, { ...env, maxWPx: 150 })
    expect(framed.wPx).toBeLessThanOrEqual(150 + 1e-6)
  })
})

describe('pixel fonts: whole dots per font pixel', () => {
  it('pixelScaleFor: the largest whole scale for limits, else the nearest; at least 1', () => {
    expect(pixelScaleFor(107, 10, true)).toBe(10)
    expect(pixelScaleFor(107, 10, false)).toBe(11)
    expect(pixelScaleFor(104, 10, false)).toBe(10)
    expect(pixelScaleFor(100, 10, true)).toBe(10)
    expect(pixelScaleFor(99.9999999, 10, true)).toBe(10) // float noise is not a step down
    expect(pixelScaleFor(4, 10, true)).toBe(1)
    expect(pixelScaleFor(0, 10, false)).toBe(1)
    expect(pixelScaleFor(50, 0, false)).toBe(1)
  })

  it('layoutLines on a grid puts baselines, pitch, origins and the box on whole dots', () => {
    const b = layoutLines(['AB', 'C', 'Dg'], 77, PIXEL_FACE, 1.15, 'center', pixelMeasure, true, 3)
    for (const l of b.lines) {
      expect(multipleOf(l.baseline, 3), `baseline ${l.baseline}`).toBe(true)
      expect(multipleOf(l.x, 3), `x ${l.x}`).toBe(true)
    }
    expect(multipleOf(b.width, 3)).toBe(true)
    expect(multipleOf(b.height, 3)).toBe(true)
    const pitch = (b.lines[1]?.baseline ?? 0) - (b.lines[0]?.baseline ?? 0)
    expect((b.lines[2]?.baseline ?? 0) - (b.lines[1]?.baseline ?? 0)).toBe(pitch)
    // Without a grid nothing is rounded (old labels keep their exact layout).
    const free = layoutLines(['AB', 'C'], 77, PIXEL_FACE, 1.15, 'center', pixelMeasure, true)
    expect(free.lines[1]?.baseline).toBeCloseTo(0.7 * 77 + 0.9 * 77 * 1.15, 9)
  })

  it('fit takes the largest whole scale; pt and mm the nearest; too tall steps down', () => {
    const env = { bandPx: 75 * 3, f: 3, dpi: 180, pixel: { emPx: 10 } }
    const fit = sizeTextBlock(['HELLO'], PIXEL_FACE, sizing(), pixelMeasure, env)
    // Fit em would be 75 / 0.7 = 107 dots → 10 dots per font pixel (em 100 dots).
    expect(fit.pixelScale).toBe(10)
    expect(fit.block.fontPx).toBe(300)
    expect(fit.block.height).toBeLessThanOrEqual(225)
    // 30 pt = 75 dots em → nearest scale 8 (em 80 dots).
    const pt = sizeTextBlock(['HELLO'], PIXEL_FACE, sizing({ size: { mode: 'pt', pt: 30 } }), pixelMeasure, env)
    expect(pt.pixelScale).toBe(8)
    expect(pt.block.fontPx).toBe(240)
    // 10 mm block = 70.9 dots ÷ 0.9 = 78.7 dots em → 8 as well.
    expect(sizeTextBlock(['HELLO'], PIXEL_FACE, sizing({ size: { mode: 'mm', mm: 10 } }), pixelMeasure, env).pixelScale).toBe(8)
    // Nearest would overshoot the band (cap + descender 0.9 em > 75 dots at k = 9): step down.
    const big = sizeTextBlock(['Hg'], PIXEL_FACE, sizing({ size: { mode: 'pt', pt: 34 } }), pixelMeasure, env)
    expect(big.pixelScale).toBe(8)
    expect(Math.ceil(big.hPx / 3 - 1e-6)).toBeLessThanOrEqual(75)
    // Shrink to fit length is a limit: round down.
    const shrunk = sizeTextBlock(['HELLO'], PIXEL_FACE, sizing({ size: { mode: 'pt', pt: 30 } }), pixelMeasure, { ...env, scale: 0.9 })
    expect(shrunk.pixelScale).toBe(6)
    // Never below one dot per font pixel.
    expect(sizeTextBlock(['HELLO'], PIXEL_FACE, sizing({ size: { mode: 'pt', pt: 4 } }), pixelMeasure, env).pixelScale).toBe(1)
  })
})

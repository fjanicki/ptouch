// W3 — text block layout and auto-fit with a deterministic fake font (no canvas in node).
import { describe, expect, it } from 'vitest'
import { fitTextBlock, invertPadding, layoutLines, splitLines, type FaceMetrics, type MeasureFn } from '../../../src/render/text'

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

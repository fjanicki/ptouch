// W3 — pure layout maths: flow placement, gaps, margins, align, fixed length overflow, mm↔dots.
import { describe, expect, it } from 'vitest'
import { createDoc, type LabelDoc } from '../../../src/doc/schema'
import { alignOffset, contentLength, layoutFlow, layoutFree, type MeasuredItem } from '../../../src/render/layout'
import { cssToRgb, dotsToMm, mmToDots, rgbToCss } from '../../../src/render/units'

const DPI = 180
const BAND = 128 // 24 mm TZe on PT-P710BT

function doc(patch: Partial<LabelDoc> = {}): LabelDoc {
  return createDoc({ items: [], marginsMm: { start: 2, end: 2 }, layout: { mode: 'flow', gapMm: 3, align: 'center' }, ...patch })
}

const item = (id: string, w: number, h: number, spacer = false): MeasuredItem => ({ itemId: id, w, h, ...(spacer ? { spacer } : {}) })

describe('units', () => {
  it('180 dpi: 24 mm ≈ 170 dots', () => {
    expect(mmToDots(24)).toBe(170)
    expect(dotsToMm(180)).toBeCloseTo(25.4)
  })
  it('round-trips mm → dots → mm within half a dot', () => {
    for (const mm of [0, 1, 2, 3.5, 12, 50, 100]) expect(Math.abs(dotsToMm(mmToDots(mm, DPI), DPI) - mm)).toBeLessThanOrEqual(dotsToMm(0.5, DPI))
  })
  it('2 mm margin = 14 dots; 360 dpi doubles', () => {
    expect(mmToDots(2, 180)).toBe(14)
    expect(mmToDots(2, 360)).toBe(28)
  })
  it('parses CSS colours', () => {
    expect(cssToRgb('#fff')).toBe(0xffffff)
    expect(cssToRgb('#FF8000')).toBe(0xff8000)
    expect(cssToRgb('#ff800080')).toBe(0xff8000)
    expect(cssToRgb('rgb(255, 0, 10)')).toBe(0xff000a)
    expect(cssToRgb('rgb(100% 0% 0% / 50%)')).toBe(0xff0000)
    expect(cssToRgb('White')).toBe(0xffffff)
    expect(cssToRgb('gold')).toBe(0xffd700)
    expect(cssToRgb('nonsense')).toBe(0)
    expect(rgbToCss(0xff8000)).toBe('#ff8000')
  })
})

describe('flow layout', () => {
  it('alignOffset', () => {
    expect(alignOffset('start', 128, 28)).toBe(0)
    expect(alignOffset('center', 128, 28)).toBe(50)
    expect(alignOffset('end', 128, 28)).toBe(100)
  })

  it('places items left to right with gaps and margins (auto length)', () => {
    const l = layoutFlow(doc(), [item('a', 100, 128), item('b', 50, 60)], BAND, DPI)
    const gap = mmToDots(3) // 21
    expect(l.placements.map((p) => [p.x, p.y])).toEqual([
      [14, 0],
      [14 + 100 + gap, 34],
    ])
    expect(l.contentDots).toBe(100 + gap + 50)
    expect(l.lengthDots).toBe(14 + 100 + gap + 50 + 14)
    expect(l.overflow).toBe(false)
    expect(l.clamped).toBeUndefined()
  })

  it('aligns across the tape (start / center / end)', () => {
    const items = [item('a', 10, 28)]
    const y = (align: 'start' | 'center' | 'end') => layoutFlow(doc({ layout: { mode: 'flow', gapMm: 0, align } }), items, BAND, DPI).placements[0]?.y
    expect([y('start'), y('center'), y('end')]).toEqual([0, 50, 100])
  })

  it('clamps item height to the band', () => {
    const l = layoutFlow(doc(), [item('a', 10, 300)], BAND, DPI)
    expect(l.placements[0]?.h).toBe(BAND)
    expect(l.placements[0]?.y).toBe(0)
  })

  it('a spacer replaces the gaps next to it', () => {
    const items = [item('a', 10, 10), item('s', 30, 0, true), item('b', 10, 10)]
    expect(contentLength(items, 21)).toBe(50)
    const l = layoutFlow(doc(), items, BAND, DPI)
    expect(l.placements.map((p) => p.x)).toEqual([14, 24, 54])
  })

  it('empty (zero-width) items take no space and no gap', () => {
    const items = [item('a', 10, 10), item('empty', 0, 0), item('b', 10, 10)]
    expect(contentLength(items, 21)).toBe(41)
    expect(layoutFlow(doc(), items, BAND, DPI).placements.map((p) => p.x)).toEqual([14, 24, 45])
  })

  it('fixed length centres short content between the margins', () => {
    const d = doc({ length: { mode: 'fixed', mm: 50 } })
    const l = layoutFlow(d, [item('a', 100, 50)], BAND, DPI)
    const len = mmToDots(50) // 354
    expect(l.lengthDots).toBe(len)
    expect(l.overflow).toBe(false)
    expect(l.placements[0]?.x).toBe(14 + Math.floor((len - 28 - 100) / 2))
  })

  it('fixed length reports overflow and starts at the margin', () => {
    const d = doc({ length: { mode: 'fixed', mm: 20 } })
    const l = layoutFlow(d, [item('a', 200, 50)], BAND, DPI)
    expect(l.lengthDots).toBe(mmToDots(20))
    expect(l.overflow).toBe(true)
    expect(l.placements[0]?.x).toBe(14)
  })

  it('pads to the printer minimum and centres the content', () => {
    const d = doc({ marginsMm: { start: 0, end: 0 } })
    const l = layoutFlow(d, [item('a', 10, 10)], BAND, DPI, { minLengthDots: 40 })
    expect(l.lengthDots).toBe(40)
    expect(l.clamped).toBe('min')
    expect(l.placements[0]?.x).toBe(15)
  })

  it('cuts to the printer maximum and reports overflow', () => {
    const l = layoutFlow(doc(), [item('a', 8000, 10)], BAND, DPI, { minLengthDots: 3, maxLengthDots: 7086 })
    expect(l.lengthDots).toBe(7086)
    expect(l.clamped).toBe('max')
    expect(l.overflow).toBe(true)
  })

  it('a label frame insets content on every side', () => {
    const l = layoutFlow(doc(), [item('a', 10, 200)], BAND, DPI, { minLengthDots: 3, insetDots: 10 })
    expect(l.placements[0]).toMatchObject({ x: 24, y: 10, h: BAND - 20 })
    expect(l.lengthDots).toBe(24 + 10 + 24)
  })

  it('free layout: auto length = right-most edge + end margin; overflow outside the band', () => {
    const d = doc({ layout: { mode: 'free' } })
    const l = layoutFree(d, [{ itemId: 'a', x: 20, y: 0, w: 50, h: 40 }], BAND, DPI)
    expect(l.lengthDots).toBe(70 + 14)
    expect(l.overflow).toBe(false)
    expect(layoutFree(d, [{ itemId: 'a', x: 0, y: 100, w: 50, h: 40 }], BAND, DPI).overflow).toBe(true)
  })
})

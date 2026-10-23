// W3 — pure layout maths: flow placement, gaps, margins, align, fixed length overflow, mm↔dots.
import { describe, expect, it } from 'vitest'
import { createDoc, type LabelDoc } from '../../../src/doc/schema'
import { alignOffset, contentLength, layoutFlow, layoutFree, layoutPieces, splitPieces, type MeasuredItem } from '../../../src/render/layout'
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

describe('Cut blocks: splitPieces (docs/CUT-PLAN.md C3)', () => {
  const cut = (id: string): MeasuredItem => ({ itemId: id, w: 0, h: 0, cut: true })

  it('no Cut: one piece with every item', () => {
    expect(splitPieces([item('a', 10, 10), item('b', 10, 10)])).toEqual({ pieces: [[0, 1]], kept: [], ignored: [] })
  })

  it('one and several Cuts: a piece per run of blocks', () => {
    expect(splitPieces([item('a', 10, 10), cut('c1'), item('b', 10, 10)])).toEqual({ pieces: [[0], [2]], kept: [1], ignored: [] })
    const s = splitPieces([item('a', 10, 10), cut('c1'), item('b', 10, 10), item('b2', 5, 10), cut('c2'), item('c', 10, 10)])
    expect(s.pieces).toEqual([[0], [2, 3], [5]])
    expect(s.kept).toEqual([1, 4])
    expect(s.ignored).toEqual([])
  })

  it('a Cut at the start, right after another Cut or at the end is ignored, with the reason', () => {
    const s = splitPieces([cut('s'), item('a', 10, 10), cut('k'), cut('d'), item('b', 10, 10), cut('e')])
    expect(s.kept).toEqual([2])
    expect(s.ignored).toEqual([
      { index: 0, itemId: 's', why: 'start' },
      { index: 3, itemId: 'd', why: 'double' },
      { index: 5, itemId: 'e', why: 'end' },
    ])
    // Ignored Cuts stay in their piece (they take no space).
    expect(s.pieces).toEqual([[0, 1], [3, 4, 5]])
  })

  it('two Cuts at the end: the first is "end", the second "double"', () => {
    const s = splitPieces([item('a', 10, 10), cut('c1'), cut('c2')])
    expect(s.kept).toEqual([])
    expect(s.pieces).toEqual([[0, 1, 2]])
    expect(s.ignored.map((i) => [i.itemId, i.why])).toEqual([
      ['c1', 'end'],
      ['c2', 'double'],
    ])
  })

  it('spacers and empty text are not "something": they join the neighbouring piece', () => {
    const s = splitPieces([item('a', 10, 10), cut('c1'), item('sp', 20, 0, true), item('empty', 0, 0), cut('c2'), item('b', 10, 10), cut('c3'), item('sp2', 5, 0, true)])
    expect(s.kept).toEqual([1])
    expect(s.ignored.map((i) => [i.itemId, i.why])).toEqual([
      ['c2', 'double'],
      ['c3', 'end'],
    ])
    expect(s.pieces).toEqual([[0], [2, 3, 4, 5, 6, 7]])
  })
})

describe('Cut blocks: layoutPieces (docs/CUT-PLAN.md C2)', () => {
  const cut = (id: string): MeasuredItem => ({ itemId: id, w: 0, h: 0, cut: true })
  const limits = { minLengthDots: 3 }

  it('the worked example: 24 mm, margins 2 / 2 mm, 160 | 150 | 170 dots → 188 | 178 | 198, cuts at 188 and 366', () => {
    const items = [item('k', 160, 60), cut('c1'), item('o', 150, 60), cut('c2'), item('g', 170, 60)]
    const L = layoutPieces(doc(), items, BAND, DPI, limits, true)
    expect(L.spans).toEqual([
      [0, 188],
      [188, 366],
      [366, 564],
    ])
    expect(L.pieceEdges).toEqual([188, 366])
    expect(L.lengthDots).toBe(564)
    expect(L.placements.map((p) => p.x)).toEqual([14, 188, 202, 366, 380])
    // 28 blank dots between two pieces (end + start margin) instead of the 21-dot gap.
    expect((L.placements[2]?.x ?? 0) - 160 - 14).toBe(28)
  })

  it('every piece is the label of its blocks alone, shifted (random widths, margins, gaps, insets, length modes)', () => {
    let seed = 7
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let run = 0; run < 200; run++) {
      const d = doc({
        marginsMm: { start: rnd(6), end: rnd(6) },
        layout: { mode: 'flow', gapMm: rnd(5), align: (['start', 'center', 'end'] as const)[rnd(3)] ?? 'center' },
        length: rnd(3) === 0 ? { mode: 'fixed', mm: 10 + rnd(40) } : { mode: 'auto' },
      })
      const lim = { minLengthDots: rnd(40), insetDots: rnd(8) }
      const items: MeasuredItem[] = []
      const n = 2 + rnd(8)
      for (let i = 0; i < n; i++) {
        const r = rnd(10)
        items.push(r === 0 ? cut(`c${i}`) : r === 1 ? item(`s${i}`, rnd(30), 0, true) : r === 2 ? item(`e${i}`, 0, 0) : item(`b${i}`, 1 + rnd(200), 1 + rnd(140)))
      }
      const L = layoutPieces(d, items, BAND, DPI, lim, true)
      L.split.pieces.forEach((idx, k) => {
        const alone = layoutFlow(d, idx.map((i) => items[i] as MeasuredItem), BAND, DPI, lim)
        const [a, b] = L.spans[k] ?? [0, 0]
        expect(b - a).toBe(alone.lengthDots)
        idx.forEach((i, j) => {
          expect(L.placements[i]?.x).toBe((alone.placements[j]?.x ?? 0) + a)
          expect(L.placements[i]?.y).toBe(alone.placements[j]?.y)
        })
      })
      L.split.kept.forEach((i, k) => expect(L.placements[i]?.x).toBe(L.pieceEdges[k]))
      // Every item knows its piece; a piece's auto length is its blocks alone at the auto length.
      L.split.pieces.forEach((idx, k) => idx.forEach((i) => expect(L.pieceOf[i]).toBe(k)))
      L.split.kept.forEach((i, k) => expect(L.pieceOf[i]).toBe(k))
      L.split.pieces.forEach((idx, k) => {
        const auto = layoutFlow({ ...d, length: { mode: 'auto' } }, idx.map((i) => items[i] as MeasuredItem), BAND, DPI, lim)
        expect(L.autoDots[k]).toBe(auto.lengthDots)
      })
    }
  })

  it('a fixed length is the length of each piece, content centred in it', () => {
    const d = doc({ length: { mode: 'fixed', mm: 30 } })
    const L = layoutPieces(d, [item('a', 100, 60), cut('c'), item('b', 50, 60)], BAND, DPI, limits, true)
    expect(L.spans).toEqual([
      [0, 213],
      [213, 426],
    ])
    expect(L.placements[0]?.x).toBe(14 + Math.floor((213 - 28 - 100) / 2))
    expect(L.placements[2]?.x).toBe(213 + 14 + Math.floor((213 - 28 - 50) / 2))
  })

  it('a piece that overflows a fixed length: its blocks start at its margin and run past its end (the renderer cuts them off at the cut)', () => {
    const d = doc({ length: { mode: 'fixed', mm: 20 } })
    const L = layoutPieces(d, [item('a', 300, 60), cut('c'), item('b', 50, 60)], BAND, DPI, limits, true)
    expect(L.spans).toEqual([
      [0, 142],
      [142, 284],
    ])
    expect(L.overflow).toBe(true)
    expect(L.placements[0]?.x).toBe(14)
    expect(L.pieceOf).toEqual([0, 0, 1])
    expect(L.autoDots).toEqual([328, 78])
  })

  it('the printer minimum pads every piece', () => {
    const d = doc({ marginsMm: { start: 0, end: 0 } })
    const L = layoutPieces(d, [item('a', 10, 60), cut('c'), item('b', 50, 60)], BAND, DPI, { minLengthDots: 30 }, true)
    expect(L.spans).toEqual([
      [0, 30],
      [30, 80],
    ])
    expect(L.pieceMin).toBe(true)
    expect(L.placements[0]?.x).toBe(10)
  })

  it('the maximum: per piece when the printer cuts (the renderer checks it), the strip otherwise', () => {
    const items = [item('a', 300, 60), cut('c'), item('b', 300, 60)]
    const cutting = layoutPieces(doc(), items, BAND, DPI, { minLengthDots: 3, maxLengthDots: 400 }, true)
    expect(cutting.lengthDots).toBe(656)
    expect(cutting.clamped).toBeUndefined()
    const marks = layoutPieces(doc(), items, BAND, DPI, { minLengthDots: 3, maxLengthDots: 400 }, false)
    expect(marks.lengthDots).toBe(400)
    expect(marks.clamped).toBe('max')
    expect(marks.overflow).toBe(true)
    expect(marks.spans).toEqual([
      [0, 328],
      [328, 400],
    ])
  })

  it('ignored Cuts change nothing: same placements as without them', () => {
    const plain = [item('a', 100, 60), item('b', 50, 60)]
    const withIgnored = [cut('s'), item('a', 100, 60), item('b', 50, 60), cut('e')]
    const A = layoutFlow(doc(), plain, BAND, DPI, limits)
    const B = layoutPieces(doc(), withIgnored, BAND, DPI, limits, true)
    expect(B.lengthDots).toBe(A.lengthDots)
    expect([B.placements[1]?.x, B.placements[2]?.x]).toEqual(A.placements.map((p) => p.x))
    expect(B.pieceEdges).toEqual([])
  })
})

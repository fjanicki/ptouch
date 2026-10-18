// Tables (docs/TABLE-PLAN.md §2) — pure table geometry with a deterministic fake font: whole-dot
// edges, auto / equal / fixed columns, one baseline per row, whole-dot text origins, alignment,
// grid lines, cut marks and machine cuts, the across directions (row 1 at the right / left end,
// equal pieces), fixed lengths shrinking the one em, pixel-font snapping.
import { describe, expect, it } from 'vitest'
import { createItem, type TableItem } from '../../../src/doc/schema'
import { acrossRowSpan, evenEdges, gridDots, layoutTable, type TableEnv, type TableLayout } from '../../../src/render/table-layout'
import type { FaceMetrics, MeasureFn } from '../../../src/render/text'
import { mmToDots } from '../../../src/render/units'

/** Fake font: 0.6 em advance per character, caps 0.72 em, descenders 0.22 em, ink = advance. */
const measure: MeasureFn = (text, px) => {
  const asc = /[A-Z0-9♯♭bdfhklt]/.test(text) ? 0.72 : 0.5
  const desc = /[gjpqy]/.test(text) ? 0.22 : 0
  const advance = 0.6 * px * [...text].length
  return { advance, left: 0, right: advance, ascent: asc * px, descent: desc * px }
}
const FACE: FaceMetrics = { cap: 0.7, desc: 0.2 }
const F = 3
const ENV: TableEnv = { band: 128, f: F, dpi: 180 }

const table = (patch: Partial<TableItem> = {}): TableItem => ({
  ...createItem('table'),
  cells: [
    ['DO', 'RE', 'MI', 'FA', 'SOL'],
    ['C', 'D', 'E', 'F', 'G'],
  ],
  ...patch,
})
const lay = (patch: Partial<TableItem> = {}, env: Partial<TableEnv> = {}): TableLayout => {
  const L = layoutTable(table(patch), FACE, measure, { ...ENV, ...env })
  if (!L) throw new Error('empty')
  return L
}
const whole = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-9
const widths = (L: TableLayout): number[] => L.edges.slice(1).map((e, i) => e - (L.edges[i] ?? 0))

describe('table layout: along', () => {
  it('columns are as wide as their widest cell plus padding, at whole dots', () => {
    const L = lay()
    expect(L.edges[0]).toBe(0)
    expect(L.edges).toHaveLength(6)
    for (const e of L.edges) expect(Number.isInteger(e)).toBe(true)
    expect(L.w).toBe(L.edges[5])
    expect(L.h).toBe(128)
    const pad = mmToDots(1, 180)
    const em = L.emPx
    // "SOL" (3 letters) is the widest cell of the last column.
    expect(widths(L)[4]).toBe(Math.ceil((0.6 * em * 3) / F - 1e-6) + 2 * pad)
    expect(widths(L)[0]).toBe(Math.ceil((0.6 * em * 2) / F - 1e-6) + 2 * pad)
  })

  it('fit: one em for every cell, the largest whose ink fits the rows', () => {
    const L = lay()
    const rows = evenEdges(128, 2)
    const pad = Math.max(1, Math.round(0.08 * 64))
    const avail = (64 - 2 * pad) * F
    // Caps only: the ink box is 0.72 em.
    expect(L.emPx * 0.72).toBeCloseTo(avail, 6)
    expect(L.rows).toEqual(rows)
    expect(L.boxDots).toBeCloseTo(avail / F, 6)
  })

  it('every row has one baseline and every origin sits on a whole dot', () => {
    const L = lay()
    for (const r of [0, 1]) {
      const ys = new Set(L.cells.filter((c) => c.r === r).map((c) => c.y))
      expect(ys.size).toBe(1)
    }
    for (const c of L.cells) {
      expect(whole(c.x / F)).toBe(true)
      expect(whole(c.y / F)).toBe(true)
    }
    // Row 2 is one row height below row 1.
    const y = (r: number) => L.cells.find((c) => c.r === r)?.y ?? 0
    expect(y(1) - y(0)).toBe(64 * F)
  })

  it('ink stays inside its column (centred by default, left and right on request)', () => {
    for (const align of ['start', 'center', 'end'] as const) {
      const L = lay({ align })
      for (const c of L.cells) {
        const ink = 0.6 * L.emPx * [...c.text].length
        expect(c.x).toBeGreaterThanOrEqual((L.edges[c.c] ?? 0) * F)
        expect(c.x + ink).toBeLessThanOrEqual((L.edges[c.c + 1] ?? 0) * F + 1e-6)
      }
      const c = L.cells.find((x) => x.r === 1 && x.c === 4)!
      const pad = mmToDots(1, 180) * F
      if (align === 'start') expect(c.x).toBe((L.edges[4] ?? 0) * F + pad)
      if (align === 'end') expect(c.x + 0.6 * L.emPx).toBeLessThanOrEqual((L.edges[5] ?? 0) * F - pad + 1e-6)
    }
  })

  it('equal columns are all as wide as the widest', () => {
    const L = lay({ columns: { mode: 'equal' } })
    expect(new Set(widths(L)).size).toBe(1)
    expect(widths(L)[0]).toBe(Math.max(...widths(lay())))
  })

  it('fixed columns are that wide; too narrow shrinks the one em with a warning', () => {
    const L = lay({ columns: { mode: 'mm', mm: 25 } })
    expect(widths(L)).toEqual(new Array(5).fill(mmToDots(25, 180)))
    expect(L.reduced).toBeUndefined()
    const narrow = lay({ columns: { mode: 'mm', mm: 5 } })
    expect(widths(narrow)).toEqual(new Array(5).fill(mmToDots(5, 180)))
    expect(narrow.reduced).toBe('width')
    expect(narrow.emPx).toBeLessThan(L.emPx)
    // "SOL" now fits its 5 mm column (minus padding).
    expect(0.6 * narrow.emPx * 3).toBeLessThanOrEqual((mmToDots(5, 180) - 2 * mmToDots(1, 180)) * F + 1e-6)
  })

  it('a point size is used as given, and reduced to the rows with a warning', () => {
    const small = lay({ size: { mode: 'pt', pt: 12 } })
    expect(small.emPx).toBeCloseTo((12 * 180 * F) / 72, 6)
    expect(small.reduced).toBeUndefined()
    const big = lay({ size: { mode: 'pt', pt: 100 } })
    expect(big.reduced).toBe('rows')
    expect(big.emPx).toBeLessThanOrEqual(lay().emPx + 1e-6)
  })

  it('an empty column keeps a width; an empty table takes no space', () => {
    const L = lay({ cells: [['A', '', 'B']] })
    expect(widths(L)[1]).toBeGreaterThanOrEqual(2 * mmToDots(1, 180))
    expect(layoutTable(table({ cells: [['', ' ']] }), FACE, measure, ENV)).toBeUndefined()
  })

  it('grid lines: outer box inside the table and inner lines centred on the edges', () => {
    const t = gridDots(180)
    expect(t).toBe(2)
    const L = lay({ grid: true })
    const has = (x: number, y: number, w: number, h: number) => L.lines.some((r) => r.x === x && r.y === y && r.w === w && r.h === h)
    expect(has(0, 0, L.w, t)).toBe(true)
    expect(has(0, 128 - t, L.w, t)).toBe(true)
    expect(has(0, 0, t, 128)).toBe(true)
    expect(has(L.w - t, 0, t, 128)).toBe(true)
    expect(has(0, 64 - 1, L.w, t)).toBe(true)
    for (const e of L.edges.slice(1, -1)) expect(has(e - 1, 0, t, 128)).toBe(true)
    // The lines leave the text alone: every origin is right of its column's line.
    for (const c of L.cells) expect(c.x).toBeGreaterThanOrEqual(((L.edges[c.c] ?? 0) + 1) * F)
  })

  it('cut marks: short ticks at every column edge at both tape edges', () => {
    const L = lay({ cutMarks: true })
    const ml = Math.min(mmToDots(1.5, 180), Math.round(128 / 4))
    expect(L.marks).toHaveLength(2 * L.edges.length)
    expect(L.marks.filter((m) => m.y === 0 && m.h === ml)).toHaveLength(L.edges.length)
    expect(L.marks.filter((m) => m.y === 128 - ml)).toHaveLength(L.edges.length)
    expect(L.marks[0]).toMatchObject({ x: 0 })
    expect(L.marks[L.marks.length - 1]).toMatchObject({ x: L.w - 2 })
    expect(L.cuts).toEqual([])
  })

  it('cut between columns: cuts at the inner edges, every piece boxed on its own, no cut marks', () => {
    const L = lay({ grid: true, cutMarks: true }, { cut: true })
    expect(L.cuts).toEqual(L.edges.slice(1, -1))
    expect(L.marks).toEqual([])
    for (const e of L.cuts) {
      expect(L.lines.some((r) => r.x === e - 2 && r.w === 2 && r.h === 128)).toBe(true)
      expect(L.lines.some((r) => r.x === e && r.w === 2 && r.h === 128)).toBe(true)
    }
    // Equal columns give pieces of one length.
    const eq = lay({ columns: { mode: 'equal' } }, { cut: true })
    expect(new Set(widths(eq)).size).toBe(1)
  })

  it('pixel fonts: the em is a whole number of font pixels per dot', () => {
    const L = lay({}, { pixel: { emPx: 8 } })
    expect(L.pixelScale).toBeGreaterThanOrEqual(1)
    expect(L.emPx).toBe((L.pixelScale ?? 0) * 8 * F)
    expect(L.emPx).toBeLessThanOrEqual(lay().emPx + 1e-6)
  })
})

describe('table layout: across', () => {
  const across = (turn: 'across-down' | 'across-up', patch: Partial<TableItem> = {}, env: Partial<TableEnv> = {}) => lay({ direction: turn, ...patch }, env)

  it('every column is one piece of the same length; the longest cell fits across the band', () => {
    const L = across('across-down')
    expect(L.turn).toBe(90)
    expect(L.piece).toBeGreaterThan(0)
    expect(new Set(widths(L))).toEqual(new Set([L.piece]))
    // SOL is the longest cell: it fills the band minus the padding.
    expect(0.6 * L.emPx * 3).toBeCloseTo((128 - 2 * mmToDots(1, 180)) * F, 6)
    // Same cells in every piece: same block coordinates.
    expect(L.cells.find((c) => c.r === 1 && c.c === 0)?.y).toBe(L.cells.find((c) => c.r === 1 && c.c === 3)?.y)
  })

  it('↓ puts row 1 at the right end of each piece, ↑ at the left end', () => {
    const down = across('across-down')
    const up = across('across-up')
    expect(up.turn).toBe(270)
    const P = down.piece ?? 0
    expect(acrossRowSpan(down, 2, 0)).toEqual([(down.edges[2] ?? 0) + P - (down.rows[1] ?? 0), (down.edges[2] ?? 0) + P])
    expect(acrossRowSpan(up, 2, 0)).toEqual([up.edges[2] ?? 0, (up.edges[2] ?? 0) + (up.rows[1] ?? 0)])
    // Both directions print the same pieces, mirrored by the half turn.
    expect(up.edges).toEqual(down.edges)
    expect(up.cells).toEqual(down.cells)
  })

  it('a fixed piece length is the length of every piece and shrinks the text when needed', () => {
    const roomy = across('across-down', { columns: { mode: 'mm', mm: 30 } })
    expect(widths(roomy)).toEqual(new Array(5).fill(mmToDots(30, 180)))
    const short = across('across-down', { columns: { mode: 'mm', mm: 6 } })
    expect(short.emPx).toBeLessThan(roomy.emPx)
    expect(short.boxDots * 2).toBeLessThanOrEqual(mmToDots(6, 180))
    const pt = across('across-down', { columns: { mode: 'mm', mm: 6 }, size: { mode: 'pt', pt: 40 } })
    expect(pt.reduced).toBe('piece')
    const wide = across('across-up', { size: { mode: 'pt', pt: 100 } })
    expect(wide.reduced).toBe('band')
  })

  it('row separators and cut marks fall on whole dots inside the pieces', () => {
    const L = across('across-down', { grid: true, cutMarks: true })
    for (const r of [...L.lines, ...L.marks]) for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isInteger(v)).toBe(true)
    const P = L.piece ?? 0
    // One separator per piece (2 rows), the 4 piece edges doubled, and the outer box.
    expect(L.lines.filter((r) => r.h === 128 && r.w === 2)).toHaveLength(5 + 2 * 4 + 2)
    const sep = L.lines.find((r) => r.h === 128 && r.x > 2 && r.x < P - 2)
    expect(sep).toBeDefined()
    // A piece edge is twice as heavy as a row line, so the pieces stand out on an uncut strip.
    const at = (x: number): boolean => L.lines.some((r) => r.h === 128 && x >= r.x && x < r.x + r.w)
    const edge = L.edges[1] ?? 0
    expect([edge - 2, edge - 1, edge, edge + 1].every(at)).toBe(true)
    expect(at(edge - 3) || at(edge + 2)).toBe(false)
    expect(at((sep?.x ?? 0) - 1) || at((sep?.x ?? 0) + 2)).toBe(false)
  })
})

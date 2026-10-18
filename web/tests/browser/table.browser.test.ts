// Tables (docs/TABLE-PLAN.md §8) — the table block rendered in Chromium with the bundled fonts and
// the wasm raster: bitmap snapshots (along, grid + cut marks, equal right-aligned, across ↓ / ↑,
// the three piano templates, the chromatic one across), exact alignment (one bottom ink row per
// row, ink inside its column, identical pieces), ♯ drawn with the bundled JetBrains Mono, the
// PNG export = the print bitmap, and a cut job = the bitmap cropped at the cuts × copies.
import { beforeAll, describe, expect, it } from 'vitest'
import { decodeJob, loadWasm, mediaForWidth, printArea, release, type Bitmap1 } from '../../src/wasm'
import { buildPrintJob, ensureFonts, pageSpans, renderLabel, type RenderResult, type RenderTarget } from '../../src/render'
import { exportPng } from '../../src/render/export'
import { createDoc, createItem, DEFAULT_PRINT, type LabelDoc, type TableItem } from '../../src/doc/schema'
import { templateById } from '../../src/ui/templates/templates'
import { expectBitmapSnapshot } from './snapshot'

const TEXT_TOLERANCE = 0.03

function target(widthMm = 24, model = 'PT-P710BT'): RenderTarget {
  const media = mediaForWidth(model, widthMm)
  return { model, media, area: printArea(model, media.id) }
}

const NOTES = [
  ['DO', 'RE', 'MI', 'FA', 'SOL'],
  ['C', 'D', 'E', 'F', 'G'],
]
const table = (patch: Partial<TableItem> = {}): TableItem => ({ ...createItem('table'), cells: NOTES.map((r) => [...r]), fontWeight: 700, ...patch })
const label = (items: TableItem[], patch: Partial<LabelDoc> = {}): LabelDoc => createDoc({ items, marginsMm: { start: 0, end: 0 }, ...patch })
const template = (id: string, direction?: TableItem['direction']): LabelDoc => {
  const d = templateById(id)!.build()
  return direction ? { ...d, items: d.items.map((i) => (i.kind === 'table' ? { ...i, direction } : i)) } : d
}

async function render(doc: LabelDoc, t = target()): Promise<RenderResult> {
  await ensureFonts(doc)
  return renderLabel(doc, t)
}

/** Lowest ink row (y) in columns [x0, x1), or -1. */
function bottomInk(b: Bitmap1, x0: number, x1: number): number {
  for (let y = b.height - 1; y >= 0; y--) for (let x = x0; x < x1; x++) if (b.get(x, y)) return y
  return -1
}
function inkIn(b: Bitmap1, x0: number, x1: number, y0 = 0, y1 = b.height): number {
  let n = 0
  for (let x = Math.max(0, x0); x < Math.min(b.length, x1); x++) for (let y = y0; y < y1; y++) if (b.get(x, y)) n++
  return n
}
function same(a: Bitmap1, ax: number, b: Bitmap1, bx: number, len: number): number {
  let differ = 0
  for (let x = 0; x < len; x++) for (let y = 0; y < a.height; y++) if (a.get(ax + x, y) !== b.get(bx + x, y)) differ++
  return differ
}

beforeAll(async () => {
  await loadWasm()
})

describe('table snapshots (24 mm, PT-P710BT)', () => {
  const cases: [string, LabelDoc][] = [
    ['table-along-24mm', label([table()])],
    ['table-grid-cutmarks-24mm', label([table({ grid: true, cutMarks: true })])],
    ['table-equal-right-24mm', label([table({ columns: { mode: 'equal' }, align: 'end', fontFamily: 'archivo-narrow' })])],
    ['table-across-down-24mm', label([table({ direction: 'across-down', grid: true })])],
    ['table-across-up-24mm', label([table({ direction: 'across-up', cutMarks: true })])],
    ['piano-white-24mm', template('piano-white-24')],
    ['piano-12-24mm', template('piano-12-24')],
    ['piano-12-across-24mm', template('piano-12-24', 'across-down')],
    ['piano-12-flats-24mm', template('piano-12-flats-24')],
  ]
  for (const [name, doc] of cases) {
    it(name, async () => {
      const r = await render(doc)
      try {
        expect(r.warnings.map((w) => `${w.code}: ${w.message}`)).toEqual([])
        expect(r.bitmap.isBlank()).toBe(false)
        await expectBitmapSnapshot(r.bitmap, name, TEXT_TOLERANCE)
      } finally {
        release(r.bitmap)
      }
    })
  }
})

describe('table alignment', () => {
  it('along: every row has one bottom ink line; ink stays inside its column', async () => {
    // Cut between columns exposes the column edges as `cuts`. Flat-bottomed letters only (round
    // ones overshoot the baseline by design).
    const r = await render(label([table({ cutBetween: true, cells: [['EL', 'HI', 'TE', 'LI', 'FEH'], ['E', 'F', 'H', 'I', 'L']] })]))
    try {
      const edges = [0, ...(r.cuts ?? []), r.lengthDots]
      expect(edges).toHaveLength(6)
      const half = r.heightDots / 2
      const bottoms = (y0: number, y1: number) =>
        edges.slice(1).map((e, i) => {
          for (let y = y1 - 1; y >= y0; y--) if (inkIn(r.bitmap, edges[i] ?? 0, e, y, y + 1)) return y
          return -1
        })
      expect(new Set(bottoms(0, half)).size).toBe(1)
      expect(new Set(bottoms(half, r.heightDots)).size).toBe(1)
      // 1 mm padding: nothing printed within 3 dots of a column edge.
      for (const e of edges) expect(inkIn(r.bitmap, e - 3, e + 3)).toBe(0)
    } finally {
      release(r.bitmap)
    }
  })

  it('the same text prints the same dots in every cell and every piece (along and across)', async () => {
    for (const direction of ['along', 'across-down', 'across-up'] as const) {
      const r = await render(label([table({ direction, cells: [['SOL', 'SOL', 'SOL'], ['G', 'G', 'G']], cutBetween: true, grid: true })]))
      try {
        const spans = pageSpans(r)
        expect(spans, direction).toHaveLength(3)
        const [a0 = 0, a1 = 0] = spans[0] ?? []
        for (const [b0] of spans.slice(1)) expect(same(r.bitmap, a0, r.bitmap, b0, a1 - a0), direction).toBe(0)
      } finally {
        release(r.bitmap)
      }
    }
  })

  it('across ↓ and ↑ are the same pieces turned 180°', async () => {
    const down = await render(label([table({ direction: 'across-down' })]))
    const up = await render(label([table({ direction: 'across-up' })]))
    try {
      expect(up.lengthDots).toBe(down.lengthDots)
      const H = down.heightDots
      const piece = down.lengthDots / 5
      expect(Number.isInteger(piece)).toBe(true)
      // Piece by piece (the columns keep their order): at most a few antialiased edge dots differ.
      for (let c = 0; c < 5; c++) {
        let d = 0
        const ink = inkIn(down.bitmap, c * piece, (c + 1) * piece)
        for (let x = 0; x < piece; x++) for (let y = 0; y < H; y++) if (down.bitmap.get(c * piece + x, y) !== up.bitmap.get(c * piece + piece - 1 - x, H - 1 - y)) d++
        expect(d / ink, `piece ${c + 1}`).toBeLessThanOrEqual(0.03)
      }
    } finally {
      release(down.bitmap)
      release(up.bitmap)
    }
  })

  it('♯ is drawn with the bundled JetBrains Mono (loaded with the table), not a system font', async () => {
    const doc = label([table({ cells: [['DO♯']], fontFamily: 'fira-sans' })])
    const report = await ensureFonts(doc)
    expect(report.fallbacks).toEqual([])
    const r = await renderLabel(doc, target())
    const plain = await render(label([table({ cells: [['DO']], fontFamily: 'fira-sans' })]))
    try {
      expect(r.warnings).toEqual([])
      expect(r.lengthDots).toBeGreaterThan(plain.lengthDots)
      expect(document.fonts.check('700 20px "ptouch Symbols JetBrains Mono"', '♯')).toBe(true)
    } finally {
      release(r.bitmap)
      release(plain.bitmap)
    }
  })
})

describe('table output identity', () => {
  it('the PNG export decodes to exactly the print bitmap', async () => {
    const r = await render(label([table({ grid: true })]))
    try {
      const png = await exportPng(r.bitmap, { dpi: 180 })
      const img = await createImageBitmap(png)
      expect([img.width, img.height]).toEqual([r.bitmap.length, r.bitmap.height])
      const ctx = new OffscreenCanvas(img.width, img.height).getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0)
      const px = ctx.getImageData(0, 0, img.width, img.height).data
      let bad = 0
      for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (((px[(y * img.width + x) * 4] ?? 0) < 128) !== r.bitmap.get(x, y)) bad++
      expect(bad).toBe(0)
    } finally {
      release(r.bitmap)
    }
  })

  it('cut between columns: one job of the bitmap cropped at the cuts, columns × copies pages', async () => {
    const t = target()
    const doc = label([table({ cutBetween: true, columns: { mode: 'equal' } })], { print: { ...DEFAULT_PRINT, copies: 2 } })
    const r = await render(doc, t)
    try {
      expect(r.cuts).toHaveLength(4)
      const job = buildPrintJob(doc, r, t)
      expect(job.pageCount).toBe(10)
      const decoded = decodeJob(t.model, job.toBytes())
      expect(decoded.violations()).toEqual([])
      const pages = decoded.pages()
      const spans = pageSpans(r)
      pages.forEach((p, i) => {
        const [a = 0, b = 0] = spans[i % 5] ?? []
        expect(p.length).toBeGreaterThanOrEqual(b - a)
        expect(same(p, Math.floor((p.length - (b - a)) / 2), r.bitmap, a, b - a), `page ${i + 1}`).toBe(0)
        p.free()
      })
      decoded.free()
      job.free()
    } finally {
      release(r.bitmap)
    }
  })

  it('cut between columns: the strip may be longer than the printer maximum, each piece may not', async () => {
    const t = target()
    const max = t.area.maxLengthDots ?? 0
    expect(max).toBeGreaterThan(0)
    // An 88-key keyboard: 88 pieces of 20 mm = 1760 mm, well over the 1000 mm of one page.
    const keys = table({ cells: [Array.from({ length: 88 }, (_, i) => `K${i + 1}`)], columns: { mode: 'mm', mm: 20 } })
    const cut = label([{ ...keys, cutBetween: true }])
    const r = await render(cut, t)
    const strip = await render(label([keys]), t)
    try {
      // No label-level length warning (the table's own "text made smaller" is fine here).
      expect(r.warnings.filter((w) => w.code === 'length-clamped' || (w.code === 'content-overflow' && !w.itemId))).toEqual([])
      expect(r.blocking).toBe(false)
      expect(r.lengthDots).toBeGreaterThan(max)
      expect(r.cuts).toHaveLength(87)
      const job = buildPrintJob(cut, r, t)
      expect(job.pageCount).toBe(88)
      job.free()
      // Not cut: one page, cut to the maximum as before.
      expect(strip.lengthDots).toBe(max)
      expect(strip.warnings.map((w) => w.code)).toContain('length-clamped')
    } finally {
      release(r.bitmap)
      release(strip.bitmap)
    }
    // A piece longer than the maximum blocks printing (a synthetic 30 mm maximum, 40 mm pieces).
    const short = { ...t, area: { ...t.area, maxLengthDots: Math.round((30 * t.area.dpi) / 25.4) } }
    const long = await render(label([table({ cutBetween: true, columns: { mode: 'mm', mm: 40 } })]), short)
    try {
      expect(long.blocking).toBe(true)
      expect(long.warnings[0]?.message).toMatch(/at most 30 mm per piece/)
    } finally {
      release(long.bitmap)
    }
  })

  it('Cut each off, or a printer without a cutter: one piece, cut marks drawn', async () => {
    const off = await render(label([table({ cutBetween: true, cutMarks: true })], { print: { ...DEFAULT_PRINT, autoCut: false } }))
    const noCutter = await renderLabel(label([table({ cutBetween: true, cutMarks: true })]), target(12, 'PT-P300BT'), { cutter: false })
    try {
      expect(off.cuts).toBeUndefined()
      expect(noCutter.cuts).toBeUndefined()
      expect(inkIn(off.bitmap, 0, 2, 0, 4)).toBeGreaterThan(0)
    } finally {
      release(off.bitmap)
      release(noCutter.bitmap)
    }
  })
})

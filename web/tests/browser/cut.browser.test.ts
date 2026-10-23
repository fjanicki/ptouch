// Cut blocks (docs/CUT-PLAN.md §6) — the strip rendered in Chromium with the bundled fonts and the
// wasm raster: bitmap snapshots (printer cuts, cut marks without a cutter or with Cut each off, a
// frame around every piece at a fixed length, table cuts combined with Cut blocks, 360 dpi), the
// C2 promise (every piece is dot for dot the label of its blocks printed alone), ignored Cuts
// change nothing, and the job: one page per piece × copies, cut after every page.
import { beforeAll, describe, expect, it } from 'vitest'
import { decodeJob, loadWasm, mediaForWidth, printArea, release, type Bitmap1 } from '../../src/wasm'
import { buildPrintJob, ensureFonts, mmToDots, pageSpans, renderLabel, type RenderOptions, type RenderResult, type RenderTarget } from '../../src/render'
import { createDoc, createItem, DEFAULT_PRINT, type CodeItem, type ImageItem, type Item, type LabelDoc, type TableItem, type TextItem } from '../../src/doc/schema'
import { expectBitmapSnapshot } from './snapshot'

const TEXT_TOLERANCE = 0.03

function target(widthMm = 24, model = 'PT-P710BT'): RenderTarget {
  const media = mediaForWidth(model, widthMm)
  return { model, media, area: printArea(model, media.id) }
}

const text = (t: string, patch: Partial<TextItem> = {}): TextItem => ({ ...createItem('text'), text: t, ...patch })
const qr = (data = 'https://example.com/garage'): CodeItem => ({ ...createItem('code'), data })
const cut = (): Item => createItem('cut')
const strip = (items: Item[], patch: Partial<LabelDoc> = {}): LabelDoc => createDoc({ items, ...patch })

async function render(doc: LabelDoc, t = target(), opts: RenderOptions = {}): Promise<RenderResult> {
  await ensureFonts(doc)
  return renderLabel(doc, t, opts)
}

/** Dots that differ between `a[ax…]` and `b[bx…]` over `len` columns. */
function differ(a: Bitmap1, ax: number, b: Bitmap1, bx: number, len: number): number {
  let n = 0
  for (let x = 0; x < len; x++) for (let y = 0; y < a.height; y++) if (a.get(ax + x, y) !== b.get(bx + x, y)) n++
  return n
}
/** Dots that differ between `a[ax…]` and `b[bx…]` read backwards (b mirrored along the label). */
function differMirrored(a: Bitmap1, ax: number, b: Bitmap1, bx: number, len: number): number {
  let n = 0
  for (let x = 0; x < len; x++) for (let y = 0; y < a.height; y++) if (a.get(ax + x, y) !== b.get(bx + len - 1 - x, y)) n++
  return n
}
function inkIn(b: Bitmap1, x0: number, x1: number, y0 = 0, y1 = b.height): number {
  let n = 0
  for (let x = Math.max(0, x0); x < Math.min(b.length, x1); x++) for (let y = y0; y < y1; y++) if (b.get(x, y)) n++
  return n
}

beforeAll(async () => {
  await loadWasm()
})

describe('cut snapshots', () => {
  const table = (patch: Partial<TableItem> = {}): TableItem => ({ ...createItem('table'), cells: [['DO', 'RE', 'MI']], fontWeight: 700, ...patch })
  const cases: [string, LabelDoc, () => RenderTarget, RenderOptions][] = [
    ['cut-three-pieces-24mm', strip([text('Kitchen'), cut(), text('Office'), cut(), qr()]), () => target(), {}],
    ['cut-marks-no-cutter-12mm', strip([text('Kitchen'), cut(), text('Office'), cut(), text('Garage')], { tape: { widthMm: 12 } }), () => target(12, 'PT-P300BT'), { cutter: false }],
    ['cut-marks-cut-each-off-24mm', strip([text('Kitchen'), cut(), text('Office'), cut(), qr()], { print: { ...DEFAULT_PRINT, autoCut: false } }), () => target(), {}],
    ['cut-frame-fixed-24mm', strip([text('Kitchen'), cut(), text('Office'), cut(), qr()], { frame: { thicknessMm: 0.5, radiusMm: 1, insetMm: 0.5 }, length: { mode: 'fixed', mm: 30, shrink: true } }), () => target(), {}],
    ['cut-table-combined-24mm', strip([text('Scale'), cut(), table({ cutBetween: true, grid: true }), cut(), qr()]), () => target(), {}],
    ['m360-cut-36mm', strip([text('Kitchen'), cut(), text('Office'), cut(), qr()], { tape: { widthMm: 36 } }), () => target(36, 'PT-P910BT'), {}],
  ]
  for (const [name, doc, t, opts] of cases) {
    it(name, async () => {
      const r = await render(doc, t(), opts)
      try {
        expect(r.warnings.map((w) => `${w.code}: ${w.message}`)).toEqual([])
        expect(r.bitmap.isBlank()).toBe(false)
        const machine = opts.cutter !== false && doc.print.autoCut
        if (machine) {
          expect(r.marks).toBeUndefined()
          expect(r.cutItems?.map((c) => c.how)).toEqual(['printer', 'printer'])
        } else {
          expect(r.cuts).toBeUndefined()
          expect(r.marks).toHaveLength(2)
          expect(r.cutItems?.map((c) => c.how)).toEqual(['mark', 'mark'])
          // Ticks at both tape edges at every mark, nothing in the middle of the band there.
          for (const x of r.marks ?? []) {
            expect(inkIn(r.bitmap, x - 1, x + 1, 0, 3)).toBeGreaterThan(0)
            expect(inkIn(r.bitmap, x - 1, x + 1, r.heightDots - 3, r.heightDots)).toBeGreaterThan(0)
            expect(inkIn(r.bitmap, x - 1, x + 1, Math.floor(r.heightDots / 2) - 2, Math.floor(r.heightDots / 2) + 2)).toBe(0)
          }
        }
        await expectBitmapSnapshot(r.bitmap, name, TEXT_TOLERANCE)
      } finally {
        release(r.bitmap)
      }
    })
  }
})

describe('every piece is the label of its blocks printed on its own (C2)', () => {
  const PIECES: Item[][] = [[text('Kitchen')], [text('Office'), qr('https://example.com/office')], [qr(), text('Garage', { fontWeight: 800 })]]
  const variants: [string, Partial<LabelDoc>, () => RenderTarget][] = [
    ['auto, 180 dpi', {}, () => target()],
    ['fixed 80 mm, frame, 180 dpi', { length: { mode: 'fixed', mm: 80 }, frame: { thicknessMm: 0.5, radiusMm: 1, insetMm: 0.5 } }, () => target()],
    ['auto, frame with inset 0, gap 1 mm, margins 1 / 3 mm', { frame: { thicknessMm: 0.4, radiusMm: 0, insetMm: 0 }, layout: { mode: 'flow', gapMm: 1, align: 'end' }, marginsMm: { start: 1, end: 3 } }, () => target()],
    ['auto, 360 dpi', { tape: { widthMm: 36 } }, () => target(36, 'PT-P910BT')],
    ['fixed 160 mm, frame, 360 dpi', { tape: { widthMm: 36 }, length: { mode: 'fixed', mm: 160 }, frame: { thicknessMm: 0.5, radiusMm: 1, insetMm: 0.5 } }, () => target(36, 'PT-P910BT')],
  ]
  for (const [name, patch, tf] of variants) {
    it(name, async () => {
      const t = tf()
      const whole = await render(strip(PIECES.flatMap((p, i) => (i ? [cut(), ...p] : p)), patch), t)
      try {
        expect(whole.warnings).toEqual([])
        const spans = pageSpans(whole)
        expect(spans).toHaveLength(PIECES.length)
        for (const [k, blocks] of PIECES.entries()) {
          const alone = await render(strip(blocks, patch), t)
          try {
            const [a = 0, b = 0] = spans[k] ?? []
            expect(b - a, `piece ${k + 1} length`).toBe(alone.lengthDots)
            expect(differ(whole.bitmap, a, alone.bitmap, 0, b - a), `piece ${k + 1}`).toBe(0)
          } finally {
            release(alone.bitmap)
          }
        }
      } finally {
        release(whole.bitmap)
      }
    })
  }
})

describe('a piece that overflows a fixed length is cut off at its cut (C2)', () => {
  /** A 256 × 128 grey ramp (a photo wider than a 20 mm piece). */
  async function rampPng(): Promise<Blob> {
    const c = new OffscreenCanvas(256, 128)
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
    const img = ctx.createImageData(256, 128)
    for (let y = 0; y < 128; y++) for (let x = 0; x < 256; x++) img.data.set([x, x, x, 255], (y * 256 + x) * 4)
    ctx.putImageData(img, 0, 0)
    return c.convertToBlob({ type: 'image/png' })
  }
  const photo: ImageItem = { ...createItem('image'), blobRef: 'ramp', dither: 'floyd-steinberg' }
  const FIRST: [string, Item[]][] = [
    ['text', [text('Kitchen drawer left side')]],
    ['text and a QR code', [text('Drawer'), qr()]],
    ['a photo', [photo]],
  ]
  for (const [what, first] of FIRST) {
    for (const autoCut of [true, false]) {
      it(`${what}, ${autoCut ? 'the printer cuts' : 'cut marks'}: both pieces are the labels of their blocks alone`, async () => {
        const blob = await rampPng()
        const opts: RenderOptions = { loadBlob: async (ref) => (ref === 'ramp' ? blob : undefined) }
        const patch: Partial<LabelDoc> = { length: { mode: 'fixed', mm: 20 }, print: { ...DEFAULT_PRINT, autoCut } }
        const whole = await render(strip([...first, cut(), text('B')], patch), target(), opts)
        const alone1 = await render(strip(first, patch), target(), opts)
        const alone2 = await render(strip([text('B')], patch), target(), opts)
        try {
          expect(whole.warnings.some((w) => w.code === 'content-overflow' && w.message.startsWith('A piece is longer than the fixed length of each piece and will be cut off.'))).toBe(true)
          expect(whole.blocking).toBe(false)
          const edge = alone1.lengthDots
          expect(whole.lengthDots).toBe(edge + alone2.lengthDots)
          if (autoCut) {
            expect(whole.cuts).toEqual([edge])
            expect(differ(whole.bitmap, 0, alone1.bitmap, 0, edge), 'piece 1').toBe(0)
            expect(differ(whole.bitmap, edge, alone2.bitmap, 0, alone2.lengthDots), 'piece 2').toBe(0)
          } else {
            // The cut mark's ticks sit on the edge (2 dots wide, x − 1 and x); the rest is each label.
            expect(whole.marks).toEqual([edge])
            expect(differ(whole.bitmap, 0, alone1.bitmap, 0, edge - 1), 'piece 1').toBe(0)
            expect(differ(whole.bitmap, edge + 1, alone2.bitmap, 1, alone2.lengthDots - 1), 'piece 2').toBe(0)
            expect(inkIn(whole.bitmap, edge, edge + 1, 12, whole.heightDots - 12), 'between the ticks').toBe(0)
          }
          // The start margin of piece 2 is blank, as on the label printed alone.
          expect(inkIn(whole.bitmap, edge + 1, edge + 14, 12, whole.heightDots - 12)).toBe(0)
        } finally {
          release(whole.bitmap)
          release(alone1.bitmap)
          release(alone2.bitmap)
        }
      })
    }
  }

  it('a table cut between its columns that overflows its piece keeps its cuts inside the piece', async () => {
    const t: TableItem = { ...createItem('table'), cells: [['DO', 'RE', 'MI', 'FA', 'SOL']], cutBetween: true, columns: { mode: 'mm', mm: 15 } }
    const patch: Partial<LabelDoc> = { length: { mode: 'fixed', mm: 25 } }
    const whole = await render(strip([t, cut(), text('B')], patch))
    const alone1 = await render(strip([t], patch))
    const alone2 = await render(strip([text('B')], patch))
    try {
      const edge = alone1.lengthDots
      // The table's own cuts that fall inside its 25 mm piece, then the Cut's: none past the edge.
      expect(whole.cuts).toEqual([...(alone1.cuts ?? []), edge])
      expect(differ(whole.bitmap, 0, alone1.bitmap, 0, edge), 'piece 1').toBe(0)
      expect(differ(whole.bitmap, edge, alone2.bitmap, 0, alone2.lengthDots), 'piece 2').toBe(0)
    } finally {
      release(whole.bitmap)
      release(alone1.bitmap)
      release(alone2.bitmap)
    }
  })
})

describe('shrink to fit length per piece', () => {
  // The text's warnings at its final size come before the auto code's, as before Cut blocks: a
  // label without a Cut lists them in the same order, and each piece of a strip does too.
  it('text warnings before the auto linear code warnings, with and without Cuts', async () => {
    const long = (): TextItem => text('A rather long label text')
    const c128 = (): CodeItem => ({ ...createItem('code'), symbology: 'code128', data: 'ABC-123456' })
    const fixed = { length: { mode: 'fixed' as const, mm: 60, shrink: true } }
    const a = long()
    const b = c128()
    const plain = await render(strip([a, b, text('more words here')], fixed))
    try {
      expect(plain.warnings.map((w) => [w.code, w.itemId])).toEqual([
        ['small-text', a.id],
        ['code-too-small', b.id],
        ['content-overflow', undefined],
      ])
    } finally {
      release(plain.bitmap)
    }
    const a2 = long()
    const b2 = c128()
    const pieced = await render(strip([a, b, text('more words here'), cut(), a2, b2, text('more words here')], fixed))
    try {
      expect(pieced.warnings.filter((w) => w.code !== 'content-overflow').map((w) => [w.code, w.itemId])).toEqual([
        ['small-text', a.id],
        ['code-too-small', b.id],
        ['small-text', a2.id],
        ['code-too-small', b2.id],
      ])
    } finally {
      release(pieced.bitmap)
    }
  })
})

describe('cut marks next to codes', () => {
  // A code's quiet zone is cleared and protected; at margins 0 it reaches the piece edge, where
  // the cut mark is: the mark is protected first, so the code's quiet zone does not wipe it out.
  for (const symbology of ['qr', 'code128', 'datamatrix'] as const) {
    for (const margin of [0, 0.5, 2]) {
      it(`${symbology}, margins ${margin} mm: both ticks of the mark print in full`, async () => {
        const code = (data: string): CodeItem => ({ ...createItem('code'), symbology, data })
        const doc = strip([code('KITCHEN-01'), cut(), code('OFFICE-02')], { marginsMm: { start: margin, end: margin }, print: { ...DEFAULT_PRINT, autoCut: false } })
        const r = await render(doc)
        try {
          expect(r.warnings.map((w) => `${w.code}: ${w.message}`)).toEqual([])
          expect(r.marks).toHaveLength(1)
          const markW = Math.max(1, mmToDots(0.25, 180))
          const markL = Math.max(1, Math.min(mmToDots(1.5, 180), Math.round(r.heightDots / 4)))
          const x0 = (r.marks?.[0] ?? 0) - Math.floor(markW / 2)
          expect(inkIn(r.bitmap, x0, x0 + markW, 0, markL)).toBe(markW * markL)
          expect(inkIn(r.bitmap, x0, x0 + markW, r.heightDots - markL, r.heightDots)).toBe(markW * markL)
        } finally {
          release(r.bitmap)
        }
      })
    }
  }
})

describe('ignored cuts', () => {
  it('a Cut at the start, right after another Cut or at the end changes nothing, with a warning each', async () => {
    const a = text('Kitchen')
    const b = qr()
    const plain = await render(strip([a, b]))
    const c1 = cut()
    const c2 = cut()
    const c3 = cut()
    const c4 = cut()
    const ignored = await render(strip([c1, a, c2, c3, b, c4]))
    try {
      // c2 is kept (between a and b); c1 (start), c3 (double) and c4 (end) are ignored.
      expect(ignored.cutItems?.map((c) => [c.itemId, c.how, c.why])).toEqual([
        [c1.id, 'ignored', 'start'],
        [c2.id, 'printer', undefined],
        [c3.id, 'ignored', 'double'],
        [c4.id, 'ignored', 'end'],
      ])
      expect(ignored.warnings.map((w) => [w.code, w.itemId, !!w.blocking])).toEqual([
        ['cut-ignored', c1.id, false],
        ['cut-ignored', c3.id, false],
        ['cut-ignored', c4.id, false],
      ])
      expect(ignored.warnings.map((w) => w.message)).toEqual([
        'Nothing is printed before this cut, so it is ignored.',
        'Nothing is printed between this cut and the one before it, so it is ignored.',
        'Nothing is printed after this cut, so it is ignored. Add a block after it to start the next piece.',
      ])
    } finally {
      release(ignored.bitmap)
    }
    // Only ignored Cuts: bit-identical to the label without them.
    const onlyIgnored = await render(strip([cut(), a, b, cut(), cut()]))
    try {
      expect(onlyIgnored.cuts).toBeUndefined()
      expect(onlyIgnored.lengthDots).toBe(plain.lengthDots)
      expect(differ(onlyIgnored.bitmap, 0, plain.bitmap, 0, plain.lengthDots)).toBe(0)
      expect(onlyIgnored.warnings.map((w) => w.code)).toEqual(['cut-ignored', 'cut-ignored', 'cut-ignored'])
    } finally {
      release(onlyIgnored.bitmap)
      release(plain.bitmap)
    }
  })

  it('a label of Cuts only is empty (blocking), a piece empty in one record is dropped for it', async () => {
    const empty = await render(strip([cut(), cut()]))
    try {
      expect(empty.blocking).toBe(true)
      expect(empty.warnings.map((w) => w.code)).toContain('empty')
    } finally {
      release(empty.bitmap)
    }
    // An empty text (e.g. a batch variable without a value) makes its piece empty.
    const r = await render(strip([text('A'), cut(), text(''), cut(), text('B')]))
    try {
      expect(r.cuts).toHaveLength(1)
      expect(r.cutItems?.map((c) => c.how)).toEqual(['printer', 'ignored'])
    } finally {
      release(r.bitmap)
    }
  })
})

describe('cut boxes, limits and the frame', () => {
  it('a kept Cut is selectable: its box is the blank between the pieces', async () => {
    const c = cut()
    const r = await render(strip([text('A'), c, text('B')]))
    try {
      const x = r.cuts?.[0] ?? 0
      expect(r.boxes.find((b) => b.itemId === c.id)).toEqual({ itemId: c.id, x: x - 14, y: 0, w: 28, h: r.heightDots })
    } finally {
      release(r.bitmap)
    }
    const narrow = await render(strip([text('A'), c, text('B')], { marginsMm: { start: 0, end: 0 } }))
    try {
      const box = narrow.boxes.find((b) => b.itemId === c.id)
      expect(box?.w).toBe(11) // at least 1.5 mm
    } finally {
      release(narrow.bitmap)
    }
  })

  it('the printer maximum: per piece when cutting (blocking), the strip otherwise', async () => {
    const t = target()
    const short = { ...t, area: { ...t.area, maxLengthDots: Math.round((30 * t.area.dpi) / 25.4) } }
    const doc = strip([text('A long piece of text'), cut(), text('B')])
    const r = await render(doc, short)
    try {
      expect(r.blocking).toBe(true)
      expect(r.warnings[0]?.message).toMatch(/^A piece is \d+ mm long; this printer prints at most 30 mm per piece\. Add a Cut/)
    } finally {
      release(r.bitmap)
    }
    const off = await render({ ...doc, print: { ...doc.print, autoCut: false } }, short)
    try {
      expect(off.blocking).toBe(false)
      expect(off.lengthDots).toBe(short.area.maxLengthDots)
      expect(off.warnings.map((w) => w.code)).toContain('length-clamped')
    } finally {
      release(off.bitmap)
    }
  })

  it('a strip cut to the printer maximum (no machine cuts): a Cut past the maximum is ignored, with a warning', async () => {
    const t = target()
    const c1 = cut()
    const c2 = cut()
    const doc = strip([text('x'.repeat(200)), c1, text('x'.repeat(200)), c2, text('end')], { print: { ...DEFAULT_PRINT, autoCut: false } })
    const r = await render(doc, t)
    try {
      expect(r.lengthDots).toBe(t.area.maxLengthDots)
      expect(r.blocking).toBe(false)
      expect(r.marks).toBeUndefined()
      expect(r.cutItems).toEqual([
        { itemId: c1.id, how: 'ignored', why: 'max' },
        { itemId: c2.id, how: 'ignored', why: 'max' },
      ])
      expect(r.warnings.filter((w) => w.code === 'cut-ignored').map((w) => [w.itemId, w.message])).toEqual([
        [c1.id, 'The strip is cut off at the printer maximum before this cut, so it is ignored.'],
        [c2.id, 'The strip is cut off at the printer maximum before this cut, so it is ignored.'],
      ])
    } finally {
      release(r.bitmap)
    }
  })

  it('free layout: a framed block across a cut gets a warning; Cuts split the flowing blocks', async () => {
    const framed = { ...text('Across'), frame: { xMm: 5, yMm: 0, wMm: 40, hMm: 10, rotation: 0 as const } }
    const r = await render(strip([text('A'), cut(), text('B'), framed], { layout: { mode: 'free' } }))
    try {
      expect(r.cuts).toHaveLength(1)
      expect(r.warnings.filter((w) => w.itemId === framed.id).map((w) => w.message)).toContain('This block lies across a cut and will be cut through.')
    } finally {
      release(r.bitmap)
    }
  })
})

describe('the print job of a cut strip', () => {
  it('pages = the bitmap cropped at the cuts, pieces × copies, cut after every page; chain keeps the last', async () => {
    const t = target()
    for (const chain of [false, true]) {
      const doc = strip([text('Kitchen'), cut(), text('Office'), cut(), qr()], { print: { ...DEFAULT_PRINT, copies: 2, chain } })
      const r = await render(doc, t)
      try {
        const spans = pageSpans(r)
        expect(spans).toHaveLength(3)
        const job = buildPrintJob(doc, r, t)
        expect(job.pageCount).toBe(6)
        const decoded = decodeJob(t.model, job.toBytes())
        expect(decoded.violations()).toEqual([])
        const cmds = decoded.commands()
        expect(cmds.filter((c) => c === 'VariousMode(64)')).toHaveLength(6)
        expect(cmds.filter((c) => c.startsWith('AdvancedMode'))).toEqual(Array.from({ length: 6 }, () => (chain ? 'AdvancedMode(0)' : 'AdvancedMode(8)')))
        const pages = decoded.pages()
        pages.forEach((p, i) => {
          const [a = 0, b = 0] = spans[i % 3] ?? []
          expect(p.length, `page ${i + 1}`).toBe(b - a)
          expect(differ(p, 0, r.bitmap, a, b - a), `page ${i + 1}`).toBe(0)
          p.free()
        })
        decoded.free()
        job.free()
      } finally {
        release(r.bitmap)
      }
    }
  })

  it('mirror on the PT-P710BT (hardware mirror): the mirror flag on every page, the pages unchanged and in order', async () => {
    const t = target()
    const doc = strip([text('Kitchen'), cut(), qr()], { print: { ...DEFAULT_PRINT, copies: 2 } })
    const r = await render(doc, t)
    try {
      const plainJob = buildPrintJob(doc, r, t)
      const mirroredJob = buildPrintJob({ ...doc, print: { ...doc.print, mirror: true } }, r, t)
      // The printer mirrors each page itself: ESC i M = auto cut (0x40) | mirror (0x80) on every
      // page. The decoder does not apply that flag (only a software mirror changes the raster), so
      // the pages read back unchanged, in the same order.
      const plainDec = decodeJob(t.model, plainJob.toBytes())
      const mirroredDec = decodeJob(t.model, mirroredJob.toBytes())
      expect(plainDec.commands().filter((c) => c.startsWith('VariousMode'))).toEqual(Array.from({ length: 4 }, () => 'VariousMode(64)'))
      expect(mirroredDec.commands().filter((c) => c.startsWith('VariousMode'))).toEqual(Array.from({ length: 4 }, () => 'VariousMode(192)'))
      expect(mirroredDec.violations()).toEqual([])
      const plain = plainDec.pages()
      const mirrored = mirroredDec.pages()
      expect(mirrored.map((p) => p.length)).toEqual(plain.map((p) => p.length))
      mirrored.forEach((m, k) => expect(differ(m, 0, plain[k] as Bitmap1, 0, m.length), `page ${k + 1}`).toBe(0))
      for (const p of [...plain, ...mirrored]) p.free()
      plainDec.free()
      mirroredDec.free()
      plainJob.free()
      mirroredJob.free()
    } finally {
      release(r.bitmap)
    }
  })

  it('mirror on a cutter model that mirrors in software (PT-E560BT): every piece is mirrored in place, in order', async () => {
    const t = target(24, 'PT-E560BT')
    const doc = strip([text('Kitchen'), cut(), text('Office'), cut(), qr()], { print: { ...DEFAULT_PRINT, mirror: true } })
    const r = await render(doc, t)
    try {
      const spans = pageSpans(r)
      expect(spans).toHaveLength(3)
      const job = buildPrintJob(doc, r, t)
      const decoded = decodeJob(t.model, job.toBytes())
      expect(decoded.violations()).toEqual([])
      // No mirror flag (the model has none): the raster itself is mirrored, page by page.
      expect(decoded.commands().filter((c) => c.startsWith('VariousMode'))).toEqual(['VariousMode(64)', 'VariousMode(64)', 'VariousMode(64)'])
      const pages = decoded.pages()
      expect(pages.map((p) => p.length)).toEqual(spans.map(([a, b]) => b - a))
      pages.forEach((p, k) => {
        const [a = 0, b = 0] = spans[k] ?? []
        expect(differMirrored(p, 0, r.bitmap, a, b - a), `piece ${k + 1} mirrored in place`).toBe(0)
        // And not simply the piece as designed (each piece has ink off its centre line).
        expect(differ(p, 0, r.bitmap, a, b - a), `piece ${k + 1} is not unmirrored`).toBeGreaterThan(0)
        p.free()
      })
      decoded.free()
      job.free()
    } finally {
      release(r.bitmap)
    }
  })
})

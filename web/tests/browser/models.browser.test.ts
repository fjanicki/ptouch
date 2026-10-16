// P-render-templates (docs/MODELS-PLAN.md §3.10) — a 36 mm label at 360 dpi (PT-P910BT) renders
// at true physical size: the 454-dot band, mm lengths and margins in 360 dpi dots, quick sizes
// and point sizes of that band, an automatic QR module that fills it, a linear 'auto' module of
// the same physical size as at 180 dpi, and the PNG export's pHYs. Snapshots `m360-*`: the text
// one per OS (.macos/.linux, like every text snapshot), the QR and the ruler exact.
import { beforeAll, describe, expect, it } from 'vitest'
import { loadWasm, mediaForWidth, printArea, release, type Bitmap1 } from '../../src/wasm'
import { createDoc, createItem, type CodeItem, type Item, type LabelDoc, type ShapeItem, type TextItem } from '../../src/doc/schema'
import { renderLabel, type RenderTarget } from '../../src/render'
import { preloadAllFonts } from '../../src/render/fonts'
import { exportPng, pixelsPerMetre } from '../../src/render/export'
import { quickTextSizes } from '../../src/render/text-size'
import { dotsToMm, mmToDots } from '../../src/render/units'
import { expectBitmapSnapshot } from './snapshot'

const TEXT_TOLERANCE = 0.03

function target(model: string, widthMm: number): RenderTarget {
  const media = mediaForWidth(model, widthMm)
  return { model, media, area: printArea(model, media.id) }
}

const text = (t: string, patch: Partial<TextItem> = {}): TextItem => ({ ...createItem('text'), text: t, ...patch })
const code = (patch: Partial<CodeItem>): CodeItem => ({ ...createItem('code'), ...patch })
const label = (items: Item[], patch: Partial<LabelDoc> = {}): LabelDoc => createDoc({ tape: { widthMm: 36 }, items, ...patch })

/** Ink rows: [first, last] or undefined when blank. */
function inkRows(b: Bitmap1): [number, number] | undefined {
  let y0 = -1
  let y1 = -1
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.length; x++) {
      if (b.get(x, y)) {
        if (y0 < 0) y0 = y
        y1 = y
        break
      }
    }
  }
  return y0 < 0 ? undefined : [y0, y1]
}

/** Inked columns (x) of row `y`. */
function inkColumns(b: Bitmap1, y: number): number[] {
  const out: number[] = []
  for (let x = 0; x < b.length; x++) if (b.get(x, y)) out.push(x)
  return out
}

beforeAll(async () => {
  await loadWasm()
  await preloadAllFonts()
})

describe('36 mm at 360 dpi (PT-P910BT)', () => {
  it('the print area: 454 dots across (32 mm) on 512-dot tape', () => {
    const { area } = target('PT-P910BT', 36)
    expect(area).toMatchObject({ dpi: 360, heightDots: 454, tapeWidthDots: 512 })
    expect(dotsToMm(area.heightDots, area.dpi)).toBeCloseTo(32.03, 2)
  })

  it('a fixed length and margins are mm at 360 dpi; the result reports mm', async () => {
    const tg = target('PT-P910BT', 36)
    const r = await renderLabel(label([text('A', { size: { mode: 'mm', mm: 10 } })], { length: { mode: 'fixed', mm: 50 } }), tg)
    try {
      expect(r.heightDots).toBe(454)
      expect(r.bitmap.height).toBe(454)
      expect(r.lengthDots).toBe(mmToDots(50, 360)) // 709 dots
      expect(r.lengthMm).toBeCloseTo(50, 1)
      expect(r.warnings).toEqual([])
    } finally {
      release(r.bitmap)
    }
  })

  it('quick size M is half the band (227 dots); mm and pt sizes print the same mm as at 180 dpi', async () => {
    const tg = target('PT-P910BT', 36)
    const m = quickTextSizes(454, 360).find((q) => q.id === 'm')!
    expect(m).toMatchObject({ dots: 227, size: { mode: 'mm', mm: 16.02 }, tooSmall: false })
    // The same text at the same size on a 180 dpi head (PT-P710BT 24 mm, band 18 mm) and on the
    // 360 dpi one: the same height and length in mm (within a 180 dpi dot or two).
    for (const size of [m.size, { mode: 'pt', pt: 36 } as const, { mode: 'mm', mm: 6 } as const]) {
      const hi = await renderLabel(label([text('Hdg 36', { size })]), tg)
      const lo = await renderLabel(label([text('Hdg 36', { size })], { tape: { widthMm: 24 } }), target('PT-P710BT', 24))
      try {
        expect(hi.warnings).toEqual([])
        const a = inkRows(hi.bitmap)!
        const b = inkRows(lo.bitmap)!
        expect(Math.abs(dotsToMm(a[1] - a[0] + 1, 360) - dotsToMm(b[1] - b[0] + 1, 180)), JSON.stringify(size)).toBeLessThan(0.3)
        expect(Math.abs(hi.lengthMm - lo.lengthMm), JSON.stringify(size)).toBeLessThan(0.6)
      } finally {
        release(hi.bitmap)
        release(lo.bitmap)
      }
    }
  })

  it('text snapshot: M and a 12 pt line on 36 mm', async () => {
    const tg = target('PT-P910BT', 36)
    const m = quickTextSizes(454, 360).find((q) => q.id === 'm')!
    const doc = label([text('Shelf 36', { size: m.size }), text('12 pt at 360 dpi', { size: { mode: 'pt', pt: 12 } })], { layout: { mode: 'flow', gapMm: 3, align: 'center' } })
    const r = await renderLabel(doc, tg)
    try {
      expect(r.warnings).toEqual([])
      await expectBitmapSnapshot(r.bitmap, 'm360-text-36mm', TEXT_TOLERANCE)
    } finally {
      release(r.bitmap)
    }
  })

  it('QR auto module fills the band; snapshot (exact)', async () => {
    const tg = target('PT-P910BT', 36)
    const qr = code({ symbology: 'qr', data: 'https://fjanicki.github.io/ptouch/', ecc: 'M', quietZone: 'standard', moduleDots: 'auto' })
    const r = await renderLabel(label([qr], { marginsMm: { start: 2, end: 2 } }), tg)
    try {
      expect(r.warnings).toEqual([])
      const box = r.boxes.find((b) => b.itemId === qr.id)!
      // Version 3 (29 modules) + 4 + 4 quiet modules; the unprinted edge (29 dots each side)
      // counts as quiet zone across the tape: floor((454 + 58) / 37) = 13 dots per module.
      expect(box.w).toBe((29 + 8) * 13)
      expect(dotsToMm(13, 360)).toBeGreaterThan(0.9)
      await expectBitmapSnapshot(r.bitmap, 'm360-qr-auto-36mm')
    } finally {
      release(r.bitmap)
    }
  })

  it('a linear auto barcode keeps its physical module size (4 dots = 0.28 mm, no warning)', async () => {
    const bar = code({ symbology: 'code128', data: 'ABC-12345', moduleDots: 'auto', showText: false })
    const hi = await renderLabel(label([bar]), target('PT-P910BT', 36))
    const lo = await renderLabel(label([{ ...bar, id: 'lo' }], { tape: { widthMm: 24 } }), target('PT-P710BT', 24))
    try {
      expect(hi.warnings).toEqual([])
      expect(lo.warnings).toEqual([])
      const wHi = hi.boxes.find((b) => b.itemId === bar.id)!.w
      const wLo = lo.boxes.find((b) => b.itemId === 'lo')!.w
      expect(wHi).toBe(2 * wLo)
    } finally {
      release(hi.bitmap)
      release(lo.bitmap)
    }
  })

  it('ruler: a tick every mm lands on mmToDots(mm, 360); snapshot (exact)', async () => {
    const tg = target('PT-P910BT', 36)
    const band = dotsToMm(tg.area.heightDots, 360)
    const lengthMm = 40
    const ticks: ShapeItem[] = []
    for (let mm = 0; mm < lengthMm; mm++) {
      const h = band * (mm % 10 === 0 ? 1 : mm % 5 === 0 ? 0.5 : 0.25)
      ticks.push({ ...createItem('shape'), shape: 'rect', widthMm: 0.25, size: { mode: 'mm', mm: h }, strokeMm: 0.25, fill: true, frame: { xMm: mm, yMm: 0, wMm: 0.25, hMm: h, rotation: 0 } })
    }
    const doc = label(ticks, { length: { mode: 'fixed', mm: lengthMm }, marginsMm: { start: 0, end: 0 }, layout: { mode: 'free' } })
    const r = await renderLabel(doc, tg)
    try {
      expect(r.lengthDots).toBe(mmToDots(lengthMm, 360))
      // The top row carries every tick (all start at y = 0): one run per mm, starting on its dot.
      const xs = inkColumns(r.bitmap, 0)
      const starts = xs.filter((x, i) => i === 0 || xs[i - 1] !== x - 1)
      expect(starts).toEqual(Array.from({ length: lengthMm }, (_, mm) => mmToDots(mm, 360)))
      await expectBitmapSnapshot(r.bitmap, 'm360-ruler-36mm')
    } finally {
      release(r.bitmap)
    }
  })

  it('PNG export carries 360 dpi (pHYs 14173 px/m)', async () => {
    const r = await renderLabel(label([text('PNG', { size: { mode: 'mm', mm: 8 } })]), target('PT-P910BT', 36))
    try {
      const png = new Uint8Array(await (await exportPng(r.bitmap, { dpi: 360 })).arrayBuffer())
      const at = png.findIndex((_, i) => png[i] === 0x70 && png[i + 1] === 0x48 && png[i + 2] === 0x59 && png[i + 3] === 0x73) // "pHYs"
      expect(at).toBeGreaterThan(0)
      const v = new DataView(png.buffer, at + 4, 9)
      expect(v.getUint32(0)).toBe(14173)
      expect(v.getUint32(4)).toBe(14173)
      expect(v.getUint8(8)).toBe(1) // metre
      expect(pixelsPerMetre(360)).toBe(14173)
      // Width and height are the bitmap's dots (IHDR at offset 16).
      const ihdr = new DataView(png.buffer, 16, 8)
      expect(ihdr.getUint32(4)).toBe(454)
    } finally {
      release(r.bitmap)
    }
  })
})

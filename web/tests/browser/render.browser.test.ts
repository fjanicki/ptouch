// W3 — renderer + wasm raster tests in Chromium (Vitest browser project): bundled fonts, text
// auto-fit, codes painted by the core, image dithering, frame, warnings, and bitmap snapshots
// (tests/browser/__snapshots__/*.pbm). The anti-fingerprinting probe is false in a clean browser.
import { beforeAll, describe, expect, it } from 'vitest'
import { encodeCode, loadWasm, printArea, mediaForWidth, version, type Bitmap1, type MediaInfo, type ModuleMatrix, type PrintArea } from '../../src/wasm'
import { createDoc, createItem, DEFAULT_PRINT, type CodeItem, type IconItem, type ImageItem, type Item, type LabelDoc, type ShapeItem, type TextItem } from '../../src/doc/schema'
import { buildPrintJob, canvasReadbackIsNoisy, ensureFonts, FONTS, mmToDots, paintPreview, renderLabel, thumbnailPng, type RenderResult, type RenderTarget } from '../../src/render'
import { preloadAllFonts } from '../../src/render/fonts'
import { expectBitmapSnapshot } from './snapshot'

const TEXT_TOLERANCE = 0.03

function target(widthMm: number): RenderTarget {
  const media: MediaInfo = mediaForWidth('PT-P710BT', widthMm)
  const area: PrintArea = printArea('PT-P710BT', media.id)
  return { model: 'PT-P710BT', media, area }
}

const text = (t: string, patch: Partial<TextItem> = {}): TextItem => ({ ...createItem('text'), text: t, ...patch })
const code = (patch: Partial<CodeItem>): CodeItem => ({ ...createItem('code'), ...patch })
const label = (items: Item[], patch: Partial<LabelDoc> = {}): LabelDoc => createDoc({ items, ...patch })

/** Rows/columns that contain ink: [minX, minY, maxX, maxY] or undefined when blank. */
function inkBox(b: Bitmap1): [number, number, number, number] | undefined {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  for (let x = 0; x < b.length; x++) {
    for (let y = 0; y < b.height; y++) {
      if (b.get(x, y)) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
    }
  }
  return x1 < 0 ? undefined : [x0, y0, x1, y1]
}

function inkCount(b: Bitmap1, x0 = 0, y0 = 0, x1 = b.length, y1 = b.height): number {
  let n = 0
  for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) if (b.get(x, y)) n++
  return n
}

/** Every module of `m` is painted exactly at (`x`, `y`) with `md` dots per module. */
function expectModules(b: Bitmap1, m: ModuleMatrix, x: number, y: number, md: number): void {
  let bad = 0
  for (let my = 0; my < m.height; my++) {
    for (let mx = 0; mx < m.width; mx++) {
      const dark = m.modules[my * m.width + mx] === 1
      for (let dy = 0; dy < md; dy++) for (let dx = 0; dx < md; dx++) if (b.get(x + mx * md + dx, y + my * md + dy) !== dark) bad++
    }
  }
  expect(bad).toBe(0)
}

async function render(doc: LabelDoc, widthMm = 24, loadBlob?: (ref: string) => Promise<Blob | undefined>): Promise<RenderResult> {
  return renderLabel(doc, target(widthMm), loadBlob ? { loadBlob } : {})
}

beforeAll(async () => {
  await loadWasm()
})

describe('environment', () => {
  it('loads wasm via fetch()', () => {
    expect(version()).toMatch(/^\d+\./)
  })

  it('canvas readback is clean (no anti-fingerprinting noise)', () => {
    expect(canvasReadbackIsNoisy()).toBe(false)
  })

  it('loads every bundled face from public/fonts', async () => {
    const r = await preloadAllFonts()
    expect(r.fallbacks).toEqual([])
    for (const f of FONTS) for (const w of f.weights) expect(document.fonts.check(`${w} 12px "${f.family}"`), `${f.family} ${w}`).toBe(true)
  })
})

describe('text', () => {
  it('renders "Hello" on 24 mm, auto-fit to the band (snapshot)', async () => {
    const doc = label([text('Hello', { fontFamily: 'fira-sans', fontWeight: 600 })])
    expect((await ensureFonts(doc)).fallbacks).toEqual([])
    const r = await render(doc)
    try {
      expect(r.bitmap.height).toBe(r.heightDots)
      expect(r.heightDots).toBe(128)
      expect(r.warnings).toEqual([])
      expect(r.blocking).toBe(false)
      // No descenders: the ink fills the band (fit uses the ink extent).
      const box = inkBox(r.bitmap)
      expect(box).toBeDefined()
      const [x0, y0, x1, y1] = box as [number, number, number, number]
      expect(y0).toBeLessThanOrEqual(2)
      expect(y1).toBeGreaterThanOrEqual(125)
      // Margins: 2 mm (14 dots) both ends, auto length.
      expect(x0).toBeGreaterThanOrEqual(13)
      expect(x0).toBeLessThanOrEqual(18)
      expect(r.lengthDots - 1 - x1).toBeGreaterThanOrEqual(13)
      expect(r.lengthDots - 1 - x1).toBeLessThanOrEqual(18)
      expect(r.boxes).toHaveLength(1)
      await expectBitmapSnapshot(r.bitmap, 'text-hello-24mm', TEXT_TOLERANCE)
    } finally {
      r.bitmap.free()
    }
  })

  it('every bundled family renders, differently, without fallback', async () => {
    const seen = new Set<string>()
    for (const f of FONTS) {
      const r = await render(label([text('Label 123', { fontFamily: f.id, fontWeight: 400 })]))
      try {
        expect(r.warnings.filter((w) => w.code === 'font-fallback'), f.id).toEqual([])
        expect(r.bitmap.isBlank()).toBe(false)
        seen.add(`${r.lengthDots}:${inkCount(r.bitmap)}`)
      } finally {
        r.bitmap.free()
      }
    }
    expect(seen.size).toBe(FONTS.length)
  })

  it('Archivo Narrow is narrower than Fira Sans; bold has more ink than regular', async () => {
    const len = async (it: TextItem) => {
      const r = await render(label([it]))
      const out = { len: r.lengthDots, ink: inkCount(r.bitmap) }
      r.bitmap.free()
      return out
    }
    const fira = await len(text('Storage', { fontFamily: 'fira-sans', fontWeight: 400 }))
    const narrow = await len(text('Storage', { fontFamily: 'archivo-narrow', fontWeight: 400 }))
    const bold = await len(text('Storage', { fontFamily: 'fira-sans', fontWeight: 800 }))
    expect(narrow.len).toBeLessThan(fira.len)
    expect(bold.ink).toBeGreaterThan(fira.ink * 1.2)
  })

  it('size in mm: cap-to-descender height of the block', async () => {
    const r = await render(label([text('Hxg', { size: { mode: 'mm', mm: 8 } })]))
    const [, y0, , y1] = inkBox(r.bitmap) ?? [0, 0, 0, 0]
    r.bitmap.free()
    // 8 mm = 56.7 dots from cap top to descender bottom (± a dot of ink overshoot each side).
    expect(y1 - y0 + 1).toBeGreaterThanOrEqual(55)
    expect(y1 - y0 + 1).toBeLessThanOrEqual(60)
  })

  it('multiline auto-fit keeps every line inside the band and aligns lines', async () => {
    const doc = label([text('Left\nX', { align: 'start', lineHeight: 1.1 })])
    const r = await render(doc)
    try {
      const [x0, y0, , y1] = inkBox(r.bitmap) ?? [0, 0, 0, 0]
      expect(y0).toBeGreaterThanOrEqual(0)
      expect(y1).toBeLessThanOrEqual(127)
      // Bottom line "X" starts at the block's left edge (start alignment).
      let xLeftBottom = Infinity
      for (let x = 0; x < r.bitmap.length && xLeftBottom === Infinity; x++) for (let y = 100; y < 128; y++) if (r.bitmap.get(x, y)) xLeftBottom = x
      expect(Math.abs(xLeftBottom - x0)).toBeLessThanOrEqual(3)
      await expectBitmapSnapshot(r.bitmap, 'text-multiline-24mm', TEXT_TOLERANCE)
    } finally {
      r.bitmap.free()
    }
  })

  it('invert draws white text on a black block that fills the band', async () => {
    const r = await render(label([text('INV', { invert: true })]))
    try {
      const box = r.boxes[0]
      expect(box).toBeDefined()
      const b = box as NonNullable<typeof box>
      expect(b.h).toBe(128)
      // Block corners are ink, the centre column has white (text counters / gaps).
      expect(r.bitmap.get(b.x + 1, 1)).toBe(true)
      expect(r.bitmap.get(b.x + b.w - 2, 126)).toBe(true)
      const inside = inkCount(r.bitmap, b.x, 0, b.x + b.w, 128)
      expect(inside).toBeGreaterThan(b.w * 128 * 0.4)
      expect(inside).toBeLessThan(b.w * 128)
    } finally {
      r.bitmap.free()
    }
  })

  it('auto-fit on 12 mm and 6 mm tape; small text is flagged', async () => {
    const r12 = await render(label([text('Label')]), 12)
    expect(r12.heightDots).toBe(70)
    expect(r12.bitmap.height).toBe(70)
    expect(r12.warnings).toEqual([])
    r12.bitmap.free()
    const r6 = await render(label([text('one\ntwo\nthree\nfour')]), 6)
    expect(r6.bitmap.height).toBe(32)
    expect(r6.warnings.map((w) => w.code)).toContain('small-text')
    expect(r6.blocking).toBe(false)
    r6.bitmap.free()
  })

  it('boldness (threshold) adds or removes ink', async () => {
    const doc = (threshold: number) => label([text('Ink')], { print: { ...DEFAULT_PRINT, threshold } })
    const light = await render(doc(200))
    const bold = await render(doc(40))
    expect(inkCount(bold.bitmap)).toBeGreaterThan(inkCount(light.bitmap))
    light.bitmap.free()
    bold.bitmap.free()
  })
})

describe('layout', () => {
  it('fixed length: content centred; too short → overflow warning', async () => {
    const ok = await render(label([text('A')], { length: { mode: 'fixed', mm: 60 } }))
    expect(ok.lengthDots).toBe(425)
    expect(ok.lengthMm).toBeCloseTo(59.97, 1)
    const [x0, , x1] = inkBox(ok.bitmap) ?? [0, 0, 0]
    expect(Math.abs(x0 - (424 - x1))).toBeLessThanOrEqual(3)
    ok.bitmap.free()
    const over = await render(label([text('A very long label text')], { length: { mode: 'fixed', mm: 20 } }))
    expect(over.warnings.map((w) => w.code)).toContain('content-overflow')
    expect(over.overflow).toBe(true)
    over.bitmap.free()
  })

  it('an empty label blocks printing', async () => {
    for (const doc of [label([]), label([text('   ')]), label([{ ...createItem('spacer'), widthMm: 10 }])]) {
      const r = await render(doc)
      expect(r.blocking).toBe(true)
      expect(r.warnings[0]?.code).toBe('empty')
      r.bitmap.free()
    }
  })

  it('icons fill the band; shapes; a label frame', async () => {
    const icon: IconItem = { ...createItem('icon'), iconId: 'warning' }
    const rect: ShapeItem = { ...createItem('shape'), shape: 'rect', widthMm: 8, strokeMm: 0.6 }
    const doc = label([icon, rect, text('FRAME')], { frame: { thicknessMm: 0.5, radiusMm: 1.5, insetMm: 0 } })
    const r = await render(doc)
    try {
      expect(r.warnings).toEqual([])
      // Frame: top and bottom rows inked along the straight part of the border.
      const mid = Math.floor(r.lengthDots / 2)
      expect(r.bitmap.get(mid, 0)).toBe(true)
      expect(r.bitmap.get(mid, 127)).toBe(true)
      expect(r.bitmap.get(0, 64)).toBe(true)
      expect(r.bitmap.get(r.lengthDots - 1, 64)).toBe(true)
      // Items sit inside the frame.
      for (const b of r.boxes) {
        expect(b.y).toBeGreaterThan(3)
        expect(b.y + b.h).toBeLessThan(125)
      }
      expect(r.boxes).toHaveLength(3)
      await expectBitmapSnapshot(r.bitmap, 'icon-shape-frame-24mm', TEXT_TOLERANCE)
    } finally {
      r.bitmap.free()
    }
  })

  it('free layout places items at their frames; 90° turns codes and text', async () => {
    const qrItem = code({ symbology: 'qr', data: 'free', moduleDots: 3, quietZone: false, frame: { xMm: 30, yMm: 0, wMm: 18, hMm: 18, rotation: 90 } })
    const txt = text('UP', { frame: { xMm: 2, yMm: 0, wMm: 20, hMm: 18, rotation: 90 } })
    const r = await render(label([txt, qrItem], { layout: { mode: 'free' } }))
    try {
      expect(r.warnings).toEqual([])
      const m = encodeCode({ symbology: 'qr', data: 'free', ecc: 'M' })
      const qb = r.boxes[1] as NonNullable<(typeof r.boxes)[1]>
      expect(qb.w).toBe(m.width * 3)
      // Module (0,0) of the upright matrix lands top-right after a clockwise turn.
      const turned = { width: m.height, height: m.width, modules: Array.from({ length: m.width * m.height }, (_, i) => m.modules[(m.height - 1 - (i % m.height)) * m.width + Math.floor(i / m.height)] ?? 0) }
      expectModules(r.bitmap, turned, qb.x, qb.y, 3)
      // Rotated text is taller than wide.
      const tb = r.boxes[0] as NonNullable<(typeof r.boxes)[0]>
      expect(tb.h).toBeGreaterThan(tb.w)
      // Auto length in free layout = right-most frame edge + end margin.
      expect(r.lengthDots).toBe(mmToDots(30) + mmToDots(18) + mmToDots(2))
      expect(qb.x).toBe(mmToDots(30) + Math.floor((mmToDots(18) - m.width * 3) / 2))
    } finally {
      r.bitmap.free()
    }
  })

  it('italic text is slanted, not clipped', async () => {
    const upright = await render(label([text('Hill', { italic: false })]))
    const italic = await render(label([text('Hill', { italic: true })]))
    const a = inkBox(upright.bitmap) ?? [0, 0, 0, 0]
    const b = inkBox(italic.bitmap) ?? [0, 0, 0, 0]
    expect(inkCount(italic.bitmap)).toBeGreaterThan(inkCount(upright.bitmap) * 0.9)
    expect(b[2] - b[0]).toBeGreaterThan(a[2] - a[0])
    // Ink stays inside the label with the 2 mm margins (± slant).
    expect(b[0]).toBeGreaterThanOrEqual(8)
    expect(italic.lengthDots - 1 - b[2]).toBeGreaterThanOrEqual(8)
    upright.bitmap.free()
    italic.bitmap.free()
  })

  it('long labels are drawn in tiles without seams', async () => {
    const long = 'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM'
    const r = await render(label([text(long)]))
    try {
      expect(r.lengthDots).toBeGreaterThan(2730 * 1.2)
      // An "M" row is continuous ink along its top serif-less stroke region: check every
      // column of the content has ink (no blank column at a tile seam).
      const [x0, , x1] = inkBox(r.bitmap) ?? [0, 0, 0]
      let blankCols = 0
      for (let x = x0; x <= x1; x++) {
        let any = false
        for (let y = 0; y < 128 && !any; y++) any = r.bitmap.get(x, y)
        if (!any) blankCols++
      }
      // Gaps between letters exist; a seam would add one at x = 2730 (and 5460).
      const colInk = (x: number) => Array.from({ length: 128 }, (_, y) => r.bitmap.get(x, y)).some(Boolean)
      expect(colInk(2730) || colInk(2729) || colInk(2731)).toBe(true)
      expect(blankCols).toBeLessThan((x1 - x0) * 0.3)
    } finally {
      r.bitmap.free()
    }
  })
})

describe('codes (painted by the core)', () => {
  it('QR on 24 mm: every module exactly, with a clear quiet zone (snapshot)', async () => {
    const item = code({ symbology: 'qr', data: 'https://example.com', ecc: 'M', moduleDots: 4, quietZone: true })
    const r = await render(label([item]))
    try {
      expect(r.warnings).toEqual([])
      const m = encodeCode({ symbology: 'qr', data: 'https://example.com', ecc: 'M' })
      const box = r.boxes[0] as NonNullable<(typeof r.boxes)[0]>
      expect(box.w).toBe((m.width + 8) * 4)
      const sx = box.x + 16
      const sy = Math.floor((128 - m.height * 4) / 2)
      expectModules(r.bitmap, m, sx, sy, 4)
      // Quiet zone left/right of the symbol is blank.
      expect(inkCount(r.bitmap, box.x, 0, sx, 128)).toBe(0)
      expect(inkCount(r.bitmap, sx + m.width * 4, 0, box.x + box.w, 128)).toBe(0)
      await expectBitmapSnapshot(r.bitmap, 'qr-24mm')
    } finally {
      r.bitmap.free()
    }
  })

  it('QR too large for 12 mm is reduced to fit, with a warning', async () => {
    const r = await render(label([code({ symbology: 'qr', data: 'https://example.com', moduleDots: 4 })]), 12)
    expect(r.warnings.map((w) => w.code)).toContain('content-overflow')
    expect(r.blocking).toBe(false)
    const m = encodeCode({ symbology: 'qr', data: 'https://example.com', ecc: 'M' })
    expect(r.boxes[0]?.w).toBe((m.width + 8) * 2)
    r.bitmap.free()
  })

  it('a QR over a filled shape (free layout) gets its quiet zone cleared by the core', async () => {
    const shape: ShapeItem = { ...(createItem('shape') as ShapeItem), shape: 'rect', fill: true, widthMm: 40, frame: { xMm: 0, yMm: 0, wMm: 40, hMm: 18, rotation: 0 } }
    const qr = code({ symbology: 'qr', data: 'hello', moduleDots: 3, quietZone: true, frame: { xMm: 10, yMm: 0, wMm: 18, hMm: 18, rotation: 0 } })
    const r = await render(label([shape, qr], { layout: { mode: 'free' } }))
    try {
      const m = encodeCode({ symbology: 'qr', data: 'hello', ecc: 'M' })
      const qb = r.boxes[1] as NonNullable<(typeof r.boxes)[1]>
      const sx = qb.x + 12 // symbol origin: box starts with the 4-module (12-dot) quiet zone
      const sy = qb.y + Math.floor((qb.h - m.height * 3) / 2)
      expectModules(r.bitmap, m, sx, sy, 3)
      // The 12-dot strip left of the symbol is white although the shape is under it.
      expect(inkCount(r.bitmap, sx - 12, sy, sx, sy + m.height * 3)).toBe(0)
      expect(inkCount(r.bitmap, 0, sy, 10, sy + m.height * 3)).toBeGreaterThan(0) // the shape elsewhere
    } finally {
      r.bitmap.free()
    }
  })

  it('a QR filling the band keeps 4 modules of quiet zone across the tape (band + margin)', async () => {
    for (const w of [24, 18, 12]) {
      const t = target(w)
      const r = await render(label([code({ symbology: 'qr', data: 'HELLO', moduleDots: 12, quietZone: true })]), w)
      try {
        const m = encodeCode({ symbology: 'qr', data: 'HELLO', ecc: 'M' })
        const md = (r.boxes[0]?.w ?? 0) / (m.width + 8)
        const ink = inkBox(r.bitmap) ?? [0, 0, 0, 0]
        const margin = Math.floor((t.area.tapeWidthDots - t.area.heightDots) / 2)
        expect(ink[1] + margin, `${w} mm top`).toBeGreaterThanOrEqual(4 * md)
        expect(r.bitmap.height - 1 - ink[3] + margin, `${w} mm bottom`).toBeGreaterThanOrEqual(4 * md)
      } finally {
        r.bitmap.free()
      }
    }
  })

  it('a linear code in a short free-layout frame shrinks to fit it (or warns), never spills', async () => {
    const bar = code({ symbology: 'code128', data: 'ROT128', moduleDots: 2, quietZone: true, showText: false, frame: { xMm: 2, yMm: 0, wMm: 12, hMm: 18, rotation: 0 } })
    const r = await render(label([bar, text('next', { frame: { xMm: 15, yMm: 0, wMm: 20, hMm: 18, rotation: 0 } })], { layout: { mode: 'free' } }))
    try {
      expect(r.warnings.map((w) => w.code)).toContain('code-too-small') // 101 modules can't fit 85 dots
      expect(r.blocking).toBe(true)
    } finally {
      r.bitmap.free()
    }
    const fits = code({ symbology: 'code128', data: 'ROT128', moduleDots: 3, quietZone: true, showText: false, frame: { xMm: 2, yMm: 0, wMm: 40, hMm: 18, rotation: 90 } })
    const r2 = await render(label([fits], { layout: { mode: 'free' } }))
    try {
      expect(r2.warnings.map((w) => w.code)).toContain('content-overflow') // reduced to fit the frame
      const ink = inkBox(r2.bitmap) ?? [0, 0, 0, 0]
      expect(ink[3] - ink[1]).toBeLessThan(mmToDots(18)) // inside the frame, not cut at the band
    } finally {
      r2.bitmap.free()
    }
  })

  it('6 mm tape: the barcode text that does not fit is reported, not silently dropped', async () => {
    const r = await render(label([code({ symbology: 'code128', data: 'A1', moduleDots: 2, showText: true })]), 6)
    expect(r.warnings.find((w) => w.code === 'content-overflow')?.message).toMatch(/text under the bars/)
    r.bitmap.free()
  })

  it('EAN-13: bars span the band at whole-dot modules (snapshot)', async () => {
    const r = await render(label([code({ symbology: 'ean13', data: '590123412345', moduleDots: 2, quietZone: true, showText: false })]))
    try {
      expect(r.warnings).toEqual([])
      const m = encodeCode({ symbology: 'ean13', data: '590123412345' })
      const box = r.boxes[0] as NonNullable<(typeof r.boxes)[0]>
      expect(box.w).toBe((m.width + 20) * 2)
      for (const y of [0, 64, 127]) {
        for (let mx = 0; mx < m.width; mx++) {
          const dark = m.modules[mx] === 1
          expect(r.bitmap.get(box.x + 20 + mx * 2, y), `module ${mx} row ${y}`).toBe(dark)
          expect(r.bitmap.get(box.x + 21 + mx * 2, y)).toBe(dark)
        }
      }
      await expectBitmapSnapshot(r.bitmap, 'ean13-24mm')
    } finally {
      r.bitmap.free()
    }
  })

  it('EAN-13 with human-readable digits under the bars', async () => {
    const r = await render(label([code({ symbology: 'ean13', data: '590123412345', moduleDots: 2, showText: true })]))
    try {
      expect(r.warnings).toEqual([])
      const box = r.boxes[0] as NonNullable<(typeof r.boxes)[0]>
      // Bars stop above the caption; the caption has ink in the bottom fifth.
      const bottom = inkCount(r.bitmap, box.x, 110, box.x + box.w, 128)
      expect(bottom).toBeGreaterThan(50)
      await expectBitmapSnapshot(r.bitmap, 'ean13-text-24mm', TEXT_TOLERANCE)
    } finally {
      r.bitmap.free()
    }
  })

  it('Code 128 renders; invalid data blocks printing with the core message', async () => {
    const ok = await render(label([code({ symbology: 'code128', data: 'PT-P710BT', moduleDots: 2 })]))
    expect(ok.warnings).toEqual([])
    expect(ok.bitmap.isBlank()).toBe(false)
    ok.bitmap.free()
    const bad = await render(label([code({ symbology: 'ean13', data: '12' })]))
    expect(bad.blocking).toBe(true)
    expect(bad.warnings[0]?.code).toBe('code-invalid')
    expect(bad.warnings[0]?.message).toMatch(/^EAN-13 barcode: /)
    bad.bitmap.free()
  })
})

describe('images (dithered by the core)', () => {
  async function gradientPng(w: number, h: number): Promise<Blob> {
    const c = new OffscreenCanvas(w, h)
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
    const img = ctx.createImageData(w, h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = Math.round((x / (w - 1)) * 255)
        img.data.set([v, v, v, 255], (y * w + x) * 4)
      }
    }
    ctx.putImageData(img, 0, 0)
    return c.convertToBlob({ type: 'image/png' })
  }

  it('Floyd–Steinberg gradient: density falls from black to white (snapshot)', async () => {
    const blob = await gradientPng(256, 128)
    const item: ImageItem = { ...createItem('image'), blobRef: 'grad', dither: 'floyd-steinberg' }
    const r = await render(label([item], { marginsMm: { start: 0, end: 0 } }), 24, async (ref) => (ref === 'grad' ? blob : undefined))
    try {
      expect(r.warnings).toEqual([])
      expect(r.boxes[0]).toMatchObject({ w: 256, h: 128 })
      const x = r.boxes[0]?.x ?? 0
      const dark = inkCount(r.bitmap, x, 0, x + 32, 128) / (32 * 128)
      const mid = inkCount(r.bitmap, x + 112, 0, x + 144, 128) / (32 * 128)
      const light = inkCount(r.bitmap, x + 224, 0, x + 256, 128) / (32 * 128)
      expect(dark).toBeGreaterThan(0.8)
      expect(mid).toBeGreaterThan(0.35)
      expect(mid).toBeLessThan(0.65)
      expect(light).toBeLessThan(0.2)
      await expectBitmapSnapshot(r.bitmap, 'image-fs-24mm')
    } finally {
      r.bitmap.free()
    }
  })

  it('threshold + invert; missing image warns without blocking', async () => {
    const blob = await gradientPng(64, 128)
    const item: ImageItem = { ...createItem('image'), blobRef: 'g', dither: 'threshold', adjust: { brightness: 0, contrast: 0, gammaX100: 100, invert: true, level: 128 } }
    const r = await render(label([item], { marginsMm: { start: 0, end: 0 } }), 24, async () => blob)
    const x = r.boxes[0]?.x ?? 0
    // Inverted: the white (right) half is now ink, the black (left) half paper.
    expect(inkCount(r.bitmap, x, 0, x + 16, 128)).toBe(0)
    expect(inkCount(r.bitmap, x + 48, 0, x + 64, 128)).toBe(16 * 128)
    r.bitmap.free()
    const missing = await render(label([{ ...createItem('image'), blobRef: 'gone' }, text('x')]), 24, async () => undefined)
    expect(missing.warnings.map((w) => w.code)).toEqual(['image-missing'])
    expect(missing.blocking).toBe(false)
    missing.bitmap.free()
  })
})

describe('outputs', () => {
  it('preview, thumbnail and print job come from the same bitmap', async () => {
    const doc = label([text('Job')], { print: { ...DEFAULT_PRINT, copies: 3 } })
    const t = target(24)
    const r = await renderLabel(doc, t)
    try {
      const canvas = document.createElement('canvas')
      paintPreview(canvas, r.bitmap, { tape: '#ffffff', ink: '#000000' })
      expect([canvas.width, canvas.height]).toEqual([r.lengthDots, 128])
      const px = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
      let darkPx = 0
      for (let i = 0; i < (px?.length ?? 0); i += 4) if (px?.[i] === 0) darkPx++
      expect(darkPx).toBe(inkCount(r.bitmap))

      const png = await thumbnailPng(r.bitmap, { tape: '#fff', ink: '#000' }, 120)
      expect(png?.type).toBe('image/png')
      const bmp = await createImageBitmap(png as Blob)
      expect(bmp.width).toBeLessThanOrEqual(120)

      const job = buildPrintJob(doc, r, t)
      expect(job.pageCount).toBe(3)
      const bytes = job.toBytes()
      expect(bytes[bytes.length - 1]).toBe(0x1a)
      job.free()
      // The preview bitmap is still alive after encoding.
      expect(r.bitmap.length).toBe(r.lengthDots)
    } finally {
      r.bitmap.free()
    }
  })
})

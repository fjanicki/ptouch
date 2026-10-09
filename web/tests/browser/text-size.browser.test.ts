// P-size (docs/FONTS-AND-SIZE-PLAN.md §3.3) — text sizing in Chromium with the real fonts: point
// sizes across fonts, `RenderResult.texts`, fixed sizes reduced to the band, "shrink to fit
// length", pixel-grid snapping, the `font-quality` warning, and the quick-size length estimate
// agreeing with the renderer. Existing snapshots (render.browser.test.ts) stay byte-identical.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadWasm, mediaForWidth, printArea, type Bitmap1 } from '../../src/wasm'
import { createDoc, createItem, type CodeItem, type Item, type LabelDoc, type TextItem, type TextSize } from '../../src/doc/schema'
import { FONTS, findFont, fontDef, itemSizingBand, renderLabel, type FontDef, type RenderResult, type RenderTarget } from '../../src/render'
import { loadFamily, preloadAllFonts } from '../../src/render/fonts'
import { defaultSizeOf, measureTextAt, quickTextSizes } from '../../src/render/text-size'
import { expectBitmapSnapshot, toPbm } from './snapshot'

function target(widthMm: number): RenderTarget {
  const media = mediaForWidth('PT-P710BT', widthMm)
  return { model: 'PT-P710BT', media, area: printArea('PT-P710BT', media.id) }
}
const text = (t: string, patch: Partial<TextItem> = {}): TextItem => ({ ...createItem('text'), text: t, ...patch })
const label = (items: Item[], patch: Partial<LabelDoc> = {}): LabelDoc => createDoc({ items, ...patch })

async function render(doc: LabelDoc, widthMm = doc.tape.widthMm): Promise<RenderResult> {
  return renderLabel(doc, target(widthMm))
}

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

/** Every maximal run of ink along rows and columns is a whole number of `k`-dot font pixels,
 * and starts on the same `k` grid. Returns the number of runs that break the rule. */
function offGridRuns(b: Bitmap1, k: number, ox: number, oy: number): number {
  let bad = 0
  const check = (start: number, len: number, origin: number) => {
    if (len % k !== 0 || (((start - origin) % k) + k) % k !== 0) bad++
  }
  for (let y = 0; y < b.height; y++) {
    let start = -1
    for (let x = 0; x <= b.length; x++) {
      const ink = x < b.length && b.get(x, y)
      if (ink && start < 0) start = x
      if (!ink && start >= 0) {
        check(start, x - start, ox)
        start = -1
      }
    }
  }
  for (let x = 0; x < b.length; x++) {
    let start = -1
    for (let y = 0; y <= b.height; y++) {
      const ink = y < b.height && b.get(x, y)
      if (ink && start < 0) start = y
      if (!ink && start >= 0) {
        check(start, y - start, oy)
        start = -1
      }
    }
  }
  return bad
}

/** Temporarily gives a registry entry extra flags (P-lib fills the real ones). */
const patched: { def: FontDef; keys: (keyof FontDef)[] }[] = []
function patchFont(id: FontDef['id'], patch: Partial<FontDef>): void {
  const def = fontDef(id)
  Object.assign(def, patch)
  patched.push({ def, keys: Object.keys(patch) as (keyof FontDef)[] })
}
afterEach(() => {
  for (const p of patched.splice(0)) for (const k of p.keys) delete (p.def as unknown as Record<string, unknown>)[k]
})

beforeAll(async () => {
  await loadWasm()
  await preloadAllFonts()
})

describe('point sizes and render info', () => {
  it('the em is pt × 2.5 dots in every font; texts reports it with the cap height and length', async () => {
    for (const def of FONTS.filter((f) => f.core)) {
      for (const pt of [8, 12, 20]) {
        const item = text('HHH', { fontFamily: def.id, fontWeight: 400, size: { mode: 'pt', pt } })
        const r = await render(label([item], { tape: { widthMm: 24 } }))
        try {
          const info = r.texts?.[0]
          expect(info, def.id).toBeDefined()
          expect(info?.itemId).toBe(item.id)
          expect(info?.emDots, `${def.id} ${pt} pt`).toBeCloseTo(pt * 2.5, 6)
          expect(info?.widthDots).toBe(r.boxes[0]?.w)
          const [, y0, , y1] = inkBox(r.bitmap) ?? [0, 0, 0, 0]
          expect(Math.abs(y1 - y0 + 1 - (info?.capDots ?? 0)), `${def.id} ${pt} pt cap`).toBeLessThanOrEqual(1.5)
          expect(info?.shrink).toBeUndefined()
          expect(info?.pixelScale).toBeUndefined()
        } finally {
          r.bitmap.free()
        }
      }
    }
  })

  it('one entry per non-empty text block, in label order', async () => {
    const a = text('A')
    const b = text('  ')
    const c = text('C', { size: { mode: 'mm', mm: 4 } })
    const r = await render(label([a, { ...createItem('icon'), iconId: 'wifi' }, b, c], { tape: { widthMm: 12 } }))
    try {
      expect(r.texts?.map((t) => t.itemId)).toEqual([a.id, c.id])
    } finally {
      r.bitmap.free()
    }
  })

  it('the quick size estimate measures exactly what the renderer prints', async () => {
    const doc = label([text('Hello Wg', { fontFamily: 'archivo-narrow' })], { tape: { widthMm: 12 } })
    const t = target(12)
    const band = itemSizingBand(doc, doc.items[0] as TextItem, t.area).bandDots
    const sizes: TextSize[] = [...quickTextSizes(band, 180).map((q) => q.size), { mode: 'pt', pt: 9 }]
    for (const size of sizes) {
      const item = { ...(doc.items[0] as TextItem), size }
      const r = await render({ ...doc, items: [item] })
      try {
        expect(measureTextAt(item, size, band, 180).widthDots, JSON.stringify(size)).toBe(r.boxes[0]?.w)
        expect(measureTextAt(item, size, band, 180).emDots).toBeCloseTo(r.texts?.[0]?.emDots ?? 0, 6)
      } finally {
        r.bitmap.free()
      }
    }
  })

  it('12 mm tape: "Hello" at M prints in about 2 cm (not 4 cm as at Fit)', async () => {
    const m = quickTextSizes(70, 180).find((q) => q.id === 'm')!.size
    const half = await render(label([text('Hello', { size: m })], { tape: { widthMm: 12 } }))
    const fit = await render(label([text('Hello')], { tape: { widthMm: 12 } }))
    try {
      expect(half.lengthMm).toBeLessThanOrEqual(25)
      expect(fit.lengthMm).toBeGreaterThan(half.lengthMm * 1.6)
      expect(half.warnings).toEqual([])
    } finally {
      half.bitmap.free()
      fit.bitmap.free()
    }
  })
})

describe('fixed sizes taller than the band', () => {
  it('are reduced to the band with a warning, not cut off', async () => {
    const r = await render(label([text('Hxg', { size: { mode: 'mm', mm: 20 } })], { tape: { widthMm: 12 } }))
    try {
      const w = r.warnings.find((x) => x.code === 'content-overflow')
      expect(w?.message).toMatch(/was reduced/)
      expect(r.overflow ?? false).toBe(false)
      const [, y0, , y1] = inkBox(r.bitmap) ?? [0, 0, 0, 0]
      expect(y0).toBeGreaterThanOrEqual(0)
      expect(y1).toBeLessThanOrEqual(69)
      // Nearly the whole band: reduced, not shrunk to nothing.
      expect(y1 - y0 + 1).toBeGreaterThan(60)
    } finally {
      r.bitmap.free()
    }
  })

  it('a point size that fits is untouched', async () => {
    const r = await render(label([text('Hxg', { size: { mode: 'pt', pt: 20 } })], { tape: { widthMm: 12 } }))
    try {
      expect(r.warnings).toEqual([])
      expect(r.texts?.[0]?.emDots).toBe(50)
    } finally {
      r.bitmap.free()
    }
  })
})

describe('“Use for new text” measures the em', () => {
  it('an empty block still gives its own size (not the 4 pt minimum)', () => {
    const size: TextSize = { mode: 'mm', mm: 7 }
    const empty = measureTextAt(text(''), size, 70, 180)
    const hello = measureTextAt(text('Hello'), size, 70, 180)
    expect(empty.widthDots).toBe(0)
    expect(empty.emDots).toBeGreaterThan(0)
    expect(empty.emDots).toBeCloseTo(hello.emDots, 0)
    const pref = defaultSizeOf(size, 70, 180, empty.emDots)
    expect(pref).toEqual(defaultSizeOf(size, 70, 180, hello.emDots))
    expect(typeof pref === 'object' && pref.pt).toBeGreaterThan(10)
    // Blank lines count as empty too.
    expect(measureTextAt(text(' \n '), size, 70, 180).emDots).toBe(empty.emDots)
  })
})

describe('shrink to fit length', () => {
  const long = 'A very long label text'
  const fixed = (shrink: boolean, items: Item[]) => label(items, { tape: { widthMm: 12 }, length: { mode: 'fixed', mm: 30, ...(shrink ? { shrink: true } : {}) } })

  it('keeps a long text inside a fixed 30 mm label', async () => {
    const off = await render(fixed(false, [text(long)]))
    const on = await render(fixed(true, [text(long)]))
    try {
      expect(off.overflow).toBe(true)
      expect(off.warnings.find((w) => w.code === 'content-overflow')?.message).toMatch(/Shrink text to fit length/)
      expect(on.overflow ?? false).toBe(false)
      expect(on.warnings.map((w) => w.code)).not.toContain('content-overflow')
      expect(on.lengthDots).toBe(off.lengthDots)
      const info = on.texts?.[0]
      expect(info?.shrink).toBeGreaterThan(0.1)
      expect(info?.shrink).toBeLessThan(1)
      // Inside the margins (2 mm default ≈ 14 dots), and nearly filling them.
      const [x0, , x1] = inkBox(on.bitmap) ?? [0, 0, 0]
      expect(x0).toBeGreaterThanOrEqual(10)
      expect(x1).toBeLessThan(on.lengthDots - 10)
      expect(x1 - x0).toBeGreaterThan(on.lengthDots * 0.7)
    } finally {
      off.bitmap.free()
      on.bitmap.free()
    }
  })

  it('codes keep their size; text that fits is never enlarged', async () => {
    const qr: CodeItem = { ...createItem('code'), data: '0001', quietZone: 'compact' }
    const on = await render(fixed(true, [qr, text(long, { size: { mode: 'mm', mm: 4 } })]))
    const plain = await render(label([qr, text('x')], { tape: { widthMm: 12 } }))
    const short = await render(fixed(true, [text('Hi', { size: { mode: 'mm', mm: 4 } })]))
    const shortOff = await render(fixed(false, [text('Hi', { size: { mode: 'mm', mm: 4 } })]))
    try {
      expect(on.overflow ?? false).toBe(false)
      expect(on.boxes[0]?.w).toBe(plain.boxes[0]?.w)
      expect(on.texts?.[0]?.shrink).toBeLessThan(1)
      expect(short.texts?.[0]?.shrink).toBeUndefined()
      expect(toPbm(short.bitmap)).toBe(toPbm(shortOff.bitmap))
      expect(short.boxes.map(({ x, y, w, h }) => [x, y, w, h])).toEqual(shortOff.boxes.map(({ x, y, w, h }) => [x, y, w, h]))
    } finally {
      for (const r of [on, plain, short, shortOff]) r.bitmap.free()
    }
  })

  it('still reports an overflow when the other content alone is too long', async () => {
    const wide = { ...createItem('shape'), shape: 'rect' as const, widthMm: 40 }
    const r = await render(fixed(true, [wide, text(long)]))
    try {
      expect(r.overflow).toBe(true)
      expect(r.texts?.[0]?.shrink).toBeUndefined()
    } finally {
      r.bitmap.free()
    }
  })
})

describe('shrink to fit length with auto linear codes and extreme text', () => {
  const at = (mm: number, shrink: boolean, items: Item[]) => label(items, { tape: { widthMm: 12 }, length: { mode: 'fixed', mm, ...(shrink ? { shrink: true } : {}) } })
  const code128 = (): CodeItem => ({ ...createItem('code'), symbology: 'code128', data: 'ABC-12345', moduleDots: 'auto' })

  it('an auto-module barcode goes down to 1 dot so the text can shrink and fit (it no longer gives up)', async () => {
    for (const mm of [40, 50, 55]) {
      const items = (): Item[] => [text('Item label long text'), code128()]
      const off = await render(at(mm, false, items()))
      const on = await render(at(mm, true, items()))
      try {
        expect(off.overflow, `${mm} mm off`).toBe(true)
        expect(on.overflow ?? false, `${mm} mm`).toBe(false)
        expect(on.warnings.map((w) => w.code), `${mm} mm`).not.toContain('content-overflow')
        expect(on.texts?.[0]?.shrink, `${mm} mm`).toBeGreaterThan(0.1)
        expect(on.texts?.[0]?.shrink, `${mm} mm`).toBeLessThan(1)
        // Code 128 'ABC-12345' with its zones is 154 dots at 1 dot per module.
        expect(on.boxes[1]?.w, `${mm} mm`).toBe(154)
      } finally {
        off.bitmap.free()
        on.bitmap.free()
      }
    }
  })

  it('keeps the auto barcode at 2 dots while the text needs to shrink only a little', async () => {
    const r = await render(at(110, true, [text('Item label long text'), code128()]))
    try {
      expect(r.overflow ?? false).toBe(false)
      expect(r.boxes[1]?.w).toBeGreaterThanOrEqual(308)
      expect(r.texts?.[0]?.shrink ?? 1).toBeGreaterThanOrEqual(0.5)
    } finally {
      r.bitmap.free()
    }
  })

  it('far too much text shrinks to the smallest size and still reports the overflow (not left full size)', async () => {
    const r = await render(at(20, true, [text('x'.repeat(400))]))
    try {
      expect(r.texts?.[0]?.shrink).toBeCloseTo(0.1, 5)
      expect(r.overflow).toBe(true)
      expect(r.warnings.map((w) => w.code)).toContain('content-overflow')
    } finally {
      r.bitmap.free()
    }
  })
})

describe('pixel fonts', () => {
  it('the em snaps to whole dots per font pixel and glyphs sit on whole dots (registry flag)', async () => {
    // JetBrains Mono is not a pixel font: this checks the plumbing (snapping, texts.pixelScale).
    patchFont('jetbrains-mono', { pixel: { emPx: 10 } })
    const fit = await render(label([text('IDE', { fontFamily: 'jetbrains-mono' })], { tape: { widthMm: 12 } }))
    const pt = await render(label([text('IDE', { fontFamily: 'jetbrains-mono', size: { mode: 'pt', pt: 15 } })], { tape: { widthMm: 12 } }))
    const italic = await render(label([text('IDE', { fontFamily: 'jetbrains-mono', italic: true, size: { mode: 'pt', pt: 15 } })], { tape: { widthMm: 12 } }))
    try {
      const f = fit.texts?.[0]
      expect(f?.pixelScale).toBeGreaterThanOrEqual(1)
      expect(f?.emDots).toBe((f?.pixelScale ?? 0) * 10)
      // 15 pt = 37.5 dots → the nearest whole scale is 4 (em 40 dots).
      expect(pt.texts?.[0]?.pixelScale).toBe(4)
      expect(pt.texts?.[0]?.emDots).toBe(40)
      // Slanted glyphs leave the grid: no "crisp" badge.
      expect(italic.texts?.[0]?.pixelScale).toBeUndefined()
    } finally {
      for (const r of [fit, pt, italic]) r.bitmap.free()
    }
  })

  const pixelFonts = FONTS.filter((f) => f.pixel && !f.core)
  it.skipIf(!pixelFonts.length)('library pixel fonts print every font pixel as a k × k block of dots (exact snapshot)', async () => {
    for (const def of pixelFonts) {
      expect(await loadFamily(def.id, 400)).toBe(true)
      const emPx = def.pixel?.emPx ?? 0
      // 3 dots per font pixel on 12 mm tape, at the nearest point size.
      const doc = label([text('Pixel 123', { fontFamily: def.id, fontWeight: 400, size: { mode: 'pt', pt: (3 * emPx) / 2.5 } })], { tape: { widthMm: 12 } })
      const r = await render(doc)
      try {
        expect(r.texts?.[0]?.pixelScale, def.id).toBe(3)
        expect(r.texts?.[0]?.emDots).toBe(3 * emPx)
        const [x0, y0] = inkBox(r.bitmap) ?? [0, 0]
        expect(offGridRuns(r.bitmap, 3, x0, y0), `${def.id}: ink runs off the 3-dot grid`).toBe(0)
        if (def.id === findFont('silkscreen')?.id) await expectBitmapSnapshot(r.bitmap, `size-pixel-${def.id}-12mm`)
      } finally {
        r.bitmap.free()
      }
    }
  })
})

describe('font-quality', () => {
  it('a thin or script font warns below a 3 mm cap height, not above, and not for sturdy weights', async () => {
    patchFont('fira-sans', { quality: 'script' })
    const small = await render(label([text('Script', { size: { mode: 'pt', pt: 10 } })], { tape: { widthMm: 12 } }))
    const large = await render(label([text('Script', { size: { mode: 'pt', pt: 24 } })], { tape: { widthMm: 12 } }))
    try {
      const w = small.warnings.find((x) => x.code === 'font-quality')
      expect(w?.itemId).toBe(small.texts?.[0]?.itemId)
      expect(w?.message).toMatch(/Script letters of Fira Sans print poorly below 3 mm/)
      expect(w?.blocking).toBeFalsy()
      expect(large.warnings.map((x) => x.code)).not.toContain('font-quality')
    } finally {
      small.bitmap.free()
      large.bitmap.free()
    }
    patchFont('fira-sans', { quality: 'thin' })
    const thin = await render(label([text('Thin', { fontWeight: 400, size: { mode: 'pt', pt: 10 } })], { tape: { widthMm: 12 } }))
    const bold = await render(label([text('Thin', { fontWeight: 700, size: { mode: 'pt', pt: 10 } })], { tape: { widthMm: 12 } }))
    try {
      expect(thin.warnings.find((x) => x.code === 'font-quality')?.message).toMatch(/Thin strokes/)
      expect(bold.warnings.map((x) => x.code)).not.toContain('font-quality')
    } finally {
      thin.bitmap.free()
      bold.bitmap.free()
    }
  })
})

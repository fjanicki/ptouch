// P-lib — the font library in Chromium (docs/FONTS-AND-SIZE-PLAN.md §3.1): every library face is
// fetched only when asked for, loads through FontFace (the browser's font sanitiser accepts the
// subset files), renders a label differently from Fira Sans and from its other weights (the
// unmodified variable Quicksand gets its `wght` axis from the requested weight), and Silkscreen's
// outlines sit on its 8-per-em pixel grid: at k × 8 px per em every edge lands on a whole pixel.
import { beforeAll, describe, expect, it } from 'vitest'
import { loadWasm, mediaForWidth, printArea, type Bitmap1 } from '../../src/wasm'
import { createDoc, createItem, type FontFamilyId, type FontWeight, type LabelDoc, type TextItem } from '../../src/doc/schema'
import { renderLabel, type RenderTarget } from '../../src/render'
import { FONTS, ensureFonts, familyLoading, familyReady, findFont, loadFamily } from '../../src/render/fonts'

const library = FONTS.filter((f) => !f.core)

function target(widthMm: number): RenderTarget {
  const media = mediaForWidth('PT-P710BT', widthMm)
  return { model: 'PT-P710BT', media, area: printArea('PT-P710BT', media.id) }
}

const textItem = (fontFamily: FontFamilyId, fontWeight: FontWeight, text = 'Hamburg 0123'): TextItem => ({ ...createItem('text'), text, fontFamily, fontWeight, size: { mode: 'fit' } })
const doc = (...items: TextItem[]): LabelDoc => createDoc({ tape: { widthMm: 12 }, items })

/** Packed dots of a 12 mm render (freed right away). */
async function dots(d: LabelDoc): Promise<{ length: number; packed: Uint8Array; fontWarnings: string[] }> {
  const r = await renderLabel(d, target(12))
  try {
    return { length: r.bitmap.length, packed: r.bitmap.toPacked().slice(), fontWarnings: r.warnings.filter((w) => w.code.startsWith('font-f') || w.code === 'font-missing').map((w) => w.message) }
  } finally {
    r.bitmap.free()
  }
}

const same = (a: { length: number; packed: Uint8Array }, b: { length: number; packed: Uint8Array }): boolean => a.length === b.length && a.packed.every((v, i) => v === b.packed[i])

beforeAll(async () => {
  await loadWasm()
})

describe('font library', () => {
  it('nothing is fetched before a family is asked for', () => {
    const fetched = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\/fonts\/[^/]+\.woff2$/.test(n))
    for (const def of library) for (const file of Object.values(def.files)) expect(fetched.some((n) => n.endsWith(`/fonts/${file}`)), file as string).toBe(false)
    for (const def of library) expect(familyReady(def.id, def.weights[0]), def.id).toBe(false)
  })

  it('every library face loads through FontFace, on demand, one request per file', async () => {
    const def = findFont('oswald')
    expect(def).toBeDefined()
    const a = loadFamily('oswald', 700)
    const b = loadFamily('oswald', 650)
    expect(familyLoading('oswald', 700)).toBe(true)
    expect(await Promise.all([a, b])).toEqual([true, true])
    expect(familyLoading('oswald', 700)).toBe(false)
    expect(performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/fonts/Oswald-Bold.woff2'))).toHaveLength(1)
    expect(familyReady('oswald', 400)).toBe(false) // the other weight is its own file

    for (const d of library) {
      for (const w of d.weights) {
        expect(await loadFamily(d.id, w), `${d.label} ${w}`).toBe(true)
        expect(familyReady(d.id, w), `${d.label} ${w}`).toBe(true)
        expect(document.fonts.check(`${w} 12px "${d.family}"`), `${d.label} ${w}`).toBe(true)
      }
    }
  })

  it('ensureFonts loads a label’s library families with no fallback', async () => {
    const items = library.map((d) => textItem(d.id, d.weights[d.weights.length - 1] as FontWeight, d.preview))
    expect(await ensureFonts(doc(...items))).toEqual({ fallbacks: [] })
  })

  it('every family renders differently from Fira Sans, and each weight differently from the others', async () => {
    const fira = await dots(doc(textItem('fira-sans', 400)))
    for (const d of library) {
      const seen: { w: number; out: Awaited<ReturnType<typeof dots>> }[] = []
      for (const w of d.weights) {
        const out = await dots(doc(textItem(d.id, w)))
        expect(out.fontWarnings, `${d.label} ${w}`).toEqual([])
        expect(same(out, fira), `${d.label} ${w} looks like Fira Sans`).toBe(false)
        for (const s of seen) expect(same(out, s.out), `${d.label} ${w} looks like ${s.w}`).toBe(false)
        seen.push({ w, out })
      }
    }
  })

  it('Quicksand (one unmodified variable file) is heavier at 700 than at 500', async () => {
    const ink = (b: { packed: Uint8Array }): number => b.packed.reduce((n, v) => n + popcount(v), 0)
    const t = (w: FontWeight): TextItem => ({ ...textItem('quicksand', w, 'Spices'), size: { mode: 'mm', mm: 6 } })
    const medium = await dots(doc(t(500)))
    const bold = await dots(doc(t(700)))
    expect(ink(bold)).toBeGreaterThan(ink(medium) * 1.15)
  })
})

describe('pixel grid', () => {
  // Every printable ASCII glyph drawn large (16 canvas px per design pixel) at whole-cell origins.
  // If the outlines sit on the font's grid, the inside of every cell (a 3 px border left out, so
  // the OS rasteriser's anti-aliasing and stem darkening at the edges do not count) is either all
  // ink or all paper. An edge off the grid cuts through a cell. Counted per font and grid.
  const SAMPLE = Array.from({ length: 0x7f - 0x21 }, (_, i) => String.fromCharCode(0x21 + i)).join('')
  const CELL = 16
  const MARGIN = 3

  async function mixedCells(id: FontFamilyId, weight: FontWeight, emPx: number): Promise<{ mixed: number; ink: number }> {
    const def = findFont(id)
    expect(await loadFamily(id, weight)).toBe(true)
    const em = emPx * CELL
    const canvas = document.createElement('canvas')
    const ctx0 = canvas.getContext('2d') as CanvasRenderingContext2D
    ctx0.font = `${weight} ${em}px "${def?.family}"`
    // Each glyph starts on a whole cell: its advance rounded up to cells.
    const starts: number[] = []
    let x = CELL
    for (const ch of SAMPLE) {
      starts.push(x)
      x += Math.ceil(ctx0.measureText(ch).width / CELL + 1) * CELL
    }
    canvas.width = x + CELL
    canvas.height = 2 * em
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    ctx.font = `${weight} ${em}px "${def?.family}"`
    ctx.textBaseline = 'alphabetic'
    const baseline = Math.round((1.5 * em) / CELL) * CELL
    SAMPLE.split('').forEach((ch, i) => ctx.fillText(ch, starts[i] as number, baseline))
    const { data, width } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let mixed = 0
    let ink = 0
    for (let cy = 0; cy + CELL <= canvas.height; cy += CELL) {
      for (let cx = 0; cx + CELL <= canvas.width; cx += CELL) {
        let on = 0
        let off = 0
        for (let y = cy + MARGIN; y < cy + CELL - MARGIN; y++) for (let x2 = cx + MARGIN; x2 < cx + CELL - MARGIN; x2++) ((data[(y * width + x2) * 4 + 3] as number) >= 128 ? on++ : off++)
        if (on && off) mixed++
        if (on) ink++
      }
    }
    return { mixed, ink }
  }

  for (const weight of [400, 700] as const) {
    it(`Silkscreen ${weight}: every glyph edge is on its 8-per-em grid`, async () => {
      expect(findFont('silkscreen')?.pixel?.emPx).toBe(8)
      const r = await mixedCells('silkscreen', weight, 8)
      expect(r.ink).toBeGreaterThan(SAMPLE.length * 4)
      expect(r.mixed, `${r.mixed} of ${r.ink} inked cells are cut by an edge`).toBe(0)
    })
  }

  it('the measurement tells: VT323, Pixelify Sans and Fira Sans are not on a whole grid', async () => {
    for (const [id, emPx] of [['vt323', 25], ['pixelify-sans', 11], ['fira-sans', 8]] as const) {
      const r = await mixedCells(id, 400, emPx)
      expect(r.mixed / r.ink, id).toBeGreaterThan(0.1)
    }
  })

  it('every Silkscreen advance is a whole number of pixels at 8 px per em', async () => {
    await loadFamily('silkscreen', 400)
    const ctx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D
    ctx.font = `400 8px "ptouch Silkscreen"`
    // Within float noise: full Chromium on Linux reports 5.99992 for 6 (the renderer quantises).
    for (const ch of SAMPLE) {
      const w = ctx.measureText(ch).width
      expect(Math.abs(w - Math.round(w)), ch).toBeLessThan(1e-3)
    }
  })
})

function popcount(v: number): number {
  let n = 0
  for (let b = v; b; b &= b - 1) n++
  return n
}

export type { Bitmap1 }

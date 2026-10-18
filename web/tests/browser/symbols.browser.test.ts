// "Insert special character" (docs/TABLE-PLAN.md §12) — symbols from the menu rendered in Chromium
// with the bundled fonts: bitmap snapshots of a text block and a table that use several of them
// (each drawn by the face, JetBrains Mono or B612), no font fallback, and a glyph the face lacks
// is measured exactly as the fallback font's glyph through the renderer's CSS font stack, so it
// can never be a system font.
import { beforeAll, describe, expect, it } from 'vitest'
import { loadWasm, mediaForWidth, printArea, release } from '../../src/wasm'
import { ensureFonts, fontDef, loadFamily, renderLabel, type RenderResult, type RenderTarget } from '../../src/render'
import { SYMBOL_FONTS, familyReady } from '../../src/render/fonts'
import { cssFont } from '../../src/render/text'
import { createDoc, createItem, type FontFamilyId, type Item, type LabelDoc, type TableItem, type TextItem } from '../../src/doc/schema'
import { expectBitmapSnapshot, toPbm } from './snapshot'

const TEXT_TOLERANCE = 0.03

function target(widthMm = 24): RenderTarget {
  const media = mediaForWidth('PT-P710BT', widthMm)
  return { model: 'PT-P710BT', media, area: printArea('PT-P710BT', media.id) }
}
const text = (t: string, patch: Partial<TextItem> = {}): TextItem => ({ ...(createItem('text') as TextItem), text: t, ...patch })
const table = (cells: string[][], patch: Partial<TableItem> = {}): TableItem => ({ ...(createItem('table') as TableItem), cells, ...patch })
const label = (items: Item[]): LabelDoc => createDoc({ items, marginsMm: { start: 0, end: 0 } })

async function render(doc: LabelDoc): Promise<RenderResult> {
  const report = await ensureFonts(doc)
  expect(report.fallbacks).toEqual([])
  return renderLabel(doc, target())
}

beforeAll(async () => {
  await loadWasm()
})

describe('special characters (24 mm, PT-P710BT)', () => {
  // First, while this page has not loaded the JetBrains Mono / B612 families: a text with
  // characters Fira Sans lacks that are in those files but outside the symbol ranges (‼ ‽ in
  // JetBrains Mono, ⁂ in B612), next to a menu symbol (♯), renders the same before and after an
  // unrelated label (a barcode caption, the font picker…) loads those families.
  it('a label renders the same whatever other fonts the page has loaded', async () => {
    expect(familyReady('jetbrains-mono', 700) || familyReady('b612', 700)).toBe(false)
    const doc = label([text('A‼‽⁂♯', { fontWeight: 700 }), table([['‼♯', '⁂']], { fontWeight: 700 })])
    const before = await render(doc)
    try {
      expect(await loadFamily('jetbrains-mono', 700)).toBe(true)
      expect(await loadFamily('b612', 700)).toBe(true)
      expect(await loadFamily('jetbrains-mono', 400)).toBe(true)
      const after = await render(doc)
      try {
        expect(after.lengthDots).toBe(before.lengthDots)
        expect(toPbm(after.bitmap) === toPbm(before.bitmap)).toBe(true)
      } finally {
        release(after.bitmap)
      }
    } finally {
      release(before.bitmap)
    }
  })

  const cases: [string, LabelDoc][] = [
    // Fira Sans has → ½ ° €; ✓ ⚠ ≈ come from JetBrains Mono, ★ ☑ from B612.
    ['symbols-text-24mm', label([text('→ ½ 20° €5 ✓ ⚠ ≈ ★ ☑', { fontWeight: 700 })])],
    ['symbols-table-24mm', label([table([['DO♯', 'MI♭', '≤ 5', '★'], ['±1', '✓', '☐', '⚡']], { fontWeight: 700, grid: true })])],
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

  it('a symbol the face lacks is drawn with the fallback font’s own glyph, never a system font', async () => {
    const cases: [string, FontFamilyId, FontFamilyId][] = [
      ['✓', 'fira-sans', 'jetbrains-mono'],
      ['⚠', 'oswald', 'jetbrains-mono'],
      ['♯', 'archivo-narrow', 'jetbrains-mono'],
      ['≈', 'fredoka', 'jetbrains-mono'],
      ['★', 'fira-sans', 'b612'],
      ['☑', 'archivo-narrow', 'b612'],
    ]
    const ctx = new OffscreenCanvas(8, 8).getContext('2d')!
    const metrics = (font: string, sym: string): number[] => {
      ctx.font = font
      const m = ctx.measureText(sym)
      return [m.width, m.actualBoundingBoxLeft, m.actualBoundingBoxRight, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent].map((v) => Math.round(v * 100) / 100)
    }
    for (const [sym, face, fallback] of cases) {
      for (const weight of [400, 700] as const) {
        const item = text(sym, { fontFamily: face, fontWeight: weight })
        // The renderer's own path: the doc's fonts are loaded, then its CSS stack is measured.
        await ensureFonts(label([item, table([[sym]], { fontFamily: face, fontWeight: weight })]))
        const got = metrics(cssFont(item, 100), sym)
        const symbolFamily = SYMBOL_FONTS.find((f) => f.id === fallback)?.family
        expect(got, `${sym} in ${face}@${weight} = ${fallback}`).toEqual(metrics(`${weight} 100px "${symbolFamily}"`, sym))
        expect(got, `${sym} in ${face}@${weight} is not the system font`).not.toEqual(metrics(`${weight} 100px ${fontDef(face).generic}`, sym))
      }
    }
    expect(document.fonts.check('400 20px "ptouch Symbols JetBrains Mono"', '♯')).toBe(true)
    expect(document.fonts.check('700 20px "ptouch Symbols B612"', '★')).toBe(true)
  })
})

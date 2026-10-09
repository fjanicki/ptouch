// Lead integration — text snapshots of a few library fonts at the sizes the studio now uses
// (Fit on 12 mm, M and points on 24 mm), per OS like every text snapshot (snapshot.ts). They pin
// the bundled files, the lazy loader and the sizing together: a changed font file, a fallback
// face or a sizing change shows up here.
import { beforeAll, describe, expect, it } from 'vitest'
import { loadWasm, mediaForWidth, printArea } from '../../src/wasm'
import { createDoc, createItem, type FontFamilyId, type FontWeight, type LabelDoc, type TapeWidthMm, type TextItem, type TextSize } from '../../src/doc/schema'
import { ensureFonts, renderLabel, type RenderTarget } from '../../src/render'
import { quickTextSizes } from '../../src/render/text-size'
import { expectBitmapSnapshot } from './snapshot'

const TEXT_TOLERANCE = 0.03

function target(widthMm: number): RenderTarget {
  const media = mediaForWidth('PT-P710BT', widthMm)
  return { model: 'PT-P710BT', media, area: printArea('PT-P710BT', media.id) }
}

function label(widthMm: TapeWidthMm, t: string, fontFamily: FontFamilyId, fontWeight: FontWeight, size: TextSize): LabelDoc {
  const item: TextItem = { ...createItem('text'), text: t, fontFamily, fontWeight, size }
  const base = createDoc({ items: [item] })
  return { ...base, tape: { ...base.tape, widthMm, mediaId: mediaForWidth('PT-P710BT', widthMm).id } }
}

beforeAll(async () => {
  await loadWasm()
})

const medium = (widthMm: number): TextSize => {
  const t = target(widthMm)
  return quickTextSizes(t.area.heightDots, t.area.dpi).find((q) => q.id === 'm')?.size ?? { mode: 'fit' }
}

const CASES: { name: string; widthMm: TapeWidthMm; text: string; family: FontFamilyId; weight: FontWeight; size: () => TextSize }[] = [
  { name: 'lib-oswald-fit-12mm', widthMm: 12, text: 'CRATE 07', family: 'oswald', weight: 700, size: () => ({ mode: 'fit' }) },
  { name: 'lib-caveat-m-24mm', widthMm: 24, text: 'Hello', family: 'caveat', weight: 700, size: () => medium(24) },
  { name: 'lib-special-elite-14pt-24mm', widthMm: 24, text: 'Spices', family: 'special-elite', weight: 400, size: () => ({ mode: 'pt', pt: 14 }) },
  { name: 'lib-lexend-m-12mm', widthMm: 12, text: 'Readable', family: 'lexend', weight: 400, size: () => medium(12) },
]

describe('library font snapshots', () => {
  for (const c of CASES) {
    it(`${c.name}: ${c.family} ${c.weight}`, async () => {
      const doc = label(c.widthMm, c.text, c.family, c.weight, c.size())
      expect((await ensureFonts(doc)).fallbacks).toEqual([])
      const r = await renderLabel(doc, target(c.widthMm))
      try {
        expect(r.warnings).toEqual([])
        expect(r.texts?.[0]?.itemId).toBe(doc.items[0]?.id)
        await expectBitmapSnapshot(r.bitmap, c.name, TEXT_TOLERANCE)
      } finally {
        r.bitmap.free()
      }
    })
  }
})

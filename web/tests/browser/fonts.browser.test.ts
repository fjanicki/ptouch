// P4 — custom fonts in Chromium: an uploaded test font (tests/unit/persist/font-fixture.ts, one
// filled box per character) passes the browser's font sanitiser, is stored, and renders
// differently from the bundled fallback; a missing upload or local font gives `font-missing`
// and the exact fallback bitmap.
import { beforeAll, describe, expect, it } from 'vitest'
import { loadWasm, mediaForWidth, printArea, type Bitmap1 } from '../../src/wasm'
import { createDoc, createItem, type FontSource, type LabelDoc, type TextItem } from '../../src/doc/schema'
import { memoryBackend } from '../../src/doc/persist'
import { openFontStore, type FontStore } from '../../src/doc/persist-fonts'
import { renderLabel, type RenderResult, type RenderTarget } from '../../src/render'
import { customFontMissing, customFontReady, ensureFonts, forgetCustomFont, loadCustomFont } from '../../src/render/fonts'
import { makeTestFont, toWoff } from '../unit/persist/font-fixture'

function target(widthMm: number): RenderTarget {
  const media = mediaForWidth('PT-P710BT', widthMm)
  return { model: 'PT-P710BT', media, area: printArea('PT-P710BT', media.id) }
}

const textDoc = (patch: Partial<TextItem>): LabelDoc => createDoc({ items: [{ ...createItem('text'), text: 'II', fontFamily: 'fira-sans', fontWeight: 600, ...patch }] })

/** Share of inked dots inside the ink's bounding box. */
function fill(b: Bitmap1): number {
  let x0 = Infinity
  let x1 = -1
  let y0 = Infinity
  let y1 = -1
  let n = 0
  for (let x = 0; x < b.length; x++) {
    for (let y = 0; y < b.height; y++) {
      if (!b.get(x, y)) continue
      n++
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }
  }
  return x1 < 0 ? 0 : n / ((x1 - x0 + 1) * (y1 - y0 + 1))
}

const same = (a: Bitmap1, b: Bitmap1): boolean => a.length === b.length && a.height === b.height && a.toPacked().every((v, i) => v === b.toPacked()[i])

async function render(doc: LabelDoc, loadFontBlob?: (ref: string) => Promise<Blob | undefined>): Promise<RenderResult> {
  return renderLabel(doc, target(12), loadFontBlob ? { loadFontBlob } : {})
}

let store: FontStore
let src: FontSource

beforeAll(async () => {
  await loadWasm()
  store = openFontStore({ area: memoryBackend().blobs })
  const info = await store.add(new File([makeTestFont({ family: 'Box Test' }).slice()], 'box.ttf'))
  src = { kind: 'user', ref: info.ref, family: info.family }
})

describe('uploaded fonts', () => {
  it('the self-made test font passes the browser font sanitiser and is named from its name table', async () => {
    expect(src.family).toBe('Box Test')
    const woff = await store.add(new File([(await toWoff(makeTestFont({ family: 'Box Woff', boxWidth: 400 }))).slice()], 'w.woff'))
    expect(woff).toMatchObject({ family: 'Box Woff', format: 'woff' })
    expect(await loadCustomFont({ kind: 'user', ref: woff.ref, family: woff.family }, (r) => store.get(r))).toBe(true)
  })

  it('rejects a file with a font signature that the browser cannot read', async () => {
    const junk = new Uint8Array(256).fill(7)
    junk.set([0, 1, 0, 0])
    await expect(store.add(new File([junk], 'broken.ttf'))).rejects.toThrow(/could not read this font/)
  })

  it('renders with the uploaded font instead of the fallback', async () => {
    const fallback = await render(textDoc({}))
    const custom = await render(textDoc({ customFont: src }), (r) => store.get(r))
    try {
      expect(custom.warnings.filter((w) => w.code.startsWith('font'))).toEqual([])
      expect(customFontReady(src)).toBe(true)
      expect(same(custom.bitmap, fallback.bitmap)).toBe(false)
      // Two filled boxes with a narrow gap vs two thin Fira strokes.
      expect(fill(custom.bitmap)).toBeGreaterThan(0.8)
      expect(fill(fallback.bitmap)).toBeLessThan(0.7)
    } finally {
      custom.bitmap.free()
      fallback.bitmap.free()
    }
  })

  it('a missing upload gives font-missing and exactly the fallback bitmap', async () => {
    const ghost: FontSource = { kind: 'user', ref: `sha256-${'0'.repeat(32)}`, family: 'Ghost Sans' }
    const fallback = await render(textDoc({}))
    const r = await render(textDoc({ customFont: ghost }), (ref) => store.get(ref))
    try {
      expect(r.warnings.filter((w) => w.code === 'font-missing').map((w) => w.message)).toEqual([expect.stringContaining('“Ghost Sans”')])
      expect(customFontMissing(ghost)).toBe(true)
      expect(same(r.bitmap, fallback.bitmap)).toBe(true)
    } finally {
      r.bitmap.free()
      fallback.bitmap.free()
    }
  })

  it('a local font that is not installed is reported missing', async () => {
    const local: FontSource = { kind: 'local', postscriptName: 'PtouchNoSuchFont-Regular', family: 'No Such Font' }
    expect((await ensureFonts(textDoc({ customFont: local }))).missing).toEqual(['No Such Font'])
  })

  it('a removed font falls back on the next render', async () => {
    const info = await store.add(new File([makeTestFont({ family: 'Box Gone', boxWidth: 300 }).slice()], 'gone.ttf'))
    const gone: FontSource = { kind: 'user', ref: info.ref, family: info.family }
    expect((await ensureFonts(textDoc({ customFont: gone }), { loadFontBlob: (r) => store.get(r) })).missing).toBeUndefined()
    await store.remove(info.ref)
    forgetCustomFont(gone)
    expect((await ensureFonts(textDoc({ customFont: gone }), { loadFontBlob: (r) => store.get(r) })).missing).toEqual(['Box Gone'])
  })
})

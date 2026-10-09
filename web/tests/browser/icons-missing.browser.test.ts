// The icon catalogue is a lazy chunk (render/icon-set.ts). When it cannot be loaded (offline before
// the service worker cached it, or a stale chunk after a deploy), a label with icons must not print
// blank: the renderer blocks printing with its own warning code, `icons-missing` (not
// `image-missing`, which history reprints read as "an image of this label is gone").
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createDoc, createItem } from '../../src/doc/schema'
import { renderLabel, type RenderTarget } from '../../src/render'
import { preloadAllFonts } from '../../src/render/fonts'
import { loadWasm, mediaForWidth, printArea } from '../../src/wasm'

// The chunk import fails (icon-set.ts rethrows the import error).
vi.mock('../../src/render/icon-set', () => ({
  loadIcons: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')),
  loadedIcons: () => undefined,
}))

function target(widthMm: number): RenderTarget {
  const media = mediaForWidth('PT-P710BT', widthMm)
  return { model: 'PT-P710BT', media, area: printArea('PT-P710BT', media.id) }
}

beforeAll(async () => {
  await loadWasm()
  await preloadAllFonts()
})

describe('icon catalogue that fails to load', () => {
  it('blocks printing with icons-missing, not image-missing', async () => {
    const r = await renderLabel(createDoc({ items: [createItem('icon'), { ...createItem('text'), text: 'Hi' }], tape: { widthMm: 12 } }), target(12))
    try {
      expect(r.blocking).toBe(true)
      const codes = r.warnings.map((w) => w.code)
      expect(codes).toContain('icons-missing')
      expect(codes).not.toContain('image-missing')
      expect(r.warnings.find((w) => w.code === 'icons-missing')).toMatchObject({ blocking: true, message: /icons could not be loaded/ })
    } finally {
      r.bitmap.free()
    }
  })

  it('a label without icons is not affected', async () => {
    const r = await renderLabel(createDoc({ items: [{ ...createItem('text'), text: 'Hi' }], tape: { widthMm: 12 } }), target(12))
    try {
      expect(r.blocking ?? false).toBe(false)
      expect(r.warnings.map((w) => w.code)).not.toContain('icons-missing')
    } finally {
      r.bitmap.free()
    }
  })
})

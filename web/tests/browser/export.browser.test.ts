// P4 — PNG / PDF export of a real render in Chromium: the browser decodes the PNG back to
// exactly the printed dots, and the PDF page is the physical label size.
import { beforeAll, describe, expect, it } from 'vitest'
import { loadWasm, mediaForWidth, printArea } from '../../src/wasm'
import { createDoc, createItem } from '../../src/doc/schema'
import { renderLabel, type RenderTarget } from '../../src/render'
import { exportPdf, exportPng } from '../../src/render/export'
import { mmToDots } from '../../src/render/units'

function target(widthMm: number): RenderTarget {
  const media = mediaForWidth('PT-P710BT', widthMm)
  return { model: 'PT-P710BT', media, area: printArea('PT-P710BT', media.id) }
}

beforeAll(async () => {
  await loadWasm()
})

describe('export', () => {
  it('the PNG decodes to exactly the print bitmap', async () => {
    const t = target(12)
    const doc = createDoc({ items: [{ ...createItem('text'), text: 'Export 42' }, { ...createItem('code'), data: 'https://example.com/a' }] })
    const r = await renderLabel(doc, t)
    try {
      const png = await exportPng(r.bitmap, { dpi: t.area.dpi })
      expect(png.type).toBe('image/png')
      const img = await createImageBitmap(png)
      expect([img.width, img.height]).toEqual([r.bitmap.length, r.bitmap.height])
      const canvas = new OffscreenCanvas(img.width, img.height)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0)
      const px = ctx.getImageData(0, 0, img.width, img.height).data
      let bad = 0
      let ink = 0
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const v = px[(y * img.width + x) * 4] ?? 0
          const dot = r.bitmap.get(x, y)
          if (dot) ink++
          if ((v < 128) !== dot) bad++
        }
      }
      expect(ink).toBeGreaterThan(100)
      expect(bad).toBe(0)
    } finally {
      r.bitmap.free()
    }
  })

  it('the PDF page is the cut label at true size', async () => {
    const t = target(24)
    const r = await renderLabel(createDoc({ items: [{ ...createItem('text'), text: 'PDF' }] }), t)
    try {
      const pdf = await exportPdf(r.bitmap, { dpi: t.area.dpi, tapeWidthDots: t.area.tapeWidthDots, marginDots: mmToDots(r.feedMarginMm, t.area.dpi), title: 'PDF' })
      const text = new TextDecoder('latin1').decode(await pdf.arrayBuffer())
      const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text)
      const mm = (pt: string | undefined) => (Number(pt) * 25.4) / 72
      expect(mm(box?.[2])).toBeCloseTo(24, 0) // 170 dots = 23.99 mm
      expect(mm(box?.[1])).toBeCloseTo(r.lengthMm + 2 * r.feedMarginMm, 0)
    } finally {
      r.bitmap.free()
    }
  })
})

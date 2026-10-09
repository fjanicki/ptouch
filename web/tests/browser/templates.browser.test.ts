// P2 — every template renders on its tape (Chromium, real fonts and wasm) without warnings once
// its placeholders are filled: no clipped or overflowing content, no blocking problem. The Wi-Fi
// templates need P3's `wifiPayload`; they are skipped while it is still a stub.
import { beforeAll, describe, expect, it } from 'vitest'
import { loadWasm, mediaForWidth, printArea, release, type Bitmap1 } from '../../src/wasm'
import { renderLabel, wifiPayload, type RenderResult, type RenderTarget } from '../../src/render'
import { preloadAllFonts } from '../../src/render/fonts'
import { createWifi, type LabelDoc } from '../../src/doc/schema'
import { resolveDoc } from '../../src/doc/variables'
import { TEMPLATES, withSampleData } from '../../src/ui/templates/templates'

function target(widthMm: number): RenderTarget {
  const media = mediaForWidth('PT-P710BT', widthMm)
  return { model: 'PT-P710BT', media, area: printArea('PT-P710BT', media.id) }
}

/** Placeholders filled the way a user (and P1's resolver) would. */
function filled(doc: LabelDoc): LabelDoc {
  return resolveDoc(withSampleData(doc), 0, { now: new Date(2026, 9, 8) }).doc
}

function wifiReady(): boolean {
  try {
    wifiPayload(createWifi({ ssid: 'x', password: 'password1' }))
    return true
  } catch {
    return false
  }
}

function inkRows(b: Bitmap1): number {
  let rows = 0
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.length; x++) {
      if (b.get(x, y)) {
        rows++
        break
      }
    }
  }
  return rows
}

beforeAll(async () => {
  await loadWasm()
  await preloadAllFonts()
})

describe('templates render on their tape', () => {
  for (const t of TEMPLATES) {
    const needsWifi = t.build().items.some((i) => i.kind === 'code' && i.content === 'wifi')
    it.skipIf(needsWifi && !wifiReady())(`${t.name}`, async () => {
      const doc = filled(t.build())
      let r: RenderResult | undefined
      try {
        r = await renderLabel(doc, target(t.tapeWidthMm))
        expect(r.warnings.map((w) => `${w.code}: ${w.message}`)).toEqual([])
        expect(r.blocking).toBe(false)
        expect(r.overflow ?? false).toBe(false)
        expect(inkRows(r.bitmap)).toBeGreaterThan(r.heightDots / 3)
        if (doc.length.mode === 'fixed') expect(r.lengthMm).toBeCloseTo(doc.length.mm, 0)
      } finally {
        release(r?.bitmap)
      }
    })
  }

  it.skipIf(!wifiReady())('the 12 mm Wi-Fi QR of a typical WPA network gets at least 2 dots per module', async () => {
    const doc = filled(TEMPLATES.find((t) => t.id === 'wifi-12')!.build())
    const qr = doc.items.find((i) => i.kind === 'code')!
    const r = await renderLabel(doc, target(12))
    try {
      // `WIFI:T:WPA;S:Home Wi-Fi;P:correct-horse-42;;` is a version 3 symbol (29 modules) at ECC L.
      const box = r.boxes.find((b) => b.itemId === qr.id)
      expect(box?.h).toBeGreaterThanOrEqual(29 * 2)
    } finally {
      release(r.bitmap)
    }
  })
})

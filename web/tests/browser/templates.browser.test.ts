// P2 — every template renders on its tape (Chromium, real fonts and wasm) without warnings once
// its placeholders are filled: no clipped or overflowing content, no blocking problem. The Wi-Fi
// templates need P3's `wifiPayload`; they are skipped while it is still a stub.
// P-size (docs/FONTS-AND-SIZE-PLAN.md §3.3) — and they do not waste tape: each one stays within a
// length budget, the 12 mm Wi-Fi sticker is 30–40 mm long with a typical network name.
// Printer models (docs/MODELS-PLAN.md §3.9) — the 36 mm variants render on the 360 dpi models, and
// every template renders cleanly on the band of every model that takes its width (`build(band)`).
import { beforeAll, describe, expect, it } from 'vitest'
import { listModels, loadWasm, mediaForWidth, printArea, release, type Bitmap1 } from '../../src/wasm'
import { renderLabel, wifiPayload, type RenderResult, type RenderTarget } from '../../src/render'
import { preloadAllFonts } from '../../src/render/fonts'
import { createWifi, type LabelDoc } from '../../src/doc/schema'
import { resolveDoc } from '../../src/doc/variables'
import { TEMPLATES, templateModel, withSampleData, type TemplateDef } from '../../src/ui/templates/templates'
import { tapeWidthsOf } from '../../src/ui/state/models'

/** The template's tape on the PT-P710BT, or on the PT-P910BT for 36 mm (which it lacks). */
function target(widthMm: number, model = widthMm === 36 ? 'PT-P910BT' : 'PT-P710BT'): RenderTarget {
  const media = mediaForWidth(model, widthMm)
  return { model, media, area: printArea(model, media.id) }
}

/** `t` built on the band of `target` (as the gallery opens it on that model). */
function builtFor(t: TemplateDef, tg: RenderTarget): LabelDoc {
  return t.build({ bandDots: tg.area.heightDots, dpi: tg.area.dpi })
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
      const doc = filled(builtFor(t, target(t.tapeWidthMm)))
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

  /** Longest printed length (mm, feed margins not included) per template with its sample text. */
  const BUDGET_MM: Record<string, number> = {
    'wifi-12': 40,
    'wifi-24': 80,
    'cable-flag': 75,
    'cable-wrap': 40,
    'bin-24': 65,
    'drawer-12': 40,
    'gridfinity-12': 32,
    'asset-tag': 30,
    'folder-spine': 100,
    'name-tag': 65,
    'wifi-36': 110,
    'bin-36': 105,
    'folder-spine-36': 150,
    'name-tag-36': 115,
    // Music (tables): about 20 mm per white key, 25 mm per key with sharps (equal columns).
    'piano-white-24': 145,
    'piano-12-24': 305,
    'piano-12-flats-24': 160,
  }

  it.skipIf(!wifiReady())('every template stays within its length budget', async () => {
    expect(Object.keys(BUDGET_MM).sort()).toEqual(TEMPLATES.map((t) => t.id).sort())
    for (const t of TEMPLATES) {
      const r = await renderLabel(filled(builtFor(t, target(t.tapeWidthMm))), target(t.tapeWidthMm))
      try {
        expect(r.lengthMm, t.id).toBeLessThanOrEqual((BUDGET_MM[t.id] ?? 0) + 0.05)
      } finally {
        release(r.bitmap)
      }
    }
  })

  it.skipIf(!wifiReady())('the 12 mm Wi-Fi sticker is 30–40 mm long for "MyHomeNetwork"; the 24 mm one keeps the ratio', async () => {
    const lengths: number[] = []
    for (const id of ['wifi-12', 'wifi-24']) {
      const t = TEMPLATES.find((x) => x.id === id)!
      const doc = t.build()
      const net = { ...doc, items: doc.items.map((i) => (i.kind === 'code' && i.content === 'wifi' ? { ...i, wifi: { ...(i.wifi ?? createWifi()), ssid: 'MyHomeNetwork', password: 'correct-horse-42' } } : i)) }
      const r = await renderLabel(resolveDoc(net, 0, { now: new Date() }).doc, target(t.tapeWidthMm))
      try {
        expect(r.warnings).toEqual([])
        lengths.push(r.lengthMm)
      } finally {
        release(r.bitmap)
      }
    }
    const [small = 0, large = 0] = lengths
    expect(small).toBeGreaterThanOrEqual(30)
    expect(small).toBeLessThanOrEqual(40)
    // Twice the tape width, about twice the length (± 25 %).
    expect(large / small).toBeGreaterThan(1.5)
    expect(large / small).toBeLessThan(2.5)
  })

  it('long text shrinks on the fixed-length templates instead of being cut off', async () => {
    for (const id of ['gridfinity-12', 'folder-spine', 'folder-spine-36', 'cable-wrap']) {
      const t = TEMPLATES.find((x) => x.id === id)!
      const doc = t.build()
      const long = { ...doc, items: doc.items.map((i) => (i.kind === 'text' ? { ...i, text: `${i.text} with a much longer description` } : i)) }
      const r = await renderLabel(long, target(t.tapeWidthMm))
      try {
        expect(r.overflow ?? false, id).toBe(false)
        expect(r.texts?.[0]?.shrink, id).toBeLessThan(1)
      } finally {
        release(r.bitmap)
      }
    }
  })

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

describe('templates on every printer model (docs/MODELS-PLAN.md §3.9)', () => {
  /** One model per distinct print area (dpi and band of every width): the others render alike. */
  function distinctModels(): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const m of listModels()) {
      const key = tapeWidthsOf(m)
        .map((w) => {
          const a = printArea(m.name, mediaForWidth(m.name, w).id)
          return `${a.dpi}:${a.heightDots}:${a.tapeWidthDots}`
        })
        .join(',')
      if (!seen.has(key)) {
        seen.add(key)
        out.push(m.name)
      }
    }
    return out
  }

  it.skipIf(!wifiReady())('every template renders without warnings on the band of every model that takes its width', async () => {
    const models = distinctModels()
    // PT-P710BT, PT-P300BT (12 mm = 64 dots), an 18 mm model and the 360 dpi heads at least.
    expect(models).toEqual(expect.arrayContaining(['PT-P710BT', 'PT-P300BT', 'PT-E310BT', 'PT-P910BT']))
    for (const name of models) {
      const m = listModels().find((x) => x.name === name)!
      for (const t of TEMPLATES.filter((x) => tapeWidthsOf(m).includes(x.tapeWidthMm))) {
        const tg = target(t.tapeWidthMm, name)
        const r = await renderLabel(filled(builtFor(t, tg)), tg)
        try {
          expect(r.warnings.map((w) => `${t.id} on ${name}: ${w.code}: ${w.message}`)).toEqual([])
          expect(r.blocking).toBe(false)
          expect(r.overflow ?? false, `${t.id} on ${name}`).toBe(false)
          expect(inkRows(r.bitmap), `${t.id} on ${name}`).toBeGreaterThan(r.heightDots / 3)
        } finally {
          release(r.bitmap)
        }
      }
    }
  })

  it('a template on a width the active model lacks is drawn with the stand-in (never fails)', async () => {
    for (const t of TEMPLATES) {
      for (const active of ['PT-P300BT', 'PT-D460BT', 'PT-P710BT']) {
        const use = templateModel(t, active, listModels())
        expect(use, `${t.id} on ${active}`).not.toBeNull()
        const tg = target(t.tapeWidthMm, use!)
        const r = await renderLabel(filled(builtFor(t, tg)), tg)
        try {
          expect(r.blocking, `${t.id} on ${active} → ${use}`).toBe(false)
        } finally {
          release(r.bitmap)
        }
      }
    }
  })
})

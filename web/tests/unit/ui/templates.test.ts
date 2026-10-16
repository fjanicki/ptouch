// P2 — the template catalogue (valid, fresh docs with obvious placeholders) and the gallery
// helpers (grid keyboard movement, bounded thumbnail queue). Printer models (docs/MODELS-PLAN.md
// §3.9): 36 mm variants, `build(band)` (quick size M of any model's band), which templates a model
// takes and the model a card is drawn and opened with (against the real core table).
import { beforeAll, describe, expect, it } from 'vitest'
import { listModels, mediaForWidth, printArea, type ModelInfo } from '../../../src/wasm'
import { loadWasmForTests } from '../../helpers/wasm'
import { findModel, tapeWidthsOf } from '../../../src/ui/state/models'
import { fallbackBand } from '../../../src/ui/state/text-defaults'
import { TAPE_WIDTHS_MM, validateDoc, type CodeItem, type LabelDoc, type SpacerItem, type TextItem } from '../../../src/doc/schema'
import { iconById } from '../../../src/render/icons'
import { mmToDots } from '../../../src/render/units'
import { matchQuickSize } from '../../../src/render/text-size'
import { FALLBACK_BAND_DOTS } from '../../../src/ui/state/text-defaults'
import {
  CABLE_FLAG_DIAMETER_MM,
  CABLE_FLAG_WRAP_MM,
  CABLE_WRAP_DIAMETER_MM,
  CABLE_WRAP_OVERLAP_MM,
  GRIDFINITY_LENGTH_MM,
  QUICK_M_MM,
  SAMPLE_WIFI,
  TEMPLATES,
  TEMPLATE_CATEGORIES,
  fitsLoadedTape,
  needsWidthText,
  primaryItemId,
  templateById,
  templateFits,
  templateModel,
  templatesIn,
  withSampleData,
  type TemplateDef,
} from '../../../src/ui/templates/templates'
import { createTaskQueue, gridMove, type CardPoint } from '../../../src/ui/templates/gallery'

const build = (id: string): LabelDoc => {
  const t = templateById(id)
  if (!t) throw new Error(`no template ${id}`)
  return t.build()
}
const texts = (d: LabelDoc) => d.items.filter((i): i is TextItem => i.kind === 'text')
const codes = (d: LabelDoc) => d.items.filter((i): i is CodeItem => i.kind === 'code')

describe('template catalogue', () => {
  it('has every template of the brief, with unique ids and names', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      'wifi-12',
      'wifi-24',
      'wifi-36',
      'cable-flag',
      'cable-wrap',
      'bin-24',
      'bin-36',
      'drawer-12',
      'gridfinity-12',
      'asset-tag',
      'folder-spine',
      'folder-spine-36',
      'name-tag',
      'name-tag-36',
    ])
    expect(new Set(TEMPLATES.map((t) => t.name)).size).toBe(TEMPLATES.length)
    for (const t of TEMPLATES) {
      expect(t.description.length, t.id).toBeGreaterThan(20)
      expect(TEMPLATE_CATEGORIES.some((c) => c.id === t.category), t.id).toBe(true)
    }
    // Every section has cards, and together they list every template once.
    expect(TEMPLATE_CATEGORIES.flatMap((c) => templatesIn(c.id))).toHaveLength(TEMPLATES.length)
    for (const c of TEMPLATE_CATEGORIES) expect(templatesIn(c.id).length, c.id).toBeGreaterThan(0)
    expect(templateById('nope')).toBeUndefined()
  })

  for (const t of TEMPLATES) {
    it(`${t.id}: a valid label (no repairs) on its tape, using bundled icons only`, () => {
      const doc = t.build()
      const v = validateDoc(JSON.parse(JSON.stringify(doc)))
      expect(v.ok).toBe(true)
      if (!v.ok) return
      expect(v.notices).toEqual([])
      expect(v.doc).toEqual(doc) // no unknown fields, nothing repaired
      expect(doc.tape.widthMm).toBe(t.tapeWidthMm)
      expect(TAPE_WIDTHS_MM).toContain(t.tapeWidthMm)
      expect(doc.items.length).toBeGreaterThan(0)
      for (const i of doc.items) if (i.kind === 'icon') expect(iconById(i.iconId), i.iconId).toBeDefined()
      // New code items follow the v1 defaults: automatic module size.
      for (const c of codes(doc)) expect(c.moduleDots).toBe('auto')
      // The label's name says what it is (the gallery card name may add the tape width).
      expect(t.name.startsWith(doc.name.split(' ')[0] ?? '')).toBe(true)
    })

    it(`${t.id}: build() makes fresh ids every call`, () => {
      const a = t.build()
      const b = t.build()
      expect(a.id).not.toBe(b.id)
      const ids = a.items.map((i) => i.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const id of ids) expect(b.items.map((i) => i.id)).not.toContain(id)
      // …and fresh objects: editing one copy never changes the next.
      expect(a.items[0]).not.toBe(b.items[0])
      expect(a.print).not.toBe(b.print)
    })
  }

  it('Wi-Fi stickers: a Wi-Fi QR code (empty network, no password) and the {{ssid}} text', () => {
    const small = build('wifi-12')
    expect(small.tape.widthMm).toBe(12)
    const [qr] = codes(small)
    expect(qr).toMatchObject({ symbology: 'qr', content: 'wifi', quietZone: 'compact', ecc: 'L', moduleDots: 'auto' })
    expect(qr?.wifi).toEqual({ ssid: '', password: '', security: 'wpa', hidden: false })
    // "Wi-Fi" over the network name, small and narrow so the sticker stays ≈ 3.5 cm long.
    expect(texts(small).map((t) => t.text)).toEqual(['Wi-Fi\n{{ssid}}'])
    expect(texts(small)[0]).toMatchObject({ fontFamily: 'archivo-narrow', size: { mode: 'mm', mm: 5.5 }, align: 'start' })
    expect(small.length).toEqual({ mode: 'auto' })

    const large = build('wifi-24')
    expect(large.tape.widthMm).toBe(24)
    expect(large.items.map((i) => i.kind)).toEqual(['icon', 'text', 'code'])
    expect(large.items[0]).toMatchObject({ kind: 'icon', iconId: 'wifi' })
    expect(texts(large)[0]?.text).toBe('Wi-Fi\n{{ssid}}')
    expect(texts(large)[0]?.size).toEqual({ mode: 'mm', mm: QUICK_M_MM[24] })
    expect(codes(large)[0]).toMatchObject({ content: 'wifi', quietZone: 'standard', ecc: 'M' })
    expect(large.length).toEqual({ mode: 'auto' })
  })

  it('cable flag: the same text on both sides of a π × Ø blank middle', () => {
    expect(CABLE_FLAG_WRAP_MM).toBeCloseTo(Math.PI * CABLE_FLAG_DIAMETER_MM, 0)
    const doc = build('cable-flag')
    expect(doc.items.map((i) => i.kind)).toEqual(['text', 'spacer', 'text'])
    const [a, b] = texts(doc)
    expect(a?.text).toBe(b?.text)
    expect(a?.size).toEqual(b?.size)
    expect((doc.items[1] as SpacerItem).widthMm).toBe(CABLE_FLAG_WRAP_MM)
    // Symmetric about the middle: equal margins, centred flow.
    expect(doc.marginsMm.start).toBe(doc.marginsMm.end)
    expect(doc.layout).toMatchObject({ mode: 'flow', align: 'center' })
    expect([9, 12]).toContain(doc.tape.widthMm)
  })

  it('cable wrap: repeated text along one turn plus overlap', () => {
    const doc = build('cable-wrap')
    expect([6, 9]).toContain(doc.tape.widthMm)
    expect(doc.length).toEqual({ mode: 'fixed', mm: Math.round(Math.PI * CABLE_WRAP_DIAMETER_MM + CABLE_WRAP_OVERLAP_MM), shrink: true })
    const [t] = texts(doc)
    const word = t?.text.split(' · ')[0] ?? ''
    expect(word.length).toBeGreaterThan(0)
    const repeats = t?.text.split(' · ').filter((w) => w === word).length ?? 0
    expect(repeats).toBeGreaterThanOrEqual(3)
    expect(repeats).toBeLessThanOrEqual(4)
  })

  it('storage labels: an icon and a text; Gridfinity is 12 mm with a fixed length for a 1-unit bin', () => {
    for (const id of ['bin-24', 'drawer-12', 'gridfinity-12']) {
      const doc = build(id)
      expect(doc.items.map((i) => i.kind), id).toEqual(['icon', 'text'])
    }
    expect(build('bin-24').tape.widthMm).toBe(24)
    expect(build('drawer-12').tape.widthMm).toBe(12)
    const grid = build('gridfinity-12')
    expect(grid.tape.widthMm).toBe(12)
    expect(grid.length).toEqual({ mode: 'fixed', mm: GRIDFINITY_LENGTH_MM, shrink: true })
    // The cut piece (≈ 2 mm feed margin at each end) stays within a 1-unit label tab (36–38 mm).
    expect(GRIDFINITY_LENGTH_MM + 4).toBeGreaterThanOrEqual(35)
    expect(GRIDFINITY_LENGTH_MM + 4).toBeLessThanOrEqual(37.8)
  })

  it('asset tag: QR {{id}} and "Asset {{id}}" (small fixed size) over a 10-label counter batch padded to 4 digits', () => {
    const doc = build('asset-tag')
    expect(codes(doc)[0]).toMatchObject({ symbology: 'qr', content: 'text', data: '{{id}}' })
    expect(texts(doc)[0]?.text).toBe('Asset\n{{id}}')
    // Not 'fit': fitted text would fill the band and make each tag ~9 cm long.
    expect(texts(doc)[0]?.size).toEqual({ mode: 'mm', mm: 7 })
    expect(doc.batch).toEqual({ enabled: true, columns: [], rows: [], count: 10, counters: [{ name: 'id', start: 1, step: 1, pad: 4 }], dateFormat: 'iso' })
  })

  it('text has a fixed size (no tape-high words) except the name tag; fixed lengths shrink long text', () => {
    for (const t of TEMPLATES) {
      const doc = t.build()
      for (const i of texts(doc)) expect(i.size.mode === 'fit', `${t.id}: ${i.text}`).toBe(t.id.startsWith('name-tag'))
      if (doc.length.mode === 'fixed') expect(doc.length.shrink, t.id).toBe(true)
    }
  })

  it('QUICK_M_MM is the quick size M of 12 and 24 mm tape, so the editor shows "M"', () => {
    for (const w of [12, 24] as const) {
      expect(matchQuickSize({ mode: 'mm', mm: QUICK_M_MM[w] }, FALLBACK_BAND_DOTS[w], 180)).toBe('m')
      expect(mmToDots(QUICK_M_MM[w], 180)).toBe(Math.round(FALLBACK_BAND_DOTS[w] / 2))
    }
    expect(texts(build('drawer-12'))[0]?.size).toEqual({ mode: 'mm', mm: QUICK_M_MM[12] })
    expect(texts(build('bin-24'))[0]?.size).toEqual({ mode: 'mm', mm: QUICK_M_MM[24] })
  })

  it('folder spine and name tag: 24 mm; the spine has a fixed length, the name tag two lines', () => {
    const spine = build('folder-spine')
    expect(spine.tape.widthMm).toBe(24)
    expect(spine.length.mode).toBe('fixed')
    const tag = build('name-tag')
    expect(tag.tape.widthMm).toBe(24)
    expect(texts(tag)[0]?.text.split('\n')).toHaveLength(2)
  })
})

describe('templates on every printer model (docs/MODELS-PLAN.md §3.9)', () => {
  let models: ModelInfo[] = []
  beforeAll(() => {
    loadWasmForTests()
    models = listModels()
  })
  const bandOf = (model: string, widthMm: number) => {
    const a = printArea(model, mediaForWidth(model, widthMm).id)
    return { bandDots: a.heightDots, dpi: a.dpi }
  }
  const byId = (id: string): TemplateDef => templateById(id)!

  it('36 mm variants of the Wi-Fi sticker, shelf label, folder spine and name tag', () => {
    expect(TEMPLATES.filter((t) => t.tapeWidthMm === 36).map((t) => t.id)).toEqual(['wifi-36', 'bin-36', 'folder-spine-36', 'name-tag-36'])
    const wifi = build('wifi-36')
    expect(wifi.items.map((i) => i.kind)).toEqual(['icon', 'text', 'code'])
    expect(codes(wifi)[0]).toMatchObject({ content: 'wifi', quietZone: 'standard', ecc: 'M', moduleDots: 'auto' })
    expect(texts(build('bin-36'))[0]?.size).toEqual({ mode: 'mm', mm: QUICK_M_MM[36] })
    expect(build('folder-spine-36').length).toEqual({ mode: 'fixed', mm: 150, shrink: true })
    expect(texts(build('name-tag-36'))[0]?.text.split('\n')).toHaveLength(2)
    expect(build('name-tag-36').frame).toBeDefined()
    // Same card name as the 24 mm one apart from the width suffix, same label name.
    expect(build('wifi-36').name).toBe(build('wifi-24').name)
    expect(build('bin-36').name).toBe(build('bin-24').name)
  })

  it('QUICK_M_MM[36] is M of the 36 mm band of the 360 dpi models', () => {
    const { bandDots, dpi } = fallbackBand(36)
    expect({ bandDots, dpi }).toEqual(bandOf('PT-P910BT', 36))
    expect(matchQuickSize({ mode: 'mm', mm: QUICK_M_MM[36] }, bandDots, dpi)).toBe('m')
  })

  it('build() without a band is unchanged, and the PT-P710BT band gives the same doc', () => {
    for (const t of TEMPLATES) {
      if (t.tapeWidthMm === 36) continue
      const strip = (d: LabelDoc) => JSON.stringify({ ...d, id: '', createdAt: '', updatedAt: '', items: d.items.map((i) => ({ ...i, id: '' })) })
      expect(strip(t.build(bandOf('PT-P710BT', t.tapeWidthMm))), t.id).toBe(strip(t.build()))
    }
    expect(texts(byId('wifi-36').build(bandOf('PT-P910BT', 36)))[0]?.size).toEqual({ mode: 'mm', mm: QUICK_M_MM[36] })
  })

  it('build(band) gives "M" of that band: 320 dots (PT-P910BT 24 mm) and 454 dots (36 mm)', () => {
    const on320 = bandOf('PT-P910BT', 24)
    expect(on320).toEqual({ bandDots: 320, dpi: 360 })
    for (const id of ['wifi-24', 'bin-24']) {
      const [t] = texts(byId(id).build(on320))
      expect(matchQuickSize(t!.size, 320, 360), id).toBe('m')
      expect(t?.size).toEqual({ mode: 'mm', mm: 11.29 })
    }
    for (const id of ['wifi-36', 'bin-36']) {
      const [t] = texts(byId(id).build({ bandDots: 454, dpi: 360 }))
      expect(matchQuickSize(t!.size, 454, 360), id).toBe('m')
    }
    // PT-P300BT 12 mm (64 dots): M of that band, still "M" in the editor.
    const p300 = bandOf('PT-P300BT', 12)
    expect(p300.bandDots).toBe(64)
    for (const id of ['drawer-12', 'cable-flag']) for (const t of texts(byId(id).build(p300))) expect(matchQuickSize(t.size, 64, 180), id).toBe('m')
  })

  it('every template is a valid label with M on the band of every model that takes its width', () => {
    for (const m of models) {
      for (const w of tapeWidthsOf(m)) {
        for (const t of TEMPLATES.filter((x) => x.tapeWidthMm === w)) {
          const band = bandOf(m.name, w)
          const doc = t.build(band)
          const v = validateDoc(JSON.parse(JSON.stringify(doc)))
          expect(v.ok && v.notices, `${t.id} on ${m.name}`).toEqual([])
          // Fixed sizes (mm) fit the band of every model that takes the width.
          for (const i of doc.items) {
            if ((i.kind === 'text' || i.kind === 'icon') && i.size.mode === 'mm') expect(mmToDots(i.size.mm, band.dpi), `${t.id} ${i.kind} on ${m.name}`).toBeLessThanOrEqual(band.bandDots)
          }
        }
      }
    }
  })

  it('templateFits: the model takes the width', () => {
    const p710 = tapeWidthsOf(findModel(models, 'PT-P710BT')!)
    const p300 = tapeWidthsOf(findModel(models, 'PT-P300BT')!)
    const p910 = tapeWidthsOf(findModel(models, 'PT-P910BT')!)
    const ids = (widths: readonly (typeof p710)[number][]) => TEMPLATES.filter((t) => !templateFits(t, widths)).map((t) => t.id)
    expect(ids(p710)).toEqual(['wifi-36', 'bin-36', 'folder-spine-36', 'name-tag-36'])
    expect(ids(p910)).toEqual([])
    expect(ids(p300)).toEqual(TEMPLATES.filter((t) => t.tapeWidthMm > 12).map((t) => t.id))
  })

  it('templateModel: the active model when it takes the width, else the stand-in; never a model without the tape', () => {
    expect(templateModel(byId('wifi-24'), 'PT-P710BT', models)).toBe('PT-P710BT')
    expect(templateModel(byId('wifi-36'), 'PT-P710BT', models)).toBe('PT-P910BT')
    expect(templateModel(byId('wifi-24'), 'PT-P300BT', models)).toBe('PT-P710BT')
    expect(templateModel(byId('wifi-12'), 'pt-p300bt', models)).toBe('PT-P300BT') // canonical name
    // Before the table is loaded (or for a name it does not know): the active model as given.
    expect(templateModel(byId('wifi-36'), 'PT-P710BT', [])).toBe('PT-P710BT')
    for (const m of models) {
      for (const t of TEMPLATES) {
        const use = templateModel(t, m.name, models)
        expect(use, `${t.id} on ${m.name}`).not.toBeNull()
        expect(() => mediaForWidth(use!, t.tapeWidthMm), `${t.id} on ${m.name}`).not.toThrow()
      }
    }
  })

  it('needsWidthText marks a width the model lacks', () => {
    expect(needsWidthText(36, 'PT-P710BT', [3.5, 6, 9, 12, 18, 24])).toBe('Needs 36 mm tape · PT-P710BT takes up to 24 mm')
    expect(needsWidthText(24, 'PT-P300BT', [3.5, 6, 9, 12])).toBe('Needs 24 mm tape · PT-P300BT takes up to 12 mm')
    expect(needsWidthText(9, 'PT-X', [3.5, 12, 24])).toBe('Needs 9 mm tape · PT-X doesn’t take it')
    expect(needsWidthText(24, 'PT-P710BT', [3.5, 6, 9, 12, 18, 24])).toBeNull()
    expect(needsWidthText(36, 'PT-P710BT', [])).toBeNull()
  })
})

describe('template helpers', () => {
  it('fitsLoadedTape compares the loaded width', () => {
    const t = { tapeWidthMm: 12 as const }
    expect(fitsLoadedTape(t, 12)).toBe(true)
    expect(fitsLoadedTape(t, 24)).toBe(false)
    expect(fitsLoadedTape(t, null)).toBe(false)
    expect(fitsLoadedTape(t, undefined)).toBe(false)
  })

  it('primaryItemId picks the Wi-Fi code, else the first text, else the first block', () => {
    const wifi = build('wifi-24')
    expect(primaryItemId(wifi)).toBe(wifi.items[2]?.id)
    const bin = build('bin-24')
    expect(primaryItemId(bin)).toBe(bin.items[1]?.id)
    expect(primaryItemId({ ...bin, items: [bin.items[0]!] })).toBe(bin.items[0]?.id)
    expect(primaryItemId({ ...bin, items: [] })).toBeNull()
  })

  it('withSampleData fills Wi-Fi codes only, without touching the template', () => {
    const doc = build('wifi-12')
    const sample = withSampleData(doc)
    expect(codes(sample)[0]?.wifi).toMatchObject(SAMPLE_WIFI)
    expect(codes(doc)[0]?.wifi?.ssid).toBe('')
    expect(sample.items[1]).toBe(doc.items[1])
    const bin = build('bin-24')
    expect(withSampleData(bin).items).toEqual(bin.items)
  })
})

describe('gridMove', () => {
  // Two sections: 3 + 2 cards in a 3-column grid, then 1 card.
  const cards: CardPoint[] = [
    { x: 100, y: 50 },
    { x: 300, y: 50 },
    { x: 500, y: 50 },
    { x: 100, y: 150 },
    { x: 300, y: 151 },
    { x: 101, y: 300 },
  ]

  it('Left/Right step in order and stop at the ends', () => {
    expect(gridMove(cards, 0, 'ArrowRight')).toBe(1)
    expect(gridMove(cards, 2, 'ArrowRight')).toBe(3)
    expect(gridMove(cards, 5, 'ArrowRight')).toBe(5)
    expect(gridMove(cards, 0, 'ArrowLeft')).toBe(0)
    expect(gridMove(cards, 3, 'ArrowLeft')).toBe(2)
  })

  it('Up/Down go to the nearest card of the next row (across sections)', () => {
    expect(gridMove(cards, 1, 'ArrowDown')).toBe(4)
    expect(gridMove(cards, 2, 'ArrowDown')).toBe(4) // no card under it: the closest in that row
    expect(gridMove(cards, 4, 'ArrowDown')).toBe(5)
    expect(gridMove(cards, 5, 'ArrowDown')).toBe(5)
    expect(gridMove(cards, 4, 'ArrowUp')).toBe(1)
    expect(gridMove(cards, 5, 'ArrowUp')).toBe(3)
    expect(gridMove(cards, 0, 'ArrowUp')).toBe(0)
  })

  it('Home/End, and -1 for other keys or a bad index', () => {
    expect(gridMove(cards, 3, 'Home')).toBe(0)
    expect(gridMove(cards, 3, 'End')).toBe(5)
    expect(gridMove(cards, 3, 'Enter')).toBe(-1)
    expect(gridMove(cards, 9, 'ArrowLeft')).toBe(-1)
    expect(gridMove([], 0, 'Home')).toBe(-1)
  })
})

describe('createTaskQueue', () => {
  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    return { promise, resolve }
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('runs at most `concurrency` tasks at a time, in order', async () => {
    const q = createTaskQueue(2)
    const gates = [deferred(), deferred(), deferred()]
    const started: number[] = []
    const results = gates.map((g, i) =>
      q.run(async () => {
        started.push(i)
        await g.promise
        return i
      }),
    )
    await flush()
    expect(started).toEqual([0, 1])
    expect(q.active).toBe(2)
    gates[1]!.resolve()
    await flush()
    expect(started).toEqual([0, 1, 2])
    gates[0]!.resolve()
    gates[2]!.resolve()
    expect(await Promise.all(results)).toEqual([0, 1, 2])
    expect(q.active).toBe(0)
  })

  it('a failing task frees its slot and rejects its own promise only', async () => {
    const q = createTaskQueue(1)
    const bad = q.run(() => Promise.reject(new Error('boom')))
    const good = q.run(() => Promise.resolve('ok'))
    await expect(bad).rejects.toThrow('boom')
    await expect(good).resolves.toBe('ok')
  })

  it('an aborted waiting task never runs; an already aborted signal rejects at once', async () => {
    const q = createTaskQueue(1)
    const gate = deferred()
    const first = q.run(() => gate.promise)
    const ac = new AbortController()
    let ran = false
    const second = q.run(async () => {
      ran = true
    }, ac.signal)
    ac.abort()
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    gate.resolve()
    await first
    await flush()
    expect(ran).toBe(false)
    await expect(q.run(async () => 1, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
  })
})

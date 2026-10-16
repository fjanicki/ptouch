// Printer models as the studio sees them (docs/MODELS-PLAN.md §2.4), against the real core table.
import { beforeAll, describe, expect, it } from 'vitest'
import { listModels, mediaForWidth, printArea, type ModelInfo } from '../../../src/wasm'
import { DEFAULT_MODEL, FALLBACK_TAPE_WIDTHS, findModel, isVerifiedModel, modelPickerGroups, modelReach, reachNote, standInModel, tapeWidthsOf, unsupportedWidthText, widthSupport } from '../../../src/ui/state/models'
import { loadWasmForTests } from '../../helpers/wasm'

let models: ModelInfo[] = []
const model = (name: string): ModelInfo => {
  const m = findModel(models, name)
  if (!m) throw new Error(`${name} is not in the table`)
  return m
}

beforeAll(() => {
  loadWasmForTests()
  models = listModels()
})

describe('tape widths per model', () => {
  it('the PT-P710BT takes 3.5–24 mm, which is also the fallback before the table loads', () => {
    expect(DEFAULT_MODEL).toBe('PT-P710BT')
    expect(tapeWidthsOf(model('PT-P710BT'))).toEqual([3.5, 6, 9, 12, 18, 24])
    expect(FALLBACK_TAPE_WIDTHS).toEqual(tapeWidthsOf(model(DEFAULT_MODEL)))
  })

  it('36 mm models, 18 mm and 12 mm models', () => {
    for (const name of ['PT-P910BT', 'PT-E920BT', 'PT-P900', 'PT-P900W', 'PT-P950NW', 'PT-D800W', 'PT-E800W', 'PT-E850TKW']) {
      expect(tapeWidthsOf(model(name)), name).toEqual([3.5, 6, 9, 12, 18, 24, 36])
    }
    for (const name of ['PT-D410', 'PT-D460BT', 'PT-E310BT', 'PT-D450']) expect(tapeWidthsOf(model(name)), name).toEqual([3.5, 6, 9, 12, 18])
    for (const name of ['PT-P300BT', 'PT-N25BT']) expect(tapeWidthsOf(model(name)), name).toEqual([3.5, 6, 9, 12])
  })

  it('leaves out heat-shrink tube, self-laminating and FLe labels', () => {
    const p900 = model('PT-P900')
    expect(p900.media.some((m) => m.kind === 'hs3' && m.widthMm === 31)).toBe(true)
    expect(p900.media.some((m) => m.kind === 'fle')).toBe(true)
    expect(tapeWidthsOf(p900)).not.toContain(31)
  })

  it('every listed width resolves to a print area (360 dpi models at 360 dpi)', () => {
    for (const m of models) {
      for (const w of tapeWidthsOf(m)) {
        const area = printArea(m.name, mediaForWidth(m.name, w).id)
        expect(area.dpi, `${m.name} ${w} mm`).toBe(m.dpi)
        expect(area.heightDots).toBeGreaterThan(0)
      }
    }
    expect(printArea('PT-P910BT', mediaForWidth('PT-P910BT', 36).id)).toMatchObject({ dpi: 360, heightDots: 454 })
  })
})

describe('reach and verification', () => {
  it('browsers reach USB and Bluetooth Classic models, not BLE-only ones', () => {
    expect(modelReach(model('PT-P710BT'))).toBe('browser')
    expect(modelReach(model('PT-P300BT'))).toBe('browser') // Bluetooth Classic, no USB
    expect(modelReach(model('PT-P750W'))).toBe('browser') // Wi-Fi, but USB too
    expect(modelReach(model('PT-N25BT'))).toBe('ble-only')
    expect(reachNote(model('PT-N25BT'))).toMatch(/Bluetooth LE only/)
    expect(reachNote(model('PT-P710BT'))).toBeNull()
    expect(modelReach({ usbPid: undefined, bluetooth: false, ble: false, network: true })).toBe('network-only')
    expect(reachNote({ bluetooth: false, ble: false, network: true })).toMatch(/Network only/)
  })

  it('picker groups: “this browser” only where the browser can connect at all (not on iPhone or Safari)', () => {
    const here = modelPickerGroups(models, true)
    expect(here.map((g) => g.label)).toEqual(['Connects from this browser', 'Design only (a browser can’t connect)'])
    expect(here[0]!.models.map((m) => m.name)).toContain('PT-P710BT')
    expect(here[1]!.models.map((m) => m.name)).toContain('PT-N25BT')
    expect(here[0]!.models.map((m) => m.name)).not.toContain('PT-N25BT')
    const designOnly = modelPickerGroups(models, false)
    expect(designOnly.map((g) => g.label)).toEqual(['Connect from Chrome or Edge on a computer', 'Design only (a browser can’t connect)'])
    expect(designOnly.some((g) => g.label.includes('this browser'))).toBe(false)
    expect(designOnly[0]!.models).toEqual(here[0]!.models)
    expect(modelPickerGroups([model('PT-P710BT')], true).map((g) => g.label)).toEqual(['Connects from this browser'])
  })

  it('only the PT-P710BT is verified', () => {
    expect(isVerifiedModel('PT-P710BT')).toBe(true)
    expect(isVerifiedModel('PT-P910BT')).toBe(false)
  })

  it('finds models by name or alias, case-insensitively', () => {
    expect(findModel(models, 'pt-p710bt')?.name).toBe('PT-P710BT')
    expect(findModel(models, 'Cube Plus')?.name).toBe('PT-P710BT')
    expect(findModel(models, 'PT-Z999BT')).toBeUndefined()
    expect(findModel(models, null)).toBeUndefined()
  })
})

describe('labels on a width the model lacks', () => {
  it('36 mm on the PT-P710BT: notice text, fit to 24 mm, preview with a 36 mm model', () => {
    const s = widthSupport('PT-P710BT', 36, tapeWidthsOf(model('PT-P710BT')), standInModel(models, 36, 'PT-P910BT'))
    expect(s).toEqual({ ok: false, model: 'PT-P710BT', widthMm: 36, widths: [3.5, 6, 9, 12, 18, 24], maxMm: 24, nearest: 24, standIn: 'PT-P910BT', message: 'This label is 36 mm; PT-P710BT takes up to 24 mm.' })
  })

  it('24 mm on the PT-P300BT fits to 12 mm; supported widths are ok', () => {
    const widths = tapeWidthsOf(model('PT-P300BT'))
    const s = widthSupport('PT-P300BT', 24, widths, standInModel(models, 24))
    expect(s.ok === false && [s.nearest, s.standIn, s.message]).toEqual([12, 'PT-P710BT', 'This label is 24 mm; PT-P300BT takes up to 12 mm.'])
    expect(widthSupport('PT-P300BT', 9, widths, null)).toEqual({ ok: true })
    // Nothing known about the model: nothing is blocked.
    expect(widthSupport('PT-Z999BT', 36, [], null)).toEqual({ ok: true })
  })

  it('the stand-in prefers the label’s own model when it takes the width', () => {
    expect(standInModel(models, 36, 'PT-E920BT')).toBe('PT-E920BT')
    expect(standInModel(models, 36, 'PT-P710BT')).toBe('PT-P910BT')
    expect(standInModel(models, 36)).toBe('PT-P910BT')
  })

  it('a gap in the widths is phrased as such', () => {
    expect(unsupportedWidthText('PT-X', 9, [6, 12])).toBe('This label is 9 mm; PT-X doesn’t take 9 mm tape.')
    expect(unsupportedWidthText('PT-X', 3.5, [6, 12])).toBe('This label is 3.5 mm; PT-X doesn’t take 3.5 mm tape.')
  })
})

describe('templates per model (frozen hook, docs/MODELS-PLAN.md §4.8)', () => {
  it('templateFits follows the model’s widths', async () => {
    const { TEMPLATES, templateFits } = await import('../../../src/ui/templates/templates')
    const p300 = tapeWidthsOf(model('PT-P300BT'))
    expect(TEMPLATES.filter((t) => templateFits(t, p300)).every((t) => t.tapeWidthMm <= 12)).toBe(true)
    expect(TEMPLATES.every((t) => templateFits(t, tapeWidthsOf(model('PT-P910BT'))))).toBe(true)
  })
})

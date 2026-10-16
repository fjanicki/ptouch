// P-core-ui (docs/MODELS-PLAN.md §3.6–§3.8, §3.11) — model-generic copy: the connect dialog, the
// model picker's options, the "untested model" notice and its issue link, the hand-off subtitle,
// the Diagnostics report's model section and the virtual printer scenario of any model. Examples
// name the PT-P710BT with a masked device name only.
import { beforeAll, describe, expect, it } from 'vitest'
import { INITIAL_SNAPSHOT, LINUX_USB_DETACH_FLAG, PacketLog, detectSupport } from '../../../src/printer'
import { listModels, printArea, type ModelInfo } from '../../../src/wasm'
import { findModel, standInModel, tapeWidthsOf, widthSupport } from '../../../src/ui/state/models'
import { EXAMPLE_DEVICE, ISSUES_URL, connectSubtitle, connectedModelText, modelOptionText, optionHints, untestedIssueUrl, untestedModelText } from '../../../src/ui/connect/copy'
import { handoffCopy, handoffModel } from '../../../src/ui/handoff/handoff'
import { buildReport } from '../../../src/ui/diagnostics/report'
import { virtualScenarioFor } from '../../../src/ui/state/virtual-printer'
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

/** Every string the helpers produce for any model and option. */
function allCopy(): string[] {
  const out: string[] = []
  for (const designOnly of [false, true])
    for (const bluetooth of [false, true])
      for (const port of [false, true]) for (const usb of [false, true]) out.push(connectSubtitle({ designOnly, designModel: 'PT-P910BT', bluetooth, port, usb }))
  for (const gecko of [false, true]) for (const bluetooth of [false, true]) for (const linux of [false, true]) out.push(...Object.values(optionHints({ gecko, bluetooth, linux, designModel: 'PT-P910BT' })))
  return out
}

describe('connect dialog copy', () => {
  it('is model-generic: the PT-P710BT appears only as an example, with a masked device name', () => {
    expect(EXAMPLE_DEVICE).toBe('PT-P710BTxxxx')
    for (const text of allCopy()) {
      for (const m of text.matchAll(/PT-P710BT\w*/g)) {
        const before = text.slice(0, m.index)
        expect(m[0] === 'PT-P710BT' || m[0] === EXAMPLE_DEVICE, text).toBe(true)
        // Inside an "(e.g. …)" aside: an "e.g." before it that no ")" closed yet.
        expect(before.lastIndexOf('e.g.') > before.lastIndexOf(')'), `"${m[0]}" is not an example in: ${text}`).toBe(true)
      }
      expect(text).not.toMatch(/Brother PT-P710BT/)
    }
  })

  it('the subtitle follows the paths this browser offers, USB included', () => {
    expect(connectSubtitle({ designOnly: false, designModel: 'PT-P710BT', bluetooth: true, port: true, usb: true })).toBe(
      'Your Brother P-touch label printer (e.g. PT-P710BT) over Bluetooth or USB. Nothing is installed and nothing leaves this browser.',
    )
    expect(connectSubtitle({ designOnly: false, designModel: 'PT-P710BT', bluetooth: false, port: true, usb: false })).toMatch(/over its Bluetooth serial port\./)
    expect(connectSubtitle({ designOnly: true, designModel: 'PT-P910BT', bluetooth: false, port: false, usb: false })).toBe(
      'This browser can’t connect to printers. Use “No printer” to design and test with a virtual PT-P910BT.',
    )
  })

  it('option hints: “No printer” names the Design-for model, USB stays the reliable one', () => {
    const h = optionHints({ gecko: false, bluetooth: true, linux: false, designModel: 'PT-P910BT' })
    expect(h.virtual).toBe('Design and test with a virtual PT-P910BT.')
    expect(h.usb).toMatch(/^Most reliable/)
    expect(h.bluetooth).toBe('Pair the printer in system settings first, then pick it (e.g. “PT-P710BTxxxx”).')
    expect(optionHints({ gecko: true, bluetooth: false, linux: false, designModel: 'PT-P710BT' }).bluetooth).toMatch(/its “cu\.” port \(e\.g\. “cu\.PT-P710BTxxxx”\)/)
    expect(optionHints({ gecko: false, bluetooth: false, linux: false, designModel: 'PT-P710BT' })['serial-port']).toMatch(/or its COM port\.$/)
  })

  it('USB hint: Linux names the AutomaticUsbDetach flag up front (usblp holds the printer otherwise)', () => {
    const linux = optionHints({ gecko: false, bluetooth: true, linux: true, designModel: 'PT-P710BT' }).usb
    expect(linux).toBe(`Most reliable: answers instantly, no pairing or waking. On Linux, start the browser with ${LINUX_USB_DETACH_FLAG} first.`)
    expect(linux).toContain('--enable-features=AutomaticUsbDetach')
    const other = optionHints({ gecko: false, bluetooth: true, linux: false, designModel: 'PT-P710BT' }).usb
    expect(other).toBe('Most reliable: answers instantly, no pairing or waking. Close P-touch Editor first.')
  })

  it('the media bar names the connected model and how it is connected', () => {
    expect(connectedModelText('PT-P910BT', 'usb')).toBe('PT-P910BT (connected)')
    expect(connectedModelText('PT-P910BT', 'virtual')).toBe('PT-P910BT (virtual printer)')
  })
})

describe('model picker options', () => {
  it('max width, and “tested” for the hardware-verified model only', () => {
    expect(modelOptionText(model('PT-P710BT'))).toBe('PT-P710BT · up to 24 mm · tested')
    expect(modelOptionText(model('PT-P910BT'))).toBe('PT-P910BT · up to 36 mm')
    expect(modelOptionText(model('PT-P300BT'))).toBe('PT-P300BT · up to 12 mm')
    expect(modelOptionText(model('PT-D460BT'))).toBe('PT-D460BT · up to 18 mm')
    expect(modelOptionText(model('PT-N25BT'))).toBe('PT-N25BT · up to 12 mm')
  })
})

describe('untested model notice', () => {
  it('says the model has not been tested and asks for a report', () => {
    expect(untestedModelText('PT-P910BT')).toBe('PT-P910BT hasn’t been tested with ptouch studio yet. Printing should work; if anything looks wrong, please report it.')
  })

  it('the issue link carries the model and connection kind, never a device name or address', () => {
    const url = new URL(untestedIssueUrl('PT-P910BT', 'USB'))
    expect(`${url.origin}${url.pathname}`).toBe(ISSUES_URL)
    expect(url.searchParams.get('title')).toBe('Untested model: PT-P910BT')
    const body = url.searchParams.get('body') ?? ''
    expect(body).toMatch(/^Model: PT-P910BT\nConnection: USB\n/)
    expect(body).toMatch(/Copy diagnostics/)
    expect(body).not.toMatch(/[0-9A-F]{2}:[0-9A-F]{2}:/i)
    expect(new URL(untestedIssueUrl('PT-E920BT')).searchParams.get('body')).toMatch(/Connection: unknown/)
  })
})

describe('hand-off copy names a non-default model', () => {
  it('only when a model is passed', () => {
    expect(handoffCopy({ designOnly: true, canShare: true }).description).toBe('Print this label from a Mac or PC with Chrome or Edge.')
    expect(handoffCopy({ designOnly: true, canShare: true, model: null, widthMm: 24 }).description).toBe('Print this label from a Mac or PC with Chrome or Edge.')
    expect(handoffCopy({ designOnly: true, canShare: true, model: 'PT-P910BT', widthMm: 36 }).description).toBe(
      'Print this label from a Mac or PC with Chrome or Edge. It is designed for a PT-P910BT on 36 mm tape.',
    )
    expect(handoffCopy({ designOnly: false, canShare: false, model: 'PT-P300BT' }).description).toMatch(/another computer.*designed for a PT-P300BT\.$/)
  })

  it('never names a model that lacks the label’s width: the model it was made for, and the notice', () => {
    const models = listModels()
    const ok = { ok: true } as const
    expect(handoffModel('PT-P910BT', 'PT-P710BT', ok)).toEqual({ model: 'PT-P910BT' })
    expect(handoffModel('PT-P710BT', 'PT-P710BT', ok)).toEqual({ model: null })

    // Designing for a PT-P300BT (up to 12 mm), a 24 mm label (made on the PT-P710BT).
    const p300 = widthSupport('PT-P300BT', 24, tapeWidthsOf(model('PT-P300BT')), standInModel(models, 24, 'PT-P710BT'))
    const small = handoffCopy({ designOnly: true, canShare: true, ...handoffModel('PT-P300BT', 'PT-P710BT', p300), widthMm: 24 }).description
    expect(small).toBe('Print this label from a Mac or PC with Chrome or Edge. It is designed for a PT-P710BT on 24 mm tape. This label is 24 mm; PT-P300BT takes up to 12 mm.')
    expect(small).not.toMatch(/designed for a PT-P300BT/)

    // The default model and a 36 mm label made for a PT-P910BT: named, with the notice.
    const p710 = widthSupport('PT-P710BT', 36, tapeWidthsOf(model('PT-P710BT')), standInModel(models, 36, 'PT-P910BT'))
    expect(handoffCopy({ designOnly: true, canShare: true, ...handoffModel('PT-P710BT', 'PT-P710BT', p710), widthMm: 36 }).description).toBe(
      'Print this label from a Mac or PC with Chrome or Edge. It is designed for a PT-P910BT on 36 mm tape. This label is 36 mm; PT-P710BT takes up to 24 mm.',
    )
  })
})

describe('diagnostics report: printer model', () => {
  const support = detectSupport({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36', serial: { requestPort() {}, getPorts() {} }, usb: {} })

  it('names the model, where it comes from, whether it was tested, its widths and the label width', () => {
    const text = buildReport(support, INITIAL_SNAPSHOT, new PacketLog(), {
      now: new Date(0),
      userAgent: 'UA',
      model: { model: 'PT-P910BT', source: 'printer', designModel: 'PT-P710BT', tested: false, tapeWidths: [3.5, 6, 9, 12, 18, 24, 36], labelWidthMm: 36, widthOk: true },
    })
    expect(text).toContain('## Printer model')
    expect(text).toContain('model:             PT-P910BT (connected printer, untested)')
    expect(text).toContain('design for:        PT-P710BT')
    expect(text).toContain('tape widths:       3.5, 6, 9, 12, 18, 24, 36 mm')
    expect(text).toContain('label tape:        36 mm')
    const design = buildReport(support, INITIAL_SNAPSHOT, new PacketLog(), {
      now: new Date(0),
      model: { model: 'PT-P710BT', source: 'design', designModel: 'PT-P710BT', tested: true, tapeWidths: [3.5, 6, 9, 12, 18, 24], labelWidthMm: 36, widthOk: false },
    })
    expect(design).toContain('model:             PT-P710BT (design for, tested)')
    expect(design).not.toContain('design for:  ')
    expect(design).toContain('label tape:        36 mm (not taken by this model)')
  })
})

describe('virtual printer of any model', () => {
  it('loads the widest TZe tape of the model', () => {
    expect(virtualScenarioFor(model('PT-P710BT'))).toEqual({ model: 'PT-P710BT', mediaId: 'tze128-24' })
    const p910 = virtualScenarioFor(model('PT-P910BT'))
    expect(p910).toEqual({ model: 'PT-P910BT', mediaId: 'tze560-36' })
    expect(printArea('PT-P910BT', p910.mediaId!)).toMatchObject({ dpi: 360, heightDots: 454 })
    expect(virtualScenarioFor(model('PT-P300BT')).mediaId).toMatch(/-12$/)
    expect(virtualScenarioFor(undefined)).toEqual({})
  })
})

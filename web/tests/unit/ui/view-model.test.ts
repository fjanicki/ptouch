// W4 — pure UI helpers: status chip, print gating, progress copy, mismatch, zoom, summaries.
import { describe, expect, it } from 'vitest'
import { createDoc, createItem, type LabelDoc } from '../../../src/doc/schema'
import type { ConnectionSnapshot } from '../../../src/printer'
import type { MediaInfo, PrinterStatus } from '../../../src/wasm'
import {
  batteryText,
  chipLabel,
  chipView,
  connectFailed,
  clampCopies,
  docIsEmpty,
  fitScale,
  formatMm,
  itemSummary,
  mediaMismatch,
  openProgressText,
  previewColors,
  printBlockReason,
  printButtonText,
  progressFraction,
  progressText,
  realScale,
  rulerSteps,
  zoomPercent,
  zoomStep,
  type PrintGate,
} from '../../../src/ui/state/view-model'

const MEDIA_24: MediaInfo = {
  id: 'tze128-24',
  kind: 'tze',
  widthMm: 24,
  widthByte: 24,
  printPins: 128,
  leftMarginPins: 0,
  rightMarginPins: 0,
  tapeWidthDots: 170,
  defaultFeedDots: 14,
}
const MEDIA_12: MediaInfo = { ...MEDIA_24, id: 'tze70-12', widthMm: 12, widthByte: 12, printPins: 70, tapeWidthDots: 85 }

// Shape of the real PT-P710BT reply (24 mm laminated white tape, black text).
const STATUS_24: PrinterStatus = {
  modelName: 'PT-P710BT',
  seriesCode: 0x30,
  modelCode: 0x76,
  ready: true,
  error: false,
  turnedOff: false,
  errors: [],
  mediaWidthMm: 24,
  mediaTypeByte: 1,
  mediaType: 'laminated',
  mediaId: 'tze128-24',
  mediaLengthMm: 0,
  statusType: 'reply',
  phase: { kind: 'receiving', number: 0 },
  notification: 'none',
  tapeColor: { byte: 1, name: 'white', css: '#ffffff' },
  textColor: { byte: 8, name: 'black', css: '#000000' },
  battery: { weak: false },
  raw: [],
}

const BASE: ConnectionSnapshot = {
  path: null,
  state: 'disconnected',
  transport: null,
  model: null,
  status: null,
  media: null,
  openProgress: null,
  progress: null,
  problem: null,
}

function snap(patch: Partial<ConnectionSnapshot>): ConnectionSnapshot {
  return { ...BASE, ...patch }
}

const READY = snap({
  path: 'bluetooth',
  state: 'ready',
  transport: { kind: 'serial-rfcomm', label: 'PT-P710BTxxxx', persistentGrant: true },
  model: 'PT-P710BT',
  status: STATUS_24,
  media: MEDIA_24,
})

function doc(widthMm: LabelDoc['tape']['widthMm'] = 24): LabelDoc {
  return createDoc({ tape: { widthMm } })
}

describe('formatting', () => {
  it('formats millimetres without a trailing .0', () => {
    expect(formatMm(24)).toBe('24 mm')
    expect(formatMm(3.5)).toBe('3.5 mm')
    expect(formatMm(42.345)).toBe('42.3 mm')
    expect(formatMm(12.04, 0)).toBe('12 mm')
  })
  it('describes the battery', () => {
    expect(batteryText(undefined)).toBeNull()
    expect(batteryText({ weak: true, source: 'battery' })).toBe('Battery low')
    expect(batteryText({ weak: false, source: 'ac' })).toBe('On AC power')
    expect(batteryText({ weak: false, percent: 79.6 })).toBe('Battery 80 %')
    expect(batteryText({ weak: false })).toBeNull()
  })
  it('shows the waking state from open retries', () => {
    expect(openProgressText(null)).toBe('Opening the connection…')
    expect(openProgressText({ attempt: 1, of: 3 })).toBe('Opening the connection…')
    expect(openProgressText({ attempt: 2, of: 3 })).toBe('Waking printer… (attempt 2 of 3)')
    // A slow first RFCOMM open (state 'waking' before any retry) explains the delay.
    expect(openProgressText({ attempt: 1, of: 3 }, 'waking')).toBe('Waking printer… this can take up to 10 s')
  })
})

describe('chipView', () => {
  it('offers to connect when disconnected', () => {
    expect(chipView(BASE)).toMatchObject({ tone: 'idle', text: 'Connect printer', busy: false })
  })
  it('shows model, tape and colours when ready', () => {
    const v = chipView(READY)
    expect(v.tone).toBe('ok')
    expect(v.text).toBe('PT-P710BT · 24 mm')
    expect(v.detail).toBe('Bluetooth · 24 mm white / black')
  })
  it('shows waking with the attempt', () => {
    const v = chipView(snap({ state: 'waking', openProgress: { attempt: 2, of: 3 } }))
    expect(v).toMatchObject({ tone: 'busy', text: 'Waking printer…', busy: true })
    expect(v.detail).toBe('Attempt 2 of 3')
    expect(chipLabel(v)).toBe('Connection: Waking printer… Attempt 2 of 3')
    expect(chipLabel(chipView(snap({ state: 'opening', transport: { kind: 'serial-rfcomm', label: 'x', persistentGrant: true } })))).toBe('Connection: Connecting… Bluetooth')
    expect(chipLabel({ text: 'Waking printer…', detail: 'Waking printer… (attempt 2 of 3)' })).toBe('Connection: Waking printer… (attempt 2 of 3)')
  })
  it('flags a missing tape cassette', () => {
    const v = chipView({ ...READY, media: null, status: { ...STATUS_24, mediaWidthMm: 0, mediaType: 'none' } })
    expect(v).toMatchObject({ tone: 'warn', text: 'PT-P710BT · no tape' })
  })
  it('maps asleep / lost / printing', () => {
    expect(chipView(snap({ state: 'no-reply' })).text).toBe('Printer asleep?')
    expect(chipView(snap({ state: 'lost' })).tone).toBe('error')
    expect(chipView({ ...READY, state: 'printing', progress: { page: 2, of: 3, phase: 'printing' } }).text).toBe('Printing 2/3')
    const problem = { id: 'open-failed' as const, severity: 'error' as const, title: 'Couldn’t connect to the printer', detail: '', actions: [] }
    // A connection that never opened is not a printer fault.
    expect(chipView(snap({ state: 'error', problem }))).toMatchObject({ tone: 'error', text: 'Couldn’t connect', detail: problem.title })
    expect(connectFailed(snap({ state: 'error', problem }))).toBe(true)
    const fault = { ...problem, id: 'printer-error' as const, title: 'The printer reported an error' }
    expect(chipView(snap({ state: 'error', problem: fault }))).toMatchObject({ text: 'Printer problem', detail: fault.title })
    expect(chipView(snap({ state: 'error', problem: { ...fault, title: 'Cover open' } })).text).toBe('Cover open')
  })
  it('follows the Firefox no-reply guidance instead of "press the power button"', () => {
    const problem = { id: 'no-reply-firefox' as const, severity: 'error' as const, title: 'The printer isn’t answering in Firefox', detail: '', actions: [] }
    const v = chipView(snap({ state: 'no-reply', problem }))
    expect(v.text).toBe('No reply')
    expect(v.detail).toMatch(/Chrome or Edge/)
  })
})

describe('media', () => {
  it('detects a tape mismatch only while connected', () => {
    expect(mediaMismatch(READY, doc(24))).toBeNull()
    expect(mediaMismatch(READY, doc(12))).toEqual({ loadedMm: 24, designMm: 12, media: MEDIA_24 })
    expect(mediaMismatch({ ...READY, state: 'lost' }, doc(12))).toBeNull()
    expect(mediaMismatch(BASE, doc(12))).toBeNull()
  })
  it('uses the printer colours only when its tape matches the design', () => {
    expect(previewColors(READY, doc(24))).toEqual({ tape: '#ffffff', ink: '#000000', fromPrinter: true })
    const yellow = { ...READY, status: { ...STATUS_24, tapeColor: { byte: 3, name: 'yellow', css: '#ffd400' } } }
    expect(previewColors(yellow, doc(24)).tape).toBe('#ffd400')
    const offline = createDoc({ tape: { widthMm: 12, colors: { tape: '#c8102e', ink: '#ffffff' } } })
    expect(previewColors({ ...READY, media: MEDIA_12 }, offline)).toEqual({ tape: '#ffffff', ink: '#000000', fromPrinter: true })
    expect(previewColors(BASE, offline)).toEqual({ tape: '#c8102e', ink: '#ffffff', fromPrinter: false })
  })
})

describe('printBlockReason', () => {
  const ok: PrintGate = { wasm: 'ready', renderError: null, hasRender: true, blocking: null, isEmpty: false, conn: READY, mismatch: null }
  it('allows printing when everything is ready', () => {
    expect(printBlockReason(ok)).toBeNull()
  })
  it.each([
    [{ wasm: 'loading' as const }, /Loading/],
    [{ wasm: 'error' as const }, /failed to load/],
    [{ isEmpty: true }, /Add something/],
    [{ renderError: 'boom' }, /could not be rendered/],
    [{ hasRender: false }, /Preparing/],
    [{ blocking: { message: 'Canvas readback is randomized' } }, /Canvas readback/],
    [{ conn: BASE }, /Connect a printer/],
    [{ conn: { ...READY, state: 'printing' as const } }, /printing/],
    [{ conn: { ...READY, state: 'waking' as const } }, /Connecting/],
    [{ conn: { ...READY, state: 'no-reply' as const } }, /not answering/],
    [{ conn: { ...READY, state: 'lost' as const } }, /Reconnect/],
    [{ conn: { ...READY, status: { ...STATUS_24, mediaType: 'none', mediaWidthMm: 0 } } }, /No tape/],
    [{ conn: { ...READY, status: { ...STATUS_24, error: true, errors: [{ id: 'cover-open', message: 'Cover open' }] } } }, /Cover open/],
    [{ mismatch: { loadedMm: 12, designMm: 24, media: MEDIA_12 } }, /has 12 mm tape; this label is 24 mm/],
    [{ canPrint: false, conn: BASE }, /needs Chrome or Edge/],
    [{ conn: { ...BASE, state: 'error' as const, problem: { id: 'open-failed' as const, severity: 'error' as const, title: 'x', detail: '', actions: [] } } }, /^Connect a printer/],
    [{ conn: { ...READY, state: 'error' as const, problem: { id: 'printer-error' as const, severity: 'error' as const, title: 'x', detail: '', actions: [] } } }, /Fix the printer problem/],
    [{ conn: { ...BASE, state: 'no-reply' as const, problem: { id: 'no-reply-firefox' as const, severity: 'error' as const, title: 'x', detail: '', actions: [] } } }, /Firefox.*Chrome or Edge/],
  ])('blocks: %o', (patch, re) => {
    expect(printBlockReason({ ...ok, ...patch })).toMatch(re)
  })
})

describe('print copy', () => {
  it('labels the button by copies', () => {
    expect(printButtonText(1)).toBe('Print label')
    expect(printButtonText(3)).toBe('Print 3 labels')
  })
  it('phrases progress by page and phase', () => {
    expect(progressText(null)).toBe('Starting…')
    expect(progressText({ page: 1, of: 1, phase: 'sending' })).toBe('Sending label…')
    expect(progressText({ page: 2, of: 3, phase: 'printing' })).toBe('Printing label 2 of 3…')
    expect(progressText({ page: 3, of: 3, phase: 'done' })).toBe('Finishing…')
  })
  it('progress fraction is monotonic over a job', () => {
    const seq = [
      { page: 1, of: 2, phase: 'sending' as const },
      { page: 1, of: 2, phase: 'printing' as const },
      { page: 1, of: 2, phase: 'done' as const },
      { page: 2, of: 2, phase: 'sending' as const },
      { page: 2, of: 2, phase: 'printing' as const },
      { page: 2, of: 2, phase: 'done' as const },
    ].map(progressFraction)
    expect(seq).toEqual([...seq].sort((a, b) => a - b))
    expect(seq.at(-1)).toBe(1)
  })
  it('clamps copies to 1–99', () => {
    expect(clampCopies(0)).toBe(1)
    expect(clampCopies(3.6)).toBe(4)
    expect(clampCopies(500)).toBe(99)
    expect(clampCopies(Number.NaN)).toBe(1)
  })
})

describe('zoom', () => {
  it('real size is 96 CSS px per inch', () => {
    expect(realScale(180)).toBeCloseTo(0.5333, 3)
    expect(zoomPercent(realScale(180) * 2, 180)).toBe('200 %')
  })
  it('fit is limited by width, height and an 8× cap', () => {
    expect(fitScale(1000, 170, 500, 300, 180)).toBeCloseTo(0.5)
    expect(fitScale(100, 170, 2000, 300, 180)).toBeCloseTo(realScale(180) * 8 > 300 / 170 ? 300 / 170 : realScale(180) * 8)
    expect(fitScale(0, 0, 0, 0, 180)).toBe(realScale(180))
  })
  it('steps through zoom levels', () => {
    expect(zoomStep(1, 1)).toBe(1.5)
    expect(zoomStep(1, -1)).toBe(0.75)
    expect(zoomStep(2.2, -1)).toBe(2)
    expect(zoomStep(16, 1)).toBe(16)
    expect(zoomStep(0.5, -1)).toBe(0.5)
  })
  it('ruler ticks stay readable', () => {
    expect(rulerSteps(10)).toEqual({ minor: 1, label: 5 })
    expect(rulerSteps(3.78)).toEqual({ minor: 2, label: 10 })
    expect(rulerSteps(1)).toEqual({ minor: 5, label: 50 })
  })
})

describe('blocks', () => {
  it('summarises items', () => {
    const text = { ...createItem('text'), text: '\n  M3 × 12 \nDIN 912' }
    expect(itemSummary(text)).toEqual({ title: 'Text', summary: 'M3 × 12' })
    expect(itemSummary({ ...createItem('text'), text: '  ' }).summary).toBe('(empty)')
    expect(itemSummary({ ...createItem('code'), symbology: 'ean13', data: '400638133393' })).toEqual({ title: 'EAN-13', summary: '400638133393' })
    expect(itemSummary(createItem('icon'), () => 'Bolt').summary).toBe('Bolt')
    expect(itemSummary(createItem('spacer')).summary).toBe('5 mm')
    expect(itemSummary(createItem('image')).summary).toBe('No image chosen')
  })
  it('knows when a label is empty', () => {
    expect(docIsEmpty({ items: [createItem('spacer')] })).toBe(true)
    expect(docIsEmpty({ items: [{ ...createItem('text'), text: ' ' }] })).toBe(true)
    expect(docIsEmpty({ items: [createItem('text')] })).toBe(false)
    expect(docIsEmpty({ items: [], frame: { thicknessMm: 0.5, radiusMm: 0, insetMm: 0 } })).toBe(false)
  })
})

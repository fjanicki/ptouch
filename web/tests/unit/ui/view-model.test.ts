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
  KIND_META,
  itemSummary,
  piecesText,
  pieceListText,
  handPiecesText,
  shortPieceHint,
  shortPieceHintFor,
  shortPieceMm,
  safePieceMm,
  pieceLengthHint,
  cutSummary,
  cutNeighbours,
  mediaMismatch,
  openProgressText,
  previewColors,
  printBlockReason,
  printerModel,
  themeColorMedia,
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
  it('designs for the printer’s model only while its link is up (a lost link falls back to Design for)', () => {
    expect(printerModel(READY)).toBe('PT-P710BT')
    expect(printerModel({ ...READY, model: null })).toBe('PT-P710BT') // from the status
    expect(printerModel({ ...READY, state: 'printing' })).toBe('PT-P710BT')
    expect(printerModel({ ...READY, state: 'handshaking' })).toBe('PT-P710BT')
    for (const state of ['lost', 'no-reply', 'error', 'disconnected'] as const) expect(printerModel({ ...READY, state })).toBeNull()
    expect(printerModel(BASE)).toBeNull()
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
    expect(printBlockReason({ ...ok, missingVariables: [] })).toBeNull()
  })
  it.each([
    [{ wasm: 'loading' as const }, /Loading/],
    [{ wasm: 'error' as const }, /failed to load/],
    [{ isEmpty: true }, /Add something/],
    [{ renderError: 'boom' }, /could not be rendered/],
    [{ hasRender: false }, /Preparing/],
    [{ blocking: { message: 'Canvas readback is randomized' } }, /Canvas readback/],
    [{ missingVariables: ['room'] }, /^Unknown variable \{\{room\}\}: add a column/],
    [{ missingVariables: ['a', 'b'], canPrint: false }, /^Unknown variables \{\{a\}\}, \{\{b\}\}/],
    [{ columnsWithoutData: ['name'] }, /^The data table has no rows, so \{\{name\}\} would print blank/],
    [{ conn: BASE }, /Connect a printer/],
    [{ conn: { ...READY, state: 'printing' as const } }, /printing/],
    [{ conn: { ...READY, state: 'waking' as const } }, /Connecting/],
    [{ conn: { ...READY, state: 'no-reply' as const } }, /not answering/],
    [{ conn: { ...READY, state: 'lost' as const } }, /Reconnect/],
    [{ conn: { ...READY, status: { ...STATUS_24, mediaType: 'none', mediaWidthMm: 0 } } }, /No tape/],
    [{ conn: { ...READY, status: { ...STATUS_24, error: true, errors: [{ id: 'cover-open', message: 'Cover open' }] } } }, /Cover open/],
    [{ mismatch: { loadedMm: 12, designMm: 24, media: MEDIA_12 } }, /has 12 mm tape; this label is 24 mm/],
    [{ canPrint: false, conn: BASE }, /needs Chrome or Edge/],
    // A width the model lacks wins over the tape mismatch and the connection (docs/MODELS-PLAN.md).
    [{ unsupportedWidth: 'This label is 36 mm; PT-P710BT takes up to 24 mm. Fit it to 24 mm to print it.', mismatch: { loadedMm: 24, designMm: 36, media: MEDIA_12 }, conn: BASE }, /^This label is 36 mm; PT-P710BT takes up to 24 mm/],
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
    expect(itemSummary({ ...createItem('table'), cells: [['DO', 'RE', 'MI', 'FA', 'SOL', 'LA', 'SI'], ['C', 'D', 'E', 'F', 'G', 'A', 'B']] })).toEqual({ title: 'Table', summary: '2 × 7 · DO RE MI FA SOL LA SI' })
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

describe('themeColorMedia', () => {
  const light = '(prefers-color-scheme: light)'
  const dark = '(prefers-color-scheme: dark)'
  it('keeps the system media queries', () => {
    expect(themeColorMedia(light, 'system')).toBe(light)
    expect(themeColorMedia(dark, 'system')).toBe(dark)
  })
  it('enables only the chosen theme colour', () => {
    expect([themeColorMedia(light, 'dark'), themeColorMedia(dark, 'dark')]).toEqual(['not all', 'all'])
    expect([themeColorMedia(light, 'light'), themeColorMedia(dark, 'light')]).toEqual(['all', 'not all'])
  })
})

describe('tables', () => {
  it('KIND_META, docIsEmpty', () => {
    expect(KIND_META.table).toEqual({ label: 'Table', icon: 'table' })
    expect(docIsEmpty(createDoc({ items: [{ ...createItem('table'), cells: [['', ' ']] }] }))).toBe(true)
    expect(docIsEmpty(createDoc({ items: [{ ...createItem('table'), cells: [['', 'x']] }] }))).toBe(false)
  })

  it('piecesText: the pieces the printer cuts, with the feed margins', () => {
    expect(piecesText([20], 2)).toBeNull()
    expect(piecesText([21.1, 21.1, 21.1], 2)).toBe('Cut into 3 pieces · about 25.1 mm each (21.1 mm printed + 2 × 2 mm feed)')
    expect(piecesText([20, 22], 2)).toBe('Cut into 2 pieces · about 24 mm to 26 mm each (incl. 2 × 2 mm feed)')
  })
})

describe('Cut blocks (docs/CUT-PLAN.md §4)', () => {
  it('KIND_META and the summary before the first render', () => {
    expect(KIND_META.cut).toEqual({ label: 'Cut', icon: 'scissors' })
    expect(itemSummary(createItem('cut'))).toEqual({ title: 'Cut', summary: 'Cut the strip here' })
    expect(docIsEmpty({ items: [createItem('cut')] })).toBe(true)
  })

  it('pieceListText: 2–8 pieces listed, equal pieces "each", 9+ as a range', () => {
    expect(pieceListText([26.5], 2)).toBeNull()
    expect(pieceListText([26.5, 25.1, 27.9], 2)).toBe('Cut into 3 pieces: about 30.5, 29.1 and 31.9 mm, each incl. 2 × 2 mm feed')
    expect(pieceListText([26, 26], 2)).toBe('Cut into 2 pieces: about 30 mm each, incl. 2 × 2 mm feed')
    expect(pieceListText(Array.from({ length: 9 }, () => 21.1), 2)).toBe(piecesText(Array.from({ length: 9 }, () => 21.1), 2))
  })

  it('handPiecesText: the pieces to cut apart at the marks', () => {
    expect(handPiecesText([28.5])).toBeNull()
    expect(handPiecesText([28.5, 25.1, 29.9])).toBe('3 pieces to cut apart at the marks: about 28.5, 25.1 and 29.9 mm')
    expect(handPiecesText([10, 12, 12, 12, 12, 12, 12, 12, 14])).toBe('9 pieces to cut apart at the marks: about 10 to 14 mm')
    // Equal lengths once: not "about 27 and 27 mm".
    expect(handPiecesText([26.98, 27.02])).toBe('2 pieces to cut apart at the marks: about 27 mm each')
  })

  it('shortPieceHint: below the head-to-cutter distance, 24.5 mm at 180 dpi and 27 mm at 360 dpi', () => {
    expect(shortPieceMm(180)).toBe(24.5)
    expect(shortPieceMm(360)).toBe(27)
    expect(shortPieceHint([30], 2, 180)).toBeNull()
    expect(shortPieceHint([21, 21], 2, 180)).toBeNull() // 25 mm as cut
    expect(shortPieceHint([13.4, 30], 2, 180)).toBe(
      'Piece 1 is about 17.4 mm. Pieces shorter than about 24.5 mm as cut have not been checked on a printer yet and may come out longer. To be sure, set a fixed length of 21 mm (about 25 mm as cut).',
    )
    expect(shortPieceHint([10, 30, 12], 2, 180)).toMatch(/^Pieces 1 and 3 are about 14 and 16 mm\. /)
    // Equal lengths once.
    expect(shortPieceHint([10, 10, 30], 2, 180)).toMatch(/^Pieces 1 and 2 are both about 14 mm\. /)
    expect(shortPieceHint([10, 10, 10.01, 30], 2, 180)).toMatch(/^Pieces 1, 2 and 3 are each about 14 mm\. /)
    // 360 dpi: 1 mm feed, 27 mm threshold.
    expect(shortPieceHint([24, 30], 1, 360)).toMatch(/^Piece 1 is about 26 mm\. Pieces shorter than about 27 mm/)
    expect(shortPieceHint([25, 30], 1, 360)).toBeNull()
    // The real threshold: 24.6 mm as cut is not under 24.5 mm; 24.46 mm is, and is not shown as
    // "24.5 mm" (shorter than about 24.5 mm).
    expect(shortPieceHint([20.6, 30], 2, 180)).toBeNull()
    expect(shortPieceHint([20.46, 30], 2, 180)).toMatch(/^Piece 1 is about 24\.4 mm\. Pieces shorter than about 24\.5 mm as cut /)
    expect(shortPieceHint([10, 10, 10, 10, 10, 10, 10, 10, 10, 30], 2, 180)).toMatch(/^9 pieces are shorter than about 24\.5 mm\. /)
  })

  it('shortPieceHint: the fixed length it suggests clears the hint, with the real feed of each model', () => {
    // PT-P710BT: 14-dot feed at 180 dpi; PT-P910BT: 14-dot feed at 360 dpi (0.99 mm).
    for (const dpi of [180, 360]) {
      const feed = (14 * 25.4) / dpi
      const safe = safePieceMm(feed, dpi)
      const asPrinted = (mm: number): number => (Math.round((mm * dpi) / 25.4) * 25.4) / dpi
      expect(shortPieceHint([asPrinted(safe), asPrinted(safe)], feed, dpi), `${dpi} dpi, ${safe} mm`).toBeNull()
      expect(shortPieceHint([asPrinted(safe - 1), 40], feed, dpi), `${dpi} dpi, ${safe - 1} mm`).toMatch(new RegExp(`set a fixed length of ${safe} mm`))
    }
    expect(safePieceMm((14 * 25.4) / 180, 180)).toBe(21)
    // 25 mm at 360 dpi is 354 dots = 24.98 mm, + 2 × 0.99 mm = 26.95 mm: still short of 27 mm.
    expect(safePieceMm((14 * 25.4) / 360, 360)).toBe(26)
    expect(shortPieceHint([(354 * 25.4) / 360, (354 * 25.4) / 360], (14 * 25.4) / 360, 360)).toMatch(/^Pieces 1 and 2 are both about 26\.9 mm\. Pieces shorter than about 27 mm as cut .* set a fixed length of 26 mm/)
  })

  it('shortPieceHint: a fixed length only when every piece fits in it; table column pieces get their own tip', () => {
    // A long piece next to the short one: a fixed length of 21 mm would cut it off.
    const spacer = shortPieceHint([13.4, 60], 2, 180, { longestAutoMm: 60 })
    expect(spacer).toMatch(/To be sure, lengthen the short pieces to about 25 mm or more as cut \(21 mm printed\), e\.g\. with a Spacer \(a fixed length would cut off the longer pieces\)\.$/)
    expect(spacer).not.toMatch(/set a fixed length/)
    expect(shortPieceHint([13.4, 20], 2, 180, { longestAutoMm: 20 })).toMatch(/set a fixed length of 21 mm/)
    // Already a fixed length (every piece is that long): the length that holds the longest piece.
    expect(shortPieceHint([15, 15], 2, 180, { longestAutoMm: 40.2, fixed: true })).toMatch(/set a fixed length of 41 mm \(about 45\.1 mm as cut\)\.$/)
    // Pieces of a table cut between its columns: a fixed length does not lengthen them.
    const columns = shortPieceHint([59.5, 16.9, 15, 15], 2, 180, { column: [false, true, true, true], longestAutoMm: 59.5 })
    expect(columns).toMatch(/^Pieces 2, 3 and 4 are about 20\.9, 19 and 19 mm\. .* Wider table columns make longer table pieces\.$/)
    expect(columns).not.toMatch(/fixed length|Spacer/)
  })

  it('shortPieceHintFor: column pieces are the pages that are not a whole Cut piece', () => {
    const mm = (d: number) => (d * 25.4) / 180
    // Piece 1 = [0, 422) "Scale"; piece 2 = a table cut into 3 columns of 120 dots.
    const r = { lengthDots: 782, lengthMm: mm(782), feedMarginMm: mm(14), cuts: [422, 542, 662], cutPieces: [{ start: 0, end: 422, autoDots: 422 }, { start: 422, end: 782, autoDots: 360 }] }
    expect(shortPieceHintFor(r, 180, false)).toMatch(/^Pieces 2, 3 and 4 are each about 20\.9 mm\. .* Wider table columns make longer table pieces\.$/)
    expect(shortPieceHintFor({ ...r, cuts: undefined }, 180, false)).toBeNull()
  })

  it('pieceLengthHint: machine-cut pieces carry the feed at both ends, hand-cut ones at the strip ends only', () => {
    const r = { lengthDots: 354, lengthMm: (354 * 25.4) / 180, feedMarginMm: (14 * 25.4) / 180 }
    expect(pieceLengthHint({ ...r, cutItems: [{ itemId: 'c', how: 'printer', x: 177 }] }, 25)).toBe('Each cut piece ≈ 29 mm with the printer’s feed')
    expect(pieceLengthHint({ ...r, marks: [177], cutItems: [{ itemId: 'c', how: 'mark', x: 177 }] }, 25)).toBe('Each piece ≈ 27 mm when cut apart at the marks (incl. the printer’s feed)')
    const three = { lengthDots: 531, lengthMm: (531 * 25.4) / 180, feedMarginMm: (14 * 25.4) / 180, marks: [177, 354], cutItems: [] }
    expect(pieceLengthHint(three, 25)).toBe('Pieces ≈ 25 mm when cut apart at the marks; the first and last ≈ 27 mm with the printer’s feed')
    expect(pieceLengthHint({ ...r, cutItems: [{ itemId: 'c', how: 'ignored', why: 'max' }] }, 25)).toBeNull()
  })

  it('cutSummary and cutNeighbours: printer cut, cut mark, ignored', () => {
    const r = { lengthDots: 564, lengthMm: 79.6, feedMarginMm: 2, cuts: [188, 366] }
    const around = cutNeighbours(r, { itemId: 'c', how: 'printer', x: 188 })
    expect(around && [Math.round(around.before * 10) / 10, Math.round(around.after * 10) / 10]).toEqual([30.5, 29.1])
    expect(cutSummary({ itemId: 'c', how: 'printer', x: 188 }, { before: 30.54, after: 29.12 })).toEqual({ summary: '30.5\u00a0/ 29.1\u00a0mm', spoken: 'Printer cuts: pieces of 30.5 and 29.1 mm' })
    expect(cutSummary({ itemId: 'c', how: 'printer', x: 188 }).summary).toBe('Printer cuts')
    const marks = { lengthDots: 564, lengthMm: 79.6, feedMarginMm: 2, marks: [188, 366] }
    const hand = cutNeighbours(marks, { itemId: 'c', how: 'mark', x: 366 })
    expect(hand && [Math.round(hand.before * 10) / 10, Math.round(hand.after * 10) / 10]).toEqual([25.1, 29.9])
    expect(cutSummary({ itemId: 'c', how: 'mark', x: 366 }, hand)).toEqual({ summary: '25.1\u00a0/ 29.9\u00a0mm, by hand', spoken: 'Cut mark, cut by hand: pieces of 25.1 and 29.9 mm' })
    expect(cutSummary({ itemId: 'c', how: 'mark', x: 366 }).summary).toBe('Cut mark · cut by hand')
    expect(cutNeighbours(r, { itemId: 'c', how: 'ignored', why: 'end' })).toBeUndefined()
    expect(cutSummary({ itemId: 'c', how: 'ignored', why: 'end' }).summary).toBe('Ignored: nothing after it')
    expect(cutSummary({ itemId: 'c', how: 'ignored', why: 'start' }).summary).toBe('Ignored: nothing before it')
    expect(cutSummary({ itemId: 'c', how: 'ignored', why: 'double' }).summary).toBe('Ignored: nothing since the cut before')
    expect(cutSummary({ itemId: 'c', how: 'ignored', why: 'max' })).toEqual({ summary: 'Ignored: past the printer maximum', spoken: 'Ignored: past the printer maximum' })
    expect(cutSummary(undefined).summary).toBe('Cut the strip here')
  })
})

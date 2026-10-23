// W4 — pure UI helpers (no Svelte, no wasm calls): status-chip text, print-button blocking
// reasons, progress copy, media mismatch, zoom maths, block summaries. Unit-tested in node
// (tests/unit/ui/view-model.test.ts). User-facing *error* copy lives in printer/problems.ts (W2);
// this file only phrases states.
import { LIMITS, type Item, type ItemKind, type LabelDoc, type TapeWidthMm } from '../../doc/schema'
import type { ClientState, ConnectionSnapshot, OpenProgress, PrintProgress, TransportKind } from '../../printer'
import type { BatteryInfo, MediaInfo } from '../../wasm'
import { handPiecesMm, pageLengthsMm, pageSpans } from '../../render/job'
import { splitPieces, type IgnoredCutReason } from '../../render/layout'
import type { CutInfo, RenderResult } from '../../render/types'
import { dotsToMm, mmToDots } from '../../render/units'

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

/** "24 mm", "3.5 mm", "42.3 mm" — trims a trailing ".0". */
export function formatMm(mm: number, digits = 1): string {
  const s = mm.toFixed(digits)
  return `${s.endsWith('.0') ? s.slice(0, -2) : s} mm`
}

export function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

export function transportKindLabel(kind: TransportKind | undefined | null): string {
  switch (kind) {
    case 'serial-rfcomm':
      return 'Bluetooth'
    case 'serial-os-port':
      return 'Serial port'
    case 'usb':
      return 'USB'
    case 'virtual':
      return 'Virtual printer'
    default:
      return ''
  }
}

export function batteryText(b: BatteryInfo | undefined | null): string | null {
  if (!b) return null
  if (b.weak) return 'Battery low'
  if (b.source === 'ac') return 'On AC power'
  if (typeof b.percent === 'number') return `Battery ${Math.round(b.percent)} %`
  return null
}

/**
 * Connect progress line. A direct-RFCOMM open that takes long (state 'waking' on attempt 1)
 * is the printer waking up: macOS' first open hangs ~10 s before the automatic retry.
 */
export function openProgressText(p: OpenProgress | null | undefined, state?: ClientState): string {
  if (!p || p.attempt <= 1) return state === 'waking' ? 'Waking printer… this can take up to 10 s' : 'Opening the connection…'
  return `Waking printer… (attempt ${p.attempt} of ${p.of})`
}

/** Problem ids of a connection that never got as far as talking to the printer. */
const NEVER_CONNECTED: ReadonlySet<string> = new Set(['open-failed', 'wrong-port', 'port-in-use', 'permission-denied', 'usb-busy', 'usb-access', 'unsupported-browser'])

/** `true` when the snapshot's error is a failed connect (nothing was ever opened / talked to). */
export function connectFailed(conn: Pick<ConnectionSnapshot, 'state' | 'problem' | 'status'>): boolean {
  return conn.state === 'error' && !conn.status && !!conn.problem && NEVER_CONNECTED.has(conn.problem.id)
}

// ---------------------------------------------------------------------------------------------
// Status chip
// ---------------------------------------------------------------------------------------------

export type ChipTone = 'idle' | 'busy' | 'ok' | 'warn' | 'error'

export interface ChipView {
  tone: ChipTone
  /** Short text on the chip. */
  text: string
  /** Secondary line (tape colours, transport, battery) for the tooltip / dialog. */
  detail: string
  /** `true` while a connection attempt or print is in progress (spinner). */
  busy: boolean
}

const BUSY_STATES: ReadonlySet<ClientState> = new Set(['opening', 'waking', 'handshaking', 'printing', 'cancelling', 'settings'])

/** Tape description from a snapshot: "24 mm white / black". */
export function tapeText(conn: Pick<ConnectionSnapshot, 'status' | 'media'>): string | null {
  const width = conn.media?.widthMm ?? (conn.status && conn.status.mediaWidthMm > 0 ? conn.status.mediaWidthMm : null)
  if (width === null || width === undefined) return null
  const w = formatMm(width === 4 && !conn.media ? 3.5 : width)
  const tape = conn.status?.tapeColor?.name
  const ink = conn.status?.textColor?.name
  return tape && ink && tape !== 'unknown' ? `${w} ${tape} / ${ink}` : w
}

export function chipView(conn: ConnectionSnapshot): ChipView {
  const model = conn.model ?? conn.status?.modelName ?? 'Printer'
  const tape = tapeText(conn)
  const parts = [transportKindLabel(conn.transport?.kind), tape, batteryText(conn.status?.battery)].filter(Boolean)
  const detail = parts.join(' · ')
  const busy = BUSY_STATES.has(conn.state)
  switch (conn.state) {
    case 'ready': {
      const noTape = conn.status && (conn.status.mediaType === 'none' || conn.status.mediaWidthMm === 0)
      if (conn.status?.error || noTape) {
        return { tone: 'warn', text: `${model} · ${noTape ? 'no tape' : 'needs attention'}`, detail, busy }
      }
      return { tone: 'ok', text: tape ? `${model} · ${formatMm(conn.media?.widthMm ?? conn.status?.mediaWidthMm ?? 0)}` : model, detail, busy }
    }
    case 'opening':
      return { tone: 'busy', text: 'Connecting…', detail, busy }
    case 'waking':
      return { tone: 'busy', text: 'Waking printer…', detail: conn.openProgress && conn.openProgress.attempt > 1 ? `Attempt ${conn.openProgress.attempt} of ${conn.openProgress.of}` : 'This can take up to 10 s', busy }
    case 'handshaking':
      return { tone: 'busy', text: 'Talking to printer…', detail, busy }
    case 'printing':
      return { tone: 'busy', text: conn.progress ? `Printing ${conn.progress.page}/${conn.progress.of}` : 'Printing…', detail, busy }
    case 'cancelling':
      return { tone: 'busy', text: 'Cancelling…', detail, busy }
    case 'settings':
      return { tone: 'busy', text: `${model} · settings…`, detail, busy }
    case 'no-reply':
      // Firefox's dead macOS port: reconnecting won't help; follow the banner's guidance.
      if (conn.problem?.id === 'no-reply-firefox') return { tone: 'warn', text: 'No reply', detail: 'Use Chrome or Edge, or re-pair the printer', busy }
      return { tone: 'warn', text: 'Printer asleep?', detail: 'Press the power button, then Reconnect', busy }
    case 'lost':
      return { tone: 'error', text: 'Connection lost', detail: 'Reconnect when the printer is on', busy }
    case 'error': {
      if (connectFailed(conn)) return { tone: 'error', text: 'Couldn’t connect', detail: conn.problem?.title ?? '', busy }
      const title = conn.problem?.title
      return { tone: 'error', text: title && title.length <= 24 ? title : 'Printer problem', detail: title ?? detail, busy }
    }
    default:
      return { tone: 'idle', text: 'Connect printer', detail: '', busy }
  }
}

/** Accessible name of the status chip: no doubled punctuation after an ellipsis, no repeats. */
export function chipLabel(view: Pick<ChipView, 'text' | 'detail'>): string {
  const text = view.text.trim()
  const detail = view.detail.trim()
  if (!detail || detail === text || detail.startsWith(text.replace(/…$/, ''))) return `Connection: ${detail && detail !== text ? detail : text}`
  return `Connection: ${text}${/[.…!?]$/.test(text) ? '' : '.'} ${detail}`
}

export function isConnected(state: ClientState): boolean {
  return state === 'ready' || state === 'printing' || state === 'cancelling' || state === 'settings'
}

/**
 * The model of the printer the studio designs for, or null to design for the "Design for" pick
 * (docs/MODELS-PLAN.md §3.2): the connected (or connecting, or virtual) printer's. A lost or
 * silent link keeps the old model and status in the snapshot until the next attach; they no
 * longer count, so the picker works again and the media bar never says "(connected)".
 */
export function printerModel(conn: Pick<ConnectionSnapshot, 'state' | 'model' | 'status'>): string | null {
  if (conn.state === 'lost' || conn.state === 'no-reply' || conn.state === 'error' || conn.state === 'disconnected') return null
  return conn.model ?? conn.status?.modelName ?? null
}

// ---------------------------------------------------------------------------------------------
// Media / tape
// ---------------------------------------------------------------------------------------------

export interface MediaMismatch {
  loadedMm: number
  designMm: number
  media: MediaInfo
}

/** Loaded tape (from status) differs from the document's tape width. */
export function mediaMismatch(conn: Pick<ConnectionSnapshot, 'media' | 'state'>, doc: Pick<LabelDoc, 'tape'>): MediaMismatch | null {
  if (!conn.media || !isConnected(conn.state)) return null
  if (Math.abs(conn.media.widthMm - doc.tape.widthMm) < 0.01) return null
  return { loadedMm: conn.media.widthMm, designMm: doc.tape.widthMm, media: conn.media }
}

/** Common TZe colour combinations for designing offline (CSS colours). */
export interface TapePreset {
  id: string
  label: string
  tape: string
  ink: string
}

export const TAPE_PRESETS: readonly TapePreset[] = [
  { id: 'white-black', label: 'Black on white', tape: '#ffffff', ink: '#000000' },
  { id: 'yellow-black', label: 'Black on yellow', tape: '#ffd400', ink: '#000000' },
  { id: 'clear-black', label: 'Black on clear', tape: '#eef1f4', ink: '#000000' },
  { id: 'white-blue', label: 'Blue on white', tape: '#ffffff', ink: '#1d3fbf' },
  { id: 'white-red', label: 'Red on white', tape: '#ffffff', ink: '#c8102e' },
  { id: 'red-white', label: 'White on red', tape: '#c8102e', ink: '#ffffff' },
  { id: 'blue-white', label: 'White on blue', tape: '#1d4fbf', ink: '#ffffff' },
  { id: 'black-white', label: 'White on black', tape: '#111111', ink: '#ffffff' },
  { id: 'green-black', label: 'Black on green', tape: '#3fae49', ink: '#000000' },
]

export const DEFAULT_COLORS = { tape: '#ffffff', ink: '#000000' } as const

/** Tape + ink for the preview: the printer's reported colours win (when its tape is the design's). */
export function previewColors(conn: Pick<ConnectionSnapshot, 'status' | 'media' | 'state'>, doc: Pick<LabelDoc, 'tape'>): { tape: string; ink: string; fromPrinter: boolean } {
  const s = conn.status
  const matches = conn.media && isConnected(conn.state) && Math.abs(conn.media.widthMm - doc.tape.widthMm) < 0.01
  if (matches && s && /^#[0-9a-f]{3,6}$/i.test(s.tapeColor.css) && /^#[0-9a-f]{3,6}$/i.test(s.textColor.css) && s.tapeColor.css !== s.textColor.css) {
    return { tape: s.tapeColor.css, ink: s.textColor.css, fromPrinter: true }
  }
  return { ...(doc.tape.colors ?? DEFAULT_COLORS), fromPrinter: false }
}

export function nearestTapeWidth(mm: number, widths: readonly TapeWidthMm[]): TapeWidthMm {
  let best = widths[0] ?? 24
  for (const w of widths) if (Math.abs(w - mm) < Math.abs(best - mm)) best = w
  return best as TapeWidthMm
}

// ---------------------------------------------------------------------------------------------
// Print bar
// ---------------------------------------------------------------------------------------------

export interface PrintGate {
  wasm: 'loading' | 'ready' | 'error'
  /** Render error message (target resolution or renderer failure). */
  renderError: string | null
  hasRender: boolean
  blocking: { message: string } | null
  isEmpty: boolean
  /** `{{name}}` placeholders nothing defines (doc/variables.ts missingVariables); they would print as written. */
  missingVariables?: readonly string[]
  /** Columns the label uses while the batch table has no rows (doc/variables.ts columnsWithoutData). */
  columnsWithoutData?: readonly string[]
  conn: Pick<ConnectionSnapshot, 'state' | 'status' | 'media'> & Partial<Pick<ConnectionSnapshot, 'problem'>>
  mismatch: MediaMismatch | null
  /** false: this browser can't reach printers at all (design mode). Default true. */
  canPrint?: boolean
  /** The label's tape width is not one the active model takes (docs/MODELS-PLAN.md): the
   * sentence to show, e.g. "This label is 36 mm; PT-P710BT takes up to 24 mm. …". */
  unsupportedWidth?: string | null
}

/** Why Print is disabled (sentence for the UI), or null when printing is possible. */
export function printBlockReason(g: PrintGate): string | null {
  if (g.wasm === 'loading') return 'Loading the label engine…'
  if (g.wasm === 'error') return 'The label engine failed to load. Reload the page.'
  if (g.isEmpty) return 'Add something to the label first.'
  if (g.renderError) return 'The preview could not be rendered.'
  if (!g.hasRender) return 'Preparing the preview…'
  if (g.blocking) return g.blocking.message
  if (g.unsupportedWidth) return g.unsupportedWidth
  const missing = g.missingVariables ?? []
  if (missing.length) return `Unknown ${missing.length === 1 ? 'variable' : 'variables'} ${missing.map((n) => `{{${n}}}`).join(', ')}: add a column or counter with that name, or fix the spelling.`
  const empty = g.columnsWithoutData ?? []
  if (empty.length) return `The data table has no rows, so ${empty.map((n) => `{{${n}}}`).join(', ')} would print blank: paste data or add a row.`
  if (g.canPrint === false) return 'Printing needs Chrome or Edge on a computer or Android.'
  switch (g.conn.state) {
    case 'ready':
      break
    case 'printing':
    case 'cancelling':
      return 'A label is printing.'
    case 'settings':
      return 'Busy: printer settings.'
    case 'opening':
    case 'waking':
    case 'handshaking':
      return 'Connecting to the printer…'
    case 'no-reply':
      return g.conn.problem?.id === 'no-reply-firefox' ? 'The printer isn’t answering in Firefox. Use Chrome or Edge, or re-pair it.' : 'The printer is not answering. Wake it and reconnect.'
    case 'lost':
      return 'The connection was lost. Reconnect first.'
    case 'error':
      return g.conn.problem && !g.conn.status && NEVER_CONNECTED.has(g.conn.problem.id) ? 'Connect a printer to print.' : 'Fix the printer problem first.'
    default:
      return 'Connect a printer to print.'
  }
  const s = g.conn.status
  if (s && (s.mediaType === 'none' || s.mediaWidthMm === 0)) return 'No tape cassette is loaded.'
  if (s?.errors.length) return `Printer reports: ${s.errors.map((e) => e.message).join(', ')}.`
  if (g.mismatch) return `The printer has ${formatMm(g.mismatch.loadedMm)} tape; this label is ${formatMm(g.mismatch.designMm)}.`
  return null
}

export function printButtonText(copies: number): string {
  return copies === 1 ? 'Print label' : `Print ${copies} labels`
}

export function progressText(p: PrintProgress | null | undefined): string {
  if (!p) return 'Starting…'
  const which = p.of > 1 ? `label ${p.page} of ${p.of}` : 'label'
  switch (p.phase) {
    case 'sending':
      return `Sending ${which}…`
    case 'printing':
      return `Printing ${which}…`
    default:
      return p.page >= p.of ? 'Finishing…' : `Printed ${which}`
  }
}

/** 0..1 for a progress bar: each page counts sending 0–40 %, printing 40–100 %. */
export function progressFraction(p: PrintProgress | null | undefined): number {
  if (!p || p.of <= 0) return 0
  const within = p.phase === 'sending' ? 0.15 : p.phase === 'printing' ? 0.5 : 1
  return Math.max(0, Math.min(1, (p.page - 1 + within) / p.of))
}

export function clampCopies(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.min(LIMITS.copies.max, Math.round(n)))
}

// ---------------------------------------------------------------------------------------------
// Preview zoom
// ---------------------------------------------------------------------------------------------

/** Zoom steps as multiples of real size (CSS px are 1/96 in). */
export const ZOOM_STEPS: readonly number[] = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16]

export type Zoom = 'fit' | number

/** CSS px per printer dot at real size. */
export function realScale(dpi: number): number {
  return 96 / dpi
}

/** Scale (CSS px per dot) that fits `lengthDots × heightDots` into the box, capped. */
export function fitScale(lengthDots: number, heightDots: number, boxW: number, boxH: number, dpi: number): number {
  if (lengthDots <= 0 || heightDots <= 0 || boxW <= 0) return realScale(dpi)
  const byW = boxW / lengthDots
  const byH = boxH > 0 ? boxH / heightDots : Infinity
  const max = realScale(dpi) * 8
  return Math.max(realScale(dpi) * 0.25, Math.min(byW, byH, max))
}

export function zoomStep(current: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > current + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 1e-6) ?? ZOOM_STEPS[0]!
}

export function zoomPercent(scale: number, dpi: number): string {
  return `${Math.round((scale / realScale(dpi)) * 100)} %`
}

/** Ruler tick spacing (mm) so minor ticks are ≥ 5 px and labels ≥ 36 px apart. */
export function rulerSteps(pxPerMm: number): { minor: number; label: number } {
  const minor = [1, 2, 5, 10, 20, 50].find((s) => s * pxPerMm >= 5) ?? 50
  const label = [5, 10, 20, 50, 100].find((s) => s * pxPerMm >= 36 && s % minor === 0) ?? 100
  return { minor, label }
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

export const KIND_META: Record<ItemKind, { label: string; icon: string }> = {
  text: { label: 'Text', icon: 'type' },
  icon: { label: 'Icon', icon: 'star' },
  code: { label: 'Code', icon: 'qr' },
  image: { label: 'Image', icon: 'image' },
  shape: { label: 'Shape', icon: 'square' },
  spacer: { label: 'Spacer', icon: 'space' },
  table: { label: 'Table', icon: 'table' },
  cut: { label: 'Cut', icon: 'scissors' },
}

const SYMBOLOGY_LABEL = { qr: 'QR', code128: 'Code 128', ean13: 'EAN-13', datamatrix: 'DataMatrix' } as const

/** Human title + one-line summary of a block for the block list and aria labels. */
export function itemSummary(item: Item, iconLabel?: (id: string) => string | undefined): { title: string; summary: string } {
  switch (item.kind) {
    case 'text': {
      const line = item.text.split('\n').find((l) => l.trim()) ?? ''
      return { title: 'Text', summary: line.trim() ? truncate(line.trim(), 40) : '(empty)' }
    }
    case 'icon':
      return { title: 'Icon', summary: iconLabel?.(item.iconId) ?? item.iconId }
    case 'code':
      // A Wi-Fi code shows its network name, never the password.
      if (item.content === 'wifi' && item.symbology === 'qr') return { title: 'Wi-Fi QR', summary: item.wifi?.ssid ? truncate(item.wifi.ssid, 40) : '(no network name)' }
      return { title: SYMBOLOGY_LABEL[item.symbology], summary: item.data ? truncate(item.data, 40) : '(empty)' }
    case 'image':
      return { title: 'Image', summary: item.blobRef || item.dataUrl ? `${capitalize(item.dither.replace('-', ' '))}` : 'No image chosen' }
    case 'shape':
      return { title: 'Shape', summary: `${capitalize(item.shape === 'rect' ? 'rectangle' : item.shape)} · ${formatMm(item.widthMm)}` }
    case 'spacer':
      return { title: 'Spacer', summary: formatMm(item.widthMm) }
    case 'table':
      return { title: 'Table', summary: truncate(`${item.cells.length} × ${item.cells[0]?.length} · ${item.cells[0]?.join(' ')}`, 40) }
    case 'cut':
      // The block list replaces this with `cutSummary` once the label has rendered.
      return { title: 'Cut', summary: 'Cut the strip here' }
  }
}

/**
 * "Cut into 7 pieces · about 25.1 mm each (21.1 mm printed + 2 × 2 mm feed)" for a label the
 * printer cuts into pieces (`pagesMm` = render/job.ts pageLengthsMm), or the range when they
 * differ; null for one piece. "About" until the piece lengths are checked on a printer (HW-T1).
 */
export function piecesText(pagesMm: readonly number[], feedMm: number): string | null {
  const n = pagesMm.length
  const lo = Math.min(...pagesMm)
  const hi = Math.max(...pagesMm)
  const mm = (v: number): string => formatMm(v + 2 * feedMm)
  const same = hi - lo < 0.05
  return n < 2 ? null : `Cut into ${n} pieces · about ${same ? mm(lo) : `${mm(lo)} to ${mm(hi)}`} each (${same ? `${formatMm(lo)} printed + ` : 'incl. '}2 × ${formatMm(feedMm)} feed)`
}

/** "30.5", "29" — a length without its unit. */
function mmNumber(mm: number): string {
  const s = mm.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

/** "a, b and c" */
function andList(v: readonly string[]): string {
  return v.length < 2 ? (v[0] ?? '') : `${v.slice(0, -1).join(', ')} and ${v[v.length - 1]}`
}

/** "30.5, 29.1 and 31.9" */
function mmList(values: readonly number[]): string {
  return andList(values.map(mmNumber))
}

/** The lengths read the same once rounded for display ("27" and "27"). */
function sameMm(values: readonly number[]): boolean {
  return new Set(values.map(mmNumber)).size === 1
}

/** Pieces listed one by one up to this many; more are shown as a range. */
const LISTED_PIECES = 8

/**
 * The readout of a strip the printer cuts at its Cut blocks (docs/CUT-PLAN.md C11): "Cut into 3
 * pieces: about 30.5, 29.1 and 31.9 mm, each incl. 2 × 2 mm feed" (`pagesMm` = render/job.ts
 * pageLengthsMm, without the feed). Above 8 pieces the range of `piecesText`; null for one piece.
 */
export function pieceListText(pagesMm: readonly number[], feedMm: number): string | null {
  const n = pagesMm.length
  if (n < 2) return null
  if (n > LISTED_PIECES) return piecesText(pagesMm, feedMm)
  const cut = pagesMm.map((p) => p + 2 * feedMm)
  const same = Math.max(...cut) - Math.min(...cut) < 0.05
  const feed = `2 × ${formatMm(feedMm)} feed`
  return same ? `Cut into ${n} pieces: about ${formatMm(cut[0] ?? 0)} each, incl. ${feed}` : `Cut into ${n} pieces: about ${mmList(cut)} mm, each incl. ${feed}`
}

/**
 * The readout of a strip cut apart by hand at its cut marks (`piecesMm` = render/job.ts
 * handPiecesMm, as cut): "3 pieces to cut apart at the marks: about 28.5, 25.1 and 29.9 mm".
 */
export function handPiecesText(piecesMm: readonly number[]): string | null {
  const n = piecesMm.length
  if (n < 2) return null
  const lo = Math.min(...piecesMm)
  const hi = Math.max(...piecesMm)
  const what = sameMm(piecesMm) ? `${mmNumber(lo)} mm each` : n > LISTED_PIECES ? `${mmNumber(lo)} to ${mmNumber(hi)} mm` : `${mmList(piecesMm)} mm`
  return `${n} pieces to cut apart at the marks: about ${what}`
}

/**
 * Distance from the print head to the cutter (docs/PROTOCOL.md §5.6): about 24.5 mm on the 180 dpi
 * models, about 27 mm at 360 dpi. Whether a shorter piece is cut at its own length is not yet
 * checked on a printer (HW-T1 / HW-C1).
 */
export function shortPieceMm(dpi: number): number {
  return dpi >= 360 ? 27 : 24.5
}

/**
 * The shortest whole-mm fixed length whose machine-cut pieces, with the printer's feed at both
 * ends, reach the head-to-cutter distance (`shortPieceMm`) once rounded to dots: 21 mm at 180 dpi
 * (2 mm feed), 26 mm at 360 dpi (1 mm feed). `shortPieceHint` is null for pieces this long.
 */
export function safePieceMm(feedMm: number, dpi: number): number {
  const limit = shortPieceMm(dpi)
  for (let mm = 1; mm < 100; mm++) if (dotsToMm(mmToDots(mm, dpi), dpi) + 2 * feedMm >= limit - 1e-6) return mm
  return Math.ceil(limit)
}

/** What `shortPieceHint` knows besides the page lengths (from the render, `shortPieceHintFor`). */
export interface ShortPieceContext {
  /** Per page: a piece of a table cut between its columns (a fixed length does not lengthen it). */
  column?: readonly boolean[]
  /** The longest auto length of the Cut pieces (mm, no feed): a shorter fixed length cuts it off. */
  longestAutoMm?: number
  /** The label has a fixed length (every Cut piece is that long: a Spacer does not lengthen it). */
  fixed?: boolean
}

/**
 * The gentle hint for machine-cut pieces shorter than the head-to-cutter distance (C11), or null:
 * "Piece 1 is about 17.4 mm. Pieces shorter than about 24.5 mm as cut have not been checked on a
 * printer yet and may come out longer. To be sure, set a fixed length of 21 mm (about 25 mm as
 * cut)." The tip fits the short pieces: a fixed length only when every Cut piece fits in it
 * (`safePieceMm`, or the longest piece when the length is already fixed), a Spacer otherwise;
 * wider columns for table pieces. Every length in it is as cut (feed included), except a fixed
 * length, which also gives its as-cut length. The threshold is the real one, and a short piece
 * that would round up to it is shown rounded down ("26.9 mm", not "27 mm" under 27 mm).
 */
export function shortPieceHint(pagesMm: readonly number[], feedMm: number, dpi: number, ctx: ShortPieceContext = {}): string | null {
  if (pagesMm.length < 2) return null
  const limit = shortPieceMm(dpi)
  // A short piece is shown below the threshold: rounded down if it would round up to it.
  const shown = (mm: number): number => (Number(mm.toFixed(1)) >= limit ? Math.floor(mm * 10) / 10 : mm)
  const short = pagesMm.flatMap((p, i) => (p + 2 * feedMm < limit - 1e-6 ? [{ n: i + 1, mm: shown(p + 2 * feedMm), column: !!ctx.column?.[i] }] : []))
  if (!short.length) return null
  const first = short[0] as { n: number; mm: number }
  const lengths = short.map((s) => s.mm)
  const threshold = formatMm(limit)
  const which =
    short.length === 1
      ? `Piece ${first.n} is about ${formatMm(first.mm)}.`
      : short.length <= LISTED_PIECES
        ? `Pieces ${andList(short.map((s) => String(s.n)))} are ${sameMm(lengths) ? `${short.length === 2 ? 'both' : 'each'} about ${formatMm(first.mm)}` : `about ${mmList(lengths)} mm`}.`
        : `${short.length} pieces are shorter than about ${threshold}.`
  const tips: string[] = []
  if (short.some((s) => !s.column)) {
    const safe = safePieceMm(feedMm, dpi)
    const fits = (mm: number): boolean => ctx.longestAutoMm === undefined || ctx.longestAutoMm <= dotsToMm(mmToDots(mm, dpi), dpi) + 1e-6
    let fixedMm: number | undefined = fits(safe) ? safe : undefined
    if (fixedMm === undefined && ctx.fixed && ctx.longestAutoMm !== undefined) {
      // Already a fixed length: every piece is that long, so the length that holds the longest.
      fixedMm = Math.max(safe, Math.ceil(ctx.longestAutoMm - 1e-6))
      while (!fits(fixedMm)) fixedMm++
    }
    const asCut = (mm: number): string => formatMm(dotsToMm(mmToDots(mm, dpi), dpi) + 2 * feedMm)
    tips.push(
      fixedMm !== undefined
        ? `To be sure, set a fixed length of ${fixedMm} mm (about ${asCut(fixedMm)} as cut).`
        : `To be sure, lengthen the short pieces to about ${asCut(safe)} or more as cut (${safe} mm printed), e.g. with a Spacer (a fixed length would cut off the longer pieces).`,
    )
  }
  if (short.some((s) => s.column)) tips.push('Wider table columns make longer table pieces.')
  return `${which} Pieces shorter than about ${threshold} as cut have not been checked on a printer yet and may come out longer. ${tips.join(' ')}`
}

/**
 * `shortPieceHint` for a render: its machine-cut pages, which of them are table column pieces
 * (not a whole Cut piece, `RenderResult.cutPieces`) and the longest Cut piece at the auto length.
 */
export function shortPieceHintFor(result: Pick<RenderResult, 'lengthDots' | 'lengthMm' | 'cuts' | 'feedMarginMm' | 'cutPieces'>, dpi: number, fixed: boolean): string | null {
  if (!result.cuts?.length) return null
  const pieces = result.cutPieces ?? []
  const column = pageSpans(result).map(([a, b]) => !pieces.some((p) => p.start === a && p.end === b))
  const mmPerDot = result.lengthDots > 0 ? result.lengthMm / result.lengthDots : 0
  const ctx: ShortPieceContext = { column, fixed, ...(pieces.length ? { longestAutoMm: Math.max(...pieces.map((p) => p.autoDots)) * mmPerDot } : {}) }
  return shortPieceHint(pageLengthsMm(result), result.feedMarginMm, dpi, ctx)
}

/**
 * The line under a fixed length while the label is in pieces (media bar, C7): machine-cut pieces
 * carry the printer's feed at both ends; pieces cut apart by hand at the marks carry it only at
 * the strip's ends (render/job.ts handPiecesMm, as the readout lists them). Null without pieces.
 */
export function pieceLengthHint(result: Pick<RenderResult, 'lengthDots' | 'lengthMm' | 'marks' | 'feedMarginMm' | 'cutItems'>, lengthMm: number): string | null {
  if (result.cutItems?.some((c) => c.how === 'printer')) return `Each cut piece ≈ ${formatMm(lengthMm + 2 * result.feedMarginMm)} with the printer’s feed`
  const hand = handPiecesMm(result)
  if (hand.length < 2) return null
  const ends = hand[0] ?? 0
  const inner = hand[1] ?? 0
  return hand.length === 2 || sameMm(hand)
    ? `Each piece ≈ ${formatMm(ends)} when cut apart at the marks (incl. the printer’s feed)`
    : `Pieces ≈ ${formatMm(inner)} when cut apart at the marks; the first and last ≈ ${formatMm(ends)} with the printer’s feed`
}

/**
 * What the render will make of a Cut block, ahead of it (render/layout.ts splitPieces, C3):
 * 'kept', or why it is ignored. A block prints when it is not a Cut or a Spacer, flows (free
 * layout: no frame) and, when `boxes` (the last render's) is given, had a width there (an empty
 * text block prints nothing); a block the last render has not seen is taken to print.
 */
export function cutFate(doc: Pick<LabelDoc, 'items' | 'layout'>, cutId: string, boxes?: Pick<RenderResult, 'boxes'>['boxes']): 'kept' | IgnoredCutReason {
  const free = doc.layout.mode === 'free'
  const flow = doc.items.filter((i) => i.kind === 'cut' || !(free && i.frame))
  const seen = boxes ? new Map(boxes.map((b) => [b.itemId, b.w > 0])) : undefined
  const split = splitPieces(
    flow.map((i) => ({ itemId: i.id, w: i.kind === 'cut' || i.kind === 'spacer' ? 0 : (seen?.get(i.id) ?? true) ? 1 : 0, h: 0, ...(i.kind === 'spacer' ? { spacer: true } : {}), ...(i.kind === 'cut' ? { cut: true } : {}) })),
  )
  return split.ignored.find((g) => g.itemId === cutId)?.why ?? 'kept'
}

/** The pieces on either side of a Cut block (mm as cut), from the render; undefined when ignored. */
export function cutNeighbours(result: Pick<RenderResult, 'lengthDots' | 'lengthMm' | 'cuts' | 'marks' | 'feedMarginMm'>, info: CutInfo): { before: number; after: number } | undefined {
  if (info.how === 'ignored' || info.x === undefined) return undefined
  const machine = info.how === 'printer'
  const k = (machine ? (result.cuts ?? []) : (result.marks ?? [])).indexOf(info.x)
  if (k < 0) return undefined
  const pieces = machine ? pageLengthsMm(result).map((p) => p + 2 * result.feedMarginMm) : handPiecesMm(result)
  const before = pieces[k]
  const after = pieces[k + 1]
  return before !== undefined && after !== undefined ? { before, after } : undefined
}

/** The ignored-Cut reasons, short (block list) — the full sentences are the `cut-ignored` warnings. */
const IGNORED_SHORT: Record<NonNullable<CutInfo['why']>, string> = {
  start: 'Ignored: nothing before it',
  double: 'Ignored: nothing since the cut before',
  end: 'Ignored: nothing after it',
  max: 'Ignored: past the printer maximum',
}

/**
 * The block list summary of a Cut block, short and led by the numbers so a narrow row still shows
 * them: "30.5 / 29.1 mm" (the pieces before and after it, the printer cuts), "30.5 / 29.1 mm, by
 * hand" (a cut mark), "Ignored: nothing after it"; "Cut the strip here" before the first render.
 * `spoken` is the same in words for the row's accessible name.
 */
export function cutSummary(info: CutInfo | undefined, around?: { before: number; after: number }): { summary: string; spoken: string } {
  const same = (summary: string): { summary: string; spoken: string } => ({ summary, spoken: summary })
  if (!info) return same('Cut the strip here')
  if (info.how === 'ignored') return same(IGNORED_SHORT[info.why ?? 'end'])
  const hand = info.how === 'mark'
  if (!around) return same(hand ? 'Cut mark · cut by hand' : 'Printer cuts')
  // Wraps only after the slash (no-break spaces elsewhere): "40.8 /" then "32.9 mm".
  const lengths = `${mmNumber(around.before)}\u00a0/ ${mmNumber(around.after)}\u00a0mm`
  const spoken = `pieces of ${mmNumber(around.before)} and ${mmNumber(around.after)} mm`
  return hand ? { summary: `${lengths}, by hand`, spoken: `Cut mark, cut by hand: ${spoken}` } : { summary: lengths, spoken: `Printer cuts: ${spoken}` }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** `true` when nothing printable is in the doc (empty text, no items…). */
export function docIsEmpty(doc: Pick<LabelDoc, 'items' | 'frame'>): boolean {
  if (doc.frame) return false
  return !doc.items.some((i) => {
    switch (i.kind) {
      case 'text':
        return i.text.trim() !== ''
      case 'code':
        return i.data.trim() !== ''
      case 'image':
        return !!(i.blobRef || i.dataUrl)
      case 'spacer':
      case 'cut':
        return false
      case 'table':
        return i.cells.some((r) => r.some((c) => c.trim() !== ''))
      default:
        return true
    }
  })
}

/** Platform-aware modifier label for shortcut hints. */
export function modKey(platform: string): string {
  return platform === 'mac' || platform === 'ios' ? '⌘' : 'Ctrl'
}

/**
 * `media` of a `<meta name="theme-color" media="(prefers-color-scheme: …)">` under the in-app
 * theme: the system setting keeps `original`; a chosen theme enables only its own colour.
 */
export function themeColorMedia(original: string, theme: 'system' | 'light' | 'dark'): string {
  if (theme === 'system') return original
  return original.includes(`prefers-color-scheme: ${theme}`) ? 'all' : 'not all'
}

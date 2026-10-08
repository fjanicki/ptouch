// W4 — pure UI helpers (no Svelte, no wasm calls): status-chip text, print-button blocking
// reasons, progress copy, media mismatch, zoom maths, block summaries. Unit-tested in node
// (tests/unit/ui/view-model.test.ts). User-facing *error* copy lives in printer/problems.ts (W2);
// this file only phrases states.
import { LIMITS, type Item, type ItemKind, type LabelDoc, type TapeWidthMm } from '../../doc/schema'
import type { ClientState, ConnectionSnapshot, OpenProgress, PrintProgress, TransportKind } from '../../printer'
import type { BatteryInfo, MediaInfo } from '../../wasm'

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
const NEVER_CONNECTED: ReadonlySet<string> = new Set(['open-failed', 'wrong-port', 'port-in-use', 'permission-denied', 'unsupported-browser'])

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

const BUSY_STATES: ReadonlySet<ClientState> = new Set(['opening', 'waking', 'handshaking', 'printing', 'cancelling'])

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
  return state === 'ready' || state === 'printing' || state === 'cancelling'
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
  conn: Pick<ConnectionSnapshot, 'state' | 'status' | 'media'> & Partial<Pick<ConnectionSnapshot, 'problem'>>
  mismatch: MediaMismatch | null
  /** false: this browser can't reach printers at all (design mode). Default true. */
  canPrint?: boolean
}

/** Why Print is disabled (sentence for the UI), or null when printing is possible. */
export function printBlockReason(g: PrintGate): string | null {
  if (g.wasm === 'loading') return 'Loading the label engine…'
  if (g.wasm === 'error') return 'The label engine failed to load. Reload the page.'
  if (g.isEmpty) return 'Add something to the label first.'
  if (g.renderError) return 'The preview could not be rendered.'
  if (!g.hasRender) return 'Preparing the preview…'
  if (g.blocking) return g.blocking.message
  if (g.canPrint === false) return 'Printing needs Chrome or Edge on a computer or Android.'
  switch (g.conn.state) {
    case 'ready':
      break
    case 'printing':
    case 'cancelling':
      return 'A label is printing.'
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
}

const SYMBOLOGY_LABEL = { qr: 'QR', code128: 'Code 128', ean13: 'EAN-13' } as const

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
      return { title: SYMBOLOGY_LABEL[item.symbology], summary: item.data ? truncate(item.data, 40) : '(empty)' }
    case 'image':
      return { title: 'Image', summary: item.blobRef || item.dataUrl ? `${capitalize(item.dither.replace('-', ' '))}` : 'No image chosen' }
    case 'shape':
      return { title: 'Shape', summary: `${capitalize(item.shape === 'rect' ? 'rectangle' : item.shape)} · ${formatMm(item.widthMm)}` }
    case 'spacer':
      return { title: 'Spacer', summary: formatMm(item.widthMm) }
  }
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
        return false
      default:
        return true
    }
  })
}

/** Platform-aware modifier label for shortcut hints. */
export function modKey(platform: string): string {
  return platform === 'mac' || platform === 'ios' ? '⌘' : 'Ctrl'
}

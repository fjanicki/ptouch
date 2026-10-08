// W5 — "Copy diagnostics" text for bug reports: app + wasm version, UA, SupportInfo, transport
// kind/label, last status hex, last Problem, probe results and the packet log tail. Everything
// passes through maskText(): device-name suffixes become "PT-P710BTxxxx", Bluetooth addresses
// "XX:XX:XX:XX:XX:XX", serial numbers "***" — a report never identifies the user's printer.
import { toHex, type ConnectionSnapshot, type PacketLog, type PacketLogEntry, type SupportInfo } from '../../printer'
import type { ProbeResult } from './probe'

const MODEL_SUFFIX = /\b((?:PT|QL|TD|RJ|PJ)-[A-Z0-9]*?(?:BT|NWB|WB|W|B))([0-9A-Z]{4})(?![0-9A-Z])/gi
const BT_ADDRESS = /\b(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}\b/gi
const SERIAL_NUMBER = /(serial[ _-]?number["']?\s*[:=]\s*["']?)[^\s"',;)]+/gi

/** Masks every device-name suffix, Bluetooth address and serial number in `text`. */
export function maskText(text: string): string {
  return text.replace(BT_ADDRESS, 'XX:XX:XX:XX:XX:XX').replace(MODEL_SUFFIX, '$1xxxx').replace(SERIAL_NUMBER, '$1***')
}

/** Replaces a device-name suffix / BT address with x's ("PT-P710BT1234" → "PT-P710BTxxxx"). */
export function maskDeviceLabel(label: string): string {
  return maskText(label)
}

export interface ReportExtras {
  appVersion?: string
  wasmVersion?: string
  userAgent?: string
  /** e.g. location.origin + BASE_URL. */
  url?: string
  /** Service worker / storage / canvas facts gathered by the page. */
  facts?: Record<string, string>
  probes?: { path: string; result: ProbeResult }[]
  /** Packet log lines to include (newest last). Default 200. */
  logTail?: number
  now?: Date
}

/** One packet-log line: time, direction, hex (truncated) or note. */
export function formatLogEntry(e: PacketLogEntry, maxBytes = 64): string {
  const t = `${(e.t / 1000).toFixed(3).padStart(9)}s`
  if (e.dir === '--') return `${t} -- ${e.note ?? ''}`
  const b = e.bytes ?? new Uint8Array()
  const more = b.length > maxBytes ? ` … (+${b.length - maxBytes} bytes, ${b.length} total)` : ''
  return `${t} ${e.dir} ${toHex(b.subarray(0, maxBytes))}${more}`
}

export function buildReport(support: SupportInfo, snap: ConnectionSnapshot, log: PacketLog, extras: ReportExtras = {}): string {
  const ua = extras.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a')
  const lines: string[] = []
  const kv = (k: string, v: unknown): void => void lines.push(`${`${k}:`.padEnd(18)} ${v === undefined || v === null || v === '' ? '—' : String(v)}`)

  lines.push('# ptouch studio diagnostics')
  kv('generated', (extras.now ?? new Date()).toISOString())
  kv('app', extras.appVersion)
  kv('wasm core', extras.wasmVersion)
  kv('url', extras.url)
  kv('user agent', ua)
  lines.push('', '## Browser support')
  kv('browser', `${support.browser}${support.version ? ` ${support.version}` : ''}`)
  kv('engine', support.engine)
  kv('platform', support.platform)
  kv('web serial', support.serial)
  kv('webusb', `${support.usb}${support.usbHidden ? ' (hidden on Windows)' : ''}`)
  kv('bt filter', support.bluetoothFilter)
  kv('brave', support.brave)
  kv('can print', support.canPrint)
  kv('paths', support.paths.join(', '))
  for (const [k, v] of Object.entries(extras.facts ?? {})) kv(k, v)

  lines.push('', '## Connection')
  kv('path', snap.path)
  kv('state', snap.state)
  kv('transport', snap.transport ? `${snap.transport.kind} · ${snap.transport.label}` : null)
  if (snap.transport?.bluetoothServiceClassId) kv('bt service', snap.transport.bluetoothServiceClassId)
  kv('model', snap.model)
  kv('media', snap.media ? `${snap.media.id} (${snap.media.widthMm} mm ${snap.media.kind})` : null)
  if (snap.status) {
    kv('status', `${snap.status.ready ? 'ready' : 'not ready'} · ${snap.status.mediaWidthMm} mm ${snap.status.mediaType} · ${snap.status.tapeColor.name}/${snap.status.textColor.name}`)
    kv('status hex', toHex(Uint8Array.from(snap.status.raw)))
    if (snap.status.errors.length) kv('printer errors', snap.status.errors.map((e) => e.id).join(', '))
  } else kv('status hex', null)
  if (snap.openProgress) kv('open progress', `attempt ${snap.openProgress.attempt} of ${snap.openProgress.of}`)
  if (snap.problem) {
    kv('problem', `${snap.problem.id} (${snap.problem.severity}): ${snap.problem.title}`)
    if (snap.problem.technical) kv('technical', snap.problem.technical)
  }

  for (const p of extras.probes ?? []) {
    lines.push('', `## Probe: ${p.path}`)
    for (const s of p.result.steps) lines.push(`${s.ok ? 'ok  ' : 'FAIL'} ${s.label.padEnd(22)} ${`${Math.round(s.ms)} ms`.padStart(9)}${s.detail ? `  ${s.detail}` : ''}`)
    if (p.result.reply) lines.push(`reply: ${toHex(p.result.reply)}`)
  }

  const entries = log.entries()
  const tail = extras.logTail ?? 200
  lines.push('', `## Packet log (last ${Math.min(tail, entries.length)} of ${entries.length})`)
  for (const e of entries.slice(-tail)) lines.push(formatLogEntry(e))

  return maskText(lines.join('\n'))
}

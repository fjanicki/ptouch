// W5 — diagnostics report masking (device names, BT addresses) and the raw link probe.
// (Persistence proper: migrate/share/store/files/prefs.test.ts in this folder.)
import { beforeAll, describe, expect, it } from 'vitest'
import { INITIAL_SNAPSHOT, PacketLog, detectSupport, type SupportInfo, type Transport, type TransportEvent, type OpenOptions } from '../../../src/printer'
import { buildReport, maskDeviceLabel, maskText } from '../../../src/ui/diagnostics/report'
import { findStatusFrame, probeTransport } from '../../../src/ui/diagnostics/probe'
import { P710BT_STATUS_24MM, loadWasmForTests } from '../../helpers/wasm'

const SUPPORT: SupportInfo = detectSupport({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  serial: { requestPort() {}, getPorts() {} },
  usb: {},
})

describe('diagnostics report', () => {
  it('masks device-name suffixes and BT addresses', () => {
    expect(maskDeviceLabel('PT-P710BT1234')).toBe('PT-P710BTxxxx')
    expect(maskDeviceLabel('aa:bb:cc:dd:ee:ff')).toBe('XX:XX:XX:XX:XX:XX')
    expect(maskDeviceLabel('cu.PT-P710BT9A7F-SerialPort')).toBe('cu.PT-P710BTxxxx-SerialPort')
    expect(maskDeviceLabel('PT-P300BTAB12')).toBe('PT-P300BTxxxx')
    expect(maskDeviceLabel('PT-P750W5678')).toBe('PT-P750Wxxxx')
    expect(maskDeviceLabel('00-1B-2C-3D-4E-5F')).toBe('XX:XX:XX:XX:XX:XX')
  })

  it('leaves model names, hex dumps and ordinary text alone', () => {
    for (const s of ['PT-P710BT', 'PT-P710BTxxxx', 'PT-E550W', 'PT-P900W', 'PT-D610BT', '80 20 42 30 76 30 00 00', 'web serial: true', 'tze128-24']) {
      expect(maskText(s)).toBe(s)
    }
  })

  it('masks serial numbers', () => {
    expect(maskText('serialNumber: E7Z123456')).toBe('serialNumber: ***')
    expect(maskText('"serial_number":"ABC123"')).toBe('"serial_number":"***"')
  })

  it('builds a report without any unmasked device name', () => {
    const log = new PacketLog()
    log.note('opened cu.PT-P710BT4F2A at aa:bb:cc:dd:ee:ff')
    log.push('>>', new Uint8Array([0x1b, 0x69, 0x53]))
    log.push('<<', P710BT_STATUS_24MM)
    log.push('>>', new Uint8Array(300))
    const snap = {
      ...INITIAL_SNAPSHOT,
      path: 'bluetooth' as const,
      state: 'ready' as const,
      transport: { kind: 'serial-rfcomm' as const, label: 'PT-P710BT4F2A', persistentGrant: true, bluetoothServiceClassId: '00001101-0000-1000-8000-00805f9b34fb' },
      model: 'PT-P710BT',
    }
    const text = buildReport(SUPPORT, snap, log, { appVersion: 'test', wasmVersion: '0.1.0', userAgent: 'UA/1.0', now: new Date(0) })
    expect(text).not.toMatch(/4F2A/i)
    expect(text).not.toMatch(/aa:bb/i)
    expect(text).toContain('PT-P710BTxxxx')
    expect(text).toContain('serial-rfcomm')
    expect(text).toContain('engine:            chromium')
    expect(text).toContain('<< 80 20 42 30')
    expect(text).toContain('(+236 bytes, 300 total)')
    expect(text).toContain('00001101-0000-1000-8000-00805f9b34fb')
  })
})

/** A scripted transport: fails `openFailures` opens, replies to the status request (or not). */
class FakeTransport implements Transport {
  readonly info = { kind: 'serial-rfcomm' as const, label: 'PT-P710BT1234', persistentGrant: true }
  isOpen = false
  opens = 0
  closes = 0
  #listeners = new Set<(e: TransportEvent) => void>()
  constructor(private readonly opts: { openFailures?: number; silent?: boolean } = {}) {}
  async open(o?: OpenOptions): Promise<void> {
    this.opens++
    o?.onProgress?.({ attempt: 1, of: 3 })
    if ((this.opts.openFailures ?? 0) >= this.opens) throw new DOMException('Failed to open serial port.', 'NetworkError')
    this.isOpen = true
  }
  async write(bytes: Uint8Array): Promise<void> {
    if (this.opts.silent) return
    // reply to ESC i S, fragmented like RFCOMM (7 + 25)
    if (bytes.at(-1) === 0x53) {
      setTimeout(() => this.#emit({ type: 'data', bytes: P710BT_STATUS_24MM.slice(0, 7) }), 5)
      setTimeout(() => this.#emit({ type: 'data', bytes: P710BT_STATUS_24MM.slice(7) }), 10)
    }
  }
  async abortWrites(): Promise<void> {}
  async close(): Promise<void> {
    this.closes++
    this.isOpen = false
  }
  subscribe(fn: (e: TransportEvent) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }
  #emit(e: TransportEvent): void {
    for (const fn of this.#listeners) fn(e)
  }
}

describe('probeTransport', () => {
  beforeAll(() => loadWasmForTests())

  it('finds a status frame inside noise', () => {
    const buf = new Uint8Array([0x00, 0x06, ...P710BT_STATUS_24MM, 0x01])
    expect(findStatusFrame(buf)).toEqual(P710BT_STATUS_24MM)
    expect(findStatusFrame(P710BT_STATUS_24MM.slice(0, 31))).toBeUndefined()
    // Core framing: a truncated frame followed by a full one yields the full one, not a window
    // glued together from both (the old TS scan matched on 80 20 alone).
    const truncated = new Uint8Array([...P710BT_STATUS_24MM.subarray(0, 10), ...P710BT_STATUS_24MM])
    expect(findStatusFrame(truncated)).toEqual(P710BT_STATUS_24MM)
  })

  it('opens, sends the handshake, times the reply and closes, ×3', async () => {
    const t = new FakeTransport()
    const log = new PacketLog()
    const r = await probeTransport(t, 3, undefined, { log, pauseMs: 1 })
    expect(r.replies).toBe(3)
    expect(r.reply).toEqual(P710BT_STATUS_24MM)
    expect(t.opens).toBe(3)
    expect(t.closes).toBe(3)
    expect(r.steps.map((s) => s.label)).toEqual(['open #1', 'write #1', 'status reply #1', 'close #1', 'open #2', 'write #2', 'status reply #2', 'close #2', 'open #3', 'write #3', 'status reply #3', 'close #3'])
    expect(r.steps.every((s) => s.ok)).toBe(true)
    const sent = log.entries().find((e) => e.dir === '>>')?.bytes
    expect(sent?.subarray(-3)).toEqual(new Uint8Array([0x1b, 0x69, 0x53]))
    expect(log.entries().filter((e) => e.dir === '<<')).toHaveLength(6)
  })

  it('records open failures and keeps cycling', async () => {
    const t = new FakeTransport({ openFailures: 1 })
    const r = await probeTransport(t, 2, undefined, { pauseMs: 1 })
    expect(r.steps[0]).toMatchObject({ label: 'open #1', ok: false })
    expect(r.steps[0]?.detail).toMatch(/NetworkError/)
    expect(r.replies).toBe(1)
  })

  it('times out on a silent port (Firefox cu.* case) and still closes', async () => {
    const t = new FakeTransport({ silent: true })
    const r = await probeTransport(t, 1, undefined, { replyTimeoutMs: 50 })
    expect(r.replies).toBe(0)
    expect(r.steps.find((s) => s.label === 'status reply')).toMatchObject({ ok: false })
    expect(r.steps.at(-1)).toMatchObject({ label: 'close', ok: true })
  })

  it('stops when aborted', async () => {
    const t = new FakeTransport({ silent: true })
    const ac = new AbortController()
    const p = probeTransport(t, 3, ac.signal, { replyTimeoutMs: 5000 })
    setTimeout(() => ac.abort(), 20)
    const r = await p
    expect(t.opens).toBe(1)
    expect(t.closes).toBe(1)
    expect(r.replies).toBe(0)
  })
})

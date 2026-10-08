// W2 — WebSerialTransport against a PortLike fake built from real WHATWG streams (ARCHITECTURE §8.4):
// fragmented status (7 + 25), open() NetworkError ×1 then success (retry + progress events),
// chunking (chunkSize) with writer.ready awaited, releaseLock on error, single read pump,
// abort/cancel, port.readable → null ⇒ 'lost'.
import { describe, expect, it } from 'vitest'
import { LinkLostError, OpenFailedError, WrongPortError } from '../../../src/printer/errors'
import { describeProblem } from '../../../src/printer/problems'
import { DEFAULT_OPEN_RETRY } from '../../../src/printer/retry'
import { detectSupport } from '../../../src/printer/support'
import type { OpenProgress, TransportEvent } from '../../../src/printer/transport'
import { SPP_UUID, WebSerialTransport } from '../../../src/printer/webserial'
import { P710BT_STATUS_24MM } from '../../helpers/wasm'
import { FakeClock, FakePort, FakeSerial, eventually, flush } from './fakes'

const FAST_RETRY = { ...DEFAULT_OPEN_RETRY, backoffMs: [0] }
const CHROME_MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36', serial: { requestPort() {} }, usb: { requestDevice() {} } }

function rfcommPort(opts: ConstructorParameters<typeof FakePort>[0] = {}): FakePort {
  return new FakePort({ info: { bluetoothServiceClassId: SPP_UUID }, ...opts })
}

/** open() waits until release() (Chrome's hanging first RFCOMM open). */
class GatedOpenPort extends FakePort {
  #gates: (() => void)[] = []
  constructor() {
    super({ info: { bluetoothServiceClassId: SPP_UUID } })
  }
  override async open(o: SerialOptions): Promise<void> {
    await new Promise<void>((r) => this.#gates.push(r))
    return super.open(o)
  }
  release(): void {
    for (const g of this.#gates.splice(0)) g()
  }
}

/** close() takes 50 ms (FakeClock not involved: real timers would slow tests, so a microtask chain). */
class SlowClosePort extends FakePort {
  override async close(): Promise<void> {
    for (let i = 0; i < 20; i++) await flush()
    return super.close()
  }
}

function collect(t: WebSerialTransport): TransportEvent[] {
  const events: TransportEvent[] = []
  t.subscribe((e) => events.push(e))
  return events
}

describe('WebSerialTransport: identity', () => {
  it('classifies a direct-RFCOMM entry and an OS port', () => {
    const bt = new WebSerialTransport(rfcommPort())
    expect(bt.mode).toBe('rfcomm')
    expect(bt.info).toMatchObject({ kind: 'serial-rfcomm', persistentGrant: true, bluetoothServiceClassId: SPP_UUID })
    const os = new WebSerialTransport(new FakePort())
    expect(os.info).toMatchObject({ kind: 'serial-os-port', label: 'Serial port', persistentGrant: false })
    // Gecko tags OS ports with SPP (Firefox ≥156) but has no direct RFCOMM.
    expect(new WebSerialTransport(rfcommPort(), {}, true).info.kind).toBe('serial-os-port')
  })
})

describe('WebSerialTransport: open', () => {
  it('opens with 9600 baud, 16 KiB buffer, no flow control, then asserts DTR/RTS', async () => {
    const port = rfcommPort()
    const t = new WebSerialTransport(port)
    await t.open()
    expect(t.isOpen).toBe(true)
    expect(port.lastOpenOptions).toEqual({ baudRate: 9600, bufferSize: 16384, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' })
    expect(port.signals).toEqual([{ dataTerminalReady: true, requestToSend: true }])
    await t.close()
  })

  it('retries open() on NetworkError and reports progress ("waking printer")', async () => {
    const port = rfcommPort({ openFailures: 1 })
    const clock = new FakeClock()
    const t = new WebSerialTransport(port, { clock })
    const progress: OpenProgress[] = []
    const opening = t.open({ onProgress: (p) => progress.push(p) })
    await clock.advance(300)
    await opening
    expect(port.openCalls).toBe(2)
    expect(clock.delays).toEqual([300]) // DEFAULT_OPEN_RETRY backoff
    expect(progress.map((p) => [p.attempt, p.of])).toEqual([
      [1, 3],
      [2, 3],
    ])
    expect((progress[1]?.lastError as DOMException).name).toBe('NetworkError')
    expect(t.isOpen).toBe(true)
    await t.close()
  })

  it('gives up after 3 attempts with backoff [300, 1000] → open-failed problem', async () => {
    const port = rfcommPort({ openFailures: 3 })
    const clock = new FakeClock()
    const t = new WebSerialTransport(port, { clock })
    const opening = t.open().catch((e: unknown) => e)
    await clock.advance(2000)
    const err = await opening
    expect(err).toBeInstanceOf(OpenFailedError)
    expect((err as OpenFailedError).attempts).toBe(3)
    expect(port.openCalls).toBe(3)
    expect(clock.delays).toEqual([300, 1000])
    const p = describeProblem(err, { support: detectSupport(CHROME_MAC), transport: t.info, stage: 'open', path: 'bluetooth' })
    expect(p.id).toBe('open-failed')
    expect(p.actions).toContain('choose-port')
    expect(p.actions).toContain('retry')
  })

  it('does not retry other errors (InvalidStateError gets one close-and-reopen, nothing more)', async () => {
    const port = rfcommPort({ openFailures: 2, openError: () => new DOMException('already open', 'InvalidStateError') })
    const t = new WebSerialTransport(port, { openRetry: FAST_RETRY })
    await expect(t.open()).rejects.toMatchObject({ name: 'InvalidStateError' })
    expect(port.openCalls).toBe(2)
    expect(port.closeCalls).toBe(1)
  })

  it('recovers a port left open by a failed close ("The port is already open")', async () => {
    const port = rfcommPort()
    port.isOpen = true // leaked by an earlier close() that was rejected
    const t = new WebSerialTransport(port, { openRetry: FAST_RETRY })
    await t.open()
    expect(t.isOpen).toBe(true)
    expect(port.openCalls).toBe(2)
    await t.close()
  })

  it('concurrent open() calls share one platform open()', async () => {
    const port = new GatedOpenPort()
    const t = new WebSerialTransport(port)
    const a = t.open()
    const b = t.open()
    port.release()
    await Promise.all([a, b])
    expect(port.openCalls).toBe(1)
    expect(t.isOpen).toBe(true)
    await t.close()
  })

  it('close() during a hanging open() aborts it; the late open is closed again', async () => {
    const port = new GatedOpenPort()
    const t = new WebSerialTransport(port)
    const opening = t.open().catch((e: unknown) => e)
    await flush()
    await t.close()
    expect(await opening).toMatchObject({ name: 'AbortError' })
    expect(t.isOpen).toBe(false)
    port.release() // the platform open() completes after we gave up
    await eventually(() => port.closeCalls === 1)
    expect(port.isOpen).toBe(false)
    expect(t.isOpen).toBe(false)
    // A new open() works (waits for the abandoned one first).
    const again = t.open()
    port.release()
    await again
    expect(t.isOpen).toBe(true)
    await t.close()
  })

  it('an AbortSignal rejects at once during a hanging open() (no 10 s wait)', async () => {
    const port = new GatedOpenPort()
    const t = new WebSerialTransport(port)
    const ac = new AbortController()
    const opening = t.open({ signal: ac.signal }).catch((e: unknown) => e)
    await flush()
    ac.abort()
    expect(await opening).toMatchObject({ name: 'AbortError' })
    port.release()
    await eventually(() => port.closeCalls === 1)
    expect(port.isOpen).toBe(false)
  })

  it('stops retrying when aborted during the backoff', async () => {
    const port = rfcommPort({ openFailures: 2 })
    const clock = new FakeClock()
    const t = new WebSerialTransport(port, { clock })
    const ac = new AbortController()
    const opening = t.open({ signal: ac.signal }).catch((e: unknown) => e)
    await clock.advance(100)
    ac.abort()
    expect(await opening).toMatchObject({ name: 'AbortError' })
    expect(port.openCalls).toBe(1)
  })
})

describe('WebSerialTransport: read pump', () => {
  it('forwards a status split 7 + 25 bytes as two data events', async () => {
    const port = rfcommPort()
    const t = new WebSerialTransport(port)
    const events = collect(t)
    await t.open()
    port.push(P710BT_STATUS_24MM.subarray(0, 7))
    port.push(P710BT_STATUS_24MM.subarray(7))
    await eventually(() => events.length === 2)
    const data = events.map((e) => (e.type === 'data' ? Array.from(e.bytes) : []))
    expect(data[0]).toHaveLength(7)
    expect(data[1]).toHaveLength(25)
    expect(data.flat()).toEqual(Array.from(P710BT_STATUS_24MM))
    await t.close()
  })

  it('emits lost when the readable errors fatally (readable → null)', async () => {
    const port = rfcommPort()
    const t = new WebSerialTransport(port)
    const events = collect(t)
    await t.open()
    port.failRead()
    await eventually(() => events.some((e) => e.type === 'lost'))
    expect(t.isOpen).toBe(false)
    const lost = events.find((e) => e.type === 'lost')
    expect(lost?.type === 'lost' && lost.error).toBeInstanceOf(LinkLostError)
    // Teardown closed the port cleanly (no locked streams) so Reconnect can re-open it.
    await eventually(() => port.closeCalls > 0)
    expect(port.closeErrors).toBe(0)
    port.openFailures = 0
    await t.open()
    expect(t.isOpen).toBe(true)
    await t.close()
  })

  it('keeps reading after a non-fatal BufferOverrunError', async () => {
    const port = rfcommPort()
    const t = new WebSerialTransport(port)
    const events = collect(t)
    await t.open()
    port.overrun()
    await flush()
    port.push([1, 2, 3])
    await eventually(() => events.some((e) => e.type === 'data'))
    expect(events.some((e) => e.type === 'lost')).toBe(false)
    await t.close()
  })

  it('emits lost when the stream ends without close() and on a disconnect event', async () => {
    const port = rfcommPort()
    const t = new WebSerialTransport(port)
    const events = collect(t)
    await t.open()
    port.endRead()
    await eventually(() => events.some((e) => e.type === 'lost'))

    const port2 = rfcommPort()
    const t2 = new WebSerialTransport(port2)
    const events2 = collect(t2)
    await t2.open()
    port2.disconnect()
    await eventually(() => events2.some((e) => e.type === 'lost'))
    expect(events2.filter((e) => e.type === 'lost')).toHaveLength(1)
  })
})

describe('WebSerialTransport: write', () => {
  it('writes in chunkSize slices, awaiting writer.ready before each', async () => {
    const port = rfcommPort()
    const t = new WebSerialTransport(port, { tuning: { chunkSize: 960, interChunkDelayMs: 0 } })
    await t.open()
    const bytes = Uint8Array.from({ length: 2500 }, (_, i) => i & 0xff)
    await t.write(bytes)
    expect(port.received.map((c) => c.length)).toEqual([960, 960, 580])
    expect(port.bytesReceived()).toEqual(bytes)
    expect(port.writerCalls).toEqual(['ready', 'write:960', 'ready', 'write:960', 'ready', 'write:580'])
    expect(port.writable?.locked).toBe(false) // lock released
    await t.close()
  })

  it('applies backpressure: never more than one chunk queued on a slow link', async () => {
    const port = rfcommPort()
    const t = new WebSerialTransport(port, { tuning: { chunkSize: 320, interChunkDelayMs: 0 } })
    await t.open()
    const releases: (() => void)[] = []
    port.gate = () => new Promise<void>((r) => releases.push(r))
    const writing = t.write(new Uint8Array(1000))
    for (let i = 0; i < 4; i++) {
      await eventually(() => releases.length === i + 1)
      await flush()
      // Only the chunk in the sink has been handed over; the next waits for ready.
      expect(port.writerCalls.filter((c) => c.startsWith('write')).length).toBe(i + 1)
      releases[i]?.()
    }
    await writing
    expect(port.received.map((c) => c.length)).toEqual([320, 320, 320, 40])
    await t.close()
  })

  it('serialises concurrent write() calls', async () => {
    const port = rfcommPort()
    const t = new WebSerialTransport(port, { tuning: { chunkSize: 4, interChunkDelayMs: 0 } })
    await t.open()
    await Promise.all([t.write(Uint8Array.from([1, 2, 3, 4, 5])), t.write(Uint8Array.from([6, 7]))])
    expect(Array.from(port.bytesReceived())).toEqual([1, 2, 3, 4, 5, 6, 7])
    await t.close()
  })

  it('releases the writer lock and reports lost when the sink fails', async () => {
    const port = rfcommPort()
    const t = new WebSerialTransport(port)
    const events = collect(t)
    await t.open()
    port.sinkError = new DOMException('The device has been lost.', 'NetworkError')
    await expect(t.write(new Uint8Array(10))).rejects.toBeInstanceOf(LinkLostError)
    expect(events.some((e) => e.type === 'lost')).toBe(true)
    await eventually(() => port.closeCalls > 0)
    expect(port.closeErrors).toBe(0) // reader + writer locks were released before close()
  })

  it('abortWrites() discards queued data; later writes still work', async () => {
    const port = rfcommPort()
    const t = new WebSerialTransport(port, { tuning: { chunkSize: 100, interChunkDelayMs: 0 } })
    const events = collect(t)
    await t.open()
    const releases: (() => void)[] = []
    port.gate = () => new Promise<void>((r) => releases.push(r))
    const writing = t.write(new Uint8Array(1000)).catch((e: unknown) => e)
    await eventually(() => releases.length === 1)
    await t.abortWrites()
    releases.forEach((r) => r())
    expect(await writing).toMatchObject({ name: 'AbortError' })
    expect(port.received.length).toBeLessThan(10)
    expect(events.some((e) => e.type === 'lost')).toBe(false)
    port.gate = null
    await t.write(Uint8Array.from([0x1b, 0x40]))
    expect(Array.from(port.received.at(-1) ?? [])).toEqual([0x1b, 0x40])
    await t.close()
  })

  it('an AbortSignal cancels a write', async () => {
    const port = rfcommPort()
    const t = new WebSerialTransport(port, { tuning: { chunkSize: 100, interChunkDelayMs: 0 } })
    await t.open()
    const releases: (() => void)[] = []
    port.gate = () => new Promise<void>((r) => releases.push(r))
    const ac = new AbortController()
    const writing = t.write(new Uint8Array(500), ac.signal).catch((e: unknown) => e)
    await eventually(() => releases.length === 1)
    ac.abort()
    releases.forEach((r) => r())
    expect(await writing).toMatchObject({ name: 'AbortError' })
    port.gate = null
    await t.close()
  })

  it('rejects writes when not open', async () => {
    const t = new WebSerialTransport(rfcommPort())
    await expect(t.write(new Uint8Array(1))).rejects.toBeInstanceOf(LinkLostError)
  })
})

describe('WebSerialTransport: close', () => {
  it('cancels the reader, releases locks, closes the port; idempotent and re-openable', async () => {
    const port = rfcommPort()
    const t = new WebSerialTransport(port)
    const events = collect(t)
    await t.open()
    await t.close()
    expect(port.readerCancelled).toBe(1)
    expect(port.closeCalls).toBe(1)
    expect(port.closeErrors).toBe(0)
    expect(port.isOpen).toBe(false)
    await t.close()
    expect(port.closeCalls).toBe(1)
    expect(events.some((e) => e.type === 'lost')).toBe(false)
    await t.open()
    expect(port.openCalls).toBe(2)
    await t.close()
  })

  it('open() right after a slow close() waits for it (no InvalidStateError)', async () => {
    const port = new SlowClosePort({ info: { bluetoothServiceClassId: SPP_UUID } })
    const clock = new FakeClock()
    const t = new WebSerialTransport(port, { clock })
    await t.open()
    void t.close()
    const reopen = t.open()
    await clock.advance(100)
    await reopen
    expect(t.isOpen).toBe(true)
    expect(port.openCalls).toBe(2)
    const close = t.close()
    await clock.advance(100)
    await close
  })

  it('a write stuck in the sink does not leak the OS port: close is retried, re-open recovers', async () => {
    const port = rfcommPort()
    const clock = new FakeClock()
    const t = new WebSerialTransport(port, { clock })
    await t.open()
    let unstick: () => void = () => {}
    port.gate = () => new Promise<void>((r) => (unstick = r))
    const writing = t.write(new Uint8Array(5000)).catch((e: unknown) => e)
    await flush()
    const closing = t.close()
    await clock.advance(2100)
    await closing
    expect(t.isOpen).toBe(false)
    expect(port.closeErrors).toBe(1) // writable still locked by the stuck sink write
    expect(port.isOpen).toBe(true)
    // The link finally times out: the write unwinds, the deferred close runs.
    port.gate = null
    unstick()
    await writing
    await eventually(() => !port.isOpen)
    await t.open()
    expect(t.isOpen).toBe(true)
    await t.close()
  })

  it('an InvalidStateError on re-open of our own leaked port is not blamed on another tab', () => {
    const p = describeProblem(new DOMException('The port is already open.', 'InvalidStateError'), { support: detectSupport(CHROME_MAC), stage: 'open', transport: new WebSerialTransport(rfcommPort()).info })
    expect(p.id).toBe('port-in-use')
    expect(p.detail).not.toMatch(/another tab/i)
    expect(p.detail).toMatch(/reload/i)
  })

  it('forget() closes and revokes the grant', async () => {
    const port = rfcommPort()
    const t = new WebSerialTransport(port)
    await t.open()
    await t.forget()
    expect(port.forgotten).toBe(true)
    expect(port.isOpen).toBe(false)
  })
})

describe('WebSerialTransport: choosers', () => {
  it('requestBluetooth calls requestPort synchronously with the SPP filter (Chromium)', async () => {
    const serial = new FakeSerial()
    const pending = WebSerialTransport.requestBluetooth(serial, {}, false)
    expect(serial.calls).toHaveLength(1) // before any await: user activation preserved
    expect(serial.calls[0]).toEqual({ filters: [{ bluetoothServiceClassId: SPP_UUID }], allowedBluetoothServiceClassIds: [SPP_UUID] })
    expect((await pending).mode).toBe('rfcomm')
  })

  it('falls back to the unfiltered chooser on TypeError (Chromium < 117)', async () => {
    const serial = new FakeSerial()
    serial.next.push(() => Promise.reject(new TypeError("Failed to read the 'filters' property")))
    await WebSerialTransport.requestBluetooth(serial, {}, false)
    expect(serial.calls).toEqual([{ filters: [{ bluetoothServiceClassId: SPP_UUID }], allowedBluetoothServiceClassIds: [SPP_UUID] }, undefined])
  })

  it('never filters on Gecko and passes NotFoundError (cancel) through', async () => {
    const serial = new FakeSerial()
    await WebSerialTransport.requestBluetooth(serial, {}, true)
    expect(serial.calls).toEqual([undefined])
    serial.next.push(() => Promise.reject(new DOMException('No port selected by the user.', 'NotFoundError')))
    await expect(WebSerialTransport.requestAnyPort(serial, {}, false)).rejects.toMatchObject({ name: 'NotFoundError' })
  })

  it('fromGranted prefers connected RFCOMM entries and honours the match', async () => {
    const os = new FakePort()
    const btOff = rfcommPort({ connected: false })
    const btOn = rfcommPort({ connected: true })
    const serial = new FakeSerial([os, btOff, btOn])
    expect((await WebSerialTransport.fromGranted(undefined, serial, {}, false))?.port).toBe(btOn)
    expect((await WebSerialTransport.fromGranted({ kind: 'serial-os-port' }, serial, {}, false))?.port).toBe(os)
    expect(await WebSerialTransport.fromGranted({ kind: 'serial-rfcomm' }, new FakeSerial([os]), {}, false)).toBeNull()
    expect(await WebSerialTransport.fromGranted(undefined, new FakeSerial([]), {}, false)).toBeNull()
  })

  // Chrome lists the P710BT twice: SPP (channel 1) and Apple "Wireless iAP" (channel 2).
  const IAP_UUID = '00000000-deca-fade-deca-deafdecacaff'

  it('fromGranted never picks the iAP entry, even when it is the only one', async () => {
    const iap = new FakePort({ info: { bluetoothServiceClassId: IAP_UUID } })
    const spp = rfcommPort({ connected: false })
    expect((await WebSerialTransport.fromGranted(undefined, new FakeSerial([iap, spp]), {}, false))?.port).toBe(spp)
    expect(await WebSerialTransport.fromGranted(undefined, new FakeSerial([iap]), {}, false)).toBeNull()
  })

  it('requestAnyPort rejects the iAP entry with WrongPortError', async () => {
    const serial = new FakeSerial([new FakePort({ info: { bluetoothServiceClassId: IAP_UUID } })])
    await expect(WebSerialTransport.requestAnyPort(serial, {}, false)).rejects.toBeInstanceOf(WrongPortError)
  })
})

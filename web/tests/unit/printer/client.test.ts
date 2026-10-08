// W2 — PrinterClient + MockTransport (wasm VirtualPrinter) with a fake Clock:
// connect → ready (24 mm), print 2 copies → progress events → done, last written byte 0x1A,
// silent printer → 'no-reply', cover open mid-job, wrong media, disconnect mid-job → 'lost'.
import { beforeAll, describe, expect, it } from 'vitest'
import { PrinterClient, type ClientState, type PrintProgress, type PrinterEvent } from '../../../src/printer/client'
import { LinkLostError, SessionFailedError } from '../../../src/printer/errors'
import { MockTransport, type MockScenario } from '../../../src/printer/mock'
import { PacketLog } from '../../../src/printer/packetlog'
import { describeProblem, isUserCancel } from '../../../src/printer/problems'
import { detectSupport } from '../../../src/printer/support'
import { WebSerialTransport } from '../../../src/printer/webserial'
import { Bitmap1, encodeJob, isPtouchError, mediaForWidth, printArea, type Job } from '../../../src/wasm'
import { loadWasmForTests, P710BT_STATUS_24MM } from '../../helpers/wasm'
import { FakeClock, FakePort, SlowRfcommPort, answerStatus, flush } from './fakes'

const CHROME_MAC = detectSupport({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36', serial: { requestPort() {} }, usb: { requestDevice() {} } })
const FIREFOX_MAC = detectSupport({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0', serial: { requestPort() {} } })

beforeAll(() => loadWasmForTests())

/** A 2-page job for 24 mm tape (200 lines per page ≈ 28 mm). Caller frees. */
function makeJob(mediaId = 'tze128-24', pages = 2, length = 200): Job {
  const { heightDots } = printArea('PT-P710BT', mediaId)
  const bpl = Math.ceil(heightDots / 8)
  const data = new Uint8Array(length * bpl).map((_, i) => (i % 5 === 0 ? 0xf0 : 0))
  const bm = Bitmap1.fromPacked(length, heightDots, data)
  const job = encodeJob('PT-P710BT', mediaId, Array.from({ length: pages }, () => bm.clone()), {})
  bm.free()
  return job
}

function setup(scenario: Partial<MockScenario> = {}, opts: { keepaliveMs?: number } = {}) {
  const clock = new FakeClock()
  const transport = new MockTransport(scenario, clock)
  const log = new PacketLog()
  const client = new PrinterClient(transport, { clock, log, keepaliveMs: opts.keepaliveMs ?? 0 })
  const events: PrinterEvent[] = []
  client.on((e) => events.push(e))
  const states = () => events.flatMap((e) => (e.type === 'state' ? [e.state] : []))
  const progress = () => events.flatMap((e) => (e.type === 'progress' ? [e.progress] : []))
  return { clock, transport, client, events, states, progress, log }
}

/** Runs `p` to completion on the fake clock. */
async function run<T>(clock: FakeClock, p: Promise<T>, maxMs = 120_000): Promise<T> {
  let done = false
  let value: T | undefined
  let error: unknown
  let failed = false
  p.then(
    (v) => ((done = true), (value = v)),
    (e: unknown) => ((done = true), (failed = true), (error = e)),
  )
  await clock.until(() => done, maxMs)
  if (!done) throw new Error('operation did not settle')
  if (failed) throw error
  return value as T
}

describe('PrinterClient + MockTransport', () => {
  it('connects to a virtual PT-P710BT and reports 24 mm media', async () => {
    const { clock, client, states, transport } = setup({ fragment: [7, 25] })
    const status = await run(clock, client.connect())
    expect(status.modelName).toBe('PT-P710BT')
    expect(status.mediaWidthMm).toBe(24)
    expect(status.mediaId).toBe('tze128-24')
    expect(client.state).toBe('ready')
    expect(client.modelName).toBe('PT-P710BT')
    expect(states()).toEqual(['opening', 'handshaking', 'ready'])
    // Handshake = invalidate + ESC @ (+ ESC i a 01) then ESC i S.
    const sent = transport.writtenBytes()
    expect(Array.from(sent.subarray(-3))).toEqual([0x1b, 0x69, 0x53])
    expect(sent[0]).toBe(0x00)
    // Idle status equals the real fixture.
    expect(status.raw).toEqual(Array.from(P710BT_STATUS_24MM))
  })

  it('shows the waking state while open() retries', async () => {
    const { clock, client, states, events } = setup({ openFailures: 1 })
    await run(clock, client.connect())
    expect(states()).toEqual(['opening', 'waking', 'handshaking', 'ready'])
    const opens = events.flatMap((e) => (e.type === 'open-progress' ? [e.progress.attempt] : []))
    expect(opens).toEqual([1, 2])
  })

  it('prints a 2-page job with truthful progress; last byte 0x1A', async () => {
    const { clock, client, transport, progress, states } = setup({ fragment: [7, 25] })
    await run(clock, client.connect())
    const job = makeJob()
    const t0 = clock.now()
    await run(clock, client.print(job))
    const p: PrintProgress[] = progress()
    expect(p).toEqual([
      { page: 1, of: 2, phase: 'sending' },
      { page: 1, of: 2, phase: 'printing' },
      { page: 2, of: 2, phase: 'sending' },
      { page: 2, of: 2, phase: 'printing' },
      { page: 2, of: 2, phase: 'done' },
    ])
    // Progress followed the printer's frames, not write completion: printing takes time.
    expect(clock.now() - t0).toBeGreaterThan(1000)
    const sent = transport.writtenBytes()
    expect(sent[sent.length - 1]).toBe(0x1a)
    expect(transport.violations()).toEqual([])
    const pages = transport.printedPages()
    expect(pages).toHaveLength(2)
    pages.forEach((pg) => pg.free())
    expect(client.state).toBe('ready')
    expect(states()).toContain('printing')
    job.free()
  })

  it('never sends anything while a page prints (keepalive paused)', async () => {
    const { clock, client, transport } = setup({}, { keepaliveMs: 50 })
    await run(clock, client.connect())
    const job = makeJob('tze128-24', 1, 400)
    const printing = client.print(job)
    await clock.until(() => client.state === 'printing')
    await clock.advance(20)
    const before = transport.written.length
    // While the page prints (≈2.5 s in the virtual timing), no further writes happen.
    await clock.advance(1000)
    expect(transport.written.length).toBe(before)
    await run(clock, printing)
    job.free()
  })

  it('sends keepalive ESC i S while idle', async () => {
    const { clock, client, transport } = setup({}, { keepaliveMs: 60_000 })
    await run(clock, client.connect())
    const n = transport.written.length
    await clock.advance(60_100)
    expect(transport.written.length).toBe(n + 1)
    expect(Array.from(transport.written.at(-1) ?? [])).toEqual([0x1b, 0x69, 0x53])
    expect(client.state).toBe('ready')
  })

  it('reports no-reply when the printer is silent (and closes the port)', async () => {
    const { clock, client, transport } = setup({ behaviour: { kind: 'silent' } })
    const err = await run(clock, client.connect()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionFailedError)
    expect((err as SessionFailedError).code).toBe('TIMEOUT')
    expect(client.state).toBe('no-reply')
    expect(transport.isOpen).toBe(false)
    expect(describeProblem(err, { support: CHROME_MAC, transport: transport.info, stage: 'handshake' }).id).toBe('no-reply')
    // Firefox + macOS OS port → specific guidance.
    expect(describeProblem(err, { support: FIREFOX_MAC, transport: { kind: 'serial-os-port', label: 'Serial port', persistentGrant: false }, stage: 'handshake' }).id).toBe('no-reply-firefox')
  })

  it('reports cover open on page 2 and recovers to ready', async () => {
    const { clock, client, states } = setup({ behaviour: { kind: 'cover-open-on-page', page: 2 } })
    await run(clock, client.connect())
    const job = makeJob()
    const err = await run(clock, client.print(job)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionFailedError)
    const f = err as SessionFailedError
    expect(f.code).toBe('PRINTER')
    expect(f.printerErrors.map((e) => e.id)).toContain('cover-open')
    expect(f.resumeFromPage).toBe(2)
    expect(describeProblem(err, { support: CHROME_MAC, stage: 'print' }).id).toBe('cover-open')
    expect(states()).toContain('error')
    // The session resets the printer; the virtual cover counts as closed after the reset.
    await clock.until(() => client.state === 'ready', 60_000)
    expect(client.state).toBe('ready')
    job.free()
  })

  it('wrong media: preflight rejects a 12 mm job on 24 mm tape before sending', async () => {
    const { clock, client, transport } = setup()
    await run(clock, client.connect())
    const n = transport.written.length
    const job = makeJob(mediaForWidth('PT-P710BT', 12).id, 1)
    let err: unknown
    try {
      await client.print(job)
    } catch (e) {
      err = e
    }
    expect(isPtouchError(err)).toBe(true)
    expect((err as { code: string }).code).toBe('MEDIA_MISMATCH')
    expect(transport.written.length).toBe(n)
    expect(client.state).toBe('ready')
    const p = describeProblem(err, { support: CHROME_MAC, stage: 'print', status: client.lastStatus, designWidthMm: 12 })
    expect(p.id).toBe('wrong-media')
    expect(p.actions).toContain('switch-tape')
    expect(p.detail).toContain('24 mm')
    job.free()
  })

  it('wrong media reported by the printer (error frame) fails the job', async () => {
    const { clock, client } = setup({ behaviour: { kind: 'wrong-media' } })
    await run(clock, client.connect())
    const job = makeJob()
    const err = await run(clock, client.print(job)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionFailedError)
    expect((err as SessionFailedError).printerErrors.map((e) => e.id)).toContain('wrong-media')
    expect(describeProblem(err, { support: CHROME_MAC, stage: 'print', status: client.lastStatus }).id).toBe('wrong-media')
    job.free()
  })

  it('no tape: connect succeeds, printing is refused with NO_MEDIA', async () => {
    const { clock, client } = setup({ behaviour: { kind: 'no-media' } })
    const status = await run(clock, client.connect()).catch((e: unknown) => e)
    // Either connect reports the status (ready with errors) or rejects; both must map to no-media.
    if (status instanceof Error) {
      expect(describeProblem(status, { support: CHROME_MAC, stage: 'handshake' }).id).toBe('no-media')
      return
    }
    const job = makeJob()
    let err: unknown
    try {
      await client.print(job)
    } catch (e) {
      err = e
    }
    expect(describeProblem(err, { support: CHROME_MAC, stage: 'print' }).id).toBe('no-media')
    job.free()
  })

  it('disconnect mid-job → lost; the job is never retried', async () => {
    const { clock, client, transport } = setup({ disconnectAfterBytes: 1200 })
    await run(clock, client.connect())
    const job = makeJob('tze128-24', 2, 600)
    const err = await run(clock, client.print(job)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LinkLostError)
    expect(client.state).toBe('lost')
    const sent = transport.writtenBytes().length
    await clock.advance(60_000)
    expect(transport.writtenBytes().length).toBe(sent)
    expect(describeProblem(err, { support: CHROME_MAC, stage: 'print' }).id).toBe('link-lost')
    job.free()
  })

  it('link lost while idle emits an error event and state lost; reconnect works', async () => {
    const { clock, client, transport, events } = setup()
    await run(clock, client.connect())
    transport.simulateDisconnect()
    await flush()
    expect(client.state).toBe('lost')
    const ev = events.find((e) => e.type === 'error')
    expect(ev && ev.type === 'error' && ev.error).toBeInstanceOf(LinkLostError)
    const status = await run(clock, client.connect())
    expect(status.mediaWidthMm).toBe(24)
    expect(client.state).toBe('ready')
  })

  it('cancel during printing: CANCELLED, printer reset, back to ready', async () => {
    const { clock, client, transport } = setup()
    await run(clock, client.connect())
    const job = makeJob('tze128-24', 3, 400)
    const printing = client.print(job).catch((e: unknown) => e)
    await clock.until(() => client.state === 'printing')
    await clock.advance(100)
    const cancelling = client.cancel()
    const err = await run(clock, printing)
    expect(err).toBeInstanceOf(SessionFailedError)
    expect((err as SessionFailedError).code).toBe('CANCELLED')
    expect(isUserCancel(err)).toBe(true)
    await run(clock, cancelling)
    expect(client.state).toBe('ready')
    // The reset (ESC @) went out after the job bytes.
    const all = Array.from(transport.writtenBytes())
    const tail = all.slice(-200)
    expect(tail.join(',')).toContain([0x1b, 0x40].join(','))
    job.free()
  })

  it('an AbortSignal cancels the print', async () => {
    const { clock, client } = setup()
    await run(clock, client.connect())
    const job = makeJob('tze128-24', 2, 400)
    const ac = new AbortController()
    const printing = client.print(job, ac.signal).catch((e: unknown) => e)
    await clock.advance(100)
    ac.abort()
    const err = await run(clock, printing)
    expect(isUserCancel(err)).toBe(true)
    await clock.until(() => client.state === 'ready')
    job.free()
  })

  it('refreshStatus returns a fresh status; BUSY while printing', async () => {
    const { clock, client } = setup()
    await run(clock, client.connect())
    const s = await run(clock, client.refreshStatus())
    expect(s.ready).toBe(true)
    const job = makeJob()
    const printing = client.print(job)
    await expect(client.refreshStatus()).rejects.toMatchObject({ code: 'BUSY' })
    await run(clock, printing)
    job.free()
  })

  it('disconnect() closes the transport and is idempotent', async () => {
    const { clock, client, transport, states } = setup()
    await run(clock, client.connect())
    await client.disconnect()
    await client.disconnect()
    expect(transport.isOpen).toBe(false)
    expect(client.state).toBe('disconnected')
    expect(states().filter((s: ClientState) => s === 'disconnected')).toHaveLength(1)
  })

  it('a print right after the previous job waits for the post-job drain (no BUSY)', async () => {
    const { clock, client, transport } = setup()
    await run(clock, client.connect())
    const job = makeJob('tze128-24', 1)
    await run(clock, client.print(job))
    expect(client.state).toBe('ready')
    // Immediately again: the session is still draining (500 ms).
    await run(clock, client.print(job))
    expect(client.state).toBe('ready')
    const pages = transport.printedPages()
    expect(pages).toHaveLength(2)
    pages.forEach((pg) => pg.free())
    job.free()
  })

  it('a preflight rejection keeps the idle keepalive running', async () => {
    const { clock, client, transport } = setup({}, { keepaliveMs: 60_000 })
    await run(clock, client.connect())
    const job = makeJob(mediaForWidth('PT-P710BT', 12).id, 1)
    await client.print(job).catch(() => {})
    const n = transport.written.length
    await clock.advance(200_000)
    expect(transport.written.length).toBeGreaterThan(n)
    expect(client.state).toBe('ready')
    job.free()
  })

  it('aborting during the handshake settles promptly (not at the next status timeout)', async () => {
    const { clock, client, transport } = setup({ latencyMs: 4000 })
    const ac = new AbortController()
    const connecting = client.connect(ac.signal).catch((e: unknown) => e)
    await clock.until(() => client.state === 'handshaking')
    await clock.advance(400)
    let settled: unknown = null
    void connecting.then((e) => (settled = e))
    ac.abort()
    await clock.advance(10)
    expect(settled).toMatchObject({ name: 'AbortError' })
    expect(client.state).toBe('disconnected')
    expect(transport.isOpen).toBe(false)
  })

  it('refuses a second connect() while the first is still opening', async () => {
    const { clock, client } = setup({ openFailures: 1 })
    const first = client.connect()
    await clock.advance(1)
    expect(['opening', 'waking']).toContain(client.state)
    await expect(client.connect()).rejects.toMatchObject({ code: 'BUSY' })
    await run(clock, first)
    expect(client.state).toBe('ready')
  })

  it('logs traffic to the packet log', async () => {
    const { clock, client, log } = setup()
    await run(clock, client.connect())
    const dirs = log.entries().map((e) => e.dir)
    expect(dirs).toContain('>>')
    expect(dirs).toContain('<<')
    expect(log.toText()).toMatch(/<< 80 20 42 30 76 30/)
  })
})

describe('PrinterClient + WebSerialTransport (fake port)', () => {
  it('reassembles a 7 + 25 byte status and reaches ready', async () => {
    const clock = new FakeClock()
    const port = new FakePort({ info: { bluetoothServiceClassId: '00001101-0000-1000-8000-00805f9b34fb' } })
    const transport = new WebSerialTransport(port, { clock })
    const client = new PrinterClient(transport, { clock, keepaliveMs: 0 })
    const connecting = client.connect()
    // Answer the status request like the real printer (92 ms later, split by RFCOMM).
    await clock.until(() => {
      const b = port.bytesReceived()
      return b.length >= 3 && b[b.length - 1] === 0x53 && b[b.length - 2] === 0x69
    }, 10_000)
    await clock.advance(92)
    port.push(P710BT_STATUS_24MM.subarray(0, 7))
    await flush()
    port.push(P710BT_STATUS_24MM.subarray(7))
    const status = await run(clock, connecting)
    expect(status.mediaWidthMm).toBe(24)
    expect(client.state).toBe('ready')
    await client.disconnect()
    expect(port.isOpen).toBe(false)
    expect(port.closeErrors).toBe(0)
  })

  it('disconnect() during a hanging RFCOMM open stops the connect for good (port not left open)', async () => {
    const clock = new FakeClock()
    const port = new SlowRfcommPort(clock)
    answerStatus(port, P710BT_STATUS_24MM, clock)
    const transport = new WebSerialTransport(port, { clock })
    const client = new PrinterClient(transport, { clock, keepaliveMs: 60_000 })
    const connecting = client.connect().catch((e: unknown) => e)
    await clock.advance(2000)
    expect(client.state).toBe('waking') // slow first RFCOMM open ⇒ "Waking printer…" after 1.5 s
    await client.disconnect()
    expect(client.state).toBe('disconnected')
    expect(await connecting).toMatchObject({ name: 'AbortError' })
    await clock.advance(5 * 60_000)
    expect(client.state).toBe('disconnected')
    expect(port.isOpen).toBe(false)
    expect(transport.isOpen).toBe(false)
    expect(port.received).toHaveLength(0)
  })

  it('disconnect() while the retried open() is completing closes the late port', async () => {
    const clock = new FakeClock()
    const port = new SlowRfcommPort(clock)
    answerStatus(port, P710BT_STATUS_24MM, clock)
    const transport = new WebSerialTransport(port, { clock })
    const client = new PrinterClient(transport, { clock, keepaliveMs: 60_000 })
    const connecting = client.connect().catch((e: unknown) => e)
    await clock.advance(10_300 + 100) // first open failed, retry (378 ms) in flight
    expect(port.openCalls).toBe(1)
    await client.disconnect()
    expect(await connecting).toMatchObject({ name: 'AbortError' })
    await clock.advance(5 * 60_000)
    expect(client.state).toBe('disconnected')
    expect(port.isOpen).toBe(false)
    expect(port.received).toHaveLength(0)
  })
})

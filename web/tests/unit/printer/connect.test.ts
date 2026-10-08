// W2 — ConnectionManager: path selection per SupportInfo (chooser called synchronously),
// virtual connect → snapshot, waking progress, restore() from remembered grants, deliberate
// disconnect clears `remember`, chooser cancel, print progress / problems, link lost.
import { beforeAll, describe, expect, it } from 'vitest'
import { ConnectionManager, type ConnectionSnapshot, type RememberedConnection } from '../../../src/printer/connect'
import { isUserCancel } from '../../../src/printer/problems'
import { detectSupport } from '../../../src/printer/support'
import { SPP_UUID } from '../../../src/printer/webserial'
import { Bitmap1, encodeJob, printArea, type Job } from '../../../src/wasm'
import { P710BT_STATUS_24MM, loadWasmForTests } from '../../helpers/wasm'
import { FakeClock, FakePort, FakeSerial, SlowRfcommPort, answerStatus } from './fakes'

beforeAll(() => loadWasmForTests())

const CHROME = detectSupport({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36', serial: { requestPort() {} }, usb: { requestDevice() {} } })
const FIREFOX = detectSupport({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0', serial: { requestPort() {} } })

function makeJob(pages = 1): Job {
  const { heightDots } = printArea('PT-P710BT', 'tze128-24')
  const bm = Bitmap1.fromPacked(100, heightDots, new Uint8Array(100 * Math.ceil(heightDots / 8)).fill(0x81))
  const job = encodeJob('PT-P710BT', 'tze128-24', Array.from({ length: pages }, () => bm.clone()), {})
  bm.free()
  return job
}

function setup(opts: { support?: typeof CHROME; serial?: FakeSerial; recall?: RememberedConnection | null; scenario?: ConstructorParameters<typeof ConnectionManager>[0]['virtualScenario'] } = {}) {
  const clock = new FakeClock()
  const remembered: (RememberedConnection | null)[] = []
  const serial = opts.serial ?? new FakeSerial()
  const m = new ConnectionManager({
    support: opts.support ?? CHROME,
    remember: (c) => remembered.push(c),
    recall: () => opts.recall ?? null,
    serial,
    virtualScenario: opts.scenario ?? {},
    client: { clock, keepaliveMs: 0 },
    serialOptions: { clock },
  })
  const snaps: ConnectionSnapshot[] = []
  m.subscribe((s) => snaps.push(s))
  return { clock, m, serial, remembered, snaps }
}

async function settle(clock: FakeClock, p: Promise<unknown>): Promise<void> {
  let done = false
  void p.finally(() => (done = true)).catch(() => {})
  await clock.until(() => done, 120_000)
}

describe('ConnectionManager', () => {
  it('Bluetooth on Chromium: requestPort with the SPP filter, called synchronously', async () => {
    const port = new FakePort({ info: { bluetoothServiceClassId: SPP_UUID } })
    const { clock, m, serial } = setup({ serial: new FakeSerial([port]) })
    answerStatus(port, P710BT_STATUS_24MM, clock)
    const p = m.connect('bluetooth')
    expect(serial.calls).toEqual([{ filters: [{ bluetoothServiceClassId: SPP_UUID }], allowedBluetoothServiceClassIds: [SPP_UUID] }])
    await settle(clock, p)
    expect(m.snapshot).toMatchObject({ path: 'bluetooth', state: 'ready', model: 'PT-P710BT', problem: null })
    expect(m.snapshot.transport?.kind).toBe('serial-rfcomm')
    expect(m.snapshot.media?.id).toBe('tze128-24')
    expect(m.snapshot.media?.widthMm).toBe(24)
    await m.disconnect()
  })

  it('Bluetooth on Firefox and "Choose port" use the unfiltered chooser', async () => {
    const { m, serial } = setup({ support: FIREFOX })
    void m.connect('bluetooth')
    void m.connect('serial-port')
    expect(serial.calls).toEqual([undefined, undefined])
    await m.disconnect()
  })

  it('records "waking" progress while open() retries, then remembers the connection', async () => {
    const port = new FakePort({ info: { bluetoothServiceClassId: SPP_UUID }, openFailures: 1 })
    const { clock, m, snaps, remembered } = setup({ serial: new FakeSerial([port]) })
    answerStatus(port, P710BT_STATUS_24MM, clock)
    await settle(clock, m.connect('bluetooth'))
    expect(snaps.some((s) => s.state === 'waking' && s.openProgress?.attempt === 2 && s.openProgress.of === 3)).toBe(true)
    expect(m.snapshot.state).toBe('ready')
    expect(m.snapshot.openProgress).toBeNull()
    expect(remembered.at(-1)).toEqual({ path: 'bluetooth', transport: { kind: 'serial-rfcomm', label: 'Bluetooth printer', bluetoothServiceClassId: SPP_UUID } })
    await m.disconnect()
  })

  it('open failing 3× → open-failed problem with "Choose port…"', async () => {
    const port = new FakePort({ info: { bluetoothServiceClassId: SPP_UUID }, openFailures: 3 })
    const { clock, m } = setup({ serial: new FakeSerial([port]) })
    await settle(clock, m.connect('bluetooth'))
    expect(m.snapshot.state).toBe('error')
    expect(m.snapshot.problem?.id).toBe('open-failed')
    expect(m.snapshot.problem?.actions).toContain('choose-port')
  })

  it('a cancelled Bluetooth chooser keeps the state and hints at "Choose port…"', async () => {
    const serial = new FakeSerial([])
    const { m } = setup({ serial })
    await m.connect('bluetooth')
    expect(m.snapshot.state).toBe('disconnected')
    expect(m.snapshot.problem).toMatchObject({ id: 'cancelled', severity: 'info' })
    expect(m.snapshot.problem?.actions).toContain('choose-port')
    await m.connect('serial-port')
    expect(m.snapshot.problem).toBeNull()
  })

  it('virtual printer: connect, print with progress, disconnect', async () => {
    const { clock, m, snaps } = setup({ scenario: { fragment: [7, 25] } })
    await settle(clock, m.connect('virtual'))
    expect(m.snapshot).toMatchObject({ path: 'virtual', state: 'ready', model: 'PT-P710BT' })
    expect(m.snapshot.transport?.kind).toBe('virtual')
    expect(m.snapshot.status?.mediaWidthMm).toBe(24)
    const job = makeJob(2)
    await settle(clock, m.print(job))
    const phases = snaps.flatMap((s) => (s.progress ? [`${s.progress.page}/${s.progress.of}:${s.progress.phase}`] : []))
    expect(phases).toContain('1/2:printing')
    expect(phases).toContain('2/2:printing')
    expect(m.snapshot.progress).toEqual({ page: 2, of: 2, phase: 'done' })
    expect(m.snapshot.state).toBe('ready')
    job.free()
    await m.disconnect()
    expect(m.snapshot.state).toBe('disconnected')
  })

  it('print failure sets a problem and rejects; cancel is not a problem', async () => {
    const { clock, m } = setup({ scenario: { behaviour: { kind: 'cover-open-on-page', page: 1 } } })
    await settle(clock, m.connect('virtual'))
    const job = makeJob(1)
    let err: unknown
    await settle(
      clock,
      m.print(job).catch((e: unknown) => (err = e)),
    )
    expect(err).toBeDefined()
    expect(m.snapshot.problem?.id).toBe('cover-open')
    job.free()

    const ok = setup()
    await settle(ok.clock, ok.m.connect('virtual'))
    const job2 = makeJob(2)
    let err2: unknown
    const printing = ok.m.print(job2).catch((e: unknown) => (err2 = e))
    await ok.clock.until(() => ok.m.snapshot.state === 'printing')
    void ok.m.cancel()
    await settle(ok.clock, printing)
    expect(isUserCancel(err2)).toBe(true)
    expect(ok.m.snapshot.problem).toBeNull()
    job2.free()
  })

  it('a wrong-tape error names the loaded and the designed width (designWidthMm)', async () => {
    const clock = new FakeClock()
    const m = new ConnectionManager({
      support: CHROME,
      virtualScenario: { behaviour: { kind: 'wrong-media' } },
      client: { clock, keepaliveMs: 0 },
      designWidthMm: () => 12,
    })
    await settle(clock, m.connect('virtual'))
    const job = makeJob(1)
    let err: unknown
    await settle(
      clock,
      m.print(job).catch((e: unknown) => (err = e)),
    )
    expect(err).toBeDefined()
    expect(m.snapshot.problem?.id).toBe('wrong-media')
    expect(m.snapshot.problem?.detail).toMatch(/24 mm.*12 mm/)
    job.free()
  })

  it('print without a connection → problem + rejection', async () => {
    const { m } = setup()
    const job = makeJob(1)
    await expect(m.print(job)).rejects.toBeDefined()
    expect(m.snapshot.problem?.id).toBe('link-lost')
    job.free()
  })

  it('restore() re-opens a remembered granted port without a prompt', async () => {
    const os = new FakePort()
    const bt = new FakePort({ info: { bluetoothServiceClassId: SPP_UUID } })
    const serial = new FakeSerial([os, bt])
    const { clock, m } = setup({ serial, recall: { path: 'bluetooth', transport: { kind: 'serial-rfcomm', label: 'Bluetooth printer', bluetoothServiceClassId: SPP_UUID } } })
    answerStatus(bt, P710BT_STATUS_24MM, clock)
    let restored: boolean | undefined
    await settle(
      clock,
      m.restore().then((r) => (restored = r)),
    )
    expect(restored).toBe(true)
    expect(serial.calls).toEqual([]) // no chooser
    expect(bt.openCalls).toBe(1)
    expect(os.openCalls).toBe(0)
    expect(m.snapshot.state).toBe('ready')
    await m.disconnect()
  })

  it('restore() resolves false when nothing is remembered or granted', async () => {
    expect(await setup().m.restore()).toBe(false)
    expect(await setup({ serial: new FakeSerial([]), recall: { path: 'bluetooth' } }).m.restore()).toBe(false)
    // A path this browser can't use is ignored.
    expect(await setup({ support: FIREFOX, recall: { path: 'usb' } }).m.restore()).toBe(false)
  })

  it('a failed auto-reconnect shows a gentle (info) problem', async () => {
    const bt = new FakePort({ info: { bluetoothServiceClassId: SPP_UUID } }) // never answers
    const { clock, m } = setup({ serial: new FakeSerial([bt]), recall: { path: 'bluetooth' } })
    await settle(clock, m.restore())
    expect(m.snapshot.state).toBe('no-reply')
    expect(m.snapshot.problem).toMatchObject({ id: 'no-reply', severity: 'info' })
  })

  it('a deliberate disconnect clears remember (and forget revokes the grant)', async () => {
    const port = new FakePort({ info: { bluetoothServiceClassId: SPP_UUID } })
    const { clock, m, remembered } = setup({ serial: new FakeSerial([port]) })
    answerStatus(port, P710BT_STATUS_24MM, clock)
    await settle(clock, m.connect('bluetooth'))
    await m.disconnect({ forget: true })
    expect(remembered.at(-1)).toBeNull()
    expect(port.forgotten).toBe(true)
    expect(port.isOpen).toBe(false)
    expect(m.snapshot.state).toBe('disconnected')
    expect(m.snapshot.path).toBeNull()
  })

  it('link lost while idle → state lost + problem; reconnect() re-opens the same port', async () => {
    const port = new FakePort({ info: { bluetoothServiceClassId: SPP_UUID } })
    const { clock, m } = setup({ serial: new FakeSerial([port]) })
    answerStatus(port, P710BT_STATUS_24MM, clock)
    await settle(clock, m.connect('bluetooth'))
    port.failRead()
    await clock.until(() => m.snapshot.state === 'lost', 1000)
    expect(m.snapshot.problem?.id).toBe('link-lost')
    await clock.advance(10)
    await settle(clock, m.reconnect())
    expect(m.snapshot.state).toBe('ready')
    expect(m.snapshot.problem).toBeNull()
    expect(port.openCalls).toBe(2)
    await m.disconnect()
  })

  it('every update publishes a new snapshot object', async () => {
    const { m, snaps } = setup()
    const before = m.snapshot
    m.dismissProblem()
    expect(m.snapshot).not.toBe(before)
    expect(snaps.at(-1)).toBe(m.snapshot)
  })

  it('two back-to-back reconnect() calls run one client; no orphan holds the port', async () => {
    const port = new FakePort({ info: { bluetoothServiceClassId: SPP_UUID } })
    const { clock, m } = setup({ serial: new FakeSerial([port]) })
    // Silent printer first → no-reply.
    await settle(clock, m.connect('bluetooth'))
    expect(m.snapshot.state).toBe('no-reply')
    answerStatus(port, P710BT_STATUS_24MM, clock)
    const a = m.reconnect()
    const b = m.reconnect()
    await settle(clock, Promise.all([a, b]))
    expect(m.snapshot.state).toBe('ready')
    expect(m.snapshot.problem).toBeNull()
    expect(m.client?.state).toBe('ready')
    expect(m.packetLog.toText()).not.toMatch(/already open/)
    await m.disconnect()
    await clock.advance(5 * 60_000)
    expect(port.isOpen).toBe(false)
  })

  it('cancelConnect() stops a hanging RFCOMM open; nothing reconnects in the background', async () => {
    const clock = new FakeClock()
    const port = new SlowRfcommPort(clock)
    answerStatus(port, P710BT_STATUS_24MM, clock)
    const m = new ConnectionManager({ support: CHROME, serial: new FakeSerial([port]), client: { clock, keepaliveMs: 60_000 }, serialOptions: { clock } })
    const connecting = m.connect('bluetooth')
    await clock.advance(2000)
    expect(m.snapshot.state).toBe('waking')
    await m.cancelConnect()
    await connecting
    expect(m.snapshot.state).toBe('disconnected')
    expect(m.snapshot.problem).toBeNull()
    await clock.advance(5 * 60_000)
    expect(m.snapshot.state).toBe('disconnected')
    expect(port.isOpen).toBe(false)
    expect(port.received).toHaveLength(0)
    // A new attempt on the same port works.
    await settle(clock, m.connect('bluetooth'))
    expect(m.snapshot.state).toBe('ready')
    await m.disconnect()
  })

  it('disconnect() while waking leaves no client running (no keepalive on a hidden port)', async () => {
    const clock = new FakeClock()
    const port = new SlowRfcommPort(clock, 0) // first open fails at once, retry takes 378 ms
    answerStatus(port, P710BT_STATUS_24MM, clock)
    const m = new ConnectionManager({ support: CHROME, serial: new FakeSerial([port]), client: { clock, keepaliveMs: 60_000 }, serialOptions: { clock } })
    const states: string[] = []
    m.subscribe((s) => states.push(s.state))
    const connecting = m.connect('bluetooth')
    await clock.until(() => m.snapshot.state === 'waking', 5000, 1)
    await m.disconnect()
    await settle(clock, connecting)
    await clock.advance(4 * 60_000)
    expect(m.snapshot.state).toBe('disconnected')
    expect(port.isOpen).toBe(false)
    expect(port.received).toHaveLength(0)
  })

  it('refreshStatus ignores a BUSY from the recovering session (PtouchError)', async () => {
    const { clock, m } = setup({ scenario: { behaviour: { kind: 'cover-open-on-page', page: 1 } } })
    await settle(clock, m.connect('virtual'))
    const job = makeJob(1)
    await settle(clock, m.print(job).catch(() => {}))
    expect(m.snapshot.problem?.id).toBe('cover-open')
    expect(m.client?.state).toBe('error') // the session is recovering
    await m.refreshStatus()
    expect(m.snapshot.problem?.id).toBe('cover-open') // not "The printer is busy"
    job.free()
  })

  it('Firefox OS port: a silent printer is reported in ~6 s, not 15 s', async () => {
    const port = new FakePort({ info: {} })
    const { clock, m } = setup({ support: FIREFOX, serial: new FakeSerial([port]) })
    const t0 = clock.now()
    await settle(clock, m.connect('serial-port'))
    expect(m.snapshot.state).toBe('no-reply')
    expect(m.snapshot.problem?.id).toBe('no-reply-firefox')
    expect(clock.now() - t0).toBeLessThan(7000)
  })
})

// P-web (docs/SETTINGS-PLAN.md §4) — printer settings through PrinterClient / ConnectionManager
// against MockTransport (the wasm VirtualPrinter) on a fake clock: read all, write + verified
// read-back, writes ignored (not verified), silent printer (TIMEOUT, back to ready), busy gating
// (status, print, a second transaction), abort → CANCELLED with the epilogue sent, unsupported
// model, keepalive suppressed, link lost, and the snapshot / Problem plumbing.
import { beforeAll, describe, expect, it } from 'vitest'
import { PrinterClient, type ClientState, type PrinterEvent } from '../../../src/printer/client'
import { ConnectionManager } from '../../../src/printer/connect'
import { LinkLostError, SessionFailedError } from '../../../src/printer/errors'
import { MockTransport, type MockScenario } from '../../../src/printer/mock'
import { PacketLog } from '../../../src/printer/packetlog'
import { describeProblem, isUserCancel } from '../../../src/printer/problems'
import { detectSupport } from '../../../src/printer/support'
import { Bitmap1, encodeJob, mediaForWidth, printArea, settingsFor, type Job } from '../../../src/wasm'
import { loadWasmForTests } from '../../helpers/wasm'
import { FakeClock } from './fakes'

const CHROME = detectSupport({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36', serial: { requestPort() {} }, usb: { requestDevice() {} } })

/** Settings opcodes of the virtual printer's store (PROTOCOL.md §3.6: auto power on / off). */
const OP_POWER_ON = 0x70
const OP_POWER_OFF = 0x41

beforeAll(() => loadWasmForTests())

function setup(scenario: Partial<MockScenario> = {}, opts: { keepaliveMs?: number } = {}) {
  const clock = new FakeClock()
  const transport = new MockTransport(scenario, clock)
  const client = new PrinterClient(transport, { clock, log: new PacketLog(), keepaliveMs: opts.keepaliveMs ?? 0 })
  const events: PrinterEvent[] = []
  client.on((e) => events.push(e))
  const states = (): ClientState[] => events.flatMap((e) => (e.type === 'state' ? [e.state] : []))
  return { clock, transport, client, events, states }
}

async function run<T>(clock: FakeClock, p: Promise<T>, maxMs = 60_000): Promise<T> {
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

/** A virtual `model` with its 24 mm TZe tape loaded. */
const on24 = (model: string): Partial<MockScenario> => ({ model, mediaId: mediaForWidth(model, 24).id })

const hex = (b: Uint8Array | undefined) => Array.from(b ?? [], (x) => x.toString(16).padStart(2, '0')).join(' ')

function makeJob(): Job {
  const { heightDots } = printArea('PT-P710BT', 'tze128-24')
  const bm = Bitmap1.fromPacked(100, heightDots, new Uint8Array(100 * Math.ceil(heightDots / 8)).fill(0x81))
  const job = encodeJob('PT-P710BT', 'tze128-24', [bm.clone()], {})
  bm.free()
  return job
}

describe('PrinterClient settings (virtual PT-P710BT)', () => {
  it('reads every setting the model has; state settings → ready; nothing committed', async () => {
    const { clock, client, transport, states } = setup()
    await run(clock, client.connect())
    const before = transport.written.length
    const report = await run(clock, client.readSettings())
    expect(report.map((r) => r.id)).toEqual(['auto-power-on', 'auto-power-off', 'auto-power-off-battery'])
    expect(report.map((r) => r.text)).toEqual(['off', '30 min', '30 min'])
    expect(report[1]?.value).toEqual({ kind: 'minutes', minutes: 30 })
    expect(report[1]?.raw).toHaveLength(32)
    expect(states().slice(-2)).toEqual(['settings', 'ready'])
    expect(client.state).toBe('ready')
    // One connection, each command its own write (SETTINGS-PLAN.md §1.4); on the PT-P710BT the
    // USB / AC timer is selector 00 and the battery timer 01 (PROTOCOL.md §8 #34).
    expect(transport.written.slice(before).map(hex)).toEqual(['1b 40 1b 69 61 01', '1b 69 55 70 01', '1b 69 55 41 01 00', '1b 69 55 41 01 01', '1b 69 61 ff'])
    expect(transport.printer?.commits()).toBe(0)
    expect(transport.violations()).toEqual([])
  })

  it('writes a value, reads it back and reports verified', async () => {
    const { clock, client, transport } = setup({ fragment: [7, 25] })
    await run(clock, client.connect())
    const before = transport.written.length
    const r = await run(clock, client.writeSettings([{ id: 'auto-power-off', value: { kind: 'minutes', minutes: 10 } }]))
    expect(r.verified).toBe(true)
    expect(r.report).toHaveLength(1)
    expect(r.report[0]).toMatchObject({ id: 'auto-power-off', text: '10 min', value: { kind: 'minutes', minutes: 10 } })
    expect(transport.written.slice(before).map(hex)).toEqual([
      '1b 40 1b 69 61 01',
      '1b 69 55 41 00 00 01',
      '1b 7e 53 1b 69 61 ff',
      '1b 40 1b 69 61 01',
      '1b 69 55 41 01 00',
      '1b 69 61 ff',
    ])
    expect(transport.printer?.settingByte(OP_POWER_OFF, 0)).toBe(1)
    expect(transport.printer?.settingByte(OP_POWER_OFF, 1)).toBe(3) // battery timer untouched
    expect(transport.printer?.commits()).toBe(1)
    expect(client.state).toBe('ready')
  })

  it('auto power on is a toggle', async () => {
    const { clock, client, transport } = setup()
    await run(clock, client.connect())
    const r = await run(clock, client.writeSettings([{ id: 'auto-power-on', value: { kind: 'enabled', enabled: true } }]))
    expect(r.verified).toBe(true)
    expect(r.report[0]?.text).toBe('on')
    expect(transport.printer?.settingByte(OP_POWER_ON)).toBe(1)
  })

  it('a printer that ignores the write: not verified, the old value is reported', async () => {
    const { clock, client } = setup({ behaviour: { kind: 'settings-writes-ignored' } })
    await run(clock, client.connect())
    const r = await run(clock, client.writeSettings([{ id: 'auto-power-off', value: { kind: 'minutes', minutes: 10 } }]))
    expect(r.verified).toBe(false)
    expect(r.report[0]?.text).toBe('30 min')
    expect(client.state).toBe('ready')
  })

  it('an unlisted byte is reported raw', async () => {
    const { clock, client, transport } = setup()
    await run(clock, client.connect())
    transport.printer?.setSettingByte(OP_POWER_OFF, 0, 0x07)
    const [r] = await run(clock, client.readSettings(['auto-power-off']))
    expect(r?.value).toBeUndefined()
    expect(r?.unlistedByte).toBe(7)
    expect(r?.text).toBe('unknown (0x07)')
  })

  it('a printer that never answers: TIMEOUT (settings-reply), back to ready, Problem says so', async () => {
    const { clock, client, transport } = setup({ behaviour: { kind: 'settings-silent' } })
    await run(clock, client.connect())
    const err = await run(clock, client.readSettings()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionFailedError)
    expect(err).toMatchObject({ code: 'TIMEOUT', stage: 'settings' })
    expect(client.state).toBe('ready')
    expect(transport.isOpen).toBe(true)
    // The default command mode is restored even after a failure.
    expect(hex(transport.written.at(-1))).toBe('1b 69 61 ff')
    const p = describeProblem(err, { support: CHROME, transport: transport.info, stage: 'settings' })
    expect(p.title).toMatch(/didn’t answer the settings request/)
    // The printer is still usable.
    const s = await run(clock, client.refreshStatus())
    expect(s.ready).toBe(true)
  })

  it('reads the right value past a stale status frame', async () => {
    const { clock, client } = setup({ behaviour: { kind: 'stale-frame-before-settings-reply' } })
    await run(clock, client.connect())
    const report = await run(clock, client.readSettings(['auto-power-off-battery']))
    expect(report[0]?.text).toBe('30 min')
  })

  it('is busy while a transaction runs: status, print and a second transaction are refused', async () => {
    const { clock, client } = setup()
    await run(clock, client.connect())
    const reading = client.readSettings()
    expect(client.state).toBe('settings')
    await expect(client.refreshStatus()).rejects.toMatchObject({ code: 'BUSY' })
    await expect(client.readSettings()).rejects.toMatchObject({ code: 'BUSY', stage: 'settings' })
    const job = makeJob()
    await expect(client.print(job)).rejects.toMatchObject({ code: 'BUSY' })
    job.free()
    await run(clock, reading)
    expect(client.state).toBe('ready')
  })

  it('refuses while printing', async () => {
    const { clock, client } = setup()
    await run(clock, client.connect())
    const job = makeJob()
    const printing = client.print(job)
    await expect(client.readSettings()).rejects.toMatchObject({ code: 'BUSY' })
    await run(clock, printing)
    job.free()
  })

  it('abort cancels the transaction: CANCELLED, epilogue sent, ready again', async () => {
    const { clock, client, transport } = setup({ behaviour: { kind: 'settings-silent' } })
    await run(clock, client.connect())
    const ctrl = new AbortController()
    const reading = client.readSettings(undefined, ctrl.signal)
    await clock.advance(200)
    ctrl.abort()
    const err = await run(clock, reading).catch((e: unknown) => e)
    expect(isUserCancel(err)).toBe(true)
    expect(client.state).toBe('ready')
    expect(hex(transport.written.at(-1))).toBe('1b 69 61 ff')
  })

  it('suppresses the idle keepalive during a transaction and restarts it after', async () => {
    const { clock, client, transport } = setup({ behaviour: { kind: 'settings-silent' } }, { keepaliveMs: 300 })
    await run(clock, client.connect())
    const before = transport.written.length
    const err = await run(clock, client.readSettings()).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'TIMEOUT' })
    // No status request (1B 69 53) went out between the prologue and the epilogue.
    const during = transport.written.slice(before).map(hex)
    expect(during.filter((h) => h === '1b 69 53')).toEqual([])
    await clock.advance(400)
    expect(hex(transport.written.at(-1))).toBe('1b 69 53')
  })

  it('a model without settings: UNSUPPORTED before anything is sent', async () => {
    const { clock, client, transport } = setup(on24('PT-E560BT'))
    await run(clock, client.connect())
    expect(settingsFor('PT-E560BT')).toEqual([])
    const before = transport.written.length
    await expect(client.readSettings(['auto-power-off'])).rejects.toMatchObject({ name: 'PtouchError', code: 'UNSUPPORTED' })
    expect(transport.written.length).toBe(before)
    expect(client.state).toBe('ready')
  })

  it('a value the model does not offer: INVALID_INPUT before anything is sent', async () => {
    const { clock, client, transport } = setup()
    await run(clock, client.connect())
    const before = transport.written.length
    await expect(client.writeSettings([{ id: 'auto-power-off', value: { kind: 'minutes', minutes: 120 } }])).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(transport.written.length).toBe(before)
    expect(client.state).toBe('ready')
  })

  it('link lost during a transaction rejects it and leaves state lost', async () => {
    const { clock, client, transport } = setup({ behaviour: { kind: 'settings-silent' } })
    await run(clock, client.connect())
    const reading = client.readSettings()
    await clock.advance(200)
    transport.simulateDisconnect()
    const err = await run(clock, reading).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LinkLostError)
    expect(client.state).toBe('lost')
  })

  it('disconnect() during a transaction rejects it', async () => {
    const { clock, client, transport } = setup({ behaviour: { kind: 'settings-silent' } })
    await run(clock, client.connect())
    const reading = client.readSettings()
    await clock.advance(200)
    const disconnecting = client.disconnect()
    const err = await run(clock, reading).catch((e: unknown) => e)
    await run(clock, disconnecting)
    expect(isUserCancel(err)).toBe(true)
    expect(client.state).toBe('disconnected')
    expect(transport.isOpen).toBe(false)
  })
})

describe('settings on the other profiles', () => {
  it('PT-P900W: 2 h is index 07, shown as "2 h"', async () => {
    const { clock, client, transport } = setup(on24('PT-P900W'))
    await run(clock, client.connect())
    const r = await run(clock, client.writeSettings([{ id: 'auto-power-off', value: { kind: 'minutes', minutes: 120 } }]))
    expect(r).toMatchObject({ verified: true, report: [{ text: '2 h' }] })
    expect(r.report[0]?.raw).toHaveLength(3)
    expect(transport.printer?.settingByte(OP_POWER_OFF, 0)).toBe(0x07)
  })

  it('PT-P910BT: 2 h is 0C (10-minute units)', async () => {
    const { clock, client, transport } = setup(on24('PT-P910BT'))
    await run(clock, client.connect())
    const r = await run(clock, client.writeSettings([{ id: 'auto-power-off', value: { kind: 'minutes', minutes: 120 } }]))
    expect(r.verified).toBe(true)
    expect(transport.printer?.settingByte(OP_POWER_OFF, 0)).toBe(0x0c)
  })
})

describe('ConnectionManager settings', () => {
  function manager(scenario: Partial<MockScenario> = {}) {
    const clock = new FakeClock()
    const m = new ConnectionManager({ support: CHROME, virtualScenario: scenario, client: { clock, keepaliveMs: 0 } })
    return { clock, m }
  }

  it('keeps the last read in the snapshot (and the write read-back)', async () => {
    const { clock, m } = manager()
    await run(clock, m.connect('virtual'))
    expect(m.snapshot.settings).toBeNull()
    const states: string[] = []
    m.subscribe((s) => states.push(s.state))
    await run(clock, m.readSettings())
    expect(states).toContain('settings')
    expect(m.snapshot.settings?.map((r) => r.text)).toEqual(['off', '30 min', '30 min'])
    const w = await run(clock, m.writeSettings([{ id: 'auto-power-off-battery', value: { kind: 'minutes', minutes: 0 } }]))
    expect(w.verified).toBe(true)
    // The read-back replaces only what was written.
    expect(m.snapshot.settings?.map((r) => `${r.id}=${r.text}`)).toEqual(['auto-power-on=off', 'auto-power-off=30 min', 'auto-power-off-battery=never'])
    await run(clock, m.writeSettings([{ id: 'auto-power-off', value: { kind: 'minutes', minutes: 50 } }]))
    expect(m.snapshot.settings?.map((r) => r.text)).toEqual(['off', '50 min', 'never'])
    expect(m.snapshot.state).toBe('ready')
    expect(m.snapshot.problem).toBeNull()
  })

  it('a timeout is returned to the caller, not shown as a connection problem', async () => {
    const { clock, m } = manager({ behaviour: { kind: 'settings-silent' } })
    await run(clock, m.connect('virtual'))
    const err = await run(clock, m.readSettings()).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'TIMEOUT' })
    expect(m.snapshot.problem).toBeNull()
    expect(m.snapshot.state).toBe('ready')
    expect(m.settingsProblem(err).id).toBe('no-reply')
  })

  it('the link dropping during a transaction becomes the connection problem', async () => {
    const { clock, m } = manager({ behaviour: { kind: 'settings-silent' } })
    await run(clock, m.connect('virtual'))
    const reading = m.readSettings()
    await clock.advance(200)
    ;(m.transport as MockTransport).simulateDisconnect()
    await run(clock, reading).catch(() => {})
    expect(m.snapshot.state).toBe('lost')
    expect(m.snapshot.problem?.id).toBe('link-lost')
  })

  it('a reconnect forgets the previous connection’s values', async () => {
    const { clock, m } = manager()
    await run(clock, m.connect('virtual'))
    await run(clock, m.readSettings())
    expect(m.snapshot.settings).not.toBeNull()
    await run(clock, m.reconnect())
    expect(m.snapshot.state).toBe('ready')
    expect(m.snapshot.settings).toBeNull()
  })

  it('no client → NotConnectedError', async () => {
    const { m } = manager()
    await expect(m.readSettings()).rejects.toMatchObject({ name: 'NotConnectedError' })
  })
})

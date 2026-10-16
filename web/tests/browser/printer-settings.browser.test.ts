// P-web (docs/SETTINGS-PLAN.md §4) — printer settings in a real browser with real timers:
// ConnectionManager → PrinterClient → MockTransport (wasm VirtualPrinter, RFCOMM-like 7 + 25
// fragments and latency): read, write + verified read-back, and a silent printer's timeout
// (~1 s settings reply timeout) leaving the connection usable.
import { beforeAll, describe, expect, it } from 'vitest'
import { ConnectionManager, detectSupport } from '../../src/printer'
import { loadWasm } from '../../src/wasm'

beforeAll(() => loadWasm())

function manager(scenario: ConstructorParameters<typeof ConnectionManager>[0]['virtualScenario'] = {}) {
  return new ConnectionManager({ support: detectSupport(), virtualScenario: scenario, client: { keepaliveMs: 0 } })
}

describe('printer settings (real timers)', () => {
  it('reads, writes and verifies over a fragmented, slow link', async () => {
    const m = manager({ fragment: [7, 25], latencyMs: 20 })
    await m.connect('virtual')
    expect(m.snapshot.state).toBe('ready')
    const read = await m.readSettings()
    expect(read.map((r) => r.text)).toEqual(['off', '30 min', '30 min'])
    const w = await m.writeSettings([{ id: 'auto-power-off', value: { kind: 'minutes', minutes: 60 } }])
    expect(w.verified).toBe(true)
    expect(w.report[0]?.text).toBe('60 min')
    expect(m.snapshot.settings?.map((r) => r.text)).toEqual(['off', '60 min', '30 min'])
    expect(m.snapshot.state).toBe('ready')
    await m.disconnect()
  })

  it('a silent printer times out and the connection stays ready', async () => {
    const m = manager({ behaviour: { kind: 'settings-silent' } })
    await m.connect('virtual')
    const t0 = performance.now()
    const err = await m.readSettings(['auto-power-on']).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'TIMEOUT', stage: 'settings' })
    expect(performance.now() - t0).toBeGreaterThan(900)
    expect(m.snapshot.state).toBe('ready')
    expect(m.snapshot.problem).toBeNull()
    await m.refreshStatus()
    expect(m.snapshot.problem).toBeNull()
    await m.disconnect()
  })
})

// W2 — the e2e serial stub (e2e/fixtures/serial-stub.ts) driven by the real printer layer in
// node: first open fails (waking), handshake answered 7 + 25, a 2-page job prints with
// 06/01 → 01 → 06/00 pushes, last written byte 0x1A. Keeps the fixture honest for W4's e2e.
import { beforeAll, describe, expect, it } from 'vitest'
import { installSerialStub, type SerialStubWindow } from '../../../e2e/fixtures/serial-stub'
import { ConnectionManager } from '../../../src/printer/connect'
import { DEFAULT_OPEN_RETRY } from '../../../src/printer/retry'
import { detectSupport } from '../../../src/printer/support'
import type { SerialLike } from '../../../src/printer/webserial'
import { Bitmap1, encodeJob, printArea } from '../../../src/wasm'
import { loadWasmForTests } from '../../helpers/wasm'

beforeAll(() => loadWasmForTests())

const CHROME = detectSupport({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36', serial: { requestPort() {} } })

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('serial stub (e2e fixture)', () => {
  it('connects through a failed first open and prints a 2-page job', async () => {
    const host: { serial?: SerialLike } = {}
    installSerialStub({ openFailures: 1, replyDelayMs: 5, printMs: 40 }, host)
    const w = globalThis as unknown as SerialStubWindow
    const m = new ConnectionManager({ support: CHROME, serial: host.serial as SerialLike, serialOptions: { openRetry: { ...DEFAULT_OPEN_RETRY, backoffMs: [10] } }, client: { keepaliveMs: 0 } })
    const states: string[] = []
    m.subscribe((s) => states.push(s.state))
    await m.connect('bluetooth')
    expect(w.__ptouchOpenAttempts).toBe(2)
    expect(states).toContain('waking')
    expect(m.snapshot).toMatchObject({ state: 'ready', model: 'PT-P710BT' })
    expect(m.snapshot.media?.widthMm).toBe(24)
    expect(w.__ptouchRequests).toHaveLength(1)

    const { heightDots } = printArea('PT-P710BT', 'tze128-24')
    const bm = Bitmap1.fromPacked(120, heightDots, new Uint8Array(120 * Math.ceil(heightDots / 8)).fill(0x55))
    const job = encodeJob('PT-P710BT', 'tze128-24', [bm.clone(), bm.clone()], {})
    bm.free()
    await m.print(job)
    job.free()
    const bytes = w.__ptouchWrites.flat()
    expect(bytes.at(-1)).toBe(0x1a)
    expect(m.snapshot.progress).toEqual({ page: 2, of: 2, phase: 'done' })
    const types = w.__ptouchStatusFrames.map((f) => `${f[18]}/${f[19]}`)
    expect(types.slice(-3)).toEqual(['6/1', '1/1', '6/0'])
    await m.disconnect()
  })

  it('silent stub → no-reply', async () => {
    const host: { serial?: SerialLike } = {}
    installSerialStub({ openFailures: 0, silent: true }, host)
    const m = new ConnectionManager({ support: CHROME, serial: host.serial as SerialLike, client: { keepaliveMs: 0, session: { statusTimeoutMs: 30, statusAttempts: 1, modeSwitchDrainMs: 5 } } })
    await m.connect('bluetooth')
    await waitFor(() => m.snapshot.state === 'no-reply')
    expect(m.snapshot.problem?.id).toBe('no-reply')
  })
})

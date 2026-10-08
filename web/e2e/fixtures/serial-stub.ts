// W2 — Playwright init scripts:
// - `stubSerial(page, opts)` replaces navigator.serial with a fake whose port behaves like a
//   PT-P710BT reached over Chrome's direct-RFCOMM entry: the first open() can fail with
//   NetworkError (verified hardware behaviour), status requests are answered with the real
//   24 mm fixture split 7 + 25 bytes, and printed pages push 06/printing → 01 completed →
//   06/receiving. Every written chunk is recorded on `window.__ptouchWrites` (number[][]).
// - `removeDeviceApis(page)` emulates Safari/iOS (no Web Serial / WebUSB) for the
//   unsupported-browser screen.
//
// `installSerialStub` is serialised into the page by Playwright, so it must be self-contained
// (no imports, no outer variables, no #private members that a transpiler could lower to
// module-level helpers). It is exported for node unit tests too.
import type { Page } from '@playwright/test'

export interface SerialStubOptions {
  /** open() rejects this many times with NetworkError first (default 1, like the real Mac). */
  openFailures?: number
  /** Never answer anything (asleep printer / dead OS port). */
  silent?: boolean
  /** Status reply delay in ms (default 92, measured). */
  replyDelayMs?: number
  /** Time a page takes to print in ms (default 1500; the real 5 cm label takes ~9 s). */
  printMs?: number
  /** Expose the port as an OS serial port (no bluetoothServiceClassId) instead of RFCOMM. */
  osPort?: boolean
  /** 32-byte status to answer with (default: real PT-P710BT, 24 mm laminated white/black). */
  status?: number[]
}

export interface SerialStubWindow {
  __ptouchWrites: number[][]
  __ptouchRequests: unknown[]
  __ptouchOpenAttempts: number
  __ptouchStatusFrames: number[][]
}

/** Installs the fake navigator.serial on `target` (default: Navigator.prototype in the page). */
export function installSerialStub(opts: SerialStubOptions = {}, target?: object): void {
  const SPP = '00001101-0000-1000-8000-00805f9b34fb'
  const FIXTURE = [0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
  const base = opts.status ?? FIXTURE
  const replyDelay = opts.replyDelayMs ?? 92
  const printMs = opts.printMs ?? 1500
  const w = globalThis as unknown as SerialStubWindow & { setTimeout: typeof setTimeout }
  w.__ptouchWrites = []
  w.__ptouchRequests = []
  w.__ptouchOpenAttempts = 0
  w.__ptouchStatusFrames = []
  let openFailures = opts.openFailures ?? 1

  const frame = (type: number, phase: number): number[] => {
    const f = base.slice()
    f[18] = type
    f[19] = phase
    return f
  }

  class StubPort extends EventTarget {
    readable: ReadableStream<Uint8Array> | null = null
    _writable: WritableStream<Uint8Array> | null = null
    _ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
    _buf: number[] = []
    _printing = false
    _queue: number[][] = []
    readonly connected = true

    getInfo() {
      return opts.osPort ? {} : { bluetoothServiceClassId: SPP }
    }

    get writable(): WritableStream<Uint8Array> | null {
      if (!this.readable) return null
      this._writable ??= new WritableStream<Uint8Array>(
        {
          write: (chunk) => {
            w.__ptouchWrites.push(Array.from(chunk))
            this._buf.push(...chunk)
            this._parse()
          },
          abort: () => {
            this._writable = null
          },
        },
        new CountQueuingStrategy({ highWaterMark: 1 }),
      )
      return this._writable
    }

    async open(_o: unknown): Promise<void> {
      w.__ptouchOpenAttempts++
      if (this.readable) throw new DOMException('The port is already open.', 'InvalidStateError')
      await new Promise((r) => w.setTimeout(r, 30))
      if (openFailures > 0) {
        openFailures--
        throw new DOMException('Failed to open serial port.', 'NetworkError')
      }
      this.readable = new ReadableStream<Uint8Array>({
        start: (c) => {
          this._ctrl = c
        },
      })
    }

    async close(): Promise<void> {
      if (this.readable?.locked || this._writable?.locked) throw new DOMException('Cannot close a locked port', 'InvalidStateError')
      this.readable = null
      this._writable = null
      this._ctrl = null
      this._buf = []
    }

    async setSignals(_s: unknown): Promise<void> {}
    async forget(): Promise<void> {}

    _send(f: number[], delay: number): void {
      w.setTimeout(() => {
        if (!this._ctrl || opts.silent) return
        w.__ptouchStatusFrames.push(f)
        this._ctrl.enqueue(Uint8Array.from(f.slice(0, 7)))
        this._ctrl.enqueue(Uint8Array.from(f.slice(7)))
      }, delay)
    }

    _printPage(last: boolean): void {
      if (this._printing) {
        this._queue.push([last ? 1 : 0])
        return
      }
      this._printing = true
      this._send(frame(0x06, 0x01), Math.min(50, printMs / 4))
      this._send(frame(0x01, 0x01), printMs)
      w.setTimeout(() => {
        this._send(frame(0x06, 0x00), 0)
        this._printing = false
        const next = this._queue.shift()
        if (next) this._printPage(next[0] === 1)
      }, printMs + 30)
    }

    /** Minimal command parser: enough to find status requests and page ends (0C / 1A). */
    _parse(): void {
      const b = this._buf
      let i = 0
      const need = (n: number) => i + n <= b.length
      for (;;) {
        if (i >= b.length) break
        const c = b[i] as number
        if (c === 0x00 || c === 0x5a) {
          i += 1
        } else if (c === 0x0c || c === 0x1a) {
          i += 1
          this._printPage(c === 0x1a)
        } else if (c === 0x4d) {
          if (!need(2)) break
          i += 2
        } else if (c === 0x47) {
          if (!need(3)) break
          const len = (b[i + 1] as number) | ((b[i + 2] as number) << 8)
          if (!need(3 + len)) break
          i += 3 + len
        } else if (c === 0x1b) {
          if (!need(2)) break
          const c1 = b[i + 1] as number
          if (c1 === 0x40) {
            i += 2
          } else if (c1 === 0x69) {
            if (!need(3)) break
            const c2 = b[i + 2] as number
            if (c2 === 0x53) {
              i += 3
              this._send(frame(0x00, this._printing ? 0x01 : 0x00), replyDelay)
            } else if (c2 === 0x7a) {
              if (!need(13)) break
              i += 13
            } else if (c2 === 0x64) {
              if (!need(5)) break
              i += 5
            } else {
              if (!need(4)) break
              i += 4
            }
          } else {
            i += 2
          }
        } else {
          i += 1
        }
      }
      this._buf = b.slice(i)
    }
  }

  const port = new StubPort()
  const serial = {
    requestPort: (options?: unknown) => {
      w.__ptouchRequests.push(options ?? null)
      return Promise.resolve(port)
    },
    getPorts: () => Promise.resolve(w.__ptouchRequests.length ? [port] : []),
    addEventListener() {},
    removeEventListener() {},
  }
  const host = target ?? (globalThis as unknown as { Navigator: { prototype: object } }).Navigator.prototype
  Object.defineProperty(host, 'serial', { get: () => serial, configurable: true })
}

/** Replaces navigator.serial in every page of `page` with the PT-P710BT stub. */
export async function stubSerial(page: Page, opts: SerialStubOptions = {}): Promise<void> {
  await page.addInitScript(installSerialStub, opts)
}

export async function removeDeviceApis(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const k of ['serial', 'usb'] as const) {
      Object.defineProperty(Navigator.prototype, k, { get: () => undefined, configurable: true })
    }
  })
}

/** Bytes written so far (flattened), read from the page. */
export async function writtenBytes(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as SerialStubWindow).__ptouchWrites.flat())
}

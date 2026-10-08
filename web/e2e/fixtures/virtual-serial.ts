// Integration fixture — replaces navigator.serial with one Bluetooth (RFCOMM) port whose far end
// is the wasm `VirtualPrinter` from crates/ptouch-wasm, i.e. the same device-side parser and
// status pusher the core's own tests use. Unlike `serial-stub.ts` (a hand-written JS fake),
// every byte the studio writes is decoded by the core, so the test can compare what was
// "printed" with the preview.
//
// The page loads its own copy of the wasm bindings from `__e2e__/ptouch.js` (same origin, so the
// production CSP `script-src 'self' 'wasm-unsafe-eval'` allows it); Playwright serves those URLs
// from web/src/wasm/pkg. The app's own wasm instance is untouched. Block service workers in
// tests that use this fixture so the routed requests always reach Playwright.
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'

export interface VirtualSerialOptions {
  /** Default "PT-P710BT". */
  model?: string
  /** Default "tze128-24" (24 mm laminated, white tape / black ink). */
  mediaId?: string
  /** open() rejects this many times with NetworkError first (default 1, like the real Mac). */
  openFailures?: number
  /** Split every 32-byte status frame like RFCOMM does (default [7, 25]). */
  fragment?: number[]
  /** VirtualTiming (ms); defaults keep a short label at ~1–3 s. */
  timing?: Record<string, number>
}

/** What the fixture exposes on `window` (typed loosely: the bindings are loaded at runtime). */
export interface VirtualSerialWindow {
  /** Every chunk written to the port, in order. */
  __vsWrites: number[][]
  __vsOpenAttempts: number
  /** The page-side wasm bindings module (decodeJob, Bitmap1, …) once the port was opened. */
  __vsWasm?: Record<string, unknown>
  /** The VirtualPrinter behind the port once it was opened. */
  __vsPrinter?: {
    printedCount: number
    printedPage(i: number): { length: number; height: number; get(x: number, y: number): boolean; free(): void } | undefined
    violations(): string[]
  }
}

/** Self-contained (serialised into the page by Playwright): no imports or outer variables. */
function installVirtualSerial(opts: VirtualSerialOptions): void {
  const SPP = '00001101-0000-1000-8000-00805f9b34fb'
  const model = opts.model ?? 'PT-P710BT'
  const mediaId = opts.mediaId ?? 'tze128-24'
  const fragment = opts.fragment ?? [7, 25]
  let openFailures = opts.openFailures ?? 1
  const w = globalThis as unknown as VirtualSerialWindow & Record<string, unknown>
  w.__vsWrites = []
  w.__vsOpenAttempts = 0

  type Printer = {
    handleInput(b: Uint8Array, now: number): void
    pollOutput(now: number): Uint8Array | undefined
  } & NonNullable<VirtualSerialWindow['__vsPrinter']>
  let printer: Printer | null = null

  async function load(): Promise<Printer> {
    if (printer) return printer
    const base = document.baseURI
    const mod = (await import(/* @vite-ignore */ new URL('__e2e__/ptouch.js', base).href)) as Record<string, unknown> & {
      default: (o: { module_or_path: URL }) => Promise<unknown>
      VirtualPrinter: new (m: string, id: string, b: unknown, t: unknown) => Printer
    }
    await mod.default({ module_or_path: new URL('__e2e__/ptouch_bg.wasm', base) })
    printer = new mod.VirtualPrinter(model, mediaId, { kind: 'normal' }, opts.timing ?? null)
    w.__vsWasm = mod
    w.__vsPrinter = printer
    return printer
  }

  class VirtualPort extends EventTarget {
    readable: ReadableStream<Uint8Array> | null = null
    _writable: WritableStream<Uint8Array> | null = null
    _ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
    _pump: ReturnType<typeof setInterval> | null = null
    readonly connected = true

    getInfo() {
      return { bluetoothServiceClassId: SPP }
    }

    get writable(): WritableStream<Uint8Array> | null {
      if (!this.readable) return null
      this._writable ??= new WritableStream<Uint8Array>(
        {
          write: (chunk) => {
            w.__vsWrites.push(Array.from(chunk))
            printer?.handleInput(chunk, performance.now())
            this._deliver()
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
      w.__vsOpenAttempts++
      if (this.readable) throw new DOMException('The port is already open.', 'InvalidStateError')
      await load()
      if (openFailures > 0) {
        openFailures--
        await new Promise((r) => setTimeout(r, 50))
        throw new DOMException('Failed to open serial port.', 'NetworkError')
      }
      this.readable = new ReadableStream<Uint8Array>({
        start: (c) => {
          this._ctrl = c
        },
      })
      this._pump = setInterval(() => this._deliver(), 5)
    }

    /** Pushes every status frame the virtual printer has due by now, RFCOMM-fragmented. */
    _deliver(): void {
      if (!printer || !this._ctrl) return
      const now = performance.now()
      for (let f = printer.pollOutput(now); f; f = printer.pollOutput(now)) {
        let at = 0
        for (let i = 0; at < f.length; i++) {
          const n = fragment[i % fragment.length] ?? f.length
          this._ctrl.enqueue(f.slice(at, at + n))
          at += n
        }
      }
    }

    async close(): Promise<void> {
      if (this.readable?.locked || this._writable?.locked) throw new DOMException('Cannot close a locked port', 'InvalidStateError')
      if (this._pump !== null) clearInterval(this._pump)
      this._pump = null
      this.readable = null
      this._writable = null
      this._ctrl = null
    }

    async setSignals(_s: unknown): Promise<void> {}
    async forget(): Promise<void> {}
  }

  const port = new VirtualPort()
  let granted = false
  const serial = {
    requestPort: () => {
      granted = true
      return Promise.resolve(port)
    },
    getPorts: () => Promise.resolve(granted ? [port] : []),
    addEventListener() {},
    removeEventListener() {},
  }
  Object.defineProperty(Navigator.prototype, 'serial', { get: () => serial, configurable: true })
}

/** Installs the wasm-backed navigator.serial in `page` (call before `page.goto`). */
export async function stubVirtualSerial(page: Page, opts: VirtualSerialOptions = {}): Promise<void> {
  const pkg = (file: string) => fileURLToPath(new URL(`../../src/wasm/pkg/${file}`, import.meta.url))
  await page.route('**/__e2e__/ptouch.js', (r) => r.fulfill({ path: pkg('ptouch.js'), contentType: 'text/javascript' }))
  await page.route('**/__e2e__/ptouch_bg.wasm', (r) => r.fulfill({ path: pkg('ptouch_bg.wasm'), contentType: 'application/wasm' }))
  await page.addInitScript(installVirtualSerial, opts)
}

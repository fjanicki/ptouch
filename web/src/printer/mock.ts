// W2 — MockTransport backed by the wasm VirtualPrinter, so the mock speaks exactly the protocol
// the core encodes. Used by unit tests, the "No printer (virtual)" connect option and the
// diagnostics page. Every reply is scheduled on the injected Clock (deterministic in tests),
// optionally fragmented like RFCOMM ([7, 25]) and delayed by `latencyMs`.
import { VirtualPrinter, type Bitmap1, type VirtualBehaviour, type VirtualTiming } from '../wasm'
import { LinkLostError, abortError } from './errors'
import { DEFAULT_OPEN_RETRY, openWithRetry, type OpenRetryPolicy } from './retry'
import { realClock, type Clock, type OpenOptions, type Transport, type TransportEvent, type TransportInfo } from './transport'

export interface MockScenario {
  model: string // "PT-P710BT"
  mediaId: string // "tze128-24"
  behaviour?: VirtualBehaviour
  timing?: VirtualTiming
  /** Split every reply like RFCOMM does, e.g. [7, 25] (the pattern repeats). */
  fragment?: number[]
  /** Extra latency added to every reply (ms). */
  latencyMs?: number
  /** Open fails this many times with NetworkError first (exercises the retry path). */
  openFailures?: number
  /** Drop the link after this many written bytes ('lost' event). */
  disconnectAfterBytes?: number
  /** Retry policy for open() (default DEFAULT_OPEN_RETRY, like Web Serial). */
  openRetry?: OpenRetryPolicy
}

export const DEFAULT_SCENARIO: MockScenario = { model: 'PT-P710BT', mediaId: 'tze128-24' }

export class MockTransport implements Transport {
  readonly info: TransportInfo
  /** Every write, for assertions. */
  readonly written: Uint8Array[] = []
  readonly scenario: MockScenario
  readonly clock: Clock
  #printer: VirtualPrinter | null = null
  #open = false
  #openFailuresLeft: number
  #bytesWritten = 0
  #listeners = new Set<(e: TransportEvent) => void>()
  #timer: unknown = null
  /** Pending delivery timers (latency), cleared on close/lost. */
  #deliveries = new Set<unknown>()
  #fragmentIndex = 0

  constructor(scenario: Partial<MockScenario> = {}, clock: Clock = realClock) {
    this.scenario = { ...DEFAULT_SCENARIO, ...scenario }
    this.clock = clock
    this.#openFailuresLeft = this.scenario.openFailures ?? 0
    this.info = { kind: 'virtual', label: `Virtual ${this.scenario.model}`, persistentGrant: true }
  }

  get isOpen(): boolean {
    return this.#open
  }

  /** The simulated printer (null until the first open). Survives close() so pages stay inspectable. */
  get printer(): VirtualPrinter | null {
    return this.#printer
  }

  /** Creates the VirtualPrinter (wasm must be loaded) on first open; re-opening keeps it. */
  async open(opts: OpenOptions = {}): Promise<void> {
    if (this.#open) return
    await openWithRetry(
      async () => {
        if (this.#openFailuresLeft > 0) {
          this.#openFailuresLeft--
          throw new DOMException('Failed to open serial port.', 'NetworkError')
        }
      },
      this.scenario.openRetry ?? DEFAULT_OPEN_RETRY,
      opts,
      this.clock,
    )
    this.#printer ??= new VirtualPrinter(this.scenario.model, this.scenario.mediaId, this.scenario.behaviour, this.scenario.timing)
    this.#open = true
  }

  /** Feeds the virtual printer and schedules its replies on `clock`. */
  async write(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError()
    const printer = this.#printer
    if (!this.#open || !printer) throw new LinkLostError('The virtual printer is not open')
    const limit = this.scenario.disconnectAfterBytes
    if (limit !== undefined && this.#bytesWritten + bytes.length > limit) {
      const accepted = bytes.subarray(0, Math.max(0, limit - this.#bytesWritten))
      if (accepted.length > 0) {
        this.written.push(accepted.slice())
        printer.handleInput(accepted, this.clock.now())
      }
      this.#bytesWritten = limit
      const e = new LinkLostError('The virtual printer disconnected')
      this.#lose(e)
      throw e
    }
    this.#bytesWritten += bytes.length
    this.written.push(bytes.slice())
    printer.handleInput(bytes, this.clock.now())
    this.#schedule()
  }

  async abortWrites(): Promise<void> {}

  async close(): Promise<void> {
    this.#open = false
    this.#stopTimers()
  }

  /** Close and free the virtual printer (pages are gone afterwards). */
  async dispose(): Promise<void> {
    await this.close()
    this.#printer?.free()
    this.#printer = null
  }

  subscribe(listener: (e: TransportEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Simulates the printer powering off / going out of range. */
  simulateDisconnect(): void {
    this.#lose(new LinkLostError('The virtual printer disconnected'))
  }

  /** All bytes written so far, concatenated. */
  writtenBytes(): Uint8Array {
    const total = this.written.reduce((n, b) => n + b.length, 0)
    const out = new Uint8Array(total)
    let off = 0
    for (const b of this.written) {
      out.set(b, off)
      off += b.length
    }
    return out
  }

  /** Pages the virtual printer has printed (label orientation). Caller frees them. */
  printedPages(): Bitmap1[] {
    const p = this.#printer
    if (!p) return []
    const out: Bitmap1[] = []
    for (let i = 0; i < p.printedCount; i++) {
      const page = p.printedPage(i)
      if (page) out.push(page)
    }
    return out
  }

  /** Protocol violations the virtual printer recorded. */
  violations(): string[] {
    return this.#printer?.violations() ?? []
  }

  #schedule(): void {
    const printer = this.#printer
    if (!this.#open || !printer) return
    if (this.#timer !== null) this.clock.clearTimeout(this.#timer)
    this.#timer = null
    const at = printer.nextOutputAt()
    if (at === undefined) return
    this.#timer = this.clock.setTimeout(() => {
      this.#timer = null
      this.#flush()
    }, Math.max(0, at - this.clock.now()))
  }

  #flush(): void {
    const printer = this.#printer
    if (!this.#open || !printer) return
    const now = this.clock.now()
    for (let frame = printer.pollOutput(now); frame; frame = printer.pollOutput(now)) this.#deliver(frame)
    this.#schedule()
  }

  #deliver(frame: Uint8Array): void {
    const pattern = (this.scenario.fragment ?? []).filter((n) => n > 0)
    const pieces: Uint8Array[] = []
    if (pattern.length === 0) pieces.push(frame)
    else {
      let off = 0
      while (off < frame.length) {
        const n = pattern[this.#fragmentIndex++ % pattern.length] ?? frame.length
        pieces.push(frame.subarray(off, off + n))
        off += n
      }
    }
    const latency = this.scenario.latencyMs ?? 0
    for (const piece of pieces) {
      const bytes = piece.slice()
      const h = this.clock.setTimeout(() => {
        this.#deliveries.delete(h)
        if (this.#open) this.#emit({ type: 'data', bytes })
      }, latency)
      this.#deliveries.add(h)
    }
  }

  #stopTimers(): void {
    if (this.#timer !== null) this.clock.clearTimeout(this.#timer)
    this.#timer = null
    for (const h of this.#deliveries) this.clock.clearTimeout(h)
    this.#deliveries.clear()
  }

  #emit(e: TransportEvent): void {
    for (const fn of [...this.#listeners]) fn(e)
  }

  #lose(error: unknown): void {
    if (!this.#open) return
    this.#open = false
    this.#stopTimers()
    this.#emit({ type: 'lost', error })
  }
}

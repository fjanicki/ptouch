// W2 test helpers: a deterministic Clock and a Web Serial PortLike built from real WHATWG
// streams (node 24 has ReadableStream / WritableStream / DOMException globally).
import type { Clock } from '../../../src/printer/transport'
import type { PortLike, SerialLike } from '../../../src/printer/webserial'

/** Lets every pending microtask (and promise chain) run. */
export const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

export class FakeClock implements Clock {
  t = 1000
  #seq = 0
  #timers = new Map<number, { at: number; fn: () => void }>()
  /** Every requested delay, in order (backoff assertions). */
  readonly delays: number[] = []

  now(): number {
    return this.t
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq
    this.delays.push(ms)
    this.#timers.set(id, { at: this.t + Math.max(0, ms), fn })
    return id
  }

  clearTimeout(h: unknown): void {
    this.#timers.delete(h as number)
  }

  get pending(): number {
    return this.#timers.size
  }

  /** Advances time by `ms`, firing due timers in (time, creation) order with microtasks flushed between. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms
    for (;;) {
      await flush()
      let next: [number, { at: number; fn: () => void }] | undefined
      for (const e of this.#timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e
      if (!next) break
      this.#timers.delete(next[0])
      this.t = Math.max(this.t, next[1].at)
      next[1].fn()
    }
    this.t = end
    await flush()
  }

  /** Advances in `step` ms increments until `pred()` or `maxMs` elapsed. Returns pred(). */
  async until(pred: () => boolean, maxMs = 120_000, step = 10): Promise<boolean> {
    const end = this.t + maxMs
    while (!pred() && this.t < end) await this.advance(step)
    return pred()
  }
}

/** Waits (real time, microtask/macrotask turns) for `pred`. */
export async function eventually(pred: () => boolean, turns = 200): Promise<void> {
  for (let i = 0; i < turns && !pred(); i++) await flush()
  if (!pred()) throw new Error('condition not reached')
}

export interface FakePortOptions {
  info?: SerialPortInfo & { bluetoothServiceClassId?: string }
  openFailures?: number
  /** Error thrown by open() (default NetworkError). */
  openError?: () => unknown
  connected?: boolean
}

/**
 * A SerialPort fake with Chrome-like semantics:
 * - open() fails `openFailures` times with NetworkError, then creates fresh streams;
 * - the writable uses CountQueuingStrategy(1); the sink can be gated to simulate a slow link;
 * - after writer.abort() the writable is replaced on next access (spec);
 * - close() rejects with InvalidStateError while a stream is locked (spec), so tests catch a
 *   missing releaseLock().
 */
export class FakePort implements PortLike {
  info: SerialPortInfo & { bluetoothServiceClassId?: string }
  openFailures: number
  openError: () => unknown
  openCalls = 0
  closeCalls = 0
  closeErrors = 0
  lastOpenOptions: SerialOptions | null = null
  signals: SerialOutputSignals[] = []
  /** Chunks received by the sink, in order. */
  received: Uint8Array[] = []
  /** Writer calls in order: 'ready' | 'write:<n>' (via the patched getWriter). */
  writerCalls: string[] = []
  /** When set, every sink write waits for this gate (slow link). */
  gate: (() => Promise<void>) | null = null
  /** When set, the sink throws this on the next write. */
  sinkError: unknown = null
  /** Called with every chunk the sink accepts (e.g. to answer like a printer). */
  onData: ((chunk: Uint8Array, port: FakePort) => void) | null = null
  connected?: boolean
  forgotten = false
  isOpen = false
  #readable: ReadableStream<Uint8Array> | null = null
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null
  #writable: WritableStream<Uint8Array> | null = null
  #listeners = new Set<() => void>()
  readerCancelled = 0

  constructor(opts: FakePortOptions = {}) {
    this.info = opts.info ?? {}
    this.openFailures = opts.openFailures ?? 0
    this.openError = opts.openError ?? (() => new DOMException('Failed to open serial port.', 'NetworkError'))
    if (opts.connected !== undefined) this.connected = opts.connected
  }

  getInfo(): SerialPortInfo {
    return this.info
  }

  async open(o: SerialOptions): Promise<void> {
    this.openCalls++
    this.lastOpenOptions = o
    if (this.isOpen) throw new DOMException('The port is already open.', 'InvalidStateError')
    if (this.openFailures > 0) {
      this.openFailures--
      throw this.openError()
    }
    this.isOpen = true
    this.#newReadable()
  }

  async close(): Promise<void> {
    this.closeCalls++
    if (this.#readable?.locked || this.#writable?.locked) {
      this.closeErrors++
      throw new DOMException('Cannot close a port with locked streams', 'InvalidStateError')
    }
    this.isOpen = false
    this.#readable = null
    this.#writable = null
    this.#controller = null
  }

  async setSignals(s: SerialOutputSignals): Promise<void> {
    this.signals.push(s)
  }

  async forget(): Promise<void> {
    this.forgotten = true
  }

  get readable(): ReadableStream<Uint8Array> | null {
    return this.#readable
  }

  get writable(): WritableStream<Uint8Array> | null {
    if (!this.isOpen) return null
    if (!this.#writable) this.#writable = this.#newWritable()
    return this.#writable
  }

  addEventListener(_type: 'disconnect', l: () => void): void {
    this.#listeners.add(l)
  }

  removeEventListener(_type: 'disconnect', l: () => void): void {
    this.#listeners.delete(l)
  }

  /** Printer → host bytes. */
  push(bytes: Uint8Array | number[]): void {
    this.#controller?.enqueue(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes))
  }

  /** Fatal read error (device lost): stream errors and `readable` becomes null. */
  failRead(error: unknown = new DOMException('The device has been lost.', 'NetworkError')): void {
    this.#controller?.error(error)
    this.#readable = null
  }

  /** Non-fatal read error: stream errors, a fresh `readable` replaces it (spec). */
  overrun(): void {
    const c = this.#controller
    this.#newReadable()
    c?.error(new DOMException('Buffer overrun', 'BufferOverrunError'))
  }

  /** The readable closes without the host asking (device gone). */
  endRead(): void {
    this.#controller?.close()
  }

  disconnect(): void {
    for (const l of [...this.#listeners]) l()
  }

  bytesReceived(): Uint8Array {
    const n = this.received.reduce((a, b) => a + b.length, 0)
    const out = new Uint8Array(n)
    let o = 0
    for (const r of this.received) {
      out.set(r, o)
      o += r.length
    }
    return out
  }

  #newReadable(): void {
    this.#readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.#controller = c
      },
      cancel: () => {
        this.readerCancelled++
      },
    })
  }

  #newWritable(): WritableStream<Uint8Array> {
    const stream = new WritableStream<Uint8Array>(
      {
        write: async (chunk) => {
          if (this.sinkError) {
            const e = this.sinkError
            this.sinkError = null
            throw e
          }
          if (this.gate) await this.gate()
          this.received.push(chunk.slice())
          this.onData?.(chunk.slice(), this)
        },
        abort: () => {
          if (this.#writable === stream) this.#writable = null
        },
      },
      new CountQueuingStrategy({ highWaterMark: 1 }),
    )
    const getWriter = stream.getWriter.bind(stream)
    const calls = this.writerCalls
    stream.getWriter = () => {
      const w = getWriter()
      return new Proxy(w, {
        get(target, prop) {
          if (prop === 'ready') {
            calls.push('ready')
            return target.ready
          }
          if (prop === 'write') return (c: Uint8Array) => (calls.push(`write:${c.length}`), target.write(c))
          const v = Reflect.get(target, prop, target)
          return typeof v === 'function' ? v.bind(target) : v
        },
      })
    }
    return stream
  }
}

export class FakeSerial implements SerialLike {
  ports: FakePort[]
  calls: (Parameters<SerialLike['requestPort']>[0] | undefined)[] = []
  /** Next requestPort() outcome(s); default resolves with ports[0]. */
  next: (() => Promise<PortLike>)[] = []

  constructor(ports: FakePort[] = [new FakePort({ info: { bluetoothServiceClassId: '00001101-0000-1000-8000-00805f9b34fb' } })]) {
    this.ports = ports
  }

  requestPort(options?: Parameters<SerialLike['requestPort']>[0]): Promise<PortLike> {
    this.calls.push(options)
    const n = this.next.shift()
    if (n) return n()
    const p = this.ports[0]
    return p ? Promise.resolve(p) : Promise.reject(new DOMException('No port selected by the user.', 'NotFoundError'))
  }

  async getPorts(): Promise<PortLike[]> {
    return this.ports
  }
}

/** Makes `port` answer every `ESC i S` with `status` (split like RFCOMM) on `clock`. */
export function answerStatus(port: FakePort, status: Uint8Array, clock: Clock, delayMs = 92): void {
  let tail: number[] = []
  port.onData = (chunk, p) => {
    tail = [...tail, ...chunk].slice(-3)
    if (tail[0] === 0x1b && tail[1] === 0x69 && tail[2] === 0x53) {
      clock.setTimeout(() => {
        p.push(status.subarray(0, 7))
        p.push(status.subarray(7))
      }, delayMs)
    }
  }
}

/**
 * The verified Chrome 154 RFCOMM behaviour on macOS: the first open() hangs `hangMs` (10 s)
 * and fails with NetworkError; later opens succeed after `openMs` (378 ms). Times on `clock`.
 */
export class SlowRfcommPort extends FakePort {
  readonly clock: FakeClock
  hangMs: number
  openMs: number
  #first = true
  constructor(clock: FakeClock, hangMs = 10_000, openMs = 378) {
    super({ info: { bluetoothServiceClassId: '00001101-0000-1000-8000-00805f9b34fb' } })
    this.clock = clock
    this.hangMs = hangMs
    this.openMs = openMs
  }
  override async open(o: SerialOptions): Promise<void> {
    if (this.#first) {
      this.#first = false
      this.openCalls++
      await new Promise<void>((r) => this.clock.setTimeout(r, this.hangMs))
      throw new DOMException('Failed to open serial port.', 'NetworkError')
    }
    await new Promise<void>((r) => this.clock.setTimeout(r, this.openMs))
    return super.open(o)
  }
}

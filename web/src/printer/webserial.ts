// W2 — Web Serial transport (ARCHITECTURE.md §3.2, §4.3, §5.4; PROTOCOL.md §2.6).
//
// Verified on the user's Mac (Chrome 154, 2026-10-08): the direct-RFCOMM entry's first open()
// failed after 10 s with NetworkError "Failed to open serial port"; an immediate retry opened
// in 378 ms. ⇒ open() retries on NetworkError (≥ 2 retries, short backoff) and reports
// progress so the UI can show "Waking printer…". The status reply then arrived 92 ms after
// the request, split across RFCOMM frames (MTU 320), so the read pump forwards whatever it
// gets and the session reassembles frames.
//
// The transport is a dumb byte pipe: one long-lived read pump feeding 'data' events, chunked
// writes with backpressure, and 'lost' when the link drops. No protocol knowledge here.
import { LinkLostError, WrongPortError, abortError, isDomError } from './errors'
import { DEFAULT_OPEN_RETRY, openWithRetry, sleep, type OpenRetryPolicy } from './retry'
import { WRITE_TUNING, realClock, type Clock, type OpenOptions, type Transport, type TransportEvent, type TransportInfo, type WriteTuning } from './transport'

export { DEFAULT_OPEN_RETRY, type OpenRetryPolicy } from './retry'

export const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb'

/** A direct-RFCOMM entry for a service other than SPP (e.g. the P710BT's Apple iAP entry). */
function isOtherBluetoothService(info: PortInfoEx): boolean {
  return info.bluetoothServiceClassId !== undefined && info.bluetoothServiceClassId.toLowerCase() !== SPP_UUID
}

/** Structural subset of SerialPort so tests can pass fakes (PortLike pattern). */
export interface PortLike {
  open(o: SerialOptions): Promise<void>
  close(): Promise<void>
  readonly readable: ReadableStream<Uint8Array> | null
  readonly writable: WritableStream<Uint8Array> | null
  getInfo(): SerialPortInfo
  setSignals?(s: SerialOutputSignals): Promise<void>
  forget?(): Promise<void>
  /** Chrome 130+ desktop, Firefox 151+; absent on Android. */
  readonly connected?: boolean
  addEventListener?(type: 'disconnect', listener: () => void): void
  removeEventListener?(type: 'disconnect', listener: () => void): void
}

/** Structural subset of navigator.serial. */
export interface SerialLike {
  requestPort(options?: SerialPortRequestOptions & { allowedBluetoothServiceClassIds?: string[] }): Promise<PortLike>
  getPorts(): Promise<PortLike[]>
}

export type SerialMode = 'rfcomm' | 'os-port'

export interface WebSerialOptions {
  /** Required by the API, ignored by Bluetooth; 9600 keeps Chrome off IOSSIOSPEED on macOS. */
  baudRate: 9600
  /** Default 16384 (Chrome default is 255). */
  bufferSize: number
  /** setSignals({ dataTerminalReady, requestToSend }) in try/catch after open (default true). */
  assertSignals: boolean
  tuning: WriteTuning
  openRetry: OpenRetryPolicy
  /** Timer source for retry backoff and inter-chunk delays (tests inject a fake). */
  clock: Clock
}

type PortInfoEx = SerialPortInfo & { bluetoothServiceClassId?: string }

function defaultSerial(): SerialLike {
  const s = (globalThis.navigator as { serial?: SerialLike } | undefined)?.serial
  if (!s) throw new DOMException('Web Serial is not available in this browser', 'NotSupportedError')
  return s
}

function detectGecko(): boolean {
  const ua = (globalThis.navigator as { userAgent?: string } | undefined)?.userAgent ?? ''
  return /Firefox\//.test(ua)
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0')

/** Errors after which the Web Serial readable is replaced by a fresh stream (spec §"readable"). */
const NON_FATAL_READ_ERRORS = new Set(['BufferOverrunError', 'BreakError', 'FramingError', 'ParityError'])

export class WebSerialTransport implements Transport {
  /** Chromium: SPP filter + allowedBluetoothServiceClassIds. Gecko: unfiltered. Needs a user
   * gesture — call synchronously from the click handler (requestPort() is invoked before the
   * first `await`). Rejects with NotFoundError when the user closes the chooser. */
  static async requestBluetooth(serial: SerialLike = defaultSerial(), opts?: Partial<WebSerialOptions>, isGecko = detectGecko()): Promise<WebSerialTransport> {
    if (isGecko) {
      // Firefox 151–155 accept the filter but match nothing (empty chooser); ≥156 only tags
      // OS-mapped ports. Unfiltered shows the same ports, so never filter on Gecko.
      return new WebSerialTransport(await serial.requestPort(), opts, true)
    }
    let port: PortLike
    try {
      port = await serial.requestPort({ filters: [{ bluetoothServiceClassId: SPP_UUID }], allowedBluetoothServiceClassIds: [SPP_UUID] })
    } catch (e) {
      // Chromium < 117 rejects the unknown filter member with a TypeError: fall back to the
      // unfiltered chooser (still inside the transient user activation window).
      if (e instanceof TypeError) port = await serial.requestPort()
      else throw e
    }
    return new WebSerialTransport(port, opts, false)
  }

  /** Unfiltered chooser: OS ports (cu.*, COMn, rfcommN) and RFCOMM entries. Needs a user gesture. */
  static async requestAnyPort(serial: SerialLike = defaultSerial(), opts?: Partial<WebSerialOptions>, isGecko = detectGecko()): Promise<WebSerialTransport> {
    const port = await serial.requestPort()
    const info = port.getInfo() as PortInfoEx
    // Chrome lists every RFCOMM service of the paired printer; only SPP speaks the protocol.
    if (!isGecko && isOtherBluetoothService(info)) throw new WrongPortError(info.bluetoothServiceClassId as string)
    return new WebSerialTransport(port, opts, isGecko)
  }

  /**
   * Re-open a previously granted port without a prompt (getPorts()); `match` picks among
   * several (kind, bluetoothServiceClassId, usbVendorId/usbProductId). Ports reporting
   * `connected === true` are preferred, then direct-RFCOMM SPP entries. Resolves null when no
   * granted port matches (or Web Serial is missing).
   */
  static async fromGranted(match?: Partial<TransportInfo>, serial?: SerialLike, opts?: Partial<WebSerialOptions>, isGecko = detectGecko()): Promise<WebSerialTransport | null> {
    let s: SerialLike
    try {
      s = serial ?? defaultSerial()
    } catch {
      return null
    }
    const ports = await s.getPorts()
    const scored = ports
      .map((port) => {
        const info = port.getInfo() as PortInfoEx
        if (!isGecko && isOtherBluetoothService(info)) return null // e.g. the iAP entry
        const kind = info.bluetoothServiceClassId && !isGecko ? 'serial-rfcomm' : 'serial-os-port'
        if (match?.kind && match.kind !== kind) return null
        if (match?.bluetoothServiceClassId && info.bluetoothServiceClassId !== match.bluetoothServiceClassId) return null
        if (match?.usbVendorId !== undefined && info.usbVendorId !== match.usbVendorId) return null
        if (match?.usbProductId !== undefined && info.usbProductId !== match.usbProductId) return null
        let score = 0
        if (port.connected === true) score += 4
        if (info.bluetoothServiceClassId === SPP_UUID) score += 2
        if (info.usbVendorId === 0x04f9) score += 1
        return { port, score }
      })
      .filter((x): x is { port: PortLike; score: number } => x !== null)
      .sort((a, b) => b.score - a.score)
    const best = scored[0]
    return best ? new WebSerialTransport(best.port, opts, isGecko) : null
  }

  readonly info: TransportInfo
  readonly mode: SerialMode
  readonly port: PortLike
  readonly options: WebSerialOptions

  #open = false
  #listeners = new Set<(e: TransportEvent) => void>()
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  #pump: Promise<void> | null = null
  /** Serialises write() calls (a WritableStream has one writer at a time). */
  #writeChain: Promise<void> = Promise.resolve()
  /** Teardown in flight after close() or 'lost' (open() and close() wait for it). */
  #teardown: Promise<void> | null = null
  /** open() in flight: concurrent callers share it; close() aborts it. */
  #opening: Promise<void> | null = null
  /** Aborts the in-flight open() (close() during open, or the caller's signal). */
  #openAbort: AbortController | null = null
  /** A port.open() we stopped waiting for (abort/close): settles once it finished and, if it
   * succeeded, the port was closed again. The next open() waits for it (Chrome rejects a
   * second open() while one is pending). */
  #abandoned: Promise<void> | null = null
  /** port.close() retried after a write stuck in the sink kept the writable locked. */
  #lateClose: Promise<void> | null = null
  /** writer.abort() in flight (the writable is replaced once it settles). */
  #aborting: Promise<void> | null = null
  #onDisconnect = () => this.#lose(new LinkLostError('The printer disconnected'))

  constructor(port: PortLike, opts: Partial<WebSerialOptions> = {}, isGecko = false) {
    this.port = port
    this.options = { baudRate: 9600, bufferSize: 16384, assertSignals: true, tuning: WRITE_TUNING.serial, openRetry: DEFAULT_OPEN_RETRY, clock: realClock, ...opts }
    const info = port.getInfo() as PortInfoEx
    this.mode = info.bluetoothServiceClassId && !isGecko ? 'rfcomm' : 'os-port'
    const usb = info.usbVendorId !== undefined
    this.info = {
      kind: this.mode === 'rfcomm' ? 'serial-rfcomm' : 'serial-os-port',
      label: this.mode === 'rfcomm' ? 'Bluetooth printer' : usb ? `USB serial ${hex4(info.usbVendorId ?? 0)}:${hex4(info.usbProductId ?? 0)}` : 'Serial port',
      // Chrome persists grants for RFCOMM entries and USB-serial adapters, not for macOS cu.*.
      persistentGrant: this.mode === 'rfcomm' || usb,
      ...(info.bluetoothServiceClassId ? { bluetoothServiceClassId: info.bluetoothServiceClassId } : {}),
      ...(usb ? { usbVendorId: info.usbVendorId, ...(info.usbProductId !== undefined ? { usbProductId: info.usbProductId } : {}) } : {}),
    }
  }

  get isOpen(): boolean {
    return this.#open
  }

  /**
   * open() with retry on NetworkError (see header), then start the single read pump.
   * Concurrent calls share one attempt. close() (or `signal`) during the open rejects it with
   * AbortError at once; a platform open() that completes later is closed again.
   */
  open(opts: OpenOptions = {}): Promise<void> {
    if (this.#open) return Promise.resolve()
    if (this.#opening) return this.#opening
    const ctrl = new AbortController()
    const external = opts.signal
    const forward = () => ctrl.abort()
    if (external?.aborted) ctrl.abort()
    else external?.addEventListener('abort', forward, { once: true })
    this.#openAbort = ctrl
    const run = this.#doOpen({ ...opts, signal: ctrl.signal }).finally(() => {
      external?.removeEventListener('abort', forward)
      if (this.#opening === run) this.#opening = null
      if (this.#openAbort === ctrl) this.#openAbort = null
    })
    this.#opening = run
    return run
  }

  async #doOpen(opts: OpenOptions & { signal: AbortSignal }): Promise<void> {
    const { signal } = opts
    if (this.#teardown) await this.#teardown
    if (this.#lateClose) await Promise.race([this.#lateClose, sleep(this.options.clock, 2000)])
    if (this.#abandoned) await this.#abandoned
    if (signal.aborted) throw abortError()
    const { baudRate, bufferSize } = this.options
    const serialOpts: SerialOptions = { baudRate, bufferSize, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }
    let recovered = false
    await openWithRetry(
      async () => {
        try {
          await this.#openPort(serialOpts, signal)
        } catch (e) {
          // "The port is already open" although this transport is closed: an earlier close()
          // failed (a write stuck in the sink kept the stream locked). Close it once and retry.
          if (recovered || !isDomError(e, 'InvalidStateError') || signal.aborted) throw e
          recovered = true
          await this.port.close().catch(() => {})
          await this.#openPort(serialOpts, signal)
        }
      },
      this.options.openRetry,
      opts,
      this.options.clock,
    )
    if (this.options.assertSignals && this.port.setSignals && !signal.aborted) {
      // Needed on OS-mapped nodes (P300BT stays silent until DTR/RTS); a no-op on RFCOMM.
      try {
        await this.port.setSignals({ dataTerminalReady: true, requestToSend: true })
      } catch {
        /* not supported by this port type */
      }
    }
    if (signal.aborted) {
      await this.port.close().catch(() => {})
      throw abortError()
    }
    this.#open = true
    this.#writeChain = Promise.resolve()
    this.port.addEventListener?.('disconnect', this.#onDisconnect)
    this.#pump = this.#readLoop()
  }

  /** port.open() raced against `signal`: an abort rejects at once; if the abandoned open()
   * later succeeds, the port is closed again (tracked in #abandoned). */
  #openPort(o: SerialOptions, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError())
    const opening = this.port.open(o)
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const settled: Promise<void> = opening
          .then(
            () => this.port.close().catch(() => {}),
            () => {},
          )
          .finally(() => {
            if (this.#abandoned === settled) this.#abandoned = null
          })
        this.#abandoned = settled
        reject(abortError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      opening.then(
        () => {
          signal.removeEventListener('abort', onAbort)
          if (signal.aborted) return // onAbort already rejected and closes the port
          resolve()
        },
        (e: unknown) => {
          signal.removeEventListener('abort', onAbort)
          if (!signal.aborted) reject(e)
        },
      )
    })
  }

  /**
   * Chunked write with backpressure: getWriter() → for each chunk { await ready; await
   * write(chunk) } → releaseLock() in finally. Resolves when Chrome has accepted the bytes
   * into its buffer, not when the printer got them. `signal` (or abortWrites()) aborts the
   * writer, which discards queued bytes; the write then rejects with AbortError.
   */
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    const run = this.#writeChain.then(() => this.#writeNow(bytes, signal))
    this.#writeChain = run.catch(() => {})
    return run
  }

  async #writeNow(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (!this.#open) throw new LinkLostError('The port is not open')
    if (signal?.aborted) throw abortError()
    await this.#abortSettled()
    if (!this.#open) throw new LinkLostError('The port was closed')
    const writable = this.port.writable
    if (!writable) {
      const e = new LinkLostError('The port is no longer writable')
      this.#lose(e)
      throw e
    }
    const writer = writable.getWriter()
    this.#writer = writer
    let aborted = false
    const onAbort = () => {
      aborted = true
      writer.abort(abortError()).catch(() => {})
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const { chunkSize, interChunkDelayMs } = this.options.tuning
    const size = Math.max(1, chunkSize)
    try {
      for (let off = 0; off < bytes.length; off += size) {
        if (aborted || this.#writer !== writer) throw abortError()
        await writer.ready
        await writer.write(bytes.subarray(off, Math.min(off + size, bytes.length)))
        if (interChunkDelayMs > 0 && off + size < bytes.length) await sleep(this.options.clock, interChunkDelayMs)
      }
    } catch (e) {
      if (aborted || this.#writer !== writer || isDomError(e, 'AbortError')) throw abortError('Write cancelled')
      if (!this.#open) throw new LinkLostError('The port was closed', { cause: e })
      const lost = new LinkLostError('Writing to the printer failed', { cause: e })
      this.#lose(lost)
      throw lost
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (this.#writer === writer) this.#writer = null
      try {
        writer.releaseLock()
      } catch {
        /* already released */
      }
    }
  }

  /**
   * writer.abort() discards queued data; the pending write() rejects with AbortError. Does not
   * wait for the chunk already in the sink (abort settles after it); the next write() and
   * close() do.
   */
  async abortWrites(): Promise<void> {
    const w = this.#writer
    if (!w) return
    this.#writer = null
    const settled = w.abort(abortError()).catch(() => {})
    this.#aborting = settled
    void settled.then(() => {
      if (this.#aborting === settled) this.#aborting = null
    })
  }

  /** Waits for a pending writer.abort() (bounded, in case the device never answers). */
  async #abortSettled(): Promise<void> {
    if (this.#aborting) await Promise.race([this.#aborting, sleep(this.options.clock, 2000)])
  }

  /**
   * writer.abort() → reader.cancel() → releaseLock() (pump) → port.close(). Idempotent. During
   * an open() it aborts that open (which then rejects with AbortError). A later open() waits
   * for the teardown, so close-then-open never hits "The port is already open".
   */
  async close(): Promise<void> {
    if (this.#opening) {
      this.#openAbort?.abort()
      try {
        await this.#opening
      } catch {
        /* AbortError (or the open's own failure) */
      }
    }
    if (!this.#open) {
      if (this.#teardown) await this.#teardown
      return
    }
    this.#open = false
    await this.#startTeardown()
  }

  #startTeardown(): Promise<void> {
    const t = this.#shutdown().finally(() => {
      if (this.#teardown === t) this.#teardown = null
    })
    this.#teardown = t
    return t
  }

  subscribe(listener: (e: TransportEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Revoke the grant (Chrome 103+, Firefox 151+). Closes first. */
  async forget(): Promise<void> {
    await this.close()
    await this.port.forget?.()
  }

  async #shutdown(): Promise<void> {
    this.port.removeEventListener?.('disconnect', this.#onDisconnect)
    await this.abortWrites()
    // Bounded wait for the aborted write to unwind: its finally releases the writer lock that
    // would otherwise make port.close() reject.
    const writes = this.#writeChain
    await Promise.race([Promise.all([this.#aborting, writes]), sleep(this.options.clock, 2000)])
    const reader = this.#reader
    if (reader) {
      try {
        await reader.cancel()
      } catch {
        /* stream already errored */
      }
    }
    try {
      await this.#pump
    } catch {
      /* pump never throws, but be safe */
    }
    this.#pump = null
    try {
      await this.port.close()
    } catch {
      // Already closed / device gone — or a write is stuck in the sink (stalled link) and keeps
      // the writable locked. Retry once it unwinds (the link timeout errors it), so the OS port
      // is not leaked; open() waits for this (bounded) and recovers from InvalidStateError.
      const late: Promise<void> = writes
        .then(() => this.port.close())
        .catch(() => {})
        .finally(() => {
          if (this.#lateClose === late) this.#lateClose = null
        })
      this.#lateClose = late
    }
  }

  /** Single long-lived read pump: never a per-call read raced against a timer. */
  async #readLoop(): Promise<void> {
    while (this.#open) {
      const readable = this.port.readable
      if (!readable) {
        this.#lose(new LinkLostError('The port is no longer readable'))
        return
      }
      let reader: ReadableStreamDefaultReader<Uint8Array>
      try {
        reader = readable.getReader()
      } catch (e) {
        this.#lose(new LinkLostError('Could not read from the port', { cause: e }))
        return
      }
      this.#reader = reader
      let ended = false
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) {
            ended = true
            break
          }
          if (value && value.byteLength > 0) this.#emit({ type: 'data', bytes: value })
        }
      } catch (e) {
        if (!this.#open) return
        const name = (e as { name?: string } | null)?.name ?? ''
        // Non-fatal serial errors replace port.readable with a fresh stream: keep reading.
        if (!NON_FATAL_READ_ERRORS.has(name) || !this.port.readable) {
          this.#lose(new LinkLostError('Reading from the printer failed', { cause: e }))
          return
        }
      } finally {
        if (this.#reader === reader) this.#reader = null
        try {
          reader.releaseLock()
        } catch {
          /* already released */
        }
      }
      if (ended) {
        // done without close(): the stream was closed under us (device gone).
        if (this.#open) this.#lose(new LinkLostError('The printer closed the connection'))
        return
      }
    }
  }

  #emit(e: TransportEvent): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn(e)
      } catch (err) {
        console.error('transport listener failed', err)
      }
    }
  }

  /** Mark the link lost once, notify, and tear down so a later open() starts clean. */
  #lose(error: unknown): void {
    if (!this.#open) return
    this.#open = false
    // Teardown first, so a close()/open() issued from a 'lost' listener waits for it.
    void this.#startTeardown()
    this.#emit({ type: 'lost', error })
  }
}

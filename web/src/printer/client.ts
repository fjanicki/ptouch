// W2 — PrinterClient: the only place bytes meet the wasm PrintSession (ARCHITECTURE.md §4.3,
// §5.4–§5.6). Pump: transport 'data' → session.handleInput(bytes, now); drain pollTransmit()
// → transport.write (sequential, awaited); drain pollEvent() → listeners; ONE timer armed at
// pollTimeout(). Keeps the port open between prints (macOS "works once" risk).
//
// Progress is derived from status frames pushed by the printer (06/printing → page-started,
// 01 → page-completed, 06/receiving → next page / job-completed; ~9 s for a 5 cm label on a
// PT-P710BT), never from write completion.
import { PrintSession, type Job, type NotificationKind, type PrinterStatus, type SessionConfig, type SessionEvent } from '../wasm'
import { LinkLostError, NotConnectedError, SessionFailedError, abortError, isDomError, type ErrorStage } from './errors'
import type { PacketLog } from './packetlog'
import { realClock, type Clock, type OpenProgress, type Transport, type TransportEvent } from './transport'

export type ClientState =
  | 'disconnected'
  | 'opening' // transport.open() in progress
  | 'waking' // open() retry after NetworkError ("Waking printer…")
  | 'handshaking' // reset + ESC i S, waiting for the first status
  | 'ready'
  | 'printing'
  | 'cancelling'
  | 'no-reply' // opened but the printer never answered (asleep / dead OS port)
  | 'lost' // link dropped; Reconnect re-opens the granted port
  | 'error'

export interface PrintProgress {
  /** 1-based. */
  page: number
  of: number
  phase: 'sending' | 'printing' | 'done'
}

export type PrinterEvent =
  | { type: 'state'; state: ClientState }
  | { type: 'open-progress'; progress: OpenProgress }
  | { type: 'status'; status: PrinterStatus }
  | { type: 'progress'; progress: PrintProgress }
  | { type: 'notification'; notification: NotificationKind }
  /** Unsolicited failure (link lost while idle, keepalive without reply). Failures of an
   * awaited operation (connect / print / refreshStatus) reject that promise instead.
   * ConnectionManager turns either into a Problem (problems.ts). */
  | { type: 'error'; error: unknown; stage: ErrorStage }

export interface PrinterClientOptions {
  log?: PacketLog
  clock?: Clock
  session?: SessionConfig
  /** Known model name, or undefined to detect from the first status. */
  model?: string
  /** Idle keepalive ESC i S interval while the tab is visible (default 60 000; 0 = off). */
  keepaliveMs?: number
  /** Max bytes of a written buffer kept in the packet log (raster data is long; default 96). */
  logMaxBytes?: number
  /** Switch 'opening' to 'waking' after this long on a direct-RFCOMM entry, whose first open()
   * hangs ~10 s on macOS before failing (default 1500; 0 = only on a retry). */
  slowOpenMs?: number
}

interface Pending<T> {
  resolve(v: T): void
  reject(e: unknown): void
}

interface PrintRun extends Pending<void> {
  of: number
}

function isVisible(): boolean {
  const d = (globalThis as { document?: { visibilityState?: string } }).document
  return !d || d.visibilityState !== 'hidden'
}

export class PrinterClient {
  readonly transport: Transport
  readonly options: PrinterClientOptions
  readonly clock: Clock
  #session: PrintSession | null = null
  #listeners = new Set<(e: PrinterEvent) => void>()
  #state: ClientState = 'disconnected'
  #status: PrinterStatus | null = null
  #unsubscribe: (() => void) | null = null
  #timer: unknown = null
  #keepalive: unknown = null
  /** Sequential write queue; `#txGen` invalidates queued buffers on cancel/disconnect. */
  #tx: Promise<void> = Promise.resolve()
  #txGen = 0
  #connecting: Pending<PrinterStatus> | null = null
  #printing: PrintRun | null = null
  #statusWaiters: Pending<PrinterStatus>[] = []
  #recovered: Pending<void>[] = []
  /** print() calls waiting for the session's post-job drain to end. */
  #drained: Pending<void>[] = []
  /** Aborts the connect() in flight (disconnect(), or the caller's signal). */
  #connectCtrl: AbortController | null = null
  /** A close started without awaiting (link lost, dead session); connect() waits for it. */
  #closing: Promise<void> | null = null
  #slowOpenTimer: unknown = null

  constructor(transport: Transport, opts: PrinterClientOptions = {}) {
    this.transport = transport
    this.options = opts
    this.clock = opts.clock ?? realClock
  }

  get state(): ClientState {
    return this.#state
  }

  get lastStatus(): PrinterStatus | null {
    return this.#status
  }

  /** Model detected by the session (e.g. "PT-P710BT"). */
  get modelName(): string | undefined {
    return this.#session?.modelName ?? this.#status?.modelName
  }

  /**
   * open (with retries; state 'waking' from the second attempt, or once a direct-RFCOMM open
   * is slow) + session.connect + await Ready. Resolves with the first status. Rejects with the
   * open error (state 'error'), a {@link SessionFailedError} (`TIMEOUT` ⇒ state 'no-reply';
   * transport closed so Reconnect re-opens it), {@link LinkLostError}, or AbortError when
   * `signal` fires or disconnect() is called (state 'disconnected'; aborts promptly, also during
   * a hanging open()). Refuses (BUSY) while another connect() runs.
   */
  async connect(signal?: AbortSignal): Promise<PrinterStatus> {
    if (this.#state === 'ready' && this.#status && this.transport.isOpen) return this.#status
    if (this.#connectCtrl || this.#connecting || this.#state === 'printing' || this.#state === 'cancelling') throw new SessionFailedError({ code: 'BUSY', message: 'The printer is busy' }, 'handshake')
    const ctrl = new AbortController()
    this.#connectCtrl = ctrl
    const forward = () => ctrl.abort()
    if (signal?.aborted) ctrl.abort()
    else signal?.addEventListener('abort', forward, { once: true })
    try {
      return await this.#connect(ctrl.signal)
    } finally {
      signal?.removeEventListener('abort', forward)
      if (this.#connectCtrl === ctrl) this.#connectCtrl = null
      this.#clearSlowOpen()
    }
  }

  async #connect(signal: AbortSignal): Promise<PrinterStatus> {
    this.#stopTimers()
    const previous = this.#state
    this.#setState('opening')
    // A close started in the background (link lost / dead session) must finish first, or the
    // re-open hits "The port is already open".
    if (this.#closing) await this.#closing
    // A port that stopped answering is re-opened from scratch (macOS OS ports "work once").
    if (this.transport.isOpen && previous !== 'disconnected') await this.#closeQuietly()
    const aborted = async (): Promise<never> => {
      await this.#closeQuietly()
      this.#setState('disconnected')
      throw abortError('Connecting was cancelled')
    }
    if (signal.aborted) return aborted()
    this.#note(`open ${this.transport.info.kind} (${this.transport.info.label})`)
    this.#armSlowOpen()
    try {
      await this.transport.open({
        signal,
        onProgress: (progress) => {
          if (progress.attempt > 1) {
            this.#note(`open failed (${String((progress.lastError as { message?: string } | undefined)?.message ?? progress.lastError)}); retry ${progress.attempt}/${progress.of}`)
            this.#clearSlowOpen()
            this.#setState('waking')
          }
          this.#emit({ type: 'open-progress', progress })
        },
      })
    } catch (e) {
      this.#clearSlowOpen()
      if (signal.aborted || isDomError(e, 'AbortError')) {
        this.#note('open cancelled')
        return aborted()
      }
      this.#note(`open failed: ${String((e as { message?: string })?.message ?? e)}`)
      this.#setState('error')
      throw e
    }
    this.#clearSlowOpen()
    // disconnect() (or the caller) gave up while the platform open() was completing.
    if (signal.aborted) return aborted()
    this.#unsubscribe?.()
    this.#unsubscribe = this.transport.subscribe((e) => this.#onTransport(e))
    this.#session?.free()
    this.#session = new PrintSession(this.options.model ?? null, this.options.session ?? null)
    this.#status = null
    this.#txGen++
    this.#tx = Promise.resolve()
    this.#setState('handshaking')
    const done = new Promise<PrinterStatus>((resolve, reject) => (this.#connecting = { resolve, reject }))
    // cancel() queues the CANCELLED failure; pump at once so the abort settles promptly.
    const onAbort = () => {
      const session = this.#session
      if (!session) return
      session.cancel(this.clock.now())
      this.#pump()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    this.#session.connect(this.clock.now())
    this.#pump()
    try {
      const status = await done
      return status
    } catch (e) {
      if (signal.aborted || (e instanceof SessionFailedError && e.code === 'CANCELLED') || isDomError(e, 'AbortError')) {
        return aborted()
      } else if (e instanceof SessionFailedError && e.code === 'TIMEOUT') {
        this.#setState('no-reply')
        await this.#closeQuietly()
      } else if (!(e instanceof LinkLostError)) {
        this.#setState('error')
        await this.#closeQuietly()
      }
      throw e
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  #armSlowOpen(): void {
    this.#clearSlowOpen()
    const after = this.options.slowOpenMs ?? 1500
    if (after <= 0 || this.transport.info.kind !== 'serial-rfcomm') return
    this.#slowOpenTimer = this.clock.setTimeout(() => {
      this.#slowOpenTimer = null
      if (this.#state === 'opening') this.#setState('waking')
    }, after)
  }

  #clearSlowOpen(): void {
    if (this.#slowOpenTimer !== null) this.clock.clearTimeout(this.#slowOpenTimer)
    this.#slowOpenTimer = null
  }

  /** ESC i S; rejects with BUSY while printing, TIMEOUT without a reply. */
  async refreshStatus(): Promise<PrinterStatus> {
    const session = this.#session
    if (!session || !this.transport.isOpen) throw new NotConnectedError()
    if (this.#state === 'printing' || this.#state === 'cancelling' || this.#state === 'handshaking') throw new SessionFailedError({ code: 'BUSY', message: 'The printer is busy' }, 'status')
    const p = new Promise<PrinterStatus>((resolve, reject) => this.#statusWaiters.push({ resolve, reject }))
    if (this.#statusWaiters.length === 1) {
      try {
        session.requestStatus(this.clock.now())
      } catch (e) {
        this.#rejectStatusWaiters(e)
      }
      this.#pump()
    }
    return p
  }

  /**
   * Submit + pace pages; resolves on JobCompleted, rejects on failure (SessionFailedError with
   * code PRINTER / CANCELLED / TIMEOUT / PRINTER_OFF…, or LinkLostError; a partially sent job is
   * never retried). Preflight errors (MEDIA_MISMATCH, NO_MEDIA, BUSY…) are thrown by wasm as
   * PtouchError before anything is sent. Abort ⇒ cancel(). The job is borrowed, not freed.
   */
  async print(job: Job, signal?: AbortSignal): Promise<void> {
    const session = this.#session
    if (!session || !this.transport.isOpen) throw new NotConnectedError()
    if (this.#state !== 'ready') throw new SessionFailedError({ code: 'BUSY', message: 'The printer is busy' }, 'print')
    if (signal?.aborted) throw abortError()
    // Right after a job the session drains for a moment (post_job_drain_ms) and refuses
    // submit(); wait for that instead of reporting a busy printer.
    if (this.#sessionStage(session) === 'draining') {
      await new Promise<void>((resolve, reject) => this.#drained.push({ resolve, reject }))
      if (this.#session !== session || this.#state !== 'ready' || !this.transport.isOpen) throw new SessionFailedError({ code: 'BUSY', message: 'The printer is busy' }, 'print')
      if (signal?.aborted) throw abortError()
    }
    this.#stopKeepalive()
    try {
      session.submit(job, this.clock.now()) // throws PtouchError on preflight failure
    } catch (e) {
      // Nothing was sent: keep watching the idle printer.
      this.#startKeepalive()
      throw e
    }
    const of = job.pageCount
    const done = new Promise<void>((resolve, reject) => (this.#printing = { resolve, reject, of }))
    this.#note(`print ${of} page${of === 1 ? '' : 's'}, ${job.totalLines} lines`)
    this.#setState('printing')
    this.#emit({ type: 'progress', progress: { page: 1, of, phase: 'sending' } })
    const onAbort = () => void this.cancel()
    signal?.addEventListener('abort', onAbort, { once: true })
    this.#pump()
    try {
      await done
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Cancel a job (or the handshake): abortWrites → session.cancel (invalidate + ESC @) →
   * resolves once the printer is back to ready (or the link is gone). The pending print()
   * rejects with SessionFailedError code CANCELLED.
   */
  async cancel(): Promise<void> {
    const session = this.#session
    if (!session) return
    if (this.#state === 'opening' || this.#state === 'waking' || this.#state === 'handshaking') {
      this.#connectCtrl?.abort()
      return
    }
    if (this.#state !== 'printing') return
    this.#setState('cancelling')
    this.#note('cancel')
    this.#txGen++ // drop buffers queued behind the one being written
    await this.transport.abortWrites()
    this.#tx = Promise.resolve()
    const recovered = new Promise<void>((resolve, reject) => this.#recovered.push({ resolve, reject }))
    session.cancel(this.clock.now())
    this.#pump()
    await recovered.catch(() => {})
  }

  /** Stop timers, close the transport, free the session. Idempotent. A running job is
   * cancelled first (best effort, ≤ 1.5 s). */
  async disconnect(): Promise<void> {
    // Stop a connect() in flight (also a hanging open()): it rejects with AbortError.
    this.#connectCtrl?.abort()
    this.#clearSlowOpen()
    if (this.#state === 'printing') {
      await Promise.race([this.cancel(), new Promise<void>((r) => this.clock.setTimeout(r, 1500))])
    }
    this.#stopTimers()
    this.#txGen++
    this.#unsubscribe?.()
    this.#unsubscribe = null
    const err = abortError('Disconnected')
    this.#failPending(err)
    this.#session?.free()
    this.#session = null
    await this.#closeQuietly()
    this.#setState('disconnected')
  }

  on(listener: (e: PrinterEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  // ----- pump -------------------------------------------------------------------------------

  #onTransport(e: TransportEvent): void {
    if (e.type === 'data') {
      this.options.log?.push('<<', e.bytes)
      const session = this.#session
      if (!session) return
      session.handleInput(e.bytes, this.clock.now())
      this.#pump()
    } else {
      this.#onLost(e.error)
    }
  }

  #pump(): void {
    const session = this.#session
    if (!session) return
    for (let buf = session.pollTransmit(); buf; buf = session.pollTransmit()) this.#enqueueWrite(buf)
    for (let ev = session.pollEvent(); ev; ev = session.pollEvent()) this.#onEvent(ev)
    if (this.#drained.length && this.#session === session && this.#sessionStage(session) !== 'draining') for (const d of this.#drained.splice(0)) d.resolve()
    this.#arm()
  }

  #sessionStage(session: PrintSession): string | undefined {
    try {
      return session.state().state
    } catch {
      return undefined
    }
  }

  #arm(): void {
    if (this.#timer !== null) this.clock.clearTimeout(this.#timer)
    this.#timer = null
    const session = this.#session
    if (!session) return
    const deadline = session.pollTimeout()
    if (deadline === undefined) return
    this.#timer = this.clock.setTimeout(() => {
      this.#timer = null
      const s = this.#session
      if (!s) return
      s.handleTimeout(this.clock.now())
      this.#pump()
    }, Math.max(0, Math.ceil(deadline - this.clock.now())))
  }

  #enqueueWrite(buf: Uint8Array): void {
    const gen = this.#txGen
    this.#tx = this.#tx.then(async () => {
      if (gen !== this.#txGen || !this.transport.isOpen) return
      const max = this.options.logMaxBytes ?? 96
      this.options.log?.push('>>', buf.length > max ? buf.subarray(0, max) : buf)
      if (buf.length > max) this.options.log?.note(`(${buf.length} bytes written)`)
      try {
        await this.transport.write(buf)
      } catch (e) {
        if (isDomError(e, 'AbortError') || gen !== this.#txGen) return
        this.#onLost(e)
      }
    })
  }

  #onEvent(ev: SessionEvent): void {
    switch (ev.type) {
      case 'status': {
        this.#status = ev.status
        this.#emit({ type: 'status', status: ev.status })
        const waiters = this.#statusWaiters.splice(0)
        for (const w of waiters) w.resolve(ev.status)
        break
      }
      case 'ready': {
        this.#status = ev.status
        if (this.#connecting) {
          const c = this.#connecting
          this.#connecting = null
          this.#note(`ready: ${ev.status.modelName ?? 'printer'}, ${ev.status.mediaWidthMm} mm ${ev.status.mediaType}`)
          this.#setState('ready')
          this.#startKeepalive()
          c.resolve(ev.status)
        } else {
          // Back to ready after recovery (printer error) or cancel.
          this.#setState('ready')
          this.#startKeepalive()
          for (const r of this.#recovered.splice(0)) r.resolve()
        }
        break
      }
      case 'page-started': {
        const run = this.#printing
        if (run) this.#emit({ type: 'progress', progress: { page: ev.page, of: run.of, phase: 'printing' } })
        break
      }
      case 'page-completed': {
        const run = this.#printing
        if (run && ev.page < run.of) this.#emit({ type: 'progress', progress: { page: ev.page + 1, of: run.of, phase: 'sending' } })
        break
      }
      case 'job-completed': {
        const run = this.#printing
        this.#printing = null
        if (run) {
          this.#emit({ type: 'progress', progress: { page: run.of, of: run.of, phase: 'done' } })
          this.#note('job completed')
          this.#setState('ready')
          this.#startKeepalive()
          run.resolve()
        }
        break
      }
      case 'notification':
        this.#emit({ type: 'notification', notification: ev.notification })
        break
      case 'failed':
        this.#onFailed(ev.error, ev.resumeFromPage)
        break
    }
  }

  #onFailed(info: { code: string; message: string; printerErrors: { id: string; message: string }[] }, resumeFromPage?: number): void {
    this.#note(`failed: ${info.code} ${info.message}`)
    if (this.#connecting) {
      const c = this.#connecting
      this.#connecting = null
      c.reject(new SessionFailedError(info, 'handshake'))
      return
    }
    if (this.#printing) {
      const run = this.#printing
      this.#printing = null
      const err = new SessionFailedError(info, 'print', resumeFromPage)
      // The session now recovers (cancel sequence + status polls) and emits `ready` again;
      // PRINTER_OFF / exhausted recovery leaves it failed.
      if (info.code === 'PRINTER_OFF') this.#setState('lost')
      else if (info.code !== 'CANCELLED') this.#setState('error')
      run.reject(err)
      if (this.#sessionFailed()) this.#onSessionDead()
      return
    }
    if (this.#statusWaiters.length > 0) {
      this.#rejectStatusWaiters(new SessionFailedError(info, 'status'))
      if (info.code === 'TIMEOUT') this.#setState('no-reply')
      return
    }
    // Unsolicited (recovery failed, printer turned off while idle…).
    const err = new SessionFailedError(info, 'idle')
    for (const r of this.#recovered.splice(0)) r.reject(err)
    if (info.code === 'PRINTER_OFF') this.#setState('lost')
    else if (info.code === 'TIMEOUT') this.#setState('no-reply')
    else this.#setState('error')
    this.#emit({ type: 'error', error: err, stage: 'idle' })
    if (this.#sessionFailed()) this.#onSessionDead()
  }

  #sessionFailed(): boolean {
    try {
      return this.#session?.state().state === 'failed'
    } catch {
      return false
    }
  }

  /** The session needs a new connect(): stop timers and close so Reconnect starts clean. */
  #onSessionDead(): void {
    this.#stopTimers()
    for (const r of this.#recovered.splice(0)) r.resolve()
    void this.#closeQuietly()
  }

  #onLost(error: unknown): void {
    if (this.#state === 'disconnected' || this.#state === 'lost') return
    const stage: ErrorStage = this.#connecting ? 'handshake' : this.#printing ? 'print' : this.#statusWaiters.length ? 'status' : 'idle'
    const lost = error instanceof LinkLostError ? error : new LinkLostError(undefined, { cause: error })
    this.#note(`link lost: ${lost.message}`)
    this.#stopTimers()
    this.#txGen++
    const hadPending = this.#failPending(lost)
    this.#setState('lost')
    if (!hadPending) this.#emit({ type: 'error', error: lost, stage })
    void this.#closeQuietly()
  }

  /** Rejects every pending operation; returns true if there was one. */
  #failPending(err: unknown): boolean {
    let any = false
    if (this.#connecting) {
      this.#connecting.reject(err)
      this.#connecting = null
      any = true
    }
    if (this.#printing) {
      this.#printing.reject(err)
      this.#printing = null
      any = true
    }
    if (this.#statusWaiters.length) {
      this.#rejectStatusWaiters(err)
      any = true
    }
    for (const r of this.#recovered.splice(0)) r.resolve()
    for (const d of this.#drained.splice(0)) d.resolve()
    return any
  }

  #rejectStatusWaiters(err: unknown): void {
    for (const w of this.#statusWaiters.splice(0)) w.reject(err)
  }

  // ----- keepalive ----------------------------------------------------------------------------

  #startKeepalive(): void {
    this.#stopKeepalive()
    const every = this.options.keepaliveMs ?? 60_000
    if (every <= 0) return
    this.#keepalive = this.clock.setTimeout(() => {
      this.#keepalive = null
      // Never send anything while a page prints; only when idle and the tab is visible.
      if (this.#state !== 'ready' || !this.transport.isOpen) return
      if (!isVisible()) return this.#startKeepalive()
      this.refreshStatus().then(
        () => this.#startKeepalive(),
        (e) => {
          if (e instanceof SessionFailedError && e.code === 'TIMEOUT') {
            this.#emit({ type: 'error', error: e, stage: 'idle' })
          } else if (e instanceof SessionFailedError && e.code === 'BUSY') {
            this.#startKeepalive()
          }
        },
      )
    }, every)
  }

  #stopKeepalive(): void {
    if (this.#keepalive !== null) this.clock.clearTimeout(this.#keepalive)
    this.#keepalive = null
  }

  #stopTimers(): void {
    this.#stopKeepalive()
    if (this.#timer !== null) this.clock.clearTimeout(this.#timer)
    this.#timer = null
  }

  // ----- helpers ------------------------------------------------------------------------------

  /** Closes the transport, ignoring errors. Tracked so a following connect() waits for it. */
  #closeQuietly(): Promise<void> {
    const p: Promise<void> = this.transport
      .close()
      .catch(() => {})
      .finally(() => {
        if (this.#closing === p) this.#closing = null
      })
    this.#closing = p
    return p
  }

  #note(text: string): void {
    this.options.log?.note(text)
  }

  #setState(state: ClientState): void {
    if (this.#state === state) return
    this.#state = state
    this.#emit({ type: 'state', state })
  }

  #emit(e: PrinterEvent): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn(e)
      } catch (err) {
        console.error('printer listener failed', err)
      }
    }
  }
}

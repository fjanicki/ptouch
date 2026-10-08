// W2 — ConnectionManager: the connect flow for every browser (ARCHITECTURE.md §3.3) and the
// single object the UI talks to. Owns the current Transport + PrinterClient, turns raw errors
// into Problems, exposes an immutable snapshot for Svelte.
//
// Flow:
//   on load        restore(): remembered path → WebSerialTransport.fromGranted / WebUsbTransport.fromGranted
//   "Bluetooth"    Gecko → requestAnyPort(); Chromium → requestBluetooth() (SPP filter);
//                  NotFoundError → offer "Choose port…"; TypeError (pre-117) → retry unfiltered
//   "Choose port"  requestAnyPort() (unfiltered; offered next to Bluetooth, verified needed)
//   "USB"          WebUsbTransport.request()
//   "Virtual"      MockTransport(scenario)
// The requestPort()/requestDevice() call MUST happen synchronously inside the click handler:
// UI calls `manager.connect(path)` directly from onclick without awaiting anything first.
// connect() issues the chooser call before its first `await`.
import { mediaForStatus, type Job, type MediaInfo, type NotificationKind, type PrinterStatus } from '../wasm'
import { PrinterClient, type ClientState, type PrintProgress, type PrinterClientOptions, type PrinterEvent } from './client'
import { LinkLostError, NotConnectedError, SessionFailedError, type ErrorStage } from './errors'
import { MockTransport, type MockScenario } from './mock'
import { PacketLog } from './packetlog'
import { describeProblem, describeStatus, isBusyError, isUserCancel, type Problem } from './problems'
import type { ConnectPath, SupportInfo } from './support'
import type { OpenProgress, Transport, TransportInfo } from './transport'
import { WebSerialTransport, type SerialLike, type WebSerialOptions } from './webserial'
import { WebUsbTransport, type UsbLike } from './webusb'

export interface ConnectionSnapshot {
  path: ConnectPath | null
  state: ClientState
  transport: TransportInfo | null
  /** Model name once known. */
  model: string | null
  status: PrinterStatus | null
  /** Media resolved from the last status (mediaForStatus). */
  media: MediaInfo | null
  /** Set while open() is retrying ("Waking printer… attempt 2 of 3"). */
  openProgress: OpenProgress | null
  progress: PrintProgress | null
  problem: Problem | null
  /** Last notification pushed by the printer (cover open, cooling…), cleared when resolved. */
  notification?: NotificationKind | null
}

export interface RememberedConnection {
  path: ConnectPath
  transport?: Pick<TransportInfo, 'kind' | 'label' | 'bluetoothServiceClassId'>
}

export interface ConnectionManagerOptions {
  support: SupportInfo
  /** Persist the last successful connection (W5 prefs); null = forget (deliberate disconnect). */
  remember?: (c: RememberedConnection | null) => void
  /** Recall the remembered connection for restore(). Return null when auto-reconnect is off. */
  recall?: () => RememberedConnection | null
  /** Scenario for the 'virtual' path. */
  virtualScenario?: Partial<MockScenario>
  /** Injected APIs (tests / e2e); default navigator.serial / navigator.usb. */
  serial?: SerialLike
  usb?: UsbLike
  /** Extra PrinterClient options (clock, session timing, keepalive). */
  client?: Omit<PrinterClientOptions, 'log'>
  /** Extra Web Serial options (tuning, retry policy). */
  serialOptions?: Partial<WebSerialOptions>
  /** Tape width of the label being designed (mm), so wrong-tape messages name both widths. */
  designWidthMm?: () => number | undefined
}

export const INITIAL_SNAPSHOT: ConnectionSnapshot = {
  path: null,
  state: 'disconnected',
  transport: null,
  model: null,
  status: null,
  media: null,
  openProgress: null,
  progress: null,
  problem: null,
  notification: null,
}

function designWidth(get: (() => number | undefined) | undefined): { designWidthMm?: number } {
  const w = get?.()
  return w === undefined ? {} : { designWidthMm: w }
}

/** Problem ids derived from status frames (cleared automatically when the status is clean). */
const STATUS_PROBLEMS = new Set(['cover-open', 'no-media', 'cutter-jam', 'overheating', 'weak-battery', 'printer-error', 'wrong-media'])

export class ConnectionManager {
  readonly packetLog = new PacketLog()
  readonly options: ConnectionManagerOptions
  #snapshot: ConnectionSnapshot = INITIAL_SNAPSHOT
  #listeners = new Set<(s: ConnectionSnapshot) => void>()
  #client: PrinterClient | null = null
  #transport: Transport | null = null
  #offClient: (() => void) | null = null
  /** Incremented per connect attempt; stale attempts don't touch the snapshot. */
  #attempt = 0
  /** Aborts the current attempt's client.connect() (a newer attempt, cancelConnect, disconnect). */
  #attemptCtrl: AbortController | null = null
  /** Client/transport teardowns, chained so a new attempt never overlaps an old close. */
  #settling: Promise<void> = Promise.resolve()
  #statusProblem = false

  constructor(options: ConnectionManagerOptions) {
    this.options = options
  }

  get snapshot(): ConnectionSnapshot {
    return this.#snapshot
  }

  /** The live client (diagnostics: refresh status); null when disconnected. */
  get client(): PrinterClient | null {
    return this.#client
  }

  /** The current transport (diagnostics); null when none was chosen yet. */
  get transport(): Transport | null {
    return this.#transport
  }

  subscribe(fn: (s: ConnectionSnapshot) => void): () => void {
    this.#listeners.add(fn)
    fn(this.#snapshot)
    return () => this.#listeners.delete(fn)
  }

  /**
   * Call synchronously from a click handler (user gesture): the chooser opens before the first
   * await. Resolves when connected, cancelled or failed; failures end up in `snapshot.problem`
   * (never rejects).
   */
  async connect(path: ConnectPath): Promise<void> {
    const attempt = this.#begin()
    let request: Promise<Transport>
    try {
      request = this.#request(path) // synchronous chooser call happens in here
    } catch (e) {
      request = Promise.reject(e)
    }
    const previous = { state: this.#snapshot.state, path: this.#snapshot.path, transport: this.#snapshot.transport }
    this.#update({ problem: null })
    let transport: Transport
    try {
      transport = await request
    } catch (e) {
      if (attempt !== this.#attempt) return
      if (isUserCancel(e)) {
        // Chooser dismissed: keep the current connection untouched; after a Bluetooth chooser,
        // hint at "Choose port…" (the printer may only appear unfiltered).
        const p = describeProblem(e, { support: this.options.support, stage: 'open', path })
        this.#update({ problem: p.actions.includes('choose-port') ? p : null })
        return
      }
      this.#update({ ...previous, problem: describeProblem(e, { support: this.options.support, stage: 'open', path }) })
      return
    }
    if (attempt !== this.#attempt) return
    await this.#teardown()
    if (attempt !== this.#attempt) return
    await this.#attach(transport, path, attempt, false)
  }

  /**
   * Auto-reconnect to a remembered grant without prompting (getPorts()/getDevices()). Resolves
   * false if there is nothing to restore; true once an attempt was made (its outcome is in the
   * snapshot). A failed auto-reconnect shows a gentle, non-blocking problem.
   */
  async restore(): Promise<boolean> {
    const remembered = this.options.recall?.() ?? null
    if (!remembered || !this.options.support.paths.includes(remembered.path)) return false
    if (this.#client && this.#snapshot.state !== 'disconnected') return true
    const attempt = this.#begin()
    let transport: Transport | null = null
    try {
      transport = await this.#granted(remembered)
    } catch {
      transport = null
    }
    if (!transport || attempt !== this.#attempt) return false
    await this.#teardown()
    if (attempt !== this.#attempt) return true
    await this.#attach(transport, remembered.path, attempt, true)
    return true
  }

  /** Re-open the current/remembered grant (after 'lost' / 'no-reply'); no prompt. */
  async reconnect(): Promise<void> {
    const transport = this.#transport
    const path = this.#snapshot.path
    if (transport && path) {
      // A reconnect already running for this link (double-click): let it finish.
      if (this.#attemptCtrl && this.#transport === transport && this.#isConnecting()) return
      const attempt = this.#begin()
      await this.#detachClient()
      if (attempt !== this.#attempt) return
      await this.#attach(transport, path, attempt, false)
      return
    }
    const restored = await this.restore()
    if (!restored) {
      this.#update({
        problem: {
          id: 'link-lost',
          severity: 'info',
          title: 'Choose your printer',
          detail: 'There is no remembered printer to reconnect to. Connect one to continue.',
          actions: this.options.support.paths.includes('bluetooth') ? ['connect-bluetooth', 'dismiss'] : ['dismiss'],
        },
      })
    }
  }

  /** Ask the printer for a fresh status (no-op without a connection). */
  async refreshStatus(): Promise<void> {
    const client = this.#client
    if (!client) return
    try {
      await client.refreshStatus()
    } catch (e) {
      // BUSY from the client (printing) or from the session (recovering after a failure).
      if (isBusyError(e)) return
      this.#update({ problem: this.#problem(e, 'status') })
    }
  }

  /**
   * Print an encoded job on the connected printer. Progress/problems go to the snapshot.
   * Resolves on success; rejects with the underlying error otherwise (use `isUserCancel(e)`
   * to ignore a deliberate cancel). The job is borrowed: the caller frees it.
   */
  async print(job: Job, signal?: AbortSignal): Promise<void> {
    const client = this.#client
    if (!client) {
      const e = new NotConnectedError()
      this.#update({ problem: this.#problem(e, 'print') })
      throw e
    }
    this.#update({ problem: null, progress: { page: 1, of: job.pageCount, phase: 'sending' } })
    try {
      await client.print(job, signal)
    } catch (e) {
      const cancelled = isUserCancel(e)
      this.#update({ progress: null, problem: cancelled ? null : this.#problem(e, 'print') })
      throw e
    }
  }

  /** Cancel the running job (or a connect attempt, see cancelConnect). */
  async cancel(): Promise<void> {
    if (this.#isConnecting()) return this.cancelConnect()
    await this.#client?.cancel()
  }

  /** `true` while opening / waking / handshaking. */
  #isConnecting(): boolean {
    const s = this.#snapshot.state
    return s === 'opening' || s === 'waking' || s === 'handshaking'
  }

  /**
   * Abandon the connect attempt in flight (also a hanging open() or a silent handshake). The
   * remembered printer is kept; the snapshot returns to disconnected without a problem.
   */
  async cancelConnect(): Promise<void> {
    if (!this.#isConnecting()) return
    this.#begin()
    this.packetLog.note('connect cancelled')
    await this.#teardown()
    this.#update({ ...INITIAL_SNAPSHOT })
  }

  /** Close the link. `forget` also revokes the grant; a deliberate disconnect clears auto-reconnect. */
  async disconnect(opts: { forget?: boolean } = {}): Promise<void> {
    this.#begin()
    const transport = this.#transport
    await this.#teardown()
    if (opts.forget && transport instanceof WebSerialTransport) {
      try {
        await transport.forget()
      } catch {
        /* older browsers */
      }
    }
    this.options.remember?.(null)
    this.#update({ ...INITIAL_SNAPSHOT })
  }

  dismissProblem(): void {
    this.#statusProblem = false
    this.#update({ problem: null })
  }

  // ----- internals ----------------------------------------------------------------------------

  /** Starts the chooser for `path`. Must not await before calling requestPort/requestDevice. */
  #request(path: ConnectPath): Promise<Transport> {
    const { support } = this.options
    const gecko = support.engine === 'gecko'
    switch (path) {
      case 'bluetooth':
        return gecko || !support.bluetoothFilter
          ? WebSerialTransport.requestAnyPort(this.options.serial, this.options.serialOptions, gecko)
          : WebSerialTransport.requestBluetooth(this.options.serial, this.options.serialOptions, gecko)
      case 'serial-port':
        return WebSerialTransport.requestAnyPort(this.options.serial, this.options.serialOptions, gecko)
      case 'usb':
        return WebUsbTransport.request(this.options.usb)
      case 'virtual':
        return Promise.resolve(new MockTransport(this.options.virtualScenario ?? {}, this.options.client?.clock))
    }
  }

  async #granted(r: RememberedConnection): Promise<Transport | null> {
    const gecko = this.options.support.engine === 'gecko'
    switch (r.path) {
      case 'bluetooth':
      case 'serial-port': {
        const match: Partial<TransportInfo> = r.transport?.kind ? { kind: r.transport.kind } : r.path === 'bluetooth' && !gecko ? { kind: 'serial-rfcomm' } : {}
        if (r.transport?.bluetoothServiceClassId) match.bluetoothServiceClassId = r.transport.bluetoothServiceClassId
        return WebSerialTransport.fromGranted(match, this.options.serial, this.options.serialOptions, gecko)
      }
      case 'usb':
        return WebUsbTransport.fromGranted(this.options.usb)
      case 'virtual':
        return new MockTransport(this.options.virtualScenario ?? {}, this.options.client?.clock)
    }
  }

  /** Starts a new attempt: invalidates and aborts the previous one. */
  #begin(): number {
    this.#attemptCtrl?.abort()
    this.#attemptCtrl = new AbortController()
    return ++this.#attempt
  }

  async #attach(transport: Transport, path: ConnectPath, attempt: number, gentle: boolean): Promise<void> {
    const signal = this.#attemptCtrl?.signal
    this.#transport = transport
    const clientOptions: PrinterClientOptions = { ...this.options.client, log: this.packetLog }
    // Firefox's OS port on macOS goes silent after first use: give up sooner than the core's
    // 3 × 5 s so the "use Chrome / re-pair" guidance shows up in ~6 s, not 15 s.
    if (!clientOptions.session && transport.info.kind === 'serial-os-port' && this.options.support.engine === 'gecko') clientOptions.session = { statusTimeoutMs: 3000, statusAttempts: 2 }
    const client = new PrinterClient(transport, clientOptions)
    this.#client = client
    this.#statusProblem = false
    this.#offClient = client.on((e) => {
      if (this.#client === client) this.#onClientEvent(e, client)
    })
    this.#update({ path, transport: transport.info, state: 'opening', openProgress: null, progress: null, problem: null, status: null, media: null, model: null, notification: null })
    try {
      const status = await client.connect(signal)
      if (attempt !== this.#attempt || this.#client !== client) return
      this.options.remember?.({ path, transport: { kind: transport.info.kind, label: transport.info.label, ...(transport.info.bluetoothServiceClassId ? { bluetoothServiceClassId: transport.info.bluetoothServiceClassId } : {}) } })
      this.#applyStatus(status, client)
      this.#update({ openProgress: null })
    } catch (e) {
      if (attempt !== this.#attempt || this.#client !== client) return
      const stage: ErrorStage = e instanceof SessionFailedError ? e.stage : e instanceof LinkLostError ? 'handshake' : 'open'
      if (isUserCancel(e)) {
        this.#update({ openProgress: null, problem: null })
        return
      }
      const problem = this.#problem(e, stage)
      this.#update({ openProgress: null, problem: gentle ? { ...problem, severity: 'info' } : problem })
    }
  }

  #onClientEvent(e: PrinterEvent, client: PrinterClient): void {
    switch (e.type) {
      case 'state':
        this.#update({ state: e.state, ...(e.state === 'ready' || e.state === 'disconnected' ? { openProgress: null } : {}), ...(e.state === 'ready' && this.#snapshot.progress?.phase !== 'done' ? { progress: null } : {}) })
        break
      case 'open-progress':
        this.#update({ openProgress: e.progress })
        break
      case 'status':
        this.#applyStatus(e.status, client)
        break
      case 'progress':
        this.#update({ progress: e.progress })
        break
      case 'notification':
        this.#onNotification(e.notification)
        break
      case 'error':
        this.#update({ problem: this.#problem(e.error, e.stage) })
        break
    }
  }

  #onNotification(n: NotificationKind): void {
    switch (n) {
      case 'cover-open':
        this.#statusProblem = true
        this.#update({ notification: n, problem: this.#problem(new SessionFailedError({ code: 'PRINTER', message: 'cover open', printerErrors: [{ id: 'cover-open', message: 'cover open' }] }, 'status'), 'status') })
        break
      case 'cooling-started':
        this.#statusProblem = true
        this.#update({ notification: n, problem: { id: 'overheating', severity: 'info', title: 'Cooling down', detail: 'The print head is hot. Printing continues automatically in a moment.', actions: ['dismiss'] } })
        break
      case 'cover-closed':
      case 'cooling-finished':
        this.#update({ notification: null, ...(this.#statusProblem ? { problem: null } : {}) })
        this.#statusProblem = false
        break
      default:
        this.#update({ notification: n })
    }
  }

  #applyStatus(status: PrinterStatus, client: PrinterClient): void {
    const model = client.modelName ?? status.modelName ?? null
    let media: MediaInfo | null = this.#snapshot.media
    if (model && status.mediaWidthMm > 0) {
      try {
        media = mediaForStatus(model, status.mediaWidthMm, status.mediaTypeByte)
      } catch {
        media = null
      }
    } else if (status.mediaWidthMm === 0) media = null
    const patch: Partial<ConnectionSnapshot> = { status, model, media }
    // Status-derived problems (cover open, no tape…) appear while idle and clear themselves.
    if (client.state !== 'printing' && client.state !== 'cancelling') {
      const p = describeStatus(status, { support: this.options.support, ...(this.#transport ? { transport: this.#transport.info } : {}) })
      if (p) {
        patch.problem = p
        this.#statusProblem = true
      } else if (this.#statusProblem && this.#snapshot.problem && STATUS_PROBLEMS.has(this.#snapshot.problem.id)) {
        patch.problem = null
        this.#statusProblem = false
      }
    }
    this.#update(patch)
  }

  #problem(e: unknown, stage: ErrorStage): Problem {
    return describeProblem(e, {
      support: this.options.support,
      stage,
      ...(this.#transport ? { transport: this.#transport.info } : {}),
      ...(this.#snapshot.path ? { path: this.#snapshot.path } : {}),
      status: this.#snapshot.status,
      ...designWidth(this.options.designWidthMm),
    })
  }

  /** Disconnects the current client. Chained after earlier teardowns, so a following attach
   * never opens the port while an old client is still closing it. */
  #detachClient(): Promise<void> {
    this.#offClient?.()
    this.#offClient = null
    const client = this.#client
    this.#client = null
    return this.#chain(async () => {
      if (client) await client.disconnect()
    })
  }

  #teardown(): Promise<void> {
    const transport = this.#transport
    this.#transport = null
    const detached = this.#detachClient()
    return this.#chain(async () => {
      await detached
      if (!transport) return
      try {
        if (transport instanceof MockTransport) await transport.dispose()
        else await transport.close()
      } catch {
        /* ignore */
      }
    })
  }

  #chain(step: () => Promise<void>): Promise<void> {
    const next = this.#settling.then(step, step)
    this.#settling = next.catch(() => {})
    return next
  }

  /** Every update creates a new snapshot object (never mutated afterwards). Not frozen: the UI
   * keeps it in Svelte `$state`, whose deep proxies break on frozen nested objects. */
  #update(patch: Partial<ConnectionSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch }
    for (const fn of [...this.#listeners]) fn(this.#snapshot)
  }
}

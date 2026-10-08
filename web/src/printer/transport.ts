// W2 — transport contract (frozen interface; ARCHITECTURE.md §4.3).
// Transports are DUMB BYTE PIPES: all protocol decisions live in the wasm PrintSession.
// PrinterClient (client.ts) is the only place bytes meet the session.

export type TransportKind = 'serial-rfcomm' | 'serial-os-port' | 'usb' | 'virtual'

export interface TransportInfo {
  kind: TransportKind
  /** Display label: "PT-P710BTxxxx", "cu.PT-P710BTxxxx", "USB 04f9:20af", "Virtual PT-P710BT". */
  label: string
  /** false for macOS cu.* ports in Chrome (session-only grant). */
  persistentGrant: boolean
  usbVendorId?: number
  usbProductId?: number
  /** Present ⇒ Chromium direct RFCOMM entry (getInfo().bluetoothServiceClassId). */
  bluetoothServiceClassId?: string
}

export type TransportEvent =
  | { type: 'data'; bytes: Uint8Array }
  /** Read/write failure, port.readable === null, disconnect event, USB disconnect. */
  | { type: 'lost'; error: unknown }

/** Progress while opening (Web Serial retries open() on NetworkError: "waking printer…"). */
export interface OpenProgress {
  attempt: number
  of: number
  /** The error that triggered this retry, if any. */
  lastError?: unknown
}

export interface OpenOptions {
  signal?: AbortSignal
  onProgress?: (p: OpenProgress) => void
}

export interface Transport {
  readonly info: TransportInfo
  readonly isOpen: boolean
  open(opts?: OpenOptions): Promise<void>
  /** Resolves when the platform has ACCEPTED the bytes (backpressure), not when the printer got them. */
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>
  /** Discard queued, not-yet-accepted bytes (cancel). No-op where unsupported. */
  abortWrites(): Promise<void>
  close(): Promise<void>
  /** Single long-lived read pump; never a per-call read raced against a timer. */
  subscribe(listener: (e: TransportEvent) => void): () => void
}

export interface WriteTuning {
  /** Bytes per write() call. */
  chunkSize: number
  /** Pause between chunks (0 = only backpressure). */
  interChunkDelayMs: number
}

/**
 * Defaults. PT-P710BT RFCOMM MTU is 320 bytes (verified 2026-10-08); Chrome re-chunks the data
 * pipe itself, so modest writes (512 B ≈ 1.6 MTU) keep backpressure meaningful without
 * per-byte overhead. (An "unreliable link" preset can be added with a UI that uses it.)
 */
export const WRITE_TUNING: Record<'serial' | 'usb', WriteTuning> = {
  serial: { chunkSize: 512, interChunkDelayMs: 0 },
  usb: { chunkSize: 16384, interChunkDelayMs: 0 },
}

/** Injectable clock so MockTransport/PrinterClient tests can use fake time. */
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
}

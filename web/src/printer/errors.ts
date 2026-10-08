// W2 — error types of the printer layer. Raw errors (DOMException from Web Serial/WebUSB,
// PtouchError thrown by wasm) pass through unchanged; these classes add the cases the platform
// does not name. problems.ts turns every one of them into a user-facing Problem.
import type { PrinterErrorInfo } from '../wasm'

/** Where in the lifecycle an error happened (shared with problems.ts / PrinterEvent). */
export type ErrorStage = 'open' | 'handshake' | 'status' | 'print' | 'idle'

/** The link dropped: read/write failure, `readable === null`, disconnect event, USB unplug. */
export class LinkLostError extends Error {
  override readonly name = 'LinkLostError'
  constructor(message = 'The connection to the printer was lost', options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** `open()` failed after every retry (cause = the last platform error). */
export class OpenFailedError extends Error {
  override readonly name = 'OpenFailedError'
  readonly attempts: number
  constructor(attempts: number, cause: unknown) {
    super(`Could not open the port after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${errorText(cause)}`, { cause })
    this.attempts = attempts
  }
}

/**
 * A failure reported by the wasm `PrintSession` (`failed` event): handshake timeout, printer
 * error during a job, cancel, printer turned off… `code` is a `PtouchErrorCode`.
 */
export class SessionFailedError extends Error {
  override readonly name = 'SessionFailedError'
  readonly code: string
  readonly printerErrors: PrinterErrorInfo[]
  /** 1-based page to resume from (job failures only). */
  readonly resumeFromPage?: number
  readonly stage: ErrorStage
  constructor(info: { code: string; message: string; printerErrors?: PrinterErrorInfo[] }, stage: ErrorStage, resumeFromPage?: number) {
    super(info.message || info.code)
    this.code = info.code
    this.printerErrors = info.printerErrors ?? []
    this.stage = stage
    if (resumeFromPage !== undefined) this.resumeFromPage = resumeFromPage
  }
}

/**
 * The chosen port is a Bluetooth service other than SPP — on the PT-P710BT, Apple's
 * "Wireless iAP" (RFCOMM channel 2, UUID 00000000-deca-fade-deca-deafdecacaff), which Chrome
 * lists next to the SPP entry. It never answers the raster protocol.
 */
export class WrongPortError extends Error {
  override readonly name = 'WrongPortError'
  readonly serviceClassId: string
  constructor(serviceClassId: string) {
    super(`Not the printer's serial (SPP) service: ${serviceClassId}`)
    this.serviceClassId = serviceClassId
  }
}

/** Operation needs a connected, idle printer. */
export class NotConnectedError extends Error {
  override readonly name = 'NotConnectedError'
  constructor(message = 'No printer is connected') {
    super(message)
  }
}

/** `true` if `e` is a DOMException (or DOMException-like, e.g. from a fake) named `name`. */
export function isDomError(e: unknown, name: string): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === name && (e instanceof DOMException || e instanceof Error)
}

export function abortError(message = 'The operation was aborted'): DOMException {
  return new DOMException(message, 'AbortError')
}

export function errorText(e: unknown): string {
  if (e instanceof Error || (typeof e === 'object' && e !== null && 'message' in e)) {
    const { name, message } = e as { name?: string; message?: string }
    return name && name !== 'Error' ? `${name}: ${message ?? ''}` : String(message ?? '')
  }
  return String(e)
}

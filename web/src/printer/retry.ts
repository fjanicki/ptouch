// W2 — open() retry shared by WebSerialTransport and MockTransport.
//
// Verified on the user's Mac (Chrome 154, 2026-10-08): the direct-RFCOMM entry's first open()
// failed after 10 s with NetworkError "Failed to open serial port"; an immediate retry opened
// in 378 ms. So open() is retried on NetworkError with a short backoff, and every attempt is
// reported so the UI can show "Waking printer… (attempt 2 of 3)".
import { OpenFailedError, abortError, isDomError } from './errors'
import type { Clock, OpenOptions } from './transport'

export interface OpenRetryPolicy {
  /** Total open() attempts (default 3 = 2 retries). */
  attempts: number
  /** Delay before retry n (default [300, 1000]); the last value repeats. */
  backoffMs: number[]
  /** Which errors are retried (default: DOMException NetworkError). */
  retryOn(error: unknown): boolean
}

export const DEFAULT_OPEN_RETRY: OpenRetryPolicy = {
  attempts: 3,
  backoffMs: [300, 1000],
  retryOn: (e) => isDomError(e, 'NetworkError'),
}

export function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const onAbort = () => {
      clock.clearTimeout(handle)
      reject(abortError())
    }
    const handle = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Runs `attempt()` until it succeeds, a non-retryable error occurs, or the policy is
 * exhausted. Reports `{attempt, of}` before every attempt (`lastError` from attempt 2 on).
 * Non-retryable errors are rethrown unchanged (e.g. InvalidStateError, SecurityError);
 * exhaustion throws {@link OpenFailedError} with the last error as `cause`.
 */
export async function openWithRetry(attempt: (n: number) => Promise<void>, policy: OpenRetryPolicy, opts: OpenOptions, clock: Clock): Promise<void> {
  const of = Math.max(1, policy.attempts)
  let lastError: unknown
  for (let n = 1; n <= of; n++) {
    if (opts.signal?.aborted) throw abortError()
    opts.onProgress?.(n === 1 ? { attempt: n, of } : { attempt: n, of, lastError })
    try {
      await attempt(n)
      return
    } catch (e) {
      lastError = e
      if (!policy.retryOn(e)) throw e
      if (n < of) {
        const delay = policy.backoffMs[Math.min(n - 1, policy.backoffMs.length - 1)] ?? 0
        await sleep(clock, delay, opts.signal)
      }
    }
  }
  throw new OpenFailedError(of, lastError)
}

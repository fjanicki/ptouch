// W5 — raw link probe for the Diagnostics page (ARCHITECTURE.md §11 Phase 0): open a transport
// by each path WITHOUT a session, send `genericHandshake() + statusRequest()`, time the reply,
// close; repeat `cycles` times (open/close stress). Uses W2 transports directly; the caller must
// make sure the studio connection is closed (the port can only be opened once). Replies are
// framed by the core's StatusFramer (wasm): no status framing rules or magic bytes live here.
import { toHex, type OpenProgress, type PacketLog, type Transport, type TransportEvent } from '../../printer'
import { StatusFramer, genericHandshake, release, statusRequest, type PrinterStatus } from '../../wasm'

export interface ProbeStep {
  label: string
  ok: boolean
  ms: number
  detail?: string
}

export interface ProbeResult {
  steps: ProbeStep[]
  /** Raw 32-byte reply of the first successful cycle, if any. */
  reply?: Uint8Array
  /** Cycles that got a status reply. */
  replies: number
  cycles: number
}

export interface ProbeOptions {
  /** Packet log to record traffic and notes into (the studio's). */
  log?: PacketLog
  /** Status reply timeout per cycle (default 5000 ms). */
  replyTimeoutMs?: number
  /** Pause between cycles (default 400 ms). */
  pauseMs?: number
  /** Live updates for the UI. */
  onStep?: (step: ProbeStep, all: readonly ProbeStep[]) => void
  onOpenProgress?: (p: OpenProgress) => void
  now?: () => number
}

/** First complete status frame in `buf` (core framing: resync, truncated frames dropped). */
export function findStatusFrame(buf: Uint8Array): Uint8Array | undefined {
  const framer = new StatusFramer()
  try {
    framer.push(buf)
    const s = framer.nextFrame()
    return s ? Uint8Array.from(s.raw) : undefined
  } finally {
    release(framer)
  }
}

function describeError(e: unknown): string {
  if (e instanceof DOMException) return `${e.name}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}

function summarize(s: PrinterStatus): string {
  const parts = [s.modelName ?? `model ${s.seriesCode.toString(16)}/${s.modelCode.toString(16)}`, `${s.mediaWidthMm} mm ${s.mediaType}`]
  parts.push(s.ready ? 'ready' : s.errors.length ? s.errors.map((e) => e.id).join(', ') : 'not ready')
  return parts.join(' · ')
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true })
  })

/** Waits for a status frame (or 'lost' / timeout / abort) from an already-subscribed framer. */
function waitForFrame(framer: StatusFramer, received: () => number, events: EventTarget, timeoutMs: number, signal?: AbortSignal): Promise<PrinterStatus> {
  return new Promise((resolve, reject) => {
    const done = (fn: () => void): void => {
      clearTimeout(timer)
      events.removeEventListener('data', onData)
      events.removeEventListener('lost', onLost)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onData = (): void => {
      const f = framer.nextFrame()
      if (f) done(() => resolve(f))
    }
    const onLost = (): void => done(() => reject(new Error('link lost while waiting for the reply')))
    const onAbort = (): void => done(() => reject(signal?.reason ?? new DOMException('aborted', 'AbortError')))
    const timer = setTimeout(() => done(() => reject(new Error(`no reply within ${timeoutMs} ms (${received()} bytes received)`))), timeoutMs)
    events.addEventListener('data', onData)
    events.addEventListener('lost', onLost)
    signal?.addEventListener('abort', onAbort, { once: true })
    onData()
  })
}

/** open (with retry progress) → write handshake → wait ≤ 5 s for 32 bytes → close; repeat `cycles`. */
export async function probeTransport(transport: Transport, cycles = 1, signal?: AbortSignal, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const now = opts.now ?? (() => performance.now())
  const log = opts.log
  const steps: ProbeStep[] = []
  const result: ProbeResult = { steps, replies: 0, cycles }
  const push = (s: ProbeStep): void => {
    steps.push(s)
    opts.onStep?.(s, steps)
  }
  const request = new Uint8Array([...genericHandshake(), ...statusRequest()])
  log?.note(`probe: ${transport.info.kind} · ${transport.info.label} · ${cycles} cycle(s)`)

  for (let c = 1; c <= cycles; c++) {
    if (signal?.aborted) break
    const tag = cycles > 1 ? ` #${c}` : ''

    // open
    let attempts = 1
    let t0 = now()
    try {
      await transport.open({
        ...(signal ? { signal } : {}),
        onProgress: (p) => {
          attempts = p.attempt
          log?.note(`probe: open attempt ${p.attempt} of ${p.of}${p.lastError ? ` after ${describeError(p.lastError)}` : ''}`)
          opts.onOpenProgress?.(p)
        },
      })
      push({ label: `open${tag}`, ok: true, ms: now() - t0, detail: attempts > 1 ? `opened on attempt ${attempts}` : 'opened' })
    } catch (e) {
      push({ label: `open${tag}`, ok: false, ms: now() - t0, detail: describeError(e) })
      log?.note(`probe: open failed: ${describeError(e)}`)
      if (signal?.aborted) break
      continue
    }

    // subscribe before writing so the reply cannot be missed
    const framer = new StatusFramer()
    let received = 0
    let head = new Uint8Array(0) // first bytes, for the "unexpected bytes" note
    const events = new EventTarget()
    const unsubscribe = transport.subscribe((ev: TransportEvent) => {
      if (ev.type === 'data') {
        log?.push('<<', ev.bytes)
        received += ev.bytes.length
        if (head.length < 32) head = Uint8Array.from([...head, ...ev.bytes.subarray(0, 32 - head.length)])
        framer.push(ev.bytes)
        events.dispatchEvent(new Event('data'))
      } else {
        log?.note(`probe: link lost: ${describeError(ev.error)}`)
        events.dispatchEvent(new Event('lost'))
      }
    })

    try {
      t0 = now()
      log?.push('>>', request)
      await transport.write(request, signal)
      const written = now()
      push({ label: `write${tag}`, ok: true, ms: written - t0, detail: `${request.length} bytes` })
      let got = false
      try {
        const status = await waitForFrame(framer, () => received, events, opts.replyTimeoutMs ?? 5000, signal)
        got = true
        result.replies++
        result.reply ??= Uint8Array.from(status.raw)
        push({ label: `status reply${tag}`, ok: true, ms: now() - written, detail: summarize(status) })
      } catch (e) {
        push({ label: `status reply${tag}`, ok: false, ms: now() - written, detail: describeError(e) })
      }
      if (!got && received > 0) log?.note(`probe: ${received} unexpected bytes: ${toHex(head)}`)
      else if (framer.discardedBytes > 0) log?.note(`probe: ${framer.discardedBytes} bytes skipped before the status frame`)
    } catch (e) {
      push({ label: `write${tag}`, ok: false, ms: now() - t0, detail: describeError(e) })
    } finally {
      unsubscribe()
      release(framer)
      t0 = now()
      try {
        await transport.close()
        push({ label: `close${tag}`, ok: true, ms: now() - t0 })
      } catch (e) {
        push({ label: `close${tag}`, ok: false, ms: now() - t0, detail: describeError(e) })
      }
    }

    if (c < cycles) {
      try {
        await sleep(opts.pauseMs ?? 400, signal)
      } catch {
        break
      }
    }
  }
  log?.note(`probe: done, ${result.replies}/${cycles} replies`)
  return result
}

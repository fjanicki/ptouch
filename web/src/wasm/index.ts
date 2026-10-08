// W1 — the only module that imports the wasm-pack output (src/wasm/pkg, gitignored; built by
// `npm run wasm`). Everything else imports wasm symbols from here, never from ./pkg.
//
// wasm-pack --target web glue: the default export `init()` fetches
// `new URL('ptouch_bg.wasm', import.meta.url)`, which Vite rewrites to a hashed asset under
// `base` (so it works at https://fjanicki.github.io/ptouch/ and is precached by the SW).
//
// Contract (docs/WEB-IMPLEMENTATION-PLAN.md §2.1):
// - Every fallible export throws a real `Error` with `name === 'PtouchError'` and a stable
//   `code` (`PtouchErrorCode`); use `isPtouchError(e)` / `ptouchErrorCode(e)`.
// - Structured values are plain objects (camelCase fields, kebab-case string enums; optional
//   fields are absent rather than null). Byte buffers returned by functions/methods are
//   `Uint8Array` copies; byte fields *inside* DTOs (`PrinterStatus.raw`,
//   `ModuleMatrix.modules`) are plain `number[]` (serde sequences).
// - Class handles (`Raster`, `Bitmap1`, `Job`, `PrintSession`, `VirtualPrinter`, `DecodedJob`,
//   `StatusFramer`) own wasm memory: call `release()` / `scoped()` (or `.free()` exactly once)
//   when done. `encodeJob` and `Raster.finish` consume their handle arguments / receiver.
//   `using` works too: this module makes `[Symbol.dispose]` a no-op on consumed handles (the
//   generated one is plain `free()`, which throws "null pointer passed to rust").
// - `encodeJob` is wrapped: every page is checked (a live, distinct `Bitmap1`) BEFORE any is
//   consumed, so a bad element throws `PtouchError` INVALID_INPUT and leaks nothing.
// - Times are `performance.now()`-style milliseconds.
import init, {
  Bitmap1,
  DecodedJob,
  Job,
  PrintSession,
  Raster,
  StatusFramer,
  VirtualPrinter,
  encodeJob as encodeJobUnchecked,
  isPtouchError,
  type PtouchError,
  type PtouchErrorCode,
  type SessionEvent,
} from './pkg/ptouch.js'

export * from './pkg/ptouch.js'

let ready: Promise<void> | undefined
let loaded = false

/** Loads and instantiates the wasm module once. Safe to call many times. */
export function loadWasm(): Promise<void> {
  ready ??= init().then(() => {
    loaded = true
  })
  return ready
}

/** `true` once `loadWasm()` resolved; wasm exports may be called synchronously after that. */
export function isWasmLoaded(): boolean {
  return loaded
}

/**
 * Test hook: mark the module as initialised after a synchronous `initSync()` (node tests, see
 * tests/helpers/wasm.ts). Not used by the app.
 */
export function markWasmLoaded(): void {
  loaded = true
  ready = Promise.resolve()
}

/** The `code` of a `PtouchError`, or `undefined` for anything else. */
export function ptouchErrorCode(e: unknown): PtouchErrorCode | undefined {
  return isPtouchError(e) ? e.code : undefined
}

/** Discriminant of a `SessionEvent` (`'status' | 'ready' | 'page-started' | …`). */
export type SessionEventType = SessionEvent['type']

/** The `SessionEvent` variant with discriminant `T`. */
export type SessionEventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>

/** Anything with a wasm-bindgen `free()`. */
export interface WasmHandle {
  free(): void
}

/**
 * Frees a handle unless it was already freed or consumed (`Raster.finish()`, pages passed to
 * `encodeJob`). Plain `.free()` on a consumed handle throws "null pointer passed to rust";
 * this never throws. Accepts `null`/`undefined` for convenience.
 */
export function release(handle: WasmHandle | null | undefined): void {
  if (!handle) return
  // wasm-bindgen zeroes `__wbg_ptr` when a handle is freed or moved into Rust.
  if ((handle as unknown as { __wbg_ptr?: number }).__wbg_ptr === 0) return
  handle.free()
}

/**
 * Runs `fn(handle)` and releases the handle afterwards (also on throw), even if `fn`
 * consumed it (e.g. `scoped(new Raster(l, h), (r) => { …; return r.finish() })`).
 */
export function scoped<H extends WasmHandle, R>(handle: H, fn: (h: H) => R): R {
  try {
    return fn(handle)
  } finally {
    release(handle)
  }
}

/** `0xRRGGBB` for `Bitmap1.toRgba` from a status colour's CSS (`ColorInfo.css`, `#rrggbb`). */
export function cssHexToRgb(css: string, fallback = 0): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(css.trim())
  return m?.[1] ? Number.parseInt(m[1], 16) : fallback
}

// `using x = …` calls [Symbol.dispose]; make it safe on handles a consuming call already took.
for (const C of [Bitmap1, DecodedJob, Job, PrintSession, Raster, StatusFramer, VirtualPrinter]) {
  if (typeof Symbol.dispose === 'symbol') {
    Object.defineProperty(C.prototype, Symbol.dispose, {
      value(this: WasmHandle) {
        release(this)
      },
      configurable: true,
      writable: true,
    })
  }
}

function invalidInput(message: string): PtouchError {
  return Object.assign(new Error(`invalid input: ${message}`), { name: 'PtouchError' as const, code: 'INVALID_INPUT' as const })
}

/**
 * Encodes `pages` (core `encode_job`, see the generated docs). **Consumes** the pages (pass
 * `bitmap.clone()` to keep one). Checked first: a non-`Bitmap1`, freed/consumed or repeated
 * page throws `PtouchError` INVALID_INPUT before anything is consumed.
 */
export function encodeJob(...args: Parameters<typeof encodeJobUnchecked>): Job {
  const pages: unknown = args[2]
  if (!Array.isArray(pages)) throw invalidInput('pages must be an array of Bitmap1')
  const seen = new Set<number>()
  pages.forEach((p: unknown, i) => {
    if (!(p instanceof Bitmap1)) throw invalidInput(`page ${i + 1} is not a Bitmap1`)
    const ptr = (p as unknown as { __wbg_ptr?: number }).__wbg_ptr ?? 0
    if (ptr === 0) throw invalidInput(`page ${i + 1} was already freed or consumed`)
    if (seen.has(ptr)) throw invalidInput(`page ${i + 1} is passed more than once (clone it)`)
    seen.add(ptr)
  })
  return encodeJobUnchecked(...args)
}

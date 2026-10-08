// W3 — canvas helpers: OffscreenCanvas where available (also in workers), else a DOM canvas.
export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement
export type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

/** Chromium's per-side canvas limit; longer labels are drawn in tiles. */
export const MAX_CANVAS_SIDE = 32767
/** Keep a single canvas below ~64 M pixels (well under every engine's area limit). */
export const MAX_CANVAS_AREA = 64 * 1024 * 1024

export function hasCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined'
}

export function createCanvas(width: number, height: number): AnyCanvas {
  const w = Math.max(1, Math.ceil(width))
  const h = Math.max(1, Math.ceil(height))
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  if (typeof document === 'undefined') throw new Error('No canvas available in this environment')
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

export function context2d(canvas: AnyCanvas, readback = true): Ctx2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: readback, alpha: true }) as Ctx2D | null
  if (!ctx) throw new Error('Canvas 2D is not available')
  return ctx
}

/** View an ImageData buffer as the `Uint8Array` the wasm bindings take (no copy). */
export function rgbaBytes(data: Uint8ClampedArray): Uint8Array {
  return new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
}

// W3 — paints a Bitmap1 into a <canvas> (exact dots, tape-tinted). Zoom is CSS
// (`image-rendering: pixelated`); the canvas backing store is exactly length × height.
import type { Bitmap1 } from '../wasm'
import { createCanvas, context2d } from './canvas'
import type { PreviewColors } from './types'
import { cssToRgb } from './units'

function imageDataOf(bitmap: Bitmap1, colors: PreviewColors): ImageData {
  const rgba = bitmap.toRgba(cssToRgb(colors.tape), cssToRgb(colors.ink))
  return new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), bitmap.length, bitmap.height)
}

export function paintPreview(canvas: HTMLCanvasElement | OffscreenCanvas, bitmap: Bitmap1, colors: PreviewColors): void {
  if (canvas.width !== bitmap.length) canvas.width = bitmap.length
  if (canvas.height !== bitmap.height) canvas.height = bitmap.height
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) return
  ctx.putImageData(imageDataOf(bitmap, colors), 0, 0)
}

/**
 * PNG thumbnail for the label list (W5 stores it): the printed dots, tape-tinted, scaled down
 * (smoothly) to at most `maxWidth` px wide; never scaled up. `undefined` where no canvas exists.
 */
export async function thumbnailPng(bitmap: Bitmap1, colors: PreviewColors, maxWidth = 320): Promise<Blob | undefined> {
  if (bitmap.length === 0 || bitmap.height === 0) return undefined
  try {
    const full = createCanvas(bitmap.length, bitmap.height)
    context2d(full, false).putImageData(imageDataOf(bitmap, colors), 0, 0)
    const scale = Math.min(1, maxWidth / bitmap.length)
    const w = Math.max(1, Math.round(bitmap.length * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const out = createCanvas(w, h)
    const ctx = context2d(out, false)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(full, 0, 0, w, h)
    if ('convertToBlob' in out) return await out.convertToBlob({ type: 'image/png' })
    return await new Promise<Blob | undefined>((resolve) => out.toBlob((b) => resolve(b ?? undefined), 'image/png'))
  } catch {
    return undefined
  }
}

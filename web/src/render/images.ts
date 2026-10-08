// W3 — image decode (createImageBitmap) → 1× RGBA scaled to the band, for Raster.blitTone
// (dithering happens in the core). Decoded bitmaps are cached per Blob so re-rendering while
// editing does not decode the photo again.
import type { ImageItem } from '../doc/schema'
import { createCanvas, context2d } from './canvas'

export interface RgbaImage {
  rgba: Uint8ClampedArray
  width: number
  height: number
}

/** Longest image side accepted along the label, dots (~564 mm at 180 dpi). */
export const MAX_IMAGE_DOTS = 4000

const decoded = new WeakMap<Blob, Promise<ImageBitmap>>()

function bitmapOf(blob: Blob): Promise<ImageBitmap> {
  let p = decoded.get(blob)
  if (!p) {
    p = createImageBitmap(blob)
    p.catch(() => decoded.delete(blob))
    decoded.set(blob, p)
  }
  return p
}

/** Natural size of an image blob (for aspect ratios). */
export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const b = await bitmapOf(blob)
  return { width: b.width, height: b.height }
}

/**
 * Size in dots of an image of natural size `w × h` drawn `heightDots` tall, aspect kept. A very
 * wide image is limited to MAX_IMAGE_DOTS long and drawn *shorter* (never squashed).
 */
export function scaledSize(w: number, h: number, heightDots: number): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 }
  const width = Math.max(1, Math.round((w * heightDots) / h))
  if (width <= MAX_IMAGE_DOTS) return { width, height: heightDots }
  return { width: MAX_IMAGE_DOTS, height: Math.max(1, Math.round((h * MAX_IMAGE_DOTS) / w)) }
}

/** Width in dots of an image of natural size `w × h` drawn `heightDots` tall (≤ MAX_IMAGE_DOTS). */
export function scaledWidth(w: number, h: number, heightDots: number): number {
  return scaledSize(w, h, heightDots).width
}

/**
 * Decodes `blob` and scales it to `targetHeightDots` (aspect kept; a very wide image comes back
 * shorter, see scaledSize), as straight RGBA at 1×.
 * `rotation` (free layout) rotates clockwise; the height still applies to the rotated image.
 * Transparent pixels stay transparent (the core leaves them untouched).
 */
export async function decodeImage(blob: Blob, targetHeightDots: number, rotation: 0 | 90 | 180 | 270 = 0): Promise<RgbaImage> {
  const bmp = await bitmapOf(blob)
  const quarter = rotation === 90 || rotation === 270
  const natW = quarter ? bmp.height : bmp.width
  const natH = quarter ? bmp.width : bmp.height
  const { width, height } = scaledSize(natW, natH, Math.max(1, Math.round(targetHeightDots)))
  if (width === 0) throw new Error('The image is empty')
  const canvas = createCanvas(width, height)
  const ctx = context2d(canvas)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.translate(width / 2, height / 2)
  ctx.rotate((rotation * Math.PI) / 180)
  const dw = quarter ? height : width
  const dh = quarter ? width : height
  ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh)
  const data = ctx.getImageData(0, 0, width, height)
  return { rgba: data.data, width, height }
}

/** Decodes a `data:` URL without fetch (CSP `connect-src 'self'` blocks fetching data URLs). */
export function dataUrlToBlob(dataUrl: string): Blob | undefined {
  const m = /^data:([^;,]*)(;[^,]*)?,(.*)$/s.exec(dataUrl)
  if (!m) return undefined
  const mime = m[1] || 'application/octet-stream'
  const base64 = (m[2] ?? '').includes(';base64')
  const payload = m[3] ?? ''
  try {
    if (!base64) return new Blob([decodeURIComponent(payload)], { type: mime })
    const bin = atob(payload)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: mime })
  } catch {
    return undefined
  }
}

const inlined = new Map<string, Blob>()
const stored = new Map<string, Blob>()

/**
 * The image's Blob: the store (`loadBlob`) first, else the inlined `dataUrl`. Blobs are content
 * addressed in the store, so a ref that returns the same size/type is the same image: reuse
 * the first Blob object so the decode cache hits.
 */
export async function resolveImageBlob(item: Pick<ImageItem, 'blobRef' | 'dataUrl'>, loadBlob?: (ref: string) => Promise<Blob | undefined>): Promise<Blob | undefined> {
  if (item.blobRef && loadBlob) {
    try {
      const b = await loadBlob(item.blobRef)
      if (b) {
        const prev = stored.get(item.blobRef)
        if (prev && prev.size === b.size && prev.type === b.type) return prev
        if (stored.size > 32) stored.clear()
        stored.set(item.blobRef, b)
        return b
      }
    } catch {
      // fall through to the inlined copy
    }
  }
  if (!item.dataUrl) return undefined
  // Same data URL → same Blob object → decode cache hit.
  const k = `${item.dataUrl.length}:${item.dataUrl.slice(0, 64)}:${item.dataUrl.slice(-64)}`
  let b = inlined.get(k)
  if (!b) {
    b = dataUrlToBlob(item.dataUrl)
    if (!b) return undefined
    if (inlined.size > 16) inlined.clear()
    inlined.set(k, b)
  }
  return b
}

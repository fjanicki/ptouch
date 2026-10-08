// W3 — anti-fingerprinting probe (ARCHITECTURE.md §6.5): Brave Shields / Cromite (and Firefox
// with resistFingerprinting) randomize getImageData, which prints as "snow". Draw a known
// pattern, read it back, compare exactly.
import { createCanvas, context2d, hasCanvas } from './canvas'

const SIZE = 16

/** Expected RGB at (x, y) of the probe pattern: solid fills that never need antialiasing. */
function expected(x: number, y: number): [number, number, number] {
  if (y < SIZE / 2) return x < SIZE / 2 ? [0, 0, 0] : [255, 255, 255]
  return x < SIZE / 2 ? [51, 102, 204] : [255, 255, 255]
}

let cached: boolean | undefined

/** `true` if canvas readback is noisy (printing must be blocked). Cached after the first call. */
export function canvasReadbackIsNoisy(): boolean {
  if (cached !== undefined) return cached
  if (!hasCanvas()) return false
  try {
    const canvas = createCanvas(SIZE, SIZE)
    const ctx = context2d(canvas)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, SIZE, SIZE)
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, SIZE / 2, SIZE / 2)
    ctx.fillStyle = '#3366cc'
    ctx.fillRect(0, SIZE / 2, SIZE / 2, SIZE / 2)
    const a = ctx.getImageData(0, 0, SIZE, SIZE).data
    const b = ctx.getImageData(0, 0, SIZE, SIZE).data
    let noisy = false
    for (let y = 0; y < SIZE && !noisy; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = (y * SIZE + x) * 4
        const [r, g, bl] = expected(x, y)
        if (a[i] !== r || a[i + 1] !== g || a[i + 2] !== bl || a[i + 3] !== 255 || a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
          noisy = true
          break
        }
      }
    }
    cached = noisy
    return noisy
  } catch {
    // A canvas that cannot be read back at all is as bad as a noisy one.
    cached = true
    return true
  }
}

/** Test hook: forget the cached probe result. */
export function resetCanvasProbe(): void {
  cached = undefined
}

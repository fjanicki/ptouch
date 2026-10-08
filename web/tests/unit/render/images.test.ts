// W3 — image scaling keeps the aspect ratio, also for images longer than the length cap.
import { describe, expect, it } from 'vitest'
import { MAX_IMAGE_DOTS, scaledSize, scaledWidth } from '../../../src/render/images'

describe('scaledSize', () => {
  it('scales to the target height', () => {
    expect(scaledSize(200, 100, 128)).toEqual({ width: 256, height: 128 })
    expect(scaledSize(0, 100, 128)).toEqual({ width: 0, height: 0 })
  })
  it('a very wide image gets shorter instead of squashed', () => {
    const s = scaledSize(8000, 100, 128) // would be 10 240 dots long
    expect(s.width).toBe(MAX_IMAGE_DOTS)
    expect(s.height).toBe(50)
    expect(s.width / s.height).toBeCloseTo(80, 0) // source aspect
    expect(scaledWidth(8000, 100, 128)).toBe(MAX_IMAGE_DOTS)
  })
})

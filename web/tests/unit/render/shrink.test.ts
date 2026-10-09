// P-size (docs/FONTS-AND-SIZE-PLAN.md §3.3) — "shrink to fit length": the common factor for the
// text blocks of a fixed-length label (never larger than 1, never below MIN_SHRINK).
import { describe, expect, it } from 'vitest'
import { MIN_SHRINK, shrinkFactor } from '../../../src/render/text'

describe('shrinkFactor', () => {
  it('is 1 when the content already fits (text is never made larger)', () => {
    expect(shrinkFactor(200, 50, 100)).toBe(1)
    expect(shrinkFactor(200, 50, 150)).toBe(1)
    expect(shrinkFactor(200, 0, 0)).toBe(1)
  })

  it('scales the text into the room the other content leaves', () => {
    // 200 dots between the margins, codes/gaps take 80: 300 dots of text must become 120.
    expect(shrinkFactor(200, 80, 300)).toBeCloseTo(0.4, 9)
    expect(80 + 300 * (shrinkFactor(200, 80, 300) ?? 0)).toBeCloseTo(200, 9)
    expect(shrinkFactor(100, 0, 125)).toBeCloseTo(0.8, 9)
  })

  it('gives up only when shrinking text cannot help (the rest alone is too long)', () => {
    expect(shrinkFactor(100, 120, 50)).toBeUndefined()
    expect(shrinkFactor(100, 100, 50)).toBeUndefined()
  })

  it('never goes below MIN_SHRINK: far too much text is clamped (and still overflows), not left full size', () => {
    expect(shrinkFactor(100, 0, 100 / MIN_SHRINK)).toBeCloseTo(MIN_SHRINK, 9)
    expect(shrinkFactor(100, 0, 100 / MIN_SHRINK + 1)).toBe(MIN_SHRINK)
    expect(shrinkFactor(100, 0, 20000)).toBe(MIN_SHRINK)
  })
})

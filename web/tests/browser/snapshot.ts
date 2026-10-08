// W3 — bitmap snapshots for the browser tests, stored as plain PBM (P1) so they open in any
// image viewer and diff line by line in review. A missing snapshot is written (commit it);
// delete a file to re-record it.
//
// Codes and dithered images come from the core and must match exactly (tolerance 0). Text
// rasterization differs slightly between OS font back ends (CoreText vs FreeType) and browser
// versions, so text snapshots use a tolerance: same height, length within 2 dots, and at most
// `tolerance` of the ink dots different at the best ±2-dot shift.
import { commands } from 'vitest/browser'
import { expect } from 'vitest'
import type { Bitmap1 } from '../../src/wasm'

export interface Pbm {
  platform: string
  length: number
  height: number
  rows: string[]
}

const platform = (): string => (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || 'unknown'

export function toPbm(bmp: Bitmap1): string {
  const rows: string[] = []
  for (let y = 0; y < bmp.height; y++) {
    let r = ''
    for (let x = 0; x < bmp.length; x++) r += bmp.get(x, y) ? '1' : '0'
    rows.push(r)
  }
  return `P1\n# ptouch render snapshot, recorded on ${platform()}\n${bmp.length} ${bmp.height}\n${rows.join('\n')}\n`
}

export function parsePbm(text: string): Pbm {
  const lines = text.split('\n')
  const plat = /recorded on (.*)$/.exec(lines[1] ?? '')?.[1] ?? 'unknown'
  const [w, h] = (lines[2] ?? '').split(' ').map(Number)
  return { platform: plat, length: w ?? 0, height: h ?? 0, rows: lines.slice(3, 3 + (h ?? 0)) }
}

/** Ink dots that differ (b shifted by `dx` along the label) and total ink of `a`. */
export function diff(a: Pbm, b: Pbm, dx = 0): { differ: number; ink: number } {
  let differ = 0
  let ink = 0
  for (let y = 0; y < Math.min(a.height, b.height); y++) {
    const ra = a.rows[y] ?? ''
    const rb = b.rows[y] ?? ''
    for (let x = 0; x < a.length; x++) {
      const va = ra[x] === '1'
      const vb = rb[x + dx] === '1'
      if (va) ink++
      if (va !== vb) differ++
    }
  }
  return { differ, ink }
}

/** Compares `bmp` with `__snapshots__/<name>.pbm` (written when missing). */
export async function expectBitmapSnapshot(bmp: Bitmap1, name: string, tolerance = 0): Promise<void> {
  const path = `tests/browser/__snapshots__/${name}.pbm`
  const actualText = toPbm(bmp)
  let expectedText: string | undefined
  try {
    expectedText = await commands.readFile(path)
  } catch {
    expectedText = undefined
  }
  if (expectedText === undefined) {
    await commands.writeFile(path, actualText)
    console.warn(`snapshot ${name}.pbm written — commit it`)
    return
  }
  const expected = parsePbm(expectedText)
  const actual = parsePbm(actualText)
  if (tolerance === 0) {
    expect(`${actual.length}x${actual.height}`, name).toBe(`${expected.length}x${expected.height}`)
    const d = diff(expected, actual)
    expect(d.differ, `${name}: ${d.differ} of ${d.ink} ink dots differ`).toBe(0)
    return
  }
  expect(actual.height, name).toBe(expected.height)
  expect(Math.abs(actual.length - expected.length), `${name} length`).toBeLessThanOrEqual(2)
  // Centred content moves by half a length difference: compare at the best small shift.
  const d = [-2, -1, 0, 1, 2].map((dx) => diff(expected, actual, dx)).reduce((best, x) => (x.differ < best.differ ? x : best))
  expect(d.differ / Math.max(1, d.ink), `${name}: ${d.differ} of ${d.ink} ink dots differ`).toBeLessThanOrEqual(tolerance)
}

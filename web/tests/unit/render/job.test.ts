// W3 — doc.print → JobOptions mapping, copies clamp, print preflight.
import { describe, expect, it } from 'vitest'
import { createDoc, DEFAULT_PRINT } from '../../../src/doc/schema'
import { buildPrintJob, copiesOf, estimateTape, jobOptions, LEADER_MM, printBlocker } from '../../../src/render/job'
import type { RenderResult, RenderTarget } from '../../../src/render/types'
import { Bitmap1, printArea, mediaForWidth } from '../../../src/wasm'
import { loadWasmForTests } from '../../helpers/wasm'
import { AREA_12, AREA_24, AREA_6, MEDIA_12, MEDIA_24, MEDIA_6 } from './fixtures'

const target: RenderTarget = { model: 'PT-P710BT', media: MEDIA_24, area: AREA_24 }

function result(patch: Partial<RenderResult> = {}): RenderResult {
  const bitmap = { height: 128, length: 100, clone: () => bitmap } as unknown as RenderResult['bitmap']
  return { bitmap, lengthDots: 100, heightDots: 128, lengthMm: 14.1, feedMarginMm: 2, boxes: [], warnings: [], blocking: false, ...patch }
}

describe('geometry fixtures', () => {
  it('match the core media table (printArea / mediaForWidth)', () => {
    loadWasmForTests()
    for (const [w, area, media] of [[24, AREA_24, MEDIA_24], [12, AREA_12, MEDIA_12], [6, AREA_6, MEDIA_6]] as const) {
      expect(mediaForWidth('PT-P710BT', w)).toEqual(media)
      expect(printArea('PT-P710BT', media.id)).toEqual(area)
    }
  })
})

describe('print job mapping', () => {
  it('maps autoCut / chain / mirror', () => {
    expect(jobOptions(createDoc())).toEqual({ copies: 1, cut: 'every-label', chain: false, mirror: false })
    expect(jobOptions(createDoc({ print: { ...DEFAULT_PRINT, copies: 3, autoCut: false, chain: true, mirror: true } }))).toEqual({ copies: 3, cut: 'none', chain: true, mirror: true })
  })

  it('clamps copies to 1–99', () => {
    const c = (copies: number) => copiesOf(createDoc({ print: { ...DEFAULT_PRINT, copies } }))
    expect([c(0), c(1), c(2.4), c(150), c(Number.NaN)]).toEqual([1, 1, 2, 99, 1])
  })

  it('refuses blocking renders with the blocking warning text', () => {
    const r = result({ blocking: true, warnings: [{ code: 'small-text', message: 'small' }, { code: 'code-invalid', message: 'EAN-13: bad check digit', blocking: true }] })
    expect(printBlocker(r, target)).toBe('EAN-13: bad check digit')
    expect(() => buildPrintJob(createDoc(), r, target)).toThrow('EAN-13: bad check digit')
  })

  it('encodes copies in the core from one page (no per-copy bitmap clones)', () => {
    loadWasmForTests()
    const bm = Bitmap1.fromPacked(100, 128, new Uint8Array(100 * 16).fill(0x81))
    let clones = 0
    const counting = { height: 128, length: 100, clone: () => (clones++, bm.clone()) } as unknown as RenderResult['bitmap']
    const job = buildPrintJob(createDoc({ print: { ...DEFAULT_PRINT, copies: 5 } }), result({ bitmap: counting }), target)
    expect(job.pageCount).toBe(5)
    expect(clones).toBe(1)
    job.free()
    bm.free()
  })

  it('refuses a render made for another tape height', () => {
    expect(printBlocker(result({ heightDots: 70 }), target)).toMatch(/different tape/)
    expect(printBlocker(result(), target)).toBeUndefined()
  })
})

describe('estimateTape', () => {
  it('adds the feed margin at both ends of every label and one leader', () => {
    expect(estimateTape([30, 30, 40], 2)).toEqual({ labelsMm: 112, leaderMm: LEADER_MM, totalMm: 112 + LEADER_MM })
    expect(estimateTape([30], 2, { leader: false })).toEqual({ labelsMm: 34, leaderMm: 0, totalMm: 34 })
  })

  it('is robust to empty and bad input', () => {
    expect(estimateTape([], 2)).toEqual({ labelsMm: 0, leaderMm: 0, totalMm: 0 })
    expect(estimateTape([Number.NaN, -5], Number.NaN).totalMm).toBe(LEADER_MM)
  })
})

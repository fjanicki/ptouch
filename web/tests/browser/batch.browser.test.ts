// P1 — batch printing in Chromium (real renderer + wasm): buildBatchJob makes ONE multi-page
// job (one preamble, so the leader is fed once), copies are per label, every page equals the
// row's own render, and the tape estimate matches the encoded page lengths.
import { beforeAll, describe, expect, it } from 'vitest'
import { createBatch, createDoc, createItem, type CodeItem, type Item, type LabelDoc, type TextItem } from '../../src/doc/schema'
import { resolveDoc } from '../../src/doc/variables'
import { estimateTape, renderLabel, type RenderTarget } from '../../src/render'
import { preloadAllFonts } from '../../src/render/fonts'
import { decodeJob, loadWasm, mediaForWidth, printArea, release } from '../../src/wasm'
import { buildBatchJob, renderBatchLabel, type BatchProgress } from '../../src/ui/batch/batch-job'
import { BatchMeasure } from '../../src/ui/batch/batch-measure.svelte'
import type { Studio } from '../../src/ui/state/studio.svelte'

function target(widthMm: number): RenderTarget {
  const media = mediaForWidth('PT-P710BT', widthMm)
  return { model: 'PT-P710BT', media, area: printArea('PT-P710BT', media.id) }
}

const text = (t: string): TextItem => ({ ...createItem('text'), text: t })
const code = (patch: Partial<CodeItem>): CodeItem => ({ ...createItem('code'), ...patch })
const NOW = new Date(2026, 9, 8, 12)

function batchDoc(items: Item[], rows: string[][], copies = 1, patch: Partial<LabelDoc> = {}): LabelDoc {
  const d = createDoc({ items, tape: { widthMm: 12 }, batch: createBatch({ enabled: true, columns: ['name', 'room'], rows }), ...patch })
  return { ...d, print: { ...d.print, copies } }
}

beforeAll(async () => {
  await loadWasm()
  await preloadAllFonts()
})

describe('buildBatchJob', () => {
  it('3 rows × 2 copies → 6 pages in one job; pages equal the per-row renders', async () => {
    const t = target(12)
    const doc = batchDoc([text('{{name}} {{room}} #{{n}}')], [['Ada', 'Lab 1'], ['Grace Hopper', 'Lab 22'], ['Linus', '']], 2)
    const progress: BatchProgress[] = []
    const built = await buildBatchJob(doc, t, { now: NOW, leader: true, onProgress: (p) => progress.push({ ...p }) })
    try {
      expect(built.labels).toBe(6)
      expect(built.job.pageCount).toBe(6)
      expect(progress[0]).toEqual({ done: 0, total: 3 })
      expect(progress.at(-1)).toEqual({ done: 3, total: 3 })

      const decoded = decodeJob(t.model, built.job.toBytes())
      try {
        expect(decoded.violations()).toEqual([])
        const cmds = decoded.commands()
        // One job: a single initialise/preamble (one leader), 5 × Print then the final PrintLast.
        expect(cmds.filter((c) => c === 'Initialize')).toHaveLength(1)
        expect(cmds.filter((c) => c === 'Print')).toHaveLength(5)
        expect(cmds.filter((c) => c === 'PrintLast')).toHaveLength(1)

        const pages = decoded.pages()
        try {
          expect(pages).toHaveLength(6)
          for (let row = 0; row < 3; row++) {
            const own = await renderLabel(resolveDoc(doc, row, { now: NOW }).doc, t)
            try {
              for (const copy of [0, 1]) {
                const page = pages[row * 2 + copy]
                expect(page?.length, `row ${row} copy ${copy}`).toBe(own.bitmap.length)
                expect(page?.toPacked(), `row ${row} copy ${copy}`).toEqual(own.bitmap.toPacked())
              }
            } finally {
              own.bitmap.free()
            }
          }
          // Different text → different lengths (auto length): the rows really differ.
          expect(new Set(pages.map((p) => p.length)).size).toBeGreaterThan(1)
        } finally {
          for (const p of pages) p.free()
        }
      } finally {
        decoded.free()
      }

      // The estimate equals the encoded page lengths + feed margins + one leader.
      const first = await renderBatchLabel(doc, 0, t, { now: NOW })
      const feed = first.feedMarginMm
      first.bitmap.free()
      const linesMm = [...built.job.pageLines()].map((l) => (l * 25.4) / t.area.dpi)
      expect(built.tapeMm).toBeCloseTo(estimateTape(linesMm, feed, { leader: true }).totalMm, 6)
    } finally {
      built.job.free()
    }
  })

  it('counter-only batches resolve {{n}} per label; no leader counted after a chained print', async () => {
    const t = target(12)
    const d = createDoc({ items: [text('A-{{n}}')], tape: { widthMm: 12 }, batch: createBatch({ enabled: true, count: 3, counters: [{ name: 'n', start: 1, step: 1, pad: 3 }] }) })
    const withLeader = await buildBatchJob(d, t, { now: NOW, leader: true })
    const noLeader = await buildBatchJob(d, t, { now: NOW, leader: false })
    try {
      expect(withLeader.labels).toBe(3)
      expect(withLeader.tapeMm - noLeader.tapeMm).toBeCloseTo(24, 6)
    } finally {
      withLeader.job.free()
      noLeader.job.free()
    }
  })

  it('throws before rendering for unknown variables', async () => {
    const d = batchDoc([text('{{name}} {{nmae}}')], [['Ada', '']])
    await expect(buildBatchJob(d, target(12), { now: NOW, leader: true })).rejects.toThrow(/Unknown variable \{\{nmae\}\}/)
  })

  it('names the label that cannot be printed', async () => {
    const d = batchDoc([code({ symbology: 'ean13', data: '{{name}}', moduleDots: 2, quietZone: 'standard' })], [['400638133393'], ['not digits'], ['400638133393']])
    await expect(buildBatchJob(d, target(24), { now: NOW, leader: true })).rejects.toThrow(/^Label 2: /)
  })

  it('stops when aborted', async () => {
    const ac = new AbortController()
    const d = batchDoc([text('{{name}}')], [['a'], ['b'], ['c']])
    const p = buildBatchJob(d, target(12), { now: NOW, leader: true, signal: ac.signal, onProgress: (x) => x.done === 1 && ac.abort() })
    await expect(p).rejects.toThrow(/cancelled/)
  })

  it('release() tolerates the consumed pages (no leaks or double frees on success)', async () => {
    const d = batchDoc([text('{{name}}')], [['x']])
    const built = await buildBatchJob(d, target(12), { now: NOW, leader: true })
    expect(built.labels).toBe(1)
    release(built.job)
    release(built.job)
  })
})

describe('BatchMeasure (background lengths + lazy thumbnails)', () => {
  const fakeStudio = { store: { getBlob: async () => undefined }, fonts: { get: async () => undefined } } as unknown as Studio
  const until = async (ok: () => boolean, ms = 10_000): Promise<void> => {
    const end = performance.now() + ms
    while (!ok()) {
      if (performance.now() > end) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it('measures every label, paints wanted thumbnails, and starts over on a new doc', async () => {
    const t = target(12)
    const m = new BatchMeasure(fakeStudio)
    try {
      const doc = batchDoc([text('{{name}}')], [['a'], ['a much longer label'], ['b']])
      const painted: number[] = []
      m.sync(doc, t, 0)
      expect(m.total).toBe(3)
      const stop = m.want(2, (b) => painted.push(b.length))
      await until(() => m.measured === 3)
      expect(painted).toHaveLength(1)
      const lengths = m.lengths
      for (let i = 0; i < 3; i++) {
        const r = await renderBatchLabel(doc, i, t, { now: new Date() })
        expect(lengths[i]).toBeCloseTo(r.lengthMm, 6)
        r.bitmap.free()
      }
      expect(lengths[1]).toBeGreaterThan(lengths[0] ?? Infinity)
      expect(m.problems).toEqual([])

      // Same doc again: nothing restarts. A new doc: results cleared, measured again, repainted.
      m.sync(doc, t, 0)
      expect(m.measured).toBe(3)
      const next = { ...doc, batch: { ...doc.batch!, rows: [['x'], ['y']] } }
      m.sync(next, t, 0)
      expect(m.measured).toBe(0)
      expect(m.total).toBe(2)
      await until(() => m.measured === 2)
      expect(painted).toHaveLength(1) // row 2 no longer exists
      stop()
    } finally {
      m.dispose()
    }
  })

  it('reports labels that cannot be printed', async () => {
    const m = new BatchMeasure(fakeStudio)
    try {
      m.sync(batchDoc([code({ symbology: 'ean13', data: '{{name}}', moduleDots: 2, quietZone: 'standard' })], [['400638133393'], ['oops']]), target(24), 0)
      await until(() => m.measured === 2)
      expect(m.problems.map(([i]) => i)).toEqual([1])
      expect(m.notices).toEqual([])
    } finally {
      m.dispose()
    }
  })

  it('flags rows that print cut off or too small (shrink to fit length with one very long value)', async () => {
    const m = new BatchMeasure(fakeStudio)
    try {
      const doc = batchDoc([text('{{name}}')], [['Ada'], ['x'.repeat(400)], ['Grace']], 1, { length: { mode: 'fixed', mm: 20, shrink: true } })
      m.sync(doc, target(12), 0)
      await until(() => m.measured === 3)
      expect(m.problems).toEqual([])
      expect(m.notices.map(([i]) => i)).toEqual([1])
      expect(m.row(1)?.notice).toMatch(/cut off/)
      expect(m.row(0)?.notice).toBeUndefined()
    } finally {
      m.dispose()
    }
  })
})

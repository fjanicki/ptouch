// P1 (docs/STUDIO-V1-PLAN.md) — a batch as ONE print job: every label (doc/variables.ts
// resolveDoc for index 0…n−1) rendered with render/renderLabel, copies repeated per label, and
// encoded with a single wasm encodeJob (multi-page: the leader is fed once; cut each optional,
// chain per doc.print). Called by Studio.print() when batchSize(doc) > 0.
import type { LabelDoc } from '../../doc/schema'
import { batchSize, missingVariables, resolveDoc } from '../../doc/variables'
import { copiesOf, ensureFonts, estimateTape, jobOptions, renderLabel, type RenderResult, type RenderTarget } from '../../render'
import { encodeJob, release, type Bitmap1, type Job } from '../../wasm'

export interface BatchProgress {
  /** Labels rendered so far. */
  done: number
  total: number
}

export interface BatchJobOptions {
  now: Date
  /** Count the ~24 mm leader in `tapeMm` (Studio.tapeLeader). */
  leader: boolean
  loadBlob?: (ref: string) => Promise<Blob | undefined>
  loadFontBlob?: (ref: string) => Promise<Blob | undefined>
  onProgress?: (p: BatchProgress) => void
  signal?: AbortSignal
}

export interface BatchJob {
  /** Owned by the caller (free() after sending). */
  job: Job
  /** Pages in the job (labels × copies). */
  labels: number
  /** Tape used incl. feed margins and the leader (render/job.ts estimateTape). */
  tapeMm: number
}

/** Pages one job may hold (the wasm binding's limit; also keeps wasm memory bounded). */
export const MAX_BATCH_PAGES = 999

/** `{{a}}, {{b}}` for messages. */
export function placeholderList(names: readonly string[]): string {
  return names.map((n) => `{{${n}}}`).join(', ')
}

/** Why `doc` cannot print as a batch before anything is rendered, or undefined. */
export function batchBlocker(doc: LabelDoc): string | undefined {
  const n = batchSize(doc)
  if (n === 0) return 'Batch printing is off.'
  const missing = missingVariables(doc)
  if (missing.length) return `Unknown ${missing.length === 1 ? 'variable' : 'variables'} ${placeholderList(missing)}: add a column or counter with that name, or fix the spelling.`
  const pages = n * copiesOf(doc)
  if (pages > MAX_BATCH_PAGES) return `${n} labels × ${copiesOf(doc)} copies is ${pages} labels; one print job holds at most ${MAX_BATCH_PAGES}. Lower the copies or split the data.`
  return undefined
}

function abortError(): DOMException {
  return new DOMException('Batch preparation was cancelled.', 'AbortError')
}

/** Renders label `index` of the batch (variables resolved), fonts loaded first. */
export async function renderBatchLabel(doc: LabelDoc, index: number, target: RenderTarget, opts: Omit<BatchJobOptions, 'leader' | 'onProgress'>): Promise<RenderResult> {
  const shown = resolveDoc(doc, index, { now: opts.now }).doc
  await ensureFonts(shown, opts.loadFontBlob ? { loadFontBlob: opts.loadFontBlob } : {})
  return renderLabel(shown, target, {
    ...(opts.loadBlob ? { loadBlob: opts.loadBlob } : {}),
    ...(opts.loadFontBlob ? { loadFontBlob: opts.loadFontBlob } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
}

/**
 * Renders and encodes the whole batch. Throws an Error with a user-facing message when a label
 * cannot be printed (blocking warning, missing variables, over the row cap); frees every
 * intermediate bitmap on all paths.
 */
export async function buildBatchJob(doc: LabelDoc, target: RenderTarget, opts: BatchJobOptions): Promise<BatchJob> {
  const why = batchBlocker(doc)
  if (why) throw new Error(why)
  const total = batchSize(doc)
  const copies = copiesOf(doc)
  const bitmaps: Bitmap1[] = []
  const lengths: number[] = []
  let feedMarginMm = 0
  try {
    opts.onProgress?.({ done: 0, total })
    for (let i = 0; i < total; i++) {
      if (opts.signal?.aborted) throw abortError()
      const r = await renderBatchLabel(doc, i, target, opts)
      if (r.blocking || r.heightDots !== target.area.heightDots) {
        r.bitmap.free()
        const w = r.warnings.find((x) => x.blocking) ?? r.warnings[0]
        throw new Error(`Label ${i + 1}: ${w?.message ?? 'it cannot be printed as designed.'}`)
      }
      bitmaps.push(r.bitmap)
      lengths.push(r.lengthMm)
      feedMarginMm = r.feedMarginMm
      opts.onProgress?.({ done: i + 1, total })
      // Let the progress paint and input through between labels.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    if (opts.signal?.aborted) throw abortError()
    // Copies per label (A A B B …): every page is its own clone, since encodeJob consumes them.
    const pages: Bitmap1[] = []
    const pageLengths: number[] = []
    try {
      bitmaps.forEach((b, i) => {
        for (let c = 0; c < copies; c++) {
          pages.push(b.clone())
          pageLengths.push(lengths[i] ?? 0)
        }
      })
      const job = encodeJob(target.model, target.media.id, pages, { ...jobOptions(doc), copies: 1 })
      return { job, labels: job.pageCount, tapeMm: estimateTape(pageLengths, feedMarginMm, { leader: opts.leader }).totalMm }
    } finally {
      for (const p of pages) release(p) // consumed by a successful encodeJob; freed otherwise
    }
  } finally {
    for (const b of bitmaps) release(b)
  }
}

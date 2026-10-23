// W3 — RenderResult + doc.print → wasm Job (copies = repeated pages, one job, leader once).
import { encodeJob, release, type Bitmap1, type Job, type JobOptions } from '../wasm'
import { LIMITS, type LabelDoc } from '../doc/schema'
import type { RenderResult, RenderTarget } from './types'

/** Copies per print: the studio's cap (doc schema). The binding accepts up to 999; 99 keeps a
 * job (and its wasm memory) reasonable and matches the 2-digit copies field. */
export const MAX_COPIES = LIMITS.copies.max

/** Tape fed before the first label of a job (head-to-cutter distance, PT-P710BT; approximate).
 * The model table has no per-model value, so every model uses it and the UI says "about". */
export const LEADER_MM = 24

export interface TapeEstimate {
  /** Labels incl. the printer's feed margin at both ends of each, mm. */
  labelsMm: number
  /** Leader counted once per job (0 when `leader` is false), mm. */
  leaderMm: number
  totalMm: number
}

/**
 * Tape a job uses: every page's length plus the feed margin at both ends, plus one leader. Used
 * by the print bar, the batch panel and the tape usage counter (one formula everywhere).
 */
export function estimateTape(pageLengthsMm: readonly number[], feedMarginMm: number, opts: { leader?: boolean } = {}): TapeEstimate {
  const feed = Number.isFinite(feedMarginMm) ? Math.max(0, feedMarginMm) : 0
  const labelsMm = pageLengthsMm.reduce((sum, l) => sum + (Number.isFinite(l) ? Math.max(0, l) : 0) + 2 * feed, 0)
  const leaderMm = opts.leader === false || pageLengthsMm.length === 0 ? 0 : LEADER_MM
  return { labelsMm, leaderMm, totalMm: labelsMm + leaderMm }
}

/** Copies clamped to 1–99 (NaN → 1). */
export function copiesOf(doc: LabelDoc): number {
  const n = Math.round(doc.print.copies)
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_COPIES, n)) : 1
}

/** `doc.print` → core `JobOptions` (everything else keeps the core/tape defaults). */
export function jobOptions(doc: LabelDoc): JobOptions {
  return {
    copies: copiesOf(doc),
    cut: doc.print.autoCut ? 'every-label' : 'none',
    chain: doc.print.chain,
    mirror: doc.print.mirror,
  }
}

/** Why `result` cannot be printed on `target`, or undefined when it can. */
export function printBlocker(result: RenderResult, target: RenderTarget): string | undefined {
  if (result.blocking) {
    const w = result.warnings.find((x) => x.blocking) ?? result.warnings[0]
    return w?.message ?? 'The label cannot be printed as designed.'
  }
  if (result.heightDots !== target.area.heightDots || result.bitmap.height !== target.area.heightDots) {
    return 'The preview was made for a different tape. Wait for it to update, then print again.'
  }
  return undefined
}

/** Pages one job may hold (the wasm binding's limit). */
export const MAX_JOB_PAGES = 999

/** Throws (user-facing) when a job would have more than `MAX_JOB_PAGES` pages (pieces). */
export function tooManyPages(n: number): void {
  if (n > MAX_JOB_PAGES) throw new Error(`That is ${n} pieces; one print job holds at most ${MAX_JOB_PAGES}. Lower the copies.`)
}

/**
 * The pages a render prints as, `[start, end)` in dots: the whole label, or one piece per
 * `result.cuts` gap (a table cut between its columns, docs/TABLE-PLAN.md §3).
 */
export function pageSpans(result: Pick<RenderResult, 'lengthDots' | 'cuts'>): [number, number][] {
  const edges = [0, ...(result.cuts ?? []), result.lengthDots]
  return edges.slice(1).map((e, i) => [edges[i] ?? 0, e])
}

/** Length of every page of `result` (mm), without the feed margins. */
export function pageLengthsMm(result: Pick<RenderResult, 'lengthDots' | 'lengthMm' | 'cuts'>): number[] {
  const mmPerDot = result.lengthDots > 0 ? result.lengthMm / result.lengthDots : 0
  return pageSpans(result).map(([a, b]) => (b - a) * mmPerDot)
}

/**
 * The pieces of a strip that is cut apart by hand at its cut marks (`result.marks`, Cut blocks on
 * a printer without a cutter or with Cut each off, docs/CUT-PLAN.md C5), mm as cut: the first and
 * the last piece carry the printer's feed margin at the strip's ends, the others none. Empty when
 * the strip has no marks.
 */
export function handPiecesMm(result: Pick<RenderResult, 'lengthDots' | 'lengthMm' | 'marks' | 'feedMarginMm'>): number[] {
  const marks = result.marks ?? []
  if (!marks.length) return []
  const mmPerDot = result.lengthDots > 0 ? result.lengthMm / result.lengthDots : 0
  const edges = [0, ...marks, result.lengthDots]
  const last = edges.length - 2
  return edges.slice(1).map((e, i) => (e - (edges[i] ?? 0)) * mmPerDot + (i === 0 ? result.feedMarginMm : 0) + (i === last ? result.feedMarginMm : 0))
}

/**
 * Encodes the rendered label as one job: its page (or its pieces, `pageSpans`) repeated
 * `copies` times inside the core (A B C A B C; the leader is fed once). Throws an Error with a
 * user-facing message when the render is blocking or stale for `target` or has too many pages,
 * and the wasm `PtouchError` from `encodeJob` otherwise. The caller frees the returned Job.
 */
export function buildPrintJob(doc: LabelDoc, result: RenderResult, target: RenderTarget): Job {
  const why = printBlocker(result, target)
  if (why) throw new Error(why)
  const spans = pageSpans(result)
  const copies = copiesOf(doc)
  tooManyPages(spans.length * copies)
  // encodeJob consumes its pages: hand it clones/crops, the preview keeps `result.bitmap`. Copies
  // repeat the pages inside the core (JobOptions.copies), never as N bitmap clones.
  const pages: Bitmap1[] = []
  try {
    for (const [a, b] of spans) pages.push(spans.length === 1 ? result.bitmap.clone() : result.bitmap.cropLines(a, b))
    return encodeJob(target.model, target.media.id, pages, jobOptions(doc))
  } finally {
    for (const p of pages) release(p) // consumed by a successful encodeJob; freed otherwise
  }
}

// W3 — RenderResult + doc.print → wasm Job (copies = repeated pages, one job, leader once).
import { encodeJob, type Job, type JobOptions } from '../wasm'
import { LIMITS, type LabelDoc } from '../doc/schema'
import type { RenderResult, RenderTarget } from './types'

/** Copies per print: the studio's cap (doc schema). The binding accepts up to 999; 99 keeps a
 * job (and its wasm memory) reasonable and matches the 2-digit copies field. */
export const MAX_COPIES = LIMITS.copies.max

/** Tape fed before the first label of a job (head-to-cutter distance, PT-P710BT; approximate). */
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

/**
 * Encodes the rendered label as one job of `copies` pages (the leader is fed once). Throws an
 * Error with a user-facing message when the render is blocking or stale for `target`, and the
 * wasm `PtouchError` from `encodeJob` otherwise. The caller frees the returned Job.
 */
export function buildPrintJob(doc: LabelDoc, result: RenderResult, target: RenderTarget): Job {
  const why = printBlocker(result, target)
  if (why) throw new Error(why)
  // encodeJob consumes its pages: hand it one clone, the preview keeps `result.bitmap`. Copies
  // repeat that page inside the core (JobOptions.copies), never as N bitmap clones.
  return encodeJob(target.model, target.media.id, [result.bitmap.clone()], jobOptions(doc))
}

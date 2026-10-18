// P1 (docs/STUDIO-V1-PLAN.md) — the batch numbers the print bar and the preview row need at start
// (initial JS); the rest of the batch helpers (batch-model.ts, which re-exports these) load with
// the batch panel. Pure (unit-tested in node through batch-model).
import type { LabelDoc } from '../../doc/schema'
import { batchSize } from '../../doc/variables'
import { estimateTape } from '../../render/job'

/** The preview row clamped to the batch (0 without a batch). */
export function clampRow(doc: LabelDoc, row: number): number {
  const n = doc.batch ? Math.max(batchSize(doc), doc.batch.rows.length, 1) : 1
  return Math.max(0, Math.min(n - 1, Math.floor(Number.isFinite(row) ? row : 0)))
}

export interface BatchTape {
  totalMm: number
  /** Every label was measured (otherwise extrapolated from the measured ones). */
  exact: boolean
}

/**
 * Tape for a batch of `labels` × `copies` (render/job.ts estimateTape). `lengthsMm[i]` is label
 * i's measured length, its piece lengths (a table cut between columns: every piece has its own
 * feed margins) or undefined; unmeasured labels count as the average measured one (or
 * `fallbackMm`, e.g. the preview's length or pieces).
 */
export function batchTape(lengthsMm: readonly (number | readonly number[] | undefined)[], labels: number, copies: number, feedMarginMm: number, leader: boolean, fallbackMm: number | readonly number[]): BatchTape {
  const known = lengthsMm.slice(0, labels).filter((l) => l !== undefined)
  const plain = known.every((l) => typeof l === 'number')
  const avg = plain && known.length ? (known as number[]).reduce((a, b) => a + b, 0) / known.length : (known[0] ?? fallbackMm)
  const pages: number[] = []
  for (let i = 0; i < labels; i++) {
    const l = lengthsMm[i] ?? avg
    for (let c = 0; c < copies; c++) pages.push(...(typeof l === 'number' ? [l] : l))
  }
  return { totalMm: estimateTape(pages, feedMarginMm, { leader }).totalMm, exact: known.length >= labels }
}

/**
 * The print bar note for a plain label (`copies` × its pages: one, or the pieces of a table cut
 * between its columns). Same formula as the print itself (studio.print → usage counter):
 * estimateTape, with the leader when the next job feeds one (`studio.tapeLeader`), so the note,
 * the batch note and the counter always agree.
 */
export function singleTapeNote(pagesMm: number | readonly number[], feedMarginMm: number, copies: number, leader: boolean): string {
  const one = typeof pagesMm === 'number' ? [pagesMm] : pagesMm
  const pages = Array.from({ length: Math.max(1, Math.round(copies) || 1) }, () => one).flat()
  const total = estimateTape(pages, feedMarginMm, { leader }).totalMm
  return `Uses about ${formatTape(total)} of tape${leader ? ` incl. the ~24 mm leader${one.length > 1 ? ' before the first piece' : ''}` : ''}.`
}

/** "1.24 m" / "86 mm" for tape totals. */
export function formatTape(mm: number): string {
  return mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`
}

/** Print button copy for a batch: "Print 25 labels" (labels × copies). */
export function batchPrintText(labels: number, copies: number): string {
  const n = labels * copies
  return n === 1 ? 'Print label' : `Print ${n} labels`
}

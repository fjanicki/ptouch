// P1 (docs/STUDIO-V1-PLAN.md) — pure helpers of the batch UI: immutable table / counter edits
// on `BatchData`, empty-cell checks, copy for counters and dates, preview-grid paging and the
// print bar's batch numbers. No Svelte, no DOM (unit-tested in node).
import { LIMITS, VARIABLE_NAME_RE, createBatch, type BatchCounter, type BatchData, type DateFormat, type LabelDoc } from '../../doc/schema'
import { addDays, batchSize, counterValue, formatDate, usedColumns } from '../../doc/variables'
import { estimateTape } from '../../render/job'

/** The doc's batch data, or the defaults (off). */
export function batchOf(doc: LabelDoc): BatchData {
  return doc.batch ?? createBatch()
}

// ---------------------------------------------------------------------------------------------
// Table edits (each returns a new BatchData; the input is never mutated)
// ---------------------------------------------------------------------------------------------

export function setCell(b: BatchData, row: number, col: number, value: string): BatchData {
  if (!b.rows[row] || col < 0 || col >= b.columns.length) return b
  const v = value.slice(0, LIMITS.batchCellChars)
  if (b.rows[row][col] === v) return b
  return { ...b, rows: b.rows.map((r, i) => (i === row ? r.map((c, j) => (j === col ? v : c)) : r)) }
}

/** Adds an empty row after `after` (default: at the end). Unchanged at the row cap. */
export function addRow(b: BatchData, after = b.rows.length - 1): BatchData {
  if (b.rows.length >= LIMITS.batchRows || b.columns.length === 0) return b
  const at = Math.max(0, Math.min(b.rows.length, after + 1))
  const rows = [...b.rows]
  rows.splice(at, 0, b.columns.map(() => ''))
  return { ...b, rows }
}

export function removeRow(b: BatchData, row: number): BatchData {
  if (row < 0 || row >= b.rows.length) return b
  return { ...b, rows: b.rows.filter((_, i) => i !== row) }
}

/** A column name not yet used by a column or counter (`col1`, `col2`, …, or `base`, `base_2`). */
export function freeName(b: BatchData, base = 'col'): string {
  const taken = new Set([...b.columns, ...b.counters.map((c) => c.name)])
  if (base !== 'col' && !taken.has(base) && VARIABLE_NAME_RE.test(base)) return base
  for (let k = base === 'col' ? 1 : 2; ; k++) {
    const name = base === 'col' ? `col${k}` : `${base}_${k}`
    if (!taken.has(name)) return name
  }
}

/** Adds a column (a fresh name, empty cells; a first row when there is none). */
export function addColumn(b: BatchData, name?: string): BatchData {
  if (b.columns.length >= LIMITS.batchColumns) return b
  const col = freeName(b, name ?? 'col')
  const rows = b.rows.length ? b.rows.map((r) => [...r, '']) : [b.columns.map(() => '').concat('')]
  return { ...b, columns: [...b.columns, col], rows }
}

export function removeColumn(b: BatchData, col: number): BatchData {
  if (col < 0 || col >= b.columns.length) return b
  const columns = b.columns.filter((_, j) => j !== col)
  return { ...b, columns, rows: columns.length ? b.rows.map((r) => r.filter((_, j) => j !== col)) : [] }
}

/** Why `name` cannot name column `col` (or a counter at `counter`), or undefined when it can. */
export function nameProblem(b: BatchData, name: string, self: { col?: number; counter?: number }): string | undefined {
  if (!VARIABLE_NAME_RE.test(name)) return 'Use letters, digits and _ (not starting with a digit), up to 32 characters.'
  if (b.columns.some((c, j) => c === name && j !== self.col)) return `A column is already called ${name}.`
  if (b.counters.some((c, k) => c.name === name && k !== self.counter)) return `A counter is already called ${name}.`
  return undefined
}

/** Renames column `col` when the name is valid and free; otherwise unchanged. */
export function renameColumn(b: BatchData, col: number, name: string): BatchData {
  if (col < 0 || col >= b.columns.length || b.columns[col] === name || nameProblem(b, name, { col })) return b
  return { ...b, columns: b.columns.map((c, j) => (j === col ? name : c)) }
}

/** Replaces the table with a parsed one (counters whose names clash with a column are renamed). */
export function replaceTable(b: BatchData, columns: string[], rows: string[][]): BatchData {
  const taken = new Set(columns)
  const counters = b.counters.map((c) => {
    if (!taken.has(c.name)) {
      taken.add(c.name)
      return c
    }
    let name = c.name
    for (let k = 2; taken.has(name); k++) name = `${c.name.slice(0, 32 - String(k).length - 1)}_${k}`
    taken.add(name)
    return { ...c, name }
  })
  return { ...b, columns, rows, counters }
}

// ---------------------------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------------------------

export function addCounter(b: BatchData): BatchData {
  if (b.counters.length >= LIMITS.batchCounters) return b
  const name = freeName(b, 'n')
  return { ...b, counters: [...b.counters, { name, start: 1, step: 1, pad: 0 }] }
}

export function updateCounter(b: BatchData, k: number, patch: Partial<BatchCounter>): BatchData {
  const c = b.counters[k]
  if (!c) return b
  const next: BatchCounter = { ...c, ...patch }
  if (patch.name !== undefined && patch.name !== c.name && nameProblem(b, patch.name, { counter: k })) next.name = c.name
  const lim = LIMITS.counterValue
  next.start = clampInt(next.start, -lim, lim, c.start)
  next.step = clampInt(next.step, -lim, lim, c.step)
  next.pad = clampInt(next.pad, LIMITS.counterPad.min, LIMITS.counterPad.max, c.pad)
  return { ...b, counters: b.counters.map((x, i) => (i === k ? next : x)) }
}

export function removeCounter(b: BatchData, k: number): BatchData {
  if (k < 0 || k >= b.counters.length) return b
  return { ...b, counters: b.counters.filter((_, i) => i !== k) }
}

function clampInt(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.round(v)))
}

/** "001, 002, 003, …" for a counter's first labels. */
export function counterExample(c: BatchCounter, n = 3): string {
  return `${Array.from({ length: n }, (_, i) => counterValue(c, i)).join(', ')}, …`
}

export const DATE_FORMATS: readonly { value: DateFormat; label: string }[] = [
  { value: 'iso', label: 'Year-month-day' },
  { value: 'dmy', label: 'Day/month/year' },
  { value: 'mdy', label: 'Month/day/year' },
  { value: 'long', label: 'Written out' },
]

/** "Day/month/year (08/10/2026)" for the date format picker. */
export function dateFormatLabel(f: DateFormat, now: Date, locale?: string): string {
  const label = DATE_FORMATS.find((d) => d.value === f)?.label ?? f
  return `${label} (${formatDate(now, f, locale)})`
}

/** Example values of the date built-ins, for the help text. */
export function dateExamples(b: BatchData, now: Date, locale?: string): { name: string; value: string }[] {
  return [
    { name: 'today', value: formatDate(now, b.dateFormat, locale) },
    { name: 'today+30d', value: formatDate(addDays(now, 30), b.dateFormat, locale) },
  ]
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

/** Cells that are empty in a column the label uses, as "row,col" keys (0-based). */
export function emptyUsedCells(doc: LabelDoc): Set<string> {
  const out = new Set<string>()
  const b = doc.batch
  if (!b) return out
  const used = new Set(usedColumns(doc))
  const cols = b.columns.map((c, j) => (used.has(c) ? j : -1)).filter((j) => j >= 0)
  b.rows.forEach((r, i) => {
    for (const j of cols) if ((r[j] ?? '').trim() === '') out.add(`${i},${j}`)
  })
  return out
}

/** "Label 3" + the first non-empty used cell (or first cell) as a short caption. */
export function rowCaption(doc: LabelDoc, row: number): string {
  const b = doc.batch
  const r = b?.rows[row]
  if (!b || !r) return `Label ${row + 1}`
  const used = usedColumns(doc)
  const j = used.map((c) => b.columns.indexOf(c)).find((k) => (r[k] ?? '').trim() !== '')
  const v = (j !== undefined ? r[j] : r.find((c) => c.trim() !== '')) ?? ''
  const short = v.length > 24 ? `${v.slice(0, 23)}…` : v
  return short ? `Label ${row + 1}: ${short}` : `Label ${row + 1}`
}

// ---------------------------------------------------------------------------------------------
// Preview grid paging, print bar
// ---------------------------------------------------------------------------------------------

/** Thumbnails / table rows per page (keeps the DOM and the renders bounded at 500 rows). */
export const PAGE_SIZE = 12
export const TABLE_PAGE_SIZE = 20

export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size))
}

/** Page (0-based) that shows `row`. */
export function pageOf(row: number, size: number): number {
  return Math.max(0, Math.floor(row / size))
}

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
 * i's measured length or undefined; unmeasured labels count as the average measured one (or
 * `fallbackMm`, e.g. the preview's length).
 */
export function batchTape(lengthsMm: readonly (number | undefined)[], labels: number, copies: number, feedMarginMm: number, leader: boolean, fallbackMm: number): BatchTape {
  const known = lengthsMm.slice(0, labels).filter((l): l is number => l !== undefined)
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : fallbackMm
  const pages: number[] = []
  for (let i = 0; i < labels; i++) {
    const l = lengthsMm[i] ?? avg
    for (let c = 0; c < copies; c++) pages.push(l)
  }
  return { totalMm: estimateTape(pages, feedMarginMm, { leader }).totalMm, exact: known.length >= labels }
}

/**
 * The print bar note for a plain label (`copies` pages). Same formula as the print itself
 * (studio.print → usage counter): estimateTape, with the leader when the next job feeds one
 * (`studio.tapeLeader`), so the note, the batch note and the counter always agree.
 */
export function singleTapeNote(lengthMm: number, feedMarginMm: number, copies: number, leader: boolean): string {
  const total = estimateTape(new Array<number>(Math.max(1, Math.round(copies) || 1)).fill(lengthMm), feedMarginMm, { leader }).totalMm
  return `Uses about ${formatTape(total)} of tape${leader ? ' incl. the ~24 mm leader' : ''}.`
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

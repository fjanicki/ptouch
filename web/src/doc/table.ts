// Tables (docs/TABLE-PLAN.md §4) — pure cell operations for the table editor and the parser of
// typed or pasted text. Part of the lazy table-editor chunk (TableProps / TableGrid); imports
// only ./schema and ./csv. Every result is rectangular and within LIMITS (tableRows, tableCols,
// tableCellChars); anything changed to get there is reported as a user-facing notice.
import { detectDelimiter, parseRecords } from './csv'
import { LIMITS } from './schema'

export type Cells = string[][]

/** One line of plain text: line breaks and tabs become spaces, at most `tableCellChars`. */
export function cleanCell(v: string): string {
  return v.replace(/\r\n?|[\n\t]/g, ' ').slice(0, LIMITS.tableCellChars)
}

export const rowCount = (cells: Cells): number => cells.length
export const colCount = (cells: Cells): number => cells[0]?.length ?? 0

/** Copy with cell (r, c) set. */
export function setCell(cells: Cells, r: number, c: number, value: string): Cells {
  return cells.map((row, i) => (i === r ? row.map((v, j) => (j === c ? cleanCell(value) : v)) : row))
}

/** A blank row inserted at `at` (0 … rows), unless the table already has the most rows. */
export function insertRow(cells: Cells, at: number): Cells {
  if (cells.length >= LIMITS.tableRows) return cells
  const out = cells.map((r) => [...r])
  out.splice(Math.max(0, Math.min(cells.length, at)), 0, Array.from({ length: Math.max(1, colCount(cells)) }, () => ''))
  return out
}

/** Row `at` removed (the last row is kept, emptied). */
export function removeRow(cells: Cells, at: number): Cells {
  if (cells.length <= 1) return [cells[0]?.map(() => '') ?? ['']]
  return cells.filter((_, i) => i !== at)
}

/** A blank column inserted at `at` (0 … cols), unless the table already has the most columns. */
export function insertColumn(cells: Cells, at: number): Cells {
  if (colCount(cells) >= LIMITS.tableCols) return cells
  return cells.map((row) => {
    const out = [...row]
    out.splice(Math.max(0, Math.min(row.length, at)), 0, '')
    return out
  })
}

/** Column `at` removed (the last column is kept, emptied). */
export function removeColumn(cells: Cells, at: number): Cells {
  if (colCount(cells) <= 1) return cells.map(() => [''])
  return cells.map((row) => row.filter((_, j) => j !== at))
}

/** Pads every row to the longest (at least one cell, one row). */
function rectangular(rows: string[][]): Cells {
  const cols = Math.max(1, ...rows.map((r) => r.length))
  const out = rows.map((r) => Array.from({ length: cols }, (_, j) => r[j] ?? ''))
  return out.length ? out : [['']]
}

export interface ParsedCells {
  cells: Cells
  notices: string[]
}

/** Clamps `rows` to the limits (rows, columns, characters per cell), noting each clamp once. */
function clamp(rows: string[][], notices: string[]): Cells {
  let out = rectangular(rows)
  if (out.length > LIMITS.tableRows) {
    notices.push(`Only the first ${LIMITS.tableRows} rows were kept: a table has at most ${LIMITS.tableRows} rows.`)
    out = out.slice(0, LIMITS.tableRows)
  }
  if (colCount(out) > LIMITS.tableCols) {
    notices.push(`Only the first ${LIMITS.tableCols} columns were kept.`)
    out = out.map((r) => r.slice(0, LIMITS.tableCols))
  }
  let cut = false
  out = out.map((r) =>
    r.map((v) => {
      const s = v.replace(/[\r\n\t]/g, ' ')
      if (s.length > LIMITS.tableCellChars) cut = true
      return s.slice(0, LIMITS.tableCellChars)
    }),
  )
  if (cut) notices.push(`Cells were shortened to ${LIMITS.tableCellChars} characters.`)
  return out
}

/** `"quoted cell"` (`""` inside is one `"`, RFC 4180) or a run of non-spaces. */
const WORD_RE = /"((?:[^"]|"")*)"|(\S+)/g

const blankRow = (r: readonly string[]): boolean => r.every((v) => v.trim() === '')

/**
 * Typed or pasted text → cells. Lines are rows (blank lines are skipped, CRLF/CR/BOM handled);
 * cells are split on tab, `;` or `,` (csv.ts `detectDelimiter`, RFC 4180 quotes), or, when the
 * first line has none of them, on runs of spaces (typed "DO RE MI FA SOL"; a `"quoted cell"`
 * keeps its spaces, `""` is an empty cell). Comma and semicolon cells are trimmed ("DO, RE");
 * tab-separated cells (a spreadsheet, or `cellsToText`) are kept as they are. A line of empty
 * cells ("\t\t", ",,") is a row: a spreadsheet block keeps its shape. Short rows are padded. A
 * tall paste (more rows than a table has, at most that many columns: a copied spreadsheet
 * column) is turned into columns, after dropping empty rows at its end.
 */
export function parseCells(text: string): ParsedCells {
  const notices: string[] = []
  const src = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n')
  const delim = detectDelimiter(src)
  let rows: string[][] = delim
    ? parseRecords(src, delim).map((r) => (delim === '\t' ? r : r.map((v) => v.trim())))
    : src
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => [...l.matchAll(WORD_RE)].map((m) => (m[1] !== undefined ? m[1].replace(/""/g, '"') : (m[2] ?? ''))))
  // Empty rows at the end (a CSV export's ",,,") only count when the table has room for them.
  if (rows.length > LIMITS.tableRows) while (rows.length && blankRow(rows.at(-1) ?? [])) rows.pop()
  if (!rows.length) return { cells: [['']], notices }
  const cols = Math.max(...rows.map((r) => r.length))
  if (rows.length > LIMITS.tableRows && cols <= LIMITS.tableRows) {
    const padded = rectangular(rows)
    rows = Array.from({ length: cols }, (_, j) => padded.map((r) => r[j] ?? ''))
    notices.push(`Turned into columns: a table has at most ${LIMITS.tableRows} rows.`)
  }
  return { cells: clamp(rows, notices), notices }
}

/**
 * `block` pasted with its top-left cell at (r, c): the table grows (up to the limits) to hold
 * it; what does not fit is dropped with a notice.
 */
export function pasteCells(cells: Cells, r: number, c: number, block: Cells): ParsedCells {
  const notices: string[] = []
  const rows = Math.min(LIMITS.tableRows, Math.max(cells.length, r + block.length))
  const cols = Math.min(LIMITS.tableCols, Math.max(colCount(cells), c + colCount(block)))
  if (r + block.length > LIMITS.tableRows || c + colCount(block) > LIMITS.tableCols) notices.push('Some pasted cells did not fit in the table and were left out.')
  const out = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => block[i - r]?.[j - c] ?? cells[i]?.[j] ?? ''))
  return { cells: out, notices }
}

/** Where a key moves in the grid, and whether a column is added first (Enter after the last
 * cell). `undefined` = the key does not move. */
export function moveFrom(rows: number, cols: number, r: number, c: number, key: 'enter' | 'shift-enter' | 'up' | 'down' | 'next' | 'prev'): { r: number; c: number; addColumn?: true } | undefined {
  switch (key) {
    case 'up':
    case 'shift-enter':
      return r > 0 ? { r: r - 1, c } : key === 'shift-enter' && c > 0 ? { r: rows - 1, c: c - 1 } : undefined
    case 'down':
      return r < rows - 1 ? { r: r + 1, c } : undefined
    case 'enter':
      if (r < rows - 1) return { r: r + 1, c }
      if (c < cols - 1) return { r: 0, c: c + 1 }
      return cols < LIMITS.tableCols ? { r: 0, c: cols, addColumn: true } : undefined
    case 'next':
      return c < cols - 1 ? { r, c: c + 1 } : r < rows - 1 ? { r: r + 1, c: 0 } : undefined
    case 'prev':
      return c > 0 ? { r, c: c - 1 } : r > 0 ? { r: r - 1, c: cols - 1 } : undefined
  }
}

/** RFC 4180 quoting: `"…"` with every `"` doubled. */
const quote = (v: string): string => `"${v.replace(/"/g, '""')}"`

/**
 * Cells as text for the "type or paste the whole table" box, written so that `parseCells` reads
 * back exactly these cells (tests/unit/doc/table.test.ts checks it for random tables). Plain
 * cells (no space, quote, comma or semicolon, not empty) are separated by spaces, as typed.
 * Otherwise: several columns are tab-separated, with a cell that has a quote, comma or semicolon
 * quoted (so the first line's only delimiter is the tab); one column is written one quoted
 * cell per line (`"DO RE"`, `""` for an empty cell).
 */
export function cellsToText(cells: Cells): string {
  const special = cells.some((r) => r.some((v) => v === '' || /\s|[",;]/.test(v)))
  if (!special) return cells.map((r) => r.join(' ')).join('\n')
  if (colCount(cells) <= 1) return cells.map((r) => quote(r[0] ?? '')).join('\n')
  return cells.map((r) => r.map((v) => (/[",;]/.test(v) ? quote(v) : v)).join('\t')).join('\n')
}

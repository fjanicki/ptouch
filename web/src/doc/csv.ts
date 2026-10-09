// P1 (docs/STUDIO-V1-PLAN.md) — pasted text / CSV → batch table (BatchData.columns + rows).
// Pure; imports only ./schema.
//
// RFC 4180 with the leniency spreadsheets need: quoted fields (`""` escapes a quote, newlines
// inside quotes), CRLF / LF / CR line ends, a UTF-8 BOM, and `,` `;` or tab as the delimiter
// (whichever occurs most often outside quotes in the header line: Excel in many European locales
// writes `;`, copying cells from a spreadsheet gives tabs). A header line with none of them is a
// single column: the rows are then never split ("Smith, John" stays one value). The header row gives the variable
// names, sanitised to VARIABLE_NAME_RE. Rows are padded / truncated to the header and every
// LIMITS cap (rows, columns, cell length, total size) applies, each with a notice.

import { LIMITS, VARIABLE_NAME_RE } from './schema'

export interface ParsedTable {
  /** Variable names (unique, valid `{{name}}`s). */
  columns: string[]
  /** Cells by column index, every row exactly `columns.length` long. */
  rows: string[][]
  /** User-facing sentences about anything that was changed or dropped. */
  notices: string[]
}

/** `null`: one column (no delimiter; quotes and line breaks still apply). */
export type Delimiter = ',' | ';' | '\t' | null
const DELIMITERS = ['\t', ';', ','] as const // tie-break order

/** Records of `text` split on `delim` (quotes per RFC 4180). Empty lines are skipped. */
export function parseRecords(text: string, delim: Delimiter): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false // inside a quoted section
  let touched = false // the current record has content (or a delimiter)
  const endField = (): void => {
    record.push(field)
    field = ''
  }
  const endRecord = (): void => {
    if (touched) {
      endField()
      records.push(record)
    }
    record = []
    field = ''
    touched = false
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
      continue
    }
    if (c === '"' && field === '') {
      // A quote opens a quoted field only at its start; elsewhere it is a literal character.
      quoted = true
      touched = true
    } else if (delim !== null && c === delim) {
      endField()
      touched = true
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++
      endRecord()
    } else {
      field += c
      touched = true
    }
  }
  endRecord()
  return records
}

/** The delimiter used most outside quotes in the first line (`null` when there is none: a
 * single column, e.g. one copied spreadsheet column whose values contain commas). */
export function detectDelimiter(text: string): Delimiter {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]))
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') quoted = !quoted
    else if (!quoted && (c === '\n' || c === '\r')) break
    else if (!quoted && c !== undefined && counts.has(c)) counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  let best: Delimiter = null
  let max = 0
  for (const d of DELIMITERS) {
    const n = counts.get(d) ?? 0
    if (n > max) {
      best = d
      max = n
    }
  }
  return best
}

/** A header cell as a variable name: accents dropped, other characters and runs of spaces → `_`
 * (none at the ends), at most 32 characters, never starting with a digit; '' when nothing is left. */
export function sanitizeName(raw: string): string {
  let s = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]/g, ' ') // "Serial No." → "Serial_No", not "Serial_No_"
    .trim()
    .replace(/\s+/g, '_')
  if (/^[0-9]/.test(s)) s = `_${s}`
  return s.slice(0, 32)
}

/** `names` made valid and unique (`name`, `name_2`, …; empty → `col<N>`). */
export function uniqueNames(names: readonly string[]): string[] {
  const out: string[] = []
  const taken = new Set<string>()
  names.forEach((raw, j) => {
    const base = sanitizeName(raw) || `col${j + 1}`
    let name = base
    for (let k = 2; taken.has(name) || !VARIABLE_NAME_RE.test(name); k++) {
      const suffix = `_${k}`
      name = base.slice(0, 32 - suffix.length) + suffix
    }
    taken.add(name)
    out.push(name)
  })
  return out
}

/** Pasted text or a CSV file → a batch table (header row = variable names). */
export function parseTable(text: string): ParsedTable {
  const notices: string[] = []
  const body = text.replace(/^﻿/, '')
  const records = parseRecords(body, detectDelimiter(body))
  const header = records[0]
  if (!header) return { columns: [], rows: [], notices: ['No data was found. Paste a table whose first row names the columns.'] }

  let headerCells = header
  if (headerCells.length > LIMITS.batchColumns) {
    notices.push(`Only the first ${LIMITS.batchColumns} columns were kept.`)
    headerCells = headerCells.slice(0, LIMITS.batchColumns)
  }
  const columns = uniqueNames(headerCells)
  const renamed = headerCells.filter((h, j) => h.trim() !== columns[j]).length
  if (renamed) notices.push(`${renamed === 1 ? 'A column name was' : `${renamed} column names were`} adjusted so it can be used as {{name}}.`)

  let data = records.slice(1)
  // Spreadsheets often export trailing rows of empty cells (",,,"): not labels.
  while (data.length && (data.at(-1) ?? []).every((c) => c.trim() === '')) data.pop()
  if (data.length > LIMITS.batchRows) {
    notices.push(`Only the first ${LIMITS.batchRows} rows were kept.`)
    data = data.slice(0, LIMITS.batchRows)
  }
  const rows: string[][] = []
  let ragged = false
  let longCells = false
  let chars = 0
  for (const rec of data) {
    if (rec.length !== columns.length && !(rec.length > columns.length && rec.slice(columns.length).every((c) => c === ''))) ragged = true
    const row = columns.map((_, j) => {
      const v = rec[j] ?? ''
      if (v.length <= LIMITS.batchCellChars) return v
      longCells = true
      return v.slice(0, LIMITS.batchCellChars)
    })
    chars += row.reduce((n, c) => n + c.length, 0)
    if (chars > LIMITS.batchTotalChars) {
      notices.push(`The data is too large; only the first ${rows.length} rows were kept.`)
      break
    }
    rows.push(row)
  }
  if (ragged) notices.push('Some rows had a different number of cells than the header; they were padded or cut to fit.')
  if (longCells) notices.push(`Cells longer than ${LIMITS.batchCellChars} characters were shortened.`)
  return { columns, rows, notices }
}

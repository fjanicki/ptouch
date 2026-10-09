// P1 — pasted text / CSV → batch table (doc/csv.ts).
import { describe, expect, it } from 'vitest'
import { detectDelimiter, parseRecords, parseTable, sanitizeName, uniqueNames } from '../../../src/doc/csv'
import { LIMITS, VARIABLE_NAME_RE } from '../../../src/doc/schema'

describe('parseRecords (RFC 4180)', () => {
  it.each<[string, string, string[][]]>([
    ['plain', 'a,b\n1,2', [['a', 'b'], ['1', '2']]],
    ['quoted fields with delimiters', '"a,b",c\n"1",2', [['a,b', 'c'], ['1', '2']]],
    ['"" escapes a quote', '"say ""hi""",x', [['say "hi"', 'x']]],
    ['newline inside quotes', '"line 1\nline 2",x\ny,z', [['line 1\nline 2', 'x'], ['y', 'z']]],
    ['CRLF', 'a,b\r\n1,2\r\n', [['a', 'b'], ['1', '2']]],
    ['bare CR', 'a,b\r1,2\r', [['a', 'b'], ['1', '2']]],
    ['empty fields', 'a,,c\n,,', [['a', '', 'c'], ['', '', '']]],
    ['empty lines are skipped', 'a\n\n\nb\n\n', [['a'], ['b']]],
    ['a quote inside a field is literal', 'O"Neil,5"', [['O"Neil', '5"']]],
    ['text after a closing quote is kept', '"ab"c,d', [['abc', 'd']]],
    ['unterminated quote runs to the end', '"abc\ndef', [['abc\ndef']]],
  ])('%s', (_, text, out) => {
    expect(parseRecords(text, ',')).toEqual(out)
  })

  it('null: one column, quotes and line breaks still apply', () => {
    expect(parseRecords('Name\nSmith, John\n"Doe; ""Jane""\nJr"', null)).toEqual([['Name'], ['Smith, John'], ['Doe; "Jane"\nJr']])
  })

  it('splits on ; and tab', () => {
    expect(parseRecords('a;b\n1;2', ';')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseRecords('a\tb\n1\t"x\ty"', '\t')).toEqual([['a', 'b'], ['1', 'x\ty']])
  })
})

describe('detectDelimiter', () => {
  it.each<[string, string | null]>([
    ['name,room\nAda,1', ','],
    ['name;room;floor\nAda;1;2', ';'],
    ['name\troom\nAda\t1', '\t'],
    ['"a;b",c\n1;2;3', ','], // the ; is inside quotes in the header
    ['single', null],
    ['"a,b"\nx,y', null], // the only comma of the header is quoted
    ['a;b,c;d', ';'],
    ['a,b;c\td', '\t'], // tie: tab, then ;, then ,
  ])('%j → %j', (text, d) => {
    expect(detectDelimiter(text)).toBe(d)
  })
})

describe('header names', () => {
  it.each<[string, string]>([
    ['name', 'name'],
    ['  first name ', 'first_name'],
    ['Serial No.', 'Serial_No'],
    ['Café', 'Cafe'],
    ['2nd', '_2nd'],
    ['_id', '_id'],
    ['a-b/c', 'a_b_c'],
    ['!!!', ''],
    ['x'.repeat(40), 'x'.repeat(32)],
  ])('%j → %j', (raw, name) => {
    expect(sanitizeName(raw)).toBe(name)
  })

  it('makes names valid and unique', () => {
    const names = uniqueNames(['name', 'Name', 'name', '', '!!', 'x'.repeat(40), 'x'.repeat(32)])
    expect(names).toEqual(['name', 'Name', 'name_2', 'col4', 'col5', 'x'.repeat(32), `${'x'.repeat(30)}_2`])
    for (const n of names) expect(n).toMatch(VARIABLE_NAME_RE)
  })
})

describe('parseTable', () => {
  it('header row = variable names; rows padded / cut to the header', () => {
    const t = parseTable('name,room\nAda,Lab 1\nGrace\nLinus,Lab 3,extra')
    expect(t.columns).toEqual(['name', 'room'])
    expect(t.rows).toEqual([
      ['Ada', 'Lab 1'],
      ['Grace', ''],
      ['Linus', 'Lab 3'],
    ])
    expect(t.notices.join(' ')).toMatch(/different number of cells/)
  })

  it('a single pasted column keeps values with commas whole', () => {
    expect(parseTable('Name\nSmith, John\nDoe, Jane')).toEqual({ columns: ['Name'], rows: [['Smith, John'], ['Doe, Jane']], notices: [] })
    expect(parseTable('Address\n12 Main St, Springfield\n').rows).toEqual([['12 Main St, Springfield']])
  })

  it('strips a UTF-8 BOM and trailing empty rows; semicolons from Excel', () => {
    const t = parseTable('﻿Name;Qty\r\nBolts;10\r\n;\r\n;\r\n')
    expect(t.columns).toEqual(['Name', 'Qty'])
    expect(t.rows).toEqual([['Bolts', '10']])
    expect(t.notices).toEqual([])
  })

  it('tab-separated cells copied from a spreadsheet', () => {
    const t = parseTable('id\tlocation\nA-1\tShelf "B"\n')
    expect(t.columns).toEqual(['id', 'location'])
    expect(t.rows).toEqual([['A-1', 'Shelf "B"']])
  })

  it('sanitises and deduplicates the header with a notice', () => {
    const t = parseTable('first name,first name,\n1,2,3')
    expect(t.columns).toEqual(['first_name', 'first_name_2', 'col3'])
    expect(t.notices.join(' ')).toMatch(/3 column names were adjusted/)
  })

  it('caps rows at LIMITS.batchRows', () => {
    const lines = ['n', ...Array.from({ length: 600 }, (_, i) => String(i))]
    const t = parseTable(lines.join('\n'))
    expect(t.rows).toHaveLength(LIMITS.batchRows)
    expect(t.rows.at(-1)).toEqual(['499'])
    expect(t.notices).toContain('Only the first 500 rows were kept.')
  })

  it('caps columns, cell length and the total size', () => {
    const header = Array.from({ length: 25 }, (_, j) => `c${j}`).join(',')
    const cols = parseTable(`${header}\n${'x,'.repeat(24)}x`)
    expect(cols.columns).toHaveLength(LIMITS.batchColumns)
    expect(cols.rows[0]).toHaveLength(LIMITS.batchColumns)
    expect(cols.notices).toContain(`Only the first ${LIMITS.batchColumns} columns were kept.`)

    const long = parseTable(`a\n${'y'.repeat(LIMITS.batchCellChars + 10)}`)
    expect(long.rows[0]?.[0]).toHaveLength(LIMITS.batchCellChars)
    expect(long.notices.join(' ')).toMatch(/shortened/)

    const row = Array.from({ length: 20 }, () => 'z'.repeat(LIMITS.batchCellChars)).join(',')
    const big = parseTable([header.split(',').slice(0, 20).join(','), ...Array.from({ length: 30 }, () => row)].join('\n'))
    expect(big.rows.length).toBe(Math.floor(LIMITS.batchTotalChars / (20 * LIMITS.batchCellChars)))
    expect(big.notices.join(' ')).toMatch(/too large/)
  })

  it('a header only gives columns without rows; nothing gives a notice', () => {
    expect(parseTable('a,b\n')).toEqual({ columns: ['a', 'b'], rows: [], notices: [] })
    const none = parseTable('\n \n'.replace(' ', ''))
    expect(none.columns).toEqual([])
    expect(none.notices[0]).toMatch(/No data/)
  })
})

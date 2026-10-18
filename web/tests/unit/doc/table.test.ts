// Tables (docs/TABLE-PLAN.md §4) — parsing typed / pasted text into cells and the editor's cell
// operations: always rectangular, within the limits, every clamp reported.
import { describe, expect, it } from 'vitest'
import { LIMITS } from '../../../src/doc/schema'
import { cellsToText, cleanCell, insertColumn, insertRow, moveFrom, parseCells, pasteCells, removeColumn, removeRow, setCell } from '../../../src/doc/table'

describe('parseCells', () => {
  it('splits typed lines on spaces', () => {
    expect(parseCells('DO RE MI FA SOL\nC D E F G')).toEqual({
      cells: [
        ['DO', 'RE', 'MI', 'FA', 'SOL'],
        ['C', 'D', 'E', 'F', 'G'],
      ],
      notices: [],
    })
    expect(parseCells('  DO   RE  \n\n  C  D ').cells).toEqual([
      ['DO', 'RE'],
      ['C', 'D'],
    ])
  })

  it('splits on tabs (spreadsheets), semicolons and commas, with quotes', () => {
    expect(parseCells('DO\tRE\tMI\r\nC\tD\tE\r\n').cells).toEqual([
      ['DO', 'RE', 'MI'],
      ['C', 'D', 'E'],
    ])
    expect(parseCells('DO;RE\nC;D').cells).toEqual([
      ['DO', 'RE'],
      ['C', 'D'],
    ])
    expect(parseCells('"DO, high",RE\nC,D').cells).toEqual([
      ['DO, high', 'RE'],
      ['C', 'D'],
    ])
    expect(parseCells('"La bémol" SOL\nAb G').cells).toEqual([
      ['La bémol', 'SOL'],
      ['Ab', 'G'],
    ])
  })

  it('handles a BOM and CR line ends, keeps empty cells between tabs, pads short rows', () => {
    expect(parseCells('﻿A\t\tC\rD').cells).toEqual([
      ['A', '', 'C'],
      ['D', '', ''],
    ])
  })

  it('turns a tall paste (a spreadsheet column) into columns', () => {
    const r = parseCells(['DO', 'RE', 'MI', 'FA', 'SOL', 'LA', 'SI'].join('\n'))
    expect(r.cells).toEqual([['DO', 'RE', 'MI', 'FA', 'SOL', 'LA', 'SI']])
    expect(r.notices).toEqual([`Turned into columns: a table has at most ${LIMITS.tableRows} rows.`])
    const pairs = parseCells(['DO\tC', 'RE\tD', 'MI\tE', 'FA\tF', 'SOL\tG', 'LA\tA', 'SI\tB'].join('\n'))
    expect(pairs.cells).toEqual([
      ['DO', 'RE', 'MI', 'FA', 'SOL', 'LA', 'SI'],
      ['C', 'D', 'E', 'F', 'G', 'A', 'B'],
    ])
  })

  it('clamps rows, columns and cell length with notices', () => {
    const wide = parseCells(Array.from({ length: 8 }, () => Array.from({ length: 120 }, (_, i) => i).join(' ')).join('\n'))
    expect(wide.cells).toHaveLength(LIMITS.tableRows)
    expect(wide.cells[0]).toHaveLength(LIMITS.tableCols)
    expect(wide.notices).toEqual([`Only the first ${LIMITS.tableRows} rows were kept: a table has at most ${LIMITS.tableRows} rows.`, `Only the first ${LIMITS.tableCols} columns were kept.`])
    const long = parseCells('x'.repeat(50))
    expect(long.cells).toEqual([['x'.repeat(LIMITS.tableCellChars)]])
    expect(long.notices).toEqual([`Cells were shortened to ${LIMITS.tableCellChars} characters.`])
  })

  it('empty text gives one empty cell', () => {
    expect(parseCells(' \n\n').cells).toEqual([['']])
  })

  it('cellsToText reads back the same cells', () => {
    for (const cells of [
      [
        ['DO', 'RE'],
        ['C', 'D'],
      ],
      [
        ['DO', 'DO♯', 'RE'],
        ['', 'RE♭', ''],
      ],
      [['La bémol', 'x']],
      // The review's counter-examples (each changed the table before).
      [['DO RE'], ['C D']],
      [
        ['DO', 'RE'],
        ['', ''],
      ],
      [
        ['', ''],
        ['C', 'D'],
      ],
      [['A'], ['']],
      [['"DO"', 'RE']],
      [['a,b,c', 'd;e', 'f']],
      [[' x ', 'y']],
      [['']],
    ]) {
      expect(parseCells(cellsToText(cells)).cells, JSON.stringify(cells)).toEqual(cells)
    }
  })

  it('cellsToText → parseCells is lossless for random tables', () => {
    // Small deterministic PRNG (mulberry32): the same 2000 tables on every run.
    let seed = 0x5eed
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T
    const VALUES = ['', ' ', 'DO', 'RE♭', 'SOL♯', 'DO RE', ' x', 'y ', '"', '""', 'a"b', '"q"', ',', 'a,b', ';', 'x;y', '\'', '#', 'é', '1', '"a, b"', '  ']
    for (let n = 0; n < 2000; n++) {
      const rows = 1 + Math.floor(rand() * LIMITS.tableRows)
      const cols = 1 + Math.floor(rand() * 6)
      const cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => pick(VALUES)))
      expect(parseCells(cellsToText(cells)).cells, JSON.stringify(cells)).toEqual(cells)
    }
  })

  it('keeps an empty row inside a spreadsheet block, so the cells below stay in place', () => {
    expect(parseCells('DO\tRE\n\t\nC\tD').cells).toEqual([
      ['DO', 'RE'],
      ['', ''],
      ['C', 'D'],
    ])
    expect(parseCells('\t\nC\tD').cells).toEqual([
      ['', ''],
      ['C', 'D'],
    ])
    expect(parseCells('DO,RE\n,\nC,D').cells).toEqual([
      ['DO', 'RE'],
      ['', ''],
      ['C', 'D'],
    ])
    // Blank lines are not rows.
    expect(parseCells('DO\tRE\n\nC\tD\n').cells).toEqual([
      ['DO', 'RE'],
      ['C', 'D'],
    ])
  })

  it('trailing tabs keep their (empty) columns: the copied range, as in a spreadsheet', () => {
    expect(parseCells('DO\tRE\t\t\nC\tD\t\t').cells).toEqual([
      ['DO', 'RE', '', ''],
      ['C', 'D', '', ''],
    ])
  })

  it('a tall paste drops the empty rows at its end before turning into columns', () => {
    const r = parseCells([...['DO', 'RE', 'MI', 'FA', 'SOL', 'LA', 'SI'].map((v) => `${v},`), ',', ','].join('\n'))
    expect(r.cells).toEqual([
      ['DO', 'RE', 'MI', 'FA', 'SOL', 'LA', 'SI'],
      ['', '', '', '', '', '', ''],
    ])
  })

  it('one line of a comma or semicolon list fills several cells', () => {
    expect(parseCells('DO,RE,MI,FA,SOL').cells).toEqual([['DO', 'RE', 'MI', 'FA', 'SOL']])
    expect(parseCells('DO; RE; MI').cells).toEqual([['DO', 'RE', 'MI']])
  })
})

describe('cell operations', () => {
  const cells = [
    ['A', 'B', 'C'],
    ['1', '2', '3'],
  ]

  it('set a cell (single line, at most the cell limit)', () => {
    expect(setCell(cells, 1, 2, 'x\ny')).toEqual([
      ['A', 'B', 'C'],
      ['1', '2', 'x y'],
    ])
    expect(cleanCell('a'.repeat(60))).toHaveLength(LIMITS.tableCellChars)
    expect(cells[1]?.[2]).toBe('3') // not mutated
  })

  it('insert and remove rows and columns, always rectangular', () => {
    expect(insertRow(cells, 1)).toEqual([['A', 'B', 'C'], ['', '', ''], ['1', '2', '3']])
    expect(insertColumn(cells, 3)).toEqual([
      ['A', 'B', 'C', ''],
      ['1', '2', '3', ''],
    ])
    expect(removeRow(cells, 0)).toEqual([['1', '2', '3']])
    expect(removeColumn(cells, 1)).toEqual([
      ['A', 'C'],
      ['1', '3'],
    ])
    // The last row / column is emptied, never removed.
    expect(removeRow([['A', 'B']], 0)).toEqual([['', '']])
    expect(removeColumn([['A'], ['B']], 0)).toEqual([[''], ['']])
  })

  it('stops at the limits', () => {
    const full = Array.from({ length: LIMITS.tableRows }, () => ['x'])
    expect(insertRow(full, 0)).toBe(full)
    const wide = [Array.from({ length: LIMITS.tableCols }, () => 'x')]
    expect(insertColumn(wide, 0)).toBe(wide)
  })

  it('paste fills the grid from a cell and grows it', () => {
    const r = pasteCells(cells, 1, 2, [
      ['p', 'q'],
      ['r', 's'],
    ])
    expect(r.cells).toEqual([
      ['A', 'B', 'C', ''],
      ['1', '2', 'p', 'q'],
      ['', '', 'r', 's'],
    ])
    expect(r.notices).toEqual([])
    const over = pasteCells(cells, 5, 0, [['a'], ['b']])
    expect(over.cells).toHaveLength(LIMITS.tableRows)
    expect(over.notices).toHaveLength(1)
  })

  it('keys: Enter goes down, then to the top of the next column, adding one after the last', () => {
    expect(moveFrom(2, 3, 0, 0, 'enter')).toEqual({ r: 1, c: 0 })
    expect(moveFrom(2, 3, 1, 0, 'enter')).toEqual({ r: 0, c: 1 })
    expect(moveFrom(2, 3, 1, 2, 'enter')).toEqual({ r: 0, c: 3, addColumn: true })
    expect(moveFrom(2, LIMITS.tableCols, 1, LIMITS.tableCols - 1, 'enter')).toBeUndefined()
    expect(moveFrom(2, 3, 0, 1, 'shift-enter')).toEqual({ r: 1, c: 0 })
    expect(moveFrom(2, 3, 1, 1, 'up')).toEqual({ r: 0, c: 1 })
    expect(moveFrom(2, 3, 0, 1, 'up')).toBeUndefined()
    expect(moveFrom(2, 3, 0, 1, 'down')).toEqual({ r: 1, c: 1 })
    expect(moveFrom(2, 3, 0, 2, 'next')).toEqual({ r: 1, c: 0 })
    expect(moveFrom(2, 3, 1, 0, 'prev')).toEqual({ r: 0, c: 2 })
    expect(moveFrom(2, 3, 1, 2, 'next')).toBeUndefined()
  })
})

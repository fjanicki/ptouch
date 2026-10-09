// P1 — pure helpers of the batch UI (ui/batch/batch-model.ts) and the batch print checks.
import { describe, expect, it } from 'vitest'
import { createBatch, createDoc, createItem, LIMITS, type BatchData, type Item, type LabelDoc, type TextItem } from '../../../src/doc/schema'
import { estimateTape, LEADER_MM } from '../../../src/render/job'
import {
  addColumn,
  addCounter,
  addRow,
  batchPrintText,
  batchTape,
  clampRow,
  counterExample,
  dateExamples,
  dateFormatLabel,
  emptyUsedCells,
  formatTape,
  freeName,
  nameProblem,
  pageCount,
  pageOf,
  removeColumn,
  removeCounter,
  removeRow,
  renameColumn,
  replaceTable,
  rowCaption,
  setCell,
  singleTapeNote,
  updateCounter,
} from '../../../src/ui/batch/batch-model'
import { batchBlocker, MAX_BATCH_PAGES, placeholderList } from '../../../src/ui/batch/batch-job'

const text = (t: string): TextItem => ({ ...createItem('text'), text: t })
const doc = (items: Item[], batch?: BatchData, copies = 1): LabelDoc => {
  const d = createDoc({ items, ...(batch ? { batch } : {}) })
  return { ...d, print: { ...d.print, copies } }
}
const table = (): BatchData => createBatch({ enabled: true, columns: ['name', 'room'], rows: [['Ada', 'Lab 1'], ['Grace', '']] })

describe('table edits', () => {
  it('setCell replaces one cell immutably (same object when unchanged)', () => {
    const b = table()
    const next = setCell(b, 1, 1, 'Lab 2')
    expect(next.rows).toEqual([['Ada', 'Lab 1'], ['Grace', 'Lab 2']])
    expect(next.rows[0]).toBe(b.rows[0])
    expect(b.rows[1]).toEqual(['Grace', ''])
    expect(setCell(b, 0, 0, 'Ada')).toBe(b)
    expect(setCell(b, 5, 0, 'x')).toBe(b)
    expect(setCell(b, 0, 0, 'z'.repeat(600)).rows[0]?.[0]).toHaveLength(LIMITS.batchCellChars)
  })

  it('adds and removes rows, up to the cap', () => {
    const b = table()
    expect(addRow(b).rows).toEqual([['Ada', 'Lab 1'], ['Grace', ''], ['', '']])
    expect(addRow(b, 0).rows[1]).toEqual(['', ''])
    expect(removeRow(b, 0).rows).toEqual([['Grace', '']])
    const full = { ...b, rows: Array.from({ length: LIMITS.batchRows }, () => ['a', 'b']) }
    expect(addRow(full)).toBe(full)
    expect(addRow(createBatch())).toEqual(createBatch()) // no columns: nothing to add
  })

  it('adds columns with free names (a first row when empty) and removes them', () => {
    const empty = createBatch()
    const one = addColumn(empty)
    expect(one.columns).toEqual(['col1'])
    expect(one.rows).toEqual([['']])
    expect(addColumn(table()).rows).toEqual([['Ada', 'Lab 1', ''], ['Grace', '', '']])
    expect(addColumn(table(), 'id').columns).toEqual(['name', 'room', 'id'])
    expect(addColumn(table(), 'name').columns).toEqual(['name', 'room', 'name_2'])
    expect(freeName(createBatch(), 'n')).toBe('n_2') // the default counter is called n
    expect(removeColumn(table(), 0)).toMatchObject({ columns: ['room'], rows: [['Lab 1'], ['']] })
    expect(removeColumn(removeColumn(table(), 0), 0)).toMatchObject({ columns: [], rows: [] })
  })

  it('renames only to valid, free names', () => {
    const b = table()
    expect(renameColumn(b, 0, 'who').columns).toEqual(['who', 'room'])
    expect(renameColumn(b, 0, 'room')).toBe(b)
    expect(renameColumn(b, 0, 'n')).toBe(b) // the counter
    expect(renameColumn(b, 0, '1x')).toBe(b)
    expect(nameProblem(b, '1x', { col: 0 })).toMatch(/letters, digits/)
    expect(nameProblem(b, 'room', { col: 0 })).toMatch(/column is already/)
    expect(nameProblem(b, 'n', { col: 0 })).toMatch(/counter is already/)
    expect(nameProblem(b, 'name', { col: 0 })).toBeUndefined()
  })

  it('replaceTable renames counters that clash with a new column', () => {
    const b = replaceTable(createBatch(), ['n', 'name'], [['1', 'a']])
    expect(b.columns).toEqual(['n', 'name'])
    expect(b.counters.map((c) => c.name)).toEqual(['n_2'])
  })
})

describe('counters', () => {
  it('adds (up to 4), updates (clamped, names checked) and removes', () => {
    let b = createBatch()
    b = addCounter(b)
    expect(b.counters.map((c) => c.name)).toEqual(['n', 'n_2'])
    b = addCounter(addCounter(b))
    expect(addCounter(b)).toBe(b)
    expect(b.counters).toHaveLength(LIMITS.batchCounters)
    const u = updateCounter(b, 0, { start: 5.4, step: -2, pad: 99 })
    expect(u.counters[0]).toEqual({ name: 'n', start: 5, step: -2, pad: LIMITS.counterPad.max })
    expect(updateCounter(b, 0, { name: 'n_2' }).counters[0]?.name).toBe('n') // taken
    expect(updateCounter(b, 0, { name: 'id' }).counters[0]?.name).toBe('id')
    expect(updateCounter(b, 0, { start: Number.NaN }).counters[0]?.start).toBe(1)
    expect(removeCounter(b, 0).counters).toHaveLength(3)
  })

  it('shows a live example', () => {
    expect(counterExample({ name: 'n', start: 1, step: 1, pad: 3 })).toBe('001, 002, 003, …')
    expect(counterExample({ name: 'n', start: 10, step: -5, pad: 0 })).toBe('10, 5, 0, …')
  })
})

describe('dates copy', () => {
  const now = new Date(2026, 9, 8)
  it('labels formats with today’s date', () => {
    expect(dateFormatLabel('dmy', now)).toBe('Day/month/year (08/10/2026)')
    expect(dateFormatLabel('long', now, 'en-US')).toBe('Written out (October 8, 2026)')
    expect(dateExamples(createBatch({ dateFormat: 'iso' }), now)).toEqual([
      { name: 'today', value: '2026-10-08' },
      { name: 'today+30d', value: '2026-11-07' },
    ])
  })
})

describe('checks', () => {
  it('flags empty cells only in columns the label uses', () => {
    const d = doc([text('{{name}} {{room}}')], { ...table(), rows: [['', 'Lab 1'], ['Grace', ' ']] })
    expect([...emptyUsedCells(d)]).toEqual(['0,0', '1,1'])
    expect(emptyUsedCells(doc([text('{{name}}')], table())).size).toBe(0) // room is empty but unused
    expect(emptyUsedCells(doc([text('x')])).size).toBe(0)
  })

  it('captions rows with the first used value', () => {
    const d = doc([text('{{room}}')], table())
    expect(rowCaption(d, 0)).toBe('Label 1: Lab 1')
    expect(rowCaption(d, 1)).toBe('Label 2: Grace') // room empty → first non-empty cell
    expect(rowCaption(doc([text('x')]), 3)).toBe('Label 4')
    expect(rowCaption(doc([text('{{name}}')], { ...table(), rows: [['x'.repeat(40), '']] }), 0)).toBe(`Label 1: ${'x'.repeat(23)}…`)
  })

  it('batchBlocker: missing variables, page cap', () => {
    expect(batchBlocker(doc([text('x')]))).toMatch(/off/)
    expect(batchBlocker(doc([text('{{name}} {{nmae}}')], table()))).toBe('Unknown variable {{nmae}}: add a column or counter with that name, or fix the spelling.')
    expect(batchBlocker(doc([text('{{name}}')], table()))).toBeUndefined()
    const many = doc([text('{{n}}')], createBatch({ enabled: true, count: 100 }), 10)
    expect(batchBlocker(many)).toMatch(`at most ${MAX_BATCH_PAGES}`)
    expect(batchBlocker(doc([text('{{n}}')], createBatch({ enabled: true, count: 99 }), 10))).toBeUndefined()
    expect(placeholderList(['a', 'b'])).toBe('{{a}}, {{b}}')
  })

  it('clampRow keeps the preview row inside the batch', () => {
    expect(clampRow(doc([text('x')]), 5)).toBe(0)
    expect(clampRow(doc([text('x')], table()), 5)).toBe(1)
    expect(clampRow(doc([text('x')], createBatch({ enabled: true, count: 10 })), 7)).toBe(7)
    expect(clampRow(doc([text('x')], createBatch({ enabled: true, count: 10 })), -3)).toBe(0)
    expect(clampRow(doc([text('x')], { ...table(), enabled: false }), 1)).toBe(1) // data without batch printing
  })
})

describe('paging, print bar', () => {
  it('pages', () => {
    expect(pageCount(0, 12)).toBe(1)
    expect(pageCount(25, 12)).toBe(3)
    expect(pageOf(11, 12)).toBe(0)
    expect(pageOf(12, 12)).toBe(1)
  })

  it('batchTape is estimateTape over labels × copies; exact once all are measured', () => {
    const all = batchTape([30, 40, 50], 3, 2, 2, true, 99)
    expect(all.exact).toBe(true)
    expect(all.totalMm).toBe(estimateTape([30, 30, 40, 40, 50, 50], 2).totalMm)
    expect(all.totalMm).toBe(2 * (30 + 40 + 50) + 6 * 4 + LEADER_MM)
    const part = batchTape([30, undefined, 50], 3, 1, 2, false, 99)
    expect(part.exact).toBe(false)
    expect(part.totalMm).toBe(30 + 40 + 50 + 3 * 4) // the unmeasured one counts as the average
    expect(batchTape([], 2, 1, 2, false, 25)).toEqual({ totalMm: 2 * (25 + 4), exact: false })
  })

  it('the plain-label note uses the print formula and the next job\'s leader (not the Chain switch)', () => {
    // 50 mm label, 2 mm feed each end, 2 copies.
    const withLeader = estimateTape([50, 50], 2, { leader: true }).totalMm
    expect(withLeader).toBe(2 * 54 + LEADER_MM)
    expect(singleTapeNote(50, 2, 2, true)).toBe(`Uses about ${formatTape(withLeader)} of tape incl. the ~24 mm leader.`)
    // Right after a chained print no leader is fed: the note and the usage counter both drop it.
    expect(singleTapeNote(50, 2, 2, false)).toBe('Uses about 108 mm of tape.')
    expect(singleTapeNote(50, 2, 0, false)).toBe('Uses about 54 mm of tape.')
  })

  it('formats tape and the Print button', () => {
    expect(formatTape(86.4)).toBe('86 mm')
    expect(formatTape(1234)).toBe('1.23 m')
    expect(batchPrintText(25, 1)).toBe('Print 25 labels')
    expect(batchPrintText(3, 2)).toBe('Print 6 labels')
    expect(batchPrintText(1, 1)).toBe('Print label')
  })
})

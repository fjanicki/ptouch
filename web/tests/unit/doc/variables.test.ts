// P1 — variables + batch labels (doc/variables.ts): the frozen contract plus semantics.
import { describe, expect, it } from 'vitest'
import { createBatch, createDoc, createItem, createWifi, LIMITS, type BatchCounter, type CodeItem, type Item, type LabelDoc, type TextItem } from '../../../src/doc/schema'
import {
  addDays,
  batchSize,
  columnsWithoutData,
  counterValue,
  dateOffset,
  findVariables,
  formatDate,
  localDay,
  missingVariables,
  passwordVariable,
  placeholderNames,
  resolveDoc,
  usedColumns,
  usesDates,
  variableKind,
} from '../../../src/doc/variables'

const text = (t: string): TextItem => ({ ...createItem('text'), text: t })
const code = (patch: Partial<CodeItem>): CodeItem => ({ ...createItem('code'), ...patch })
const doc = (items: Item[], patch: Partial<LabelDoc> = {}): LabelDoc => createDoc({ items, ...patch })
/** 8 October 2026, 15:30 local time. */
const NOW = new Date(2026, 9, 8, 15, 30)
const ctx = { now: NOW, locale: 'en-GB' }
const texts = (d: LabelDoc): string[] => d.items.map((i) => (i.kind === 'text' ? i.text : i.kind === 'code' ? (i.content === 'wifi' ? `${i.wifi?.ssid}|${i.wifi?.password}` : i.data) : ''))

describe('variables (frozen contract)', () => {
  it('batchSize: 0 without an enabled batch, rows or count otherwise, capped', () => {
    expect(batchSize(createDoc())).toBe(0)
    expect(batchSize(createDoc({ batch: createBatch({ count: 7 }) }))).toBe(0)
    expect(batchSize(createDoc({ batch: createBatch({ enabled: true, count: 7 }) }))).toBe(7)
    expect(batchSize(createDoc({ batch: createBatch({ enabled: true, columns: ['a'], rows: [['1'], ['2']] }) }))).toBe(2)
    expect(batchSize(createDoc({ batch: createBatch({ enabled: true, count: 10_000 }) }))).toBe(LIMITS.batchRows)
  })

  it('resolveDoc returns the same doc when there is nothing to replace', () => {
    const d = createDoc()
    expect(resolveDoc(d, 0, { now: new Date() })).toEqual({ doc: d, missing: [] })
    expect(resolveDoc(d, 0, { now: new Date() }).doc).toBe(d)
    const plain = doc([text('Hello'), code({ data: 'https://example.com' })], { batch: createBatch({ enabled: true, columns: ['a'], rows: [['1']] }) })
    expect(resolveDoc(plain, 0, ctx).doc).toBe(plain)
  })
})

describe('findVariables / placeholderNames', () => {
  it('lists names in order of appearance, deduplicated, trimming inner spaces', () => {
    expect(placeholderNames('{{a}} {{ b }} {{a}} {{}} {{x y}} {single} {{{c}}}')).toEqual(['a', 'b', '', 'x y', 'c'])
    expect(placeholderNames('no placeholders {{ unclosed')).toEqual([])
  })

  it('scans text, code data and the Wi-Fi fields that are printed', () => {
    const d = doc([
      text('{{name}} in {{room}}'),
      code({ data: '{{id}}' }),
      code({ symbology: 'qr', content: 'wifi', data: '{{stale}}', wifi: createWifi({ ssid: '{{net}}', password: '{{pw}}' }) }),
      code({ symbology: 'code128', content: 'wifi', data: '{{sku}}', wifi: createWifi({ ssid: '{{ignored}}' }) }),
    ])
    expect(findVariables(d)).toEqual(['name', 'room', 'id', 'net', 'pw', 'sku'])
  })
})

describe('counters', () => {
  const c = (start: number, step: number, pad: number): BatchCounter => ({ name: 'n', start, step, pad })
  it.each<[BatchCounter, number, string]>([
    [c(1, 1, 0), 0, '1'],
    [c(1, 1, 0), 9, '10'],
    [c(1, 1, 3), 0, '001'],
    [c(1, 1, 3), 999, '1000'],
    [c(100, 10, 0), 3, '130'],
    [c(5, -2, 0), 4, '-3'],
    [c(1, -1, 2), 2, '-01'],
    [c(-5, 0, 3), 7, '-005'],
    [c(0, 1, 12), 42, '000000000042'],
  ])('%j at %i → %s', (counter, i, out) => {
    expect(counterValue(counter, i)).toBe(out)
  })

  it('A-{{n}} with pad 3 gives A-001, A-002 … for each label', () => {
    const d = doc([text('A-{{n}}')], { batch: createBatch({ enabled: true, count: 3, counters: [{ name: 'n', start: 1, step: 1, pad: 3 }] }) })
    expect([0, 1, 2].map((i) => texts(resolveDoc(d, i, ctx).doc)[0])).toEqual(['A-001', 'A-002', 'A-003'])
  })
})

describe('dates (local calendar)', () => {
  it('parses today, today+Nd and today-Nd up to 3650 days', () => {
    expect(dateOffset('today')).toBe(0)
    expect(dateOffset('today+30d')).toBe(30)
    expect(dateOffset('today-7d')).toBe(-7)
    expect(dateOffset('today+3650d')).toBe(3650)
    expect(dateOffset('today+3651d')).toBeUndefined()
    expect(dateOffset('today+30')).toBeUndefined()
    expect(dateOffset('Today')).toBeUndefined()
  })

  it('adds calendar days across month and year ends (no UTC shift)', () => {
    expect(formatDate(addDays(new Date(2026, 0, 31, 23, 59), 1), 'iso')).toBe('2026-02-01')
    expect(formatDate(addDays(new Date(2026, 11, 31, 0, 1), 1), 'iso')).toBe('2027-01-01')
    expect(formatDate(addDays(new Date(2028, 1, 28, 12), 1), 'iso')).toBe('2028-02-29') // leap year
    expect(formatDate(addDays(new Date(2026, 2, 1, 0, 30), -1), 'iso')).toBe('2026-02-28')
    expect(formatDate(addDays(NOW, 30), 'iso')).toBe('2026-11-07')
    expect(formatDate(addDays(new Date(2026, 9, 25, 1, 0), 0), 'iso')).toBe('2026-10-25') // DST change day in Europe
  })

  it('formats iso, dmy, mdy and long', () => {
    expect(formatDate(NOW, 'iso')).toBe('2026-10-08')
    expect(formatDate(NOW, 'dmy')).toBe('08/10/2026')
    expect(formatDate(NOW, 'mdy')).toBe('10/08/2026')
    expect(formatDate(NOW, 'long', 'en-US')).toBe('October 8, 2026')
    expect(formatDate(NOW, 'long', 'en-GB')).toBe('8 October 2026')
  })

  it('{{today}} uses the batch date format, iso without batch data', () => {
    const items = [text('Packed {{today}}, best before {{today+30d}}, made {{today-7d}}')]
    expect(texts(resolveDoc(doc(items), 0, ctx).doc)[0]).toBe('Packed 2026-10-08, best before 2026-11-07, made 2026-10-01')
    const dmy = doc(items, { batch: createBatch({ dateFormat: 'dmy' }) })
    expect(texts(resolveDoc(dmy, 0, ctx).doc)[0]).toBe('Packed 08/10/2026, best before 07/11/2026, made 01/10/2026')
    const long = doc([text('{{today}}')], { batch: createBatch({ dateFormat: 'long' }) })
    expect(texts(resolveDoc(long, 0, ctx).doc)[0]).toBe('8 October 2026')
  })
})

describe('resolveDoc', () => {
  const table = createBatch({ enabled: true, columns: ['name', 'room'], rows: [['Ada', 'Lab 1'], ['Grace', 'Lab 2'], ['Linus', '']] })

  it('replaces columns from the row, in text and code data', () => {
    const d = doc([text('{{name}} – {{room}}'), code({ data: 'https://example.com/{{name}}' })], { batch: table })
    const r = resolveDoc(d, 1, ctx)
    expect(r.missing).toEqual([])
    expect(texts(r.doc)).toEqual(['Grace – Lab 2', 'https://example.com/Grace'])
    expect(texts(resolveDoc(d, 2, ctx).doc)[0]).toBe('Linus – ') // empty cell
    expect(texts(resolveDoc(d, 99, ctx).doc)[0]).toBe('Linus – ') // clamped to the last row
  })

  it('never mutates the input and keeps unchanged items by reference', () => {
    const plain = text('static')
    const d = doc([plain, text('{{name}}')], { batch: table })
    const before = structuredClone(d)
    const r = resolveDoc(d, 0, ctx)
    expect(d).toEqual(before)
    expect(r.doc).not.toBe(d)
    expect(r.doc.items[0]).toBe(plain)
  })

  it('columns win over counters and built-ins', () => {
    const b = createBatch({ enabled: true, columns: ['n', 'today'], rows: [['col-n', 'col-today']] })
    expect(texts(resolveDoc(doc([text('{{n}} {{today}}')], { batch: b }), 0, ctx).doc)[0]).toBe('col-n col-today')
  })

  it('a disabled batch still resolves the chosen row (the label prints once)', () => {
    const d = doc([text('{{name}} {{n}}')], { batch: { ...table, enabled: false } })
    expect(texts(resolveDoc(d, 1, ctx).doc)[0]).toBe('Grace 2')
  })

  it('unknown names stay visible and are listed once, in order', () => {
    const d = doc([text('{{nmae}} {{name}} {{x y}} {{nmae}}'), code({ data: '{{id}}' })], { batch: table })
    const r = resolveDoc(d, 0, ctx)
    expect(texts(r.doc)).toEqual(['{{nmae}} Ada {{x y}} {{nmae}}', '{{id}}'])
    expect(r.missing).toEqual(['nmae', 'x y', 'id'])
    expect(missingVariables(d)).toEqual(['nmae', 'x y', 'id'])
  })

  it('resolves only once (a value containing {{…}} is printed as is)', () => {
    const b = createBatch({ enabled: true, columns: ['a', 'b'], rows: [['{{b}}', 'B']] })
    const r = resolveDoc(doc([text('{{a}}')], { batch: b }), 0, ctx)
    expect(texts(r.doc)[0]).toBe('{{b}}')
    expect(r.missing).toEqual([])
  })

  it('{{ssid}} is the first Wi-Fi code’s network name (itself resolved)', () => {
    const wifi = code({ symbology: 'qr', content: 'wifi', wifi: createWifi({ ssid: 'Home-{{n}}', password: '{{n}}' }) })
    const d = doc([text('Wi-Fi\n{{ssid}}'), wifi], { batch: createBatch({ enabled: true, count: 2 }) })
    const r = resolveDoc(d, 1, ctx)
    expect(r.missing).toEqual([])
    expect(texts(r.doc)).toEqual(['Wi-Fi\nHome-2', 'Home-2|2'])
    expect(variableKind(d, 'ssid')).toBe('ssid')
  })

  it('a Wi-Fi password is a placeholder only when the whole field is one; other braces are literal', () => {
    const b = createBatch({ enabled: true, columns: ['y', 'pw'], rows: [['Y', 'row-secret']] })
    const literal = doc([code({ symbology: 'qr', content: 'wifi', wifi: createWifi({ ssid: 'Home', password: 'x{{y}}z{{today}}' }) })], { batch: b })
    expect(findVariables(literal)).toEqual([])
    expect(missingVariables(literal)).toEqual([])
    const r = resolveDoc(literal, 0, ctx)
    expect(r.doc).toBe(literal)
    expect(texts(r.doc)).toEqual(['Home|x{{y}}z{{today}}'])
    // Without any batch data a literal brace password never blocks printing either.
    expect(missingVariables(doc([code({ symbology: 'qr', content: 'wifi', wifi: createWifi({ ssid: 'Home', password: 'a{{b}}' }) })]))).toEqual([])

    const whole = doc([code({ symbology: 'qr', content: 'wifi', wifi: createWifi({ ssid: 'Home', password: '{{ pw }}' }) })], { batch: b })
    expect(findVariables(whole)).toEqual(['pw'])
    expect(texts(resolveDoc(whole, 0, ctx).doc)).toEqual(['Home|row-secret'])
    expect(passwordVariable('{{pw}}')).toBe('pw')
    expect(passwordVariable(' {{pw}}')).toBeUndefined()
    expect(passwordVariable('pw')).toBeUndefined()
  })

  it('{{ssid}} stays visible (but is not missing) while the network name is empty', () => {
    const d = doc([text('{{ssid}}'), code({ symbology: 'qr', content: 'wifi', wifi: createWifi() })])
    const r = resolveDoc(d, 0, ctx)
    expect(r.doc).toBe(d)
    expect(r.missing).toEqual([])
  })

  it('{{ssid}} without a Wi-Fi code, or inside the network name itself, is missing', () => {
    expect(resolveDoc(doc([text('{{ssid}}')]), 0, ctx).missing).toEqual(['ssid'])
    const self = doc([code({ symbology: 'qr', content: 'wifi', wifi: createWifi({ ssid: 'x{{ssid}}', password: 'p' }) })])
    expect(resolveDoc(self, 0, ctx).missing).toEqual(['ssid'])
    // A text code switched away from Wi-Fi is not a source.
    expect(variableKind(doc([text('{{ssid}}'), code({ content: 'text', wifi: createWifi({ ssid: 'Net' }) })]), 'ssid')).toBe('missing')
  })

  it('reports kinds and the columns the label uses', () => {
    const d = doc([text('{{name}} {{n}} {{today+1d}} {{nope}}')], { batch: table })
    expect(['name', 'room', 'n', 'today+1d', 'nope'].map((n) => variableKind(d, n))).toEqual(['column', 'column', 'counter', 'date', 'missing'])
    expect(usedColumns(d)).toEqual(['name'])
  })
})

describe('print guards', () => {
  it('columnsWithoutData: used columns of an enabled batch that has no rows', () => {
    const header = createBatch({ enabled: true, columns: ['name', 'room'], rows: [] })
    expect(columnsWithoutData(doc([text('Hi {{name}}')], { batch: header }))).toEqual(['name'])
    expect(columnsWithoutData(doc([text('Hi {{n}}')], { batch: header }))).toEqual([]) // counters only
    expect(columnsWithoutData(doc([text('Hi {{name}}')], { batch: { ...header, rows: [['Ada', '1']] } }))).toEqual([])
    expect(columnsWithoutData(doc([text('Hi {{name}}')], { batch: { ...header, enabled: false } }))).toEqual([])
  })

  it('usesDates / localDay: dated labels re-render when the local day changes', () => {
    expect(usesDates(doc([text('Best before {{today+30d}}')]))).toBe(true)
    expect(usesDates(doc([text('{{n}} {{name}}')]))).toBe(false)
    expect(localDay(new Date(2026, 9, 8, 23, 59))).toBe('2026-10-08')
    expect(localDay(new Date(2026, 9, 9, 0, 0))).toBe('2026-10-09')
  })
})

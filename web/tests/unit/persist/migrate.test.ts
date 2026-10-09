// W5 — schema migrations against fixtures (one per schema version).
import { describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA, MIGRATIONS, migrate } from '../../../src/doc/persist-migrate'
import { createDoc, createItem } from '../../../src/doc/schema'
import { fixture } from './helpers'

describe('migrate()', () => {
  it('has a migration step for every older schema', () => {
    for (let n = 0; n < CURRENT_SCHEMA; n++) expect(MIGRATIONS[n], `step ${n} → ${n + 1}`).toBeTypeOf('function')
  })

  it('accepts a current (schema 2) document unchanged', () => {
    const raw = fixture('schema-2.json')
    const r = migrate(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.readOnly).toBe(false)
    expect(r.migratedFrom).toBeUndefined()
    expect(r.doc).toEqual(raw)
  })

  it('upgrades schema 1 so it prints exactly as before', () => {
    const raw = fixture('schema-1.json') as { items: Record<string, unknown>[] }
    const r = migrate(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.migratedFrom).toBe(1)
    expect(r.readOnly).toBe(false)
    expect(r.doc.schema).toBe(2)
    // Only code items change: quiet zone true → 'standard', content 'text', module size KEPT
    // (only new items default to 'auto').
    const [text, code] = r.doc.items
    expect(text).toEqual(raw.items[0])
    expect(code).toEqual({ ...raw.items[1], content: 'text', quietZone: 'standard', moduleDots: 2 })
    expect(r.doc.batch).toBeUndefined()
    const { schema: _a, items: _b, ...rest } = raw as Record<string, unknown>
    void _a
    void _b
    expect(r.doc).toMatchObject(rest)
  })

  it('maps a schema-1 quiet zone of false to none and keeps every module size', () => {
    const raw = fixture('schema-1.json') as { items: Record<string, unknown>[] }
    raw.items = [5, 1, 12].map((moduleDots, i) => ({ ...raw.items[1], id: `c${i}`, moduleDots, quietZone: i !== 1 }))
    const r = migrate(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doc.items.map((i) => (i.kind === 'code' ? [i.moduleDots, i.quietZone] : null))).toEqual([
      [5, 'standard'],
      [1, 'none'],
      [12, 'standard'],
    ])
  })

  it('new code items default to automatic module size and the standard quiet zone', () => {
    expect(createItem('code')).toMatchObject({ content: 'text', moduleDots: 'auto', quietZone: 'standard' })
  })

  it('does not mutate its input', () => {
    const raw = fixture('schema-0.json')
    const before = JSON.stringify(raw)
    migrate(raw)
    expect(JSON.stringify(raw)).toBe(before)
  })

  it('upgrades unversioned (schema 0) JSON by filling defaults', () => {
    const r = migrate(fixture('schema-0.json'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.migratedFrom).toBe(0)
    expect(r.readOnly).toBe(false)
    expect(r.doc.schema).toBe(2)
    expect(r.doc.name).toBe('Prototype label')
    expect(r.doc.tape.widthMm).toBe(24)
    expect(r.doc.length).toEqual({ mode: 'auto' })
    expect(r.doc.print.copies).toBe(1)
    expect(r.doc.items).toHaveLength(1)
    expect(typeof r.doc.id).toBe('string')
  })

  it('opens documents from a newer schema read-only', () => {
    const r = migrate(fixture('schema-99.json'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.readOnly).toBe(true)
    expect(r.migratedFrom).toBe(99)
    expect(r.doc.name).toBe('From the future')
  })

  it('round-trips a fresh document through JSON', () => {
    const doc = createDoc()
    const r = migrate(JSON.parse(JSON.stringify(doc)))
    expect(r.ok && r.doc).toMatchObject(doc)
  })

  it.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a string', 'hello'],
    ['an object without schema or items', { name: 'x' }],
    ['a negative schema', { schema: -1, items: [] }],
    ['a non-integer schema', { schema: 1.5, items: [] }],
  ])('rejects %s', (_label, raw) => {
    const r = migrate(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems.length).toBeGreaterThan(0)
  })
})

describe('untrusted input hardening', () => {
  it('schema 0: a "__proto__" key never replaces the prototype or leaks into the document', () => {
    const raw = JSON.parse('{"items":[],"__proto__":{"frame":{"thicknessMm":3},"polluted":1}}') as Record<string, unknown>
    const out = MIGRATIONS[0]!(structuredClone(raw))
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect((out as { polluted?: unknown }).polluted).toBeUndefined()
    const r = migrate(raw)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc.frame).toBeUndefined()
  })

  it('caps the error text built from a hostile schema value', () => {
    const r = migrate({ schema: 'z'.repeat(20_000), items: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems.join(' ').length).toBeLessThan(200)
  })
})

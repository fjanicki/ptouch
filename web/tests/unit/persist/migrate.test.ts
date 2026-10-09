// W5 — schema migrations against fixtures (one per schema version).
import { describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA, MIGRATIONS, migrate } from '../../../src/doc/persist-migrate'
import { createDoc, createItem } from '../../../src/doc/schema'
import { fixture } from './helpers'

describe('migrate()', () => {
  it('has a migration step for every older schema', () => {
    for (let n = 0; n < CURRENT_SCHEMA; n++) expect(MIGRATIONS[n], `step ${n} → ${n + 1}`).toBeTypeOf('function')
  })

  it('accepts a current (schema 3) document unchanged', () => {
    const raw = fixture('schema-3.json')
    const r = migrate(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.readOnly).toBe(false)
    expect(r.migratedFrom).toBeUndefined()
    expect(r.doc).toEqual(raw)
    // The schema-3 fields survive: point size, a library font, shrink to fit length.
    expect(r.doc.items[1]).toMatchObject({ fontFamily: 'oswald', size: { mode: 'pt', pt: 10.5 } })
    expect(r.doc.length).toEqual({ mode: 'fixed', mm: 36, shrink: true })
  })

  it('schema 2 → 3 marks fixed-size (mm) text clipTall, so it keeps v1’s clipping; fit text and other items are untouched', () => {
    const text = (size: unknown) => ({ ...createItem('text'), size })
    const fit = text({ mode: 'fit' })
    const mm = text({ mode: 'mm', mm: 6 })
    const legacy = text(6)
    const icon = { ...createItem('icon'), size: { mode: 'mm', mm: 6 } }
    const raw = { ...createDoc({ items: [] }), schema: 2, items: [fit, mm, legacy, icon] }
    const r = migrate(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doc.items[0]).toEqual(fit)
    expect(r.doc.items[1]).toEqual({ ...mm, clipTall: true })
    expect(r.doc.items[2]).toMatchObject({ size: { mode: 'mm', mm: 6 }, clipTall: true })
    expect(r.doc.items[3]).toEqual(icon)
    // A schema-3 document keeps the flag through validation (share links, history, files).
    const again = migrate(r.doc)
    expect(again.ok && again.doc.items[1]).toEqual({ ...mm, clipTall: true })
    // Only `true` is read; anything else is dropped.
    const odd = migrate({ ...r.doc, items: [{ ...mm, clipTall: 'yes' }] })
    expect(odd.ok && odd.doc.items[0]).toEqual(mm)
  })

  it('upgrades schema 2 by changing nothing but the version (renders pixel-identically)', () => {
    const raw = fixture('schema-2.json') as Record<string, unknown>
    const r = migrate(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.migratedFrom).toBe(2)
    expect(r.readOnly).toBe(false)
    expect(r.doc).toEqual({ ...raw, schema: 3 })
    // No `shrink` appears on a fixed length that did not have it.
    expect(r.doc.length).toEqual({ mode: 'fixed', mm: 40 })
  })

  it('a schema-3 label opened by a schema-2 reader would be read-only (newer-version path)', () => {
    const raw = { ...(fixture('schema-3.json') as Record<string, unknown>), schema: CURRENT_SCHEMA + 1 }
    const r = migrate(raw)
    expect(r.ok && r.readOnly).toBe(true)
  })

  it('upgrades schema 1 so it prints exactly as before', () => {
    const raw = fixture('schema-1.json') as { items: Record<string, unknown>[] }
    const r = migrate(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.migratedFrom).toBe(1)
    expect(r.readOnly).toBe(false)
    expect(r.doc.schema).toBe(3)
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
    expect(r.doc.schema).toBe(3)
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

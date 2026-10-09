// W3 — schema factories, ops immutability, history (undo/redo/coalesce), validateDoc.
import { describe, expect, it } from 'vitest'
import { createBatch, createDoc, createItem, FONT_FAMILY_IDS, LIMITS, SCHEMA_VERSION, validateDoc, type ItemKind, type LabelDoc, type TextItem } from '../../../src/doc/schema'
import { addItem, duplicateItem, moveItem, removeItem, updateDoc, updateItem } from '../../../src/doc/ops'
import { COALESCE_MS, createHistory } from '../../../src/doc/history'

const KINDS: ItemKind[] = ['text', 'icon', 'code', 'image', 'shape', 'spacer']

/** Deep-freezes a doc so any mutation by an op throws. */
function frozen<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    for (const k of Object.keys(v)) frozen((v as Record<string, unknown>)[k])
    Object.freeze(v)
  }
  return v
}

describe('schema', () => {
  it('creates a 24 mm flow label with one text block', () => {
    const d = createDoc()
    expect(d.schema).toBe(SCHEMA_VERSION)
    expect(d.tape.widthMm).toBe(24)
    expect(d.items.map((i) => i.kind)).toEqual(['text'])
  })

  it('every factory item survives validation unchanged', () => {
    const d = createDoc({ items: KINDS.map((k) => createItem(k)) })
    const v = validateDoc(JSON.parse(JSON.stringify(d)))
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.doc).toEqual(d)
    expect(v.notices).toEqual([])
  })
})

describe('ops', () => {
  it('never mutate the input', () => {
    const d = frozen(createDoc())
    const [d2, id] = addItem(d, 'code')
    expect(d.items).toHaveLength(1)
    expect(moveItem(d2, id, 0).items[0]?.id).toBe(id)
    expect(createItem('spacer').kind).toBe('spacer')
    const textId = d.items[0]?.id ?? ''
    expect(updateItem<TextItem>(d, textId, { text: 'Hi' }).items[0]).toMatchObject({ text: 'Hi', kind: 'text' })
    expect(removeItem(d, textId).items).toHaveLength(0)
    expect(updateDoc(d, { name: 'x' }).name).toBe('x')
    expect(d.name).toBe('Untitled label')
  })

  it('updateItem drops clipTall (v1 clipping) when the text size changes, and only then', () => {
    const t: TextItem = { ...(createItem('text') as TextItem), size: { mode: 'mm', mm: 9 }, clipTall: true }
    const d = frozen(createDoc({ items: [t] }))
    expect(updateItem<TextItem>(d, t.id, { text: 'Hi' }).items[0]).toMatchObject({ clipTall: true })
    expect(updateItem<TextItem>(d, t.id, { fontFamily: 'oswald' }).items[0]).toMatchObject({ clipTall: true })
    const resized = updateItem<TextItem>(d, t.id, { size: { mode: 'mm', mm: 4 } }).items[0]
    expect(resized).toMatchObject({ size: { mode: 'mm', mm: 4 } })
    expect(resized && 'clipTall' in resized).toBe(false)
    expect(d.items[0]).toMatchObject({ clipTall: true })
  })

  it('addItem inserts after the given item', () => {
    const [d1, a] = addItem(createDoc({ items: [] }), 'text')
    const [d2, b] = addItem(d1, 'icon')
    const [d3, c] = addItem(d2, 'code', a)
    expect(d3.items.map((i) => i.id)).toEqual([a, c, b])
  })

  it('duplicateItem deep-copies right after the source with a new id', () => {
    const base = frozen(createDoc({ items: [createItem('text'), { ...createItem('icon'), frame: { xMm: 1, yMm: 1, wMm: 5, hMm: 5, rotation: 0 } }] }))
    const [first, second] = base.items
    const [d, id] = duplicateItem(base, first?.id ?? '')
    expect(d.items).toHaveLength(3)
    expect(d.items[1]?.id).toBe(id)
    expect(id).not.toBe(first?.id)
    expect({ ...d.items[1], id: 'x' }).toEqual({ ...first, id: 'x' })
    const [d2, id2] = duplicateItem(base, second?.id ?? '')
    expect(d2.items[2]?.frame).toEqual({ xMm: 3, yMm: 3, wMm: 5, hMm: 5, rotation: 0 })
    expect(d2.items[2]?.id).toBe(id2)
    expect(duplicateItem(base, 'missing')).toEqual([base, ''])
  })
})

describe('history', () => {
  const docs = (n: number): LabelDoc[] => Array.from({ length: n }, (_, i) => createDoc({ name: `v${i}` }))

  it('undo / redo walk the snapshots; a new edit clears redo', () => {
    const [a, b, c, d] = docs(4) as [LabelDoc, LabelDoc, LabelDoc, LabelDoc]
    const h = createHistory(a)
    expect(h.canUndo).toBe(false)
    h.push(b)
    h.push(c)
    expect(h.undo()).toBe(b)
    expect(h.undo()).toBe(a)
    expect(h.undo()).toBeUndefined()
    expect(h.canRedo).toBe(true)
    expect(h.redo()).toBe(b)
    h.push(d)
    expect(h.canRedo).toBe(false)
    expect(h.redo()).toBeUndefined()
    expect(h.undo()).toBe(b)
  })

  it('coalesces edits with the same key within 1 s', () => {
    let t = 0
    const [a, b, c, d, e] = docs(5) as [LabelDoc, LabelDoc, LabelDoc, LabelDoc, LabelDoc]
    const h = createHistory(a, 200, () => t)
    h.push(b, 'text:1')
    t += 300
    h.push(c, 'text:1') // merged into b's step
    t += 300
    h.push(d, 'text:2') // other key → new step
    t += COALESCE_MS + 1
    h.push(e, 'text:2') // too late → new step
    expect(h.undo()).toBe(d)
    expect(h.undo()).toBe(c)
    expect(h.undo()).toBe(a)
    expect(h.canUndo).toBe(false)
  })

  it('does not coalesce across an undo', () => {
    let t = 0
    const [a, b, c] = docs(3) as [LabelDoc, LabelDoc, LabelDoc]
    const h = createHistory(a, 200, () => t)
    h.push(b, 'k')
    h.undo()
    t += 10
    h.push(c, 'k')
    expect(h.undo()).toBe(a)
  })

  it('keeps at most `capacity` snapshots', () => {
    const all = docs(10)
    const h = createHistory(all[0] as LabelDoc, 4)
    for (const d of all.slice(1)) h.push(d)
    const seen: string[] = []
    for (let d = h.undo(); d; d = h.undo()) seen.push(d.name)
    expect(seen).toEqual(['v8', 'v7', 'v6'])
  })

  it('reset forgets everything', () => {
    const [a, b, c] = docs(3) as [LabelDoc, LabelDoc, LabelDoc]
    const h = createHistory(a)
    h.push(b)
    h.reset(c)
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
    expect(h.undo()).toBeUndefined()
  })

  it('pushing the present again is a no-op', () => {
    const [a] = docs(1) as [LabelDoc]
    const h = createHistory(a)
    h.push(a)
    expect(h.canUndo).toBe(false)
  })
})

describe('validateDoc', () => {
  it('rejects things that are not current-schema labels', () => {
    for (const raw of [null, 42, 'x', [], {}, { schema: 1, items: [] }, { schema: 2, items: [] }, { schema: 4, items: [] }, { schema: 3 }, { schema: 3, items: {} }]) {
      const v = validateDoc(raw)
      expect(v.ok, JSON.stringify(raw)).toBe(false)
      if (!v.ok) expect(v.problems[0]).toMatch(/not a ptouch label document/)
    }
  })

  it('fills a minimal document with defaults', () => {
    const v = validateDoc({ schema: SCHEMA_VERSION, items: [] })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.doc).toMatchObject({ tape: { widthMm: 24 }, length: { mode: 'auto' }, marginsMm: { start: 2, end: 2 }, layout: { mode: 'flow', gapMm: 3, align: 'center' }, print: { copies: 1, autoCut: true, threshold: 128 } })
    expect(v.doc.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('clamps numbers and repairs enums with readable notices', () => {
    const d = createDoc({ items: [] }) as unknown as Record<string, unknown>
    const v = validateDoc({
      ...d,
      tape: { widthMm: 13 },
      length: { mode: 'fixed', mm: 5000 },
      print: { copies: 500, autoCut: 'yes', chain: false, mirror: false, threshold: -4 },
      items: [
        { id: 'c', kind: 'code', symbology: 'pdf417', data: 123, moduleDots: 0, quietZone: true, ecc: 'Z', showText: false },
        { id: 't', kind: 'text', text: 'Hi', fontFamily: 'Comic Sans', fontWeight: 650, italic: false, size: { mode: 'mm', mm: 999 }, align: 'middle', lineHeight: 'x', invert: false },
      ],
    })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.doc.tape.widthMm).toBe(12)
    expect(v.doc.length).toEqual({ mode: 'fixed', mm: 1000 })
    expect(v.doc.print).toEqual({ copies: 99, autoCut: true, chain: false, mirror: false, threshold: 0 })
    expect(v.doc.items[0]).toMatchObject({ kind: 'code', symbology: 'qr', data: '123', moduleDots: 1, ecc: 'M' })
    expect(v.doc.items[1]).toMatchObject({ kind: 'text', fontFamily: 'fira-sans', fontWeight: 600, size: { mode: 'mm', mm: 100 }, align: 'center', lineHeight: 1.1 })
    const all = v.notices.join('\n')
    expect(all).toMatch(/tape: width 13 mm is not a TZe width; using 12 mm/)
    expect(all).toMatch(/print: copies 500 out of range; clamped to 99/)
    expect(all).toMatch(/item 1 \(code\): symbology "pdf417" is not supported/)
    expect(all).toMatch(/item 2 \(text\): fontFamily "Comic Sans" is not supported/)
  })

  it('drops unknown kinds and fixes duplicate ids', () => {
    const d = createDoc({ items: [] }) as unknown as Record<string, unknown>
    const v = validateDoc({ ...d, items: [{ id: 'a', kind: 'spacer', widthMm: 4 }, { id: 'a', kind: 'spacer', widthMm: 4 }, { id: 'z', kind: 'hologram' }, 'junk'] })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.doc.items).toHaveLength(2)
    expect(v.doc.items[0]?.id).toBe('a')
    expect(v.doc.items[1]?.id).not.toBe('a')
    expect(v.notices.join('\n')).toMatch(/unknown kind "hologram"; dropped/)
    expect(v.notices.join('\n')).toMatch(/item 4 is not an object; dropped/)
  })

  it('keeps inlined image data URLs, drops anything else', () => {
    const d = createDoc({ items: [] }) as unknown as Record<string, unknown>
    const img = { ...createItem('image'), blobRef: 'sha-1' }
    const v = validateDoc({ ...d, items: [{ ...img, dataUrl: 'data:image/png;base64,AAAA' }, { ...img, id: 'x', dataUrl: 'javascript:alert(1)' }] })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.doc.items[0]).toMatchObject({ dataUrl: 'data:image/png;base64,AAAA' })
    expect(v.doc.items[1]).not.toHaveProperty('dataUrl')
  })

  it('returns a new object and strips unknown fields', () => {
    const raw = { ...createDoc(), extra: true } as unknown
    const v = validateDoc(raw)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.doc).not.toBe(raw)
    expect(v.doc).not.toHaveProperty('extra')
  })
})

describe('validateDoc: untrusted documents', () => {
  const base = () => ({ ...createDoc(), items: [] as unknown[] }) as Record<string, unknown>

  it('caps the number of blocks and the total text', () => {
    const many = { ...base(), items: Array.from({ length: 37_000 }, () => ({ kind: 'text', text: 'x' })) }
    const r = validateDoc(many)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.doc.items.length).toBe(200)
      expect(r.notices.join(' ')).toMatch(/first 200/)
    }
    const long = { ...base(), items: Array.from({ length: 50 }, () => ({ kind: 'text', text: 'y'.repeat(4000) })) }
    const r2 = validateDoc(long)
    expect(r2.ok && r2.doc.items.length).toBe(10)
  })

  it('rejects oversized ids, media ids, timestamps and non-colour strings', () => {
    const doc = { ...base(), id: 'i'.repeat(100_000), createdAt: 'c'.repeat(50_000), tape: { widthMm: 24, mediaId: 'm'.repeat(70_000), colors: { tape: 'url(x);'.repeat(1000), ink: 'expression()' } } }
    const r = validateDoc(doc)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doc.id.length).toBeLessThanOrEqual(64)
    expect(r.doc.createdAt.length).toBeLessThanOrEqual(40)
    expect(r.doc.tape.mediaId).toBeUndefined()
    expect(r.doc.tape.colors).toBeUndefined()
    const ok = validateDoc({ ...base(), tape: { widthMm: 12, mediaId: 'tze231-12', colors: { tape: '#FFD400', ink: '#000' } } })
    expect(ok.ok && ok.doc.tape).toEqual({ widthMm: 12, mediaId: 'tze231-12', colors: { tape: '#FFD400', ink: '#000' } })
  })
})

describe('validateDoc (schema 3 fields)', () => {
  const base = () => createDoc({ items: [] }) as unknown as Record<string, unknown>

  it('keeps point sizes, every library font and shrink to fit length', () => {
    const items = FONT_FAMILY_IDS.map((fontFamily, i) => ({ ...createItem('text'), id: `t${i}`, fontFamily, size: { mode: 'pt', pt: 4 + i * 5.5 } }))
    const v = validateDoc({ ...base(), length: { mode: 'fixed', mm: 40, shrink: true }, items })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.notices).toEqual([])
    expect(v.doc.items).toEqual(items)
    expect(v.doc.length).toEqual({ mode: 'fixed', mm: 40, shrink: true })
  })

  it('clamps point sizes and repairs a malformed one', () => {
    const v = validateDoc({
      ...base(),
      items: [
        { ...createItem('text'), id: 'a', size: { mode: 'pt', pt: 1 } },
        { ...createItem('text'), id: 'b', size: { mode: 'pt', pt: 1000 } },
        { ...createItem('text'), id: 'c', size: { mode: 'pt', pt: 'huge' } },
        { ...createItem('text'), id: 'd', size: { mode: 'em', em: 2 } },
      ],
    })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.doc.items.map((i) => (i.kind === 'text' ? i.size : null))).toEqual([
      { mode: 'pt', pt: LIMITS.sizePt.min },
      { mode: 'pt', pt: LIMITS.sizePt.max },
      { mode: 'pt', pt: 12 },
      { mode: 'fit' },
    ])
    expect(v.notices).toHaveLength(4)
  })

  it('accepts a point size only on text blocks', () => {
    const v = validateDoc({ ...base(), items: [{ ...createItem('icon'), id: 'i', size: { mode: 'pt', pt: 12 } }] })
    expect(v.ok && v.doc.items[0]).toMatchObject({ size: { mode: 'fit' } })
    expect(v.ok && v.notices.join()).toMatch(/size was malformed/)
  })

  it('an unknown font family falls back to Fira Sans with a notice', () => {
    const v = validateDoc({ ...base(), items: [{ ...createItem('text'), id: 'a', fontFamily: 'comic-sans' }] })
    expect(v.ok && v.doc.items[0]).toMatchObject({ fontFamily: 'fira-sans' })
    expect(v.ok && v.notices.join()).toMatch(/fontFamily "comic-sans" is not supported/)
  })

  it('shrink is only kept on a fixed length, and only when on', () => {
    const read = (length: unknown) => {
      const v = validateDoc({ ...base(), length })
      return v.ok ? v.doc.length : null
    }
    expect(read({ mode: 'fixed', mm: 30, shrink: false })).toEqual({ mode: 'fixed', mm: 30 })
    expect(read({ mode: 'fixed', mm: 30 })).toEqual({ mode: 'fixed', mm: 30 })
    expect(read({ mode: 'auto', shrink: true })).toEqual({ mode: 'auto' })
    expect(read({ mode: 'fixed', mm: 30, shrink: 'yes' })).toEqual({ mode: 'fixed', mm: 30 })
  })

  it('new text items still default to fit (the studio applies the user default on insert)', () => {
    expect(createItem('text').size).toEqual({ mode: 'fit' })
  })
})

describe('validateDoc (schema 2 fields)', () => {
  const base = () => createDoc({ items: [] }) as unknown as Record<string, unknown>

  it('keeps Wi-Fi, DataMatrix, quiet-zone modes, auto module size and custom fonts', () => {
    const items = [
      { id: 'w', kind: 'code', symbology: 'qr', content: 'wifi', data: '', wifi: { ssid: 'Home', password: 'pw;1', security: 'wep', hidden: true }, moduleDots: 'auto', quietZone: 'compact', ecc: 'Q', showText: false },
      { id: 'd', kind: 'code', symbology: 'datamatrix', content: 'text', data: 'A-001', moduleDots: 4, quietZone: 'none', ecc: 'M', showText: false },
      { ...createItem('text'), id: 'u', customFont: { kind: 'user', ref: 'sha256-0123456789abcdef0123456789abcdef', family: 'Inter' } },
      { ...createItem('text'), id: 'l', customFont: { kind: 'local', postscriptName: 'Helvetica-Bold', family: 'Helvetica' } },
    ]
    const v = validateDoc({ ...base(), items })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.notices).toEqual([])
    expect(v.doc.items).toEqual(items)
  })

  it('accepts a schema-1 style boolean quiet zone and repairs bad v2 values', () => {
    const v = validateDoc({
      ...base(),
      items: [
        { id: 'a', kind: 'code', symbology: 'qr', data: 'x', moduleDots: 'big', quietZone: false, ecc: 'M', showText: false },
        { id: 'b', kind: 'code', symbology: 'qr', content: 'telepathy', data: 'x', moduleDots: 3, quietZone: 'wide', ecc: 'M', showText: false, wifi: { ssid: 's'.repeat(100), security: 'wpa9', hidden: 'no' } },
        { ...createItem('text'), id: 'c', customFont: { kind: 'user', ref: '../../etc/passwd', family: 'X' } },
        { ...createItem('text'), id: 'd', customFont: { kind: 'local', postscriptName: 'Evil") ; url(x', family: 'X' } },
      ],
    })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const [a, b, c, d] = v.doc.items
    expect(a).toMatchObject({ content: 'text', moduleDots: 3, quietZone: 'none' })
    expect(b).toMatchObject({ content: 'text', quietZone: 'standard', wifi: { ssid: 's'.repeat(64), password: '', security: 'wpa', hidden: false } })
    expect(c && 'customFont' in c).toBe(false)
    expect(d && 'customFont' in d).toBe(false)
    expect(v.notices.join('\n')).toMatch(/customFont was malformed/)
  })

  it('validates batch data: names, caps, counters', () => {
    const rows = Array.from({ length: 600 }, (_, i) => [`r${i}`, i, { x: 1 }])
    const v = validateDoc({
      ...base(),
      batch: {
        enabled: true,
        columns: ['room', 'room', '1bad', 'ok_2'],
        rows,
        count: 9999,
        counters: [{ name: 'n', start: 5, step: 2, pad: 3 }, { name: 'room', start: 1, step: 1, pad: 0 }, { name: 'x y' }],
        dateFormat: 'klingon',
      },
    })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const b = v.doc.batch
    expect(b?.columns).toEqual(['room', 'col2', 'col3', 'ok_2'])
    expect(b?.rows).toHaveLength(LIMITS.batchRows)
    expect(b?.rows[1]).toEqual(['r1', '1', '', ''])
    expect(b?.count).toBe(LIMITS.batchCount.max)
    expect(b?.counters).toEqual([{ name: 'n', start: 5, step: 2, pad: 3 }])
    expect(b?.dateFormat).toBe('iso')
    expect(b?.enabled).toBe(true)
  })

  it('a doc without batch data has no batch field', () => {
    const v = validateDoc(base())
    expect(v.ok && 'batch' in v.doc).toBe(false)
    expect(createBatch()).toMatchObject({ enabled: false, columns: [], rows: [], counters: [{ name: 'n', start: 1, step: 1, pad: 0 }] })
    const w = validateDoc({ ...base(), batch: createBatch() })
    expect(w.ok && w.doc.batch).toEqual(createBatch())
  })
})

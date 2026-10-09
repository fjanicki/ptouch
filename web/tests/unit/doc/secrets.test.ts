// Lead — Wi-Fi passwords never leave the browser by default (doc/secrets.ts).
import { describe, expect, it } from 'vitest'
import { createBatch, createDoc, createItem, createWifi, type CodeItem } from '../../../src/doc/schema'
import { docHasSecrets, stripSecrets } from '../../../src/doc/secrets'

const wifiCode = (password: string, content: CodeItem['content'] = 'wifi'): CodeItem => ({ ...createItem('code'), content, wifi: createWifi({ ssid: 'Home', password }) })

describe('secrets', () => {
  it('finds Wi-Fi passwords, also on codes switched back to text', () => {
    expect(docHasSecrets(createDoc())).toBe(false)
    expect(docHasSecrets(createDoc({ items: [wifiCode('')] }))).toBe(false)
    expect(docHasSecrets(createDoc({ items: [wifiCode('pw')] }))).toBe(true)
    expect(docHasSecrets(createDoc({ items: [wifiCode('pw', 'text')] }))).toBe(true)
  })

  it('blanks every password without touching the input', () => {
    const doc = createDoc({ items: [createItem('text'), wifiCode('one'), wifiCode('two', 'text')] })
    const before = JSON.stringify(doc)
    const { doc: out, removed } = stripSecrets(doc)
    expect(removed).toBe(2)
    expect(JSON.stringify(doc)).toBe(before)
    expect(JSON.stringify(out)).not.toMatch(/"one"|"two"/)
    expect(out.items[1]).toMatchObject({ wifi: { ssid: 'Home', password: '' } })
    expect(docHasSecrets(out)).toBe(false)
  })

  it('returns the same object when there is nothing to strip', () => {
    const doc = createDoc()
    expect(stripSecrets(doc)).toEqual({ doc, removed: 0, columns: [] })
    expect(stripSecrets(doc).doc).toBe(doc)
  })

  it('blanks the batch column a {{pw}} password names (counters and other columns stay)', () => {
    const code: CodeItem = { ...createItem('code'), content: 'wifi', wifi: createWifi({ ssid: '{{net}}', password: '{{pw}}' }) }
    const batch = createBatch({ enabled: true, columns: ['net', 'pw'], rows: [['Guest1', 'S3cretPassw0rd!'], ['Guest2', 'Another-Secret-9'], ['Guest3', '']] })
    const doc = createDoc({ items: [code], batch })
    const before = JSON.stringify(doc)
    const out = stripSecrets(doc)
    expect(JSON.stringify(doc)).toBe(before)
    expect(out.columns).toEqual(['pw'])
    expect(out.removed).toBe(3) // the field + two non-empty cells
    expect(out.doc.batch?.rows).toEqual([['Guest1', ''], ['Guest2', ''], ['Guest3', '']])
    expect(out.doc.batch?.counters).toEqual(batch.counters)
    expect(JSON.stringify(out.doc)).not.toMatch(/S3cret|Another-Secret/)
  })

  it('a literal password that only contains braces names no column', () => {
    const code: CodeItem = { ...createItem('code'), content: 'wifi', wifi: createWifi({ ssid: 'Home', password: 'x{{pw}}z' }) }
    const doc = createDoc({ items: [code], batch: createBatch({ enabled: true, columns: ['pw'], rows: [['visible']] }) })
    const out = stripSecrets(doc)
    expect(out.columns).toEqual([])
    expect(out.doc.batch?.rows).toEqual([['visible']])
  })
})

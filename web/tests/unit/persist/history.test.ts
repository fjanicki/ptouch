// P4 — print history: newest first, capped, thumbnails, migrated docs, remove/clear.
import { describe, expect, it } from 'vitest'
import { memoryBackend } from '../../../src/doc/persist'
import { HISTORY_LIMIT, openPrintHistory, type PrintRecordInput } from '../../../src/doc/persist-history'
import { createDoc, createItem, type Item } from '../../../src/doc/schema'
import { fixture } from './helpers'

function open(limit?: number) {
  const b = memoryBackend()
  return { b, h: openPrintHistory({ records: b.labels, thumbs: b.thumbs, ...(limit ? { limit } : {}) }) }
}

function input(name: string, printedAt: string, patch: Partial<PrintRecordInput> = {}): PrintRecordInput {
  const doc = createDoc({ name })
  return { printedAt, doc, name, tapeWidthMm: 12, mediaId: 'tze-12', labels: 2, copies: 2, tapeMm: 61.2, ...patch }
}

describe('print history', () => {
  it('lists newest first with every field', async () => {
    const { h } = open()
    await h.add(input('Old', '2026-10-01T10:00:00.000Z'))
    await h.add(input('New', '2026-10-08T10:00:00.000Z', { batchRows: 25, labels: 25, copies: 1 }))
    const list = await h.list()
    expect(list.map((r) => r.name)).toEqual(['New', 'Old'])
    expect(list[0]).toMatchObject({ name: 'New', tapeWidthMm: 12, mediaId: 'tze-12', labels: 25, copies: 1, batchRows: 25, tapeMm: 61.2 })
    expect(list[0]?.doc.name).toBe('New')
    expect(list[1]?.batchRows).toBeUndefined()
    expect(await h.get(list[1]!.id)).toMatchObject({ name: 'Old' })
  })

  it('keeps the same-second prints in insertion order', async () => {
    const { h } = open()
    for (const n of ['a', 'b', 'c']) await h.add(input(n, '2026-10-08T10:00:00.000Z'))
    expect((await h.list()).map((r) => r.name)).toEqual(['c', 'b', 'a'])
  })

  it(`drops the oldest beyond the limit (${HISTORY_LIMIT} by default), thumbnails too`, async () => {
    const { b, h } = open(3)
    for (let i = 1; i <= 5; i++) await h.add(input(`L${i}`, `2026-10-0${i}T10:00:00.000Z`, { thumbnail: new Blob([`t${i}`], { type: 'image/png' }) }))
    const list = await h.list()
    expect(list.map((r) => r.name)).toEqual(['L5', 'L4', 'L3'])
    expect((await b.thumbs.entries()).length).toBe(3)
    expect(list.every((r) => typeof r.thumbUrl === 'string')).toBe(true)
  })

  it('snapshots the doc (later edits do not change the record)', async () => {
    const { h } = open()
    const rec = input('Snap', '2026-10-08T10:00:00.000Z')
    await h.add(rec)
    rec.doc.name = 'Changed'
    expect((await h.list())[0]?.doc.name).toBe('Snap')
  })

  it('migrates stored docs on read and skips unreadable ones', async () => {
    const { b, h } = open()
    await b.labels.set('old', { id: 'old', printedAt: '2026-01-01T00:00:00.000Z', seq: 1, doc: fixture('schema-1.json'), name: 'v1', tapeWidthMm: 24, labels: 1, copies: 1, tapeMm: 40 })
    await b.labels.set('bad', { id: 'bad', printedAt: '2026-01-02T00:00:00.000Z', seq: 2, doc: { hello: 1 }, name: 'bad', tapeWidthMm: 24, labels: 1, copies: 1, tapeMm: 40 })
    await b.labels.set('junk', 'not a record')
    const list = await h.list()
    expect(list.map((r) => r.id)).toEqual(['old'])
    const code = list[0]?.doc.items.find((i) => i.kind === 'code')
    expect(code?.kind === 'code' ? code.quietZone : undefined).toMatch(/^(standard|none)$/)
  })

  it('blobRefs lists the image refs of the recorded docs (kept by the label store GC)', async () => {
    const { h } = open()
    const ref = `sha256-${'b'.repeat(32)}`
    const doc = createDoc({ name: 'Logo', items: [{ ...createItem('image'), blobRef: ref } as Item] })
    await h.add(input('Logo', '2026-10-01T10:00:00.000Z', { doc }))
    await h.add(input('Again', '2026-10-02T10:00:00.000Z', { doc }))
    expect(await h.blobRefs()).toEqual([ref])
  })

  it('removes one record and clears everything', async () => {
    const { b, h } = open()
    await h.add(input('A', '2026-10-01T10:00:00.000Z', { thumbnail: new Blob(['x']) }))
    await h.add(input('B', '2026-10-02T10:00:00.000Z'))
    const [first] = await h.list()
    await h.remove(first!.id)
    expect((await h.list()).map((r) => r.name)).toEqual(['A'])
    await h.clear()
    expect(await h.list()).toEqual([])
    expect(await b.thumbs.entries()).toEqual([])
  })
})

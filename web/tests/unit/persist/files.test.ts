// W5 — `.ptlabel.json` export/import round trip (with an image), id conflicts, bad input.
import { describe, expect, it } from 'vitest'
import { memoryBackend, openLabelStore } from '../../../src/doc/persist'
import { FILE_FORMAT, importLabelFile, labelFileName, parseLabelFile, serializeLabelFile } from '../../../src/doc/persist-files'
import { createDoc, type ImageItem } from '../../../src/doc/schema'
import { PNG_1PX, fixture, sampleDoc } from './helpers'

const fresh = () => openLabelStore({ backend: memoryBackend(), requestPersistence: async () => true })
const imageOf = (items: { kind: string }[]): ImageItem | undefined => items.find((i): i is ImageItem => i.kind === 'image')

describe('label files', () => {
  it('names files after the label', () => {
    expect(labelFileName('Cable tags')).toBe('cable-tags.ptlabel.json')
    expect(labelFileName('Größe / M3 × 12')).toBe('grosse-m3-12.ptlabel.json')
    expect(labelFileName('   ')).toBe('label.ptlabel.json')
  })

  it('exports a self-contained file and imports it into another library', async () => {
    const a = fresh()
    const ref = await a.putBlob(new Blob([PNG_1PX], { type: 'image/png' }))
    const doc = sampleDoc(ref)
    await a.save(doc)

    const { text, notices } = await serializeLabelFile(doc, a)
    expect(notices).toEqual([])
    const env = JSON.parse(text)
    expect(env.format).toBe(FILE_FORMAT)
    expect(env.version).toBe(1)
    expect(imageOf(env.doc.items)?.dataUrl).toMatch(/^data:image\/png;base64,/)

    const b = fresh()
    const file = new File([text], 'shelf.ptlabel.json', { type: 'application/json' })
    const imported = await importLabelFile(file, b)
    expect(imported.notices).toEqual([])
    expect(imported.doc.id).toBe(doc.id)
    expect(imported.doc.name).toBe(doc.name)
    expect(imported.doc.items.map((i) => i.kind)).toEqual(doc.items.map((i) => i.kind))
    const img = imageOf(imported.doc.items)
    expect(img?.dataUrl).toBeUndefined()
    const blob = await b.getBlob(img?.blobRef ?? '')
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(PNG_1PX)

    await b.save(imported.doc)
    expect((await b.load(doc.id))?.doc).toMatchObject({ ...imported.doc, updatedAt: expect.any(String) })
  })

  it('imports a copy when the id already exists in the library', async () => {
    const store = fresh()
    const doc = createDoc({ name: 'Mine' })
    await store.save(doc)
    const { text } = await serializeLabelFile(doc, store)
    const r = await parseLabelFile(text, store)
    expect(r.doc.id).not.toBe(doc.id)
    expect(r.notices.join(' ')).toMatch(/copy/)
  })

  it('accepts a bare document (no envelope) and older formats', async () => {
    const r = await parseLabelFile(JSON.stringify(fixture('schema-1.json')), fresh())
    expect(r.doc.name).toBe('Cable tags')
    const old = await parseLabelFile(JSON.stringify(fixture('schema-0.json')), fresh())
    expect(old.notices.join(' ')).toMatch(/upgraded/)
  })

  it('opens files from a newer schema read-only', async () => {
    const r = await parseLabelFile(JSON.stringify({ format: FILE_FORMAT, version: 1, doc: fixture('schema-99.json') }), fresh())
    expect(r.readOnly).toBe(true)
  })

  it('notes images missing from the library on export', async () => {
    const { notices } = await serializeLabelFile(sampleDoc('sha256-gone'), fresh())
    expect(notices.join(' ')).toMatch(/could not be found/)
  })

  it.each([
    ['invalid JSON', '{nope', /not valid JSON/],
    ['an unrelated JSON file', '{"hello":"world"}', /not a valid ptouch label/],
    ['a newer envelope', JSON.stringify({ format: FILE_FORMAT, version: 9, doc: {} }), /newer version/],
  ])('rejects %s', async (_l, text, msg) => {
    await expect(parseLabelFile(text, fresh())).rejects.toThrow(msg)
  })
})

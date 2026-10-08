// W5 — label library (memory backend; IndexedDB is exercised in e2e) and autosave debounce.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blobToDataUrl } from '../../../src/doc/persist-codec'
import { createAutosave, memoryBackend, openLabelStore, type LabelStore } from '../../../src/doc/persist'
import { createDoc, type ImageItem } from '../../../src/doc/schema'
import { PNG_1PX, sampleDoc } from './helpers'

const png = (): Blob => new Blob([PNG_1PX], { type: 'image/png' })

describe('LabelStore', () => {
  let t = Date.parse('2026-10-08T12:00:00Z')
  const now = (): number => t
  beforeEach(() => {
    t = Date.parse('2026-10-08T12:00:00Z')
  })

  it('saves and loads a document', async () => {
    const store = openLabelStore({ backend: memoryBackend(), requestPersistence: async () => true })
    const doc = createDoc({ name: 'A' })
    await store.save(doc)
    const back = await store.load(doc.id)
    expect(back?.readOnly).toBe(false)
    expect(back?.doc).toMatchObject(doc)
    expect(await store.load('nope')).toBeUndefined()
  })

  it('stores a copy, not a live reference', async () => {
    const store = openLabelStore({ backend: memoryBackend(), requestPersistence: async () => true })
    const doc = createDoc({ name: 'before' })
    await store.save(doc)
    doc.name = 'mutated after save'
    expect((await store.load(doc.id))?.doc.name).toBe('before')
  })

  it('lists labels newest first with thumbnails', async () => {
    const store = openLabelStore({ backend: memoryBackend(), now, requestPersistence: async () => true })
    const a = createDoc({ name: 'Older', tape: { widthMm: 12 } })
    const b = createDoc({ name: 'Newer' })
    await store.save(a)
    t += 1000
    await store.save(b, png())
    const list = await store.list()
    expect(list.map((l) => l.name)).toEqual(['Newer', 'Older'])
    expect(list[1]?.tapeWidthMm).toBe(12)
    expect(list[0]?.thumbUrl).toMatch(/^blob:/)
    expect(list[1]?.thumbUrl).toBeUndefined()
  })

  it('requests persistent storage once, after the first save', async () => {
    const persist = vi.fn(async () => true)
    const store = openLabelStore({ backend: memoryBackend(), requestPersistence: persist })
    expect(persist).not.toHaveBeenCalled()
    await store.save(createDoc())
    await store.save(createDoc())
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('removes labels and their thumbnails', async () => {
    const store = openLabelStore({ backend: memoryBackend(), requestPersistence: async () => true })
    const doc = createDoc()
    await store.save(doc, png())
    await store.remove(doc.id)
    expect(await store.list()).toEqual([])
    expect(await store.load(doc.id)).toBeUndefined()
  })

  it('stores blobs by content (dedupe)', async () => {
    const store = openLabelStore({ backend: memoryBackend() })
    const a = await store.putBlob(png())
    const b = await store.putBlob(png())
    expect(a).toBe(b)
    expect(a).toMatch(/^sha256-[0-9a-f]{32}$/)
    expect((await store.getBlob(a))?.size).toBe(PNG_1PX.length)
    expect(await store.getBlob('')).toBeUndefined()
  })

  it('moves inlined images into the blob store on save', async () => {
    const store = openLabelStore({ backend: memoryBackend(), requestPersistence: async () => true })
    const doc = sampleDoc('')
    const items = await Promise.all(doc.items.map(async (i) => (i.kind === 'image' ? { ...i, dataUrl: await blobToDataUrl(png()) } : i)))
    await store.save({ ...doc, items })
    const img = (await store.load(doc.id))?.doc.items.find((i): i is ImageItem => i.kind === 'image')
    expect(img?.dataUrl).toBeUndefined()
    expect(img?.blobRef).toMatch(/^sha256-/)
    expect((await store.getBlob(img!.blobRef))?.type).toBe('image/png')
  })

  it('garbage-collects unreferenced blobs after the grace period only', async () => {
    const store = openLabelStore({ backend: memoryBackend(), now, blobGraceMs: 60_000, requestPersistence: async () => true })
    const used = await store.putBlob(png())
    const orphan = await store.putBlob(new Blob([new Uint8Array([1, 2, 3])]))
    await store.save(sampleDoc(used))
    expect(await store.getBlob(orphan)).toBeDefined() // young orphan survives (undo)
    t += 61_000
    expect(await store.collectGarbage()).toBe(1)
    expect(await store.getBlob(orphan)).toBeUndefined()
    expect(await store.getBlob(used)).toBeDefined()
  })

  it('opens stored documents from a newer schema read-only', async () => {
    const backend = memoryBackend()
    const store = openLabelStore({ backend })
    const doc = createDoc()
    await backend.labels.set(doc.id, { doc: { ...doc, schema: 2 }, savedAt: new Date().toISOString() })
    expect((await store.load(doc.id))?.readOnly).toBe(true)
  })

  it('throws a readable error for a corrupt entry', async () => {
    const backend = memoryBackend()
    const store = openLabelStore({ backend })
    await backend.labels.set('bad', { doc: 'garbage', savedAt: '' })
    await expect(store.load('bad')).rejects.toThrow(/could not be opened/)
  })
})

describe('createAutosave', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function spyStore(): LabelStore & { saved: string[] } {
    const saved: string[] = []
    const inner = openLabelStore({ backend: memoryBackend(), requestPersistence: async () => true })
    return { ...inner, saved, save: async (d, th) => (saved.push(d.name), inner.save(d, th)) }
  }

  it('debounces bursts of edits into one save of the latest doc', async () => {
    const store = spyStore()
    const auto = createAutosave(store, 500, undefined, { document: undefined, window: undefined })
    const doc = createDoc()
    auto.schedule({ ...doc, name: 'a' })
    await vi.advanceTimersByTimeAsync(300)
    auto.schedule({ ...doc, name: 'ab' })
    await vi.advanceTimersByTimeAsync(300)
    auto.schedule({ ...doc, name: 'abc' })
    expect(store.saved).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    expect(store.saved).toEqual(['abc'])
    auto.dispose()
  })

  it('flush() saves immediately and only once', async () => {
    const store = spyStore()
    const auto = createAutosave(store, 500)
    auto.schedule(createDoc({ name: 'now' }))
    await auto.flush()
    expect(store.saved).toEqual(['now'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.saved).toEqual(['now'])
    await auto.flush()
    expect(store.saved).toEqual(['now'])
  })

  it('flushes when the page becomes hidden', async () => {
    const store = spyStore()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState })
    const auto = createAutosave(store, 500, undefined, { document: doc as never })
    auto.schedule(createDoc({ name: 'hidden' }))
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.saved).toEqual(['hidden'])
    auto.dispose()
  })

  it('reports save errors and keeps working', async () => {
    const errors: unknown[] = []
    let fail = true
    const store = { ...openLabelStore({ backend: memoryBackend() }), save: async () => {
      if (fail) throw new Error('quota')
    } }
    const auto = createAutosave(store, 100, (e) => errors.push(e))
    auto.schedule(createDoc())
    await vi.advanceTimersByTimeAsync(100)
    expect(errors).toHaveLength(1)
    fail = false
    auto.schedule(createDoc())
    await vi.advanceTimersByTimeAsync(100)
    expect(errors).toHaveLength(1)
  })

  it('passes a thumbnail and reports onSaved', async () => {
    const store = spyStore()
    const thumbs: (Blob | undefined)[] = []
    const inner = store.save
    store.save = async (d, th) => (thumbs.push(th), inner(d, th))
    const onSaved = vi.fn()
    const auto = createAutosave(store, 10, undefined, { thumbnail: async () => png(), onSaved })
    auto.schedule(createDoc())
    await vi.advanceTimersByTimeAsync(10)
    expect(thumbs[0]).toBeInstanceOf(Blob)
    expect(onSaved).toHaveBeenCalledTimes(1)
  })
})

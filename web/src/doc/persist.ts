// W5 — IndexedDB label library (idb-keyval 6.3.0; ARCHITECTURE.md §7).
// Areas: `labels` (StoredLabel by doc id), `blobs` (images by content ref), `thumbs` (1-bit PNG
// by doc id). idb-keyval's createStore() creates ONE object store per database, so each area is
// its own database (`ptouch-labels`, `ptouch-blobs`, `ptouch-thumbs`).
// Autosave is debounced 500 ms and flushed when the tab is hidden; navigator.storage.persist()
// is requested after the first save. The storage backend is injectable (memoryBackend() for
// unit tests: node has no IndexedDB).
import { createStore, del, entries, get, set, type UseStore } from 'idb-keyval'
import { migrate } from './persist-migrate'
import { contentRef, dataUrlToBlob } from './persist-codec'
import type { ImageItem, LabelDoc } from './schema'

export interface LabelSummary {
  id: string
  name: string
  /** ISO 8601 time of the last save (list order: newest first). */
  updatedAt: string
  tapeWidthMm: number
  /** Object URL of the thumbnail, if any (revoked on the next `list()`). */
  thumbUrl?: string
}

export interface LabelStore {
  list(): Promise<LabelSummary[]>
  /** Loads and migrates (persist-migrate.ts). `readOnly` for documents from a newer schema. */
  load(id: string): Promise<{ doc: LabelDoc; readOnly: boolean } | undefined>
  /** Saves `doc`. Inlined images (`dataUrl`) are moved into the blob store first. */
  save(doc: LabelDoc, thumbnail?: Blob): Promise<void>
  remove(id: string): Promise<void>
  /** Stores a blob under its content hash and returns that ref (equal content → same ref). */
  putBlob(blob: Blob): Promise<string>
  getBlob(ref: string): Promise<Blob | undefined>
  /** Delete blobs no saved doc references (older than the grace period). Returns the count. */
  collectGarbage(): Promise<number>
}

// ------------------------------------------------------------------------------------------
// Backends
// ------------------------------------------------------------------------------------------

/** Minimal async key-value area (idb-keyval subset). */
export interface KeyValueArea {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  del(key: string): Promise<void>
  entries<T>(): Promise<[string, T][]>
}

export interface StorageBackend {
  labels: KeyValueArea
  blobs: KeyValueArea
  thumbs: KeyValueArea
}

function idbArea(store: UseStore): KeyValueArea {
  return {
    get: (k) => get(k, store),
    set: (k, v) => set(k, v, store),
    del: (k) => del(k, store),
    entries: <T>() => entries<string, T>(store),
  }
}

let idb: StorageBackend | undefined

/** The IndexedDB backend (one database per area; created lazily, shared). */
export function idbBackend(): StorageBackend {
  idb ??= {
    labels: idbArea(createStore('ptouch-labels', 'labels')),
    blobs: idbArea(createStore('ptouch-blobs', 'blobs')),
    thumbs: idbArea(createStore('ptouch-thumbs', 'thumbs')),
  }
  return idb
}

/** In-memory backend (tests; fallback when IndexedDB is unavailable, e.g. some private modes). */
export function memoryBackend(): StorageBackend {
  const area = (): KeyValueArea => {
    const m = new Map<string, unknown>()
    return {
      get: async <T>(k: string) => m.get(k) as T | undefined,
      set: async (k, v) => void m.set(k, v),
      del: async (k) => void m.delete(k),
      entries: async <T>() => [...m.entries()] as [string, T][],
    }
  }
  return { labels: area(), blobs: area(), thumbs: area() }
}

// ------------------------------------------------------------------------------------------
// Store
// ------------------------------------------------------------------------------------------

/** What is stored per label. `doc` stays raw JSON so migrate() runs on every load. */
interface StoredLabel {
  doc: unknown
  savedAt: string
}

interface StoredBlob {
  blob: Blob
  /** ms since epoch; unreferenced blobs younger than the grace period survive GC (undo). */
  createdAt: number
}

export interface LabelStoreOptions {
  backend?: StorageBackend
  /** Unreferenced blobs younger than this survive GC, so undo can bring an image back. Default 1 day. */
  blobGraceMs?: number
  /** Called after the first successful save (default: navigator.storage.persist()). */
  requestPersistence?: () => Promise<unknown>
  now?: () => number
}

const DAY_MS = 24 * 60 * 60 * 1000

function defaultRequestPersistence(): Promise<unknown> {
  const storage = (globalThis.navigator as Navigator | undefined)?.storage
  return typeof storage?.persist === 'function' ? storage.persist().catch(() => false) : Promise.resolve(false)
}

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

const isImage = (i: { kind: string }): i is ImageItem => i.kind === 'image'

/** Blob refs used by a (raw, possibly unmigrated) stored document. */
function refsOf(raw: unknown): string[] {
  const items = (raw as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return []
  return items.flatMap((i: unknown) => {
    const r = (i as { kind?: unknown; blobRef?: unknown } | null) ?? {}
    return r.kind === 'image' && typeof r.blobRef === 'string' && r.blobRef ? [r.blobRef] : []
  })
}

export function openLabelStore(opts: LabelStoreOptions = {}): LabelStore {
  const backend = opts.backend ?? (hasIndexedDb() ? idbBackend() : memoryBackend())
  const grace = opts.blobGraceMs ?? DAY_MS
  const now = opts.now ?? Date.now
  const requestPersistence = opts.requestPersistence ?? defaultRequestPersistence
  let persistRequested = false
  let thumbUrls: string[] = []

  async function putBlob(blob: Blob): Promise<string> {
    const ref = await contentRef(new Uint8Array(await blob.arrayBuffer()))
    await backend.blobs.set(ref, { blob, createdAt: now() } satisfies StoredBlob)
    return ref
  }

  /** Moves inlined images into the blob store; returns the copy to store (no dataUrl fields). */
  async function internalize(doc: LabelDoc): Promise<LabelDoc> {
    if (!doc.items.some((i) => isImage(i) && i.dataUrl)) return doc
    const items = await Promise.all(
      doc.items.map(async (i) => {
        if (!isImage(i) || !i.dataUrl) return i
        const { dataUrl, ...rest } = i
        const have = rest.blobRef ? await backend.blobs.get<StoredBlob>(rest.blobRef) : undefined
        const blobRef = have ? rest.blobRef : await putBlob(dataUrlToBlob(dataUrl))
        return { ...rest, blobRef }
      }),
    )
    return { ...doc, items }
  }

  async function collectGarbage(): Promise<number> {
    const used = new Set((await backend.labels.entries<StoredLabel>()).flatMap(([, rec]) => refsOf(rec?.doc)))
    let removed = 0
    for (const [ref, rec] of await backend.blobs.entries<StoredBlob>()) {
      if (used.has(ref)) continue
      if (rec && now() - rec.createdAt < grace) continue
      await backend.blobs.del(ref)
      removed++
    }
    return removed
  }

  return {
    async list() {
      for (const u of thumbUrls) URL.revokeObjectURL(u)
      thumbUrls = []
      const thumbs = new Map(await backend.thumbs.entries<Blob>())
      const out: LabelSummary[] = []
      for (const [id, rec] of await backend.labels.entries<StoredLabel>()) {
        const d = (rec?.doc ?? {}) as Partial<LabelDoc>
        const thumb = thumbs.get(id)
        let thumbUrl: string | undefined
        if (thumb) {
          thumbUrl = URL.createObjectURL(thumb)
          thumbUrls.push(thumbUrl)
        }
        out.push({
          id,
          name: typeof d.name === 'string' && d.name ? d.name : 'Untitled label',
          updatedAt: rec?.savedAt ?? '',
          tapeWidthMm: typeof d.tape?.widthMm === 'number' ? d.tape.widthMm : 24,
          ...(thumbUrl ? { thumbUrl } : {}),
        })
      }
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },

    async load(id) {
      const rec = await backend.labels.get<StoredLabel>(id)
      if (!rec) return undefined
      const m = migrate(rec.doc)
      if (!m.ok) throw new Error(`Label "${id}" could not be opened: ${m.problems.join('; ')}`)
      return { doc: m.doc, readOnly: m.readOnly }
    },

    async save(doc, thumbnail) {
      const stored = await internalize(doc)
      await backend.labels.set(doc.id, { doc: structuredClone(stored), savedAt: new Date(now()).toISOString() } satisfies StoredLabel)
      if (thumbnail) await backend.thumbs.set(doc.id, thumbnail)
      if (!persistRequested) {
        persistRequested = true
        void requestPersistence()
      }
      // GC never fails a save.
      await collectGarbage().catch(() => 0)
    },

    async remove(id) {
      await backend.labels.del(id)
      await backend.thumbs.del(id)
      await collectGarbage().catch(() => 0)
    },

    putBlob,

    async getBlob(ref) {
      if (!ref) return undefined
      return (await backend.blobs.get<StoredBlob>(ref))?.blob
    },

    collectGarbage,
  }
}

/** Puts every inlined image (`dataUrl`) of `doc` into the blob store; returns the updated doc. */
export async function internalizeImages(doc: LabelDoc, store: Pick<LabelStore, 'putBlob'>): Promise<LabelDoc> {
  if (!doc.items.some((i) => isImage(i) && i.dataUrl)) return doc
  const items = await Promise.all(
    doc.items.map(async (i) => {
      if (!isImage(i) || !i.dataUrl) return i
      const { dataUrl, ...rest } = i
      return { ...rest, blobRef: await store.putBlob(dataUrlToBlob(dataUrl)) }
    }),
  )
  return { ...doc, items }
}

// ------------------------------------------------------------------------------------------
// Autosave
// ------------------------------------------------------------------------------------------

export interface Autosave {
  /** Schedule a save of `doc` (debounced). */
  schedule(doc: LabelDoc): void
  /** Save now (also runs automatically when the tab is hidden or unloaded). */
  flush(): Promise<void>
  /** Flushes what is pending (best effort) and stops listening. */
  dispose(): void
}

export interface AutosaveOptions {
  /** Thumbnail for the label list, computed at save time (e.g. render/thumbnailPng). */
  thumbnail?: (doc: LabelDoc) => Promise<Blob | undefined>
  /** Called after every successful save (UI "Saved" hint). */
  onSaved?: (doc: LabelDoc) => void
  /** Where to listen for `visibilitychange` / `pagehide` (default: document / window if present). */
  document?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

export function createAutosave(store: LabelStore, delayMs = 500, onError?: (e: unknown) => void, opts: AutosaveOptions = {}): Autosave {
  let pending: LabelDoc | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let chain: Promise<void> = Promise.resolve()
  const doc = opts.document ?? (typeof document !== 'undefined' ? document : undefined)
  const win = opts.window ?? (typeof window !== 'undefined' ? window : undefined)

  function flush(): Promise<void> {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const d = pending
    pending = undefined
    if (d) {
      chain = chain.then(async () => {
        try {
          const thumb = opts.thumbnail ? await opts.thumbnail(d).catch(() => undefined) : undefined
          await store.save(d, thumb)
          opts.onSaved?.(d)
        } catch (e) {
          onError?.(e)
        }
      })
    }
    return chain
  }

  const onVisibility = (): void => {
    if (doc?.visibilityState === 'hidden') void flush()
  }
  const onPageHide = (): void => void flush()
  doc?.addEventListener('visibilitychange', onVisibility)
  win?.addEventListener('pagehide', onPageHide)

  return {
    schedule(d) {
      pending = d
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => void flush(), delayMs)
    },
    flush,
    dispose() {
      void flush()
      doc?.removeEventListener('visibilitychange', onVisibility)
      win?.removeEventListener('pagehide', onPageHide)
    },
  }
}

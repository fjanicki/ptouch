// W5 — IndexedDB label library (idb-keyval 6.3.0; ARCHITECTURE.md §7).
// Areas: `labels` (StoredLabel by doc id), `blobs` (images by content ref), `thumbs` (1-bit PNG
// by doc id). idb-keyval's createStore() creates ONE object store per database, so each area is
// its own database (`ptouch-labels`, `ptouch-blobs`, `ptouch-thumbs`).
// Autosave is debounced 500 ms and flushed when the tab is hidden; navigator.storage.persist()
// is requested after the first save. The storage backend is injectable (memoryBackend() for
// unit tests: node has no IndexedDB). hasIndexedDb / idbArea / memoryArea are shared with the
// font store and print history (persist-fonts.ts, persist-history.ts); idbArea is Blob-safe in
// Safari Private Browsing (blobSafeArea).
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
  /** Delete blobs no saved doc (nor `retainedRefs`) references, older than the grace period.
   * Returns the count. */
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

/** IndexedDB is usable here (some private modes throw on access). */
export function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

/** A Blob stored as bytes (see blobSafeArea). */
interface StoredBytes {
  [BLOB_TAG]: true
  type: string
  bytes: ArrayBuffer
}
const BLOB_TAG = '__ptouchBlob'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype

/** `v` holds a Blob at the top level or one level down (`{ blob, … }` records). */
function hasBlob(v: unknown): boolean {
  return v instanceof Blob || (isRecord(v) && Object.values(v).some((x) => x instanceof Blob))
}

async function blobToBytes(b: Blob): Promise<StoredBytes> {
  return { [BLOB_TAG]: true, type: b.type, bytes: await b.arrayBuffer() }
}

/** Blobs (top level or one level down) → StoredBytes. */
async function encodeBlobs(v: unknown): Promise<unknown> {
  if (v instanceof Blob) return blobToBytes(v)
  if (!isRecord(v)) return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k] = x instanceof Blob ? await blobToBytes(x) : x
  return out
}

const isStoredBytes = (v: unknown): v is StoredBytes => isRecord(v) && v[BLOB_TAG] === true && v.bytes instanceof ArrayBuffer

/** StoredBytes (top level or one level down) → Blobs again. */
function decodeBlobs<T>(v: unknown): T {
  if (isStoredBytes(v)) return new Blob([v.bytes], { type: v.type }) as T
  if (!isRecord(v) || !Object.values(v).some(isStoredBytes)) return v as T
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k] = isStoredBytes(x) ? new Blob([x.bytes], { type: x.type }) : x
  return out as T
}

/** A readable Error for a failed IndexedDB request (idb-keyval rejects with `transaction.error`,
 * which WebKit leaves `null` when it aborts a put). */
function storageError(e: unknown): unknown {
  return e ?? new Error('This browser did not allow saving here (private browsing, or storage is full).')
}

/**
 * `raw` made safe for Blob values. Safari Private Browsing (a WebKit ephemeral session) rejects
 * every Blob put — with a `null` error — while JSON and ArrayBuffers are fine, so a refused value
 * holding Blobs (top level, or one level down in a record such as `{ blob, createdAt }`) is stored
 * as bytes instead (and every later one, once refused), and reads turn bytes back into Blobs.
 */
export function blobSafeArea(raw: KeyValueArea): KeyValueArea {
  let refused = false
  const fail = (e: unknown): Promise<never> => Promise.reject(storageError(e))
  return {
    get: async <T>(k: string) => decodeBlobs<T | undefined>(await raw.get(k).catch(fail)),
    async set(k, v) {
      if (refused && hasBlob(v)) return raw.set(k, await encodeBlobs(v)).catch(fail)
      try {
        await raw.set(k, v)
      } catch (e) {
        if (!hasBlob(v)) throw storageError(e)
        await raw.set(k, await encodeBlobs(v)).catch(fail)
        refused = true
      }
    },
    del: (k) => raw.del(k).catch(fail),
    entries: async <T>() => (await raw.entries<unknown>().catch(fail)).map(([k, v]): [string, T] => [k, decodeBlobs<T>(v)]),
  }
}

/** An IndexedDB area in its own database (idb-keyval `createStore(db, store)`: one object store
 * per database), Blob-safe (blobSafeArea). */
export function idbArea(db: string, storeName: string): KeyValueArea {
  const store: UseStore = createStore(db, storeName)
  return blobSafeArea({
    get: (k) => get(k, store),
    set: (k, v) => set(k, v, store),
    del: (k) => del(k, store),
    entries: <T>() => entries<string, T>(store),
  })
}

/** Map-backed area (unit tests; fallback when IndexedDB is unavailable). */
export function memoryArea(): KeyValueArea {
  const m = new Map<string, unknown>()
  return {
    get: async <T>(k: string) => m.get(k) as T | undefined,
    set: async (k, v) => void m.set(k, v),
    del: async (k) => void m.delete(k),
    entries: async <T>() => [...m.entries()] as [string, T][],
  }
}

let idb: StorageBackend | undefined

/** The IndexedDB backend (one database per area; created lazily, shared). */
export function idbBackend(): StorageBackend {
  idb ??= {
    labels: idbArea('ptouch-labels', 'labels'),
    blobs: idbArea('ptouch-blobs', 'blobs'),
    thumbs: idbArea('ptouch-thumbs', 'thumbs'),
  }
  return idb
}

/** In-memory backend (tests; fallback when IndexedDB is unavailable, e.g. some private modes). */
export function memoryBackend(): StorageBackend {
  return { labels: memoryArea(), blobs: memoryArea(), thumbs: memoryArea() }
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
  /** Blob refs used outside the label library (print history docs): GC keeps them, so a
   * reprint never loses an image. A rejection skips that GC run (nothing is deleted). */
  retainedRefs?: () => Promise<Iterable<string>>
  /** Called after the first successful save (default: navigator.storage.persist()). */
  requestPersistence?: () => Promise<unknown>
  now?: () => number
}

const DAY_MS = 24 * 60 * 60 * 1000

function defaultRequestPersistence(): Promise<unknown> {
  const storage = (globalThis.navigator as Navigator | undefined)?.storage
  return typeof storage?.persist === 'function' ? storage.persist().catch(() => false) : Promise.resolve(false)
}

const isImage = (i: { kind: string }): i is ImageItem => i.kind === 'image'

/** Blob refs used by a (raw, possibly unmigrated) stored document. */
export function refsOf(raw: unknown): string[] {
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
    if (opts.retainedRefs) for (const ref of await opts.retainedRefs()) used.add(ref)
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
      // The label is saved: a thumbnail the browser refuses only costs the list its picture.
      if (thumbnail) await backend.thumbs.set(doc.id, thumbnail).catch((e: unknown) => console.warn('could not store the label thumbnail', e))
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

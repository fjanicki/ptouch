// P4 (docs/STUDIO-V1-PLAN.md) — print history: the last HISTORY_LIMIT printed labels (doc
// snapshot, 1-bit thumbnail, date, tape, copies) in IndexedDB database `ptouch-history`, for
// one-click reprint / open. Local only (Wi-Fi passwords included, like the label library);
// clearable. Stored docs stay raw JSON and go through migrate() when read.
// Thumbnails live in their own database (`ptouch-history-thumbs`, one object store per database
// as in persist.ts), keyed by record id. Images stay in the label store's blob area (`blobRef`):
// its GC asks blobRefs() so a reprint never loses them.
import { hasIndexedDb, idbArea, memoryArea, refsOf, type KeyValueArea } from './persist'
import { migrate } from './persist-migrate'
import type { LabelDoc } from './schema'

export const HISTORY_LIMIT = 50

export interface PrintRecord {
  id: string
  /** ISO 8601. */
  printedAt: string
  /** The label as printed (batch data included; placeholders unresolved). */
  doc: LabelDoc
  name: string
  tapeWidthMm: number
  mediaId?: string
  /** Pages in the job (batch rows × copies, or copies). */
  labels: number
  copies: number
  /** Batch rows printed (absent for a plain label). */
  batchRows?: number
  /** Tape used, incl. the leader (render/job.ts estimateTape). */
  tapeMm: number
  /** Object URL of the thumbnail (revoked on the next list()). */
  thumbUrl?: string
}

export type PrintRecordInput = Omit<PrintRecord, 'id' | 'thumbUrl'> & { thumbnail?: Blob }

export interface PrintHistory {
  /** Adds a record and drops the oldest beyond the limit. */
  add(rec: PrintRecordInput): Promise<void>
  /** Newest first. */
  list(): Promise<PrintRecord[]>
  get(id: string): Promise<PrintRecord | undefined>
  remove(id: string): Promise<void>
  clear(): Promise<void>
  /** Image blob refs the recorded docs use (the label store's GC keeps them: persist.ts). */
  blobRefs(): Promise<string[]>
}

export interface PrintHistoryOptions {
  /** Injectable areas (unit tests: memoryBackend()); default IndexedDB `ptouch-history`. */
  records?: KeyValueArea
  thumbs?: KeyValueArea
  limit?: number
}

/** What is stored per print. `doc` stays raw JSON so migrate() runs on every read. */
interface StoredRecord extends Omit<PrintRecord, 'doc' | 'thumbUrl'> {
  doc: unknown
  /** Insertion order (ties in `printedAt`). */
  seq: number
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback)

/** Newest first: `printedAt`, then insertion order. */
function newestFirst(a: StoredRecord, b: StoredRecord): number {
  return b.printedAt.localeCompare(a.printedAt) || b.seq - a.seq
}

let idSeq = 0
function recordId(now: number): string {
  idSeq = (idSeq + 1) % 1296
  return `${now.toString(36)}-${idSeq.toString(36).padStart(2, '0')}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`
}

export function openPrintHistory(opts: PrintHistoryOptions = {}): PrintHistory {
  const idb = hasIndexedDb()
  const records = opts.records ?? (idb ? idbArea('ptouch-history', 'records') : memoryArea())
  const thumbs = opts.thumbs ?? (idb ? idbArea('ptouch-history-thumbs', 'thumbs') : memoryArea())
  const limit = Math.max(1, Math.floor(opts.limit ?? HISTORY_LIMIT))
  let thumbUrls: string[] = []
  let seq = 0

  /** Every stored record (malformed ones dropped), newest first. */
  async function all(): Promise<StoredRecord[]> {
    const out: StoredRecord[] = []
    for (const [, r] of await records.entries<StoredRecord>()) {
      if (r && typeof r.id === 'string' && typeof r.printedAt === 'string') out.push(r)
    }
    return out.sort(newestFirst)
  }

  /** Stored → PrintRecord; undefined when the doc cannot be read any more. */
  function toRecord(r: StoredRecord, thumb?: Blob): PrintRecord | undefined {
    const m = migrate(r.doc)
    if (!m.ok) return undefined
    let thumbUrl: string | undefined
    if (thumb instanceof Blob && typeof URL.createObjectURL === 'function') {
      thumbUrl = URL.createObjectURL(thumb)
      thumbUrls.push(thumbUrl)
    }
    return {
      id: r.id,
      printedAt: r.printedAt,
      doc: m.doc,
      name: typeof r.name === 'string' && r.name ? r.name : m.doc.name,
      tapeWidthMm: num(r.tapeWidthMm, m.doc.tape.widthMm),
      ...(typeof r.mediaId === 'string' ? { mediaId: r.mediaId } : {}),
      labels: num(r.labels, 1),
      copies: num(r.copies, 1),
      ...(typeof r.batchRows === 'number' ? { batchRows: num(r.batchRows) } : {}),
      tapeMm: num(r.tapeMm),
      ...(thumbUrl ? { thumbUrl } : {}),
    }
  }

  async function removeIds(ids: string[]): Promise<void> {
    for (const id of ids) {
      await records.del(id)
      await thumbs.del(id)
    }
  }

  return {
    async add(input) {
      const now = Date.now()
      const { thumbnail, doc, ...rest } = input
      const rec: StoredRecord = { ...rest, id: recordId(now), doc: structuredClone(doc), seq: now * 1000 + (seq++ % 1000) }
      await records.set(rec.id, rec)
      if (thumbnail) await thumbs.set(rec.id, thumbnail)
      const kept = await all()
      await removeIds(kept.slice(limit).map((r) => r.id))
    },

    async list() {
      for (const u of thumbUrls) URL.revokeObjectURL(u)
      thumbUrls = []
      const stored = await all()
      const thumbMap = new Map(await thumbs.entries<Blob>())
      return stored.flatMap((r) => toRecord(r, thumbMap.get(r.id)) ?? [])
    },

    async get(id) {
      const r = await records.get<StoredRecord>(id)
      return r ? toRecord(r) : undefined
    },

    async remove(id) {
      await removeIds([id])
    },

    async blobRefs() {
      return [...new Set((await records.entries<StoredRecord>()).flatMap(([, r]) => refsOf(r?.doc)))]
    },

    async clear() {
      const ids = [...(await records.entries()).map(([k]) => k), ...(await thumbs.entries()).map(([k]) => k)]
      await removeIds([...new Set(ids)])
    },
  }
}

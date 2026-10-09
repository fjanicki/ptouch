// W5 — `*.ptlabel.json` export/import (self-contained: images inlined as data URLs).
// Export via showSaveFilePicker where available (Chromium), else a Blob download; import via
// showOpenFilePicker / <input type=file> (pickLabelFile) or drag-and-drop (the UI passes the File).
import { blobToDataUrl } from './persist-codec'
import { internalizeImages, type LabelStore } from './persist'
import { migrate } from './persist-migrate'
import { shareableDoc } from './persist-share'
import { newId, type Item, type LabelDoc } from './schema'

export const FILE_EXTENSION = '.ptlabel.json'
export const FILE_MIME = 'application/json'
/** Marker of the file envelope. */
export const FILE_FORMAT = 'ptouch-label'
/** Refuse absurd files before parsing (images are ≤ a few MB in practice). */
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024

export interface LabelFile {
  format: typeof FILE_FORMAT
  /** Envelope version (independent of the doc schema). */
  version: 1
  exportedAt: string
  generator: string
  doc: LabelDoc
}

/** File name for a label: "Cable tags" → "cable-tags.ptlabel.json". */
export function labelFileName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'label'}${FILE_EXTENSION}`
}

export interface LabelFileOptions {
  /** Keep Wi-Fi passwords in the file (the user ticked "Include Wi-Fi password"). Default
   * false: they are blanked (doc/secrets.ts stripSecrets) with a notice. */
  includeWifiPasswords?: boolean
}

/** The self-contained JSON text of a label (images inlined from `store`; Wi-Fi passwords left
 * out unless `opts.includeWifiPasswords`; font files never included). */
export async function serializeLabelFile(source: LabelDoc, store: Pick<LabelStore, 'getBlob'>, generator = 'ptouch studio', opts: LabelFileOptions = {}): Promise<{ text: string; notices: string[] }> {
  const { doc, notices } = shareableDoc(source, opts)
  const items: Item[] = await Promise.all(
    doc.items.map(async (i): Promise<Item> => {
      if (i.kind !== 'image' || i.dataUrl) return i
      const blob = i.blobRef ? await store.getBlob(i.blobRef) : undefined
      if (!blob) {
        notices.push('An image could not be found and is missing from the file.')
        return i
      }
      return { ...i, dataUrl: await blobToDataUrl(blob) }
    }),
  )
  const file: LabelFile = { format: FILE_FORMAT, version: 1, exportedAt: new Date().toISOString(), generator, doc: { ...doc, items } }
  return { text: `${JSON.stringify(file, null, 2)}\n`, notices }
}

export interface ImportResult {
  doc: LabelDoc
  notices: string[]
  /** Made by a newer version: open read-only (do not autosave). */
  readOnly: boolean
}

/**
 * Parses, migrates and validates a label file's text (envelope or a bare LabelDoc). Images are
 * moved into the blob store. If a label with the same id already exists, the import becomes a
 * copy with a new id. Throws an Error with a user-facing message on invalid input.
 */
export async function parseLabelFile(text: string, store: Pick<LabelStore, 'putBlob'> & Partial<Pick<LabelStore, 'load'>>): Promise<ImportResult> {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('This file is not a ptouch label (it is not valid JSON).')
  }
  const env = json as Partial<LabelFile> | null
  const raw = env && typeof env === 'object' && env.format === FILE_FORMAT ? env.doc : json
  if (env && typeof env === 'object' && env.format === FILE_FORMAT && typeof env.version === 'number' && env.version > 1) {
    throw new Error('This label file was made by a newer version of ptouch studio. Please update the app.')
  }
  const m = migrate(raw)
  if (!m.ok) throw new Error(`This file is not a valid ptouch label: ${m.problems.join('; ')}`)

  const notices: string[] = []
  if (m.readOnly) notices.push('This label was made with a newer version of ptouch studio and opens read-only.')
  if (m.migratedFrom !== undefined && !m.readOnly) notices.push('This label was upgraded from an older format.')
  let doc = m.doc
  let exists = false
  try {
    exists = (await store.load?.(doc.id)) !== undefined
  } catch {
    exists = true // unreadable entry with that id: never overwrite it
  }
  if (exists) {
    const now = new Date().toISOString()
    doc = { ...doc, id: newId(), createdAt: now, updatedAt: now }
    notices.push('A label with the same id is already in your library, so this one was imported as a copy.')
  }
  doc = await internalizeImages(doc, store)
  return { doc, notices, readOnly: m.readOnly }
}

/** Parses + migrates a file; images are moved into the blob store. */
export async function importLabelFile(file: File, store: LabelStore): Promise<{ doc: LabelDoc; notices: string[]; readOnly?: boolean }> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('This file is too large to be a label.')
  return parseLabelFile(await file.text(), store)
}

type SavePicker = (o: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<{
  createWritable(): Promise<{ write(data: Blob | string): Promise<void>; close(): Promise<void> }>
}>
type OpenPicker = (o: { types?: { description: string; accept: Record<string, string[]> }[]; multiple?: boolean }) => Promise<{ getFile(): Promise<File> }[]>

const PICKER_TYPES = [{ description: 'ptouch label', accept: { 'application/json': [FILE_EXTENSION, '.json'] } }]

const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError'

/**
 * Exports a self-contained `.ptlabel.json`. Call from a click handler: the save picker is opened
 * first (it needs the user gesture), then the content is built. Resolves `false` if the user
 * cancelled the picker. Notices (e.g. missing images) are returned for a toast.
 */
export async function exportLabelFile(doc: LabelDoc, store: LabelStore, opts: LabelFileOptions = {}): Promise<{ saved: boolean; notices: string[] }> {
  const name = labelFileName(doc.name)
  const picker = (globalThis as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker
  if (typeof picker === 'function') {
    let handle: Awaited<ReturnType<SavePicker>> | undefined
    try {
      handle = await picker({ suggestedName: name, types: PICKER_TYPES })
    } catch (e) {
      if (isAbort(e)) return { saved: false, notices: [] }
      // SecurityError (gesture expired) etc.: fall back to a download below
    }
    if (handle) {
      const { text, notices } = await serializeLabelFile(doc, store, undefined, opts)
      const w = await handle.createWritable()
      await w.write(new Blob([text], { type: FILE_MIME }))
      await w.close()
      return { saved: true, notices }
    }
  }
  const { text, notices } = await serializeLabelFile(doc, store, undefined, opts)
  downloadBytes(new Blob([text], { type: FILE_MIME }), name, FILE_MIME)
  return { saved: true, notices }
}

/** Lets the user choose a label file (open picker, or a hidden file input). `undefined` = cancelled. */
export async function pickLabelFile(): Promise<File | undefined> {
  const picker = (globalThis as unknown as { showOpenFilePicker?: OpenPicker }).showOpenFilePicker
  if (typeof picker === 'function') {
    try {
      const [h] = await picker({ types: PICKER_TYPES, multiple: false })
      return h ? await h.getFile() : undefined
    } catch (e) {
      if (isAbort(e)) return undefined
      // SecurityError (no gesture) etc.: fall back to the input element
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = `${FILE_EXTENSION},.json,application/json`
    input.addEventListener('change', () => resolve(input.files?.[0]), { once: true })
    input.addEventListener('cancel', () => resolve(undefined), { once: true })
    input.click()
  })
}

/** Download raw bytes (job .bin, PBM/PNG of decoded pages, exported labels). */
export function downloadBytes(bytes: Uint8Array | Blob, filename: string, mime = 'application/octet-stream'): void {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes.slice()], { type: mime })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

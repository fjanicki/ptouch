// W5 — share links: URL fragment `#d=<base64url(deflate-raw(JSON))>` via CompressionStream.
// The fragment never reaches a server (browsers do not send it). Images are inlined as data
// URLs when small (≤ 32 KB); larger ones are left out with a notice. Links are capped in size;
// on load the payload is size-limited, decompressed with a cap, migrated and validated.
// Privacy: Wi-Fi passwords are blanked unless the user opts in, and font files are never
// included (shareableDoc; the label file export uses the same rule).
import { base64UrlToBytes, blobToDataUrl, bytesToBase64Url, dataUrlSize } from './persist-codec'
import { internalizeImages, type LabelStore } from './persist'
import { migrate } from './persist-migrate'
import { newId, type ImageItem, type Item, type LabelDoc } from './schema'
import { stripSecrets } from './secrets'

export const SHARE_PREFIX = '#d='
export const SHARE_IMAGE_LIMIT_BYTES = 32 * 1024
/** Largest fragment we create (characters after `#d=`). Fits one 32 KB image with headroom. */
export const SHARE_MAX_FRAGMENT_CHARS = 64 * 1024
/** Largest fragment we accept (reading is a little more lenient than writing). */
export const SHARE_READ_MAX_FRAGMENT_CHARS = 256 * 1024
/** Decompression cap (guards against deflate bombs). */
export const SHARE_MAX_JSON_BYTES = 1024 * 1024

export interface ShareResult {
  url: string
  /** Human-readable notices, e.g. "1 image was too large and was left out". */
  notices: string[]
}

export interface ShareOptions {
  /** Resolves `ImageItem.blobRef` (LabelStore.getBlob) so images can be inlined. */
  getBlob?: (ref: string) => Promise<Blob | undefined>
  /** Keep Wi-Fi passwords in the link (the user ticked "Include Wi-Fi password"). Default
   * false: they are blanked (doc/secrets.ts stripSecrets) with a notice. */
  includeWifiPasswords?: boolean
}

export const NOTICE_WIFI_PASSWORD_OMITTED = 'The Wi-Fi password was left out.'
export const NOTICE_WIFI_PASSWORDS_OMITTED = 'The Wi-Fi passwords were left out.'
/** The passwords came from a batch column (`{{pw}}`): its cells are blanked too. */
export function noticeWifiPasswordColumns(columns: readonly string[]): string {
  const names = columns.map((c) => `{{${c}}}`).join(', ')
  return `The Wi-Fi passwords were left out, including the ${names} ${columns.length === 1 ? 'column' : 'columns'} of the data table.`
}
export const NOTICE_CUSTOM_FONTS = 'Custom fonts are not included. The recipient sees the built-in font unless they have the same font.'

/**
 * The doc as it may leave this browser (share link, label file): Wi-Fi passwords blanked unless
 * `includeWifiPasswords`, plus the notices to show. Custom fonts stay referenced (the recipient
 * may have them) but their files are never embedded, which gets a notice too.
 */
export function shareableDoc(doc: LabelDoc, opts: { includeWifiPasswords?: boolean } = {}): { doc: LabelDoc; notices: string[] } {
  const notices: string[] = []
  let out = doc
  if (!opts.includeWifiPasswords) {
    const s = stripSecrets(doc)
    out = s.doc
    if (s.columns.length) notices.push(noticeWifiPasswordColumns(s.columns))
    else if (s.removed) notices.push(s.removed === 1 ? NOTICE_WIFI_PASSWORD_OMITTED : NOTICE_WIFI_PASSWORDS_OMITTED)
  }
  if (out.items.some((i) => i.kind === 'text' && i.customFont)) notices.push(NOTICE_CUSTOM_FONTS)
  return { doc: out, notices }
}

/** Thrown by readShareFragment / parseShareFragment for a damaged or invalid link. */
export class ShareLinkError extends Error {
  override name = 'ShareLinkError'
}

const isImage = (i: Item): i is ImageItem => i.kind === 'image'

async function pump(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new ShareLinkError('This share link is too large to open.')
      parts.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.byteLength
  }
  return out
}

function transform(bytes: Uint8Array, ts: CompressionStream | DecompressionStream, maxBytes: number): Promise<Uint8Array> {
  const src = new Blob([bytes.slice()]).stream()
  return pump(src.pipeThrough(ts as unknown as ReadableWritablePair<Uint8Array, Uint8Array>), maxBytes)
}

export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return transform(bytes, new CompressionStream('deflate-raw'), Number.MAX_SAFE_INTEGER)
}

export async function inflateRaw(bytes: Uint8Array, maxBytes = SHARE_MAX_JSON_BYTES): Promise<Uint8Array> {
  return transform(bytes, new DecompressionStream('deflate-raw'), maxBytes)
}

/** Encodes a (share-ready) doc into the fragment payload (without `#d=`). */
export async function encodeSharePayload(doc: LabelDoc): Promise<string> {
  return bytesToBase64Url(await deflateRaw(new TextEncoder().encode(JSON.stringify(doc))))
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * Builds `baseUrl#d=…`. `baseUrl` = location.origin + import.meta.env.BASE_URL.
 * Throws an Error with a user-facing message if the label cannot fit in a link.
 */
export async function createShareLink(source: LabelDoc, baseUrl: string, opts: ShareOptions = {}): Promise<ShareResult> {
  const { doc, notices } = shareableDoc(source, opts)
  let tooLarge = 0
  let missing = 0
  const items: Item[] = []
  for (const item of doc.items) {
    if (!isImage(item)) {
      items.push(item)
      continue
    }
    let dataUrl = item.dataUrl
    if (!dataUrl && item.blobRef && opts.getBlob) {
      const blob = await opts.getBlob(item.blobRef)
      if (blob && blob.size <= SHARE_IMAGE_LIMIT_BYTES) dataUrl = await blobToDataUrl(blob)
      else if (blob) tooLarge++
      else missing++
      if (!blob || blob.size > SHARE_IMAGE_LIMIT_BYTES) continue
    }
    if (!dataUrl) {
      missing++
      continue
    }
    if (dataUrlSize(dataUrl) > SHARE_IMAGE_LIMIT_BYTES) {
      tooLarge++
      continue
    }
    items.push({ ...item, blobRef: '', dataUrl })
  }

  // The recipient gets a copy; the id is replaced on load anyway.
  let shared: LabelDoc = { ...doc, items }
  let payload = await encodeSharePayload(shared)

  // Still too long: drop the largest images first.
  while (payload.length > SHARE_MAX_FRAGMENT_CHARS) {
    const imgs = shared.items.filter(isImage)
    if (imgs.length === 0) break
    const largest = imgs.reduce((a, b) => (dataUrlSize(a.dataUrl ?? '') >= dataUrlSize(b.dataUrl ?? '') ? a : b))
    shared = { ...shared, items: shared.items.filter((i) => i !== largest) }
    tooLarge++
    payload = await encodeSharePayload(shared)
  }
  if (payload.length > SHARE_MAX_FRAGMENT_CHARS) {
    throw new Error('This label is too large for a share link. Use “Export file” instead.')
  }

  if (tooLarge) notices.push(`${plural(tooLarge, 'image was', 'images were')} too large for a link and ${tooLarge === 1 ? 'was' : 'were'} left out. Use “Export file” to share ${tooLarge === 1 ? 'it' : 'them'}.`)
  if (missing) notices.push(`${plural(missing, 'image', 'images')} could not be found and ${missing === 1 ? 'was' : 'were'} left out.`)

  const base = baseUrl.replace(/#.*$/, '')
  return { url: `${base}${SHARE_PREFIX}${payload}`, notices }
}

export interface ParsedShare {
  doc: LabelDoc
  /** Made by a newer app version: show it, but do not autosave over anything. */
  readOnly: boolean
  notices: string[]
}

/**
 * Parses `location.hash`. `undefined` if it is not a share fragment; throws ShareLinkError
 * (user-facing message) if it is one but is damaged or invalid. The doc gets a fresh id so it
 * never overwrites a label in the library. With `store`, inlined images move into the blob store.
 */
export async function parseShareFragment(hash: string, store?: Pick<LabelStore, 'putBlob'>): Promise<ParsedShare | undefined> {
  const h = hash.startsWith('#') ? hash : `#${hash}`
  if (!h.startsWith(SHARE_PREFIX)) return undefined
  const payload = h.slice(SHARE_PREFIX.length).split('&')[0] ?? ''
  if (!payload) throw new ShareLinkError('This share link is empty.')
  if (payload.length > SHARE_READ_MAX_FRAGMENT_CHARS) throw new ShareLinkError('This share link is too large to open.')

  let raw: unknown
  try {
    const json = await inflateRaw(base64UrlToBytes(payload))
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json))
  } catch (e) {
    if (e instanceof ShareLinkError) throw e
    throw new ShareLinkError('This share link is damaged (it may have been cut off when it was copied).')
  }

  const m = migrate(raw)
  if (!m.ok) throw new ShareLinkError(`This share link does not contain a valid label: ${m.problems.join('; ')}`)
  const now = new Date().toISOString()
  let doc: LabelDoc = { ...m.doc, id: newId(), createdAt: now, updatedAt: now }
  if (store) doc = await internalizeImages(doc, store)
  const notices = m.readOnly ? ['This label was made with a newer version of ptouch studio and opens read-only.'] : []
  return { doc, readOnly: m.readOnly, notices }
}

/**
 * Parses `location.hash`; `undefined` if it is not a share fragment. Throws ShareLinkError for a
 * damaged link. Callers should clear the fragment afterwards (history.replaceState) so a reload
 * does not import it again.
 */
export async function readShareFragment(hash: string, store?: Pick<LabelStore, 'putBlob'>): Promise<LabelDoc | undefined> {
  return (await parseShareFragment(hash, store))?.doc
}

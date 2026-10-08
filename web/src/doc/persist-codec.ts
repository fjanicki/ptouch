// W5 — byte/text codecs shared by the persistence modules: base64 / base64url, data URLs,
// content hashes. Pure and dependency-free (works in browsers and node ≥ 24). Data URLs are
// decoded by hand: `fetch(dataUrl)` would be blocked by the CSP (`connect-src 'self'`).

const CHUNK = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** RFC 4648 §5, no padding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlToBytes(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('invalid base64url')
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  return base64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return `data:${blob.type || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`
}

/** Decodes a base64 (or percent-encoded) data URL; throws on anything else. */
export function dataUrlToBlob(url: string): Blob {
  const m = /^data:([^,;]*)((?:;[^,;=]+=[^,;]*)*)(;base64)?,(.*)$/s.exec(url)
  if (!m) throw new Error('not a data: URL')
  const mime = m[1] || 'application/octet-stream'
  const payload = m[4] ?? ''
  const bytes = m[3] ? base64ToBytes(payload) : new TextEncoder().encode(decodeURIComponent(payload))
  return new Blob([bytes.slice()], { type: mime })
}

/** Approximate decoded size of a data URL in bytes (without decoding it). */
export function dataUrlSize(url: string): number {
  const comma = url.indexOf(',')
  if (comma < 0) return url.length
  const payload = url.length - comma - 1
  return url.slice(0, comma).endsWith(';base64') ? Math.floor((payload * 3) / 4) : payload
}

/** `sha256-<first 32 hex digits>` of the content: stable blob keys, so equal images dedupe. */
export async function contentRef(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()))
  return `sha256-${Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')}`
}

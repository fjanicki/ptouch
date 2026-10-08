// W5 — shared helpers for the persistence tests.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createDoc, createItem, type LabelDoc } from '../../../src/doc/schema'

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'))
}

/** A tiny but real PNG (1×1, opaque black). */
export const PNG_1PX = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)

/** Deterministic, poorly compressible bytes. */
export function noise(n: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n)
  let x = seed >>> 0 || 1
  for (let i = 0; i < n; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out
}

/** A label with text, QR and an image item pointing at `blobRef`. */
export function sampleDoc(blobRef = ''): LabelDoc {
  const doc = createDoc({ name: 'Shelf 3 — screws M3' })
  const qr = createItem('code')
  const img = { ...createItem('image'), blobRef }
  return { ...doc, items: [...doc.items, qr, img] }
}

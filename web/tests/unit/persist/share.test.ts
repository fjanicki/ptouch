// W5 — share links: deflate-raw + base64url in `#d=`, round trip, image rules, size caps,
// damaged links (CompressionStream is available in node 24).
import { describe, expect, it } from 'vitest'
import { bytesToBase64Url } from '../../../src/doc/persist-codec'
import { memoryBackend, openLabelStore } from '../../../src/doc/persist'
import {
  SHARE_IMAGE_LIMIT_BYTES,
  SHARE_MAX_FRAGMENT_CHARS,
  SHARE_PREFIX,
  ShareLinkError,
  createShareLink,
  deflateRaw,
  encodeSharePayload,
  parseShareFragment,
  readShareFragment,
} from '../../../src/doc/persist-share'
import { createDoc, createItem, type ImageItem } from '../../../src/doc/schema'
import { PNG_1PX, noise, sampleDoc } from './helpers'

const BASE = 'https://fjanicki.github.io/ptouch/'
const hashOf = (url: string): string => url.slice(url.indexOf('#'))

describe('share links', () => {
  it('round-trips a document through the URL fragment', async () => {
    const doc = createDoc({ name: 'Garage — fuse box ⚡ ÄÖÜ' })
    const { url, notices } = await createShareLink(doc, BASE)
    expect(notices).toEqual([])
    expect(url.startsWith(`${BASE}${SHARE_PREFIX}`)).toBe(true)
    expect(hashOf(url)).toMatch(/^#d=[A-Za-z0-9_-]+$/)

    const back = await readShareFragment(hashOf(url))
    expect(back).toBeDefined()
    const { id, createdAt, updatedAt, ...rest } = doc
    expect(back).toMatchObject(rest)
    // A shared label is a copy: it never overwrites the recipient's library entry.
    expect(back?.id).not.toBe(id)
    void createdAt
    void updatedAt
  })

  it('compresses: a typical label stays short', async () => {
    const { url } = await createShareLink(createDoc(), BASE)
    expect(hashOf(url).length).toBeLessThan(1000)
  })

  it('replaces an existing fragment in the base URL', async () => {
    const { url } = await createShareLink(createDoc(), `${BASE}#diagnostics`)
    expect(url.indexOf('#')).toBe(BASE.length)
  })

  it('returns undefined for fragments that are not share links', async () => {
    expect(await readShareFragment('')).toBeUndefined()
    expect(await readShareFragment('#diagnostics')).toBeUndefined()
    expect(await parseShareFragment('#x=1')).toBeUndefined()
  })

  it('accepts the fragment without the leading #', async () => {
    const { url } = await createShareLink(createDoc({ name: 'no hash' }), BASE)
    expect((await readShareFragment(hashOf(url).slice(1)))?.name).toBe('no hash')
  })

  it('inlines small images from the store and moves them back into a store on load', async () => {
    const sender = openLabelStore({ backend: memoryBackend() })
    const ref = await sender.putBlob(new Blob([PNG_1PX], { type: 'image/png' }))
    const { url, notices } = await createShareLink(sampleDoc(ref), BASE, { getBlob: sender.getBlob })
    expect(notices).toEqual([])

    const receiver = openLabelStore({ backend: memoryBackend() })
    const parsed = await parseShareFragment(hashOf(url), receiver)
    const img = parsed?.doc.items.find((i): i is ImageItem => i.kind === 'image')
    expect(img).toBeDefined()
    expect(img?.dataUrl).toBeUndefined()
    expect(img?.blobRef).toBe(ref) // content-addressed: same bytes, same ref
    const blob = await receiver.getBlob(img?.blobRef ?? '')
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(PNG_1PX)
    expect(blob?.type).toBe('image/png')
  })

  it('leaves out images over 32 KB with a notice', async () => {
    const store = openLabelStore({ backend: memoryBackend() })
    const big = await store.putBlob(new Blob([noise(SHARE_IMAGE_LIMIT_BYTES + 1)], { type: 'image/png' }))
    const { url, notices } = await createShareLink(sampleDoc(big), BASE, { getBlob: store.getBlob })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/1 image was too large/)
    const back = await readShareFragment(hashOf(url))
    expect(back?.items.some((i) => i.kind === 'image')).toBe(false)
    expect(back?.items).toHaveLength(2)
  })

  it('reports images it cannot resolve', async () => {
    const { notices } = await createShareLink(sampleDoc('sha256-missing'), BASE, { getBlob: async () => undefined })
    expect(notices.join(' ')).toMatch(/could not be found/)
  })

  it('keeps every link under the size cap by dropping the largest images first', async () => {
    const store = openLabelStore({ backend: memoryBackend() })
    const doc = createDoc()
    const refs = await Promise.all([1, 2, 3].map((s) => store.putBlob(new Blob([noise(30_000, s)], { type: 'image/png' }))))
    const imgs = refs.map((r) => ({ ...createItem('image'), blobRef: r }))
    const { url, notices } = await createShareLink({ ...doc, items: [...doc.items, ...imgs] }, BASE, { getBlob: store.getBlob })
    expect(hashOf(url).length - SHARE_PREFIX.length).toBeLessThanOrEqual(SHARE_MAX_FRAGMENT_CHARS)
    expect(notices.join(' ')).toMatch(/too large/)
    const back = await readShareFragment(hashOf(url))
    expect(back?.items.filter((i) => i.kind === 'image').length).toBeLessThan(3)
  })

  it('refuses a label that cannot fit at all', async () => {
    // ~200 KB of incompressible text.
    const text = Array.from(noise(150_000), (b) => String.fromCharCode(0x4e00 + b)).join('')
    const doc = createDoc()
    const t = { ...createItem('text'), text }
    await expect(createShareLink({ ...doc, items: [t] }, BASE)).rejects.toThrow(/too large for a share link/)
  })

  it('rejects damaged links with a ShareLinkError', async () => {
    const { url } = await createShareLink(createDoc(), BASE)
    const cut = hashOf(url).slice(0, 20)
    await expect(readShareFragment(cut)).rejects.toBeInstanceOf(ShareLinkError)
    await expect(readShareFragment('#d=***')).rejects.toBeInstanceOf(ShareLinkError)
    await expect(readShareFragment('#d=')).rejects.toBeInstanceOf(ShareLinkError)
  })

  it('validates the payload schema', async () => {
    const payload = bytesToBase64Url(await deflateRaw(new TextEncoder().encode(JSON.stringify({ hello: 'world' }))))
    await expect(readShareFragment(`#d=${payload}`)).rejects.toThrow(/valid label/)
  })

  it('refuses decompression bombs', async () => {
    const zeros = new Uint8Array(2 * 1024 * 1024)
    const payload = bytesToBase64Url(await deflateRaw(zeros))
    expect(payload.length).toBeLessThan(10_000)
    await expect(readShareFragment(`#d=${payload}`)).rejects.toThrow(/too large/)
  })

  it('opens links made by a newer app read-only', async () => {
    const future = { ...createDoc(), schema: 7 }
    const payload = await encodeSharePayload(future as never)
    const parsed = await parseShareFragment(`#d=${payload}`)
    expect(parsed?.readOnly).toBe(true)
    expect(parsed?.notices[0]).toMatch(/newer version/)
  })
})

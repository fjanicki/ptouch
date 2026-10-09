// W5 — share links: deflate-raw + base64url in `#d=`, round trip, image rules, size caps,
// damaged links (CompressionStream is available in node 24). P3: Wi-Fi passwords are left out
// unless the user opts in; custom fonts are never embedded.
import { describe, expect, it } from 'vitest'
import { base64UrlToBytes, bytesToBase64Url } from '../../../src/doc/persist-codec'
import { memoryBackend, openLabelStore } from '../../../src/doc/persist'
import {
  NOTICE_CUSTOM_FONTS,
  NOTICE_WIFI_PASSWORD_OMITTED,
  NOTICE_WIFI_PASSWORDS_OMITTED,
  noticeWifiPasswordColumns,
  SHARE_IMAGE_LIMIT_BYTES,
  SHARE_MAX_FRAGMENT_CHARS,
  SHARE_PREFIX,
  ShareLinkError,
  createShareLink,
  deflateRaw,
  encodeSharePayload,
  inflateRaw,
  parseShareFragment,
  readShareFragment,
  shareableDoc,
} from '../../../src/doc/persist-share'
import { createBatch, createDoc, createItem, createWifi, type ImageItem, type Item, type LabelDoc } from '../../../src/doc/schema'
import { INITIAL_SNAPSHOT, PacketLog, detectSupport } from '../../../src/printer'
import { buildReport } from '../../../src/ui/diagnostics/report'
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

describe('share links: privacy (P3)', () => {
  const wifiDoc = (): LabelDoc =>
    createDoc({
      name: 'Guest Wi-Fi',
      items: [
        { ...createItem('code'), content: 'wifi', wifi: createWifi({ ssid: 'Guest', password: 'hunter2-secret' }) } as Item,
        { ...createItem('text'), text: '{{ssid}}' } as Item,
      ],
    })
  const decoded = async (url: string): Promise<string> => new TextDecoder().decode(await inflateRaw(base64UrlToBytes(hashOf(url).slice(SHARE_PREFIX.length))))

  it('leaves Wi-Fi passwords out by default, with a notice; the SSID stays', async () => {
    const { url, notices } = await createShareLink(wifiDoc(), BASE)
    expect(notices).toEqual([NOTICE_WIFI_PASSWORD_OMITTED])
    const json = await decoded(url)
    expect(json).not.toContain('hunter2-secret')
    const back = await readShareFragment(hashOf(url))
    const code = back?.items.find((i) => i.kind === 'code')
    expect(code?.kind === 'code' && code.wifi).toEqual({ ssid: 'Guest', password: '', security: 'wpa', hidden: false })
  })

  it('keeps them only when the user opts in', async () => {
    const { url, notices } = await createShareLink(wifiDoc(), BASE, { includeWifiPasswords: true })
    expect(notices).toEqual([])
    expect(await decoded(url)).toContain('hunter2-secret')
  })

  it('also blanks the password of a code switched back to text, and counts several', async () => {
    const doc = wifiDoc()
    const two = { ...doc, items: [...doc.items, { ...(doc.items[0] as Item), id: 'other', content: 'text' } as Item] }
    const { url, notices } = await createShareLink(two, BASE)
    expect(notices).toEqual([NOTICE_WIFI_PASSWORDS_OMITTED])
    expect(await decoded(url)).not.toContain('hunter2-secret')
  })

  it('leaves out passwords that come from a batch column ({{pw}}), with a notice naming it', async () => {
    const doc = createDoc({
      name: 'Guest stickers',
      items: [{ ...createItem('code'), content: 'wifi', wifi: createWifi({ ssid: '{{net}}', password: '{{pw}}' }) } as Item],
      batch: createBatch({ enabled: true, columns: ['net', 'pw'], rows: [['Guest1', 'S3cretPassw0rd!'], ['Guest2', 'Another-Secret-9']] }),
    })
    const { url, notices } = await createShareLink(doc, BASE)
    expect(notices).toEqual([noticeWifiPasswordColumns(['pw'])])
    expect(notices[0]).toMatch(/\{\{pw\}\} column/)
    const json = await decoded(url)
    expect(json).not.toMatch(/S3cretPassw0rd|Another-Secret-9/)
    const back = await readShareFragment(hashOf(url))
    expect(back?.batch?.rows).toEqual([['Guest1', ''], ['Guest2', '']])
    // Opted in: everything stays.
    expect(await decoded((await createShareLink(doc, BASE, { includeWifiPasswords: true })).url)).toContain('S3cretPassw0rd!')
  })

  it('shareableDoc returns the same doc when there is nothing to strip, and notes custom fonts', () => {
    const plain = createDoc()
    expect(shareableDoc(plain)).toEqual({ doc: plain, notices: [] })
    expect(shareableDoc(plain).doc).toBe(plain)
    const fonts = createDoc({ items: [{ ...createItem('text'), customFont: { kind: 'local', postscriptName: 'Inter-Regular', family: 'Inter' } } as Item] })
    expect(shareableDoc(fonts).notices).toEqual([NOTICE_CUSTOM_FONTS])
  })

  it('the diagnostics report takes no document and never shows logged bytes as text', () => {
    // buildReport(support, snapshot, packetLog, extras) has no access to the label. Even a
    // packet that happened to carry a Wi-Fi payload would appear only as truncated hex.
    const log = new PacketLog()
    log.push('>>', new TextEncoder().encode('WIFI:T:WPA;S:Guest;P:hunter2-secret;;'))
    const support = detectSupport({ userAgent: 'Mozilla/5.0 Chrome/154.0.0.0', serial: { requestPort() {}, getPorts() {} }, usb: {} })
    const text = buildReport(support, INITIAL_SNAPSHOT, log, { now: new Date(0) })
    expect(buildReport.length).toBe(3)
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('Guest')
  })
})

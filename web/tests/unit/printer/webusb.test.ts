// W2 — WebUsbTransport against a UsbDeviceLike fake: open sequence, endpoint discovery, the
// single transferIn loop, chunked transferOut, close cancelling the pending read, unplug → lost.
import { describe, expect, it } from 'vitest'
import { LinkLostError } from '../../../src/printer/errors'
import type { TransportEvent } from '../../../src/printer/transport'
import { BROTHER_VENDOR_ID, WebUsbTransport, type UsbDeviceLike, type UsbLike } from '../../../src/printer/webusb'
import { P710BT_STATUS_24MM } from '../../helpers/wasm'
import { eventually } from './fakes'

type InResolver = { resolve: (r: USBInTransferResult) => void; reject: (e: unknown) => void }

class FakeUsbDevice implements UsbDeviceLike {
  readonly vendorId = BROTHER_VENDOR_ID
  readonly productId = 0x20af
  readonly productName = 'PT-P710BT'
  opened = false
  configuration: USBConfiguration | null = null
  calls: string[] = []
  out: { ep: number; data: Uint8Array }[] = []
  pendingIn: InResolver[] = []
  outError: unknown = null

  async open() {
    this.calls.push('open')
    this.opened = true
  }
  async close() {
    this.calls.push('close')
    this.opened = false
    for (const p of this.pendingIn.splice(0)) p.reject(new DOMException('The transfer was cancelled.', 'AbortError'))
  }
  async selectConfiguration(n: number) {
    this.calls.push(`config:${n}`)
    this.configuration = {
      configurationValue: 1,
      interfaces: [
        {
          interfaceNumber: 0,
          claimed: false,
          alternate: null as unknown as USBAlternateInterface,
          alternates: [
            {
              alternateSetting: 0,
              interfaceClass: 7,
              interfaceSubclass: 1,
              interfaceProtocol: 2,
              endpoints: [
                { endpointNumber: 2, direction: 'out', type: 'bulk', packetSize: 64 },
                { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 },
              ],
            },
          ],
        },
      ],
    } as unknown as USBConfiguration
  }
  async claimInterface(n: number) {
    this.calls.push(`claim:${n}`)
  }
  async releaseInterface(n: number) {
    this.calls.push(`release:${n}`)
  }
  async transferOut(ep: number, data: BufferSource): Promise<USBOutTransferResult> {
    if (this.outError) throw this.outError
    const bytes = new Uint8Array(data as ArrayBuffer)
    this.out.push({ ep, data: bytes.slice() })
    return { status: 'ok', bytesWritten: bytes.length } as USBOutTransferResult
  }
  transferIn(ep: number, len: number): Promise<USBInTransferResult> {
    this.calls.push(`in:${ep}:${len}`)
    return new Promise((resolve, reject) => this.pendingIn.push({ resolve, reject }))
  }
  /** Device → host. */
  reply(bytes: Uint8Array) {
    const p = this.pendingIn.shift()
    p?.resolve({ status: 'ok', data: new DataView(bytes.slice().buffer) } as USBInTransferResult)
  }
  unplug() {
    for (const p of this.pendingIn.splice(0)) p.reject(new DOMException('The device was disconnected.', 'NotFoundError'))
  }
}

describe('WebUsbTransport', () => {
  it('opens: open → selectConfiguration(1) → claimInterface(0) → one transferIn(1, 64)', async () => {
    const dev = new FakeUsbDevice()
    const t = new WebUsbTransport(dev)
    expect(t.info).toMatchObject({ kind: 'usb', label: 'PT-P710BT', usbVendorId: 0x04f9, usbProductId: 0x20af })
    await t.open()
    await eventually(() => dev.pendingIn.length === 1)
    expect(dev.calls).toEqual(['open', 'config:1', 'claim:0', 'in:1:64'])
    expect(t.isOpen).toBe(true)
    await t.close()
  })

  it('forwards IN data and keeps exactly one transferIn pending', async () => {
    const dev = new FakeUsbDevice()
    const t = new WebUsbTransport(dev)
    const events: TransportEvent[] = []
    t.subscribe((e) => events.push(e))
    await t.open()
    await eventually(() => dev.pendingIn.length === 1)
    dev.reply(P710BT_STATUS_24MM)
    await eventually(() => events.length === 1)
    const e = events[0]
    expect(e?.type === 'data' && Array.from(e.bytes)).toEqual(Array.from(P710BT_STATUS_24MM))
    await eventually(() => dev.pendingIn.length === 1)
    expect(dev.pendingIn).toHaveLength(1)
    await t.close()
  })

  it('writes one transferOut per chunk to the bulk OUT endpoint', async () => {
    const dev = new FakeUsbDevice()
    const t = new WebUsbTransport(dev, { chunkSize: 4 })
    await t.open()
    await t.write(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))
    expect(dev.out.map((o) => o.ep)).toEqual([2, 2, 2])
    expect(dev.out.map((o) => Array.from(o.data))).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9]])
    await t.close()
  })

  it('close() releases the interface, closes the device and ends the read loop', async () => {
    const dev = new FakeUsbDevice()
    const t = new WebUsbTransport(dev)
    const events: TransportEvent[] = []
    t.subscribe((e) => events.push(e))
    await t.open()
    await eventually(() => dev.pendingIn.length === 1)
    await t.close()
    expect(dev.calls.slice(-2)).toEqual(['release:0', 'close'])
    expect(t.isOpen).toBe(false)
    expect(events.some((e) => e.type === 'lost')).toBe(false)
    // Re-open works (Reconnect).
    await t.open()
    expect(t.isOpen).toBe(true)
    await t.close()
  })

  it('unplug → lost; write failure → lost', async () => {
    const dev = new FakeUsbDevice()
    const t = new WebUsbTransport(dev)
    const events: TransportEvent[] = []
    t.subscribe((e) => events.push(e))
    await t.open()
    await eventually(() => dev.pendingIn.length === 1)
    dev.unplug()
    await eventually(() => events.some((e) => e.type === 'lost'))
    expect(t.isOpen).toBe(false)

    const dev2 = new FakeUsbDevice()
    const t2 = new WebUsbTransport(dev2)
    await t2.open()
    dev2.outError = new DOMException('A transfer error has occurred.', 'NetworkError')
    await expect(t2.write(new Uint8Array(3))).rejects.toBeInstanceOf(LinkLostError)
    expect(t2.isOpen).toBe(false)
  })

  it('abortWrites() drops the remaining chunks', async () => {
    const dev = new FakeUsbDevice()
    const t = new WebUsbTransport(dev, { chunkSize: 1 })
    await t.open()
    let release: () => void = () => {}
    const orig = dev.transferOut.bind(dev)
    dev.transferOut = async (ep, data) => {
      await new Promise<void>((r) => (release = r))
      return orig(ep, data)
    }
    const writing = t.write(new Uint8Array(10)).catch((e: unknown) => e)
    await t.abortWrites()
    release()
    expect(await writing).toMatchObject({ name: 'AbortError' })
    expect(dev.out.length).toBeLessThanOrEqual(1)
    await t.close()
  })

  it('request() filters by Brother vendor id; fromGranted() picks a granted Brother device', async () => {
    const dev = new FakeUsbDevice()
    const calls: USBDeviceRequestOptions[] = []
    const usb: UsbLike = {
      requestDevice: (o) => (calls.push(o), Promise.resolve(dev)),
      getDevices: async () => [dev],
    }
    const pending = WebUsbTransport.request(usb)
    expect(calls).toEqual([{ filters: [{ vendorId: 0x04f9 }] }]) // synchronous: user gesture kept
    expect((await pending).device).toBe(dev)
    expect((await WebUsbTransport.fromGranted(usb))?.device).toBe(dev)
    expect(await WebUsbTransport.fromGranted({ ...usb, getDevices: async () => [] })).toBeNull()
  })
})

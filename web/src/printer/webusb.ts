// W2 — WebUSB transport (optional; macOS/Linux/ChromeOS/Android; hidden on Windows unless the
// user opted in, because usbprint.sys owns the device there). VID 0x04F9, interface 0 class
// 0x07, bulk OUT 0x02 / IN 0x81 (ARCHITECTURE.md §3.2 step 4, §4.3; PROTOCOL.md §2.8).
//
// One transferIn(IN, 64) loop feeds 'data'; only close() ends it (an abandoned transferIn
// would swallow the next status frame). transferOut may block for the whole print because
// the printer back-pressures USB: no write timeout, and a partially sent job is never retried.
import { LinkLostError, abortError, isDomError } from './errors'
import { sleep } from './retry'
import { WRITE_TUNING, realClock, type Clock, type OpenOptions, type Transport, type TransportEvent, type TransportInfo, type WriteTuning } from './transport'

export const BROTHER_VENDOR_ID = 0x04f9
const PRINTER_CLASS = 0x07

export interface UsbDeviceLike {
  open(): Promise<void>
  close(): Promise<void>
  selectConfiguration(n: number): Promise<void>
  readonly configuration: USBConfiguration | null
  claimInterface(n: number): Promise<void>
  releaseInterface(n: number): Promise<void>
  transferOut(ep: number, data: BufferSource): Promise<USBOutTransferResult>
  transferIn(ep: number, len: number): Promise<USBInTransferResult>
  readonly productId: number
  readonly vendorId: number
  readonly productName?: string
  readonly opened?: boolean
  clearHalt?(direction: USBDirection, ep: number): Promise<void>
}

export interface UsbLike {
  requestDevice(o: USBDeviceRequestOptions): Promise<UsbDeviceLike>
  getDevices(): Promise<UsbDeviceLike[]>
  addEventListener?(type: 'disconnect', listener: (e: { device: UsbDeviceLike }) => void): void
  removeEventListener?(type: 'disconnect', listener: (e: { device: UsbDeviceLike }) => void): void
}

function defaultUsb(): UsbLike {
  const u = (globalThis.navigator as { usb?: UsbLike } | undefined)?.usb
  if (!u) throw new DOMException('WebUSB is not available in this browser', 'NotSupportedError')
  return u
}

/** Interface number and bulk endpoint numbers resolved from the active configuration. */
interface Endpoints {
  iface: number
  out: number
  in: number
}

function findEndpoints(config: USBConfiguration | null): Endpoints {
  const fallback: Endpoints = { iface: 0, out: 2, in: 1 }
  if (!config) return fallback
  const ifaces = config.interfaces ?? []
  const printer = ifaces.find((i) => i.alternates?.some((a) => a.interfaceClass === PRINTER_CLASS)) ?? ifaces[0]
  if (!printer) return fallback
  const alt = printer.alternates?.find((a) => a.interfaceClass === PRINTER_CLASS) ?? printer.alternates?.[0] ?? printer.alternate
  const eps = alt?.endpoints ?? []
  const out = eps.find((e) => e.direction === 'out' && e.type === 'bulk')?.endpointNumber ?? fallback.out
  const inn = eps.find((e) => e.direction === 'in' && e.type === 'bulk')?.endpointNumber ?? fallback.in
  return { iface: printer.interfaceNumber, out, in: inn }
}

export interface WebUsbOptions extends WriteTuning {
  /** Pause after an empty transferIn before polling again (some firmwares answer IN with ZLPs). */
  idlePollMs: number
  clock: Clock
  /** navigator.usb (for 'disconnect' events). */
  usb?: UsbLike
}

export class WebUsbTransport implements Transport {
  /** filters: [{ vendorId: 0x04f9 }]. Needs a user gesture (requestDevice() runs before any await). */
  static async request(usb: UsbLike = defaultUsb(), opts: Partial<WebUsbOptions> = {}): Promise<WebUsbTransport> {
    const dev = await usb.requestDevice({ filters: [{ vendorId: BROTHER_VENDOR_ID }] })
    return new WebUsbTransport(dev, { usb, ...opts })
  }

  /** getDevices() filtered to Brother; null when none is granted/plugged in ("printer asleep?"). */
  static async fromGranted(usb?: UsbLike, match?: Partial<TransportInfo>, opts: Partial<WebUsbOptions> = {}): Promise<WebUsbTransport | null> {
    let u: UsbLike
    try {
      u = usb ?? defaultUsb()
    } catch {
      return null
    }
    const devices = (await u.getDevices()).filter((d) => d.vendorId === BROTHER_VENDOR_ID && (match?.usbProductId === undefined || d.productId === match.usbProductId))
    const dev = devices[0]
    return dev ? new WebUsbTransport(dev, { usb: u, ...opts }) : null
  }

  readonly info: TransportInfo
  readonly device: UsbDeviceLike
  readonly tuning: WriteTuning
  readonly options: WebUsbOptions

  #open = false
  #closing = false
  #endpoints: Endpoints = { iface: 0, out: 2, in: 1 }
  #listeners = new Set<(e: TransportEvent) => void>()
  #loop: Promise<void> | null = null
  #writeChain: Promise<void> = Promise.resolve()
  /** Bumped by abortWrites(): chunks of older writes are not sent. */
  #writeGen = 0
  #onUsbDisconnect = (e: { device: UsbDeviceLike }) => {
    if (e.device === this.device) this.#lose(new LinkLostError('The USB printer was unplugged or turned off'))
  }

  constructor(device: UsbDeviceLike, opts: Partial<WebUsbOptions> = {}) {
    this.device = device
    this.options = { ...WRITE_TUNING.usb, idlePollMs: 25, clock: realClock, ...opts }
    this.tuning = { chunkSize: this.options.chunkSize, interChunkDelayMs: this.options.interChunkDelayMs }
    const hex = (n: number) => n.toString(16).padStart(4, '0')
    this.info = {
      kind: 'usb',
      label: device.productName?.trim() || `USB ${hex(device.vendorId)}:${hex(device.productId)}`,
      persistentGrant: true,
      usbVendorId: device.vendorId,
      usbProductId: device.productId,
    }
  }

  get isOpen(): boolean {
    return this.#open
  }

  /** open → selectConfiguration(1) if null → claimInterface(printer iface, normally 0) → IN loop. */
  async open(opts: OpenOptions = {}): Promise<void> {
    if (this.#open) return
    if (this.#loop) await this.#loop
    opts.onProgress?.({ attempt: 1, of: 1 })
    if (opts.signal?.aborted) throw abortError()
    if (!this.device.opened) await this.device.open()
    try {
      if (this.device.configuration === null) await this.device.selectConfiguration(1)
      this.#endpoints = findEndpoints(this.device.configuration)
      await this.device.claimInterface(this.#endpoints.iface)
    } catch (e) {
      await this.device.close().catch(() => {})
      throw e
    }
    if (opts.signal?.aborted) {
      await this.#release()
      throw abortError()
    }
    this.#open = true
    this.#closing = false
    this.#writeChain = Promise.resolve()
    this.options.usb?.addEventListener?.('disconnect', this.#onUsbDisconnect)
    this.#loop = this.#readLoop()
  }

  /** One transferOut per chunk; may block for the whole print; never retried. */
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    const gen = this.#writeGen
    const run = this.#writeChain.then(() => this.#writeNow(bytes, gen, signal))
    this.#writeChain = run.catch(() => {})
    return run
  }

  async #writeNow(bytes: Uint8Array, gen: number, signal?: AbortSignal): Promise<void> {
    if (!this.#open) throw new LinkLostError('The USB device is not open')
    const size = Math.max(1, this.tuning.chunkSize)
    for (let off = 0; off < bytes.length; off += size) {
      if (signal?.aborted || gen !== this.#writeGen) throw abortError('Write cancelled')
      const chunk = bytes.slice(off, Math.min(off + size, bytes.length))
      let r: USBOutTransferResult
      try {
        r = await this.device.transferOut(this.#endpoints.out, chunk)
      } catch (e) {
        if (!this.#open || this.#closing) throw new LinkLostError('The USB device was closed', { cause: e })
        const lost = new LinkLostError('Writing to the USB printer failed', { cause: e })
        this.#lose(lost)
        throw lost
      }
      if (r.status !== 'ok') {
        const lost = new LinkLostError(`USB transfer ${r.status}`)
        this.#lose(lost)
        throw lost
      }
      if (this.tuning.interChunkDelayMs > 0 && off + size < bytes.length) await sleep(this.options.clock, this.tuning.interChunkDelayMs)
    }
  }

  /** A transferOut in flight cannot be cancelled; later chunks are dropped. */
  async abortWrites(): Promise<void> {
    this.#writeGen++
  }

  async close(): Promise<void> {
    if (!this.#open) {
      if (this.#loop) await this.#loop.catch(() => {})
      return
    }
    this.#open = false
    this.#writeGen++
    await this.#release()
  }

  subscribe(listener: (e: TransportEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async #release(): Promise<void> {
    this.#closing = true
    this.options.usb?.removeEventListener?.('disconnect', this.#onUsbDisconnect)
    try {
      await this.device.releaseInterface(this.#endpoints.iface)
    } catch {
      /* gone / not claimed */
    }
    try {
      // close() cancels the pending transferIn, which ends the read loop.
      await this.device.close()
    } catch {
      /* already closed */
    }
    if (this.#loop) await this.#loop.catch(() => {})
    this.#loop = null
  }

  async #readLoop(): Promise<void> {
    while (this.#open) {
      let r: USBInTransferResult
      try {
        r = await this.device.transferIn(this.#endpoints.in, 64)
      } catch (e) {
        if (!this.#open || this.#closing) return
        if (isDomError(e, 'AbortError')) return
        this.#lose(new LinkLostError('Reading from the USB printer failed', { cause: e }))
        return
      }
      if (!this.#open) return
      if (r.status === 'stall') {
        try {
          await this.device.clearHalt?.('in', this.#endpoints.in)
        } catch (e) {
          this.#lose(new LinkLostError('The USB endpoint stalled', { cause: e }))
          return
        }
        continue
      }
      const data = r.data
      if (data && data.byteLength > 0) {
        this.#emit({ type: 'data', bytes: new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) })
      } else if (this.options.idlePollMs > 0) {
        await sleep(this.options.clock, this.options.idlePollMs)
      }
    }
  }

  #emit(e: TransportEvent): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn(e)
      } catch (err) {
        console.error('transport listener failed', err)
      }
    }
  }

  #lose(error: unknown): void {
    if (!this.#open) return
    this.#open = false
    this.#writeGen++
    this.#emit({ type: 'lost', error })
    void this.#release()
  }
}

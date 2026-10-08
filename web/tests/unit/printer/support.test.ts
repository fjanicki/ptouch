// W2 — detectSupport() for UA fixtures: Chrome mac/win/linux/android, Edge, Firefox 151/156,
// Safari macOS/iOS, Brave; describeProblem() / describeStatus() / describeSupport() tables.
import { describe, expect, it } from 'vitest'
import { LinkLostError, NotConnectedError, OpenFailedError, SessionFailedError } from '../../../src/printer/errors'
import { fromHex, PacketLog, toHex } from '../../../src/printer/packetlog'
import { describeProblem, describeStatus, describeSupport, isUserCancel, type ProblemContext, type ProblemId } from '../../../src/printer/problems'
import { detectSupport, type NavigatorLike } from '../../../src/printer/support'
import type { TransportInfo } from '../../../src/printer/transport'
import { SPP_UUID } from '../../../src/printer/webserial'
import type { PrinterStatus } from '../../../src/wasm'

const serial = { requestPort() {} }
const usb = { requestDevice() {} }
const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  chromeLinux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
  chrome110: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
  firefoxMac151: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0',
  firefoxMac156: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:156.0) Gecko/20100101 Firefox/156.0',
  firefoxWin150: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 16; Mobile; rv:157.0) Gecko/157.0 Firefox/157.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/154.0.0.0 Mobile/15E148 Safari/604.1',
}

const d = (nav: NavigatorLike, opts?: { usbOnWindows?: boolean }) => detectSupport(nav, opts)

describe('detectSupport', () => {
  it('Safari has no printing path', () => {
    const s = d({ userAgent: UA.safariMac })
    expect(s.canPrint).toBe(false)
    expect(s.paths).toEqual(['virtual'])
    expect(s).toMatchObject({ engine: 'webkit', platform: 'mac', browser: 'safari' })
  })

  it('Chromium on macOS offers usb (first: the verified reliable path), bluetooth, serial-port, virtual', () => {
    const s = d({ userAgent: UA.chromeMac, serial, usb })
    expect(s.paths).toEqual(['usb', 'bluetooth', 'serial-port', 'virtual'])
    expect(s).toMatchObject({ engine: 'chromium', platform: 'mac', browser: 'chrome', version: 154, bluetoothFilter: true, canPrint: true, brave: false })
  })

  it('Windows hides USB unless the user opted in', () => {
    expect(d({ userAgent: UA.chromeWin, serial, usb }).paths).toEqual(['bluetooth', 'serial-port', 'virtual'])
    expect(d({ userAgent: UA.chromeWin, serial, usb }).usbHidden).toBe(true)
    expect(d({ userAgent: UA.chromeWin, serial, usb }, { usbOnWindows: true }).paths).toEqual(['bluetooth', 'serial-port', 'usb', 'virtual'])
    expect(d({ userAgent: UA.edgeWin, serial, usb }).browser).toBe('edge')
  })

  it('Linux and ChromeOS get every path', () => {
    expect(d({ userAgent: UA.chromeLinux, serial, usb }).paths).toEqual(['usb', 'bluetooth', 'serial-port', 'virtual'])
    expect(d({ userAgent: UA.chromeOs, serial, usb }).platform).toBe('chromeos')
  })

  it('Android Chrome: RFCOMM Bluetooth only (+ USB OTG)', () => {
    const s = d({ userAgent: UA.chromeAndroid, serial, usb })
    expect(s.platform).toBe('android')
    expect(s.paths).toEqual(['bluetooth', 'usb', 'virtual'])
  })

  it('old Chromium (< 117) has no SPP filter', () => {
    expect(d({ userAgent: UA.chrome110, serial }).bluetoothFilter).toBe(false)
  })

  it('Firefox offers serial-port (unfiltered) only', () => {
    for (const ua of [UA.firefoxMac151, UA.firefoxMac156]) {
      const s = d({ userAgent: ua, serial })
      expect(s.paths).toEqual(['serial-port', 'virtual'])
      expect(s.bluetoothFilter).toBe(false)
      expect(s).toMatchObject({ engine: 'gecko', browser: 'firefox', platform: 'mac', canPrint: true })
    }
    // Firefox < 151 / enterprise-disabled: no navigator.serial.
    expect(d({ userAgent: UA.firefoxWin150 }).canPrint).toBe(false)
    expect(d({ userAgent: UA.firefoxAndroid }).platform).toBe('android')
  })

  it('iOS (any browser) is WebKit without device APIs', () => {
    for (const ua of [UA.safariIos, UA.chromeIos]) {
      const s = d({ userAgent: ua })
      expect(s).toMatchObject({ engine: 'webkit', platform: 'ios', canPrint: false })
    }
    // iPadOS desktop UA.
    expect(d({ userAgent: UA.safariMac, maxTouchPoints: 5 }).platform).toBe('ios')
  })

  it('Brave: detected via navigator.brave / brands; serial off by default', () => {
    const s = d({ userAgent: UA.chromeMac, brave: {}, usb })
    expect(s).toMatchObject({ brave: true, browser: 'brave', serial: false })
    expect(s.paths).toEqual(['usb', 'virtual'])
    const b = d({ userAgent: UA.chromeMac, userAgentData: { brands: [{ brand: 'Brave', version: '154' }], platform: 'macOS' } })
    expect(b.brave).toBe(true)
    expect(b.canPrint).toBe(false)
  })

  it('prefers userAgentData.platform when present', () => {
    expect(d({ userAgent: UA.chromeLinux, serial, userAgentData: { platform: 'Chrome OS' } }).platform).toBe('chromeos')
  })
})

describe('describeSupport', () => {
  it('explains each unsupported environment', () => {
    expect(describeSupport(d({ userAgent: UA.chromeMac, serial, usb }))).toBeNull()
    expect(describeSupport(d({ userAgent: UA.safariIos }))?.title).toMatch(/iPhone and iPad/)
    expect(describeSupport(d({ userAgent: UA.safariMac }))?.title).toMatch(/Safari/)
    expect(describeSupport(d({ userAgent: UA.chromeMac, brave: {} }))?.detail).toMatch(/brave:\/\/flags/)
    expect(describeSupport(d({ userAgent: UA.firefoxWin150 }))?.detail).toMatch(/Firefox 151/)
    expect(describeSupport(d({ userAgent: UA.firefoxAndroid }))?.detail).toMatch(/Chrome on Android/)
    const ff = describeSupport(d({ userAgent: UA.firefoxMac156, serial }))
    expect(ff).toMatchObject({ id: 'no-reply-firefox', severity: 'info' })
    expect(ff?.detail).toContain('PT-P710BTxxxx')
  })
})

describe('describeProblem', () => {
  const chrome = d({ userAgent: UA.chromeMac, serial, usb })
  const firefox = d({ userAgent: UA.firefoxMac156, serial })
  const windows = d({ userAgent: UA.chromeWin, serial, usb }, { usbOnWindows: true })
  const rfcomm: TransportInfo = { kind: 'serial-rfcomm', label: 'Bluetooth printer', persistentGrant: true, bluetoothServiceClassId: SPP_UUID }
  const osPort: TransportInfo = { kind: 'serial-os-port', label: 'Serial port', persistentGrant: false }
  const usbInfo: TransportInfo = { kind: 'usb', label: 'USB 04f9:20af', persistentGrant: true }
  const dom = (name: string, msg = name) => new DOMException(msg, name)
  const failed = (code: string, stage: ProblemContext['stage'], printerErrors: { id: string; message: string }[] = []) => new SessionFailedError({ code, message: code, printerErrors }, stage)
  const pe = (code: string) => Object.assign(new Error(code), { name: 'PtouchError', code })
  const status24 = { mediaWidthMm: 24 } as PrinterStatus

  const cases: [string, unknown, ProblemContext, ProblemId, string?][] = [
    ['bluetooth chooser cancelled → hint choose-port', dom('NotFoundError'), { support: chrome, stage: 'open', path: 'bluetooth' }, 'cancelled', 'choose-port'],
    ['open retries exhausted (RFCOMM)', new OpenFailedError(3, dom('NetworkError', 'Failed to open serial port.')), { support: chrome, stage: 'open', transport: rfcomm }, 'open-failed', 'choose-port'],
    ['open failed on macOS OS port → port in use', new OpenFailedError(3, dom('NetworkError')), { support: chrome, stage: 'open', transport: osPort }, 'port-in-use', 'connect-bluetooth'],
    ['USB open failed', dom('NetworkError', 'Unable to claim interface.'), { support: chrome, stage: 'open', transport: usbInfo }, 'open-failed'],
    ['USB on Windows', dom('SecurityError'), { support: windows, stage: 'open', transport: usbInfo }, 'permission-denied'],
    ['Bluetooth permission (TCC)', dom('SecurityError'), { support: chrome, stage: 'open' }, 'permission-denied'],
    ['Firefox site permission denied', dom('NotAllowedError'), { support: firefox, stage: 'open' }, 'permission-denied'],
    ['port already open elsewhere', dom('InvalidStateError', 'The port is already open.'), { support: chrome, stage: 'open' }, 'port-in-use'],
    ['handshake timeout (Chrome)', failed('TIMEOUT', 'handshake'), { support: chrome, stage: 'handshake', transport: rfcomm }, 'no-reply', 'reconnect'],
    ['handshake timeout (Firefox macOS)', failed('TIMEOUT', 'handshake'), { support: firefox, stage: 'handshake', transport: osPort }, 'no-reply-firefox'],
    ['keepalive timeout → asleep', failed('TIMEOUT', 'status'), { support: chrome, stage: 'idle', transport: rfcomm }, 'printer-off', 'reconnect'],
    ['link lost while printing', new LinkLostError(), { support: chrome, stage: 'print' }, 'link-lost', 'reconnect'],
    ['write NetworkError while idle', dom('NetworkError'), { support: chrome, stage: 'idle' }, 'link-lost'],
    ['cover open', failed('PRINTER', 'print', [{ id: 'cover-open', message: 'cover open' }]), { support: chrome, stage: 'print' }, 'cover-open'],
    ['no tape', failed('PRINTER', 'print', [{ id: 'no-media', message: 'no tape cassette' }]), { support: chrome, stage: 'print' }, 'no-media'],
    ['end of tape', failed('PRINTER', 'print', [{ id: 'end-of-media', message: 'end of tape' }]), { support: chrome, stage: 'print' }, 'no-media'],
    ['cutter jam', failed('PRINTER', 'print', [{ id: 'cutter-jam', message: 'cutter jam' }]), { support: chrome, stage: 'print' }, 'cutter-jam'],
    ['overheating', failed('PRINTER', 'print', [{ id: 'overheating', message: 'print head overheated' }]), { support: chrome, stage: 'print' }, 'overheating'],
    ['weak battery', failed('PRINTER', 'print', [{ id: 'weak-batteries', message: 'weak batteries' }]), { support: chrome, stage: 'print' }, 'weak-battery'],
    ['wrong tape (printer)', failed('PRINTER', 'print', [{ id: 'wrong-media', message: 'wrong tape' }]), { support: chrome, stage: 'print', status: status24 }, 'wrong-media', 'switch-tape'],
    ['other printer error', failed('PRINTER', 'print', [{ id: 'system-error-info1', message: 'system error (out of order)' }]), { support: chrome, stage: 'print' }, 'printer-error'],
    ['wrong tape (preflight)', pe('MEDIA_MISMATCH'), { support: chrome, stage: 'print', status: status24, designWidthMm: 12 }, 'wrong-media', 'switch-tape'],
    ['no tape (preflight)', pe('NO_MEDIA'), { support: chrome, stage: 'print' }, 'no-media'],
    ['printer turned off', failed('PRINTER_OFF', 'print'), { support: chrome, stage: 'print' }, 'printer-off'],
    ['busy', pe('BUSY'), { support: chrome, stage: 'status' }, 'busy'],
    ['cancelled job', failed('CANCELLED', 'print'), { support: chrome, stage: 'print' }, 'cancelled'],
    ['not connected', new NotConnectedError(), { support: chrome, stage: 'print' }, 'link-lost'],
    ['unknown model', pe('UNKNOWN_MODEL'), { support: chrome, stage: 'handshake' }, 'unknown', 'open-diagnostics'],
    ['garbage', new Error('boom'), { support: chrome, stage: 'idle' }, 'unknown'],
  ]

  for (const [name, err, ctx, id, action] of cases) {
    it(name, () => {
      const p = describeProblem(err, ctx)
      expect(p.id).toBe(id)
      expect(p.title.length).toBeGreaterThan(3)
      expect(p.detail.length).toBeGreaterThan(10)
      expect(p.technical).toBeTruthy()
      if (action) expect(p.actions).toContain(action)
    })
  }

  it('wrong-media copy names both widths', () => {
    const p = describeProblem(pe('MEDIA_MISMATCH'), { support: chrome, stage: 'print', status: { mediaWidthMm: 12 } as PrinterStatus, designWidthMm: 24 })
    expect(p.detail).toContain('12 mm')
    expect(p.detail).toContain('24 mm')
  })

  it('technical text includes stage, transport and cause', () => {
    const p = describeProblem(new OpenFailedError(3, dom('NetworkError', 'Failed to open serial port.')), { support: chrome, stage: 'open', transport: rfcomm })
    expect(p.technical).toMatch(/open · serial-rfcomm/)
    expect(p.technical).toMatch(/Failed to open serial port/)
  })

  it('isUserCancel', () => {
    expect(isUserCancel(dom('NotFoundError'))).toBe(true)
    expect(isUserCancel(dom('AbortError'))).toBe(true)
    expect(isUserCancel(failed('CANCELLED', 'print'))).toBe(true)
    expect(isUserCancel(dom('NetworkError'))).toBe(false)
    expect(isUserCancel(new Error('x'))).toBe(false)
  })
})

describe('describeStatus', () => {
  const chrome = d({ userAgent: UA.chromeMac, serial, usb })
  const base = { errors: [], mediaWidthMm: 24, mediaTypeByte: 1, mediaType: 'laminated', battery: { weak: false } } as unknown as PrinterStatus
  it('null for a healthy status', () => {
    expect(describeStatus(base, { support: chrome })).toBeNull()
  })
  it('flags errors, missing tape and weak battery from the core-decoded status', () => {
    expect(describeStatus({ ...base, errors: [{ id: 'cover-open', message: 'cover open' }] }, { support: chrome })?.id).toBe('cover-open')
    expect(describeStatus({ ...base, mediaWidthMm: 0, mediaType: 'none' }, { support: chrome })?.id).toBe('no-media')
    expect(describeStatus({ ...base, battery: { weak: true } } as PrinterStatus, { support: chrome })?.id).toBe('weak-battery')
    // A tape that differs from the design is the core preflight's job (MEDIA_MISMATCH), not a
    // status problem re-derived from raw bytes here.
    expect(describeStatus(base, { support: chrome, designWidthMm: 12 })).toBeNull()
    // Every banner can be dismissed.
    expect(describeStatus({ ...base, errors: [{ id: 'cutter-jam', message: 'cutter jam' }] }, { support: chrome })?.actions).toContain('dismiss')
  })
})

describe('PacketLog', () => {
  it('hex round trip and text dump', () => {
    expect(toHex(Uint8Array.from([0x1b, 0x69, 0x53]))).toBe('1B 69 53')
    expect(Array.from(fromHex('1b 69 53'))).toEqual([0x1b, 0x69, 0x53])
    expect(Array.from(fromHex('0x1b,0x69'))).toEqual([0x1b, 0x69])
    expect(() => fromHex('1b6')).toThrow()
    expect(() => fromHex('zz')).toThrow()
    const log = new PacketLog(3)
    const seen: number[] = []
    log.subscribe((e) => seen.push(e.length))
    log.push('>>', Uint8Array.from([0x1b, 0x69, 0x53]))
    log.note('hello')
    log.push('<<', new Uint8Array(100))
    log.push('<<', Uint8Array.from([1]))
    expect(log.entries()).toHaveLength(3) // ring buffer
    const text = log.toText(4)
    expect(text).toMatch(/-- hello/)
    expect(text).toMatch(/<< 00 00 00 00 … \(\+96 bytes\)/)
    log.clear()
    expect(log.entries()).toHaveLength(0)
    expect(seen.at(-1)).toBe(0)
  })
})

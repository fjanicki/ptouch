// W2 — browser capability detection (ARCHITECTURE.md §3). Pure: takes navigator-like input so
// it is unit-testable; the UI calls detectSupport() once at startup.
//
// Paths per engine (§3.1/§3.3):
//   Chromium desktop  bluetooth (SPP filter, ≥117) + serial-port (unfiltered) + usb (not Windows);
//                     usb first on macOS/Linux/ChromeOS (verified 2026-10-08 on macOS: WebUSB
//                     answers in 4 ms every time, Bluetooth open() often fails after 10 s)
//   Chrome Android    bluetooth only (RFCOMM; ≥138) + usb (OTG)
//   Firefox ≥151      serial-port only (OS-mapped ports; the SPP filter matches nothing on
//                     151–155, so it is never used)
//   Safari / iOS      nothing (design-only)
// 'virtual' is always offered last.

export type Engine = 'chromium' | 'gecko' | 'webkit' | 'unknown'
export type Platform = 'mac' | 'windows' | 'linux' | 'chromeos' | 'android' | 'ios' | 'other'
export type ConnectPath = 'bluetooth' | 'serial-port' | 'usb' | 'virtual'
export type Browser = 'chrome' | 'edge' | 'brave' | 'opera' | 'samsung' | 'firefox' | 'safari' | 'other'

export interface SupportInfo {
  engine: Engine
  platform: Platform
  /** navigator.serial.requestPort exists. */
  serial: boolean
  /** navigator.usb exists. */
  usb: boolean
  /** Chromium ≥ 117: SPP service-class filter + getInfo().bluetoothServiceClassId. */
  bluetoothFilter: boolean
  /** Brave (Web Serial off by default, canvas readback may be randomized). */
  brave: boolean
  /** At least one way to talk to a real printer. */
  canPrint: boolean
  /** Connect options to offer, in recommended order ('virtual' always last). */
  paths: ConnectPath[]
  /** Browser brand (display / diagnostics). */
  browser: Browser
  /** Major version of that browser, when known. */
  version?: number
  /** WebUSB is available but hidden because the platform is Windows (usbprint.sys). */
  usbHidden: boolean
}

export interface NavigatorLike {
  userAgent: string
  serial?: unknown
  usb?: unknown
  userAgentData?: { brands?: { brand: string; version: string }[]; platform?: string; mobile?: boolean }
  brave?: unknown
  /** iPadOS reports "Macintosh"; touch points tell them apart. */
  maxTouchPoints?: number
}

export interface SupportOptions {
  /** Offer WebUSB on Windows (only works after a WinUSB driver swap; prefs.usbOnWindows). */
  usbOnWindows?: boolean
}

function major(ua: string, re: RegExp): number | undefined {
  const m = re.exec(ua)
  return m?.[1] ? Number.parseInt(m[1], 10) : undefined
}

function detectPlatform(nav: NavigatorLike): Platform {
  const ua = nav.userAgent
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1 && !/Chrome\/|Firefox\//.test(ua))) return 'ios'
  const p = nav.userAgentData?.platform?.toLowerCase()
  if (p) {
    if (p === 'macos') return 'mac'
    if (p === 'windows') return 'windows'
    if (p === 'android') return 'android'
    if (p === 'chrome os' || p === 'chromeos') return 'chromeos'
    if (p === 'linux') return 'linux'
  }
  if (/Android/.test(ua)) return 'android'
  if (/CrOS/.test(ua)) return 'chromeos'
  if (/Mac OS X|Macintosh/.test(ua)) return 'mac'
  if (/Windows/.test(ua)) return 'windows'
  if (/Linux|X11/.test(ua)) return 'linux'
  return 'other'
}

function detectBrowser(nav: NavigatorLike, platform: Platform): { engine: Engine; browser: Browser; version?: number; brave: boolean } {
  const ua = nav.userAgent
  const brands = nav.userAgentData?.brands ?? []
  const brave = nav.brave !== undefined || brands.some((b) => /brave/i.test(b.brand))
  // Every iOS browser is WebKit (CriOS, FxiOS, EdgiOS included).
  if (platform === 'ios') return { engine: 'webkit', browser: /CriOS/.test(ua) ? 'chrome' : /FxiOS/.test(ua) ? 'firefox' : /EdgiOS/.test(ua) ? 'edge' : 'safari', brave: false }
  const ff = major(ua, /Firefox\/(\d+)/)
  if (ff !== undefined) return { engine: 'gecko', browser: 'firefox', version: ff, brave: false }
  const chrome = major(ua, /Chrom(?:e|ium)\/(\d+)/)
  if (chrome !== undefined) {
    const brandVersion = (re: RegExp) => {
      const b = brands.find((x) => re.test(x.brand))
      return b ? Number.parseInt(b.version, 10) : undefined
    }
    let browser: Browser = 'chrome'
    if (brave) browser = 'brave'
    else if (/Edg(?:e|A)?\//.test(ua)) browser = 'edge'
    else if (/OPR\//.test(ua)) browser = 'opera'
    else if (/SamsungBrowser\//.test(ua)) browser = 'samsung'
    const version = brandVersion(/^(Chromium|Google Chrome)$/) ?? chrome
    return { engine: 'chromium', browser, version, brave }
  }
  if (/AppleWebKit\//.test(ua) && /Safari\//.test(ua)) return { engine: 'webkit', browser: 'safari', ...(major(ua, /Version\/(\d+)/) !== undefined ? { version: major(ua, /Version\/(\d+)/) as number } : {}), brave: false }
  return { engine: 'unknown', browser: 'other', brave }
}

/** Detects what this browser can do. Defaults to the real `navigator`. */
export function detectSupport(nav: NavigatorLike = globalThis.navigator as unknown as NavigatorLike, opts: SupportOptions = {}): SupportInfo {
  const n: NavigatorLike = nav ?? { userAgent: '' }
  const serial = typeof (n.serial as { requestPort?: unknown } | undefined)?.requestPort === 'function'
  const usbApi = typeof (n.usb as { requestDevice?: unknown } | undefined)?.requestDevice === 'function'
  const platform = detectPlatform(n)
  const { engine, browser, version, brave } = detectBrowser(n, platform)

  // The SPP filter needs Chromium 117+ (desktop) / 138+ (Android, where serial = RFCOMM only).
  // Unknown versions are assumed current; an old Chromium rejects the filter with a TypeError
  // and requestBluetooth() falls back to the unfiltered chooser.
  const bluetoothFilter = serial && engine === 'chromium' && (version === undefined || version >= 117)

  const usbHidden = usbApi && platform === 'windows' && !opts.usbOnWindows
  const usb = usbApi && engine === 'chromium' && !usbHidden

  const paths: ConnectPath[] = []
  if (serial) {
    if (engine === 'gecko') paths.push('serial-port')
    else if (platform === 'android') paths.push('bluetooth')
    else if (engine === 'chromium') paths.push('bluetooth', 'serial-port')
    else paths.push('serial-port')
  }
  if (usb) {
    // USB is the dependable path wherever the browser can claim the interface (not Windows).
    if (engine === 'chromium' && (platform === 'mac' || platform === 'linux' || platform === 'chromeos')) paths.unshift('usb')
    else paths.push('usb')
  }
  paths.push('virtual')

  return {
    engine,
    platform,
    serial,
    usb: usbApi,
    bluetoothFilter,
    brave,
    canPrint: paths.some((p) => p !== 'virtual'),
    paths,
    browser,
    ...(version !== undefined ? { version } : {}),
    usbHidden,
  }
}

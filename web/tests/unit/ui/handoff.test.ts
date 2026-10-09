// P5 — iPhone hand-off helpers: design-only copy, Web Share feature checks with fake navigators,
// share data, AbortError handling, and the shared .ptlabel.json file (passwords left out).
import { describe, expect, it, vi } from 'vitest'
import { memoryBackend, openLabelStore } from '../../../src/doc/persist'
import { createBatch, createDoc, createItem, createWifi, type LabelDoc } from '../../../src/doc/schema'
import type { SupportInfo } from '../../../src/printer'
import {
  appleDevice,
  canShareFile,
  canShareLink,
  designOnlyMessage,
  fileShareData,
  handoffCopy,
  isDesignOnly,
  isStandalone,
  labelShareFile,
  linkShareData,
  share,
  type ShareNavigator,
} from '../../../src/ui/handoff/handoff'

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const URL_ = 'https://fjanicki.github.io/ptouch/#d=abc'

const support = (s: Partial<SupportInfo>): Pick<SupportInfo, 'canPrint' | 'platform'> => ({ canPrint: false, platform: 'ios', ...s })
const jsonFile = () => new File(['{}'], 'shelf.ptlabel.json', { type: 'application/json' })

function wifiDoc(password = 'correct horse'): LabelDoc {
  const code = { ...createItem('code'), content: 'wifi' as const, wifi: createWifi({ ssid: 'Home', password }) }
  const doc = createDoc({ name: 'Wi-Fi sticker' })
  return { ...doc, items: [...doc.items, code] }
}

describe('design-only mode', () => {
  it('is on when no printer path exists', () => {
    expect(isDesignOnly({ canPrint: false })).toBe(true)
    expect(isDesignOnly({ canPrint: true })).toBe(false)
  })

  it('names the Apple device (iPadOS reports a Mac user agent with touch)', () => {
    expect(appleDevice({ userAgent: IPHONE_UA })).toBe('iPhone')
    expect(appleDevice({ userAgent: IPAD_UA, maxTouchPoints: 5 })).toBe('iPad')
    expect(appleDevice({ userAgent: IPAD_UA, maxTouchPoints: 0 })).toBe('iPhone')
  })

  it('says plainly that printing happens from a computer', () => {
    expect(designOnlyMessage(support({}), { userAgent: IPHONE_UA })).toBe(
      'Design mode: on iPhone you can design labels here; printing happens from a computer with Chrome or Edge.',
    )
    expect(designOnlyMessage(support({}), { userAgent: IPAD_UA, maxTouchPoints: 5 })).toMatch(/^Design mode: on iPad /)
    expect(designOnlyMessage(support({ platform: 'mac' }), { userAgent: IPAD_UA })).toMatch(/^Design mode: this browser can’t connect to printers\./)
  })

  it('detects a home-screen launch', () => {
    expect(isStandalone({ standalone: true })).toBe(true)
    expect(isStandalone({}, () => ({ matches: true }))).toBe(true)
    expect(isStandalone({ standalone: false }, () => ({ matches: false }))).toBe(false)
    expect(isStandalone({})).toBe(false)
    expect(
      isStandalone({}, () => {
        throw new Error('no matchMedia')
      }),
    ).toBe(false)
  })
})

describe('Web Share feature checks', () => {
  it('needs navigator.share for a link; canShare decides when present', () => {
    expect(canShareLink({}, URL_)).toBe(false)
    expect(canShareLink({ share: async () => {} }, URL_)).toBe(true) // share() without canShare()
    const canShare = vi.fn(() => true)
    expect(canShareLink({ share: async () => {}, canShare }, URL_)).toBe(true)
    expect(canShare).toHaveBeenCalledWith({ url: URL_ })
    expect(canShareLink({ share: async () => {}, canShare: () => false }, URL_)).toBe(false)
    const throwing: ShareNavigator = {
      share: async () => {},
      canShare: () => {
        throw new TypeError('bad')
      },
    }
    expect(canShareLink(throwing, URL_)).toBe(false)
  })

  it('needs canShare({files}) for a file', () => {
    const file = jsonFile()
    expect(canShareFile({ share: async () => {} }, file)).toBe(false)
    const canShare = vi.fn((d?: ShareData) => !!d?.files?.length)
    expect(canShareFile({ share: async () => {}, canShare }, file)).toBe(true)
    expect(canShare).toHaveBeenCalledWith({ files: [file] })
    expect(canShareFile({ share: async () => {}, canShare: () => false }, file)).toBe(false)
    expect(canShareFile({ canShare: () => true }, file)).toBe(false)
  })
})

describe('share data', () => {
  it('shares the link with a title and no text (AirDrop then sends a link, not a note)', () => {
    expect(linkShareData('Shelf 3', URL_)).toEqual({ title: 'Shelf 3 (ptouch label)', url: URL_ })
    expect(linkShareData('  ', URL_).title).toBe('Untitled label (ptouch label)')
  })

  it('shares the file', () => {
    const file = jsonFile()
    expect(fileShareData('Shelf 3', file)).toEqual({ title: 'Shelf 3 (ptouch label)', files: [file] })
  })

  it('reports shared, cancelled (AbortError, silent) and failed', async () => {
    const data = linkShareData('Shelf', URL_)
    const ok = vi.fn(async () => {})
    expect(await share({ share: ok }, data)).toEqual({ outcome: 'shared' })
    expect(ok).toHaveBeenCalledWith(data)

    const abort = async () => {
      throw new DOMException('Share canceled', 'AbortError')
    }
    expect(await share({ share: abort }, data)).toEqual({ outcome: 'cancelled' })

    const err = new DOMException('Must be handling a user gesture', 'NotAllowedError')
    const denied = async () => {
      throw err
    }
    expect(await share({ share: denied }, data)).toEqual({ outcome: 'failed', error: err })

    const none = await share({}, data)
    expect(none.outcome).toBe('failed')
  })
})

describe('dialog copy', () => {
  it('mentions Share only when the Share button is shown, and fits the device', () => {
    expect(handoffCopy({ designOnly: true, canShare: true }).firstStep).toMatch(/^Tap Share and pick AirDrop/)
    expect(handoffCopy({ designOnly: true, canShare: false }).firstStep).not.toMatch(/Share/)
    expect(handoffCopy({ designOnly: false, canShare: false }).firstStep).toMatch(/^Copy the link, or export the file/)
    expect(handoffCopy({ designOnly: true, canShare: true }).description).toMatch(/Mac or PC/)
    expect(handoffCopy({ designOnly: false, canShare: true }).description).toMatch(/another computer/)
  })
})

describe('the shared label file', () => {
  const store = () => openLabelStore({ backend: memoryBackend(), requestPersistence: async () => true })

  it('is a .ptlabel.json named after the label, without the Wi-Fi password by default', async () => {
    const { file, notices } = await labelShareFile(wifiDoc(), store())
    expect(file.name).toBe('wi-fi-sticker.ptlabel.json')
    expect(file.type).toBe('application/json')
    expect(notices).toEqual(['The Wi-Fi password was left out.'])
    const text = await file.text()
    expect(text).not.toContain('correct horse')
    const env = JSON.parse(text)
    const code = env.doc.items.find((i: { kind: string }) => i.kind === 'code')
    expect(code.wifi).toMatchObject({ ssid: 'Home', password: '' })
  })

  it('leaves out passwords from a batch column, and says so', async () => {
    const doc = wifiDoc('{{pw}}')
    const withBatch: LabelDoc = { ...doc, batch: createBatch({ enabled: true, columns: ['pw'], rows: [['S3cretPassw0rd!']] }) }
    const { file, notices } = await labelShareFile(withBatch, store())
    expect(await file.text()).not.toContain('S3cretPassw0rd!')
    expect(notices.join(' ')).toMatch(/\{\{pw\}\} column/)
  })

  it('keeps the password only when the user ticked "Include Wi-Fi password"', async () => {
    const { file } = await labelShareFile(wifiDoc(), store(), { includeWifiPasswords: true })
    expect(await file.text()).toContain('correct horse')
  })
})

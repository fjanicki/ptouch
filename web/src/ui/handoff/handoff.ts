// P5 (docs/STUDIO-V1-PLAN.md) — iPhone hand-off helpers: design-only copy, Web Share feature
// checks and share data. Pure (navigator-like input) so it is unit-testable; HandoffDialog and
// DesignOnlyBanner call these. Every iOS browser is WebKit (no Web Serial / WebUSB), so on an
// iPhone the label is designed here and printed from a computer: AirDrop / Messages via
// navigator.share, the link with Copy, or the .ptlabel.json file.
import type { LabelStore } from '../../doc/persist'
import { FILE_MIME, labelFileName, serializeLabelFile } from '../../doc/persist-files'
import type { LabelDoc } from '../../doc/schema'
import type { SupportInfo } from '../../printer'

/** The parts of `navigator` the hand-off uses (fakes in tests). */
export interface ShareNavigator {
  userAgent?: string
  maxTouchPoints?: number
  /** iOS Safari: true when started from the home screen. */
  standalone?: boolean
  share?: (data: ShareData) => Promise<void>
  canShare?: (data?: ShareData) => boolean
}

export type ShareOutcome = 'shared' | 'cancelled' | 'failed'

/** The Apple device the user holds ("iPhone" / "iPad"); iPadOS reports a Mac user agent. */
export function appleDevice(nav: Pick<ShareNavigator, 'userAgent' | 'maxTouchPoints'>): 'iPhone' | 'iPad' {
  const ua = nav.userAgent ?? ''
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1) ? 'iPad' : 'iPhone'
}

/** No way to reach a printer from this browser: design here, print from a computer. */
export function isDesignOnly(support: Pick<SupportInfo, 'canPrint'>): boolean {
  return !support.canPrint
}

/** One-line design-only explanation for the banner. */
export function designOnlyMessage(support: Pick<SupportInfo, 'platform'>, nav: Pick<ShareNavigator, 'userAgent' | 'maxTouchPoints'>): string {
  if (support.platform === 'ios') return `Design mode: on ${appleDevice(nav)} you can design labels here; printing happens from a computer with Chrome or Edge.`
  return 'Design mode: this browser can’t connect to printers. Design here, then print from Chrome or Edge on a computer.'
}

/** The dialog's subtitle and first step: they only mention a Share button when one is shown
 * (no navigator.share in Firefox or some in-app browsers), and a computer user is not told to
 * "print from a Mac or PC". */
export function handoffCopy(o: { designOnly: boolean; canShare: boolean }): { description: string; firstStep: string } {
  const description = o.designOnly ? 'Print this label from a Mac or PC with Chrome or Edge.' : 'Open this label on another computer with Chrome or Edge.'
  if (!o.canShare) return { description, firstStep: 'Copy the link, or export the file, and send it to your computer.' }
  return { description, firstStep: o.designOnly ? 'Tap Share and pick AirDrop or Messages, or copy the link.' : 'Share or copy the link, or export the file.' }
}

/** Started from the home screen (iOS `navigator.standalone`, or display-mode standalone). */
export function isStandalone(nav: Pick<ShareNavigator, 'standalone'>, matchMedia?: (q: string) => { matches: boolean }): boolean {
  if (nav.standalone === true) return true
  try {
    return !!matchMedia?.('(display-mode: standalone)').matches
  } catch {
    return false
  }
}

/** Share sheet data for the link. Title and URL only: with `text` next to a URL, iOS sends
 * AirDrop as a note instead of a link the Mac opens. */
export function linkShareData(labelName: string, url: string): ShareData {
  return { title: shareTitle(labelName), url }
}

/** Share sheet data for the `.ptlabel.json` file. */
export function fileShareData(labelName: string, file: File): ShareData {
  return { title: shareTitle(labelName), files: [file] }
}

function shareTitle(labelName: string): string {
  const name = labelName.trim() || 'Untitled label'
  return `${name} (ptouch label)`
}

/** navigator.share exists and accepts a URL. */
export function canShareLink(nav: ShareNavigator, url: string): boolean {
  if (typeof nav.share !== 'function') return false
  if (typeof nav.canShare !== 'function') return true // share() predates canShare() (old Safari)
  try {
    return nav.canShare({ url })
  } catch {
    return false
  }
}

/** navigator.share accepts this file (needs canShare: file sharing is newer than share()). */
export function canShareFile(nav: ShareNavigator, file: File): boolean {
  if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false
  try {
    return nav.canShare({ files: [file] })
  } catch {
    return false
  }
}

/**
 * Opens the share sheet. Must be called straight from the click handler (Safari requires a
 * fresh user gesture), so build `data` beforehand. A user cancel (AbortError) is 'cancelled'
 * and stays silent; anything else is 'failed' with the error.
 */
export async function share(nav: ShareNavigator, data: ShareData): Promise<{ outcome: ShareOutcome; error?: unknown }> {
  if (typeof nav.share !== 'function') return { outcome: 'failed', error: new Error('Sharing is not available in this browser.') }
  try {
    await nav.share(data)
    return { outcome: 'shared' }
  } catch (e) {
    if (isAbort(e)) return { outcome: 'cancelled' }
    return { outcome: 'failed', error: e }
  }
}

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError'
}

/**
 * The open label as a `.ptlabel.json` File for the share sheet. Wi-Fi passwords (and password
 * columns of the data table) are blanked unless `includeWifiPasswords`: serializeLabelFile does
 * that, with the notice saying so (doc/secrets.ts is the one place that knows what to strip).
 */
export async function labelShareFile(doc: LabelDoc, store: Pick<LabelStore, 'getBlob'>, opts: { includeWifiPasswords?: boolean } = {}): Promise<{ file: File; notices: string[] }> {
  const { text, notices } = await serializeLabelFile(doc, store, undefined, opts)
  return { file: new File([text], labelFileName(doc.name), { type: FILE_MIME }), notices }
}

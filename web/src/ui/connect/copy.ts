// P-core-ui (docs/MODELS-PLAN.md §3.6–§3.8) — model-generic copy for the connect dialog, the
// media bar's model line and the "untested model" notice. Pure, so it is unit-tested in node
// (tests/unit/ui/connect-copy.test.ts). Examples name the PT-P710BT (the hardware-verified model)
// with a masked device name; nothing here ever holds a real printer's name suffix or address.
import { LINUX_USB_DETACH_FLAG, type ConnectPath, type TransportKind } from '../../printer'
import type { ModelInfo } from '../../wasm'
import { isVerifiedModel, tapeWidthsOf } from '../state/models'
import { formatMm } from '../state/view-model'

/** Model used in examples ("your printer, e.g. PT-P710BTxxxx"). */
export const EXAMPLE_MODEL = 'PT-P710BT'
/** A paired printer's Bluetooth name, masked like Diagnostics masks it. */
export const EXAMPLE_DEVICE = `${EXAMPLE_MODEL}xxxx`

/** Where "Report an issue" opens a new GitHub issue. */
export const ISSUES_URL = 'https://github.com/fjanicki/ptouch/issues/new'

/** The connect dialog's subtitle, following the paths this browser really offers. */
export function connectSubtitle(o: { designOnly: boolean; designModel: string; bluetooth: boolean; port: boolean; usb: boolean }): string {
  if (o.designOnly) return `This browser can’t connect to printers. Use “No printer” to design and test with a virtual ${o.designModel}.`
  const ways = [o.bluetooth ? 'Bluetooth' : o.port ? 'its Bluetooth serial port' : null, o.usb ? 'USB' : null].filter(Boolean)
  return `Your Brother P-touch label printer (e.g. ${EXAMPLE_MODEL}) over ${ways.join(' or ')}. Nothing is installed and nothing leaves this browser.`
}

/** One hint per connect option. USB stays "Most reliable" (USB-first guidance); on `linux` it
 * names the flag that lets Chromium detach the kernel's usblp driver (problems.ts usb-busy). */
export function optionHints(o: { gecko: boolean; bluetooth: boolean; linux: boolean; designModel: string }): Record<ConnectPath, string> {
  return {
    bluetooth: o.gecko
      ? `Pair the printer in system settings, then pick its “cu.” port (e.g. “cu.${EXAMPLE_DEVICE}”).`
      : `Pair the printer in system settings first, then pick it (e.g. “${EXAMPLE_DEVICE}”).`,
    'serial-port': o.bluetooth
      ? `Shows every serial port. Pick your printer (e.g. “${EXAMPLE_DEVICE}” or “cu.${EXAMPLE_DEVICE}”) if Bluetooth shows nothing.`
      : `Pair the printer in system settings first, then pick its “cu.” port (macOS, e.g. “cu.${EXAMPLE_DEVICE}”) or its COM port.`,
    usb: o.linux
      ? `Most reliable: answers instantly, no pairing or waking. On Linux, start the browser with ${LINUX_USB_DETACH_FLAG} first.`
      : 'Most reliable: answers instantly, no pairing or waking. Close P-touch Editor first.',
    virtual: `Design and test with a virtual ${o.designModel}.`,
  }
}

/** The media bar's model line while a printer is connected: "PT-P910BT (connected)". */
export function connectedModelText(model: string, kind: TransportKind | null | undefined): string {
  return `${model} (${kind === 'virtual' ? 'virtual printer' : 'connected'})`
}

/** The "untested model" notice (§3.7). */
export function untestedModelText(model: string): string {
  return `${model} hasn’t been tested with ptouch studio yet. Printing should work; if anything looks wrong, please report it.`
}

/**
 * A prefilled "new issue" link for an untested model: the model and how it was connected, never
 * the printer's Bluetooth name or address (the body asks for the masked Diagnostics report).
 */
export function untestedIssueUrl(model: string, connection?: string): string {
  const body = [
    `Model: ${model}`,
    `Connection: ${connection || 'unknown'}`,
    '',
    'What did you print, and what happened?',
    '',
    '',
    'Please paste “Copy diagnostics” from the Diagnostics page below (device names are masked).',
  ].join('\n')
  const q = new URLSearchParams({ title: `Untested model: ${model}`, body })
  return `${ISSUES_URL}?${q.toString()}`
}

/** A model picker option: "PT-P910BT · up to 36 mm", "PT-P710BT · up to 24 mm · tested". */
export function modelOptionText(info: ModelInfo): string {
  const widths = tapeWidthsOf(info)
  const max = widths[widths.length - 1]
  return `${info.name}${max ? ` · up to ${formatMm(max)}` : ''}${isVerifiedModel(info.name) ? ' · tested' : ''}`
}

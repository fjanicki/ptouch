// W2 — maps every failure (transport, wasm PtouchError, printer status errors) to an
// actionable, user-facing Problem. The UI (W4) only renders Problems; all copy lives here so
// hints stay consistent between the connect panel, print bar and diagnostics page.
import type { PrinterErrorInfo, PrinterStatus } from '../wasm'
import { LinkLostError, NotConnectedError, OpenFailedError, SessionFailedError, WrongPortError, errorText } from './errors'
import type { ConnectPath, SupportInfo } from './support'
import type { TransportInfo } from './transport'

export type ProblemId =
  | 'open-failed' // NetworkError "Failed to open serial port" after all retries
  | 'wrong-port' // picked a non-SPP Bluetooth service (the P710BT's Apple iAP entry)
  | 'port-in-use' // another app holds the tty (macOS TIOCEXCL)
  | 'no-reply' // opened, but no status within the handshake timeout (asleep / dead port)
  | 'no-reply-firefox' // Firefox OS port on macOS: dead after first use → use Chrome/Edge or re-pair
  | 'link-lost' // read/write failed, disconnect event, printer powered off
  | 'permission-denied' // Bluetooth TCC / SecurityError
  | 'unsupported-browser'
  | 'no-media'
  | 'wrong-media' // loaded tape ≠ design tape (offer "switch design to N mm")
  | 'cover-open'
  | 'cutter-jam'
  | 'overheating' // cooling: wait
  | 'weak-battery'
  | 'printer-error' // any other printer error bit
  | 'printer-off'
  | 'busy'
  | 'cancelled'
  | 'canvas-noise' // anti-fingerprinting randomizes canvas readback (render/antifp.ts)
  | 'unknown'

export type ProblemAction =
  | 'retry'
  | 'reconnect'
  | 'choose-port' // unfiltered requestPort()
  | 'connect-bluetooth'
  | 'connect-usb'
  | 'switch-tape' // set doc.tape to the loaded width
  | 'open-diagnostics'
  | 'dismiss'

export interface Problem {
  id: ProblemId
  severity: 'info' | 'warning' | 'error'
  title: string
  /** One or two sentences: what happened and what to do. Plain text. */
  detail: string
  actions: ProblemAction[]
  /** Raw error code / message for "copy diagnostics". */
  technical?: string
  printerErrors?: PrinterErrorInfo[]
}

export interface ProblemContext {
  support: SupportInfo
  transport?: TransportInfo
  /** Stage in which the error happened. */
  stage: 'open' | 'handshake' | 'status' | 'print' | 'idle'
  /** Connect path in use (picks fallbacks, e.g. "Choose port…" after a Bluetooth failure). */
  path?: ConnectPath
  /** Last known status (wrong-media copy names the loaded tape). */
  status?: PrinterStatus | null
  /** Tape width of the design, in mm (wrong-media copy). */
  designWidthMm?: number
}

const CHROME_EDGE = 'Chrome or Edge'

/** `true` for a cancelled chooser or operation (NotFoundError / AbortError / CANCELLED): silently ignore. */
export function isUserCancel(error: unknown): boolean {
  if (error instanceof SessionFailedError) return error.code === 'CANCELLED'
  const name = (error as { name?: unknown } | null)?.name
  return (error instanceof DOMException || error instanceof Error) && (name === 'NotFoundError' || name === 'AbortError')
}

/** BUSY from the printer layer (SessionFailedError) or from the wasm session (PtouchError). */
export function isBusyError(error: unknown): boolean {
  return codeOf(error) === 'BUSY'
}

function codeOf(error: unknown): string | undefined {
  if (error instanceof SessionFailedError) return error.code
  if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'PtouchError') {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

function domName(error: unknown): string | undefined {
  if (error instanceof DOMException) return error.name
  if (error instanceof Error && /Error$/.test(error.name) && error.name !== 'Error' && error.name !== 'TypeError') return error.name
  return undefined
}

function technical(ctx: ProblemContext, error: unknown): string {
  const parts: string[] = [ctx.stage]
  if (ctx.transport) parts.push(ctx.transport.kind)
  const code = codeOf(error)
  if (code) parts.push(code)
  let text = errorText(error)
  const cause = (error as { cause?: unknown } | null)?.cause
  if (cause !== undefined) text += ` (cause: ${errorText(cause)})`
  return `${parts.join(' · ')}: ${text}`
}

function mm(n: number | undefined): string {
  return n === 4 ? '3.5 mm' : `${n ?? '?'} mm`
}

const isMacOsPort = (ctx: ProblemContext) => ctx.transport?.kind === 'serial-os-port' && ctx.support.platform === 'mac'

/** Problem for one decoded printer error id (from a status frame or a failed job). */
function printerProblem(errors: PrinterErrorInfo[], ctx: ProblemContext): Problem {
  const ids = new Set(errors.map((e) => e.id))
  const base = { severity: 'error' as const, printerErrors: errors }
  const during = ctx.stage === 'print' ? ' The label was not finished.' : ''
  if (ids.has('cover-open'))
    return { ...base, id: 'cover-open', title: 'The printer cover is open', detail: `Close the tape compartment cover until it clicks, then try again.${during}`, actions: ['retry', 'dismiss'] }
  if (ids.has('no-media') || ids.has('end-of-media'))
    return {
      ...base,
      id: 'no-media',
      title: ids.has('end-of-media') ? 'The tape has run out' : 'No tape cassette',
      detail: ids.has('end-of-media') ? `Insert a new TZe cassette, close the cover, then try again.${during}` : 'Insert a TZe tape cassette and close the cover, then try again.',
      actions: ['retry', 'dismiss'],
    }
  if (ids.has('wrong-media')) return wrongMedia(ctx, errors)
  if (ids.has('cutter-jam'))
    return { ...base, id: 'cutter-jam', title: 'The cutter is jammed', detail: 'Turn the printer off, open the cover and gently remove any stuck tape around the cutter, then turn it back on and reconnect.', actions: ['reconnect', 'dismiss'] }
  if (ids.has('overheating'))
    return { ...base, id: 'overheating', severity: 'warning', title: 'The print head is too hot', detail: 'The printer is cooling down. Wait a minute or two without printing, then try again.', actions: ['retry', 'dismiss'] }
  if (ids.has('weak-batteries'))
    return { ...base, id: 'weak-battery', severity: 'warning', title: 'The battery is weak', detail: 'Charge the printer or connect the AC adapter, then try again. Printing on a weak battery can stop mid-label.', actions: ['retry', 'dismiss'] }
  if (ids.has('power-turned-off'))
    return { ...base, id: 'printer-off', title: 'The printer turned off', detail: 'Turn the printer on, then reconnect.', actions: ['reconnect', 'dismiss'] }
  if (ids.has('printer-in-use'))
    return { ...base, id: 'busy', severity: 'warning', title: 'The printer is busy', detail: 'Another device or app is using the printer. Wait for it to finish, then try again.', actions: ['retry', 'dismiss'] }
  const list = errors.map((e) => e.message).join(', ')
  return { ...base, id: 'printer-error', title: 'The printer reported an error', detail: `${list ? `${capitalize(list)}. ` : ''}Turn the printer off and on again, then reconnect.`, actions: ['reconnect', 'open-diagnostics', 'dismiss'] }
}

function wrongMedia(ctx: ProblemContext, errors?: PrinterErrorInfo[]): Problem {
  const loaded = ctx.status && ctx.status.mediaWidthMm > 0 ? mm(ctx.status.mediaWidthMm) : null
  const design = ctx.designWidthMm !== undefined ? mm(ctx.designWidthMm) : null
  const detail =
    loaded && design
      ? `The printer has ${loaded} tape loaded, but this label is designed for ${design}. Switch the design to ${loaded}, or load ${design} tape.`
      : loaded
        ? `The printer has ${loaded} tape loaded, which doesn't match this label. Switch the design to ${loaded}, or change the cassette.`
        : 'The loaded tape doesn’t match this label. Check the cassette, or switch the design to the loaded tape.'
  return { id: 'wrong-media', severity: 'warning', title: 'Wrong tape width', detail, actions: loaded ? ['switch-tape', 'dismiss'] : ['retry', 'dismiss'], ...(errors ? { printerErrors: errors } : {}) }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function noReply(ctx: ProblemContext): Problem {
  const gecko = ctx.support.engine === 'gecko'
  if (gecko && (ctx.support.platform === 'mac' || ctx.transport?.kind === 'serial-os-port')) {
    return {
      id: 'no-reply-firefox',
      severity: 'error',
      title: 'The printer isn’t answering in Firefox',
      detail:
        ctx.support.platform === 'mac'
          ? `Firefox on macOS can only use the system serial port, which often stops returning data after the first use. Use ${CHROME_EDGE} (they talk to the printer directly over Bluetooth), or remove and re-pair the printer in System Settings › Bluetooth.`
          : `Firefox can only use the system serial port. Make sure the printer is on, then turn it off and on again and reconnect — or use ${CHROME_EDGE}.`,
      // Reconnecting rarely helps a dead OS port: Diagnostics first, Reconnect after re-pairing.
      actions: ['open-diagnostics', 'reconnect', 'dismiss'],
    }
  }
  if (ctx.stage === 'print') {
    return { id: 'no-reply', severity: 'error', title: 'The printer stopped responding', detail: 'Printing may not have finished. Check the printer, turn it off and on again if needed, then reconnect.', actions: ['reconnect', 'dismiss'] }
  }
  if (ctx.stage === 'idle' || ctx.stage === 'status') {
    return { id: 'printer-off', severity: 'warning', title: 'The printer went to sleep', detail: 'It turns itself off after a while without use. Turn it on, then reconnect.', actions: ['reconnect', 'dismiss'] }
  }
  return {
    id: 'no-reply',
    severity: 'error',
    title: 'The printer didn’t answer',
    detail: isMacOsPort(ctx)
      ? 'The serial port opened, but the printer sent nothing back. Turn the printer off and on again and reconnect, or use Bluetooth instead of the system port.'
      : 'Make sure the printer is turned on and nearby. If it is, turn it off and on again, then reconnect.',
    actions: isMacOsPort(ctx) ? ['reconnect', 'connect-bluetooth', 'open-diagnostics'] : ['reconnect', 'open-diagnostics', 'dismiss'],
  }
}

function linkLost(ctx: ProblemContext): Problem {
  if (ctx.stage === 'print')
    return { id: 'link-lost', severity: 'error', title: 'The printer disconnected while printing', detail: 'The label may be incomplete. Make sure the printer is on and nearby, reconnect, and print again.', actions: ['reconnect', 'dismiss'] }
  return {
    id: 'link-lost',
    severity: 'warning',
    title: 'The printer disconnected',
    detail: ctx.transport?.kind === 'usb' ? 'Check the USB cable and that the printer is on, then reconnect.' : 'It may have turned itself off or gone out of range. Turn it on, then reconnect.',
    actions: ['reconnect', 'dismiss'],
  }
}

function openFailed(ctx: ProblemContext, cause: unknown): Problem {
  const kind = ctx.transport?.kind
  const msg = errorText(cause)
  if (kind === 'serial-os-port' || /in use|busy|already open|access denied|resource busy/i.test(msg)) {
    return {
      id: 'port-in-use',
      severity: 'error',
      title: 'The serial port is busy or unavailable',
      detail: `Another app may be using it — close other label or terminal apps (and the ptouch command-line tool), make sure the printer is on, then try again.${ctx.support.bluetoothFilter ? ' Connecting via Bluetooth avoids the system port.' : ''}`,
      actions: ctx.support.bluetoothFilter ? ['retry', 'connect-bluetooth', 'open-diagnostics'] : ['retry', 'open-diagnostics', 'dismiss'],
    }
  }
  if (kind === 'usb') {
    return {
      id: 'open-failed',
      severity: 'error',
      title: 'Couldn’t open the USB printer',
      detail:
        ctx.support.platform === 'windows'
          ? 'Windows’ printer driver holds the device, so the browser can’t use it. Connect via Bluetooth instead.'
          : 'Another app (such as P-touch Editor or the system print queue) may be using it. Close it, unplug and replug the cable, then try again.',
      actions: ctx.support.paths.includes('bluetooth') ? ['retry', 'connect-bluetooth', 'dismiss'] : ['retry', 'dismiss'],
    }
  }
  return {
    id: 'open-failed',
    severity: 'error',
    title: 'Couldn’t connect to the printer',
    detail: 'Make sure the printer is on (the Bluetooth light is lit) and close to this computer, then try again. If it keeps failing, use “Choose port…” and pick the printer from the full list.',
    actions: ctx.support.paths.includes('serial-port') ? ['retry', 'choose-port', 'open-diagnostics'] : ['retry', 'open-diagnostics', 'dismiss'],
  }
}

function permissionDenied(ctx: ProblemContext): Problem {
  const mac = ctx.support.platform === 'mac'
  return {
    id: 'permission-denied',
    severity: 'error',
    title: ctx.support.engine === 'gecko' ? 'Serial access was not allowed' : 'Bluetooth permission needed',
    detail:
      ctx.support.engine === 'gecko'
        ? 'Firefox asks once per site before allowing serial ports. Allow it in the site permissions (the icon left of the address), then try again.'
        : mac
          ? 'Allow your browser to use Bluetooth in System Settings › Privacy & Security › Bluetooth, make sure Bluetooth is on, then try again.'
          : 'Make sure Bluetooth is on and that this site may use serial devices (site settings), then try again.',
    actions: ['retry', 'dismiss'],
  }
}

/**
 * Maps any error to a Problem. Classifies DOMException names (NetworkError, InvalidStateError,
 * SecurityError, NotFoundError = cancelled picker), printer-layer errors (errors.ts),
 * PtouchError codes (wasm) and printer error ids.
 */
export function describeProblem(error: unknown, ctx: ProblemContext): Problem {
  const tech = technical(ctx, error)
  const p = classify(error, ctx)
  return dismissable({ ...p, technical: p.technical ?? tech })
}

/** Every banner can be closed: 'dismiss' is always the last action. */
function dismissable(p: Problem): Problem {
  return p.actions.includes('dismiss') ? p : { ...p, actions: [...p.actions, 'dismiss'] }
}

function classify(error: unknown, ctx: ProblemContext): Problem {
  if (isUserCancel(error)) {
    if (ctx.stage === 'open' && ctx.path === 'bluetooth' && ctx.support.paths.includes('serial-port') && (error as { name?: string }).name === 'NotFoundError') {
      return {
        id: 'cancelled',
        severity: 'info',
        title: 'No printer chosen',
        detail: 'If your printer wasn’t in the list, pair it in your computer’s Bluetooth settings first and make sure it is on — or use “Choose port…” to see every serial port.',
        actions: ['choose-port', 'dismiss'],
      }
    }
    return { id: 'cancelled', severity: 'info', title: ctx.stage === 'print' ? 'Printing cancelled' : 'Cancelled', detail: ctx.stage === 'print' ? 'The printer was reset. Check the tape before printing again.' : 'Nothing was changed.', actions: ['dismiss'] }
  }
  if (error instanceof WrongPortError) {
    return {
      id: 'wrong-port',
      severity: 'warning',
      title: 'That entry isn’t the printer’s print port',
      detail: 'The printer shows up twice; the other entry is an Apple accessory service that can’t print. Use Bluetooth (it picks the right one) or a USB cable.',
      actions: [...(ctx.support.paths.includes('usb') ? (['connect-usb'] as const) : []), ...(ctx.support.paths.includes('bluetooth') ? (['connect-bluetooth'] as const) : []), 'dismiss'],
    }
  }
  if (error instanceof OpenFailedError) return openFailed(ctx, error.cause)
  if (error instanceof LinkLostError) return linkLost(ctx)
  if (error instanceof NotConnectedError) return { id: 'link-lost', severity: 'warning', title: 'No printer connected', detail: 'Connect a printer first.', actions: ctx.support.paths.includes('bluetooth') ? ['connect-bluetooth', 'dismiss'] : ['dismiss'] }

  const code = codeOf(error)
  if (code) {
    const printerErrors = error instanceof SessionFailedError ? error.printerErrors : []
    switch (code) {
      case 'PRINTER':
        return printerErrors.length > 0
          ? printerProblem(printerErrors, ctx)
          : { id: 'printer-error', severity: 'error', title: 'The printer reported an error', detail: 'Turn the printer off and on again, then reconnect.', actions: ['reconnect', 'dismiss'] }
      case 'NO_MEDIA':
        return printerProblem([{ id: 'no-media', message: 'no tape cassette' }], ctx)
      case 'MEDIA_MISMATCH':
        return wrongMedia(ctx)
      case 'TIMEOUT':
        return noReply(ctx)
      case 'PRINTER_OFF':
        return { id: 'printer-off', severity: 'warning', title: 'The printer turned off', detail: ctx.stage === 'print' ? 'The label was not finished. Turn the printer on, reconnect and print again.' : 'Turn it on, then reconnect.', actions: ['reconnect', 'dismiss'] }
      case 'BUSY':
      case 'NOT_READY':
        return { id: 'busy', severity: 'warning', title: 'The printer is busy', detail: 'Wait until the current label is finished, then try again.', actions: ['dismiss'] }
      case 'UNKNOWN_MODEL':
        return { id: 'unknown', severity: 'error', title: 'This printer model isn’t supported', detail: 'The printer answered, but it isn’t a model this studio knows how to drive. Open Diagnostics and copy the report if you want to request support.', actions: ['open-diagnostics', 'dismiss'] }
      case 'UNSUPPORTED_MEDIA':
        return { id: 'wrong-media', severity: 'warning', title: 'This tape isn’t supported', detail: 'The loaded tape type or width can’t be used with this printer. Load a TZe cassette.', actions: ['dismiss'] }
      case 'STATUS_LENGTH':
      case 'STATUS_HEADER':
      case 'PROTOCOL':
      case 'CORRUPT':
        return { id: 'unknown', severity: 'error', title: 'Unexpected reply from the printer', detail: 'Turn the printer off and on again, then reconnect. If it keeps happening, open Diagnostics.', actions: ['reconnect', 'open-diagnostics'] }
      case 'TOO_SHORT':
      case 'TOO_LONG':
      case 'EMPTY':
      case 'BITMAP_SIZE':
      case 'DATA_LENGTH':
      case 'INVALID_INPUT':
        return { id: 'unknown', severity: 'warning', title: 'This label can’t be printed as is', detail: `${capitalize(errorText(error).replace(/^PtouchError: /, ''))}. Adjust the label and try again.`, actions: ['dismiss'] }
      case 'UNSUPPORTED':
        return { id: 'unknown', severity: 'warning', title: 'Not available yet', detail: 'This feature isn’t available in this version of the studio.', actions: ['dismiss'] }
    }
  }

  const name = domName(error)
  if (name === 'NetworkError') return ctx.stage === 'open' ? openFailed(ctx, error) : linkLost(ctx)
  if (name === 'SecurityError' || name === 'NotAllowedError') return permissionDenied(ctx)
  // InvalidStateError ("The port is already open") concerns this page's own SerialPort object
  // (a previous connection that did not close cleanly): other tabs fail with NetworkError.
  if (name === 'InvalidStateError')
    return {
      id: 'port-in-use',
      severity: 'error',
      title: 'The previous connection is still closing',
      detail: 'This page still holds the printer connection from an earlier attempt. Wait a moment and try again; if it keeps happening, reload this page.',
      actions: ['retry', 'dismiss'],
    }
  if (name === 'NotSupportedError') return describeSupport(ctx.support) ?? unsupported(ctx.support)

  return { id: 'unknown', severity: 'error', title: 'Something went wrong', detail: 'Try again. If it keeps happening, open Diagnostics and copy the report.', actions: ['retry', 'open-diagnostics'] }
}

/**
 * Problem for errors currently shown in a status frame (cover open, no tape…), or null when
 * the printer is fine. Use after connect and for status updates while idle.
 */
export function describeStatus(status: PrinterStatus, ctx: Omit<ProblemContext, 'stage'> & { stage?: ProblemContext['stage'] }): Problem | null {
  const p = statusProblem(status, ctx)
  return p && dismissable(p)
}

function statusProblem(status: PrinterStatus, ctx: Omit<ProblemContext, 'stage'> & { stage?: ProblemContext['stage'] }): Problem | null {
  if (!status.errors.length) {
    // The core decodes the media ("none" = no cassette). A tape that differs from the design is
    // not a printer problem: the core's preflight (MEDIA_MISMATCH) and the media bar handle it.
    if (status.mediaType === 'none' || status.mediaWidthMm === 0) return { ...printerProblem([{ id: 'no-media', message: 'no tape cassette' }], { ...ctx, stage: ctx.stage ?? 'status' }), technical: 'status: no media' }
    if (status.battery.weak) return { ...printerProblem([{ id: 'weak-batteries', message: 'weak batteries' }], { ...ctx, stage: 'status' }) }
    return null
  }
  return { ...printerProblem(status.errors, { ...ctx, stage: ctx.stage ?? 'status', status }), technical: `status errors: ${status.errors.map((e) => e.id).join(', ')}` }
}

function unsupported(support: SupportInfo): Problem {
  return { id: 'unsupported-browser', severity: 'info', title: 'This browser can’t talk to label printers', detail: `Use ${CHROME_EDGE} on a computer or Android phone to print. You can still design labels and export them here.`, actions: ['dismiss'], technical: `${support.engine}/${support.platform}` }
}

/**
 * Why this browser can't print (or prints with caveats), for the unsupported-browser screen and
 * the connect dialog. null = fully supported.
 */
export function describeSupport(support: SupportInfo): Problem | null {
  const tech = `${support.engine}/${support.platform}${support.brave ? '/brave' : ''}`
  if (support.platform === 'ios')
    return { id: 'unsupported-browser', severity: 'info', title: 'iPhone and iPad can’t talk to label printers', detail: `No browser on iOS or iPadOS supports Web Serial or WebUSB. Design your label here, then print from ${CHROME_EDGE} on a computer or Android phone.`, actions: ['dismiss'], technical: tech }
  if (support.brave && !support.canPrint)
    return { id: 'unsupported-browser', severity: 'info', title: 'Brave has printer access turned off', detail: `Enable “Web Serial API” at brave://flags (search for “serial”), restart Brave, and reload this page — or use ${CHROME_EDGE}.`, actions: ['dismiss'], technical: tech }
  if (support.engine === 'webkit')
    return { id: 'unsupported-browser', severity: 'info', title: 'Safari can’t talk to label printers', detail: `Safari supports neither Web Serial nor WebUSB. Open this page in ${CHROME_EDGE} to print; you can still design labels here.`, actions: ['dismiss'], technical: tech }
  if (support.engine === 'gecko' && !support.canPrint)
    return {
      id: 'unsupported-browser',
      severity: 'info',
      title: 'This Firefox can’t talk to label printers',
      detail:
        support.platform === 'android'
          ? `Firefox for Android has no Web Serial. Use Chrome on Android to print.`
          : `Printing needs Firefox 151 or newer with serial ports allowed (some managed installs turn it off), or ${CHROME_EDGE}.`,
      actions: ['dismiss'],
      technical: tech,
    }
  if (!support.canPrint) return { ...unsupported(support), technical: tech }
  if (support.engine === 'gecko')
    return {
      id: 'no-reply-firefox',
      severity: 'info',
      title: 'Firefox works through the system serial port only',
      detail:
        support.platform === 'mac'
          ? `Pair the printer in System Settings › Bluetooth, then choose “cu.PT-P710BTxxxx”. On macOS this port often works only once per pairing; ${CHROME_EDGE} are more reliable.`
          : `Pair the printer in your system’s Bluetooth settings first, then choose its serial port. ${CHROME_EDGE} can connect over Bluetooth directly.`,
      actions: ['dismiss'],
      technical: tech,
    }
  return null
}

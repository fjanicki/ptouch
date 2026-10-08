// W5 — small per-browser preferences in localStorage (try/catch everywhere; private windows
// may throw). Never store printer-identifying data beyond what getPorts()/getDevices() already
// hold (the transport kind/label used to pick the right granted port). Values are sanitized
// on load, so a corrupt or hand-edited entry falls back to defaults field by field.

export type ConnectPathPref = 'bluetooth' | 'serial-port' | 'usb' | 'virtual'

export interface Prefs {
  /** Last successful connect path, for "Reconnect" and auto-reconnect on load. */
  lastPath?: ConnectPathPref
  /** Remembered transport info (kind + label) to match a granted port. */
  lastTransport?: { kind: string; label: string; bluetoothServiceClassId?: string }
  /** Cleared by a deliberate "Disconnect". */
  autoReconnect: boolean
  theme: 'system' | 'light' | 'dark'
  /** Id of the last open label. */
  lastLabelId?: string
  previewZoom: number
  previewMode: 'design' | 'dots'
  /** Windows users who installed WinUSB may opt in to USB. */
  usbOnWindows: boolean
  /** Single-character keyboard shortcuts (1, 0, +, -, [, ], ?); can be turned off (WCAG 2.1.4). */
  singleKeyShortcuts: boolean
  /** Unsupported browser: the user chose to design labels anyway (skip the blocking screen). */
  designAnyway: boolean
}

export const DEFAULT_PREFS: Prefs = {
  autoReconnect: true,
  theme: 'system',
  previewZoom: 1,
  previewMode: 'design',
  usbOnWindows: false,
  singleKeyShortcuts: true,
  designAnyway: false,
}

export const PREFS_KEY = 'ptouch.prefs.v1'

/** Storage subset (localStorage); injectable for tests. */
export type PrefsStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): PrefsStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined
  } catch {
    return undefined // SecurityError: storage disabled
  }
}

const PATHS: readonly ConnectPathPref[] = ['bluetooth', 'serial-port', 'usb', 'virtual']
const THEMES: readonly Prefs['theme'][] = ['system', 'light', 'dark']

/** Keeps only well-typed fields; anything else falls back to the default. */
export function sanitizePrefs(raw: unknown): Prefs {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const p: Prefs = { ...DEFAULT_PREFS }
  if (PATHS.includes(r['lastPath'] as ConnectPathPref)) p.lastPath = r['lastPath'] as ConnectPathPref
  const t = r['lastTransport'] as Record<string, unknown> | undefined
  if (t && typeof t === 'object' && typeof t['kind'] === 'string' && typeof t['label'] === 'string') {
    p.lastTransport = { kind: t['kind'], label: t['label'], ...(typeof t['bluetoothServiceClassId'] === 'string' ? { bluetoothServiceClassId: t['bluetoothServiceClassId'] } : {}) }
  }
  if (typeof r['autoReconnect'] === 'boolean') p.autoReconnect = r['autoReconnect']
  if (THEMES.includes(r['theme'] as Prefs['theme'])) p.theme = r['theme'] as Prefs['theme']
  if (typeof r['lastLabelId'] === 'string' && r['lastLabelId']) p.lastLabelId = r['lastLabelId']
  if (typeof r['previewZoom'] === 'number' && Number.isFinite(r['previewZoom'])) p.previewZoom = Math.min(16, Math.max(0.1, r['previewZoom']))
  if (r['previewMode'] === 'design' || r['previewMode'] === 'dots') p.previewMode = r['previewMode']
  if (typeof r['usbOnWindows'] === 'boolean') p.usbOnWindows = r['usbOnWindows']
  if (typeof r['singleKeyShortcuts'] === 'boolean') p.singleKeyShortcuts = r['singleKeyShortcuts']
  if (typeof r['designAnyway'] === 'boolean') p.designAnyway = r['designAnyway']
  return p
}

export function loadPrefs(storage: PrefsStorage | undefined = defaultStorage()): Prefs {
  try {
    const raw = storage?.getItem(PREFS_KEY)
    return raw ? sanitizePrefs(JSON.parse(raw)) : { ...DEFAULT_PREFS }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

/**
 * Merges `patch` into the stored prefs and returns the result. Keys set to `undefined` in the
 * patch are removed (e.g. `{ lastPath: undefined }`). Never throws.
 */
export function savePrefs(patch: Partial<Prefs>, storage: PrefsStorage | undefined = defaultStorage()): Prefs {
  const merged: Record<string, unknown> = { ...loadPrefs(storage) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete merged[k]
    else merged[k] = v
  }
  const next = sanitizePrefs(merged)
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify(next))
  } catch {
    // storage unavailable or full: preferences are best-effort
  }
  return next
}

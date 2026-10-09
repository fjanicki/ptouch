// W5 — small per-browser preferences in localStorage (try/catch everywhere; private windows
// may throw). Never store printer-identifying data beyond what getPorts()/getDevices() already
// hold (the transport kind/label used to pick the right granted port). Values are sanitized
// on load, so a corrupt or hand-edited entry falls back to defaults field by field.
//
// Fonts and size (docs/FONTS-AND-SIZE-PLAN.md, lead-owned): the default font and text size for
// new text blocks, favourite and recently used fonts (font picker).
import { CONTENT_REF_RE, FONT_FAMILY_IDS, LIMITS, type FontFamilyId, type FontWeight } from './schema'

export type ConnectPathPref = 'bluetooth' | 'serial-port' | 'usb' | 'virtual'

/**
 * Size of a NEW text block (existing blocks never change):
 * - 'auto': fit the tape on narrow tape (≤ 9 mm), half the printable height on 12 mm and wider
 *   (ui/state/text-defaults.ts; the reasoning is in docs/FONTS-AND-SIZE-PLAN.md §3);
 * - 'fit' / 'half' / 'third': fit, or that fraction of the printable height (quick sizes M / S);
 * - `{pt}`: a fixed point size.
 */
export type DefaultTextSize = 'auto' | 'fit' | 'half' | 'third' | { pt: number }

/**
 * A font in the picker's favourites / recent lists, same encoding as the picker's values:
 * `b:<FontFamilyId>` (bundled), `u:<content ref>` (uploaded), `l:<PostScript name>` (this
 * computer). Uploaded/local keys may point at fonts that are gone; the picker skips those.
 */
export type FontKey = string

/** Most favourites / recent fonts kept. */
export const MAX_FAVORITE_FONTS = 50
export const MAX_RECENT_FONTS = 8

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
  /** Font of new text blocks (bundled only: a custom font may be missing on another device). */
  defaultFont: { family: FontFamilyId; weight: FontWeight }
  defaultTextSize: DefaultTextSize
  /** Starred fonts, in the order they were starred. */
  favoriteFonts: FontKey[]
  /** Recently picked fonts, most recent first (≤ MAX_RECENT_FONTS). */
  recentFonts: FontKey[]
}

export const DEFAULT_PREFS: Prefs = {
  autoReconnect: true,
  theme: 'system',
  previewZoom: 1,
  previewMode: 'design',
  usbOnWindows: false,
  singleKeyShortcuts: true,
  designAnyway: false,
  defaultFont: { family: 'fira-sans', weight: 600 },
  defaultTextSize: 'auto',
  favoriteFonts: [],
  recentFonts: [],
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
const WEIGHTS: readonly FontWeight[] = [400, 500, 600, 700, 800]
const SIZE_WORDS: readonly DefaultTextSize[] = ['auto', 'fit', 'half', 'third']

/** `true` for a well-formed `FontKey` (a known bundled id, a content ref, a safe local name). */
export function isFontKey(v: unknown): v is FontKey {
  if (typeof v !== 'string') return false
  const rest = v.slice(2)
  if (v.startsWith('b:')) return (FONT_FAMILY_IDS as readonly string[]).includes(rest)
  if (v.startsWith('u:')) return CONTENT_REF_RE.test(rest)
  if (v.startsWith('l:')) return /^[\x20-\x7e]{1,100}$/.test(rest) && !/["'\\]/.test(rest)
  return false
}

/** Well-formed, deduplicated keys, at most `max`. */
function fontKeys(v: unknown, max: number): FontKey[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter(isFontKey))].slice(0, max)
}

function defaultTextSize(v: unknown): DefaultTextSize | undefined {
  if (SIZE_WORDS.includes(v as DefaultTextSize)) return v as DefaultTextSize
  const pt = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)['pt'] : undefined
  if (typeof pt === 'number' && Number.isFinite(pt)) return { pt: Math.min(LIMITS.sizePt.max, Math.max(LIMITS.sizePt.min, pt)) }
  return undefined
}

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
  const f = r['defaultFont'] as Record<string, unknown> | undefined
  if (f && typeof f === 'object' && (FONT_FAMILY_IDS as readonly unknown[]).includes(f['family']) && WEIGHTS.includes(f['weight'] as FontWeight)) {
    p.defaultFont = { family: f['family'] as FontFamilyId, weight: f['weight'] as FontWeight }
  }
  p.defaultTextSize = defaultTextSize(r['defaultTextSize']) ?? DEFAULT_PREFS.defaultTextSize
  p.favoriteFonts = fontKeys(r['favoriteFonts'], MAX_FAVORITE_FONTS)
  p.recentFonts = fontKeys(r['recentFonts'], MAX_RECENT_FONTS)
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

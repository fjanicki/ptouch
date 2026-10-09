// P4 — fonts installed on this computer (Local Font Access API, Chromium desktop only). The list
// is asked for ONLY from a click (it shows a permission prompt) and kept for this tab, shared by
// the font manager and every text block's font picker. The fonts vary by machine: a label that
// uses one prints as designed only where that font is installed.
// Typed locally (no @types dependency): https://wicg.github.io/local-font-access/
import { LIMITS } from '../../doc/schema'

interface FontData {
  family: string
  fullName: string
  postscriptName: string
  style: string
}
type QueryLocalFonts = (opts?: { postscriptNames?: string[] }) => Promise<FontData[]>

export interface LocalFontInfo {
  /** `local("…")` name; validated like schema.ts readFontSource (printable ASCII, no quotes). */
  postscriptName: string
  /** Display name (full name, e.g. "Helvetica Neue Bold"). */
  name: string
}

export type LocalFontsStatus = 'idle' | 'loading' | 'ready' | 'denied' | 'error'

/** `true` where the browser can list installed fonts (Chrome/Edge on a computer). */
export function localFontsSupported(): boolean {
  return typeof (globalThis as unknown as { queryLocalFonts?: unknown }).queryLocalFonts === 'function'
}

const PS_RE = /^[\x20-\x7e]{1,100}$/

/** Usable entries, deduplicated by PostScript name, sorted by display name. */
export function toLocalFonts(list: readonly FontData[]): LocalFontInfo[] {
  const seen = new Map<string, LocalFontInfo>()
  for (const f of list) {
    const ps = typeof f.postscriptName === 'string' ? f.postscriptName : ''
    if (!PS_RE.test(ps) || /["'\\]/.test(ps) || seen.has(ps)) continue
    const name = (typeof f.fullName === 'string' && f.fullName.trim() ? f.fullName : ps).replace(/\s+/g, ' ').trim().slice(0, LIMITS.fontNameChars)
    seen.set(ps, { postscriptName: ps, name })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

class LocalFonts {
  status = $state<LocalFontsStatus>('idle')
  fonts = $state.raw<LocalFontInfo[]>([])
  error = $state<string | null>(null)

  /** Asks the browser for the installed fonts. Call from a click (permission prompt). */
  async query(): Promise<void> {
    const q = (globalThis as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts
    if (typeof q !== 'function' || this.status === 'loading') return
    this.status = 'loading'
    this.error = null
    try {
      this.fonts = toLocalFonts(await q.call(globalThis))
      this.status = 'ready'
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
      this.status = denied ? 'denied' : 'error'
      this.error = denied ? 'Access to this computer’s fonts was not allowed. You can allow it in the site settings.' : 'This computer’s fonts could not be listed.'
    }
  }
}

/** The tab-wide list. */
export const localFonts = new LocalFonts()

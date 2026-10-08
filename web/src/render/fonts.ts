// W3 — bundled OFL fonts (web/public/fonts/*.woff2, listed in public/fonts/SOURCES.md and
// web/THIRD_PARTY.md). Loaded with the FontFace API from `import.meta.env.BASE_URL + 'fonts/…'`
// so they work under /ptouch/ and offline (precached). Chosen for 180 dpi (ARCHITECTURE §6.2).
//
// Faces are registered under a private family name ("ptouch Fira Sans"…) so a copy of the same
// family installed on the user's machine can never stand in for the bundled file: the preview
// and the printed dots are always drawn with exactly the bundled font.
import type { FontFamilyId, FontWeight, LabelDoc } from '../doc/schema'

export interface FontDef {
  id: FontFamilyId
  /** CSS family name registered with FontFace. */
  family: string
  label: string
  /** Weights that have their own file (other weights use the nearest one, see `resolveWeight`). */
  weights: FontWeight[]
  /** File per weight, relative to `${BASE_URL}fonts/`. */
  files: Partial<Record<FontWeight, string>>
  license: 'OFL-1.1'
  /** Licence text next to the files. */
  licenseFile: string
  /** Short description for the font picker. */
  hint: string
}

export const FONTS: readonly FontDef[] = [
  {
    id: 'fira-sans',
    family: 'ptouch Fira Sans',
    label: 'Fira Sans',
    weights: [400, 500, 600, 700, 800],
    files: {
      400: 'FiraSans-Regular.woff2',
      500: 'FiraSans-Medium.woff2',
      600: 'FiraSans-SemiBold.woff2',
      700: 'FiraSans-Bold.woff2',
      800: 'FiraSans-ExtraBold.woff2',
    },
    license: 'OFL-1.1',
    licenseFile: 'OFL-FiraSans.txt',
    hint: 'Clear, sturdy sans-serif',
  },
  {
    id: 'archivo-narrow',
    family: 'ptouch Archivo Narrow',
    label: 'Archivo Narrow',
    weights: [400, 500, 600, 700],
    files: {
      400: 'ArchivoNarrow-Regular.woff2',
      500: 'ArchivoNarrow-Medium.woff2',
      600: 'ArchivoNarrow-SemiBold.woff2',
      700: 'ArchivoNarrow-Bold.woff2',
    },
    license: 'OFL-1.1',
    licenseFile: 'OFL-ArchivoNarrow.txt',
    hint: 'Condensed: more text per label',
  },
  {
    id: 'jetbrains-mono',
    family: 'ptouch JetBrains Mono',
    label: 'JetBrains Mono',
    weights: [400, 700],
    files: { 400: 'JetBrainsMono-Regular.woff2', 700: 'JetBrainsMono-Bold.woff2' },
    license: 'OFL-1.1',
    licenseFile: 'OFL-JetBrainsMono.txt',
    hint: 'Monospaced: serial numbers, codes',
  },
  {
    id: 'atkinson-hyperlegible',
    family: 'ptouch Atkinson Hyperlegible',
    label: 'Atkinson Hyperlegible',
    weights: [400, 700],
    files: { 400: 'AtkinsonHyperlegible-Regular.woff2', 700: 'AtkinsonHyperlegible-Bold.woff2' },
    license: 'OFL-1.1',
    licenseFile: 'OFL-AtkinsonHyperlegible.txt',
    hint: 'Designed for low vision: distinct 0/O, 1/l/I',
  },
]

/** The family used for the human-readable line under linear barcodes. */
export const CODE_TEXT_FONT: { id: FontFamilyId; weight: FontWeight } = { id: 'jetbrains-mono', weight: 400 }

export function fontDef(id: FontFamilyId): FontDef {
  return FONTS.find((f) => f.id === id) ?? (FONTS[0] as FontDef)
}

/** Nearest weight that has a file (ties go to the lighter weight). */
export function resolveWeight(def: FontDef, weight: number): FontWeight {
  let best = def.weights[0] ?? 400
  for (const w of def.weights) if (Math.abs(w - weight) < Math.abs(best - weight)) best = w
  return best
}

/** URL of a font file under the app's base path (works at / in dev and /ptouch/ on Pages). */
export function fontUrl(file: string): string {
  const base = typeof import.meta.env?.BASE_URL === 'string' ? import.meta.env.BASE_URL : '/'
  return `${base.endsWith('/') ? base : `${base}/`}fonts/${file}`
}

export interface FontReport {
  /** "Family weight" strings that fell back to a system font. */
  fallbacks: string[]
}

export interface FontUse {
  id: FontFamilyId
  weight: FontWeight
}

/** Every (family, resolved weight) a document draws with, deduplicated. */
export function fontsUsed(doc: LabelDoc): FontUse[] {
  const seen = new Map<string, FontUse>()
  const add = (id: FontFamilyId, weight: number): void => {
    const def = fontDef(id)
    const w = resolveWeight(def, weight)
    seen.set(`${def.id}:${w}`, { id: def.id, weight: w })
  }
  for (const it of doc.items) {
    if (it.kind === 'text' && it.text.trim() !== '') add(it.fontFamily, it.fontWeight)
    if (it.kind === 'code' && it.showText && it.symbology !== 'qr') add(CODE_TEXT_FONT.id, CODE_TEXT_FONT.weight)
  }
  return [...seen.values()]
}

type FontSet = FontFaceSet & { add(font: FontFace): FontFaceSet }

/** `document.fonts`, or the worker's `self.fonts`; undefined where fonts cannot be loaded. */
function fontSet(): FontSet | undefined {
  const g = globalThis as unknown as { document?: { fonts?: FontSet }; fonts?: FontSet }
  return g.document?.fonts ?? g.fonts
}

const loading = new Map<string, Promise<boolean>>()

/** Loads one face (once per page); resolves `true` when it is usable. */
function loadFace(def: FontDef, weight: FontWeight): Promise<boolean> {
  const key = `${def.id}:${weight}`
  const cached = loading.get(key)
  if (cached) return cached
  const p = (async () => {
    const set = fontSet()
    const file = def.files[weight]
    if (!set || !file || typeof FontFace === 'undefined') return false
    try {
      const face = new FontFace(def.family, `url("${fontUrl(file)}") format("woff2")`, {
        weight: String(weight),
        style: 'normal',
        display: 'block',
      })
      set.add(face)
      await face.load()
      return true
    } catch {
      return false
    }
  })()
  // A failed load (offline before the first visit was cached…) may succeed on the next render.
  p.then((ok) => {
    if (!ok) loading.delete(key)
  }, () => loading.delete(key))
  loading.set(key, p)
  return p
}

/**
 * CSS `font` shorthand that selects the bundled face, with a generic fallback of the same kind
 * (`sans-serif` / `monospace`) so a face that failed to load never turns into Times.
 */
export function faceCss(def: FontDef, weight: FontWeight, px: number, italic = false): string {
  return `${exactFaceCss(def, weight, px, italic)}, ${def.id === 'jetbrains-mono' ? 'monospace' : 'sans-serif'}`
}

/** Only the bundled face (no fallback): for `fonts.check()`. */
function exactFaceCss(def: FontDef, weight: FontWeight, px: number, italic = false): string {
  return `${italic ? 'italic ' : ''}${weight} ${px}px "${def.family}"`
}

/** `true` if the face is loaded and will be used for drawing. */
export function isFaceReady(def: FontDef, weight: FontWeight): boolean {
  const set = fontSet()
  if (!set) return false
  try {
    return set.check(exactFaceCss(def, weight, 16))
  } catch {
    return false
  }
}

/**
 * Loads every family/weight `doc` uses (FontFace), then asserts `fonts.check()` for each. Safe
 * to call before every render: faces load once. Fallbacks are reported, never thrown.
 */
export async function ensureFonts(doc: LabelDoc): Promise<FontReport> {
  const uses = fontsUsed(doc)
  const results = await Promise.all(uses.map(async (u) => {
    const def = fontDef(u.id)
    const ok = await loadFace(def, u.weight)
    return ok && isFaceReady(def, u.weight) ? undefined : `${def.label} ${u.weight}`
  }))
  return { fallbacks: results.filter((r): r is string => r !== undefined) }
}

/** Loads every bundled face (font picker previews, diagnostics). */
export async function preloadAllFonts(): Promise<FontReport> {
  const all = FONTS.flatMap((def) => def.weights.map((w) => ({ def, w })))
  const res = await Promise.all(all.map(async ({ def, w }) => ((await loadFace(def, w)) ? undefined : `${def.label} ${w}`)))
  return { fallbacks: res.filter((r): r is string => r !== undefined) }
}

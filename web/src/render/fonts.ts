// W3 — bundled fonts (web/public/fonts/*.woff2, listed in public/fonts/SOURCES.md and
// web/THIRD_PARTY.md). Loaded with the FontFace API from `import.meta.env.BASE_URL + 'fonts/…'`
// so they work under /ptouch/. Chosen for 180 dpi (ARCHITECTURE §6.2).
//
// Font library (docs/FONTS-AND-SIZE-PLAN.md): the core families are precached; every other
// family loads on first use (`loadFamily`, or `ensureFonts` before a render) and is then cached
// by the service worker (pwa.config.ts runtime rule for fonts/*.woff2), so it works offline too.
//
// Faces are registered under a private family name ("ptouch Fira Sans"…) so a copy of the same
// family installed on the user's machine can never stand in for the bundled file: the preview
// and the printed dots are always drawn with exactly the bundled font.
//
// P4 — custom fonts (`TextItem.customFont`, docs/STUDIO-V1-PLAN.md §3 P4): an uploaded file is
// registered from its bytes under `ptouch-user-<ref>`, a font installed on this computer with
// `local("<postscriptName>")` under `ptouch-local-<name>`. Both get the weight range `1 1000`, so
// the one file is used for every weight and the canvas never synthesises bold. A custom font
// that cannot be loaded is reported as `missing`; the item then draws with its bundled family.
import type { FontFamilyId, FontSource, FontWeight, LabelDoc, TextItem } from '../doc/schema'
import { CODE_TEXT_FONT, FONTS, findFont, type FontDef } from './font-catalog'

// The registry (types frozen by the lead, data by P-lib) lives in font-catalog.ts; re-exported
// here so existing imports keep working.
export { CODE_TEXT_FONT, FONT_CATEGORIES, FONTS, MIN_QUALITY_CAP_MM, coreFontFiles, findFont, type FontCategory, type FontDef, type FontLicense } from './font-catalog'

export function fontDef(id: FontFamilyId): FontDef {
  return findFont(id) ?? (FONTS[0] as FontDef)
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
  /** Custom fonts (`TextItem.customFont`) not available on this device: the item's bundled
   * family is used instead (display names, deduplicated). */
  missing?: string[]
}

export interface EnsureFontsOptions {
  /** Resolves an uploaded font's blob (persist-fonts.ts FontStore.get). */
  loadFontBlob?: (ref: string) => Promise<Blob | undefined>
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
/** Faces whose file loaded in this page ("id:weight"). `fonts.check()` alone is not enough: it
 * also answers `true` for a family that was never registered (nothing to load). */
const loaded = new Set<string>()

type FileListener = (url: string) => void
/** URLs of library (not precached) font files this page loaded, for the service worker cache. */
const libraryFiles = new Set<string>()
const fileListeners = new Set<FileListener>()

/**
 * Calls `fn` with the URL of every library font file this page has loaded, now and from then on
 * (pwa/font-cache.ts puts them into the service worker's font cache, so a font used on the very
 * first visit, before the worker controls the page, also works offline later). Core files are
 * precached and never reported. Returns an unsubscribe function.
 */
export function onLibraryFontFile(fn: FileListener): () => void {
  fileListeners.add(fn)
  for (const url of libraryFiles) fn(url)
  return () => fileListeners.delete(fn)
}

/** Loads one face (once per page); resolves `true` when it is usable. */
function loadFace(def: FontDef, weight: FontWeight): Promise<boolean> {
  const key = `${def.id}:${weight}`
  const cached = loading.get(key)
  if (cached) return cached
  const p = (async () => {
    const set = fontSet()
    const file = def.files[weight]
    if (!set || !file || typeof FontFace === 'undefined') return false
    // One face per weight, even when weights share a file (Quicksand's variable font): the
    // browser then sets the `wght` axis from the requested weight.
    let face: FontFace | undefined
    try {
      face = new FontFace(def.family, `url("${fontUrl(file)}") format("woff2")`, {
        weight: String(weight),
        style: 'normal',
        display: 'block',
      })
      set.add(face)
      await face.load()
      loaded.add(key)
      if (!def.core) {
        const url = fontUrl(file)
        if (!libraryFiles.has(url)) {
          libraryFiles.add(url)
          for (const fn of fileListeners) fn(url)
        }
      }
      return true
    } catch {
      // Unregister the failed face so the generic fallback draws and a retry starts clean.
      try {
        if (face) set.delete(face)
      } catch {
        // not in the set
      }
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
 * Loads the face of family `id` that `weight` resolves to (nearest file, `resolveWeight`): once
 * per page, concurrent calls share one request, a failure is retried on the next call. Resolves
 * `true` when the face is usable. The picker calls it for previews and to show a spinner; the
 * renderer goes through `ensureFonts`, which uses the same cache.
 */
export function loadFamily(id: FontFamilyId, weight: number = 400): Promise<boolean> {
  const def = fontDef(id)
  return loadFace(def, resolveWeight(def, weight))
}

/** `true` if the face `loadFamily(id, weight)` loads is ready now (synchronous; no request). */
export function familyReady(id: FontFamilyId, weight: number = 400): boolean {
  const def = fontDef(id)
  return isFaceReady(def, resolveWeight(def, weight))
}

/** `true` while that face is being fetched (picker spinner). */
export function familyLoading(id: FontFamilyId, weight: number = 400): boolean {
  const def = fontDef(id)
  return loading.has(`${def.id}:${resolveWeight(def, weight)}`) && !isFaceReady(def, resolveWeight(def, weight))
}

/**
 * CSS `font` shorthand that selects the bundled face, with a generic fallback of the same kind
 * (`def.generic`: `sans-serif`, `monospace`…) so a face that failed to load never turns into Times.
 */
export function faceCss(def: FontDef, weight: FontWeight, px: number, italic = false): string {
  return `${exactFaceCss(def, weight, px, italic)}, ${def.generic}`
}

/** Only the bundled face (no fallback): for `fonts.check()`. */
function exactFaceCss(def: FontDef, weight: FontWeight, px: number, italic = false): string {
  return `${italic ? 'italic ' : ''}${weight} ${px}px "${def.family}"`
}

/**
 * `true` if the face a text item draws with is loaded: its custom font when that is available,
 * else its bundled family/weight. The renderer measures with real metrics only when this holds.
 */
export function textFaceReady(item: Pick<TextItem, 'fontFamily' | 'fontWeight'> & Partial<Pick<TextItem, 'customFont'>>): boolean {
  const custom = activeCustomFamily(item)
  if (custom) return checkFace(`400 16px "${custom}"`)
  const def = fontDef(item.fontFamily)
  return isFaceReady(def, resolveWeight(def, item.fontWeight))
}

function checkFace(css: string): boolean {
  const set = fontSet()
  if (!set) return false
  try {
    return set.check(css)
  } catch {
    return false
  }
}

/** `true` if the face is loaded and will be used for drawing. */
export function isFaceReady(def: FontDef, weight: FontWeight): boolean {
  const set = fontSet()
  if (!set || !loaded.has(`${def.id}:${resolveWeight(def, weight)}`)) return false
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
export async function ensureFonts(doc: LabelDoc, opts: EnsureFontsOptions = {}): Promise<FontReport> {
  const uses = fontsUsed(doc)
  const [results, custom] = await Promise.all([
    Promise.all(uses.map(async (u) => {
      const def = fontDef(u.id)
      const ok = await loadFace(def, u.weight)
      return ok && isFaceReady(def, u.weight) ? undefined : `${def.label} ${u.weight}`
    })),
    Promise.all(customFontsUsed(doc).map(async (src) => ((await loadCustomFont(src, opts.loadFontBlob)) ? undefined : src.family))),
  ])
  const missing = [...new Set(custom.filter((r): r is string => r !== undefined))]
  return { fallbacks: results.filter((r): r is string => r !== undefined), ...(missing.length ? { missing } : {}) }
}

// ------------------------------------------------------------------------------------------
// Custom fonts (uploaded / installed on this computer)
// ------------------------------------------------------------------------------------------

/** Private CSS family of a custom font (never collides with the bundled or system families). */
export function customFamily(src: FontSource): string {
  return src.kind === 'user' ? `ptouch-user-${src.ref}` : `ptouch-local-${src.postscriptName}`
}

const customKey = (src: FontSource): string => (src.kind === 'user' ? `user:${src.ref}` : `local:${src.postscriptName}`)

/** Loaded custom faces by key (only successes are kept: a missing font may be added later). */
const customFaces = new Map<string, FontFace>()
const customLoading = new Map<string, Promise<boolean>>()
/** Keys whose last load attempt failed (the font is not on this device). */
const customFailed = new Set<string>()

/** Every distinct custom font a document's (non-empty) text items use. */
export function customFontsUsed(doc: LabelDoc): FontSource[] {
  const seen = new Map<string, FontSource>()
  for (const it of doc.items) if (it.kind === 'text' && it.customFont && it.text.trim() !== '') seen.set(customKey(it.customFont), it.customFont)
  return [...seen.values()]
}

/** `true` once `src` is loaded in this page (the renderer then draws with it). */
export function customFontReady(src: FontSource): boolean {
  return customFaces.has(customKey(src))
}

/** `true` once loading `src` was tried and failed (not merely not tried yet). */
export function customFontMissing(src: FontSource): boolean {
  return customFailed.has(customKey(src)) && !customFaces.has(customKey(src))
}

/** The custom family an item draws with right now, or undefined (bundled family). */
export function activeCustomFamily(item: Partial<Pick<TextItem, 'customFont'>>): string | undefined {
  return item.customFont && customFontReady(item.customFont) ? customFamily(item.customFont) : undefined
}

/**
 * Loads a custom font once per page; resolves `true` when it is usable. An uploaded font needs
 * `loadFontBlob` (FontStore.get) the first time; a local font is looked up by the browser.
 */
export function loadCustomFont(src: FontSource, loadFontBlob?: (ref: string) => Promise<Blob | undefined>): Promise<boolean> {
  const key = customKey(src)
  if (customFaces.has(key)) return Promise.resolve(true)
  const pending = customLoading.get(key)
  if (pending) return pending
  const p = (async (): Promise<boolean> => {
    const set = fontSet()
    if (!set || typeof FontFace === 'undefined') return false
    let source: string | ArrayBuffer
    if (src.kind === 'user') {
      const blob = loadFontBlob ? await loadFontBlob(src.ref).catch(() => undefined) : undefined
      if (!blob) return false
      source = await blob.arrayBuffer()
    } else {
      // Validated in schema.ts (no quotes or backslashes), so it cannot break out of local("…").
      if (/["'\\]/.test(src.postscriptName)) return false
      source = `local("${src.postscriptName}")`
    }
    try {
      const face = new FontFace(customFamily(src), source, { weight: '1 1000', style: 'normal', display: 'block' })
      await face.load()
      set.add(face)
      customFaces.set(key, face)
      return true
    } catch {
      return false
    }
  })()
    .then((ok) => {
      if (ok) customFailed.delete(key)
      else customFailed.add(key)
      return ok
    })
    .finally(() => customLoading.delete(key))
  customLoading.set(key, p)
  return p
}

/** Unregisters an uploaded font (FontManager "Remove"): labels using it fall back from now on. */
export function forgetCustomFont(src: FontSource): void {
  const key = customKey(src)
  const face = customFaces.get(key)
  customFaces.delete(key)
  customFailed.delete(key)
  if (!face) return
  try {
    fontSet()?.delete(face)
  } catch {
    // already gone
  }
}

/** Loads every bundled face, the whole library included (about 1.4 MB): tests and diagnostics
 * only; the app loads library families on first use (`loadFamily`, `ensureFonts`). */
export async function preloadAllFonts(): Promise<FontReport> {
  const all = FONTS.flatMap((def) => def.weights.map((w) => ({ def, w })))
  const res = await Promise.all(all.map(async ({ def, w }) => ((await loadFace(def, w)) ? undefined : `${def.label} ${w}`)))
  return { fallbacks: res.filter((r): r is string => r !== undefined) }
}

// Font library registry (docs/FONTS-AND-SIZE-PLAN.md).
//
// - The TYPES and helpers above the "Data" line are lead-owned and frozen: the picker (P-picker),
//   the sizing code (P-size) and the loader in render/fonts.ts rely on them.
// - The DATA (`FONTS`) is owned by P-lib: one entry per `FontFamilyId` (doc/schema.ts), files
//   in web/public/fonts/ documented in public/fonts/SOURCES.md, licences next to the files.
//
// Every family is registered under a private CSS name ("ptouch <Family>") so a copy installed on
// the user's machine can never stand in for the bundled file: the preview and the printed dots
// are always drawn with exactly the bundled font.
import type { FontFamilyId, FontWeight } from '../doc/schema'

/** Picker sections (and filter chips), in display order. */
export type FontCategory = 'sans' | 'condensed' | 'industrial' | 'rounded' | 'handwritten' | 'stencil' | 'typewriter' | 'pixel' | 'accessible' | 'mono'

export const FONT_CATEGORIES: readonly { id: FontCategory; label: string }[] = [
  { id: 'sans', label: 'Sans' },
  { id: 'condensed', label: 'Condensed & bold' },
  { id: 'industrial', label: 'Industrial' },
  { id: 'rounded', label: 'Rounded' },
  { id: 'handwritten', label: 'Handwritten' },
  { id: 'stencil', label: 'Stencil' },
  { id: 'typewriter', label: 'Typewriter & slab' },
  { id: 'pixel', label: 'Pixel' },
  { id: 'accessible', label: 'Easy to read' },
  { id: 'mono', label: 'Monospaced' },
]

/** SPDX ids of the licences a bundled font may have (both allow bundling and subsetting). */
export type FontLicense = 'OFL-1.1' | 'Apache-2.0'

export interface FontDef {
  id: FontFamilyId
  /** CSS family name registered with FontFace: always "ptouch <label>". */
  family: string
  /** Display name (the upstream family name, or the OFL rename when the font was renamed). */
  label: string
  category: FontCategory
  /** Weights that have their own file (other weights use the nearest one, see `resolveWeight`). */
  weights: FontWeight[]
  /** File per weight, relative to `${BASE_URL}fonts/`. A lazily loaded file never changes its
   * content under the same name (the service worker caches it CacheFirst): new bytes, new name. */
  files: Partial<Record<FontWeight, string>>
  license: FontLicense
  /** Licence text next to the files (`OFL-<Family>.txt`, `Apache-<Family>.txt`). */
  licenseFile: string
  /** Short description for the font picker. */
  hint: string
  /** Sample the picker shows when the text block is empty (short; in the font's character set). */
  preview: string
  /** CSS generic family drawn when the face failed to load. */
  generic: 'sans-serif' | 'serif' | 'monospace' | 'cursive'
  /** Core family: precached with the app (offline from the first visit; pwa.config.ts). The
   * others load on first use and are then cached by the service worker. */
  core: boolean
  /**
   * Pixel font: `emPx` design pixels per em (one design pixel = unitsPerEm / emPx font units).
   * Crisp when the em size in dots is a whole multiple of `emPx` and glyph origins sit on whole
   * dots (P-size snaps both and draws without anti-aliasing).
   */
  pixel?: { emPx: number }
  /** Thin strokes or a script: the picker warns below `MIN_QUALITY_CAP_MM`. */
  quality?: 'thin' | 'script'
  /** Narrow letters: more text per label. */
  condensed?: boolean
}

/** Cap height (mm) below which a `quality` font prints poorly at 180 dpi (picker hint). */
export const MIN_QUALITY_CAP_MM = 3

/** The family used for the human-readable line under linear barcodes. */
export const CODE_TEXT_FONT: { id: FontFamilyId; weight: FontWeight } = { id: 'jetbrains-mono', weight: 400 }

// ------------------------------------------------------------------------------------------
// Data (P-lib). The four core families come first; FONTS[0] is the fallback for unknown ids.
// ------------------------------------------------------------------------------------------

type LibOptions = Partial<Pick<FontDef, 'license' | 'generic' | 'pixel' | 'quality' | 'condensed'>> & {
  /** One variable file (`<Stem>-Variable.woff2`) serves every weight. */
  variable?: boolean
}

const STYLE: Record<FontWeight, string> = { 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold' }

/**
 * A library (lazily loaded) entry. Names follow from the label: family "ptouch <label>", files
 * `<Stem>-<Style>.woff2` and licence `OFL-<Stem>.txt` / `Apache-<Stem>.txt`, where `<Stem>` is the
 * label without spaces. The licence defaults to OFL-1.1 and the generic family to sans-serif.
 */
function lib(id: FontFamilyId, label: string, category: FontCategory, weights: FontWeight[], hint: string, preview: string, opts: LibOptions = {}): FontDef {
  const { variable, license = 'OFL-1.1', generic = 'sans-serif', ...flags } = opts
  const stem = label.replace(/ /g, '')
  const files = Object.fromEntries(weights.map((w) => [w, `${stem}-${variable ? 'Variable' : STYLE[w]}.woff2`]))
  const licenseFile = `${license === 'OFL-1.1' ? 'OFL' : 'Apache'}-${stem}.txt`
  return { id, family: `ptouch ${label}`, label, category, weights, files, license, licenseFile, hint, preview, generic, core: false, ...flags }
}

export const FONTS: readonly FontDef[] = [
  {
    id: 'fira-sans',
    family: 'ptouch Fira Sans',
    label: 'Fira Sans',
    category: 'sans',
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
    preview: 'Label 123',
    generic: 'sans-serif',
    core: true,
  },
  {
    id: 'archivo-narrow',
    family: 'ptouch Archivo Narrow',
    label: 'Archivo Narrow',
    category: 'condensed',
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
    preview: 'Label 123',
    generic: 'sans-serif',
    core: true,
    condensed: true,
  },
  {
    id: 'jetbrains-mono',
    family: 'ptouch JetBrains Mono',
    label: 'JetBrains Mono',
    category: 'mono',
    weights: [400, 700],
    files: { 400: 'JetBrainsMono-Regular.woff2', 700: 'JetBrainsMono-Bold.woff2' },
    license: 'OFL-1.1',
    licenseFile: 'OFL-JetBrainsMono.txt',
    hint: 'Monospaced: serial numbers, codes',
    preview: 'SN 0O1lI',
    generic: 'monospace',
    core: true,
  },
  {
    id: 'atkinson-hyperlegible',
    family: 'ptouch Atkinson Hyperlegible',
    label: 'Atkinson Hyperlegible',
    category: 'accessible',
    weights: [400, 700],
    files: { 400: 'AtkinsonHyperlegible-Regular.woff2', 700: 'AtkinsonHyperlegible-Bold.woff2' },
    license: 'OFL-1.1',
    licenseFile: 'OFL-AtkinsonHyperlegible.txt',
    hint: 'Designed for low vision: distinct 0/O, 1/l/I',
    preview: '0O 1lI Label',
    generic: 'sans-serif',
    core: true,
  },

  // Library: loaded on first use (public/fonts/SOURCES.md has provenance, Reserved Font Name
  // findings and the pixel-grid measurements). In schema order, i.e. by category.
  lib('oswald', 'Oswald', 'condensed', [400, 700], 'Tall condensed sans: long words, short labels', 'LABEL 123', { condensed: true }),
  lib('bebas-neue', 'Bebas Neue', 'condensed', [400], 'Narrow capitals only: bold signage', 'TOOLS 24', { condensed: true }),
  lib('barlow-condensed', 'Barlow Condensed', 'condensed', [500, 700], 'Narrow road-sign grotesk', 'Cable 2.5 mm²', { condensed: true }),
  lib('anton', 'Anton', 'condensed', [400], 'Heavy and narrow: big, loud words', 'BOLD 42', { condensed: true }),
  lib('barlow', 'Barlow', 'industrial', [400, 600], 'Plain technical grotesk with a DIN feel', 'Breaker 16 A'),
  lib('b612', 'B612', 'industrial', [400, 700], 'Made for cockpit displays: open, unambiguous', 'ALT 3500 ft'),
  lib('nunito', 'Nunito', 'rounded', [400, 700], 'Friendly rounded sans', 'Kitchen'),
  lib('fredoka', 'Fredoka', 'rounded', [400, 600], 'Round and bubbly: toys, kids’ things', 'Toys & Games'),
  // Reserved Font Name: shipped unmodified, one variable file for both weights.
  lib('quicksand', 'Quicksand', 'rounded', [500, 700], 'Light, round geometric sans', 'Spices', { quality: 'thin', variable: true }),
  lib('caveat', 'Caveat', 'handwritten', [400, 700], 'Casual handwriting', 'Homemade jam', { quality: 'script', generic: 'cursive' }),
  lib('permanent-marker', 'Permanent Marker', 'handwritten', [400], 'Felt-tip marker capitals', 'DO NOT TOUCH', { license: 'Apache-2.0' }),
  lib('pacifico', 'Pacifico', 'handwritten', [400], 'Retro surf-style brush script', 'Hello!', { quality: 'script', generic: 'cursive' }),
  lib('big-shoulders-stencil', 'Big Shoulders Stencil', 'stencil', [400, 700], 'Narrow Chicago-style stencil', 'CRATE 07', { condensed: true }),
  lib('saira-stencil-one', 'Saira Stencil One', 'stencil', [400], 'Wide, heavy military stencil', 'CARGO 12'),
  lib('special-elite', 'Special Elite', 'typewriter', [400], 'Worn, inky typewriter', 'Archive 1962', { license: 'Apache-2.0', generic: 'serif' }),
  lib('courier-prime', 'Courier Prime', 'typewriter', [400, 700], 'Clean monospaced typewriter', 'Ref. 0042', { generic: 'monospace' }),
  lib('roboto-slab', 'Roboto Slab', 'typewriter', [400, 700], 'Sturdy slab serif', 'Pantry', { license: 'Apache-2.0', generic: 'serif' }),
  // A 125-unit grid at 1000 units per em. VT323 (CRT-style dots, half-pixel steps) and Pixelify
  // Sans (optically sized pixels) are not on a whole-number grid: no `pixel` (SOURCES.md).
  lib('silkscreen', 'Silkscreen', 'pixel', [400, 700], 'Tiny 8-pixel capitals: crisp at whole-dot scales', 'PIXEL 8', { pixel: { emPx: 8 }, generic: 'monospace' }),
  lib('vt323', 'VT323', 'pixel', [400], 'Retro DEC terminal lettering', '> READY_', { generic: 'monospace' }),
  lib('pixelify-sans', 'Pixelify Sans', 'pixel', [400, 700], 'Pixel-art look, smooth at any size', 'Level 1'),
  lib('lexend', 'Lexend', 'accessible', [400, 700], 'Wide, evenly spaced letters for easier reading', 'Easy to read'),
]

/** The registry entry of `id`, or undefined (an id with no entry yet draws with `FONTS[0]`). */
export function findFont(id: string): FontDef | undefined {
  return FONTS.find((f) => f.id === id)
}

/** Every file of the core (precached) families, e.g. for the precache test. */
export function coreFontFiles(): string[] {
  return FONTS.filter((f) => f.core).flatMap((f) => Object.values(f.files).filter((v): v is string => typeof v === 'string'))
}

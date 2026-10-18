// P2 (docs/STUDIO-V1-PLAN.md) — the "New from template" catalogue. A template is a plain
// LabelDoc with obvious placeholder text; `build()` returns a fresh doc (new ids) every call and
// the gallery opens it with `studio.newFromTemplate`. Sizes follow the PT-P710BT at 180 dpi:
// printable band 12 mm → 70 dots (9.9 mm), 24 mm → 128 dots (18.1 mm); the printer adds a
// ≈ 2 mm feed margin at each end of every label (not counted in `length`). The 36 mm variants
// follow the PT-P910BT at 360 dpi: 36 mm → 454 dots (32 mm).
//
// Printer models (docs/MODELS-PLAN.md §3.9): the gallery shows the templates whose width the
// active model takes (`templateFits`) and the others in a marked "other widths" section; it
// renders and opens each one with the active model, or the stand-in for a width it lacks
// (`templateModel`), and passes that model's band to `build(band)` so "M" is M on that band.
// Other sizes are physical (mm) and fit every model's band of the template's width.
//
// Fonts and size (docs/FONTS-AND-SIZE-PLAN.md §3.3, P-size): text has fixed sizes, so a sticker is
// only as long as it needs to be (text that fits the band makes short words several cm long).
// Where it fits the design, the size is the quick size M of that tape (`QUICK_M_MM`), so the
// text properties show it as "M". Fixed-length templates shrink long text to fit the length.
import { createBatch, createDoc, createItem, createWifi, type CodeItem, type IconItem, type Item, type LabelDoc, type SpacerItem, type TableItem, type TapeWidthMm, type TextItem, type TextSize } from '../../doc/schema'
import { quickTextSizes } from '../../render/text-size'
import type { ModelInfo } from '../../wasm'
import { findModel, standInModel, tapeWidthsOf } from '../state/models'
import { formatMm } from '../state/view-model'

export type TemplateCategory = 'network' | 'cables' | 'storage' | 'office' | 'music'

/** Gallery sections, in display order. */
export const TEMPLATE_CATEGORIES: readonly { id: TemplateCategory; label: string }[] = [
  { id: 'network', label: 'Wi-Fi' },
  { id: 'cables', label: 'Cables' },
  { id: 'storage', label: 'Shelves, bins & drawers' },
  { id: 'office', label: 'Office' },
  { id: 'music', label: 'Music' },
]

export interface TemplateDef {
  id: string
  /** Card title (unique; also the new label's name without the size suffix). */
  name: string
  /** One sentence for the card: what it is for and how to adapt it. */
  description: string
  category: TemplateCategory
  tapeWidthMm: TapeWidthMm
  /** A fresh doc. `band` (docs/MODELS-PLAN.md §4.8, frozen): the printable band it is opened on,
   * so quick sizes are that band's; without it, today's output (byte-identical). */
  build(band?: TemplateBand): LabelDoc
}

/** The printable band a template is opened on (the active model's print area for its width). */
export interface TemplateBand {
  bandDots: number
  dpi: number
}

/** Default cable diameter of the cable flag (mm). */
export const CABLE_FLAG_DIAMETER_MM = 6
/** Blank middle of the cable flag: one turn around the cable (π × Ø, rounded to 0.5 mm). */
export const CABLE_FLAG_WRAP_MM = Math.round(Math.PI * CABLE_FLAG_DIAMETER_MM * 2) / 2
/** Default cable diameter of the cable wrap (mm) and the overlap that the end sticks to. */
export const CABLE_WRAP_DIAMETER_MM = 8
export const CABLE_WRAP_OVERLAP_MM = 15
/**
 * Gridfinity bins sit on a 42 mm grid. Common label inserts for a 1-unit bin are 36–38 mm long
 * and 11–11.5 mm tall (Pred's parametric bins: 42 − 4.2 = 37.8 × 11.5 mm; Cullen J Webb's
 * labels: 36.4 × 11 mm). 32 mm printed + the printer's 2 × ≈ 2 mm feed margin gives a ≈ 36 mm
 * piece of 12 mm tape that fits the label tab of a 1-unit bin.
 */
export const GRIDFINITY_LENGTH_MM = 32

/** Quick size M (half the printable band, render/text-size.ts) of 12 mm (35 dots) and 24 mm
 * (64 dots) tape on the PT-P710BT, and of 36 mm (227 dots at 360 dpi) on the PT-P910BT, in mm. */
export const QUICK_M_MM = { 12: 4.94, 24: 9.03, 36: 16.02 } as const

/** Quick size M of `band` (the band the template is opened on), else of the default band of
 * that tape (`QUICK_M_MM`): `build()` without a band stays byte-identical. */
function quickM(widthMm: keyof typeof QUICK_M_MM, band: TemplateBand | undefined): TextSize {
  const m = band ? quickTextSizes(band.bandDots, band.dpi).find((q) => q.id === 'm')?.size : undefined
  return m ?? { mode: 'mm', mm: QUICK_M_MM[widthMm] }
}

const text = (t: string, patch: Partial<TextItem> = {}): TextItem => ({ ...createItem('text'), text: t, ...patch })
const icon = (iconId: string, patch: Partial<IconItem> = {}): IconItem => ({ ...createItem('icon'), iconId, ...patch })
const spacer = (widthMm: number): SpacerItem => ({ ...createItem('spacer'), widthMm })
const code = (patch: Partial<CodeItem>): CodeItem => ({ ...createItem('code'), ...patch })
/** A QR code for a Wi-Fi network (the network is filled in the code editor). */
const wifiQr = (patch: Partial<CodeItem>): CodeItem => code({ content: 'wifi', data: '', wifi: createWifi(), moduleDots: 'auto', ...patch })

/** A table block (docs/TABLE-PLAN.md §5): equal columns and cut marks, text along the tape. */
const table = (cells: string[][], patch: Partial<TableItem> = {}): TableItem => ({ ...createItem('table'), cells, columns: { mode: 'equal' }, cutMarks: true, ...patch })

/** Piano keys in keyboard order, solfège and letter names (♯ = U+266F, ♭ = U+266D). */
export const PIANO_WHITE = [
  ['DO', 'RE', 'MI', 'FA', 'SOL', 'LA', 'SI'],
  ['C', 'D', 'E', 'F', 'G', 'A', 'B'],
] as const
export const PIANO_12 = [
  ['DO', 'DO♯', 'RE', 'RE♯', 'MI', 'FA', 'FA♯', 'SOL', 'SOL♯', 'LA', 'LA♯', 'SI'],
  ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'],
] as const
/** The flat names of the black keys (empty under the white keys). */
export const PIANO_FLATS = [
  ['', 'RE♭', '', 'MI♭', '', '', 'SOL♭', '', 'LA♭', '', 'SI♭', ''],
  ['', 'D♭', '', 'E♭', '', '', 'G♭', '', 'A♭', '', 'B♭', ''],
] as const
const rows = (...r: readonly (readonly string[])[]): string[][] => r.map((x) => [...x])

function label(name: string, widthMm: TapeWidthMm, items: Item[], patch: Partial<Omit<LabelDoc, 'schema' | 'items'>> = {}): LabelDoc {
  return createDoc({ name, tape: { widthMm }, items, ...patch })
}

// Music (docs/TABLE-PLAN.md §5): a strip of note names to cut apart and stick on the keys. Margins
// 0, so the cut marks at both ends are the ends of the strip and every piece is one column wide.
// "Across" is one click away in the table editor (for sticking a piece lengthwise on a key).
const PIANO_LAYOUT = { marginsMm: { start: 0, end: 0 } }
const MUSIC: TemplateDef[] = [
  {
    id: 'piano-white-24',
    name: 'Piano notes',
    description: 'The white keys, DO RE MI … over C D E …, in equal columns with cut marks: cut the strip apart and stick one piece on each key.',
    category: 'music',
    tapeWidthMm: 24,
    build: () => label('Piano notes', 24, [table(rows(...PIANO_WHITE), { fontWeight: 700 })], PIANO_LAYOUT),
  },
  {
    id: 'piano-12-24',
    name: 'Piano notes, all 12 keys',
    description: 'White and black keys in keyboard order (DO DO♯ RE … over C C♯ D …) in equal columns with cut marks.',
    category: 'music',
    tapeWidthMm: 24,
    build: () => label('Piano notes, all 12 keys', 24, [table(rows(...PIANO_12), { fontFamily: 'jetbrains-mono', fontWeight: 700 })], PIANO_LAYOUT),
  },
  {
    // Flats get their own rows: a combined "DO♯/RE♭" cell would make every cell smaller.
    id: 'piano-12-flats-24',
    name: 'Piano notes, all 12 keys with flats',
    description: 'All 12 keys with the flat names of the black keys in two more rows (RE♭ under DO♯, D♭ under C♯): smaller text, more names.',
    category: 'music',
    tapeWidthMm: 24,
    build: () => label('Piano notes, all 12 keys with flats', 24, [table(rows(...PIANO_12, ...PIANO_FLATS), { fontFamily: 'jetbrains-mono', fontWeight: 700 })], PIANO_LAYOUT),
  },
]

export const TEMPLATES: readonly TemplateDef[] = [
  {
    id: 'wifi-12',
    name: 'Wi-Fi sticker (12 mm)',
    description: 'Small sticker: guests scan the QR code with the iPhone Camera app to join. Enter your network in the QR block.',
    category: 'network',
    tapeWidthMm: 12,
    // ECC L keeps a typical WPA payload at version 3 (29 modules): 2 dots per module on the 70-dot
    // band, with the compact quiet zone using the unprinted tape edge. "Wi-Fi" over the network
    // name in Archivo Narrow, 5.5 mm for both lines (2.6 mm each): ≈ 34 mm with "MyHomeNetwork".
    build: () =>
      label('Wi-Fi sticker', 12, [wifiQr({ quietZone: 'compact', ecc: 'L' }), text('Wi-Fi\n{{ssid}}', { fontFamily: 'archivo-narrow', size: { mode: 'mm', mm: 5.5 }, align: 'start' })], {
        marginsMm: { start: 1.5, end: 2 },
        layout: { mode: 'flow', gapMm: 2, align: 'center' },
      }),
  },
  {
    id: 'wifi-24',
    name: 'Wi-Fi sticker (24 mm)',
    description: 'Larger sticker with a Wi-Fi icon, the network name and a QR code that phones join from.',
    category: 'network',
    tapeWidthMm: 24,
    // Two lines at M (9 mm for both): ≈ 71 mm with "MyHomeNetwork" (it was 103 mm at Fit).
    build: (band) =>
      label('Wi-Fi sticker', 24, [icon('wifi', { size: { mode: 'mm', mm: 9 } }), text('Wi-Fi\n{{ssid}}', { lineHeight: 1.15, align: 'start', size: quickM(24, band) }), wifiQr({ quietZone: 'standard', ecc: 'M' })], {
        layout: { mode: 'flow', gapMm: 2.5, align: 'center' },
      }),
  },
  {
    id: 'wifi-36',
    name: 'Wi-Fi sticker (36 mm)',
    description: 'Big sticker for a wall or a router: Wi-Fi icon, the network name and a QR code that phones join from across the room.',
    category: 'network',
    tapeWidthMm: 36,
    // The 24 mm design on the 32 mm band of a 360 dpi model: two lines at M (16 mm for both),
    // a QR code with the standard quiet zone that fills the band.
    build: (band) =>
      label('Wi-Fi sticker', 36, [icon('wifi', { size: { mode: 'mm', mm: 14 } }), text('Wi-Fi\n{{ssid}}', { lineHeight: 1.15, align: 'start', size: quickM(36, band) }), wifiQr({ quietZone: 'standard', ecc: 'M' })], {
        layout: { mode: 'flow', gapMm: 3.5, align: 'center' },
      }),
  },
  {
    id: 'cable-flag',
    name: 'Cable flag',
    description: `The same text on both ends; the blank middle (${CABLE_FLAG_WRAP_MM} mm ≈ π × ${CABLE_FLAG_DIAMETER_MM} mm) wraps around the cable and the ends stick together, so it reads from either side. Other cables: spacer = π × diameter.`,
    category: 'cables',
    tapeWidthMm: 12,
    build: (band) =>
      label('Cable flag', 12, [text('Cable name', { fontFamily: 'archivo-narrow', size: quickM(12, band) }), spacer(CABLE_FLAG_WRAP_MM), text('Cable name', { fontFamily: 'archivo-narrow', size: quickM(12, band) })], {
        marginsMm: { start: 1, end: 1 },
        layout: { mode: 'flow', gapMm: 2, align: 'center' },
      }),
  },
  {
    id: 'cable-wrap',
    name: 'Cable wrap',
    description: `Repeated text that wraps once around a cable up to ${CABLE_WRAP_DIAMETER_MM} mm thick (π × Ø + ${CABLE_WRAP_OVERLAP_MM} mm overlap), so the name shows from every side.`,
    category: 'cables',
    tapeWidthMm: 9,
    build: () =>
      label('Cable wrap', 9, [text('LAN 1 · LAN 1 · LAN 1', { fontFamily: 'archivo-narrow', size: { mode: 'mm', mm: 4 } })], {
        length: { mode: 'fixed', mm: Math.round(Math.PI * CABLE_WRAP_DIAMETER_MM + CABLE_WRAP_OVERLAP_MM), shrink: true },
        marginsMm: { start: 0, end: 0 },
      }),
  },
  {
    id: 'bin-24',
    name: 'Shelf or bin label (24 mm)',
    description: 'Icon and contents for shelves, boxes and bins. Pick another icon in the icon block.',
    category: 'storage',
    tapeWidthMm: 24,
    build: (band) => label('Shelf label', 24, [icon('archive', { size: { mode: 'mm', mm: 14 } }), text('Contents', { size: quickM(24, band) })]),
  },
  {
    id: 'bin-36',
    name: 'Shelf or bin label (36 mm)',
    description: 'Large icon and contents for shelves, crates and archive boxes, readable from a distance.',
    category: 'storage',
    tapeWidthMm: 36,
    build: (band) => label('Shelf label', 36, [icon('archive', { size: { mode: 'mm', mm: 22 } }), text('Contents', { size: quickM(36, band) })], { layout: { mode: 'flow', gapMm: 3, align: 'center' } }),
  },
  {
    id: 'drawer-12',
    name: 'Drawer label (12 mm)',
    description: 'Compact icon and contents for drawers and small boxes.',
    category: 'storage',
    tapeWidthMm: 12,
    build: (band) => label('Drawer label', 12, [icon('package'), text('Contents', { size: quickM(12, band) })], { layout: { mode: 'flow', gapMm: 2, align: 'center' } }),
  },
  {
    id: 'gridfinity-12',
    name: 'Gridfinity bin (12 mm)',
    description: `≈ 36 mm piece (${GRIDFINITY_LENGTH_MM} mm + feed margins): fits the label tab of a 1-unit (42 mm) Gridfinity bin.`,
    category: 'storage',
    tapeWidthMm: 12,
    build: () =>
      label('Gridfinity label', 12, [icon('nut', { size: { mode: 'mm', mm: 8 } }), text('M3 × 8', { size: { mode: 'mm', mm: 6 } })], {
        length: { mode: 'fixed', mm: GRIDFINITY_LENGTH_MM, shrink: true },
        marginsMm: { start: 1, end: 1 },
        layout: { mode: 'flow', gapMm: 1.5, align: 'center' },
      }),
  },
  {
    id: 'asset-tag',
    name: 'Asset tag',
    description: 'Small numbered tags (about 3 cm each) with a QR code: prints Asset 0001 to 0010 in one job. Change the count and start in the batch panel.',
    category: 'office',
    tapeWidthMm: 12,
    // A short QR payload ("0001": version 1, 21 modules) gets 3 dots per module on the 70-dot
    // band; the two-line text has a fixed size so it does not grow to the band height and make
    // every tag ~9 cm long.
    build: () =>
      label('Asset tag', 12, [code({ data: '{{id}}', quietZone: 'compact', ecc: 'M' }), text('Asset\n{{id}}', { size: { mode: 'mm', mm: 7 }, lineHeight: 1.1 })], {
        marginsMm: { start: 1.5, end: 1.5 },
        layout: { mode: 'flow', gapMm: 1.5, align: 'center' },
        batch: createBatch({ enabled: true, count: 10, counters: [{ name: 'id', start: 1, step: 1, pad: 4 }] }),
      }),
  },
  {
    id: 'folder-spine',
    name: 'Folder spine',
    description: 'Large title for the spine of a binder or file box (100 mm long); a long title gets smaller to fit.',
    category: 'office',
    tapeWidthMm: 24,
    build: () => label('Folder spine', 24, [text('Folder title', { fontWeight: 700, size: { mode: 'mm', mm: 15 } })], { length: { mode: 'fixed', mm: 100, shrink: true } }),
  },
  {
    id: 'folder-spine-36',
    name: 'Folder spine (36 mm)',
    description: 'Large title for the wide spine of a lever-arch file or archive box (150 mm long); a long title gets smaller to fit.',
    category: 'office',
    tapeWidthMm: 36,
    build: () => label('Folder spine', 36, [text('Folder title', { fontWeight: 700, size: { mode: 'mm', mm: 22 } })], { length: { mode: 'fixed', mm: 150, shrink: true } }),
  },
  {
    id: 'name-tag',
    name: 'Name tag',
    description: 'Two lines with a thin border: a name and a team or role.',
    category: 'office',
    tapeWidthMm: 24,
    build: () =>
      label('Name tag', 24, [text('Your Name\nTeam or role', { lineHeight: 1.15 })], {
        marginsMm: { start: 4, end: 4 },
        frame: { thicknessMm: 0.4, radiusMm: 2, insetMm: 0 },
      }),
  },
  {
    id: 'name-tag-36',
    name: 'Name tag (36 mm)',
    description: 'A large name tag for events and doors: two lines with a thin rounded border.',
    category: 'office',
    tapeWidthMm: 36,
    build: () =>
      label('Name tag', 36, [text('Your Name\nTeam or role', { lineHeight: 1.15 })], {
        marginsMm: { start: 6, end: 6 },
        frame: { thicknessMm: 0.5, radiusMm: 3, insetMm: 0 },
      }),
  },
  ...MUSIC,
]

export function templateById(id: string): TemplateDef | undefined {
  return TEMPLATES.find((t) => t.id === id)
}

/** Templates of `category`, in catalogue order. */
export function templatesIn(category: TemplateCategory): TemplateDef[] {
  return TEMPLATES.filter((t) => t.category === category)
}

/** The active model takes the template's tape width (docs/MODELS-PLAN.md §3.9; frozen). */
export function templateFits(t: Pick<TemplateDef, 'tapeWidthMm'>, widths: readonly TapeWidthMm[]): boolean {
  return widths.some((w) => Math.abs(w - t.tapeWidthMm) < 0.01)
}

/**
 * The model a template card is drawn and opened with: `active` when it takes the template's
 * width (or the table does not know it: nothing to check), else the stand-in the editor would
 * preview it with (models.ts `standInModel`: the first table model that takes the width); null
 * when no model takes it. Thumbnails therefore never ask a model for a tape it lacks.
 */
export function templateModel(t: Pick<TemplateDef, 'tapeWidthMm'>, active: string, models: readonly ModelInfo[]): string | null {
  const info = findModel(models, active)
  if (!info || templateFits(t, tapeWidthsOf(info))) return info?.name ?? active
  return standInModel(models, t.tapeWidthMm)
}

/** "Needs 36 mm tape · PT-P710BT takes up to 24 mm" (a width above the model's widest) or
 * "Needs 9 mm tape · PT-X doesn’t take it" (a gap): the mark of a template or a printed label
 * whose width the active model lacks; null when it takes the width (or `widths` is unknown). */
export function needsWidthText(widthMm: number, model: string, widths: readonly number[]): string | null {
  if (widths.length === 0 || widths.some((w) => Math.abs(w - widthMm) < 0.01)) return null
  const max = Math.max(...widths)
  return `Needs ${formatMm(widthMm)} tape · ${model} ${widthMm > max ? `takes up to ${formatMm(max)}` : 'doesn’t take it'}`
}

/** The template is designed for the tape that is loaded in the printer. */
export function fitsLoadedTape(t: Pick<TemplateDef, 'tapeWidthMm'>, loadedWidthMm: number | null | undefined): boolean {
  return loadedWidthMm != null && Math.abs(loadedWidthMm - t.tapeWidthMm) < 0.01
}

/**
 * The block to select after opening a template: the Wi-Fi code (its network must be entered),
 * else the first text block with placeholder text, else the first block.
 */
export function primaryItemId(doc: LabelDoc): string | null {
  const wifi = doc.items.find((i) => i.kind === 'code' && i.content === 'wifi')
  return (wifi ?? doc.items.find((i) => i.kind === 'text') ?? doc.items[0])?.id ?? null
}

/** Sample network for gallery thumbnails and tests (never stored in a label). */
export const SAMPLE_WIFI = { ssid: 'Home Wi-Fi', password: 'correct-horse-42' } as const

/** A copy of `doc` with the Wi-Fi codes filled with `SAMPLE_WIFI` (so thumbnails show a QR). */
export function withSampleData(doc: LabelDoc): LabelDoc {
  return {
    ...doc,
    items: doc.items.map((i) => (i.kind === 'code' && i.content === 'wifi' ? { ...i, wifi: { ...(i.wifi ?? createWifi()), ...SAMPLE_WIFI } } : i)),
  }
}

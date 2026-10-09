// P2 (docs/STUDIO-V1-PLAN.md) — the "New from template" catalogue. A template is a plain
// LabelDoc with obvious placeholder text; `build()` returns a fresh doc (new ids) every call and
// the gallery opens it with `studio.newFromTemplate`. Sizes follow the PT-P710BT at 180 dpi:
// printable band 12 mm → 70 dots (9.9 mm), 24 mm → 128 dots (18.1 mm); the printer adds a
// ≈ 2 mm feed margin at each end of every label (not counted in `length`).
import { createBatch, createDoc, createItem, createWifi, type CodeItem, type IconItem, type Item, type LabelDoc, type SpacerItem, type TapeWidthMm, type TextItem } from '../../doc/schema'

export type TemplateCategory = 'network' | 'cables' | 'storage' | 'office'

/** Gallery sections, in display order. */
export const TEMPLATE_CATEGORIES: readonly { id: TemplateCategory; label: string }[] = [
  { id: 'network', label: 'Wi-Fi' },
  { id: 'cables', label: 'Cables' },
  { id: 'storage', label: 'Shelves, bins & drawers' },
  { id: 'office', label: 'Office' },
]

export interface TemplateDef {
  id: string
  /** Card title (unique; also the new label's name without the size suffix). */
  name: string
  /** One sentence for the card: what it is for and how to adapt it. */
  description: string
  category: TemplateCategory
  tapeWidthMm: TapeWidthMm
  build(): LabelDoc
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

const text = (t: string, patch: Partial<TextItem> = {}): TextItem => ({ ...createItem('text'), text: t, ...patch })
const icon = (iconId: string, patch: Partial<IconItem> = {}): IconItem => ({ ...createItem('icon'), iconId, ...patch })
const spacer = (widthMm: number): SpacerItem => ({ ...createItem('spacer'), widthMm })
const code = (patch: Partial<CodeItem>): CodeItem => ({ ...createItem('code'), ...patch })
/** A QR code for a Wi-Fi network (the network is filled in the code editor). */
const wifiQr = (patch: Partial<CodeItem>): CodeItem => code({ content: 'wifi', data: '', wifi: createWifi(), moduleDots: 'auto', ...patch })

function label(name: string, widthMm: TapeWidthMm, items: Item[], patch: Partial<Omit<LabelDoc, 'schema' | 'items'>> = {}): LabelDoc {
  return createDoc({ name, tape: { widthMm }, items, ...patch })
}

export const TEMPLATES: readonly TemplateDef[] = [
  {
    id: 'wifi-12',
    name: 'Wi-Fi sticker (12 mm)',
    description: 'Small sticker: guests scan the QR code with the iPhone Camera app to join. Enter your network in the QR block.',
    category: 'network',
    tapeWidthMm: 12,
    // ECC L keeps a typical WPA payload at version 3 (29 modules): 2 dots per module on the 70-dot
    // band, with the compact quiet zone using the unprinted tape edge.
    build: () => label('Wi-Fi sticker', 12, [wifiQr({ quietZone: 'compact', ecc: 'L' }), text('{{ssid}}')], { marginsMm: { start: 1.5, end: 2 }, layout: { mode: 'flow', gapMm: 2, align: 'center' } }),
  },
  {
    id: 'wifi-24',
    name: 'Wi-Fi sticker (24 mm)',
    description: 'Larger sticker with a Wi-Fi icon, the network name and a QR code that phones join from.',
    category: 'network',
    tapeWidthMm: 24,
    build: () =>
      label('Wi-Fi sticker', 24, [icon('wifi', { size: { mode: 'mm', mm: 9 } }), text('Wi-Fi\n{{ssid}}', { lineHeight: 1.15 }), wifiQr({ quietZone: 'standard', ecc: 'M' })], {
        layout: { mode: 'flow', gapMm: 2.5, align: 'center' },
      }),
  },
  {
    id: 'cable-flag',
    name: 'Cable flag',
    description: `The same text on both ends; the blank middle (${CABLE_FLAG_WRAP_MM} mm ≈ π × ${CABLE_FLAG_DIAMETER_MM} mm) wraps around the cable and the ends stick together, so it reads from either side. Other cables: spacer = π × diameter.`,
    category: 'cables',
    tapeWidthMm: 12,
    build: () =>
      label('Cable flag', 12, [text('Cable name', { size: { mode: 'mm', mm: 5 } }), spacer(CABLE_FLAG_WRAP_MM), text('Cable name', { size: { mode: 'mm', mm: 5 } })], {
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
        length: { mode: 'fixed', mm: Math.round(Math.PI * CABLE_WRAP_DIAMETER_MM + CABLE_WRAP_OVERLAP_MM) },
        marginsMm: { start: 0, end: 0 },
      }),
  },
  {
    id: 'bin-24',
    name: 'Shelf or bin label (24 mm)',
    description: 'Icon and contents for shelves, boxes and bins. Pick another icon in the icon block.',
    category: 'storage',
    tapeWidthMm: 24,
    build: () => label('Shelf label', 24, [icon('archive', { size: { mode: 'mm', mm: 14 } }), text('Contents')]),
  },
  {
    id: 'drawer-12',
    name: 'Drawer label (12 mm)',
    description: 'Compact icon and contents for drawers and small boxes.',
    category: 'storage',
    tapeWidthMm: 12,
    build: () => label('Drawer label', 12, [icon('package'), text('Contents')], { layout: { mode: 'flow', gapMm: 2, align: 'center' } }),
  },
  {
    id: 'gridfinity-12',
    name: 'Gridfinity bin (12 mm)',
    description: `≈ 36 mm piece (${GRIDFINITY_LENGTH_MM} mm + feed margins): fits the label tab of a 1-unit (42 mm) Gridfinity bin.`,
    category: 'storage',
    tapeWidthMm: 12,
    build: () =>
      label('Gridfinity label', 12, [icon('nut', { size: { mode: 'mm', mm: 8 } }), text('M3 × 8', { size: { mode: 'mm', mm: 6 } })], {
        length: { mode: 'fixed', mm: GRIDFINITY_LENGTH_MM },
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
    description: 'Large title for the spine of a binder or file box (100 mm long).',
    category: 'office',
    tapeWidthMm: 24,
    build: () => label('Folder spine', 24, [text('Folder title', { fontWeight: 700, size: { mode: 'mm', mm: 15 } })], { length: { mode: 'fixed', mm: 100 } }),
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
]

export function templateById(id: string): TemplateDef | undefined {
  return TEMPLATES.find((t) => t.id === id)
}

/** Templates of `category`, in catalogue order. */
export function templatesIn(category: TemplateCategory): TemplateDef[] {
  return TEMPLATES.filter((t) => t.category === category)
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

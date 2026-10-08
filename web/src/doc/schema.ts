// W3 owns this file, but its exported TYPES are a frozen contract shared by W3 (renderer),
// W4 (editor UI) and W5 (persistence/migrations). Additive, optional fields only; anything else
// bumps SCHEMA_VERSION and needs a migration in persist-migrate.ts (W5).
//
// Editor-library-independent JSON. Geometry is in **mm** (device-independent); the renderer
// snaps to the dot grid of the target printer (ARCHITECTURE.md §6.1). This module imports
// nothing (layering rule: `doc` depends on nothing).

export const SCHEMA_VERSION = 1 as const

/** Nominal TZe tape widths (PT-P710BT). 3.5 mm reports width byte 4 in the status. */
export type TapeWidthMm = 3.5 | 6 | 9 | 12 | 18 | 24
export const TAPE_WIDTHS_MM: readonly TapeWidthMm[] = [3.5, 6, 9, 12, 18, 24]

/** Bundled OFL families (web/public/fonts, render/fonts.ts). */
export type FontFamilyId = 'fira-sans' | 'archivo-narrow' | 'jetbrains-mono' | 'atkinson-hyperlegible'
export type FontWeight = 400 | 500 | 600 | 700 | 800

export type Align = 'start' | 'center' | 'end'
export type Rotation = 0 | 90 | 180 | 270
export type Symbology = 'qr' | 'code128' | 'ean13'
export type QrEcc = 'L' | 'M' | 'Q' | 'H'
/** Same strings as the wasm `DitherKind`. */
export type DitherKind = 'threshold' | 'floyd-steinberg' | 'atkinson' | 'bayer4' | 'bayer8'

export interface TapeSettings {
  widthMm: TapeWidthMm
  /** Exact media id (e.g. "tze128-24") once known from the printer; else resolved from widthMm. */
  mediaId?: string
  /** Preview colours (CSS) when designing offline; the printer's reported colours win. */
  colors?: { tape: string; ink: string }
}

export type LengthSettings = { mode: 'auto' } | { mode: 'fixed'; mm: number }

export type LayoutSettings =
  | { mode: 'flow'; gapMm: number; align: Align }
  /** v1 free-form editor; MVP renders free docs with each item's `frame`. */
  | { mode: 'free' }

export interface PrintSettings {
  /** Labels per job (one job, leader fed once). 1–99. */
  copies: number
  autoCut: boolean
  /** Last label stays in the printer (saves tape on the next job). */
  chain: boolean
  mirror: boolean
  /** Crisp-plane coverage threshold 0–255 (128 = 50 %); the "boldness" slider moves it. */
  threshold: number
}

/** Optional border around the whole label. */
export interface LabelFrame {
  thicknessMm: number
  radiusMm: number
  /** Inset from the printable band edge / label ends. */
  insetMm: number
}

export interface LabelDoc {
  schema: typeof SCHEMA_VERSION
  id: string
  name: string
  /** ISO 8601. */
  createdAt: string
  updatedAt: string
  tape: TapeSettings
  length: LengthSettings
  /** Blank space before/after the content along the label (≥ 0). The printer adds its own feed
   * margin (default 2 mm) at both ends; the editor shows both. */
  marginsMm: { start: number; end: number }
  layout: LayoutSettings
  frame?: LabelFrame
  /** Order = flow order (left → right) / z-order (free). */
  items: Item[]
  print: PrintSettings
}

/** Placement for `layout.mode = 'free'` (mm from the top-left of the printable band). */
export interface ItemFrame {
  xMm: number
  yMm: number
  wMm: number
  hMm: number
  rotation: Rotation
}

/** Size along the tape: fill the printable band ("fit") or a fixed height in mm. */
export type ItemSize = { mode: 'fit' } | { mode: 'mm'; mm: number }

interface ItemBase {
  id: string
  frame?: ItemFrame
}

export interface TextItem extends ItemBase {
  kind: 'text'
  /** Multiline (`\n`). */
  text: string
  fontFamily: FontFamilyId
  fontWeight: FontWeight
  italic: boolean
  /** Cap-to-descender height of the text block; 'fit' = largest size that fits the band. */
  size: ItemSize
  align: Align
  /** Line height multiplier (1.0–2.0). */
  lineHeight: number
  /** White text on a black block. */
  invert: boolean
}

export interface IconItem extends ItemBase {
  kind: 'icon'
  /** Id from render/icons.ts. */
  iconId: string
  size: ItemSize
}

export interface CodeItem extends ItemBase {
  kind: 'code'
  symbology: Symbology
  data: string
  /** Dots per module (integer; preflight blocks < 1). */
  moduleDots: number
  quietZone: boolean
  /** QR only. */
  ecc: QrEcc
  /** Linear codes: print the human-readable text under the bars. */
  showText: boolean
}

export interface ImageItem extends ItemBase {
  kind: 'image'
  /** Key of the blob in IndexedDB (`blobs` store, persist.ts). */
  blobRef: string
  /** Inlined copy, present only in exported files / share links. */
  dataUrl?: string
  size: ItemSize
  dither: DitherKind
  adjust: { brightness: number; contrast: number; gammaX100: number; invert: boolean; level: number }
}

export interface ShapeItem extends ItemBase {
  kind: 'shape'
  shape: 'rect' | 'ellipse' | 'line'
  /** Along the label. */
  widthMm: number
  size: ItemSize
  strokeMm: number
  fill: boolean
}

export interface SpacerItem extends ItemBase {
  kind: 'spacer'
  widthMm: number
}

export type Item = TextItem | IconItem | CodeItem | ImageItem | ShapeItem | SpacerItem
export type ItemKind = Item['kind']
export type ItemOf<K extends ItemKind> = Extract<Item, { kind: K }>

// ------------------------------------------------------------------------------------------
// Factories (pure; ids from crypto.randomUUID, available in secure contexts and node ≥ 19)
// ------------------------------------------------------------------------------------------

export function newId(): string {
  return crypto.randomUUID()
}

export const DEFAULT_PRINT: PrintSettings = {
  copies: 1,
  autoCut: true,
  chain: false,
  mirror: false,
  threshold: 128,
}

/** A new, empty label (24 mm, auto length, flow layout) with one text block. */
export function createDoc(init: Partial<Omit<LabelDoc, 'schema'>> = {}): LabelDoc {
  const now = new Date().toISOString()
  return {
    schema: SCHEMA_VERSION,
    id: newId(),
    name: 'Untitled label',
    createdAt: now,
    updatedAt: now,
    tape: { widthMm: 24 },
    length: { mode: 'auto' },
    marginsMm: { start: 2, end: 2 },
    layout: { mode: 'flow', gapMm: 3, align: 'center' },
    items: [createItem('text')],
    print: { ...DEFAULT_PRINT },
    ...init,
  }
}

/** A new item of `kind` with sensible defaults. */
export function createItem<K extends ItemKind>(kind: K): ItemOf<K> {
  const id = newId()
  const items: { [P in ItemKind]: ItemOf<P> } = {
    text: {
      id,
      kind: 'text',
      text: 'Label',
      fontFamily: 'fira-sans',
      fontWeight: 600,
      italic: false,
      size: { mode: 'fit' },
      align: 'center',
      lineHeight: 1.1,
      invert: false,
    },
    icon: { id, kind: 'icon', iconId: 'bolt', size: { mode: 'fit' } },
    code: {
      id,
      kind: 'code',
      symbology: 'qr',
      data: 'https://example.com',
      moduleDots: 3,
      quietZone: true,
      ecc: 'M',
      showText: false,
    },
    image: {
      id,
      kind: 'image',
      blobRef: '',
      size: { mode: 'fit' },
      dither: 'floyd-steinberg',
      adjust: { brightness: 0, contrast: 0, gammaX100: 100, invert: false, level: 128 },
    },
    shape: { id, kind: 'shape', shape: 'rect', widthMm: 10, size: { mode: 'fit' }, strokeMm: 0.5, fill: false },
    spacer: { id, kind: 'spacer', widthMm: 5 },
  }
  return items[kind] as ItemOf<K>
}

// ------------------------------------------------------------------------------------------
// Validation (pure; no imports)
// ------------------------------------------------------------------------------------------

/** Valid ranges used by `validateDoc` (and by editors for their controls). */
export const LIMITS = {
  lengthMm: { min: 4, max: 1000 },
  marginMm: { min: 0, max: 100 },
  gapMm: { min: 0, max: 100 },
  sizeMm: { min: 0.5, max: 100 },
  lineHeight: { min: 0.5, max: 3 },
  moduleDots: { min: 1, max: 20 },
  widthMm: { min: 0, max: 1000 },
  strokeMm: { min: 0.1, max: 20 },
  frameThicknessMm: { min: 0, max: 10 },
  frameRadiusMm: { min: 0, max: 50 },
  frameInsetMm: { min: 0, max: 20 },
  copies: { min: 1, max: 99 },
  threshold: { min: 0, max: 255 },
  brightness: { min: -100, max: 100 },
  gammaX100: { min: 10, max: 1000 },
  /** Characters per text item / code payload. */
  textChars: 4000,
  /** Blocks per label (a share link of a few KB could otherwise expand to tens of thousands). */
  items: 200,
  /** Characters of text + code data across the whole label. */
  totalChars: 40_000,
} as const

/** Untrusted short strings: ids, media ids, colours, timestamps (share links, imported files). */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MEDIA_ID_RE = /^[a-z0-9-]{1,32}$/
const COLOR_RE = /^#[0-9a-f]{3,8}$/i
const isTimestamp = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v))

/** JSON of an untrusted value for an error message, at most `max` characters. */
export function shortJson(v: unknown, max = 40): string {
  let s: string
  try {
    s = JSON.stringify(v) ?? String(v)
  } catch {
    s = String(v)
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const FONT_FAMILIES: readonly FontFamilyId[] = ['fira-sans', 'archivo-narrow', 'jetbrains-mono', 'atkinson-hyperlegible']
const FONT_WEIGHTS: readonly FontWeight[] = [400, 500, 600, 700, 800]
const ALIGNS: readonly Align[] = ['start', 'center', 'end']
const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270]
const SYMBOLOGIES: readonly Symbology[] = ['qr', 'code128', 'ean13']
const ECCS: readonly QrEcc[] = ['L', 'M', 'Q', 'H']
const DITHERS: readonly DitherKind[] = ['threshold', 'floyd-steinberg', 'atkinson', 'bayer4', 'bayer8']
const SHAPES: readonly ShapeItem['shape'][] = ['rect', 'ellipse', 'line']

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Collects repairs while reading a document. */
class Reader {
  constructor(
    private readonly where: string,
    /** Shared by nested readers so every repair of one document lands in one list. */
    readonly notes: string[] = [],
  ) {}

  at(where: string): Reader {
    return new Reader(where, this.notes)
  }

  note(msg: string): void {
    this.notes.push(`${this.where}: ${msg}`)
  }

  num(o: Obj, key: string, min: number, max: number, dflt: number, int = false): number {
    const v = o[key]
    let n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    if (!Number.isFinite(n)) {
      if (v !== undefined) this.note(`${key} was not a number; reset to ${dflt}`)
      return dflt
    }
    if (int) n = Math.round(n)
    if (n < min || n > max) {
      const c = Math.min(max, Math.max(min, n))
      this.note(`${key} ${n} out of range; clamped to ${c}`)
      return c
    }
    return n
  }

  bool(o: Obj, key: string, dflt: boolean): boolean {
    const v = o[key]
    if (typeof v === 'boolean') return v
    if (v !== undefined) this.note(`${key} was not true/false; reset to ${dflt}`)
    return dflt
  }

  str(o: Obj, key: string, dflt: string, maxLen: number = LIMITS.textChars): string {
    const v = o[key]
    if (typeof v === 'string') {
      if (v.length > maxLen) {
        this.note(`${key} truncated to ${maxLen} characters`)
        return v.slice(0, maxLen)
      }
      return v
    }
    if (typeof v === 'number') return String(v)
    if (v !== undefined) this.note(`${key} was not text; reset`)
    return dflt
  }

  oneOf<T>(o: Obj, key: string, allowed: readonly T[], dflt: T): T {
    const v = o[key]
    if (allowed.includes(v as T)) return v as T
    if (v !== undefined) this.note(`${key} ${JSON.stringify(v)} is not supported; using ${JSON.stringify(dflt)}`)
    return dflt
  }

  obj(o: Obj, key: string): Obj {
    const v = o[key]
    if (isObj(v)) return v
    if (v !== undefined) this.note(`${key} was malformed; defaults used`)
    return {}
  }
}

function readSize(r: Reader, o: Obj, key = 'size'): ItemSize {
  const v = o[key]
  if (isObj(v) && v['mode'] === 'mm') return { mode: 'mm', mm: r.num(v, 'mm', LIMITS.sizeMm.min, LIMITS.sizeMm.max, 6) }
  if (isObj(v) && v['mode'] === 'fit') return { mode: 'fit' }
  if (typeof v === 'number') return { mode: 'mm', mm: r.num(o, key, LIMITS.sizeMm.min, LIMITS.sizeMm.max, 6) }
  if (v !== undefined) r.note(`${key} was malformed; fit to tape`)
  return { mode: 'fit' }
}

function nearestWeight(v: unknown): FontWeight | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return FONT_WEIGHTS.reduce((best, w) => (Math.abs(w - v) < Math.abs(best - v) ? w : best), 400 as FontWeight)
}

function readItemFrame(r: Reader, o: Obj): ItemFrame | undefined {
  const v = o['frame']
  if (v === undefined) return undefined
  if (!isObj(v)) {
    r.note('frame was malformed; removed')
    return undefined
  }
  return {
    xMm: r.num(v, 'xMm', -1000, 1000, 0),
    yMm: r.num(v, 'yMm', -100, 100, 0),
    wMm: r.num(v, 'wMm', 0.5, 1000, 10),
    hMm: r.num(v, 'hMm', 0.5, 100, 10),
    rotation: r.oneOf(v, 'rotation', ROTATIONS, 0),
  }
}

function readItem(r: Reader, o: Obj, id: string): Item | undefined {
  const frame = readItemFrame(r, o)
  const base = frame ? { id, frame } : { id }
  switch (o['kind']) {
    case 'text': {
      const weight = nearestWeight(o['fontWeight'])
      if (weight === undefined && o['fontWeight'] !== undefined) r.note('fontWeight was malformed; using 600')
      return {
        ...base,
        kind: 'text',
        text: r.str(o, 'text', ''),
        fontFamily: r.oneOf(o, 'fontFamily', FONT_FAMILIES, 'fira-sans'),
        fontWeight: weight ?? 600,
        italic: r.bool(o, 'italic', false),
        size: readSize(r, o),
        align: r.oneOf(o, 'align', ALIGNS, 'center'),
        lineHeight: r.num(o, 'lineHeight', LIMITS.lineHeight.min, LIMITS.lineHeight.max, 1.1),
        invert: r.bool(o, 'invert', false),
      }
    }
    case 'icon':
      return { ...base, kind: 'icon', iconId: r.str(o, 'iconId', 'bolt', 64), size: readSize(r, o) }
    case 'code':
      return {
        ...base,
        kind: 'code',
        symbology: r.oneOf(o, 'symbology', SYMBOLOGIES, 'qr'),
        data: r.str(o, 'data', ''),
        moduleDots: r.num(o, 'moduleDots', LIMITS.moduleDots.min, LIMITS.moduleDots.max, 3, true),
        quietZone: r.bool(o, 'quietZone', true),
        ecc: r.oneOf(o, 'ecc', ECCS, 'M'),
        showText: r.bool(o, 'showText', false),
      }
    case 'image': {
      const adjust = r.obj(o, 'adjust')
      const ra = r.at('image adjust')
      const dataUrl = o['dataUrl']
      const img: ImageItem = {
        ...base,
        kind: 'image',
        blobRef: r.str(o, 'blobRef', '', 256),
        size: readSize(r, o),
        dither: r.oneOf(o, 'dither', DITHERS, 'floyd-steinberg'),
        adjust: {
          brightness: ra.num(adjust, 'brightness', LIMITS.brightness.min, LIMITS.brightness.max, 0, true),
          contrast: ra.num(adjust, 'contrast', LIMITS.brightness.min, LIMITS.brightness.max, 0, true),
          gammaX100: ra.num(adjust, 'gammaX100', LIMITS.gammaX100.min, LIMITS.gammaX100.max, 100, true),
          invert: ra.bool(adjust, 'invert', false),
          level: ra.num(adjust, 'level', LIMITS.threshold.min, LIMITS.threshold.max, 128, true),
        },
      }
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) img.dataUrl = dataUrl
      else if (dataUrl !== undefined) r.note('dataUrl is not an inlined image; removed')
      return img
    }
    case 'shape':
      return {
        ...base,
        kind: 'shape',
        shape: r.oneOf(o, 'shape', SHAPES, 'rect'),
        widthMm: r.num(o, 'widthMm', 0.1, LIMITS.widthMm.max, 10),
        size: readSize(r, o),
        strokeMm: r.num(o, 'strokeMm', LIMITS.strokeMm.min, LIMITS.strokeMm.max, 0.5),
        fill: r.bool(o, 'fill', false),
      }
    case 'spacer':
      return { ...base, kind: 'spacer', widthMm: r.num(o, 'widthMm', LIMITS.widthMm.min, LIMITS.widthMm.max, 5) }
    default:
      return undefined
  }
}

/**
 * Structural validation of an already-migrated document (import, share links, IndexedDB).
 *
 * Lenient by design: anything readable is repaired rather than rejected. Numbers are clamped to
 * `LIMITS`, unknown enum values fall back to defaults, items of unknown kinds are dropped and
 * duplicate/missing ids are regenerated; every repair is listed in `notices`. Only input that
 * is not a schema-1 label at all (wrong type, wrong `schema`, no `items` array) fails.
 * The result is a fresh object (never the input), with unknown fields removed.
 */
export function validateDoc(raw: unknown): { ok: true; doc: LabelDoc; notices: string[] } | { ok: false; problems: string[] } {
  if (!isObj(raw)) return { ok: false, problems: ['not a ptouch label document (expected a JSON object)'] }
  if (raw['schema'] !== SCHEMA_VERSION) return { ok: false, problems: [`not a ptouch label document (schema ${shortJson(raw['schema'] ?? null)}, expected ${SCHEMA_VERSION})`] }
  if (!Array.isArray(raw['items'])) return { ok: false, problems: ['not a ptouch label document (no "items" list)'] }

  const r = new Reader('label')
  const now = new Date().toISOString()
  const id = typeof raw['id'] === 'string' && ID_RE.test(raw['id']) ? raw['id'] : (r.note('missing or invalid id; a new one was assigned'), newId())

  const tapeIn = r.obj(raw, 'tape')
  const tr = r.at('tape')
  let widthMm = tapeIn['widthMm'] as TapeWidthMm
  if (!TAPE_WIDTHS_MM.includes(widthMm)) {
    const n = typeof widthMm === 'number' && Number.isFinite(widthMm) ? widthMm : 24
    const nearest = TAPE_WIDTHS_MM.reduce((b, w) => (Math.abs(w - n) < Math.abs(b - n) ? w : b), 24 as TapeWidthMm)
    tr.note(`width ${shortJson(tapeIn['widthMm'] ?? null)} mm is not a TZe width; using ${nearest} mm`)
    widthMm = nearest
  }
  const tape: TapeSettings = { widthMm }
  if (typeof tapeIn['mediaId'] === 'string' && MEDIA_ID_RE.test(tapeIn['mediaId'])) tape.mediaId = tapeIn['mediaId']
  const colors = tapeIn['colors']
  if (isObj(colors) && typeof colors['tape'] === 'string' && typeof colors['ink'] === 'string' && COLOR_RE.test(colors['tape']) && COLOR_RE.test(colors['ink'])) {
    tape.colors = { tape: colors['tape'], ink: colors['ink'] }
  } else if (colors !== undefined) tr.note('tape colours are not #rrggbb colours; using the defaults')

  const lengthIn = r.obj(raw, 'length')
  const length: LengthSettings =
    lengthIn['mode'] === 'fixed' ? { mode: 'fixed', mm: r.at('length').num(lengthIn, 'mm', LIMITS.lengthMm.min, LIMITS.lengthMm.max, 50) } : { mode: 'auto' }

  const m = r.obj(raw, 'marginsMm')
  const mr = r.at('margins')
  const marginsMm = { start: mr.num(m, 'start', LIMITS.marginMm.min, LIMITS.marginMm.max, 2), end: mr.num(m, 'end', LIMITS.marginMm.min, LIMITS.marginMm.max, 2) }

  const lay = r.obj(raw, 'layout')
  const lr = r.at('layout')
  const layout: LayoutSettings =
    lay['mode'] === 'free'
      ? { mode: 'free' }
      : { mode: 'flow', gapMm: lr.num(lay, 'gapMm', LIMITS.gapMm.min, LIMITS.gapMm.max, 3), align: lr.oneOf(lay, 'align', ALIGNS, 'center') }

  let frame: LabelFrame | undefined
  if (raw['frame'] !== undefined && raw['frame'] !== null) {
    const fr = r.obj(raw, 'frame')
    const fRead = r.at('frame')
    frame = {
      thicknessMm: fRead.num(fr, 'thicknessMm', LIMITS.frameThicknessMm.min, LIMITS.frameThicknessMm.max, 0.5),
      radiusMm: fRead.num(fr, 'radiusMm', LIMITS.frameRadiusMm.min, LIMITS.frameRadiusMm.max, 0),
      insetMm: fRead.num(fr, 'insetMm', LIMITS.frameInsetMm.min, LIMITS.frameInsetMm.max, 0),
    }
  }

  const pIn = r.obj(raw, 'print')
  const pr = r.at('print')
  const print: PrintSettings = {
    copies: pr.num(pIn, 'copies', LIMITS.copies.min, LIMITS.copies.max, 1, true),
    autoCut: pr.bool(pIn, 'autoCut', true),
    chain: pr.bool(pIn, 'chain', false),
    mirror: pr.bool(pIn, 'mirror', false),
    threshold: pr.num(pIn, 'threshold', LIMITS.threshold.min, LIMITS.threshold.max, 128, true),
  }

  const items: Item[] = []
  const ids = new Set<string>()
  let rawItems = raw['items'] as unknown[]
  if (rawItems.length > LIMITS.items) {
    r.note(`${rawItems.length} blocks; only the first ${LIMITS.items} were kept`)
    rawItems = rawItems.slice(0, LIMITS.items)
  }
  let chars = 0
  let overBudget = false
  rawItems.forEach((rawItem, i) => {
    if (overBudget) return
    if (!isObj(rawItem)) {
      r.note(`item ${i + 1} is not an object; dropped`)
      return
    }
    let itemId = typeof rawItem['id'] === 'string' && ID_RE.test(rawItem['id']) ? rawItem['id'] : ''
    if (!itemId || ids.has(itemId)) {
      if (itemId) r.note(`item ${i + 1} has a duplicate id; a new one was assigned`)
      itemId = newId()
    }
    const item = readItem(r.at(`item ${i + 1} (${String(rawItem['kind'] ?? '?')})`), rawItem, itemId)
    if (!item) {
      r.note(`item ${i + 1} has unknown kind ${JSON.stringify(rawItem['kind'] ?? null)}; dropped`)
      return
    }
    chars += item.kind === 'text' ? item.text.length : item.kind === 'code' ? item.data.length : 0
    if (chars > LIMITS.totalChars) {
      overBudget = true
      r.note(`more than ${LIMITS.totalChars} characters of text; blocks from ${i + 1} on were dropped`)
      return
    }
    ids.add(itemId)
    items.push(item)
  })

  const doc: LabelDoc = {
    schema: SCHEMA_VERSION,
    id,
    name: r.str(raw, 'name', 'Untitled label', 200) || 'Untitled label',
    createdAt: isTimestamp(raw['createdAt']) ? raw['createdAt'] : now,
    updatedAt: isTimestamp(raw['updatedAt']) ? raw['updatedAt'] : now,
    tape,
    length,
    marginsMm,
    layout,
    ...(frame ? { frame } : {}),
    items,
    print,
  }
  return { ok: true, doc, notices: r.notes }
}

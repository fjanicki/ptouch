// Font picker list model (docs/FONTS-AND-SIZE-PLAN.md §3.2, P-picker): the entries the picker
// lists (bundled library fonts, uploaded fonts, fonts of this computer), search, filter chips,
// grouping (Favourites, Recent, categories, Your fonts, This computer), keyboard moves and
// print-quality notes. Pure (no DOM, no Svelte), so it is unit-tested in node; only the lazily
// loaded picker body (FontPickerPanel.svelte) imports it, which keeps it out of the entry chunk.
import type { FontSource, TextItem } from '../../doc/schema'
import type { FontKey } from '../../doc/persist-prefs'
import { FONT_CATEGORIES, MIN_QUALITY_CAP_MM, type FontCategory, type FontDef } from '../../render/font-catalog'

export type FontEntryKind = 'bundled' | 'user' | 'local'

export interface FontEntry {
  key: FontKey
  kind: FontEntryKind
  /** Display name. */
  label: string
  /** Bundled fonts only. */
  def?: FontDef
  /** Uploaded / local fonts only (what choosing it stores in `TextItem.customFont`). */
  source?: FontSource
  /** A custom font the block uses that is not in the lists (other device, removed). */
  missing?: boolean
  /** Folded label, then the folded search text (category, hint, flags, kind). */
  name: string
  words: string
}

/** Filter chips: a category, or "Your fonts" (uploaded + this computer). */
export type FontFilter = FontCategory | 'yours'

export interface FontGroup {
  id: 'favorites' | 'recent' | 'results' | FontCategory | 'user' | 'local'
  label: string
  entries: FontEntry[]
}

/** The uploaded fonts the picker lists (persist-fonts.ts `UserFontInfo` subset). */
export interface UserFontLike {
  ref: string
  family: string
}
/** The fonts of this computer (local-fonts.svelte.ts `LocalFontInfo`). */
export interface LocalFontLike {
  postscriptName: string
  name: string
}

export const GROUP_LABELS = {
  favorites: 'Favourites',
  recent: 'Recent',
  results: 'Search results',
  user: 'Your fonts',
  local: 'This computer (varies by machine)',
} as const

/** Lower case, accents removed (é → e, ß stays), runs of spaces and punctuation collapsed. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const categoryLabel = (c: FontCategory): string => FONT_CATEGORIES.find((x) => x.id === c)?.label ?? c

function bundledWords(def: FontDef): string {
  const flags = [def.condensed ? 'condensed narrow' : '', def.pixel ? 'pixel retro bitmap' : '', def.quality === 'script' ? 'script' : '', def.generic === 'monospace' ? 'monospaced' : '']
  return fold([categoryLabel(def.category), def.hint, ...flags].join(' '))
}

/**
 * Every font the picker can list, in canonical order: bundled fonts by category (FONT_CATEGORIES
 * order, registry order inside a category), then uploaded fonts, then this computer's fonts.
 */
export function fontEntries(fonts: readonly FontDef[], userFonts: readonly UserFontLike[] = [], localFonts: readonly LocalFontLike[] = []): FontEntry[] {
  const out: FontEntry[] = []
  for (const c of FONT_CATEGORIES) {
    for (const def of fonts) {
      if (def.category !== c.id) continue
      out.push({ key: `b:${def.id}`, kind: 'bundled', label: def.label, def, name: fold(def.label), words: bundledWords(def) })
    }
  }
  for (const f of userFonts) {
    out.push({ key: `u:${f.ref}`, kind: 'user', label: f.family, source: { kind: 'user', ref: f.ref, family: f.family }, name: fold(f.family), words: fold('your fonts uploaded') })
  }
  for (const f of localFonts) {
    out.push({ key: `l:${f.postscriptName}`, kind: 'local', label: f.name, source: { kind: 'local', postscriptName: f.postscriptName, family: f.name }, name: fold(f.name), words: fold(`this computer local ${f.postscriptName}`) })
  }
  return out
}

/** An entry for the block's own custom font when the lists do not have it (shown as missing). */
export function missingEntry(item: Pick<TextItem, 'customFont'>, entries: readonly FontEntry[]): FontEntry | undefined {
  const c = item.customFont
  if (!c) return undefined
  const key: FontKey = c.kind === 'user' ? `u:${c.ref}` : `l:${c.postscriptName}`
  if (entries.some((e) => e.key === key)) return undefined
  return { key, kind: c.kind, label: c.family, source: c, missing: true, name: fold(c.family), words: '' }
}

/**
 * How well `entry` matches the (unfolded) `query`: 0 = no match. Every word of the query must
 * match: the whole name (100), the start of the name (80), the start of a word of the name (60),
 * anywhere in the name (40), the start of a search word (20) or anywhere in the search text (10).
 */
export function matchScore(entry: FontEntry, query: string): number {
  const tokens = fold(query).split(' ').filter(Boolean)
  if (!tokens.length) return 1
  let score = 0
  const nameWords = entry.name.split(' ')
  const words = entry.words.split(' ')
  for (const t of tokens) {
    const s =
      entry.name === t ? 100
      : entry.name.startsWith(t) ? 80
      : nameWords.some((w) => w.startsWith(t)) ? 60
      : entry.name.includes(t) ? 40
      : words.some((w) => w.startsWith(t)) ? 20
      : entry.words.includes(t) ? 10
      : 0
    if (!s) return 0
    score += s
  }
  return score
}

function passes(entry: FontEntry, filters: ReadonlySet<FontFilter>): boolean {
  if (!filters.size) return true
  if (entry.kind === 'bundled') return !!entry.def && filters.has(entry.def.category)
  return filters.has('yours')
}

/** The chips worth showing: categories that have fonts, then "Your fonts" when there are any. */
export function availableFilters(entries: readonly FontEntry[]): { id: FontFilter; label: string }[] {
  const cats = new Set(entries.flatMap((e) => (e.def ? [e.def.category] : [])))
  const out: { id: FontFilter; label: string }[] = FONT_CATEGORIES.filter((c) => cats.has(c.id)).map((c) => ({ id: c.id, label: c.label }))
  if (entries.some((e) => e.kind !== 'bundled')) out.push({ id: 'yours', label: GROUP_LABELS.user })
  return out
}

export interface GroupOptions {
  entries: readonly FontEntry[]
  favorites?: readonly FontKey[]
  recent?: readonly FontKey[]
  query?: string
  filters?: ReadonlySet<FontFilter>
}

/**
 * The listbox groups, in display order.
 * - Browsing (no search, no chip): Favourites, Recent, each category, Your fonts, This computer.
 *   Favourites and recent fonts that are gone (removed upload, local list not loaded) are skipped.
 * - Filtering with chips: only the chosen categories / Your fonts and This computer.
 * - Searching: one "Search results" group, best match first (ties keep the canonical order).
 * Empty groups are left out.
 */
export function buildGroups({ entries, favorites = [], recent = [], query = '', filters = new Set() }: GroupOptions): FontGroup[] {
  const pool = entries.filter((e) => passes(e, filters))
  if (fold(query)) {
    const scored = pool.map((e, i) => ({ e, i, s: matchScore(e, query) })).filter((x) => x.s > 0)
    scored.sort((a, b) => b.s - a.s || a.i - b.i)
    return scored.length ? [{ id: 'results', label: GROUP_LABELS.results, entries: scored.map((x) => x.e) }] : []
  }
  const byKey = new Map(entries.map((e) => [e.key, e] as const))
  const pick = (keys: readonly FontKey[]): FontEntry[] => [...new Set(keys)].flatMap((k) => byKey.get(k) ?? [])
  const groups: FontGroup[] = []
  if (!filters.size) {
    groups.push({ id: 'favorites', label: GROUP_LABELS.favorites, entries: pick(favorites) })
    groups.push({ id: 'recent', label: GROUP_LABELS.recent, entries: pick(recent) })
  }
  for (const c of FONT_CATEGORIES) groups.push({ id: c.id, label: c.label, entries: pool.filter((e) => e.def?.category === c.id) })
  groups.push({ id: 'user', label: GROUP_LABELS.user, entries: pool.filter((e) => e.kind === 'user') })
  groups.push({ id: 'local', label: GROUP_LABELS.local, entries: pool.filter((e) => e.kind === 'local') })
  return groups.filter((g) => g.entries.length > 0)
}

/** One listbox option: the entry and its group (an entry can be listed in several groups). */
export interface FontOption {
  entry: FontEntry
  group: FontGroup['id']
  index: number
}

/** The options in listbox order (what ↑/↓ walk through). */
export function flatOptions(groups: readonly FontGroup[]): FontOption[] {
  let index = 0
  return groups.flatMap((g) => g.entries.map((entry) => ({ entry, group: g.id, index: index++ })))
}

/** Rows a Page Up / Page Down moves. */
export const PAGE_ROWS = 8

/**
 * The active option after `key` (ArrowDown/Up, Home/End, PageDown/PageUp), clamped to the list;
 * `undefined` for other keys. From "none active" (-1), ↓ goes to the first option, ↑ to the last.
 */
export function moveActive(active: number, key: string, count: number): number | undefined {
  if (count <= 0) return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End' ? -1 : undefined
  const last = count - 1
  switch (key) {
    case 'ArrowDown':
      return active < 0 ? 0 : Math.min(last, active + 1)
    case 'ArrowUp':
      return active < 0 ? last : Math.max(0, active - 1)
    case 'Home':
      return 0
    case 'End':
      return last
    case 'PageDown':
      return Math.min(last, Math.max(0, active) + PAGE_ROWS)
    case 'PageUp':
      return Math.max(0, active - PAGE_ROWS)
    default:
      return undefined
  }
}

/** First line of the block's text, trimmed to about 24 characters ("" when it is empty). */
export function previewText(text: string, max = 24): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''
  const chars = [...line]
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : line
}

/** The sentence the picker shows when `def` prints poorly at the block's cap height. */
export function qualityNote(def: Pick<FontDef, 'quality' | 'label'>): string | undefined {
  if (def.quality === 'thin') return `${def.label} has thin strokes that print poorly below ${MIN_QUALITY_CAP_MM} mm; try M or larger.`
  if (def.quality === 'script') return `${def.label} is a script font that blurs below ${MIN_QUALITY_CAP_MM} mm; try M or larger.`
  return undefined
}

/** Short tag for a row whose font would print poorly at the block's current cap height. */
export function qualityTag(def: Pick<FontDef, 'quality'> | undefined, capMm: number | undefined): string | undefined {
  if (!def?.quality || capMm === undefined || !(capMm < MIN_QUALITY_CAP_MM)) return undefined
  return def.quality === 'thin' ? 'Thin at this size' : 'Hard to read at this size'
}

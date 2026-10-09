// P1 (docs/STUDIO-V1-PLAN.md) — variables and batch labels. Pure; imports only ./schema.
//
// Placeholders are `{{name}}` in TextItem.text, CodeItem.data and CodeItem.wifi.ssid/password.
// A Wi-Fi password is a placeholder only when the WHOLE field is one `{{name}}` (e.g. `{{pw}}`
// for a per-row password column); braces anywhere else in a password are literal characters
// (WPA passphrases may contain them), never substituted and never "missing".
// Names resolve, in this order, to:
//   1. a batch column (`BatchData.columns`, value from the current row);
//   2. a batch counter (`BatchData.counters`, e.g. `{{n}}` → start + i × step, zero-padded);
//   3. built-ins: `{{today}}`, `{{today+30d}}` / `{{today-7d}}` (local date in
//      `BatchData.dateFormat`, 'iso' without batch data), `{{ssid}}` (the first Wi-Fi code's
//      network name; used by the Wi-Fi sticker templates).
// Anything else is "missing": it stays visible as `{{name}}` in the preview/print and is
// listed in `ResolvedDoc.missing` so the UI can highlight it.
//
// Only the fields that are printed are scanned: a QR code with content 'wifi' encodes its
// `wifi` block (not `data`), every other code encodes `data` (render/codes.ts codePayload).
// Resolution is a single pass: a value that itself contains `{{…}}` is printed verbatim.

import { LIMITS, VARIABLE_NAME_RE, type BatchCounter, type CodeItem, type DateFormat, type Item, type LabelDoc } from './schema'

export interface VariableContext {
  /** "Today" for date variables (local time). */
  now: Date
  /** Locale for the 'long' date format (default: the browser's). Tests pass one explicitly. */
  locale?: string
}

export interface ResolvedDoc {
  /** The label with every known placeholder replaced; the input object itself when the doc has
   * no placeholders (cheap: the studio resolves before every render). */
  doc: LabelDoc
  /** Unknown placeholder names, deduplicated, in order of appearance. */
  missing: string[]
}

/** What a placeholder name refers to (VariableHint chips, BatchPanel). */
export type VariableKind = 'column' | 'counter' | 'date' | 'ssid' | 'missing'

/** `{{ name }}` (inner spaces tolerated); group 1 is the raw name. No braces inside. */
const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g
/** `today`, `today+30d`, `today-7d` (N ≤ MAX_DATE_OFFSET days). */
const DATE_RE = /^today(?:([+-])(\d{1,4})d)?$/
/** Largest `{{today±Nd}}` offset (10 years). */
export const MAX_DATE_OFFSET = 3650

/** Placeholder names in `text` (trimmed, deduplicated, in order of appearance). */
export function placeholderNames(text: string): string[] {
  if (!text.includes('{{')) return []
  const out: string[] = []
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const name = (m[1] ?? '').trim()
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/** `{{name}}` → its placeholder name when the WHOLE string is one placeholder (Wi-Fi passwords). */
export function passwordVariable(password: string): string | undefined {
  const m = /^\{\{([^{}]*)\}\}$/.exec(password)
  return m ? (m[1] ?? '').trim() : undefined
}

/** A QR code with content 'wifi' encodes `wifi`; every other code encodes `data`. */
function encodesWifi(item: CodeItem): boolean {
  return item.content === 'wifi' && item.symbology === 'qr'
}

/** The printed strings of an item that may hold placeholders. */
function itemFields(item: Item): string[] {
  if (item.kind === 'text') return [item.text]
  if (item.kind !== 'code') return []
  if (!encodesWifi(item)) return [item.data]
  if (!item.wifi) return []
  return passwordVariable(item.wifi.password) === undefined ? [item.wifi.ssid] : [item.wifi.ssid, item.wifi.password]
}

/** Names of all `{{…}}` placeholders in the doc (deduplicated, in order of appearance). */
export function findVariables(doc: LabelDoc): string[] {
  const out: string[] = []
  for (const item of doc.items) {
    for (const field of itemFields(item)) {
      for (const name of placeholderNames(field)) if (!out.includes(name)) out.push(name)
    }
  }
  return out
}

/**
 * Labels the batch prints: rows (or `count` without rows) when `doc.batch.enabled`, else 0 (a
 * plain label). Capped at LIMITS.batchRows.
 */
export function batchSize(doc: LabelDoc): number {
  const b = doc.batch
  if (!b?.enabled) return 0
  return Math.min(LIMITS.batchRows, b.rows.length > 0 ? b.rows.length : Math.max(1, Math.round(b.count)))
}

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

/** Value of `counter` for label `index` (0-based): start + index × step, zero-padded to `pad`
 * digits after the sign (pad 2: -1 → "-01"). */
export function counterValue(counter: BatchCounter, index: number): string {
  const v = Math.round(counter.start) + Math.max(0, Math.floor(index)) * Math.round(counter.step)
  const digits = String(Math.abs(v)).padStart(Math.max(0, Math.min(LIMITS.counterPad.max, Math.round(counter.pad))), '0')
  return v < 0 ? `-${digits}` : digits
}

/** `now` shifted by `days` calendar days in local time (DST-safe: date parts, never ms). */
export function addDays(now: Date, days: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)
}

const two = (n: number): string => String(n).padStart(2, '0')

/** A local calendar date in `format` ('long' via Intl in `locale`, default the browser's). */
export function formatDate(date: Date, format: DateFormat, locale?: string): string {
  const y = String(date.getFullYear()).padStart(4, '0')
  const m = two(date.getMonth() + 1)
  const d = two(date.getDate())
  switch (format) {
    case 'dmy':
      return `${d}/${m}/${y}`
    case 'mdy':
      return `${m}/${d}/${y}`
    case 'long':
      return new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(date)
    default:
      return `${y}-${m}-${d}`
  }
}

/** Day offset of a date placeholder (`today` 0, `today+30d` 30, `today-7d` −7), or undefined
 * when `name` is not one (or the offset is over MAX_DATE_OFFSET). */
export function dateOffset(name: string): number | undefined {
  const m = DATE_RE.exec(name)
  if (!m) return undefined
  const n = m[2] ? Number(m[2]) : 0
  if (n > MAX_DATE_OFFSET) return undefined
  return m[1] === '-' ? -n : n
}

/** The first Wi-Fi QR code of the label (the `{{ssid}}` source). */
function firstWifi(doc: LabelDoc): CodeItem | undefined {
  for (const i of doc.items) if (i.kind === 'code' && encodesWifi(i) && i.wifi) return i
  return undefined
}

/** What `name` refers to in `doc` (independent of the row). */
export function variableKind(doc: LabelDoc, name: string): VariableKind {
  const b = doc.batch
  if (b && VARIABLE_NAME_RE.test(name)) {
    if (b.columns.includes(name)) return 'column'
    if (b.counters.some((c) => c.name === name)) return 'counter'
  }
  if (dateOffset(name) !== undefined) return 'date'
  if (name === 'ssid' && firstWifi(doc)) return 'ssid'
  return 'missing'
}

/** Placeholder names in the doc that nothing defines (in order of appearance). */
export function missingVariables(doc: LabelDoc): string[] {
  return findVariables(doc).filter((n) => variableKind(doc, n) === 'missing')
}

/** Batch columns the label actually uses (by placeholder). */
export function usedColumns(doc: LabelDoc): string[] {
  const used = findVariables(doc)
  return (doc.batch?.columns ?? []).filter((c) => used.includes(c))
}

/** Columns the label uses while the enabled batch has no rows: every label would print them
 * blank, so printing is blocked until data is added (view-model.ts printBlockReason). */
export function columnsWithoutData(doc: LabelDoc): string[] {
  const b = doc.batch
  if (!b?.enabled || b.rows.length > 0) return []
  return usedColumns(doc)
}

/** The label prints a `{{today…}}` date (its render depends on the calendar day). */
export function usesDates(doc: LabelDoc): boolean {
  return findVariables(doc).some((n) => dateOffset(n) !== undefined)
}

/** The local calendar day of `now` (YYYY-MM-DD): part of the render key of dated labels, so a
 * preview made before midnight is never printed after it. */
export function localDay(now: Date): string {
  return formatDate(now, 'iso')
}

type Lookup = (name: string) => string | undefined

/** Replaces known placeholders in `text`; unknown ones stay and are added to `missing`. */
function substitute(text: string, lookup: Lookup, missing: string[]): string {
  if (!text.includes('{{')) return text
  return text.replace(PLACEHOLDER_RE, (whole, raw: string) => {
    const name = raw.trim()
    const v = lookup(name)
    if (v !== undefined) return v
    if (!missing.includes(name)) missing.push(name)
    return whole
  })
}

/**
 * The doc as label `index` (0-based) of its batch, placeholders replaced. Without batch data
 * (or with it disabled) index 0 is used for counters and the built-ins still resolve.
 */
export function resolveDoc(doc: LabelDoc, index: number, ctx: VariableContext): ResolvedDoc {
  if (!doc.items.some((i) => itemFields(i).some((f) => f.includes('{{')))) return { doc, missing: [] }

  const b = doc.batch
  // A disabled batch still shows (and prints once) the preview row: data resolves either way.
  const i = b?.enabled || (b && b.rows.length > 0) ? Math.max(0, Math.floor(Number.isFinite(index) ? index : 0)) : 0
  const row = b && b.rows.length > 0 ? (b.rows[Math.min(i, b.rows.length - 1)] ?? []) : undefined
  const dateFormat: DateFormat = b?.dateFormat ?? 'iso'

  const base: Lookup = (name) => {
    if (b && VARIABLE_NAME_RE.test(name)) {
      const col = b.columns.indexOf(name)
      if (col >= 0) return row?.[col] ?? ''
      const counter = b.counters.find((c) => c.name === name)
      if (counter) return counterValue(counter, i)
    }
    const days = dateOffset(name)
    if (days !== undefined) return formatDate(addDays(ctx.now, days), dateFormat, ctx.locale)
    return undefined
  }

  // `{{ssid}}`: the first Wi-Fi code's network name, itself resolved (without `{{ssid}}`). An
  // empty name keeps the placeholder visible (an obviously unfilled template), but is not missing.
  const wifi = firstWifi(doc)
  let ssid: string | undefined
  if (wifi?.wifi) ssid = substitute(wifi.wifi.ssid, base, [])
  const lookup: Lookup = (name) => {
    const v = base(name)
    if (v !== undefined) return v
    if (name === 'ssid' && ssid !== undefined) return ssid === '' ? '{{ssid}}' : ssid
    return undefined
  }

  const missing: string[] = []
  let changed = false
  const items = doc.items.map((item): Item => {
    if (item.kind === 'text') {
      const text = substitute(item.text, lookup, missing)
      if (text === item.text) return item
      changed = true
      return { ...item, text }
    }
    if (item.kind !== 'code') return item
    if (!encodesWifi(item)) {
      const data = substitute(item.data, lookup, missing)
      if (data === item.data) return item
      changed = true
      return { ...item, data }
    }
    if (!item.wifi) return item
    // The `{{ssid}}` source cannot refer to itself.
    const s = substitute(item.wifi.ssid, item === wifi ? base : lookup, missing)
    const p = passwordVariable(item.wifi.password) === undefined ? item.wifi.password : substitute(item.wifi.password, lookup, missing)
    if (s === item.wifi.ssid && p === item.wifi.password) return item
    changed = true
    return { ...item, wifi: { ...item.wifi, ssid: s, password: p } }
  })
  return { doc: changed ? { ...doc, items } : doc, missing }
}

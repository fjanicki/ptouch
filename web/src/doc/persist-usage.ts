// P4 (docs/STUDIO-V1-PLAN.md) — tape usage counter: total mm printed per tape width, resettable.
// localStorage (try/catch everywhere, like persist-prefs.ts); sanitized on load. The mm come from
// render/job.ts estimateTape (labels + feed margins + the leader when one was fed).
import type { PrefsStorage } from './persist-prefs'

export const USAGE_KEY = 'ptouch.usage.v1'

export interface TapeUsageEntry {
  /** Tape fed, incl. leaders, mm. */
  mm: number
  labels: number
  jobs: number
}

export interface TapeUsage {
  /** ISO 8601: first use or last reset. */
  since: string
  /** Key = tape width in mm as a string ("3.5", "12", …). */
  byWidth: Partial<Record<string, TapeUsageEntry>>
}

/** Widest tape any P-touch takes is 36 mm; anything else in storage is junk. */
const MAX_WIDTH_MM = 100
/** Per-job sanity cap (a 999-page job of 1 m labels is ~1 km). */
const MAX_JOB_MM = 1_000_000

function defaultStorage(): PrefsStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined
  } catch {
    return undefined // SecurityError: storage disabled
  }
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** Width key: "12", "3.5" (canonical number text), or undefined for an implausible width. */
function widthKey(widthMm: number): string | undefined {
  if (!Number.isFinite(widthMm) || widthMm <= 0 || widthMm > MAX_WIDTH_MM) return undefined
  return String(Math.round(widthMm * 10) / 10)
}

function validIso(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v))
}

/** Keeps only well-typed entries; anything else is dropped (never throws). */
export function sanitizeUsage(raw: unknown, now = new Date()): TapeUsage {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const out: TapeUsage = { since: validIso(r['since']) ? r['since'] : now.toISOString(), byWidth: {} }
  const by = r['byWidth']
  if (typeof by === 'object' && by !== null && !Array.isArray(by)) {
    for (const [k, v] of Object.entries(by as Record<string, unknown>)) {
      const key = widthKey(Number(k))
      if (!key || key !== k || typeof v !== 'object' || v === null) continue
      const e = v as Record<string, unknown>
      if (!isCount(e['mm']) || !isCount(e['labels']) || !isCount(e['jobs'])) continue
      out.byWidth[key] = { mm: e['mm'], labels: Math.floor(e['labels']), jobs: Math.floor(e['jobs']) }
    }
  }
  return out
}

function save(usage: TapeUsage, storage: PrefsStorage | undefined): void {
  try {
    storage?.setItem(USAGE_KEY, JSON.stringify(usage))
  } catch {
    // storage unavailable or full: the counter is best-effort
  }
}

export function loadUsage(storage: PrefsStorage | undefined = defaultStorage()): TapeUsage {
  try {
    const raw = storage?.getItem(USAGE_KEY)
    if (raw) return sanitizeUsage(JSON.parse(raw))
  } catch {
    // corrupt JSON / SecurityError: start over below
  }
  const fresh = sanitizeUsage(undefined)
  save(fresh, storage) // remember "since" from the first visit
  return fresh
}

/** Adds one job and returns the new totals. Never throws. */
export function addUsage(widthMm: number, mm: number, labels: number, storage: PrefsStorage | undefined = defaultStorage()): TapeUsage {
  const usage = loadUsage(storage)
  const key = widthKey(widthMm)
  if (!key || !isCount(mm) || mm > MAX_JOB_MM || !isCount(labels)) return usage
  const prev = usage.byWidth[key] ?? { mm: 0, labels: 0, jobs: 0 }
  const next: TapeUsage = {
    since: usage.since,
    byWidth: { ...usage.byWidth, [key]: { mm: Math.round((prev.mm + mm) * 100) / 100, labels: prev.labels + Math.floor(labels), jobs: prev.jobs + 1 } },
  }
  save(next, storage)
  return next
}

export function resetUsage(storage: PrefsStorage | undefined = defaultStorage()): TapeUsage {
  const fresh = sanitizeUsage(undefined)
  save(fresh, storage)
  return fresh
}

/** Widths in use, narrowest first (for display). */
export function usageRows(usage: TapeUsage): { widthMm: number; entry: TapeUsageEntry }[] {
  return Object.entries(usage.byWidth)
    .flatMap(([k, e]) => (e ? [{ widthMm: Number(k), entry: e }] : []))
    .sort((a, b) => a.widthMm - b.widthMm)
}

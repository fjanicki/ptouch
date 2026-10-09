// Schema migrations (unit-tested). Every stored, imported or shared document goes through
// `migrate()`: it upgrades the JSON step by step to SCHEMA_VERSION, then calls `validateDoc`
// (W3) on the result. Documents written by a NEWER app version are not downgraded: they are
// validated as if current and opened read-only, so they are never overwritten with data loss.
//
// Adding a schema version N+1:
//   1. bump SCHEMA_VERSION in schema.ts (W3) and change the types;
//   2. add `N: (doc) => …` to MIGRATIONS below (input = a valid schema-N JSON object);
//   3. add a fixture `tests/unit/persist/fixtures/schema-N.json` + a test.
import { SCHEMA_VERSION, createDoc, shortJson, validateDoc, type LabelDoc } from './schema'

export type MigrateResult =
  | { ok: true; doc: LabelDoc; readOnly: boolean; migratedFrom?: number }
  | { ok: false; problems: string[] }

export const CURRENT_SCHEMA = SCHEMA_VERSION

type Json = Record<string, unknown>
type Migration = (doc: Json) => Json

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * `MIGRATIONS[n]` upgrades a schema-`n` object to schema `n + 1`.
 *
 * Schema 0 = unversioned JSON (hand-written files, the pre-release prototype): an object with an
 * `items` array but no `schema` field. Missing top-level settings are filled from `createDoc()`
 * defaults; item fields are left to `validateDoc`.
 */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  0: (raw) => {
    const base = createDoc({ items: [] }) as unknown as Json
    const out: Json = { ...base }
    // Untrusted keys: never assign "__proto__" (it would swap the object's prototype) or other
    // prototype-related names; validateDoc reads only own, known fields anyway.
    for (const [k, v] of Object.entries(raw)) if (v !== undefined && v !== null && !UNSAFE_KEYS.has(k)) out[k] = v
    out['schema'] = 1
    if (typeof out['name'] !== 'string' || out['name'] === '') out['name'] = 'Imported label'
    return out
  },
  /**
   * Schema 1 → 2 (studio v1). Only code items change, and they print exactly as before:
   * `quietZone` true/false → 'standard'/'none', `content` = 'text', and `moduleDots` keeps its
   * number (only NEW items default to 'auto'). Everything else (custom fonts, batch, Wi-Fi) is
   * new and optional.
   */
  1: (raw) => {
    const items = Array.isArray(raw['items'])
      ? (raw['items'] as unknown[]).map((item) => {
          if (!isObject(item) || item['kind'] !== 'code') return item
          const out: Json = { ...item, content: 'text' }
          if (typeof item['quietZone'] === 'boolean') out['quietZone'] = item['quietZone'] ? 'standard' : 'none'
          return out
        })
      : raw['items']
    return { ...raw, schema: 2, items }
  },
}

/** Schema version of a raw object (0 = unversioned), or a problem string. */
function versionOf(raw: Json): number | string {
  const s = raw['schema']
  if (s === undefined) return Array.isArray(raw['items']) ? 0 : 'not a ptouch label document (no "schema" or "items")'
  if (typeof s !== 'number' || !Number.isInteger(s) || s < 0) return `invalid schema version ${shortJson(s)}`
  return s
}

/** Upgrades any stored/imported JSON to the current schema, then validates it. */
export function migrate(raw: unknown): MigrateResult {
  if (!isObject(raw)) return { ok: false, problems: ['not a ptouch label document (expected a JSON object)'] }
  const from = versionOf(raw)
  if (typeof from === 'string') return { ok: false, problems: [from] }

  if (from > CURRENT_SCHEMA) {
    // Newer app wrote this. Try to read it as the current schema (additive changes are the norm);
    // the caller must not save it back.
    const v = validateDoc({ ...raw, schema: CURRENT_SCHEMA })
    if (!v.ok) return { ok: false, problems: [`made by a newer version of ptouch studio (schema ${from}); please update the app`, ...v.problems] }
    return { ok: true, doc: v.doc, readOnly: true, migratedFrom: from }
  }

  let doc: Json = structuredClone(raw)
  for (let n = from; n < CURRENT_SCHEMA; n++) {
    const step = MIGRATIONS[n]
    if (!step) return { ok: false, problems: [`no migration from schema ${n} to ${n + 1}`] }
    try {
      doc = step(doc)
    } catch (e) {
      return { ok: false, problems: [`migration from schema ${n} failed: ${e instanceof Error ? e.message : String(e)}`] }
    }
  }

  const v = validateDoc(doc)
  if (!v.ok) return { ok: false, problems: v.problems }
  return from === CURRENT_SCHEMA ? { ok: true, doc: v.doc, readOnly: false } : { ok: true, doc: v.doc, readOnly: false, migratedFrom: from }
}

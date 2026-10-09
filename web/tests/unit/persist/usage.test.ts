// P4 — tape usage counter: add/reset per width, sanitised loading, never throws.
import { describe, expect, it } from 'vitest'
import { USAGE_KEY, addUsage, loadUsage, resetUsage, sanitizeUsage, usageRows } from '../../../src/doc/persist-usage'
import type { PrefsStorage } from '../../../src/doc/persist-prefs'

function memory(): PrefsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

const throwing: PrefsStorage = {
  getItem: () => {
    throw new DOMException('denied', 'SecurityError')
  },
  setItem: () => {
    throw new DOMException('full', 'QuotaExceededError')
  },
}

describe('tape usage', () => {
  it('starts empty and remembers when counting began', () => {
    const s = memory()
    const u = loadUsage(s)
    expect(u.byWidth).toEqual({})
    expect(Date.parse(u.since)).not.toBeNaN()
    expect(loadUsage(s).since).toBe(u.since)
  })

  it('adds jobs per tape width', () => {
    const s = memory()
    addUsage(12, 50.5, 2, s)
    addUsage(12, 30.25, 1, s)
    const u = addUsage(3.5, 40, 3, s)
    expect(u.byWidth).toEqual({ '12': { mm: 80.75, labels: 3, jobs: 2 }, '3.5': { mm: 40, labels: 3, jobs: 1 } })
    expect(loadUsage(s)).toEqual(u)
    expect(usageRows(u).map((r) => r.widthMm)).toEqual([3.5, 12])
  })

  it('ignores impossible jobs', () => {
    const s = memory()
    for (const [w, mm, n] of [
      [Number.NaN, 10, 1],
      [-6, 10, 1],
      [500, 10, 1],
      [12, -1, 1],
      [12, Number.POSITIVE_INFINITY, 1],
      [12, 10, -2],
    ] as const) {
      expect(addUsage(w, mm, n, s).byWidth).toEqual({})
    }
  })

  it('resets to zero with a new start date', () => {
    const s = memory()
    s.data.set(USAGE_KEY, JSON.stringify({ since: '2020-01-01T00:00:00.000Z', byWidth: { '24': { mm: 1000, labels: 10, jobs: 5 } } }))
    expect(loadUsage(s).byWidth['24']?.mm).toBe(1000)
    const r = resetUsage(s)
    expect(r.byWidth).toEqual({})
    expect(r.since).not.toBe('2020-01-01T00:00:00.000Z')
    expect(loadUsage(s)).toEqual(r)
  })

  it('sanitises stored junk', () => {
    const now = new Date('2026-10-08T00:00:00Z')
    expect(sanitizeUsage('nope', now)).toEqual({ since: now.toISOString(), byWidth: {} })
    const u = sanitizeUsage(
      {
        since: 'yesterday-ish',
        byWidth: { '12': { mm: 5, labels: 1.7, jobs: 1 }, '9.0': { mm: 1, labels: 1, jobs: 1 }, x: {}, '18': { mm: 'lots', labels: 1, jobs: 1 }, '24': null, __proto__: { mm: 1 } },
      },
      now,
    )
    expect(u).toEqual({ since: now.toISOString(), byWidth: { '12': { mm: 5, labels: 1, jobs: 1 } } })
    const s = memory()
    s.data.set(USAGE_KEY, '{not json')
    expect(loadUsage(s).byWidth).toEqual({})
  })

  it('never throws when storage is unavailable', () => {
    expect(() => loadUsage(throwing)).not.toThrow()
    expect(addUsage(12, 10, 1, throwing).byWidth['12']).toEqual({ mm: 10, labels: 1, jobs: 1 })
    expect(resetUsage(throwing).byWidth).toEqual({})
  })
})

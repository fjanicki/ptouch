// W5 — preferences survive throwing / corrupt / missing localStorage.
import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS, PREFS_KEY, loadPrefs, sanitizePrefs, savePrefs, type PrefsStorage } from '../../../src/doc/persist-prefs'

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

describe('prefs', () => {
  it('returns defaults when nothing is stored or storage is missing', () => {
    expect(loadPrefs(memory())).toEqual(DEFAULT_PREFS)
    expect(loadPrefs(undefined)).toEqual(DEFAULT_PREFS)
  })

  it('saves and merges patches', () => {
    const s = memory()
    savePrefs({ theme: 'dark' }, s)
    const p = savePrefs({ lastPath: 'bluetooth', lastTransport: { kind: 'serial-rfcomm', label: 'Bluetooth printer' } }, s)
    expect(p.theme).toBe('dark')
    expect(loadPrefs(s)).toEqual(p)
    expect(loadPrefs(s).lastPath).toBe('bluetooth')
  })

  it('removes keys patched with undefined', () => {
    const s = memory()
    savePrefs({ lastLabelId: 'x' }, s)
    expect(savePrefs({ lastLabelId: undefined }, s).lastLabelId).toBeUndefined()
    expect(loadPrefs(s).lastLabelId).toBeUndefined()
  })

  it('never throws when storage throws', () => {
    expect(loadPrefs(throwing)).toEqual(DEFAULT_PREFS)
    expect(savePrefs({ theme: 'light' }, throwing).theme).toBe('light')
  })

  it('ignores corrupt JSON and wrong types field by field', () => {
    const s = memory()
    s.data.set(PREFS_KEY, '{not json')
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS)
    s.data.set(PREFS_KEY, JSON.stringify({ theme: 'neon', previewZoom: 'big', autoReconnect: false, lastPath: 'carrier-pigeon', previewMode: 'dots' }))
    expect(loadPrefs(s)).toEqual({ ...DEFAULT_PREFS, autoReconnect: false, previewMode: 'dots' })
  })

  it('clamps the preview zoom', () => {
    expect(sanitizePrefs({ previewZoom: 1000 }).previewZoom).toBe(16)
    expect(sanitizePrefs({ previewZoom: 0 }).previewZoom).toBe(0.1)
  })
})

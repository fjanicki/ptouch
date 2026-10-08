// W1 — wasm loader + error contract seen from TS (node, `initSync`).
import { describe, expect, it } from 'vitest'
import { loadWasmForTests } from '../../helpers/wasm'
import {
  cancelSequence,
  cssHexToRgb,
  genericHandshake,
  isPtouchError,
  isWasmLoaded,
  loadWasm,
  parseStatus,
  printArea,
  ptouchErrorCode,
  Raster,
  release,
  scoped,
  statusRequest,
  version,
} from '../../../src/wasm'

loadWasmForTests()

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(Error)
    expect(isPtouchError(e)).toBe(true)
    return ptouchErrorCode(e)
  }
  expect.unreachable('expected a PtouchError')
}

describe('wasm loader', () => {
  it('is marked loaded and loadWasm() resolves without refetching', async () => {
    expect(isWasmLoaded()).toBe(true)
    await expect(loadWasm()).resolves.toBeUndefined()
  })

  it('exposes the core version', () => {
    expect(version()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('returns the raw command sequences', () => {
    expect([...statusRequest()]).toEqual([0x1b, 0x69, 0x53])
    const hs = genericHandshake()
    expect(hs.length).toBe(206)
    expect(hs.slice(0, 200).every((b) => b === 0)).toBe(true)
    expect([...hs.slice(200)]).toEqual([0x1b, 0x40, 0x1b, 0x69, 0x61, 0x01])
    const cancel = cancelSequence('PT-P710BT')
    expect(cancel).toBeInstanceOf(Uint8Array)
    expect([...cancel.slice(-2)]).toEqual([0x1b, 0x40])
  })
})

describe('PtouchError', () => {
  it('carries stable codes', () => {
    expect(codeOf(() => scoped(new Raster(10, 8), (r) => r.blitCrisp(new Uint8Array(4), 1, 1, 0, 128)))).toBe('INVALID_INPUT')
    expect(codeOf(() => parseStatus(new Uint8Array(5)))).toBe('STATUS_LENGTH')
    expect(codeOf(() => parseStatus(new Uint8Array(32)))).toBe('STATUS_HEADER')
    expect(codeOf(() => printArea('PT-NOPE', 'tze128-24'))).toBe('UNKNOWN_MODEL')
    expect(codeOf(() => printArea('PT-P710BT', 'tze560-24'))).toBe('UNSUPPORTED_MEDIA')
    expect(codeOf(() => cancelSequence('nope'))).toBe('UNKNOWN_MODEL')
  })

  it('has name PtouchError and a readable message', () => {
    try {
      parseStatus(new Uint8Array(5))
    } catch (e) {
      expect((e as Error).name).toBe('PtouchError')
      expect((e as Error).message).toContain('5 bytes')
    }
  })

  it('guards only PtouchErrors', () => {
    expect(isPtouchError(new Error('x'))).toBe(false)
    expect(isPtouchError({ name: 'PtouchError', code: 'EMPTY' })).toBe(false)
    expect(isPtouchError('PtouchError')).toBe(false)
    expect(ptouchErrorCode(new Error('x'))).toBeUndefined()
  })
})

describe('helpers', () => {
  it('scoped() frees after use, also when the handle was consumed', () => {
    const bmp = scoped(new Raster(4, 8), (r) => r.finish())
    expect(bmp.length).toBe(4)
    release(bmp)
    release(bmp) // double release is a no-op
    release(null)
    const r = new Raster(4, 8)
    r.finish().free()
    expect(() => r.free()).toThrow() // plain free() on a consumed handle throws
    release(r)
  })

  it('cssHexToRgb parses status colours', () => {
    expect(cssHexToRgb('#ffffff')).toBe(0xffffff)
    expect(cssHexToRgb('#ff3e4a')).toBe(0xff3e4a)
    expect(cssHexToRgb('red', 0x123456)).toBe(0x123456)
  })
})

// P4 — fonts installed on this computer (Local Font Access): the list is filtered to names that
// are safe inside CSS local("…") and that schema.ts accepts; denial is reported, not thrown.
import { afterEach, describe, expect, it } from 'vitest'
import { localFonts, localFontsSupported, toLocalFonts } from '../../../src/ui/fonts/local-fonts.svelte'

const font = (postscriptName: string, fullName = postscriptName) => ({ family: 'F', fullName, postscriptName, style: 'Regular' })
const g = globalThis as unknown as { queryLocalFonts?: unknown }

afterEach(() => {
  delete g.queryLocalFonts
})

describe('local fonts', () => {
  it('keeps safe, unique PostScript names, sorted by display name', () => {
    const list = toLocalFonts([
      font('Zeta-Bold', 'Zeta Bold'),
      font('Alpha-Regular', 'Alpha'),
      font('Alpha-Regular', 'Alpha duplicate'),
      font('Bad"Quote'),
      font("Bad'Quote"),
      font('Back\\slash'),
      font('Ünicode'),
      font(''),
      font('NoFullName', ''),
      font('Long', 'x'.repeat(300)),
    ])
    expect(list.map((f) => f.postscriptName)).toEqual(['Alpha-Regular', 'NoFullName', 'Long', 'Zeta-Bold'])
    expect(list[0]?.name).toBe('Alpha')
    expect(list[1]?.name).toBe('NoFullName')
    expect(list[2]?.name).toHaveLength(100)
  })

  it('is only offered where the browser has the API', () => {
    expect(localFontsSupported()).toBe(false)
    g.queryLocalFonts = async () => []
    expect(localFontsSupported()).toBe(true)
  })

  it('lists on request and reports a denied permission', async () => {
    g.queryLocalFonts = async () => [font('Inter-Regular', 'Inter')]
    await localFonts.query()
    expect(localFonts.status).toBe('ready')
    expect(localFonts.fonts).toEqual([{ postscriptName: 'Inter-Regular', name: 'Inter' }])
    g.queryLocalFonts = async () => {
      throw new DOMException('no', 'NotAllowedError')
    }
    await localFonts.query()
    expect(localFonts.status).toBe('denied')
    expect(localFonts.error).toMatch(/not allowed/)
  })
})

// The icon catalogue is lazy (render/icon-set.ts): it stays out of the initial JS, loads once, and
// only the lazy icon editor imports it statically.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadIcons, loadedIcons } from '../../../src/render/icon-set'

const SRC = fileURLToPath(new URL('../../../src', import.meta.url))

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (n === 'pkg') return []
    return statSync(p).isDirectory() ? files(p) : /\.(ts|svelte)$/.test(n) ? [p] : []
  })
}

describe('lazy icon catalogue', () => {
  it('loads once; concurrent calls share the load', async () => {
    expect(loadedIcons()).toBeUndefined()
    const [a, b] = await Promise.all([loadIcons(), loadIcons()])
    expect(a).toBe(b)
    expect(loadedIcons()).toBe(a)
    expect(await loadIcons()).toBe(a)
    expect(a.iconById('question')?.label).toBe('Question')
  })

  it('only the lazy icon editor imports render/icons for values', () => {
    const value = /import\s+(?!type\b)[^'"]*from\s+['"][./]*(?:render\/)?icons['"]|export\s+(?!type\b)[^'"]*from\s+['"]\.\/icons['"]/
    const users = files(SRC)
      .filter((f) => value.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))
    expect(users).toEqual(['ui/editor/props/IconProps.svelte'])
  })
})

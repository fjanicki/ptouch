// Shared (frozen) — enforces the layering rule from ARCHITECTURE.md §4 without ESLint:
//   doc → nothing (persist* may use idb-keyval) · wasm → ./pkg only · printer → wasm
//   render → wasm, doc · ui/App/pwa → anything. printer never imports render and vice versa.
// Static, dynamic (`import('x')`) and side-effect (`import 'x'`) imports are all checked, and
// no layer outside the wasm bindings may hold protocol magic bytes (framing, ESC sequences):
// "one protocol implementation" — the Rust core (ARCHITECTURE.md §1).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (n === 'pkg') return []
    return statSync(p).isDirectory() ? files(p) : /\.(ts|svelte)$/.test(n) ? [p] : []
  })
}

const ALLOWED: Record<string, RegExp> = {
  doc: /^(\.\/|idb-keyval$)/,
  wasm: /^\.\/pkg\//,
  printer: /^(\.\/|\.\.\/wasm(\/index)?$)/,
  render: /^(\.\/|\.\.\/wasm(\/index)?$|\.\.\/doc\/(schema|ops|history)$)/,
}

/** Every module specifier: `import … from`, `export … from`, `import 'x'`, `import('x')`. */
function importSpecs(src: string): string[] {
  const out: string[] = []
  for (const re of [/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g, /^\s*import\s+['"]([^'"]+)['"]/gm, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const m of src.matchAll(re)) out.push(m[1] ?? '')
  }
  return out
}

/** Protocol bytes that belong to the core: ESC (0x1b), the status header (0x80 0x20 …). */
const MAGIC = /\b0x1[bB]\b|\b0x80\b|\\x1[bB]|\\u001[bB]/

describe('import scanner', () => {
  it('finds static, side-effect and dynamic imports', () => {
    expect(importSpecs(`import a from './a'\nimport './b.css'\nconst c = await import('../c')\nexport { d } from "./d"`)).toEqual(['./a', './d', './b.css', '../c'])
  })
})

describe('no protocol magic bytes outside the core bindings', () => {
  for (const file of files(SRC)) {
    const rel = relative(SRC, file)
    if (rel.startsWith('wasm/')) continue
    it(`${rel} has no protocol byte literals`, () => {
      const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      expect(MAGIC.test(src), `${rel} contains protocol bytes; ask the wasm core instead`).toBe(false)
    })
  }
})

describe('layering', () => {
  for (const file of files(SRC)) {
    const rel = relative(SRC, file)
    const layer = rel.split('/')[0] ?? ''
    const rule = ALLOWED[layer]
    if (!rule) continue
    it(`${rel} respects the ${layer} layer`, () => {
      const src = readFileSync(file, 'utf8')
      const specs = importSpecs(src)
      const bad = specs.filter((s) => !rule.test(s))
      expect(bad, `${rel} imports ${bad.join(', ')}`).toEqual([])
    })
  }
})

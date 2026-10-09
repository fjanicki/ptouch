// JS the browser loads before the studio can start: the entry module plus every chunk
// index.html preloads (Rolldown may move shared code out of the entry chunk into a preloaded
// chunk once some components are lazy, so measuring `assets/index-*.js` alone undercounts).
// Usage: node scripts/entry-size.mjs [dist] [budget-bytes]; exits 1 over budget.
// gzip level 9, as `gzip -9`. Run by .github/workflows/web.yml after the build; pages.yml does
// not run it, but it deploys only after that CI run has passed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const dist = process.argv[2] ?? 'dist'
const budget = Number(process.argv[3] ?? 122880)
const html = readFileSync(join(dist, 'index.html'), 'utf8')
const files = [...html.matchAll(/<(?:script type="module"[^>]*\ssrc|link rel="modulepreload"[^>]*\shref)="([^"]+\.js)"/g)].map((m) => (m[1] ?? '').replace(/^.*?assets\//, 'assets/'))
if (!files.length) {
  console.error('no entry script found in index.html')
  process.exit(1)
}
let total = 0
for (const f of files) {
  const n = gzipSync(readFileSync(join(dist, f)), { level: 9 }).length
  total += n
  console.log(`${String(n).padStart(8)}  ${f}`)
}
console.log(`${String(total).padStart(8)}  initial JS, gzipped (budget ${budget})`)
if (total > budget) process.exit(1)

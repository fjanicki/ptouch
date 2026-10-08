// Builds the wasm package (src/wasm/pkg, gitignored) if it is missing, so `npm run dev`,
// `npm run check` and `npm run build` work on a fresh clone. CI runs `npm run wasm` explicitly.
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const pkg = new URL('../src/wasm/pkg/ptouch.js', import.meta.url)
if (!existsSync(pkg)) {
  console.log('[ensure-wasm] src/wasm/pkg missing → npm run wasm (needs wasm-pack 0.15.0)')
  execSync('npm run wasm', { stdio: 'inherit', cwd: new URL('..', import.meta.url) })
}

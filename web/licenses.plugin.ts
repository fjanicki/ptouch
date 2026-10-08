// Publishes web/THIRD_PARTY.md as `licenses/THIRD_PARTY.md` next to the licence texts in
// public/licenses/, so the deployed site carries the notices its bundled code requires
// (minification drops source-comment licence headers). Single source: THIRD_PARTY.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const SOURCE = fileURLToPath(new URL('./THIRD_PARTY.md', import.meta.url))

export function thirdPartyNotices(): Plugin {
  return {
    name: 'ptouch-third-party-notices',
    // Dev server: serve the same file.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.endsWith('/licenses/THIRD_PARTY.md')) return next()
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
        res.end(readFileSync(SOURCE, 'utf8'))
      })
    },
    generateBundle() {
      this.addWatchFile(SOURCE)
      this.emitFile({ type: 'asset', fileName: 'licenses/THIRD_PARTY.md', source: readFileSync(SOURCE, 'utf8') })
    },
  }
}

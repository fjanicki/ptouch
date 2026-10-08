/// <reference types="vitest/config" />
// Shared file (frozen; see docs/WEB-IMPLEMENTATION-PLAN.md §1). PWA options live in
// pwa.config.ts (W5) so this file never needs per-package edits.
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'
import { playwright } from '@vitest/browser-playwright'
import { pwaOptions } from './pwa.config.ts'
import { thirdPartyNotices } from './licenses.plugin.ts'

// GitHub project pages live at https://<user>.github.io/<repo>/ → base must be '/<repo>/'.
// CI sets BASE_PATH from actions/configure-pages' `base_path` (e.g. "/ptouch"); dev uses '/'.
const base = process.env.BASE_PATH ? `${process.env.BASE_PATH.replace(/\/$/, '')}/` : '/'

export default defineConfig({
  base,
  plugins: [svelte(), VitePWA(pwaOptions), thirdPartyNotices()],
  build: { target: 'es2022', sourcemap: true },
  // The wasm-pack glue loads `new URL('ptouch_bg.wasm', import.meta.url)`; Vite rewrites it to a
  // hashed asset under `base`. No Vite wasm plugin is needed (ARCHITECTURE.md §2).
  server: { fs: { allow: ['..'] } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            // Local: PW_CHANNEL=chrome uses the installed Google Chrome (no download).
            // CI: `npx playwright install --with-deps chromium` first.
            provider: playwright({
              launchOptions: process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {},
            }),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})

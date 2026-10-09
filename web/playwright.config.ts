// e2e against the production build served under the Pages base path (ARCHITECTURE.md §8.4).
// PW_WEBKIT=1 (CI) adds a WebKit project for the iPhone spec: every iOS browser is WebKit, so
// Safari's own <dialog>, FontFace, CompressionStream and share behaviour is exercised there.
import { defineConfig, devices } from '@playwright/test'

const PORT = 4317

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/ptouch/`,
    trace: 'retain-on-failure',
  },
  projects: [
    // Local: installed Google Chrome (no download). CI: PW_CHANNEL=chromium.
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL ?? 'chrome' } },
    // Unsupported-browser screen (no navigator.serial / navigator.usb) is tested in chromium
    // with the APIs deleted by an init script (e2e/fixtures/serial-stub.ts).
    ...(process.env.PW_WEBKIT ? [{ name: 'webkit', testMatch: /iphone\.spec\.ts$/, use: { ...devices['iPhone 13'] } }] : []),
  ],
  webServer: {
    command: `BASE_PATH=/ptouch npx vite build && npx vite preview --port ${PORT} --strictPort --base /ptouch/`,
    url: `http://localhost:${PORT}/ptouch/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})

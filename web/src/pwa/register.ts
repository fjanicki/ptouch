// W5 — service worker registration (vite-plugin-pwa generateSW, registerType 'prompt').
// A new version is applied only on user request and never while a print is running: swapping
// the wasm/JS under a live session would abort the job mid-stream. Checks for updates hourly
// while the tab is visible (Pages deploys are infrequent; the browser also checks on navigation).
import { registerSW } from 'virtual:pwa-register'
import { cacheLibraryFonts } from './font-cache'

export interface UpdateState {
  /** A new version is installed and waiting. */
  needRefresh: boolean
  /** The app shell, wasm and fonts are cached: the studio works offline. */
  offlineReady: boolean
}

type Listener = (s: UpdateState) => void
const listeners = new Set<Listener>()
let state: UpdateState = { needRefresh: false, offlineReady: false }
let update: ((reload?: boolean) => Promise<void>) | undefined
let registered = false

const UPDATE_CHECK_MS = 60 * 60 * 1000

function emit(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  for (const fn of listeners) fn(state)
}

export function registerServiceWorker(): void {
  if (registered || typeof navigator === 'undefined' || !('serviceWorker' in navigator) || import.meta.env.DEV) return
  registered = true
  update = registerSW({
    immediate: true,
    onNeedRefresh: () => emit({ needRefresh: true }),
    onOfflineReady: () => emit({ offlineReady: true }),
    onRegisteredSW: (_url, reg) => {
      if (!reg) return
      setInterval(() => {
        if (document.visibilityState === 'visible' && navigator.onLine && !reg.installing) void reg.update().catch(() => {})
      }, UPDATE_CHECK_MS)
    },
    onRegisterError: (e: unknown) => console.warn('service worker registration failed', e),
  })
  // Library fonts used before the worker controls this page (first visit) go into its cache too.
  cacheLibraryFonts()
}

export function onUpdateState(fn: Listener): () => void {
  listeners.add(fn)
  fn(state)
  return () => listeners.delete(fn)
}

export function dismissOfflineReady(): void {
  emit({ offlineReady: false })
}

/**
 * Reload into the new version. Refuses (resolves `false`) while `busy` (a print is running);
 * the toast retries once the print has finished.
 */
export async function applyUpdate(busy = false): Promise<boolean> {
  if (busy || !update) return false
  await update(true)
  return true
}

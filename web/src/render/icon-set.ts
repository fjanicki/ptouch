// Lazy access to the icon catalogue (icons.ts, about 8 KB gzipped). It loads the first time a
// label with an icon is rendered or an icon editor opens, so it stays out of the initial JS; the
// service worker precaches its chunk, so icons still work offline.
import type * as Icons from './icons'

export type IconSet = typeof Icons

let set: IconSet | undefined
let pending: Promise<IconSet> | undefined

/** Loads the catalogue once per page; concurrent calls share the request, a failure is retried. */
export function loadIcons(): Promise<IconSet> {
  if (set) return Promise.resolve(set)
  pending ??= import('./icons').then(
    (m) => (set = m),
    (e: unknown) => {
      pending = undefined
      throw e
    },
  )
  return pending
}

/** The catalogue if it has loaded, without a request. */
export function loadedIcons(): IconSet | undefined {
  return set
}

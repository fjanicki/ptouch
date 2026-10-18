// Lazy access to the icon catalogue (icons.ts, about 8 KB gzipped). It loads the first time a
// label with an icon is rendered or an icon editor opens, so it stays out of the initial JS; the
// service worker precaches its chunk, so icons still work offline.
import type * as Icons from './icons'
import { lazyModule } from './lazy'

export type IconSet = typeof Icons

/** `loadIcons()` loads the catalogue once per page (concurrent calls share the request, a failure
 * is retried); `loadedIcons()` is the catalogue if it has loaded, without a request. */
export const [loadIcons, loadedIcons] = lazyModule<IconSet>(() => import('./icons'))

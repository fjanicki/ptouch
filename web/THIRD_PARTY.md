# Third-party components shipped in the web studio

Everything bundled into `web/dist` (the GitHub Pages site) is permissively licensed (MIT,
Apache-2.0, BSD, ISC, OFL-1.1, Unicode-3.0). Dev-only tooling (Vite, Vitest, Playwright,
svelte-check, TypeScript, wasm-pack, fontTools) is not shipped and is not listed. Owner: W5
(keeps this file current); every change that adds a bundled asset or runtime dependency adds
a row here in the same change.

**Published notices.** The deployed site carries every notice these licences require at
[`/ptouch/licenses/`](public/licenses/index.html): this file (emitted by `licenses.plugin.ts`),
`MIT.txt`, `ISC-Lucide.txt`, `Apache-2.0.txt` (idb-keyval's notice plus the full licence text),
`rust-crates.txt` (each crate's notice, from its published crate), and the OFL texts in
`fonts/`. Diagnostics links to it; pages.yml fails the deploy if any of them is missing. Update
those files together with the tables below.

The site makes no network requests after it has loaded (CSP `connect-src 'self'`): no CDN, no
analytics, no web fonts from third-party hosts.

## JavaScript (runtime, bundled into `assets/index-*.js` / `sw.js`)

| Package | Version | License | Use |
|---|---|---|---|
| [svelte](https://github.com/sveltejs/svelte) | 5.57.2 | MIT | UI runtime |
| [idb-keyval](https://github.com/jakearchibald/idb-keyval) | 6.3.0 | Apache-2.0 | IndexedDB label library (`src/doc/persist.ts`) |
| [workbox-window](https://github.com/GoogleChrome/workbox) (via vite-plugin-pwa 2.0.0) | 7.4.1 | MIT | service-worker registration and update prompt |
| workbox-core, workbox-precaching, workbox-routing (generated `sw.js`) | 7.4.1 | MIT | offline precache of the app shell, wasm, fonts and icons |

## Rust crates compiled into `ptouch_bg.wasm`

From `cargo tree -p ptouch-wasm --target wasm32-unknown-unknown -e normal`.

| Crate | Version | License |
|---|---|---|
| ptouch, ptouch-wasm (this repository) | 0.1.0 | MIT OR Apache-2.0 |
| wasm-bindgen, wasm-bindgen-shared | 0.2.129 | MIT OR Apache-2.0 |
| js-sys | 0.3.106 | MIT OR Apache-2.0 |
| tsify | 0.5.8 | MIT OR Apache-2.0 |
| serde, serde_core | 1.0.229 | MIT OR Apache-2.0 |
| serde-wasm-bindgen | 0.6.5 | MIT |
| fast_qr | 0.14.0 | MIT |
| barcoders | 2.0.0 | MIT OR Apache-2.0 |
| once_cell | 1.21.4 | MIT OR Apache-2.0 |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 |
| bumpalo | 3.20.3 | MIT OR Apache-2.0 |
| futures-core, futures-task, futures-util | 0.3.34 | MIT OR Apache-2.0 |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT |
| slab | 0.4.12 | MIT |

Build-time only (procedural macros, not part of the binary): wasm-bindgen-macro(-support)
0.2.129, tsify-macros 0.5.8, serde_derive 1.0.229, serde_derive_internals 0.29.1, syn 2.0.119 /
3.0.6, quote 1.0.47, proc-macro2 1.0.107 (all MIT OR Apache-2.0), unicode-ident 1.0.26
((MIT OR Apache-2.0) AND Unicode-3.0).

## Fonts (`public/fonts/`)

Self-hosted, Latin subsets in woff2. Upstream URLs, versions and SHA-256 sums of every file are
in [`public/fonts/SOURCES.md`](public/fonts/SOURCES.md); each family's licence text ships next
to its files.

| Family | Files | License | Source |
|---|---|---|---|
| Fira Sans | Regular, Medium, SemiBold, Bold, ExtraBold | OFL-1.1 (`OFL-FiraSans.txt`) | https://github.com/bBoxType/FiraSans (4.301) |
| Archivo Narrow | Regular, Medium, SemiBold, Bold | OFL-1.1 (`OFL-ArchivoNarrow.txt`) | https://github.com/Omnibus-Type/ArchivoNarrow |
| JetBrains Mono | Regular, Bold | OFL-1.1 (`OFL-JetBrainsMono.txt`) | https://github.com/JetBrains/JetBrainsMono (v2.304) |
| Atkinson Hyperlegible | Regular, Bold | OFL-1.1 (`OFL-AtkinsonHyperlegible.txt`) | https://github.com/googlefonts/atkinson-hyperlegible |

## Icons and images

| Asset | License | Use |
|---|---|---|
| Lucide 1.52.0 (subset, path data inlined) | ISC | UI icons (`src/ui/common/Icon.svelte`) and label icons (`src/render/icons.ts`) |
| Feather (via Lucide: arrow-*, calendar, check, clock, corner-down-right, info, key, lock, minus, monitor, move, music, plus, power, server, x) | MIT, Copyright (c) 2013-present Cole Bemis | shapes Lucide derives from Feather |
| App icons and favicon (`public/favicon.svg`, `public/icons/*`) | MIT OR Apache-2.0 (this repository) | original artwork; PNGs rendered from `icons/icon.svg` / `icons/icon-maskable.svg` |

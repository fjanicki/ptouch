# Third-party components shipped in the web studio

Everything bundled into `web/dist` (the GitHub Pages site) is permissively licensed (MIT,
Apache-2.0, BSD, ISC, OFL-1.1, Unicode-3.0). Dev-only tooling (Vite, Vitest, Playwright,
svelte-check, TypeScript, wasm-pack, fontTools) is not shipped and is not listed. Owner: W5
(keeps this file current); every change that adds a bundled asset or runtime dependency adds
a row here in the same change.

**Published notices.** The deployed site carries every notice these licences require at
[`/ptouch/licenses/`](public/licenses/index.html): this file (emitted by `licenses.plugin.ts`),
`MIT.txt`, `ISC-Lucide.txt`, `Apache-2.0.txt` (idb-keyval's notice plus the full licence text),
`rust-crates.txt` (each crate's notice, from its published crate), and the font licence texts
(OFL, Apache-2.0) in `fonts/`. Diagnostics links to it; pages.yml fails the deploy if any of them is missing. Update
those files together with the tables below.

The site only ever talks to itself (CSP `connect-src 'self'`, `font-src 'self'`): no CDN, no
analytics, no web fonts from third-party hosts. Library fonts and some editor parts are fetched
from the site the first time they are used, then served offline by the service worker.

## JavaScript (runtime, bundled into `assets/index-*.js` / `sw.js`)

| Package | Version | License | Use |
|---|---|---|---|
| [svelte](https://github.com/sveltejs/svelte) | 5.57.2 | MIT | UI runtime |
| [idb-keyval](https://github.com/jakearchibald/idb-keyval) | 6.3.0 | Apache-2.0 | IndexedDB label library (`src/doc/persist.ts`) |
| [workbox-window](https://github.com/GoogleChrome/workbox) (via vite-plugin-pwa 2.0.0) | 7.4.1 | MIT | service-worker registration and update prompt |
| workbox-core, workbox-precaching, workbox-routing, workbox-strategies, workbox-expiration, workbox-cacheable-response (generated `sw.js`) | 7.4.1 | MIT | offline precache of the app shell, wasm, core fonts and icons; runtime cache of the font library |

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
| datamatrix | 0.3.3 | Apache-2.0 OR MIT |
| arrayvec (via datamatrix) | 0.7.8 | MIT OR Apache-2.0 |
| flagset (via datamatrix) | 0.4.7 | Apache-2.0 |
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

Self-hosted, Latin subsets in woff2 (Fira Sans and Quicksand, which reserve their names: the
complete, unmodified upstream fonts). Upstream URLs,
commits and SHA-256 sums of every file, the Reserved Font Name findings and the processing are in
[`public/fonts/SOURCES.md`](public/fonts/SOURCES.md); each family's licence text (OFL or Apache)
ships next to its files and is linked from the licences page. The core families are precached;
the library families load on first use, from this site only.

| Family | Files | License | Source |
|---|---|---|---|
| Fira Sans | Regular, Medium, SemiBold, Bold, ExtraBold (unmodified upstream WOFF2) | OFL-1.1 (`OFL-FiraSans.txt`) | https://github.com/bBoxType/FiraSans (4.301) |
| Archivo Narrow | Regular, Medium, SemiBold, Bold | OFL-1.1 (`OFL-ArchivoNarrow.txt`) | https://github.com/Omnibus-Type/ArchivoNarrow |
| JetBrains Mono | Regular, Bold | OFL-1.1 (`OFL-JetBrainsMono.txt`) | https://github.com/JetBrains/JetBrainsMono (v2.304) |
| Atkinson Hyperlegible | Regular, Bold | OFL-1.1 (`OFL-AtkinsonHyperlegible.txt`) | https://github.com/googlefonts/atkinson-hyperlegible |

Font library, all from https://github.com/google/fonts at commit `f2bd09b` (designer repository
in parentheses):

| Family | Files | License | Source |
|---|---|---|---|
| Oswald | Regular, Bold | OFL-1.1 (`OFL-Oswald.txt`) | `ofl/oswald` (googlefonts/OswaldFont) |
| Bebas Neue | Regular | OFL-1.1 (`OFL-BebasNeue.txt`) | `ofl/bebasneue` (dharmatype/Bebas-Neue) |
| Barlow Condensed | Medium, Bold | OFL-1.1 (`OFL-BarlowCondensed.txt`) | `ofl/barlowcondensed` (jpt/barlow) |
| Anton | Regular | OFL-1.1 (`OFL-Anton.txt`) | `ofl/anton` (googlefonts/AntonFont) |
| Barlow | Regular, SemiBold | OFL-1.1 (`OFL-Barlow.txt`) | `ofl/barlow` (jpt/barlow) |
| B612 | Regular, Bold | OFL-1.1 (`OFL-B612.txt`) | `ofl/b612` (polarsys/b612) |
| Nunito | Regular, Bold | OFL-1.1 (`OFL-Nunito.txt`) | `ofl/nunito` (googlefonts/nunito) |
| Fredoka | Regular, SemiBold | OFL-1.1 (`OFL-Fredoka.txt`) | `ofl/fredoka` (hafontia/Fredoka-One) |
| Quicksand | Variable (unmodified) | OFL-1.1, Reserved Font Name "Quicksand" (`OFL-Quicksand.txt`) | `ofl/quicksand` (andrew-paglinawan/QuicksandFamily) |
| Caveat | Regular, Bold | OFL-1.1 (`OFL-Caveat.txt`) | `ofl/caveat` (googlefonts/caveat) |
| Permanent Marker | Regular | Apache-2.0 (`Apache-PermanentMarker.txt`), © 2010 Font Diner, Inc. | `apache/permanentmarker` |
| Pacifico | Regular | OFL-1.1 (`OFL-Pacifico.txt`) | `ofl/pacifico` (googlefonts/Pacifico) |
| Big Shoulders Stencil | Regular, Bold | OFL-1.1 (`OFL-BigShouldersStencil.txt`) | `ofl/bigshouldersstencil` (xotypeco/big_shoulders) |
| Saira Stencil One | Regular | OFL-1.1 (`OFL-SairaStencilOne.txt`) | `ofl/sairastencilone` (Omnibus-Type/Saira) |
| Special Elite | Regular | Apache-2.0 (`Apache-SpecialElite.txt`), © 2010 Brian J. Bonislawsky DBA Astigmatic (AOETI) | `apache/specialelite` |
| Courier Prime | Regular, Bold | OFL-1.1 (`OFL-CourierPrime.txt`) | `ofl/courierprime` (quoteunquoteapps/CourierPrime) |
| Roboto Slab | Regular, Bold | Apache-2.0 (`Apache-RobotoSlab.txt`), © 2018 The Roboto Slab Project Authors | `apache/robotoslab` (googlefonts/robotoslab) |
| Silkscreen | Regular, Bold | OFL-1.1 (`OFL-Silkscreen.txt`) | `ofl/silkscreen` (googlefonts/silkscreen) |
| VT323 | Regular | OFL-1.1 (`OFL-VT323.txt`) | `ofl/vt323` |
| Pixelify Sans | Regular, Bold | OFL-1.1 (`OFL-PixelifySans.txt`) | `ofl/pixelifysans` (eifetx/Pixelify-Sans) |
| Lexend | Regular, Bold | OFL-1.1 (`OFL-Lexend.txt`) | `ofl/lexend` (googlefonts/lexend) |

## Icons and images

| Asset | License | Use |
|---|---|---|
| Lucide 1.52.0 (subset, path data inlined) | ISC | UI icons (`src/ui/common/Icon.svelte`) and label icons (`src/render/icons.ts`) |
| Feather (via Lucide: arrow-*, calendar, check, clock, corner-down-right, info, key, lock, minus, monitor, move, music, plus, power, server, x) | MIT, Copyright (c) 2013-present Cole Bemis | shapes Lucide derives from Feather |
| App icons and favicon (`public/favicon.svg`, `public/icons/*`) | MIT OR Apache-2.0 (this repository) | original artwork; PNGs rendered from `icons/icon.svg` / `icons/icon-maskable.svg` |

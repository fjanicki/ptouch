# ptouch — Implementation plan (web print studio)

Status: skeleton in place, 2026-10-08. Goal: a polished, install-free print studio at
**https://fjanicki.github.io/ptouch/** (Vite `base` = `/ptouch/`). It prints to a paired PT-P710BT
from Chrome/Edge over Web Serial. The library stays strictly separate from the UI: all protocol
logic is in the Rust core and reaches the browser through `ptouch-wasm`. The web app only does
I/O, editing and rendering.

Five work packages (W1–W5) can run **in parallel**. Each owns a disjoint set of files. Every
shared interface already exists as compiling code, so packages fill in bodies and add tests.

Normative references: `docs/ARCHITECTURE.md` (§3 browser support/connect flow, §4.2 wasm API,
§4.3 TS transports, §5 data flow, §6 editor, §7 persistence, §8 tests, §9 CI/CD, §10 versions),
`docs/PROTOCOL.md` (§2.6 Web Serial, §6.3 P710BT, §6.8 status handshake),
`docs/HARDWARE-TESTS.md`.

---

## 0. What the skeleton already does (verified 2026-10-08)

| Check | Result |
|---|---|
| `cargo clippy --workspace --all-targets -- -D warnings` | passes (ptouch-wasm added to the workspace) |
| `cargo clippy -p ptouch-wasm --all-targets --target wasm32-unknown-unknown -- -D warnings` | passes |
| `cd web && npm run wasm` (= `wasm-pack build ../crates/ptouch-wasm --target web --release --out-dir ../../web/src/wasm/pkg --out-name ptouch`) | builds; 108.7 KB wasm / 47.3 KB gzip with stubs (budget ≤ 150 KB gzip) |
| `npm run check` (svelte-check, `--fail-on-warnings`) | 0 errors, 0 warnings |
| `npm test` (Vitest `unit` project, node) | 40 passed, 16 todo; real wasm loaded in node via `initSync` |
| `PW_CHANNEL=chrome npx vitest run --project browser` | passes (wasm loaded via `fetch` in Chromium) |
| `BASE_PATH=/ptouch npm run build` | builds `dist/` with `sw.js`, manifest, hashed wasm under `/ptouch/assets/` |
| `npm run e2e` (Playwright, build + `vite preview --base /ptouch/`, CSP active) | 3 passed: shell renders + wasm loads, unsupported screen, `#diagnostics` |
| `npm run dev` | serves the shell (top bar, INSERT, preview, PROPERTIES, print bar), no console errors |
| `actionlint 1.7.12 .github/workflows/pages.yml` | clean |

The skeleton did **not** change `crates/ptouch`. The bindings convert types only. No new core
API was needed.

Toolchain (ARCHITECTURE §10, prototype-verified): rustc 1.97.1, wasm-pack 0.15.0,
wasm-bindgen =0.2.129, js-sys =0.3.106, tsify =0.5.8 (`js`), serde-wasm-bindgen =0.6.5,
wasm-bindgen-test =0.3.79, fast_qr =0.14.0, barcoders =2.0.0; Node 24.18.0 / npm 11.16.0,
vite 8.3.4, svelte 5.57.2, @sveltejs/vite-plugin-svelte 7.3.1, typescript 6.0.3,
svelte-check 4.7.6, @tsconfig/svelte 5.0.8, vite-plugin-pwa 2.0.0, idb-keyval 6.3.0,
vitest + @vitest/browser-playwright 5.0.3, @playwright/test 1.64.0, @types/w3c-web-serial
1.0.8, @types/w3c-web-usb 1.0.14, @types/node 24.19.0. All are pinned exactly.

## 1. Rules for every work package

1. **Edit only the files you own** (§3). You may create new files inside your owned
   directories/patterns. If you need a change in a file you don't own, don't edit it. Report the
   exact change in your final message and the integrator will apply it.
2. **Shared files are frozen** (owned by nobody): root `Cargo.toml`, `Cargo.lock`,
   `web/package.json`, `web/package-lock.json`, `web/vite.config.ts`, `web/tsconfig.json`,
   `web/svelte.config.js`, `web/playwright.config.ts`, `web/index.html` (CSP!),
   `web/src/main.ts`, `web/scripts/ensure-wasm.mjs`, `web/.gitignore`,
   `web/tests/unit/layering.test.ts`. **No new npm or cargo dependencies without the
   integrator.** Bundled code must be MIT/Apache/BSD/ISC/OFL. Request additions with
   name, version, licence and reason.
3. **Frozen interfaces** (§2) may only grow **additively** (new optional fields, new
   functions). Renames, removals and changed semantics must go through the integrator.
4. **Layering** (enforced by `tests/unit/layering.test.ts`): `doc/*` imports nothing
   (`persist*` may import `idb-keyval`). `wasm/*` imports only `./pkg`. `printer/*` imports only
   `../wasm` and itself. `render/*` imports only `../wasm`, `../doc/{schema,ops,history}` and
   itself. `ui/*`, `App.svelte` and `pwa/*` may import anything. `printer` never imports
   `render`, and `render` never imports `printer`. Only `src/wasm/index.ts` imports `src/wasm/pkg`.
5. **Core rules:** do not change `crates/ptouch` semantics. If a binding truly needs a small
   **additive** core API, document it in the PR and in `crates/ptouch-wasm/src/lib.rs`
   ("Deviations"), and tell the integrator.
6. **Privacy:** never write a real Bluetooth address or device-name suffix anywhere (code,
   tests, fixtures, docs, logs you paste). Use `PT-P710BTxxxx` and `XX:XX:XX:XX:XX:XX`.
7. **No hardware.** Do not access the real printer. Test against the wasm `VirtualPrinter`
   (MockTransport) and fixtures. **Do not commit or push.**
8. **Product quality:** keyboard operable, visible focus, labelled controls (`aria-*`),
   WCAG AA contrast in light **and** dark (`styles/tokens.css`), `prefers-reduced-motion`,
   layout works at 360 px width. No network calls after load (CSP `connect-src 'self'`).
9. **Definition of done (all packages):** no `TODO(Wn)` left in owned files, and all of
   these pass:
   ```sh
   cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
   cargo clippy -p ptouch-wasm --all-targets --target wasm32-unknown-unknown -- -D warnings
   cd web && npm run wasm && npm run check && npm test
   PW_CHANNEL=chrome npx vitest run --project browser   # CI uses chromium
   npm run e2e && BASE_PATH=/ptouch npm run build
   ```

## 2. Interfaces between packages (frozen contracts)

### 2.1 wasm API (W1 → W2, W3, W5) — `src/wasm/index.ts` re-exports `src/wasm/pkg/ptouch.js`

Generated TS (`ptouch.d.ts`) from `crates/ptouch-wasm`. Every function and class exists now.
**Stubbed** items throw `PtouchError{code:"UNSUPPORTED"}` (or return empty) until W1 lands
them. Items marked ✓ already work.

| Export | Shape | Notes |
|---|---|---|
| `loadWasm(): Promise<void>` ✓, `isWasmLoaded()` ✓ | `src/wasm/index.ts` | call once at boot. Every other export needs it |
| `version()` ✓, `statusRequest()` ✓, `genericHandshake()` ✓ | | `00×200 1B 40 1B 69 61 01`, then `1B 69 53` |
| `isPtouchError(e): e is PtouchError` ✓ | `{name:"PtouchError", code: PtouchErrorCode}` | 21 codes = `ptouch::Error::code()` |
| `listModels(): ModelInfo[]` | name, codes, usbPid?, dpi, headPins, bluetooth, caps, media[] | |
| `printArea(model, mediaId): PrintArea` | dpi, heightDots, tapeWidthDots, margins, minLengthDots, maxLengthDots?, defaultFeedDots, maxFeedDots | renderer geometry |
| `mediaForWidth(model, widthMm, kind?)`, `mediaForStatus(model, widthByte, typeByte)` → `MediaInfo` | id, kind, widthMm, widthByte, printPins… | offline design / from status |
| `parseStatus(bytes): PrinterStatus` | modelName?, ready, error, errors[{id,message}], mediaWidthMm, mediaType, mediaId?, statusType, phase, notification, tapeColor/textColor {name,css}, battery, raw | |
| `encodeCode(spec: CodeSpec): ModuleMatrix` | `{symbology:"qr",data,ecc?}` / `"code128"` / `"ean13"` → `{width,height,modules}` | implemented in ptouch-wasm (fast_qr/barcoders) |
| `new Raster(length, height)` ✓ `.blitCrisp` ✓ `.blitBitmap` ✓ `.finish()` ✓ `.blitTone(rgba,w,h,x,y,ToneOptions?)` `.blitCode(m,x,y,moduleDots,quietZone)` | | crisp plane at 3×; codes never via canvas |
| `Bitmap1` ✓ `.length .height .get .isBlank .trimBlank .toRgba(tapeRgb,inkRgb) .toPacked .toPbm .clone() Bitmap1.fromPacked` | | the exact printed dots |
| `encodeJob(model, mediaId, pages: Bitmap1[], JobOptions?): Job` | **consumes** pages (pass `.clone()`) | `prepare_pages` + `encode_job` |
| `Job` ✓ `.toBytes() .pageCount .pageLines() .totalLines .mediaWidthByte` | | |
| `decodeJob(model, bytes): DecodedJob` `.pages() .violations() .commands()` | | diagnostics |
| `new PrintSession(model?, SessionConfig?)` `.connect ✓ .requestStatus .submit(job,now) .cancel ✓ .handleInput ✓ .handleTimeout ✓ .pollTransmit ✓ .pollEvent .pollTimeout ✓ .state() .lastStatus() .modelName ✓` | events: `SessionEvent` union (`status`/`ready`/`page-started`/`page-completed`/`job-completed`/`notification`/`failed{error{code,message,printerErrors},resumeFromPage?}`) | times are `performance.now()` ms |
| `new VirtualPrinter(model, mediaId, VirtualBehaviour?, VirtualTiming?)` `.handleInput ✓ .pollOutput(now) ✓ .nextOutputAt ✓ .printedCount ✓ .printedPage(i) ✓ .violations ✓ .idleStatus ✓` | behaviours: normal, silent, no-push, cover-open-on-page, wrong-media, extra-frames, cooling-on-page, no-media | constructor stubbed |

These deviations from ARCHITECTURE §4.2 come from the core API and are documented in `lib.rs`:
- media are addressed by id, not by width;
- `submit` takes no width argument and borrows the job;
- `blitCode` takes `quietZone`;
- codes are encoded in ptouch-wasm, not in a core `codes` feature;
- the core has 21 error codes.

Class handles own wasm memory, so call `.free()` when a handle is replaced (e.g. the previous
`RenderResult.bitmap`).

### 2.2 Printer layer (W2 → W4, W5) — `src/printer/index.ts`

- `transport.ts` (frozen):
  - `Transport { info, isOpen, open({signal,onProgress}), write(bytes,signal), abortWrites(), close(), subscribe(listener) }`;
  - `TransportEvent` = `data` | `lost`; `TransportInfo.kind` = `serial-rfcomm` | `serial-os-port` | `usb` | `virtual`;
  - `OpenProgress {attempt, of, lastError}`;
  - `WRITE_TUNING` (serial 960 B, usb 16 KiB, unreliable 320 B/10 ms; RFCOMM MTU is 320);
  - `Clock` / `realClock`.
- `support.ts`: `detectSupport(nav?) → SupportInfo {engine, platform, serial, usb, bluetoothFilter, brave, canPrint, paths: ConnectPath[]}`, where `ConnectPath` = `bluetooth` | `serial-port` | `usb` | `virtual`.
- `problems.ts`:
  - `describeProblem(error, {support, transport?, stage}) → Problem {id, severity, title, detail, actions[], technical?, printerErrors?}`;
  - `isUserCancel(e)`.
  - **All user-facing error copy lives here.** The UI only renders Problems (`ui/common/ProblemBanner.svelte`).
- `packetlog.ts`: `PacketLog {push, note, entries, clear, subscribe, toText}`, `toHex`, `fromHex`.
- `webserial.ts`:
  - `WebSerialTransport.requestBluetooth()` / `.requestAnyPort()` / `.fromGranted(match?)`, `.forget()`;
  - `PortLike`, `SerialLike`, `DEFAULT_OPEN_RETRY` (3 attempts, backoff [300, 1000] ms, retry on `NetworkError`).
- `webusb.ts`: `WebUsbTransport.request()` / `.fromGranted()`, `UsbDeviceLike`.
- `mock.ts`: `MockTransport(scenario: Partial<MockScenario>, clock?)`, `.written`, `.printedPages()`.
  - `MockScenario {model, mediaId, behaviour?, timing?, fragment?, latencyMs?, openFailures?, disconnectAfterBytes?}`.
- `client.ts`:
  - `PrinterClient(transport, {log?, clock?, session?, model?, keepaliveMs?})`;
  - methods: `.connect(signal) → PrinterStatus`, `.refreshStatus()`, `.print(job, signal)`, `.cancel()`, `.disconnect()`, `.on(listener)`;
  - getters: `.state`, `.lastStatus`, `.modelName`;
  - `ClientState` = `disconnected` | `opening` | `waking` | `handshaking` | `ready` | `printing` | `cancelling` | `no-reply` | `lost` | `error`.
- `connect.ts` — **the UI's only entry point**:
  - `ConnectionManager({support, remember?, recall?, virtualScenario?})`;
  - `.connect(path)` must be **called synchronously in the click handler**;
  - `.restore()`, `.reconnect()`, `.refreshStatus()`, `.print(job, signal)`, `.cancel()`, `.disconnect({forget?})`, `.dismissProblem()`;
  - `.subscribe(fn)` delivers an immutable `ConnectionSnapshot {path, state, transport, model, status, media, openProgress, progress, problem}`;
  - `.packetLog`, `.client`.

### 2.3 Document model (W3 → W4, W5) — `src/doc/schema.ts`

`LabelDoc` schema 1 (types are complete and frozen):
- top-level fields: tape `{widthMm, mediaId?, colors?}`, length auto/fixed, `marginsMm`, layout flow/free, `frame?`, `items`, print `{copies, autoCut, chain, mirror, threshold}`;
- `Item` = Text | Icon | Code | Image | Shape | Spacer, with the fields documented inline;
- factories: `createDoc()`, `createItem(kind)`, `newId()`;
- `validateDoc(raw)` returns `{ok, doc}` or `{ok:false, problems}`.

`doc/ops.ts` has pure immutable operations: `addItem` → `[doc, id]`, `updateItem`, `removeItem`,
`moveItem`, `duplicateItem`, `updateDoc`. `doc/history.ts` has `createHistory(doc, 200)` →
`{canUndo, canRedo, push(doc, coalesceKey?), undo, redo, reset}`.

### 2.4 Renderer (W3 → W4, W5) — `src/render/index.ts`

- `renderLabel(doc, target: RenderTarget{model, media, area}, {factor?, loadBlob?, signal?}) → Promise<RenderResult>`.
  - `RenderResult`: `{bitmap: Bitmap1, lengthDots, heightDots, lengthMm, feedMarginMm, boxes: ItemBox[], warnings: RenderWarning[], blocking}`.
  - The caller frees the previous bitmap.
- `paintPreview(canvas, bitmap, {tape, ink})` and `thumbnailPng(bitmap, colors)`.
- `buildPrintJob(doc, result, target) → Job` (copies = repeated pages, one job).
- `ensureFonts(doc) → {fallbacks}`, `FONTS`, `fontDef`, `ICONS`, `iconById`.
- `codeMatrix`, `codeSizeDots`, `maxModuleDots`, `canvasReadbackIsNoisy()`.
- `mmToDots`, `dotsToMm`, `cssToRgb`.

### 2.5 Studio context (W4 → W5) — `src/ui/state/studio.svelte.ts`

`getStudio()` returns the `Studio` instance. W5 relies on these members, which W4 must keep:
`support`, `connection` (ConnectionManager), `conn` (snapshot), `doc`, `setDoc(doc,
coalesceKey?)`, `render` (RenderResult | null), `prefs`, `view` / `setView('studio' |
'diagnostics')` (URL hash `#diagnostics`), `wasm` state. `App.svelte` (W4) renders
`<Diagnostics onclose>` (W5) for the diagnostics view and always mounts `<UpdateToast busy>` (W5).

### 2.6 Persistence (W5 → W4) — `src/doc/persist*.ts`

- `persist.ts`:
  - `openLabelStore() → LabelStore {list, load(id) → {doc, readOnly}, save(doc, thumb?), remove, putBlob, getBlob, collectGarbage}`;
  - `createAutosave(store, 500, onError) → {schedule(doc), flush(), dispose()}`.
- `persist-migrate.ts`: `migrate(raw) → {ok, doc, readOnly, migratedFrom?}` or `{ok:false, problems}`.
- `persist-share.ts`: `createShareLink(doc, baseUrl) → {url, notices}`, `readShareFragment(hash)`. The fragment is `#d=…`; the diagnostics view uses `#diagnostics`.
- `persist-files.ts`: `exportLabelFile(doc, store)`, `importLabelFile(file, store) → {doc, notices}`, `downloadBytes(bytes, name, mime)`.
- `persist-prefs.ts`: `loadPrefs()`, `savePrefs(patch)`, `Prefs` (lastPath, lastTransport, autoReconnect, theme, lastLabelId, previewZoom, previewMode, usbOnWindows).

## 3. Work packages

### W1 — wasm bindings

**Owns:** `crates/ptouch-wasm/**` (incl. its `Cargo.toml`), `web/src/wasm/**` (except the
generated, gitignored `pkg/`), `web/tests/helpers/wasm.ts`, `web/tests/unit/wasm/**`.

**Tasks** (in this order, because W2 and W3 tests unblock as each lands):
1. Core → DTO conversion functions as plain Rust (`status_dto`, `media_dto`, `event_dto`,
   `error_info`), unit-testable natively (`#[cfg(test)]`).
2. `parseStatus`; `PrintSession` (constructor with model and config, `requestStatus`,
   `submit`, `pollEvent`, `state`, `lastStatus`); `VirtualPrinter::new`; `cancelSequence`.
3. `listModels`, `printArea`, `mediaForWidth` (3.5 → width byte 4), `mediaForStatus`.
4. `encodeCode`:
   - QR via fast_qr (ECL);
   - Code 128 via barcoders (code-set prefix; prefer C for even digit runs);
   - EAN-13 with check digit;
   - linear codes have `height = 1`.
5. `Raster.blitTone` (ToneOptions → Dither/ToneAdjust) and `Raster.blitCode`.
6. `encodeJob` (`prepare_pages` + `encode_job`, JobOptions mapping) and `decodeJob`.
7. Remove `#![allow(unused_variables, dead_code)]` and `not_implemented`. Keep the wasm size
   ≤ 150 KB gzip, and drop serde on hot paths if it grows.

**Tests:**
- Native `cargo test -p ptouch-wasm`:
  - DTO mapping of the real fixture `80 20 42 30 76 30 00 00 00 00 18 01 00 … 01 08 …` →
    PT-P710BT, 24 mm, `tze128-24`, laminated, white/black, ready;
  - every error code maps to its TS string;
  - Code 128 / EAN-13 / QR matrices against known vectors.
- `crates/ptouch-wasm/tests/web.rs` (wasm-bindgen-test, headless Chrome):
  - thrown error `code` and `isPtouchError`;
  - tsify shapes;
  - `Raster` → `Bitmap1` → `encodeJob` bytes equal the native golden for the same bitmap;
  - `PrintSession` driven by `VirtualPrinter` through a full job.
- `web/tests/unit/wasm/*.test.ts` (node, `initSync`): the same contract seen from TS,
  including `SessionEvent` discriminants and `VirtualPrinter` round trip.

Local wasm-bindgen tests need a ChromeDriver that matches your Chrome:
`npx @puppeteer/browsers install chromedriver@<chrome version>` and then
`wasm-pack test --headless --chrome --chromedriver <path> crates/ptouch-wasm`.

### W2 — printer transport + PrinterClient

**Owns:** `web/src/printer/**`, `web/tests/unit/printer/**`, `web/e2e/fixtures/**`.

**Tasks:**
- **`webserial.ts`:**
  - Chromium: SPP filter + `allowedBluetoothServiceClassIds`. Gecko: unfiltered.
    `NotFoundError` = user cancel. `TypeError` (pre-117 Chromium) → retry unfiltered.
  - **`open()` retries on `NetworkError`** (≥ 2 retries, short backoff) and emits
    `onProgress` so the UI can show "Waking printer…".
    *Verified:* the first direct-RFCOMM open failed after 10 s; the immediate retry opened in
    378 ms.
  - Open with `baudRate: 9600` and `bufferSize: 16384`, then optionally `setSignals` in a
    try/catch.
  - Writes: chunked with `await writer.ready` between chunks, writer lock released in
    `finally`. Run one long-lived read pump; on errors or `readable === null` emit `lost`.
  - `close()` order: `reader.cancel()` → `releaseLock()` → `port.close()`. Also implement
    `fromGranted(match)` and `forget()`.
- **`webusb.ts`:** `open → selectConfiguration(1) → claimInterface(0)`. Run one `transferIn(1,64)`
  loop that only `close()` cancels. Writes never time out and are never retried.
- **`mock.ts`:** drive the VirtualPrinter on the injected `Clock`, with fragmentation, latency,
  `openFailures` (NetworkError) and `disconnectAfterBytes`.
- **`client.ts`:**
  - Pump exactly as ARCHITECTURE §4.3/§5.5: one timer at `pollTimeout()`; sequential awaited
    writes of `pollTransmit()`; events mapped to `PrinterEvent`.
  - Progress comes from status frames (`06/01` printing → `01` completed → `06/00` ready;
    about 9 s for a 5 cm label), **never** from write completion.
  - Handshake timeout → state `no-reply`.
  - Keepalive `ESC i S` every 60 s while the tab is visible and idle. Never send anything
    while a page prints.
- **`connect.ts`:** connect flow (ARCHITECTURE §3.3) for every path; `restore()` auto-reconnect
  via `remember`/`recall`; snapshot updates; turns errors into Problems; keeps the port open
  between prints.
- **`problems.ts`:** actionable copy for every `ProblemId`, including:
  - `no-reply-firefox`: Firefox 157 on macOS exposes only `/dev/cu.*`, which accepts writes
    but never returns data after first use. Advise Chrome/Edge or re-pairing.
  - `open-failed`: offer "Choose port…" and "Try again".
  - `port-in-use`: tell the user to close other apps / the CLI.
  - `wrong-media`: action `switch-tape`.
  - The printer errors: cover open, no tape, cutter jam, overheating/cooling, weak battery,
    printer off.
- **`support.ts`:** full UA/platform detection (Chrome/Edge/Brave/Firefox 151–155 vs ≥ 156,
  Safari, iOS, Android). Hide USB on Windows unless `prefs.usbOnWindows`.
- **`e2e/fixtures/serial-stub.ts`:** `stubSerial(page, {openFailures, silent})` exposes a fake
  `navigator.serial` whose port answers like a PT-P710BT. Writes are recorded on
  `window.__ptouchWrites`.

**Tests (Vitest node):**
- `WebSerialTransport` against a `PortLike` built from real WHATWG streams:
  - 7 + 25 byte fragmentation;
  - NetworkError ×1 then success → progress events and success;
  - NetworkError ×3 → `open-failed`;
  - chunk sizes and `ready` awaiting;
  - `releaseLock` on error;
  - `readable` → null ⇒ `lost`;
  - abort.
- `WebUsbTransport` with a `UsbDeviceLike` fake.
- `PrinterClient` + `MockTransport` + fake clock:
  - connect → ready 24 mm;
  - 2-copy print → progress order and last byte `0x1A`;
  - silent → `no-reply`;
  - cover open on page 2;
  - wrong media;
  - disconnect mid-job → `lost` (job never retried);
  - cancel.
- `ConnectionManager` path selection per `SupportInfo`, `restore()`, and that a deliberate
  `disconnect` clears `remember`.
- A `describeProblem` table test.

### W3 — document model, renderer, codes, fonts

**Owns:** `web/src/doc/schema.ts` (types frozen per §2.3; bodies such as `validateDoc` are
W3's), `web/src/doc/ops.ts`, `web/src/doc/history.ts`, `web/src/render/**`,
`web/public/fonts/**`, `web/tests/unit/doc/**`, `web/tests/unit/render/**`,
`web/tests/browser/**`.

**Tasks:**
- **Renderer** per ARCHITECTURE §5.1–§5.2 and §6.5. Canvas x = length and y = across the tape.
  - Crisp plane on OffscreenCanvas at 3× → `blitCrisp` (doc threshold).
  - Images → `decodeImage` → `blitTone`.
  - Codes → `codeMatrix` → `blitCode` with integer `moduleDots` and quiet zones; never drawn
    on canvas. Order: tone → crisp → codes.
  - Flow layout: margins, gap, cross-axis align, auto/fixed length clamped to
    `minLengthDots..maxLengthDots`, overflow warning.
  - Text: multiline, weight, italic, size `fit` (largest that fits the band) or mm, align,
    line height, invert.
  - Icons are stroked SVG paths scaled to the band. Shapes; spacer; optional frame.
  - Warnings: `small-text` < 2 mm, `font-fallback`, `code-too-small`, `code-invalid`,
    `canvas-noise` (blocking).
  - `ItemBox`es for click-to-select. Thumbnails.
  - The UI passes normal left-to-right images; the core encoder handles the
    last-column-first feed order (verified orientation).
- **Fonts:** the four OFL families (Fira Sans, Archivo Narrow, JetBrains Mono, Atkinson
  Hyperlegible).
  - Self-hosted woff2 (Latin subset is fine), with the OFL texts in `public/fonts/`.
  - `SOURCES.md` records upstream URL, version and SHA-256 for every file.
  - `ensureFonts` uses `FontFace` + `document.fonts.check`.
  - Tell W5 the final file list for `THIRD_PARTY.md`.
- **Icons:** about 60 label-useful Lucide (ISC) icons, with categories and keywords.
- **Doc:** `validateDoc` (clamp numbers, drop unknown kinds with problems), `duplicateItem`,
  and the history ring buffer with coalescing.

**Tests:**
- Node: layout maths, mm↔dots, `validateDoc`, ops immutability, history (undo/redo/coalesce,
  capacity), `codeSizeDots`/`maxModuleDots`, `buildPrintJob` copies/options mapping.
- Browser project (Chromium):
  - render the fixture docs (24 mm text "Hello" in a bundled font, 12 mm QR, EAN-13, image
    dither) and compare packed 1-bpp bytes with checked-in snapshots
    (`tests/browser/__snapshots__`);
  - `canvasReadbackIsNoisy()` is false in a clean browser;
  - the result `bitmap.height === area.heightDots`.

### W4 — editor UI

**Owns:** `web/src/App.svelte`, `web/src/ui/**` **except** `web/src/ui/diagnostics/**`,
`web/src/styles/**`, `web/tests/unit/ui/**`, `web/e2e/shell.spec.ts`,
`web/e2e/editor.spec.ts`, `web/e2e/connect-print.spec.ts`.

**Tasks** (UX per ARCHITECTURE §6.2/§6.4; a clean, modern, accessible product):
- **Studio state:**
  - boot: wasm → fonts → share fragment (W5 `readShareFragment`) or last label
    (`prefs.lastLabelId`) → `connection.restore()`;
  - target resolution: `conn.media` from the status, else `mediaForWidth(model ?? 'PT-P710BT', doc.tape.widthMm)` → `printArea`;
  - debounced re-render (rAF / 50 ms, abort stale renders, free old bitmaps);
  - history (⌘/Ctrl-Z, ⇧⌘Z);
  - autosave via W5.
- **Top bar:** brand, LabelsMenu (New / Open list with thumbnails / Import / Export / Share
  link via W5), status chip (● ready with tape, ◐ connecting/waking, ○ asleep?, ✕ error) and
  Reconnect / Disconnect.
- **Connect dialog:**
  - options: Bluetooth (default), **Choose port…** (unfiltered; always shown next to
    Bluetooth on Chromium), USB cable, No printer (virtual);
  - call `connection.connect(path)` directly in `onclick`;
  - show "Waking printer… (attempt n of m)" from `openProgress` and the ProblemBanner with
    its actions.
- **Media bar:** tape width (auto from status, manual offline), tape/ink colour swatches,
  length auto/fixed, margins. A mismatch banner with one-click "Use loaded 12 mm tape".
- **Insert panel and block list:** add, select, reorder (drag + Alt+↑/↓), duplicate, delete.
- **Properties editors** for every item kind plus label settings (threshold/"boldness",
  frame, gap/align).
- **Preview:**
  - the exact bitmap with `image-rendering: pixelated`;
  - printable band and tape edges, ruler in mm, length readout, feed margins drawn;
  - zoom (fit / 100 % / +/−), Design vs Exact-dots modes;
  - click a box to select; dark-mode friendly surround.
- **Print bar:**
  - copies 1–99, cut each, chain, "~24 mm leader once" note;
  - Print button disabled with the reason (not connected, blocking warning, mismatch);
  - progress "Printing label 2 of 3"; Cancel; success toast.
- **Unsupported-browser screen** (Safari/iOS/no API): friendly copy with a link to Chrome/Edge
  and a "Design labels anyway" button.
- **Responsive** single column under 860 px with a sticky print bar. Light/dark plus a theme
  toggle (`prefs.theme` → `html[data-theme]`).

**Tests:**
- `tests/unit/ui/**` for pure helpers (e.g. status-chip text, print-button disabled reasons).
- e2e:
  - `shell.spec.ts` (keep it green when copy changes);
  - `editor.spec.ts`: add text/QR, edit, reorder, undo, keyboard-only flow, axe-like checks
    of labels/roles;
  - `connect-print.spec.ts` with W2's `stubSerial`: connect → chip shows "24 mm", the first
    open fails and the waking state shows, then print → last written byte `0x1A` and progress
    shown.

### W5 — persistence, diagnostics, PWA, deploy, docs

**Owns:** `web/src/doc/persist*.ts`, `web/src/ui/diagnostics/**`, `web/src/pwa/**`,
`web/pwa.config.ts`, `web/public/icons/**`, `web/public/favicon.svg`, `web/THIRD_PARTY.md`,
`web/tests/unit/persist/**`, `web/e2e/diagnostics.spec.ts`, `.github/workflows/pages.yml`,
the **web section of `README.md`** (add one section only; don't touch the rest).

**Tasks:**
- **`persist.ts`:**
  - idb-keyval stores `labels` / `blobs` / `thumbs`;
  - list sorted by `updatedAt` with thumbnails;
  - blob GC on save;
  - `navigator.storage.persist()` after the first save;
  - autosave debounced 500 ms, plus `flush()` on `visibilitychange`.
- **`persist-migrate.ts`:** a versioned migration chain; future versions open read-only.
  Validate the result with `validateDoc`.
- **`persist-share.ts`:** deflate-raw + base64url in the `#d=` fragment. Leave out images
  over 32 KB with a notice; never contact a server.
- **`persist-files.ts`:** export a self-contained `.ptlabel.json` (`showSaveFilePicker` or
  download). Import via picker/drop; images go into `blobs`.
- **`persist-prefs.ts`:** keep it robust when `localStorage` throws.
- **Diagnostics page** (Phase 0 tool, ARCHITECTURE §6.2/§11):
  - environment and support info;
  - raw probe per path (`probe.ts`): open with retry progress → `genericHandshake()` +
    `statusRequest()` → reply timing and hex, open/close × N; refuse while the studio
    connection is open;
  - live packet log with filter/clear/copy;
  - virtual-printer section: render the current doc → `encodeJob` → download `.bin`,
    `decodeJob` → decoded pages as PNG/PBM next to the preview;
  - orientation and ruler test labels (built as `LabelDoc`s and rendered through W3);
  - "Copy diagnostics" (`report.ts`, masked device labels).
- **PWA:**
  - `registerType: 'prompt'`; the update toast never reloads while printing;
  - 192/512/maskable PNG icons and a polished favicon;
  - the manifest's scope/`start_url` follow `base`;
  - wasm and woff2 precached (verify offline in e2e).
- **Deploy:**
  - keep `pages.yml` green (actionlint);
  - verify the built CSP in e2e;
  - the README web section: URL, supported browsers, pairing steps, the macOS
    "first open may fail, the app retries" note, privacy (no network).
  - **Do not enable Pages** (the lead does).

**Tests:**
- Unit:
  - migrations from fixtures;
  - share-link round trip (node 24 has `CompressionStream`);
  - export/import round trip with an image;
  - prefs with throwing storage;
  - `maskDeviceLabel`;
  - autosave debounce (fake timers).
- e2e `diagnostics.spec.ts`:
  - reachable from the top bar and `#diagnostics`;
  - virtual-printer job download name/size;
  - copied report contains no unmasked device names;
  - offline reload after first visit (service worker).

## 4. Integration order

1. W1 lands status, session and virtual printer first. W2's client tests and W4's connect
   flows can then run for real.
2. W1 lands geometry, codes, tone and encode. This unblocks W3's browser snapshot tests and
   printing.
3. W2 and W3 deliver against the frozen interfaces. W4 builds UI against the stubs and
   switches over as they land.
4. W5 can finish persistence and PWA independently. Diagnostics needs W2 transports and W3
   rendering.
5. The integrator runs the §1.9 checklist on the merged tree, then the manual browser matrix
   (`docs/HARDWARE-TESTS.md`) on the deployed site.

## 5. Hardware facts the code must honour (verified 2026-10-08, Chrome 154, macOS)

- **Direct RFCOMM works.** `requestPort` with the SPP filter is used, and `getInfo()` reports
  `bluetoothServiceClassId 00001101-0000-1000-8000-00805f9b34fb`.
  - The first `open()` failed with `NetworkError` after 10 s; the immediate retry opened in
    378 ms.
  - The status reply arrived 92 ms after `00×100 1B 40 1B 69 53`.
  - ⇒ open retries, a "waking printer…" state, and both the Bluetooth and "Choose port"
    buttons.
- **Firefox 157 on macOS** exposes only `/dev/cu.*`. It opens and accepts writes but never
  returns data after first use. ⇒ detect the status timeout and show `no-reply-firefox`
  guidance.
- **Safari / iOS:** no Web Serial ⇒ the unsupported-browser screen.
- **Orientation:** the core sends raster lines last column first. UIs pass normal images.
- **Real status fixture:** `80 20 42 30 76 30 00 00 00 00 18 01 00 00 00 00 00 00 00 00 00 00 00 00 01 08 00 00 00 00 00 00`
  (24 mm laminated white tape, black text).
- **Print over RFCOMM:** the printer pushes `06/01` (printing), then `01` (completed), then
  `06/00` (ready). A 5 cm label takes about 9 s. The RFCOMM MTU is 320, so write in modest
  chunks with backpressure.

## 6. Open questions (decide during implementation, report to the integrator)

- The default write chunk for RFCOMM (960 B now). Tune it with the diagnostics "unreliable
  link" preset if prints stall.
- Whether the idle keepalive (`ESC i S` every 60 s) defers the ~10 min auto power-off (H8).
- Whether to move I/O + wasm into a worker later (`requestPort` must stay on the main thread).

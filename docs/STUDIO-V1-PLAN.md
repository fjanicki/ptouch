# ptouch studio v1 — implementation plan (5 parallel packages)

Status: **implemented and integrated, 2026-10-08** (all five packages landed; see §6 for the
integration notes and what is left). The contracts below describe the frozen interfaces; stub
behaviour they mention (DataMatrix throwing `UNSUPPORTED`, the provisional quiet-zone and auto
size rules in §5) is gone. Base: the web studio from
`docs/WEB-IMPLEMENTATION-PLAN.md` (read its §1 rules, §2 contracts and the layering rules in
`web/tests/unit/layering.test.ts` first) and `docs/ARCHITECTURE.md` §6–§7.

This round adds variables and batch printing (F1), templates (F2), Wi-Fi QR codes, DataMatrix,
quiet-zone modes and automatic module size (F3), custom fonts (F4), PNG/PDF export, print
history and a tape usage counter (F5), and iPhone hand-off plus iOS PWA polish (F6).

**Out of scope:** free-form layout, `.lbx` import, more printer models, Android-specific UI.

---

## 0. Who the user is (drives the decisions below)

- The user's phone is an **iPhone**. Every iOS browser uses WebKit, and WebKit has no Web Serial,
  WebUSB or Web Bluetooth. The iPhone is therefore **design-only**: the user designs a label,
  sends it to a computer (AirDrop or Messages with the share link, or a `.ptlabel.json` file),
  and prints from Chrome or Edge on the Mac. F6 makes that path smooth. The studio must work at
  375 px (iPhone) and still at 360 px.
- The **iOS Camera app scans QR codes**, including `WIFI:` codes ("Join network …"). As far as we
  know it does not act on **DataMatrix**. DataMatrix needs a scanner app (any phone, no special
  hardware), but it fits more on narrow tape. The UI copy says this (P3).
- Printer: PT-P710BT, 180 dpi, 1 dot = 0.141 mm. Print pins / tape width in dots: 3.5 mm 24/24,
  6 mm 32/42, 9 mm 50/64, 12 mm 70/84, 18 mm 112/128, 24 mm 128/170. Unprinted margin on each
  side = (tape − pins) / 2. Auto full cut: yes. **Half cut: not supported.** Chain printing:
  yes. Each job feeds a leader of about 24 mm once, so many small labels print as **one**
  chained multi-page job. USB (WebUSB) is the recommended transport on macOS.

## 1. Rules for every package

1. **Edit only the files you own** (§3). You may add new files in the directories and file
   patterns you own. If you need a change in a file you do not own, do not edit it. Put the exact
   change (file, before/after) in your final report, and the lead applies it.
2. **Lead-owned, frozen files** (no package edits them):
   - repo: root `Cargo.toml`, `Cargo.lock`;
   - web config: `web/package.json`, `web/package-lock.json`, `web/vite.config.ts`,
     `web/tsconfig.json`, `web/svelte.config.js`, `web/playwright.config.ts`, `web/src/main.ts`,
     `web/tests/unit/layering.test.ts`, `web/THIRD_PARTY.md`;
   - doc layer: `web/src/doc/schema.ts`, `persist-migrate.ts`, `secrets.ts`, `persist.ts`,
     `persist-codec.ts`, `persist-prefs.ts`, `ops.ts`, `history.ts`;
   - render layer: `web/src/render/index.ts`, `types.ts`, `job.ts`;
   - UI: `web/src/App.svelte`, `web/src/ui/TopBar.svelte`, `web/src/ui/labels/**`,
     `web/src/ui/state/**`, `web/src/ui/common/**`;
   - wasm wrapper: `web/src/wasm/index.ts`.

   Packages import new render modules **by path** (`'../../render/export'`), so nobody needs to
   edit `render/index.ts`.
3. **No new dependencies.** The lead added `datamatrix =0.3.3` (cargo). Everything else is
   hand-written (CSV, PNG, PDF, font name table) or a web platform API. If you are sure you need
   another dependency, request it with name, exact version (at least two weeks old), licence and
   reason.
4. **The core stays as it is.** `crates/ptouch` does not change. You do not need it: §2.4 shows
   how every quiet-zone mode works with the existing `Raster.blitCode`.
5. **Layering** (enforced by a test):
   - `doc/*` imports only `./…` (and `idb-keyval` in `persist*`);
   - `render/*` imports only `../wasm`, `../doc/{schema,ops,history}` and `./…`;
   - `ui/*` imports anything.

   No protocol byte literals (`0x1b`, `0x80`, `\x1b`) are allowed outside `src/wasm`. Keep this in
   mind in the PNG/PDF writers (P4).
6. **Privacy:**
   - Never write a real Bluetooth name suffix or address. Use `PT-P710BTxxxx` and
     `XX:XX:XX:XX:XX:XX`.
   - Wi-Fi passwords stay in this browser (§2.5).
   - The diagnostics report never contains document content.
7. **No hardware.** Use `MockTransport` and `VirtualPrinter`. **Never commit or push.**
8. **Quality:**
   - keyboard operable, visible focus, labelled controls, WCAG AA contrast in light and dark;
   - `prefers-reduced-motion` respected;
   - layout works at 360 px and 375 px, with touch targets ≥ 44 px on coarse pointers (P5 sets
     the global rule);
   - match the surrounding style and comment density;
   - every new behaviour has unit tests, and every UI flow has a Playwright e2e test.
9. **Definition of done:** no `TODO(Pn)` left in your files, and all of these pass:
   ```sh
   cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
   cargo clippy -p ptouch-wasm --all-targets --target wasm32-unknown-unknown -- -D warnings
   cargo test --workspace
   cd web && npm run wasm && npm run check && npm test
   PW_CHANNEL=chrome npx vitest run --project browser
   npx playwright test && BASE_PATH=/ptouch/ npm run build
   ```
   `e2e/studio-v1-entry.spec.ts` (the lead's test) must stay green: the dialog titles are frozen.
10. **Render snapshots:**
    - exact snapshots (codes, dither) are `web/tests/browser/__snapshots__/<name>.pbm`;
    - text snapshots are per OS: `<name>.macos.pbm` (record it locally) and `<name>.linux.pbm`
      (record it in Docker). To record a Linux snapshot:
      1. rsync `web/` (without `node_modules` and `dist`; the built `src/wasm/pkg` is included) to
         a fresh directory under the session scratchpad;
      2. run `docker run --rm -v <dir>:/web -w /web mcr.microsoft.com/playwright:v1.64.0-noble
         bash -c "npm ci --ignore-scripts --no-audit --no-fund && npx vitest run --project
         browser"`;
      3. copy the new `*.linux.pbm` files back.
    - Use distinct snapshot names per package (prefix `p1-`, `p3-`, `p4-` …).
    - The existing snapshots must stay byte-identical. That is the proof that schema-1 labels
      look the same after migration.

## 2. Frozen contracts (implemented or stubbed by the lead; signatures do not change)

### 2.1 `LabelDoc` schema 2 — `web/src/doc/schema.ts`

`SCHEMA_VERSION = 2`. Additions:

- **Code item:**
  - `Symbology = 'qr' | 'code128' | 'ean13' | 'datamatrix'`;
  - `content: 'text' | 'wifi'`;
  - `wifi?: WifiSettings`, where `WifiSettings = {ssid, password, security: 'wpa' | 'wep' | 'open', hidden}`.
    `'wpa'` means WPA/WPA2/WPA3 personal (`T:WPA`), `'wep'` is `T:WEP` and `'open'` is
    `T:nopass`. The block is kept when the item switches back to `'text'`. `createWifi()` makes
    the defaults;
  - `quietZone: 'standard' | 'compact' | 'none'`. `validateDoc` also accepts a schema-1 boolean;
  - `moduleDots: 'auto' | number` (integer 1–20).
- **Text item:** `customFont?: FontSource`, where
  `FontSource = {kind:'user', ref:'sha256-<32 hex>', family} | {kind:'local', postscriptName, family}`.
  `fontFamily` (bundled) stays required: it is the **fallback** when the custom font is missing.
- **Doc:** `batch?: BatchData`, where
  `BatchData = {enabled, columns: string[], rows: string[][], count, counters: BatchCounter[], dateFormat: 'iso'|'dmy'|'mdy'|'long'}`
  and `BatchCounter = {name, start, step, pad}`. `createBatch()` makes the defaults (off, no
  table, count 10, one counter `n` = 1, 2, 3 …).
- **`LIMITS`:**
  - Wi-Fi: `ssidChars 64`, `wifiPasswordChars 64`;
  - batch: `batchRows 500`, `batchColumns 20`, `batchCellChars 500`, `batchCounters 4`,
    `batchCount 1–500`, `counterValue ±1e9`, `counterPad 0–12`, `batchTotalChars 200 000`;
  - fonts: `fontNameChars 100`.
- **Patterns:** `VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/` and
  `CONTENT_REF_RE = /^sha256-[0-9a-f]{32}$/`.
- **Defaults:** new code items are `content 'text'`, `moduleDots 'auto'`,
  `quietZone 'standard'`.
- **Validation:** `validateDoc` validates every new field. Bad values are repaired with notices.
  A local font name may not contain quotes or backslashes, because it ends up inside CSS
  `local("…")`.

### 2.2 Migration — `web/src/doc/persist-migrate.ts`

`MIGRATIONS[1]` changes code items only:
- `quietZone` `true` becomes `'standard'` and `false` becomes `'none'`;
- `content` is set to `'text'`;
- **the numeric `moduleDots` is kept.**

Old labels therefore print exactly as before; only new items get `'auto'`. Fixtures:
`tests/unit/persist/fixtures/schema-{0,1,2,99}.json`. All existing render snapshots are
unchanged.

### 2.3 Doc-level pure modules

| Module | Owner | Frozen API |
|---|---|---|
| `doc/secrets.ts` | lead (done) | `docHasSecrets(doc)`, `stripSecrets(doc) → {doc, removed}` (Wi-Fi passwords blanked; same object when nothing to strip) |
| `doc/variables.ts` | P1 | `findVariables(doc) → string[]`, `batchSize(doc) → number` (done: 0 unless `batch.enabled`; rows or `count`; capped at 500), `resolveDoc(doc, index, {now}) → {doc, missing}`. `resolveDoc` must return **the input object** when nothing changes (it runs before every render) |
| `doc/persist-fonts.ts` | P4 | `openFontStore({area?}) → FontStore {list, add(file), get(ref), remove(ref)}`, `UserFontInfo`, `MAX_FONT_BYTES = 10 MB`, `MAX_FONTS = 50`. Own IndexedDB database `ptouch-fonts` (the label blob GC would delete fonts) |
| `doc/persist-history.ts` | P4 | `openPrintHistory({records?, thumbs?, limit?}) → PrintHistory {add(PrintRecordInput), list, get, remove, clear}`, `PrintRecord`, `HISTORY_LIMIT = 50`. Databases `ptouch-history` and `ptouch-history-thumbs` |
| `doc/persist-usage.ts` | P4 | `loadUsage(storage?)`, `addUsage(widthMm, mm, labels, storage?)`, `resetUsage(storage?) → TapeUsage {since, byWidth{"12": {mm, labels, jobs}}}`, `USAGE_KEY` |
| `doc/persist-share.ts` | P3 | `ShareOptions.includeWifiPasswords?` (default false) |
| `doc/persist-files.ts` | P3 | `LabelFileOptions {includeWifiPasswords?}` on `serializeLabelFile(doc, store, generator?, opts?)` and `exportLabelFile(doc, store, opts?)` |

**Variable semantics (P1 implements, P2 and P3 rely on them).** Placeholders are `{{name}}`.
They can appear in `TextItem.text`, `CodeItem.data` and `CodeItem.wifi.{ssid,password}`. A name
is resolved in this order:
1. a batch column (the value from the current row);
2. a batch counter (`start + i × step`, zero-padded to `pad`; `A-{{n}}` gives `A-001`);
3. a built-in:
   - `{{today}}`, `{{today+30d}}` and `{{today-7d}}` give the **local** date in
     `batch.dateFormat`, or `'iso'` when there is no batch;
   - `{{ssid}}` gives the SSID of the first Wi-Fi code in the label (used by the Wi-Fi sticker
     templates).

An unknown name stays visible as `{{name}}` and is listed in `missing`.

### 2.4 Render layer

- `render/types.ts`:
  - new warning code `font-missing`;
  - `RenderOptions.loadFontBlob?(ref)`.
- `render/fonts.ts` (P4):
  - `ensureFonts(doc, {loadFontBlob?}) → FontReport {fallbacks, missing?}`;
  - `textFaceReady(item)`, which the renderer uses for text items.

  The renderer already turns `missing` into `font-missing` warnings.
- `render/codes.ts` (P3):
  - `codePayload(item)` returns `data`, or the `WIFI:` string for a QR code with content
    `'wifi'`. `codeMatrix(item)` encodes `codePayload(item)` and caches it by payload;
  - `quietModules(m, quietZone)`, `maxModuleDots(m, band, quietZone, marginDots)` and
    `codeSizeDots` take `QuietZone | boolean` (`QuietZoneArg`).
- `render/wifi.ts` (P3): `wifiPayload(wifi: WifiSettings) → string`. It throws an Error with a
  user-facing message when the network name is empty or a password is missing.
- `render/job.ts` (lead, done):
  - `LEADER_MM = 24`;
  - `estimateTape(pageLengthsMm, feedMarginMm, {leader?}) → {labelsMm, leaderMm, totalMm}`.

  Every label counts its length plus 2 × the feed margin. The leader is counted once. Every tape
  number in the UI and the usage counter uses this function.
- **Quiet zones without a core change (P3).** The core's `blitCode(m, x, y, md, true)` only knows
  4 modules for 2-D and 10 for linear codes. With `quietZone = false`, the core paints **light
  modules as cleared and protected** dots. So for any other zone:
  1. pad the module matrix with light modules (`qx` left/right, `qy` top/bottom);
  2. blit the padded matrix with `false`. Dots outside the raster are clipped, so a vertical
     zone can run into the unprinted tape edge.

  Never use `true` for DataMatrix or for `'compact'`.
- **wasm** (P3): `encodeCode({symbology:'datamatrix', data})` returns a `ModuleMatrix` (square
  ECC 200, finder border included, no quiet zone). Today it is stubbed: it throws `PtouchError`
  `UNSUPPORTED`. The `datamatrix =0.3.3` dependency is in place.

### 2.5 Privacy contract (P3 implements the persistence part)

- Wi-Fi passwords are stored only locally: in the label library (IndexedDB) and in the print
  history.
- Share links and exported files **blank them** (`stripSecrets`) unless the user ticks "Include
  Wi-Fi password". When they are left out, the user gets a notice.
- `Studio.requestShare(kind)` opens `SecretsDialog` first whenever `docHasSecrets(doc)`.
- The block list shows the SSID, never the password (done in `view-model.ts`).
- The diagnostics report has no document access. The packet log is truncated to 64 bytes per
  entry; keep it that way.
- Share links and exported files never contain font files. The receiving side sees
  `font-missing` and the bundled fallback.

### 2.6 Studio context — `web/src/ui/state/studio.svelte.ts` (frozen; packages never edit it)

Existing members (`support`, `connection`, `conn`, `doc`, `setDoc`, `updateItem`, `updateDoc`,
`insert`, `openDoc`, `render`, `target`, `prefs`, `toast`, `announce`, `print`, `printing`,
`store`, `autosave`, …) stay. New members:

| Member | For | Notes |
|---|---|---|
| `dialog: StudioDialog \| null`, `openDialog(d)`, `closeDialog()` | all | `StudioDialog = 'templates' \| 'history' \| 'export' \| 'handoff' \| 'fonts' \| 'share-secrets'`. One modal at a time |
| `previewRow` | P1 | The batch label the preview shows. The studio renders `resolveDoc(doc, previewRow, {now})`. Reset to 0 by `openDoc`. P1 clamps it |
| `batchCount` (derived `batchSize(doc)`) | P1 | `> 0` makes `print()` call `buildBatchJob` |
| `batchProgress: {done,total} \| null` | P1 | Set while a batch renders for printing |
| `tapeLeader` | P1, P4 | `false` right after a chained print in this tab (the next job saves the leader) |
| `print()` | — | Single label: `buildPrintJob` + `estimateTape`. Batch: `ui/batch/batch-job.ts` `buildBatchJob(doc, target, {now, leader, loadBlob, loadFontBlob, onProgress}) → {job, labels, tapeMm}`. On success it calls `addUsage` (P4) and `printHistory.add` (P4, with a thumbnail of the current preview) |
| `newFromTemplate(doc)` | P2 | Opens a copy with a fresh id and timestamps, closes the dialog and announces |
| `requestShare('link' \| 'file')`, `createShareUrl(opts) → {url, notices}`, `copyShareLink(opts)`, `exportFile(opts)` | P3, P5 | `opts = ShareActionOptions {includeWifiPasswords?}`. `pendingShare` holds the action waiting in `SecretsDialog` |
| `fonts: FontStore`, `fontsVersion`, `fontsChanged()` | P4 | `fontsChanged()` re-renders. The renderer resolves `customFont.ref` through `fonts.get` |
| `printHistory: PrintHistory`, `usage`, `resetUsage()` | P4 | |

### 2.7 UI entry points (mounted by the lead; packages fill the bodies)

| Component | Mounted in | Visible when |
|---|---|---|
| `ui/batch/BatchPanel.svelte` (P1) | `App.svelte`, centre column under the preview | always (P1 decides collapsed/expanded) |
| `ui/batch/VariableHint.svelte` `{text}` (P1) | `TextProps` (under Text), `CodeProps` (under Data) | P1 |
| `ui/templates/TemplateGallery.svelte` (P2) | `App.svelte` | `dialog === 'templates'` (Labels → "New from template…") |
| `ui/share/SecretsDialog.svelte` (P3) | `App.svelte` | `dialog === 'share-secrets'` |
| `ui/history/HistoryDialog.svelte` (P4) | `App.svelte` | `'history'` (Labels → "Print history…") |
| `ui/export/ExportDialog.svelte` (P4) | `App.svelte` | `'export'` (Labels → "Export image (PNG, PDF)…") |
| `ui/fonts/FontManager.svelte` (P4) | `App.svelte` | `'fonts'` (Labels → "Fonts…") |
| `ui/handoff/HandoffDialog.svelte` (P5) | `App.svelte` | `'handoff'` (Labels → "Send to computer…") |
| `ui/handoff/DesignOnlyBanner.svelte` (P5) | `App.svelte`, top of the centre column | `!support.canPrint` |

- Every dialog uses `ui/common/Modal.svelte`, a native `<dialog>` with
  `{open, title, onclose, size?: 'm'|'l', description?, children, footer?}`. Keep the titles: the
  entry e2e test finds the dialogs by them.
- New shared icons in `ui/common/Icon.svelte`: `wifi`, `history`, `send`, `template`,
  `smartphone`, `share`, `table`, `eye`, `eye-off`. Label icons (`render/icons.ts`) already
  include `wifi`, `router`, `network`, `tag`, `archive`, `folder` and others.

## 3. Packages

### P1 — Variables + batch (F1)

**Owns:**
- source: `web/src/doc/variables.ts` (bodies), new `web/src/doc/csv.ts`, `web/src/ui/batch/**`
  (BatchPanel, VariableHint, `batch-job.ts` bodies, new files), `web/src/ui/print/PrintBar.svelte`;
- tests: `web/tests/unit/doc/variables.test.ts`, `web/tests/unit/doc/csv.test.ts`,
  `web/tests/unit/ui/batch*.test.ts`, `web/tests/browser/batch.browser.test.ts`,
  `web/e2e/batch.spec.ts`.

**Uses:** `BatchData`, `createBatch`, `LIMITS`, `VARIABLE_NAME_RE`, `studio.previewRow`,
`batchCount`, `batchProgress`, `tapeLeader`, `renderLabel`, `thumbnailPng`, `estimateTape`,
`jobOptions`, `encodeJob` (multi-page; it consumes its pages).

**Tasks:**
- **`csv.ts`** (`parseTable(text) → {columns, rows, notices}`):
  - follows RFC 4180: quoted fields, `""` escapes, newlines inside quotes, CRLF/LF/CR;
  - strips a UTF-8 BOM and skips trailing empty lines;
  - detects the delimiter among `,` `;` and tab by counting it outside quotes in the header line;
  - the header row gives the variable names: trimmed, spaces → `_`, made to match
    `VARIABLE_NAME_RE`, deduplicated with `_2`;
  - pads or truncates rows to the column count;
  - caps rows at `LIMITS.batchRows` with the notice "Only the first 500 rows were kept" (and the
    column and cell caps too).
- **`variables.ts`:** semantics as in §2.3. Dates use the local calendar (`getFullYear()` and
  friends, never `toISOString`). `'long'` uses `Intl.DateTimeFormat(undefined, {dateStyle:'long'})`;
  pass an explicit locale in tests. `{{today+Nd}}` allows N up to 3650. Counters handle negative
  steps and padding of negative numbers (`-01`).
- **BatchPanel:**
  - turn batch on/off;
  - paste text or CSV, or pick a `.csv`/`.txt` file;
  - an editable grid (add/remove rows and columns, keyboard-navigable);
  - counters (name, start, step, pad, with a live example such as "A-001, A-002, …");
  - date format;
  - "Labels: N" and the row-cap message;
  - **missing variables highlighted** (names in the doc that no column/counter/built-in defines,
    plus empty cells in used columns);
  - a **per-row preview grid**: lazily rendered 1-bit thumbnails, at most ~2 renders at a time,
    aborted on change, bitmaps freed. Click or Enter sets `studio.previewRow`.
- **VariableHint:** chips for the variables used in the field. Unknown ones are shown with error
  styling plus text (not colour alone), with an "Edit data…" button that opens/scrolls to the
  BatchPanel.
- **`buildBatchJob`:**
  - for each i, `resolveDoc(doc, i)` → `renderLabel` (same `RenderTarget`);
  - if a label is blocking, throw `Label i+1: <message>` (free everything);
  - pages = every label × `copies`, cloned. Cap the total at 999 pages with a clear error;
  - `encodeJob(model, media.id, pages, {...jobOptions(doc), copies: 1})`. That is ONE job, the
    leader is fed once, cut each = `print.autoCut` and chain = `print.chain`;
  - `tapeMm` = `estimateTape(every label's lengthMm, feedMarginMm, {leader})`;
  - report `onProgress`.
- **PrintBar** (with a batch):
  - the button reads "Print 25 labels";
  - copies are per label;
  - the tape estimate is **exact** once every row has been measured (render in the background,
    abortable) and shown as "≈ … (estimated)" until then;
  - "Cut each" is clear, and there is no half cut (the printer does not support it);
  - progress shows "Preparing label 12 of 25" from `batchProgress`, then the existing page
    progress.

  Without a batch it behaves exactly as today. Keep the existing a11y and focus behaviour.

**Tests:**
- unit: CSV parser table tests (quotes, `;`, tab, BOM, CRLF, ragged rows, caps, header
  sanitising), variables (columns, counters with step/pad/negatives, dates with a fixed `now`
  across month and year ends, `{{ssid}}`, missing, identity for no placeholders), batch size;
- browser: `buildBatchJob` for 3 rows × 2 copies with `decodeJob` → 6 pages in one job (one
  leader), and the page bitmaps equal the per-row renders;
- e2e: paste CSV → grid → preview row switch → print to the virtual printer → "6 labels printed";
  the missing-variable highlight; the 500-row cap message; keyboard-only grid editing; the
  360 px layout.

**Acceptance:**
- A pasted 3-column CSV prints N labels in one job on `VirtualPrinter`.
- `{{n}}` with pad 3 prints 001…; `{{today+30d}}` is correct in local time.
- Unknown variables are visibly flagged before printing.
- The tape estimate equals the job's `pageLines` + margins + leader.

### P2 — Templates (F2)

**Owns:** `web/src/ui/templates/**` (TemplateGallery, `templates.ts`, new files),
`web/tests/unit/ui/templates.test.ts`, `web/tests/browser/templates.browser.test.ts`,
`web/e2e/templates.spec.ts`.

**Uses:** `createDoc`, `createItem`, `createWifi`, `createBatch`, `ICONS`/`iconById`,
`renderLabel`/`thumbnailPng`, `studio.newFromTemplate`, `studio.target`, `conn.media` (to
suggest templates that fit the loaded tape), and the built-in variables `{{ssid}}` and the
counter.

**Tasks:**
- Write `TEMPLATES: TemplateDef[]`, with `{id, name, description, category, tapeWidthMm, build(): LabelDoc}`.
  `build()` returns a fresh `LabelDoc` with new ids every call. Templates are plain `LabelDoc`s
  with placeholder text. Templates:
  1. **Wi-Fi sticker, 12 mm:**
     - a QR code: `content 'wifi'`, `createWifi()`, `moduleDots 'auto'`, `quietZone 'compact'`,
       ECC `L` (fits a WPA payload at ≥ 2 dots);
     - a text item `{{ssid}}`.
  2. **Wi-Fi sticker, 24 mm:**
     - a `wifi` icon;
     - text `Wi-Fi\n{{ssid}}`;
     - a QR code (ECC `M`, standard quiet zone).

     Both Wi-Fi stickers are small (auto length).
  3. **Cable flag:** the same text on both halves with a spacer between them. The spacer is the
     wrap length (≈ π × cable Ø, 6 mm cable by default), with a fixed length, so the text reads
     from either side when wrapped. Use 9 or 12 mm tape.
  4. **Cable wrap:** the text repeated 3–4× along a fixed length (≈ π × Ø + overlap) on 6/9 mm
     tape.
  5. **Shelf / bin / drawer label** with an icon (24 mm and 12 mm). Include a
     **Gridfinity-friendly 12 mm** variant with a fixed length. Verify the common Gridfinity
     label-tab size and say which bin width it fits.
  6. **Asset tag:**
     - a QR code with data `{{id}}` (or a URL prefix plus `{{id}}`) and text `Asset {{id}}`;
     - `batch = createBatch({enabled:true, count:10, counters:[{name:'id', start:1, step:1, pad:4}]})`.
  7. **Folder spine:** 24 mm, large text, fixed length.
  8. **Simple name tag:** 24 mm, two lines.
- **Gallery:**
  - grouped cards with live 1-bit thumbnails (rendered lazily with bounded concurrency, bitmaps
    freed) and a tape chip;
  - a "Fits the loaded tape" hint;
  - keyboard grid navigation, and works at 360 px;
  - choosing a card calls `studio.newFromTemplate(t.build())`.

**Tests:**
- unit: every template passes `validateDoc` with no notices and uses only existing icon ids, and
  `build()` makes fresh ids;
- browser: every template renders without blocking warnings once its placeholders are filled.
  The Wi-Fi ones need P3's `wifiPayload`: use `test.skip` until it lands, and report;
- e2e: open the gallery → pick "Wi-Fi sticker (12 mm)" → the editor shows a 12 mm label with a
  QR block and a text block.

**Acceptance:** all 8 templates are present and keyboard-accessible, and each opens as a new label
(fresh history) whose placeholder text is obvious.

### P3 — Codes (F3)

**Owns:**
- Rust: `crates/ptouch-wasm/src/codes.rs`, `dto.rs` (the `CodeSpec` doc only),
  `crates/ptouch-wasm/tests/**`;
- web source: `web/src/render/codes.ts`, `render/wifi.ts`, `render/renderer.ts` (only
  `prepareCode`, code blits and the code-related constants),
  `web/src/ui/editor/props/CodeProps.svelte`, `web/src/ui/editor/InsertPanel.svelte`,
  `web/src/ui/share/**`, `web/src/doc/persist-share.ts`, `web/src/doc/persist-files.ts`;
- web tests: `web/tests/unit/render/codes.test.ts`, new `tests/unit/render/wifi.test.ts`,
  `tests/unit/persist/share.test.ts`, `tests/unit/persist/files.test.ts`,
  `tests/unit/wasm/bindings.test.ts`, the code cases in `tests/browser/render.browser.test.ts`
  (new snapshots `p3-*`), `web/e2e/codes.spec.ts`.

**Tasks:**
- **DataMatrix** in `codes.rs` with `datamatrix::DataMatrix::encode_str(data,
  SymbolList::default().enforce_square())`, falling back to `encode` for non-Latin-1 text if
  needed. The bitmap becomes a `ModuleMatrix`. The error for too much data is `INVALID_INPUT`.
  Native tests:
  - a known vector: size 10×10 for "A1" or a published example;
  - the L finder: left column and bottom row dark, and alternating timing on the top row and
    right column;
  - a round trip through `DataMatrix::decode`.

  Check the wasm size against the budget (≤ 150 KB gzip) and report the delta.
- **`wifiPayload`:**
  - format: `WIFI:T:<WPA|WEP|nopass>;S:<ssid>;P:<password>;H:true;;`;
  - for `'open'` there is no `P`; `H:true` appears only when the network is hidden;
  - escape `\` first, then `;` `,` `:` `"` with a backslash;
  - the SSID is required, and WPA/WEP need a password (WPA 8–63 characters or 64 hex: show a
    warning, not a block, outside that range);
  - test vectors cover every special character and every security mode.
- **Quiet-zone modes** (implemented with the padded-matrix technique in §2.4):

  | Mode | QR | DataMatrix | Linear |
  |---|---|---|---|
  | standard | 4 modules all round; the vertical part may use the unprinted tape edge (today's rule) | 1 module (ISO/IEC 16022) | 10 modules left and right |
  | compact | 2 modules along the label; vertical zone = only the unprinted tape edge, the symbol may fill the whole band | 1 module along the label, same vertical rule | 5 modules |
  | none | none | none | none |

  A label frame or a free-layout frame sets `marginDots = 0`, as today.
- **`moduleDots: 'auto'`:**
  - 2-D codes: the largest whole-dot size that fits the band, given the quiet-zone mode, the tape
    margin and a free-layout frame;
  - linear codes: the largest size in 1–4 that fits a fixed length or frame, else 2;
  - no "reduced" warning for `'auto'`.

  A numeric override is kept as today. Remove the lead's provisional code (`TODO(P3)` in
  `renderer.ts` and `codes.ts`).
- **CodeProps:**
  - symbology: QR / DataMatrix / Code 128 / EAN-13. Copy: "QR: best for phone cameras (the
    iPhone Camera app reads it)." and "DataMatrix: smaller, but needs a scanner app.";
  - for QR, a Content selector `Text` / `Wi-Fi network`. Wi-Fi fields: network name, security
    (WPA/WPA2/WPA3, WEP, None), password with a show/hide toggle (`eye`/`eye-off`, an
    `aria-pressed` button), and "Hidden network". Add a note that the password stays on this
    device unless you choose to share it;
  - a button "Add network name label" inserts a text block `{{ssid}}`;
  - quiet zone as a segmented control: Standard / Compact / None, each with a hint;
  - module size Auto (default) or a fixed number;
  - **physical size in mm** and a **readability hint**: ≥ 3 dots "good for phone cameras",
    2 "OK close up", 1 "unreliable" (shown as text, not colour alone). Keep `VariableHint`
    mounted.
- **InsertPanel:** add a "Wi-Fi QR" tile (QR, content `'wifi'`, compact quiet zone on tapes
  ≤ 12 mm).
- **Privacy:** `persist-share.ts` and `persist-files.ts` apply `stripSecrets` unless
  `includeWifiPasswords`, with the notice "The Wi-Fi password was left out." Add a notice when
  the label uses custom fonts: "Custom fonts are not included". `SecretsDialog`: an unticked
  "Include Wi-Fi password" checkbox, a warning when ticked ("anyone with the link can join your
  network"), and Continue / Cancel.

**Tests:**
- Rust: native DataMatrix vectors;
- unit: wifi escaping and vectors; quiet modules and `maxModuleDots`/auto for every mode × tape
  width (12 mm: band 70, margin 7; 24 mm: band 128, margin 21); share/export strip passwords by
  default and keep them when asked; the report has no doc text;
- browser: snapshots of a DataMatrix, a compact QR on 12 mm and a Wi-Fi QR, plus a
  module-by-module check that the printed dots equal the matrix (the Rust tests decode the
  symbol itself). Existing snapshots unchanged;
- e2e: insert a Wi-Fi QR, fill it, show/hide the password, copy a share link (the password
  absent from the decoded fragment), the SecretsDialog flow, quiet-zone and auto-size readouts.

**Acceptance:**
- A Wi-Fi QR on 12 mm in compact mode is visibly larger than in standard mode.
- The iOS Camera "Join network" payload format is correct per the vectors.
- DataMatrix renders crisply with a 1-module quiet zone.
- Passwords never appear in share links or exports by default.

### P4 — Fonts, export, history, usage (F4, F5)

**Owns:**
- doc layer: `web/src/doc/persist-fonts.ts`, `persist-history.ts`, `persist-usage.ts`;
- render layer: `web/src/render/fonts.ts`, `web/src/render/text.ts` (font selection and face
  CSS only), new `web/src/render/export.ts`;
- UI: `web/src/ui/fonts/**`, `web/src/ui/history/**`, `web/src/ui/export/**`,
  `web/src/ui/editor/props/TextProps.svelte` (keep the `VariableHint` mount);
- tests: `web/tests/unit/persist/{fonts,history,usage}.test.ts`,
  `web/tests/unit/render/export.test.ts`, `web/tests/browser/fonts.browser.test.ts`,
  `web/tests/browser/export.browser.test.ts`, `web/e2e/fonts-export-history.spec.ts`.

**Tasks:**
- **Fonts:**
  - upload TTF/OTF/WOFF/WOFF2;
  - check the signature (`00 01 00 00`/`true`, `OTTO`, `wOFF`, `wOF2`) and the size (≤ 10 MB,
    ≤ 50 fonts);
  - `FontFace` must load before the font is stored;
  - the family name comes from the `name` table (IDs 1/16; TTF/OTF, and WOFF via
    `DecompressionStream('deflate')`), else from the file name;
  - store it in `ptouch-fonts` keyed by content ref;
  - register it under a private family (`ptouch-user-<ref>`), with the weight range `1 1000` so
    the canvas does not synthesise bold;
  - **Local fonts:**
    - `queryLocalFonts()` only on a click (permission prompt), only where it exists (Chromium
      desktop), labelled "Varies by machine";
    - register with `local("<postscriptName>")` under `ptouch-local-<name>`;
    - type the API locally (no `@types` dependency).
  - **Missing fonts:**
    - `ensureFonts` reports the `missing` display names (the renderer warns `font-missing` and
      draws with `fontFamily`);
    - TextProps shows "Not on this device — using Fira Sans" with "Choose font…";
    - `fontsUsed` and the face CSS honour `customFont`.

  CSP: `font-src 'self' blob: data:` already allows blob URLs, and `FontFace` with an
  `ArrayBuffer` needs no fetch.
- **TextProps:** the font picker lists the bundled fonts first, then "Your fonts", then "This
  computer" (local), then "Manage fonts…" (opens `dialog 'fonts'`). It sets
  `customFont`/`fontFamily`.
- **Export (`render/export.ts`):**
  - `exportPng(bitmap, {dpi}) → Promise<Blob>`: 1-bit grayscale (colour type 0, bit depth 1),
    ink = black, a `pHYs` chunk with 180 dpi = 7087 px/m, unit 1. Compress with
    `CompressionStream('deflate')` (zlib) and compute the CRC32 by hand;
  - `exportPdf(bitmap, {dpi, tapeWidthDots}) → Promise<Blob>`: a hand-written PDF 1.4 whose page
    size is the label length × the tape width in points (mm × 72 / 25.4). The bitmap is an
    `/Image` XObject with `/BitsPerComponent 1 /ColorSpace /DeviceGray /FlateDecode`, placed at
    the band offset at true physical size, with a correct `xref`;
  - mind the protocol-bytes lint (no `0x1b`/`0x80` literals).

  ExportDialog: PNG / PDF of the **exact print bitmap** (`studio.render.bitmap`, cloned while
  encoding). The file name comes from the label name. Note "batch: exports the preview row".
- **History:**
  - `PrintRecord` with a thumbnail, keeping the newest 50 (drop the oldest), raw doc JSON that is
    migrated on read, and clear;
  - HistoryDialog lists the thumbnail, name, date, tape, labels/copies and mm. Actions: **Open**
    (as a copy when the library label differs) and **Reprint** (open, `await tick()`, then
    `studio.print()`, which waits for the render);
  - "Clear history" with a confirmation.
- **Usage:** localStorage `ptouch.usage.v1`, sanitised and never throwing. HistoryDialog shows the
  total mm (and m) per tape width, labels, jobs, "since <date>", and Reset with a confirmation.

**Tests:**
- unit: font signature/size validation, name-table parsing on a tiny fixture font (self-made or
  OFL; record the source), the store with a memory area, history cap/order/migrate/clear, usage
  add/reset/sanitise with throwing storage;
- PNG: parse back the chunks (IHDR 1-bit, pHYs 7087, CRC valid; inflate IDAT equals the packed
  rows);
- PDF: the xref offsets point at `n 0 obj`, the MediaBox in mm matches;
- browser: an uploaded test font renders differently from the fallback; a missing ref gives
  `font-missing`;
- e2e: upload a font → pick it → preview changes; export PNG/PDF downloads with the right names
  and sizes; print to the virtual printer → history shows it → reprint; the usage counter
  increases and resets.

**Acceptance:**
- An uploaded font is used for preview and print, and survives a reload.
- A shared label without the font falls back with a clear message.
- The PNG opens at the real size at 180 dpi, and the PDF prints at true size.
- Every print appears in the history (≤ 50) and in the usage counter.

### P5 — iPhone hand-off, iOS PWA, phone layout (F6)

**Owns:**
- source: `web/index.html` (meta/link tags only; a CSP change needs the lead), `web/pwa.config.ts`,
  `web/public/icons/**` (incl. `apple-touch-icon.png` 180×180), `web/public/favicon.svg`,
  `web/src/pwa/**`, `web/src/ui/handoff/**`, `web/src/ui/UnsupportedBrowser.svelte`,
  `web/src/styles/**`;
- tests: `web/tests/unit/ui/handoff.test.ts`, `web/e2e/iphone.spec.ts`; update
  `web/e2e/shell.spec.ts` only for copy that P5 changes.

**Tasks:**
- **Design-only mode** (no Web Serial/WebUSB; `support.platform === 'ios'` or `canPrint` false):
  - the UnsupportedBrowser screen and `DesignOnlyBanner` say plainly: "On iPhone you can design
    labels here; printing happens from a computer with Chrome or Edge";
  - offer "Send to computer…".
- **HandoffDialog:**
  - **Share** uses `navigator.share({title, url})` when `navigator.canShare?.({url})`. This gives
    AirDrop or Messages. Also offer sharing the `.ptlabel.json` as a `File` when
    `canShare({files})`. A user cancel (`AbortError`) stays silent;
  - always show the link in a read-only field with **Copy**, and **Export file**
    (`studio.exportFile`);
  - an "Include Wi-Fi password" checkbox when `docHasSecrets` (unticked);
  - short steps: "On your Mac: open the link in Chrome → Connect → Print".
  - No QR code of the link (computers rarely scan). No library sync.
- **iOS PWA:**
  - `apple-touch-icon`;
  - `apple-mobile-web-app-capable` and `mobile-web-app-capable`;
  - `apple-mobile-web-app-title` = "ptouch";
  - `apple-mobile-web-app-status-bar-style`;
  - `theme-color` for light and dark (`media`);
  - viewport `viewport-fit=cover`;
  - safe-area insets (top bar, print bar, dialogs, side gutters) via global CSS;
  - the manifest stays correct under `/ptouch/`.

  The existing CSP must stay as it is.
- **Phone layout:**
  - at 375 px and 360 px there is no horizontal scroll;
  - touch targets are ≥ 44 px on `(pointer: coarse)`, via global rules in `styles/`;
  - check the TopBar, LabelsMenu, PrintBar, properties and dialogs. Component-scoped fixes in
    files you don't own are reported to the lead or the owning package.

**Tests:**
- unit: hand-off helpers (share-data building, the `canShare` feature checks with fakes);
- e2e `iphone.spec.ts` (Chromium with an iPhone 13 viewport/UA, `navigator.serial`/`usb`
  deleted, `navigator.share` stubbed):
  - the design-only banner;
  - Send to computer → share called with the link; Copy puts the link on the clipboard; the
    password is excluded by default;
  - no horizontal scroll at 375 and 360;
  - the key controls' bounding boxes are ≥ 44 px;
  - the built `index.html` has the apple meta tags and the CSP.

**Acceptance:** on an iPhone a user can design a label, add it to the home screen, and send it to
the Mac in two taps. The page has no horizontal scroll, every touch target is ≥ 44 px, and the
safe areas are respected.

## 4. Integration order and conflicts

1. P3 lands `wifiPayload` and DataMatrix early: P2's Wi-Fi template tests and the P1/P2 browser
   tests use them.
2. P1 and P4 both touch printing outcomes only through the frozen Studio hooks (`buildBatchJob`
   for P1; `addUsage`/`printHistory` for P4). The lead already wired both.
3. P4 owns `render/fonts.ts` and `text.ts`, and P3 owns `renderer.ts`. If P4 needs a renderer
   change, report it to the lead (the font hook `textFaceReady` and `font-missing` warnings are
   already wired).
4. The lead integrates, runs §1.9 on the merged tree, records Linux text snapshots in Docker if
   any package added text snapshots, and runs a manual check on an iPhone (Safari: design,
   share, home screen) and on the Mac (Chrome: print a batch, Wi-Fi QR scanned by the iPhone
   Camera app).

## 5. Lead's deviations from the brief (decided, frozen)

- **Dialog names:** `ExportMenu` is `ui/export/ExportDialog.svelte` (a dialog, not a menu). Two
  entry points were added: `ui/share/SecretsDialog.svelte` (P3, the password question) and
  `ui/handoff/DesignOnlyBanner.svelte` (P5).
- **Wi-Fi security** is stored as `'wpa' | 'wep' | 'open'`; WPA/WPA2/WPA3 personal all map to
  `T:WPA`.
- **Custom fonts** are an optional `customFont` **next to** the bundled `fontFamily`, which stays
  the fallback. Font files never go into share links or exports (licences, size).
- **Batch** has an `enabled` switch and a `count` for counter-only batches. Counters are a list
  (the default is `n`).
- **Built-in variable `{{ssid}}`:** the Wi-Fi templates show the network name without typing it
  twice.
- **Quiet-zone modes and DataMatrix need no core change:** the padded-matrix technique in §2.4.
- **`render/job.ts` `estimateTape`** is the single tape formula. `Studio.tapeLeader` tracks
  whether the next job needs a leader.
- **Lead ownership:** `App.svelte`, `TopBar.svelte`, `LabelsMenu.svelte`, `studio.svelte.ts`,
  `view-model.ts` and `ui/common/**` are now lead-owned. `PrintBar.svelte` moves to P1,
  `CodeProps`/`InsertPanel` to P3, and `TextProps` to P4.
- **Provisional behaviour until P3 lands:** `'compact'` behaves like `'standard'`; `'auto'` gives
  2-D codes the largest size that fits and linear codes 2 dots; DataMatrix and Wi-Fi codes show
  a blocking "not available in this build yet" warning.

## 6. Integration status (2026-10-08)

All of §1.9 passes on the merged tree on macOS and in the Linux Playwright container
(`mcr.microsoft.com/playwright:v1.64.0-noble`, both the browser vitest project and the full
Playwright suite). No text snapshot changed; the three new P3 snapshots are exact (no text), so
no `.linux.pbm` files were needed. The wasm-bindgen browser tests (`crates/ptouch-wasm/tests/web.rs`,
10 tests incl. DataMatrix) pass with a ChromeDriver matching the local Chrome.

Integration changes (lead):

- **Entry-chunk budget** (CI: 122,880 B gzipped): the v1 features had pushed the entry chunk to
  138 KB. The six v1 dialogs now load on their first open (`App.svelte`, then stay mounted), and
  the batch panel's expanded part is a separate chunk (`ui/batch/BatchBody.svelte`, loaded on
  first expand; `BatchPanel.svelte` keeps the header, the measuring and the preview-row effects).
  Entry chunk now about 120.4 KB. The service worker precaches the lazy chunks, so the installed
  app still works offline.
- **Batch preparation can be cancelled:** `Studio.print()` passes an `AbortController` signal to
  `buildBatchJob`; `cancelPrint()` aborts it while labels are being prepared ("Printing
  cancelled", nothing sent). The print bar's Cancel is enabled during preparation.
- **Unknown variables block every print** (not only batches): `PrintGate.missingVariables` in
  `view-model.ts`, so the button, `⌘P` and the reason line agree.
- **Accessibility / phones:** the menu trigger (`ui/common/Menu.svelte`) carries `aria-label`, so
  "Labels" keeps its name when its text is hidden on phones. At ≤ 420 px the logo is hidden and
  the theme button moves into "More", so the label name is readable at 360 px. In design-only
  mode (no Web Serial / WebUSB) the idle connection chip is hidden on phones; the design-only
  banner offers "Send to computer". `html { scroll-padding }` keeps focused and scrolled-to
  controls clear of the sticky top bar and print bar (WCAG 2.4.11). The large `Modal` subtracts
  the side safe-area insets. `theme-color` follows the in-app theme (`themeColorMedia`).
- Removed the unused `BindError::unsupported` from `crates/ptouch-wasm/src/error.rs`.
- **e2e** `e2e/studio-v1-flows.spec.ts`: the cross-package flows checked on the printed dots.
  The expected symbol is encoded by the wasm bindings and searched for in the page the virtual
  printer decoded. The flows are: the Wi-Fi sticker template on 12 mm carrying the escaped
  `WIFI:` string, with the share link leaving the password out; a 3-row CSV printed as one
  chained job (one `Initialize`, `Print` ×2, `PrintLast`, chain bit clear); DataMatrix printed
  where the preview shows it; compact + auto making a 12 mm QR 3 dots per module instead of 2;
  batch cancel; and the fixes above. Export, history/reprint and the iPhone hand-off are covered
  by `fonts-export-history.spec.ts` and `iphone.spec.ts`.

Left for later:

- **Wasm budget:** 152,111 B gzipped of 153,600 B (DataMatrix added about 30 KB). The next wasm
  feature needs room: a small ASCII-only DataMatrix encoder, checked against the crate's decoder
  in tests, would recover most of it.
- **Manual device check (§4.4) not yet done:** iPhone Safari (design, Send to computer, Add to
  Home Screen) and Chrome on the Mac (print a batch; scan the Wi-Fi QR with the iPhone Camera).
  SSIDs that look like hex are not quoted; confirm on the iPhone.
- Batch measuring re-renders every label after each edit while a batch is on (up to 500 renders,
  sequential and yielding). Fine on desktop; watch it on phones.


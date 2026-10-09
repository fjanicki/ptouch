# ptouch studio — fonts and text size (3 parallel packages)

Status: **integrated by the lead, 2026-10-08** (§6): all three packages landed and every command
of §1.9 is green. Not yet checked on the real printer (§5.4). Base: studio v1
(`docs/STUDIO-V1-PLAN.md`; its §1 rules, the layering rules in `web/tests/unit/layering.test.ts`
and the snapshot procedure in its §1.10 still apply). Every command of §1.6 is green on the tree
the packages start from.

This round answers two pieces of user feedback:

1. "Can we add some cool fonts that would be built in, or at least suggested/loaded without
   uploading them each time?" → a self-hosted **font library** (P-lib) and a real **font picker**
   (P-picker).
2. "We need to be able to make the text smaller. I printed 'Hello' and it took 4 cm of tape. It
   uses the whole vertical space by default." A size control existed (Text size: Fit tape |
   Fixed mm), but the user did not find it. The 12 mm Wi-Fi sticker template is also 80 mm long,
   because its `{{ssid}}` text fits the tape height. → **text sizing** (P-size): point sizes,
   visible quick sizes, a smaller default for new text, shrink to fit length, crisp pixel fonts,
   and small templates.

The user designs on an **iPhone** (design only, WebKit, 375 px) and prints from a **Mac**
(Chrome or Edge). Printer: PT-P710BT, 180 dpi (1 dot = 0.141 mm). Printable band in dots:
3.5 mm 24, 6 mm 32, 9 mm 50, 12 mm 70, 18 mm 112, 24 mm 128. 1 pt = 1/72 in = 2.5 dots. Each
job wastes a leader of about 24 mm.

---

## 1. Rules for every package

1. **Edit only the files you own** (§4). If you need a change in a file you do not own, do not
   make it. Put the exact change (file, before/after) in your final report, and the lead applies
   it. You may add new files inside the directories you own.
2. **Lead-owned, frozen files** (in addition to the STUDIO-V1-PLAN §1.2 list):
   - `web/src/doc/schema.ts`, `web/src/doc/persist-migrate.ts`, `web/src/doc/persist-prefs.ts`;
   - `web/src/render/types.ts`, `web/src/render/index.ts`;
   - the type section of `web/src/render/font-catalog.ts` (everything above the "Data" line);
   - `web/src/ui/state/studio.svelte.ts`, `web/src/ui/state/text-defaults.ts`, `web/src/App.svelte`,
     `web/src/ui/editor/PropertiesPanel.svelte`;
   - `web/pwa.config.ts`, `web/scripts/entry-size.mjs`, `.github/workflows/**`;
   - `e2e/fonts-and-size-entry.spec.ts` (the lead's test: keep it green; the names it uses are
     frozen).
3. **No new runtime dependencies.** Font tooling is not shipped: use fontTools in a Python venv
   under the session scratchpad, with pinned versions (as in `public/fonts/SOURCES.md`).
4. **Licences and downloads (P-lib):**
   - Download from the **official upstream only**: the designer's repository, or
     `github.com/google/fonts` at a pinned commit. Record the URL, the commit or release and
     both SHA-256 sums.
   - Put each download in its own new, empty directory under
     `<scratchpad>/dl-fonts/`. Never execute downloaded content. Run Python with `-I`.
   - Never copy GPL code. Only OFL-1.1, Apache-2.0 or MIT-compatible font licences.
5. **No third-party requests at runtime.** The CSP stays `font-src 'self' blob: data:`. Every font
   is served from `web/public/fonts/`.
6. **Privacy:** no personal identifiers (printer Bluetooth name suffix or address). Never access a
   real printer, serial port or USB device. **Never commit or push.**
7. **Quality:**
   - keyboard operable, visible focus, labelled controls, WCAG AA contrast in light and dark;
   - `prefers-reduced-motion` respected;
   - works at 375 px and 360 px (no horizontal scroll, touch targets ≥ 44 px on coarse pointers)
     and on desktop;
   - match the surrounding style and comment density;
   - every new behaviour has unit tests, and every UI flow has a Playwright e2e test.
8. **Initial JS budget: 122,880 B gzipped.** This is the entry module plus every chunk
   `index.html` preloads (`node scripts/entry-size.mjs dist`, run by CI after the build). Today
   it is about 120.7 KB. Rolldown moved the shared code into a preloaded `studio.svelte-*.js`
   chunk once the property editors became lazy (§2.8), so the old `index-*.js`-only check
   undercounted. Large UI (the picker popover, the font catalogue UI) loads on first use.
9. **Definition of done:** no `STUB` left in your files, and all of these pass:
   ```sh
   cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
   cargo test --workspace
   cd web && npm run wasm && npm run check && npm test
   PW_CHANNEL=chrome npx vitest run --project browser
   npx playwright test && BASE_PATH=/ptouch/ npm run build && node scripts/entry-size.mjs dist
   ```
10. **Snapshots:** text snapshots are per OS (`<name>.macos.pbm` recorded locally,
    `<name>.linux.pbm` recorded in Docker, see STUDIO-V1-PLAN §1.10). Prefixes: `lib-` (P-lib)
    and `size-` (P-size). Existing snapshots stay byte-identical. That is the proof that old
    labels render the same. P-size's changes to sizing must not change any existing snapshot.

## 2. Frozen contracts (implemented by the lead)

### 2.1 Schema 3 — `web/src/doc/schema.ts`

`SCHEMA_VERSION = 3`.

- **`TextSize = ItemSize | {mode:'pt', pt}`.** `TextItem.size` is a `TextSize`. `pt` is the em
  size of each line, as in P-touch Editor or a word processor: 1 pt = 1/72 in = 2.5 dots at
  180 dpi. `{mode:'mm'}` keeps its meaning: the cap-to-descender height of the whole block.
  Icons, images and shapes keep `ItemSize`; a `pt` size on them is repaired to `fit`.
  `LIMITS.sizePt = {min: 4, max: 144}`. A malformed `pt` is reset to 12 with a notice.
- **`FONT_FAMILY_IDS`** (the `FontFamilyId` union) lists all 25 bundled ids (§3.1). The list is
  frozen: removing an id would turn labels that use it into Fira Sans. An unknown id is still
  repaired to `fira-sans` with a notice.
- **`LengthSettings` fixed gets `shrink?: boolean`** ("shrink to fit length"). It is written only
  when it is true and only for `mode:'fixed'`, so labels without it keep their exact JSON.
- `createItem('text')` still makes `size: {mode:'fit'}`, Fira Sans 600. The **user's** default is
  applied by the Studio (§2.6), so templates, tests and old code paths do not change.

### 2.2 Migration — `web/src/doc/persist-migrate.ts`

`MIGRATIONS[2]` only changes `schema` from 2 to 3. Every schema-2 label is the same object after
migration, so it renders pixel-identically (`tests/unit/persist/migrate.test.ts`; fixture
`tests/unit/persist/fixtures/schema-3.json`). An app that still runs schema 2 opens a schema-3
label **read-only**, through the existing "made by a newer version" path, instead of silently
turning a point size or a library font into something else.

### 2.3 Preferences — `web/src/doc/persist-prefs.ts`

| Field | Type | Default | Notes |
|---|---|---|---|
| `defaultFont` | `{family: FontFamilyId, weight: FontWeight}` | Fira Sans 600 | bundled only: a custom font may be missing on another device |
| `defaultTextSize` | `DefaultTextSize = 'auto' \| 'fit' \| 'half' \| 'third' \| {pt}` | `'auto'` | §3.3 |
| `favoriteFonts` | `FontKey[]` | `[]` | ≤ `MAX_FAVORITE_FONTS` (50), in starring order |
| `recentFonts` | `FontKey[]` | `[]` | ≤ `MAX_RECENT_FONTS` (8), most recent first |

- `FontKey` is `b:<FontFamilyId>`, `u:<content ref>` or `l:<PostScript name>`. These are the
  values the v1 select used. `isFontKey(v)` validates a key; unknown bundled ids and unsafe local
  names are dropped. Keys of uploaded or local fonts can point at fonts that are gone; the picker
  skips them.
- Sanitising works field by field, as before.
- Saving: `studio.updatePrefs(patch)`.

### 2.4 Font registry and loader — `web/src/render/font-catalog.ts`, `web/src/render/fonts.ts`

```ts
type FontCategory = 'sans' | 'condensed' | 'industrial' | 'rounded' | 'handwritten' | 'stencil' | 'typewriter' | 'pixel' | 'accessible' | 'mono'
const FONT_CATEGORIES: readonly { id: FontCategory; label: string }[]   // display order
type FontLicense = 'OFL-1.1' | 'Apache-2.0'
interface FontDef {
  id: FontFamilyId
  family: string                 // always `ptouch ${label}` (private: a system copy never stands in)
  label: string
  category: FontCategory
  weights: FontWeight[]
  files: Partial<Record<FontWeight, string>>   // relative to `${BASE_URL}fonts/`
  license: FontLicense
  licenseFile: string            // next to the files
  hint: string                   // one line for the picker
  preview: string                // sample when the text block is empty
  generic: 'sans-serif' | 'serif' | 'monospace' | 'cursive'   // drawn when the face failed to load
  core: boolean                  // precached; false = loaded on first use
  pixel?: { emPx: number }       // design pixels per em
  quality?: 'thin' | 'script'    // print-quality hint below MIN_QUALITY_CAP_MM (3 mm cap height)
  condensed?: boolean
}
const FONTS: readonly FontDef[]  // core four first; FONTS[0] is the fallback for unknown ids
findFont(id): FontDef | undefined; coreFontFiles(): string[]; CODE_TEXT_FONT; MIN_QUALITY_CAP_MM = 3
```

The loader is in `fonts.ts`. Everything is re-exported from `render/index.ts`.

- `loadFamily(id, weight = 400): Promise<boolean>`: loads the face the weight resolves to
  (`resolveWeight`, the nearest file). It loads once per page, concurrent calls share one
  request, and a failure is retried on the next call. It resolves `true` when the face is usable.
- `familyReady(id, weight)`: synchronous, makes no request.
- `familyLoading(id, weight)`: `true` while the face is being fetched (for the spinner).
- `ensureFonts(doc)`: unchanged; it uses the same cache. The renderer awaits it, so a lazy family
  used in a label loads before the render. A family that cannot load (offline before it was ever
  cached) gives the existing `font-fallback` warning and draws with `def.generic`.
- `fontDef(id)` falls back to `FONTS[0]` for an id without an entry, so a schema id that P-lib has
  not filled in yet draws with Fira Sans.

### 2.5 Service worker — `web/pwa.config.ts`

- **Precache:** only the core families, with the glob
  `fonts/{FiraSans,ArchivoNarrow,JetBrainsMono,AtkinsonHyperlegible}-*.woff2`.
- **Runtime:** `/\/fonts\/[A-Za-z0-9_-]+\.woff2$/` → `CacheFirst`, cache `ptouch-fonts`,
  `maxEntries 100`, status 200 only. A library font that was used once also works offline.
- `tests/unit/render/font-catalog.test.ts` checks that the glob matches exactly
  `coreFontFiles()` and no library file, and checks the runtime rule.
- **Rule for P-lib:** a library file **never changes content under the same name**. CacheFirst
  has no revisions, so new bytes need a new file name. Library file names must not start with a
  core family prefix.

### 2.6 Text defaults and Studio — `ui/state/text-defaults.ts`, `ui/state/studio.svelte.ts`

- `resolveDefaultTextSize(pref, tapeWidthMm, bandDots, dpi): TextSize` and
  `newTextDefaults(prefs, tapeWidthMm, bandDots, dpi): {fontFamily, fontWeight, size}`. These
  are pure.
- `FALLBACK_BAND_DOTS` is the PT-P710BT band per tape width. It is used before the wasm core
  (and with it the exact print area) has loaded.
- `AUTO_HALF_MIN_TAPE_MM = 12`.
- Studio:
  - `textDefaults(doc = this.doc)`: the band comes from `itemSizingBand` when the print area
    matches the doc's tape, else from the fallback table;
  - `insert('text', patch)` applies `textDefaults()` **before** `patch`;
  - `newLabel()` and the first-run label get a text block with the defaults;
  - `updatePrefs(patch)` saves preference fields.
- Opening, importing or sharing a label never changes its items.

### 2.7 Quick sizes — `web/src/render/text-size.ts` (P-size owns the bodies)

```ts
type QuickSizeId = 'xs' | 's' | 'm' | 'l' | 'fit'
interface QuickTextSize { id; label: 'XS'|'S'|'M'|'L'|'Fit'; name: 'Extra small'|'Small'|'Medium'|'Large'|'Fit tape'; size: TextSize; dots: number; tooSmall: boolean }
QUICK_FRACTIONS = { xs: 1/4, s: 1/3, m: 1/2, l: 3/4 }   // of the band, for the whole block
MIN_READABLE_DOTS = 14                                   // 2 mm, the renderer's small-text limit
quickTextSizes(bandDots, dpi): QuickTextSize[]          // XS, S, M, L, Fit
matchQuickSize(size, bandDots, dpi): QuickSizeId | undefined
```

- A quick size is stored as an ordinary `{mode:'mm'}` size: the block's cap-to-descender
  height, snapped to whole dots and rounded to 0.01 mm (it round-trips through `mmToDots`).
  This makes it font-independent, and it always fits the band.
- Once chosen, it is a fixed physical size. Changing the tape later keeps it.
- On 12 mm tape: XS 18, S 23, M 35, L 53 and Fit 70 dots.
- P-size may tune the fractions or the minimum, but must update the tests and this table.

### 2.8 Render info, warning, and UI entry points

- `render/types.ts`: the new warning code `font-quality` (P-size emits it), and
  `RenderResult.texts?: TextRenderInfo[]` with `{itemId, emDots, capDots, widthDots, shrink?,
  pixelScale?}` per non-empty text block. P-size fills `texts`; the picker reads it (quality hint,
  "crisp" badge) and so do the quick sizes (length estimates).
- `render/text.ts`: `ptToPx(pt, dpi, f)`. `fitTextBlock` takes `{fit:false, emPx}` for point
  sizes. The renderer already draws `pt` sizes (`tests/browser/render.browser.test.ts` "size in
  points").
- `ui/common/SizeField.svelte`: `allowPt` adds a "Points" mode with a "Font size" field in pt.
  The other blocks keep "Fit tape" / "Fixed".
- **`ui/fonts/FontPicker.svelte`** (P-picker): it is mounted in TextProps. Its props are frozen:
  - `item: TextItem`;
  - `id: string`, the control the "Font" label points at: the picker's trigger must keep the
    accessible name **"Font"**;
  - `describedby?: string` (the "not on this device" note);
  - `onchange(patch: FontPatch)`.

  `ui/fonts/font-choice.ts` provides `FontPatch`, `fontKeyOf`, `familyPatch`, `pushRecent` and
  `toggleFavorite`. The stub is the v1 select, moved unchanged; it records recent fonts.
- **`ui/editor/props/TextSizeQuick.svelte`** (P-size): its props are frozen: `item: TextItem`,
  `variant: 'props' | 'compact'`. It is mounted twice:
  - in TextProps above the size field, as the group **"Quick text size"**;
  - in `App.svelte` under the preview while a text block is selected, as the group **"Text size
    of the selected block"**.

  The buttons are named "Extra small", "Small", "Medium", "Large" and "Fit tape", and use
  `aria-pressed`. The stub works but has no length readout.
- **`PropertiesPanel.svelte`**: only `TextProps` is in the entry chunk. The icon, code, image,
  shape and spacer editors load the first time such a block is selected; the service worker
  precaches their chunks. This made room for this round (initial JS 120.7 KB).

## 3. Decisions

### 3.1 The font library (P-lib verifies each line)

25 families: the 4 existing core ones plus 21 library ones. The ids are frozen. Weights are a
suggestion; keep only the useful ones (≤ 3). A variable font is instanced with
`fontTools.varLib.instancer`.

| id | Family | Category | Weights | Expected licence | Flags | Upstream (pin a commit) |
|---|---|---|---|---|---|---|
| `oswald` | Oswald | condensed | 400, 700 | OFL | condensed | google/fonts `ofl/oswald` or googlefonts/OswaldFont |
| `bebas-neue` | Bebas Neue | condensed | 400 | OFL | condensed, caps only | google/fonts `ofl/bebasneue` (Dharma Type) |
| `barlow-condensed` | Barlow Condensed | condensed | 500, 700 | OFL | condensed | jpt/barlow |
| `anton` | Anton | condensed | 400 | OFL | condensed | google/fonts `ofl/anton` |
| `barlow` | Barlow | industrial | 400, 600 | OFL | | jpt/barlow |
| `b612` | B612 | industrial | 400, 700 | OFL (B612 is dual EPL/OFL; ship it under OFL) | | polarsys/b612 or google/fonts `ofl/b612` |
| `nunito` | Nunito | rounded | 400, 700 | OFL | | google/fonts `ofl/nunito` |
| `fredoka` | Fredoka | rounded | 400, 600 | OFL | | google/fonts `ofl/fredoka` |
| `quicksand` | Quicksand | rounded | 500, 700 | OFL | `thin` at 500 | google/fonts `ofl/quicksand` |
| `caveat` | Caveat | handwritten | 400, 700 | OFL | `script` | google/fonts `ofl/caveat` |
| `permanent-marker` | Permanent Marker | handwritten | 400 | **Apache-2.0** | | google/fonts `apache/permanentmarker` |
| `pacifico` | Pacifico | handwritten | 400 | OFL | `script` | google/fonts `ofl/pacifico` |
| `big-shoulders-stencil` | Big Shoulders Stencil (check the current upstream name) | stencil | 700 (+ 400) | OFL | condensed | google/fonts / xotypeco/big_shoulders |
| `saira-stencil-one` | Saira Stencil One | stencil | 400 | OFL | | google/fonts `ofl/sairastencilone` |
| `special-elite` | Special Elite | typewriter | 400 | **Apache-2.0** | | google/fonts `apache/specialelite` |
| `courier-prime` | Courier Prime | typewriter | 400, 700 | OFL | generic `monospace` | google/fonts `ofl/courierprime` |
| `roboto-slab` | Roboto Slab | typewriter | 400, 700 | OFL (was Apache; check) | generic `serif` | google/fonts `ofl/robotoslab` |
| `silkscreen` | Silkscreen | pixel | 400, 700 | OFL | `pixel` | google/fonts `ofl/silkscreen` |
| `vt323` | VT323 | pixel | 400 | OFL | `pixel` | google/fonts `ofl/vt323` |
| `pixelify-sans` | Pixelify Sans | pixel | 400, 700 | OFL | `pixel` | google/fonts `ofl/pixelifysans` |
| `lexend` | Lexend | accessible | 400, 700 | OFL | | google/fonts `ofl/lexend` |

- **D-DIN is dropped.** Datto released it under the OFL, but only as downloads on font
  aggregators. There is no official, versioned upstream repository, so we cannot pin its
  provenance as §1.4 requires. Barlow (industrial, DIN-like) and B612 cover that look.
- **Reserved Font Names.** Read every `OFL.txt` and copyright line for "with Reserved Font Name".
  Subsetting is a modification under the OFL (OFL-FAQ). A family with an RFN must therefore be
  either:
  - (a) shipped **unmodified**, the upstream woff2 byte-identical, when it is reasonably small
    (≤ about 150 KB per face); or
  - (b) renamed per the OFL. The new name must not contain the RFN, in the name table **and** in
    the picker label.

  Prefer (a). If neither is acceptable, drop the family and record why. For a family dropped or
  substituted, report to the lead: the id stays in `FONT_FAMILY_IDS` with no catalogue entry (it
  draws as Fira Sans), or the lead renames it before the release.
- **Apache-2.0 fonts:** ship `Apache-<Family>.txt` (the upstream LICENSE) next to the files.
  `assets.test.ts` checks the licence text by `def.license`.
- **Subsetting:** the same `pyftsubset` command and unicode range as `SOURCES.md`. Pixel fonts
  usually cover far less; subset to what they have. Record the upstream URL, commit, path,
  upstream SHA-256 and bundled SHA-256 per file, and the RFN finding per family.
- **Size:** aim for ≤ 80 KB per file and ≤ 1.5 MB for the whole library. Report the total.
- **Pixel `emPx`:** measure it from the font. It is the number of design pixels per em: take the
  greatest common divisor of the outline coordinates in font units, then
  `emPx = unitsPerEm / gcd`. Check it with a render: at `k × emPx` dots per em, every glyph edge
  lies on a whole dot. Put the measurement in SOURCES.md.

### 3.2 The picker (P-picker)

- **The trigger** is a button named "Font". It shows the current font in that font and opens:
  - a **popover** on desktop;
  - a **bottom sheet** at ≤ 600 px (with the safe-area insets).

  The content is a **lazy chunk**, loaded on the first open (§1.8).
- **The content:**
  - a search field (`role="combobox"`, `aria-controls` the listbox, `aria-activedescendant`);
  - category filter chips (toggle buttons with `aria-pressed`);
  - one listbox with groups (`role="group"`, labelled), in this order: **Favourites**,
    **Recent**, then the categories, then **Your fonts** (uploaded), then **This computer**
    (local, "varies by machine"), then "Manage fonts…".
- **Rows:**
  - each row previews the block's own text (the first line, trimmed to about 24 characters) or
    `def.preview` / the family name, drawn in that font;
  - library previews load lazily (`loadFamily` as rows scroll into view, at most 4 at a time);
  - a spinner (respecting reduced motion) shows while `familyLoading`.

  Choosing a font that is not loaded still applies at once. The renderer waits for the font, and
  the preview shows the existing "rendering" state.
- **Keyboard:**
  - ↑/↓, Home/End and type-ahead through the search field;
  - Enter picks; Escape closes and returns focus to the trigger;
  - **f** (or a "Star" button outside the option) toggles the favourite of the active row.

  Options must not contain focusable children (listbox pattern). The accessible name says
  "favourite".
- **Hints:**
  - quality: when `studio.render.warnings` has `font-quality` for the item, the picker and the
    text properties say so in words, e.g. "Thin strokes print poorly below 3 mm; try M or
    larger";
  - "crisp" badge: shown for a pixel font when `render.texts[i].pixelScale` is set.
- **Default font:** "Use for new text" in the picker footer sets `prefs.defaultFont` (the current
  family and weight; bundled fonts only).
- **"Your fonts":** uploaded and local fonts from v1 appear in the same picker, and "Manage
  fonts…" opens the font manager.

### 3.3 Text sizing (P-size) — and the default size

- **Default size for new text: `'auto'`.** That is **Fit on 3.5–9 mm tape, and M (half the band)
  on 12 mm and wider.**
  - On narrow tape the whole band is 3.4–7 mm. Fit is already a normal reading size, and half of
    it would fall under the 2 mm legibility limit.
  - From 12 mm up, Fit makes text 10–18 mm tall. The user's "Hello" took about 40 mm of 12 mm
    tape. Half the band is 5 mm on 12 mm and 9 mm on 24 mm. That is still easy to read and about
    halves the length of short words. On 24 mm, the first-run "Label" prints 27.8 mm long at M;
    at Fit it is more than twice as long.
  - Only new text blocks get it. Existing labels and templates are unchanged.
  - The first-run label uses it too, because that is where the user met the problem.
  - The preference offers Auto, Fit, Half (M), Third (S) and a point size. It is set from the
    size UI: "Use for new text".
- **Point sizes:** they are in the size field now (Fit tape / Fixed / Points). P-size may
  restructure the size UI (owned) but keeps the names in `e2e/fonts-and-size-entry.spec.ts`.
- **Quick sizes:** in the text properties and under the preview. Each button shows the label
  length it would give. An estimate from `render.texts` is fine: the width scales with the em,
  so the length changes by `widthDots × (ratio − 1)`. Mark it "≈". Show `tooSmall` in words.
- **Shrink to fit length** (`length.shrink`): it is offered when the length is Fixed. Text
  blocks scale down by one common factor (never up) until the flow content fits; codes, icons and
  images keep their size. Report the factor in `texts[i].shrink`. Keep the overflow warning when
  the label still does not fit.
- **Pixel fonts:**
  - snap the em to `k × emPx` dots: the largest k that fits for Fit, and the nearest k for mm/pt
    (k ≥ 1);
  - put glyph origins and baselines on whole dots, and draw so that every font pixel maps to
    whole dots;
  - check with an exact bitmap snapshot (`size-pixel-*`).
- **Templates:** use fixed sizes, so stickers are small:
  - the **12 mm Wi-Fi sticker** must print ≤ 40 mm (about 30–40 mm) with the SSID
    "MyHomeNetwork": the QR plus the network name on one or two small lines;
  - the 24 mm variant should keep a similar ratio;
  - review every template for wasted tape;
  - the gallery card shows each template's printed length, from the thumbnail render.
- **A fixed-size text block taller than the band:** P-size decides whether to reduce it to the
  band, as icons are (warning "was reduced"), instead of clipping it. Rationale: the tape can
  change after a quick size was chosen. Old labels that render correctly must not change.

## 4. Packages and ownership

| | P-lib (S1, font library) | P-picker (S2, font picker) | P-size (S3, text sizing) |
|---|---|---|---|
| **Source** | `web/public/fonts/**` (files, `SOURCES.md`, licence texts); `web/public/licenses/index.html` (the fonts line); the **Fonts section** of `web/THIRD_PARTY.md`; the **data** part of `web/src/render/font-catalog.ts`; `web/src/render/fonts.ts` (loader) | `web/src/ui/fonts/**` (FontPicker and its lazy body, `font-choice.ts`, FontManager, `local-fonts.svelte.ts`) | `web/src/render/text.ts`; `web/src/render/text-size.ts` (bodies); in `web/src/render/renderer.ts` the text parts (`prepareText`, a shrink-to-fit pass, pixel snapping, filling `texts`, the `font-quality` warning); `web/src/ui/common/SizeField.svelte`; `web/src/ui/editor/props/TextProps.svelte`; `web/src/ui/editor/props/TextSizeQuick.svelte`; `web/src/ui/editor/props/LabelProps.svelte` (the shrink option); `web/src/ui/templates/**` |
| **Tests** | `tests/unit/render/assets.test.ts`; new `tests/unit/render/font-library.test.ts`; `tests/browser/font-library.browser.test.ts` (snapshots `lib-*`); `e2e/font-library.spec.ts` | `tests/unit/ui/font-choice.test.ts`; new `tests/unit/ui/font-picker*.test.ts`; `e2e/font-picker.spec.ts`; the font-select lines of `e2e/fonts-export-history.spec.ts` (switch them to the picker) | `tests/unit/render/text.test.ts`, `text-size.test.ts`; new `tests/unit/render/shrink*.test.ts`; `tests/unit/ui/templates.test.ts`; `tests/browser/text-size.browser.test.ts` (snapshots `size-*`), `tests/browser/templates.browser.test.ts`; `e2e/text-size.spec.ts`, `e2e/templates.spec.ts` |
| **Uses** | §2.4, §2.5 | §2.3, §2.4, §2.8 (`texts`, `font-quality`), `studio.updatePrefs`, `studio.fonts`, `studio.render` | §2.1, §2.3, §2.6, §2.7, §2.8, `FontDef.pixel` and `quality` |

### P-lib — tasks and acceptance

- Download, verify (licence, RFN), subset or ship unmodified, and document every family in §3.1.
- Fill a `FONTS` entry per id. Keep the core four first and unchanged (their snapshots must not
  move).
- Licence texts go next to the files. Add a THIRD_PARTY.md row and a licences page link per
  family, grouped by licence.
- Loader:
  - check that `ensureFonts` + `loadFamily` work for lazy families under `/ptouch/`;
  - check that a library family is **not** requested at startup (e2e: network log) and is
    requested **once** when used;
  - if feasible: after first use, the label renders offline (`context.setOffline(true)` + the
    service worker of the production build).
- Tests:
  - unit: every schema id has an entry (or is listed as dropped with a reason), and the file,
    hash and licence checks extend to the library;
  - browser: every library family loads through `FontFace` and renders differently from Fira
    Sans; a pixel font at `k × emPx` has every glyph edge on whole dots (exact `lib-pixel-*`
    snapshot or a programmatic check).
- **Acceptance:** 21 families (or the documented subset) render offline after first use, with no
  third-party request at runtime. `SOURCES.md` records upstream URL, commit and both SHA-256 sums
  per file, plus the RFN finding per family. The licences page and THIRD_PARTY list every family.

### P-picker — tasks and acceptance

- Build §3.2: the lazy popover/sheet body, search, chips, groups, favourites, recent, previews,
  spinner, hints, default font, and "Your fonts" / "This computer" / "Manage fonts…".
- Record recent fonts on pick (`pushRecent`), favourites with `toggleFavorite`, and save with
  `studio.updatePrefs`.
- Tests:
  - unit: filtering, search (accent- and case-insensitive), grouping order, favourites/recent
    ordering, and skipping keys of fonts that are gone;
  - e2e:
    - keyboard only: open, search "mono", ↓, Enter → JetBrains Mono is applied, focus returns
      to the trigger;
    - star a font → it is listed under Favourites after a reload;
    - recent order;
    - an uploaded font appears under "Your fonts";
    - the 375 px bottom sheet has no horizontal scroll, touch targets ≥ 44 px, and closes with
      Escape and on backdrop tap;
    - the spinner shows while a slowed-down font request is pending.
- **Acceptance:** any font can be found and applied with the keyboard and with a screen reader
  (correct roles, names and active descendant). It works at 375 px and on desktop. The initial
  JS stays within budget.

### P-size — tasks and acceptance

- Build §3.3: point sizes, quick sizes with length readouts (both mounts), the default-size
  preference UI, shrink to fit length, pixel snapping, `texts` + `font-quality`, and the
  templates.
- Tests:
  - unit: the quick-size table per tape, the shrink factor maths, pixel-scale snapping and the
    template lengths (validate every template; the 12 mm Wi-Fi sticker ≤ 40 mm with
    "MyHomeNetwork");
  - browser:
    - pt sizes across fonts (the em is pt × 2.5 dots);
    - shrink keeps a long text inside a fixed 30 mm label;
    - an exact snapshot of a pixel font;
    - every existing snapshot is unchanged;
  - e2e:
    - choose S → the label gets shorter and the readout matches the preview length;
    - "Use for new text" → a new text block gets it;
    - shrink on a fixed length;
    - the template gallery shows lengths;
    - 375 px layout.
- **Acceptance:** on 12 mm tape a new "Hello" prints at most about 25 mm (not 40 mm). The size
  control is visible without scrolling in the text properties and under the preview. The 12 mm
  Wi-Fi sticker is 30–40 mm long. Old labels render byte-identically.

## 5. Integration order and conflicts

1. P-lib lands the catalogue data early: P-picker's previews and P-size's pixel snapping need
   real entries. Until then they use the four core fonts and fake `FontDef`s in their unit tests.
2. TextProps belongs to P-size. P-picker changes only `ui/fonts/**`; the mount line
   `<FontPicker {item} id=… describedby=… onchange=…/>` is frozen. If P-picker needs the weight
   select changed (for example to fold it into the picker), it asks P-size or the lead.
3. `renderer.ts`: P-size owns the text parts; nobody else edits it this round.
4. The lead integrates, runs §1.9, records Linux text snapshots in Docker, and checks the initial
   JS budget. Then the lead checks manually on the iPhone (picker sheet, quick sizes) and on the
   Mac (print "Hello" on 12 mm, print the Wi-Fi sticker, print a pixel-font label).

## 6. Integration (lead, 2026-10-08)

**Result.** 21 library families (D-DIN dropped, §3.1), the picker, and text sizing are in. Every
existing snapshot is byte-identical. Commands of §1.9: all green, including the browser project in
the Linux image and the WebKit "iPhone" projects in Docker.

**Initial JS budget.** With all three packages the startup JS was 123,949 B, over the 122,880 B
budget. The icon catalogue (`render/icons.ts`, about 8.6 KB gzipped) now loads on demand, like
the fonts:
- `render/icon-set.ts` adds `loadIcons()`/`loadedIcons()`;
- `renderLabel` awaits it when the label has an icon (if it cannot load: a blocking
  `image-missing` warning, never a blank print);
- the block list loads it for icon names, and `IconProps` (already lazy) imports it directly;
- the service worker precaches its chunk, so it works offline.
`tests/unit/render/icon-set.test.ts` keeps it out of the entry.

| | v1 (777e872) | this round |
|---|---|---|
| Initial JS (gzip -9, `scripts/entry-size.mjs`) | 122,058 B | 115,352 B |
| Precache | 46 entries, 1,411.5 KiB | 61 entries, about 1,456 KiB (13 core font files, as before) |
| Library fonts (lazy, runtime cache `ptouch-fonts`) | — | 34 files, 909,772 B, none precached |

**Fixes applied during integration.**
- **Font picker on iPhone.** A tap on a font in the bottom sheet did nothing in WebKit. The
  option's `pointerdown` handler cancelled the tap's click. It now cancels only mouse presses,
  which keeps focus in the search field. The new `webkit-sheets` Playwright project runs the
  "iPhone" blocks of `font-picker.spec.ts` and `text-size.spec.ts` in WebKit (CI:
  `PW_WEBKIT=1`).
- **Shrink setting.** Changing *Printed length* (`MediaBar`) kept the length but dropped
  *Shrink text to fit length*.
- **Quick sizes at 375 px.** The length readouts were cut off with an ellipsis ("≈ 18 …"). They
  now wrap instead.
- **Flaky test.** The points test in `fonts-and-size-entry.spec.ts` waits for the 12 pt render
  before setting 8 pt.
- **Docs and CI.**
  - `pages.yml` checks that every font licence the licences page links to is in the build.
  - THIRD_PARTY.md and the README no longer say the site makes no requests after loading.
    Library fonts are fetched from the site itself on first use, and never from third parties.

**Added tests.**
- `e2e/fonts-and-size-integration.spec.ts`:
  - a library font picked in the picker is requested only from `/ptouch/fonts/`, fetched once
    through the service worker, changes the preview, and works offline;
  - "Hello" at S is under 55 % of its Fit length on 24 mm;
  - the default size applies only to new blocks;
  - a pt size survives a reload and a share link;
  - shrink keeps text inside a 30 mm label (checked on the exported bitmap);
  - Silkscreen edges sit on its k-dot grid in the exported bitmap;
  - the 12 mm Wi-Fi sticker with "MyHomeNetwork" is 25–40 mm.
- `tests/browser/font-snapshots.browser.test.ts`: `lib-*` text snapshots of Oswald, Caveat,
  Special Elite and Lexend, recorded on macOS and Linux.

**Still to do.**
- Real-printer check on the Mac (§5.4).
- A manual check on a real iPhone. Picker sheet and quick sizes have only been tested in WebKit
  under Playwright.
- `actionlint` on the changed workflows. It is not installed locally; CI runs it.

## Review follow-ups (decisions)

- **Fira Sans (core):** its name table reserves "Fira" (nameID 0), so the five files are now the
  unmodified upstream WOFF2 files (byte-identical, SHA-256 in `SOURCES.md`); the RFN test covers
  the core families too. Precache grows by about 600 KB; rendering of covered text is unchanged.
- **Old labels stay pixel-identical:** the 2 → 3 migration marks fixed-size (mm) text `clipTall`,
  which keeps v1's clipping of text taller than the band; choosing a new size drops the flag.
- **Quick sizes follow the tape:** changing the tape width maps XS–L to the same quick size of the
  new band; an untouched label gets the new tape's default size.
- **Shrink to fit length:** never gives up below `MIN_SHRINK` (clamps, still reports the overflow);
  auto-module linear codes may drop to 1 dot when the text would otherwise shrink below half.
- **First-visit fonts offline:** an uncontrolled page sends the library font files it loaded to
  the worker (`CACHE_URLS`, `src/pwa/font-cache.ts`); the font route ignores `Vary`.

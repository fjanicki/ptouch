# ptouch studio — printer models (2 parallel packages)

Status: **contract layer landed by the lead, 2026-10-15** (§2, §7): schema 4, prefs, the Studio's
model state, the helpers in `ui/state/models.ts`, print gating, the any-model virtual printer, a
minimal model picker and unsupported-width notice, and `e2e/models-entry.spec.ts`. Every command
of §1.8 except the Linux Docker runs is green on that tree (§7). P-core-ui and P-render-templates
start from it. Base: fonts and size (`docs/FONTS-AND-SIZE-PLAN.md`); its §1 rules, the layering
rules in `web/tests/unit/layering.test.ts` and the snapshot procedure of STUDIO-V1-PLAN §1.10 still
apply.

User request: "can we make it more dynamic and not hard-code max 24mm so it can potentially work
with other models?"

The core already knows 27 models (`docs/models.toml`, exposed by `listModels()`): 180 dpi models
up to 24 mm (PT-P710BT, P715eBT, E560BT, D610BT, E720BT, E510, E550W, P750W, P700, H500, E500,
D600), up to 18 mm (E310BT, D460BT, D410, D450), up to 12 mm (P300BT, P300BTz, N25BT), and 360 dpi
models up to 36 mm (P910BT, E920BT, P900, P900W, P950NW, D800W, E800W, E850TKW). The studio used
none of that: it hard-coded the PT-P710BT. **Only the PT-P710BT is hardware-verified** (the user's
printer); every other model is "untested" in the UI.

Goal: everything tape-related follows the **active model's profile**: the connected printer's
model, else the remembered **"Design for"** model (default PT-P710BT).

---

## 1. Rules for every package

1. **Edit only the files you own** (§5). Need a change elsewhere? Put the exact change (file,
   before/after) in your final report; the lead applies it. New files inside your directories are
   fine.
2. **Lead-owned, frozen files** (in addition to the FONTS-AND-SIZE-PLAN §1.2 list):
   - `web/src/doc/schema.ts`, `web/src/doc/persist-migrate.ts`, `web/src/doc/persist-prefs.ts`,
     `web/src/doc/persist-history.ts` (the `PrintRecord` type);
   - `web/src/ui/state/studio.svelte.ts`, `web/src/ui/state/models.ts`,
     `web/src/ui/state/text-defaults.ts`, the `PrintGate` type in `web/src/ui/state/view-model.ts`;
   - `web/src/printer/connect.ts` (`virtualScenario`), `crates/ptouch-wasm/**`, `crates/ptouch/**`;
   - `e2e/models-entry.spec.ts` (keep it green; the names it uses are frozen, §4.9).
3. **Rust core:** `crates/ptouch` stays sans-IO / `no_std` and is not changed this round. Need a
   new binding? Ask the lead (small additions to `crates/ptouch-wasm` only; `npm run wasm`; clippy
   on `wasm32-unknown-unknown` stays clean).
4. **No new runtime dependencies.**
5. **Privacy:** never write the user's printer Bluetooth name suffix or address anywhere; examples
   use `PT-P710BTxxxx`. Never access a real printer, serial port or USB device. **Never commit or
   push.**
6. **Persisted data:** schema-3-and-older labels open and render pixel-identically (the lead's
   migration does nothing but bump the version). Do not re-record an existing snapshot unless
   rendering intentionally changed; say which and why in your report.
7. **Entry JS budget:** `scripts/entry-size.mjs`, 122,880 B gzipped. After the lead's layer it is
   **118,362 B** (+2,177 B over 116,185 B). Allowance: **P-core-ui ≤ +2,500 B**, **P-render-templates
   ≤ +1,000 B**; anything bigger is lazy-loaded (dialog bodies, the untested-model notice, template
   data stay in their lazy chunks). Measure with `BASE_PATH=/ptouch/ npm run build && node
   scripts/entry-size.mjs`.
8. **Quality and commands:** as FONTS-AND-SIZE-PLAN §1.7 (keyboard, labelled controls, AA contrast
   in both themes, 375 px / 360 px without horizontal scroll, ≥ 44 px touch targets on coarse
   pointers, surrounding style and comment density). Full command list, all green before you
   report:
   - `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings`;
     `cargo clippy -p ptouch-wasm --target wasm32-unknown-unknown -- -D warnings`;
     `cargo test --workspace`;
   - in `web/`: `npm run wasm`; `npm run check`; `npm test`;
     `PW_CHANNEL=chrome npx vitest run --project browser`; `npx playwright test`;
     `BASE_PATH=/ptouch/ npm run build && node scripts/entry-size.mjs`;
   - Linux (lead runs these at integration; packages may too): docker image
     `mcr.microsoft.com/playwright:v1.64.0-noble`, `-v /Users/fjanicki/Development/ptouch:/repo
     -v /repo/web/node_modules` (anonymous volume, so the macOS `node_modules` are not clobbered),
     `npm ci` inside, then the browser project and e2e with `PW_CHANNEL=chromium PW_WEBKIT=1`
     (full Chromium, never the headless shell). New or changed text snapshots need both
     `.macos.pbm` (local, `PW_CHANNEL=chrome`) and `.linux.pbm` (Docker, `PW_CHANNEL=chromium`).
   - Temp files and screenshots: the session scratchpad (`…/scratchpad`, screenshots in
     `scratchpad/screens/`).

---

## 2. Findings (scout, 2026-10-15)

### 2.1 What the core gives (`listModels()`, `printArea`, `mediaForWidth`, `mediaForStatus`)

- `ModelInfo`: `name`, `aliases`, codes, `usbPid?`, `dpi`, `headPins`, `bluetooth` (Classic SPP),
  `caps` (autoCut, chain, halfCut, mirror, highResolution, statusNotify) and `media[]`. **Missing
  before this round:** BLE and network transports. The lead added `ble` and `network` to the DTO
  (`crates/ptouch-wasm/src/dto.rs`, from core `Transports`; no core change).
- `media[]` per model: `kind` = `tze` | `hs2` | `hs3` | `sl` | `fle`, `widthMm`, `printPins`,
  margins, `tapeWidthDots`, `lengthMm` (FLe only). Continuous TZe widths across the table are
  exactly 3.5, 6, 9, 12, 18, 24 and 36 mm. Heat-shrink tube has odd widths (5.2–31 mm), SL is
  24/36 mm, FLe is one die-cut 21 × 45 mm label on 360 dpi models.
- **360 dpi renders correctly through `printArea`**: PT-P910BT 36 mm → `dpi 360, heightDots 454,
  tapeWidthDots 512, minLengthDots 29, maxLengthDots 14173`; 24 mm → 320 dots. The renderer, the
  quick sizes, point sizes, rulers, mm readouts, code module sizing and PNG/PDF export already
  take `dpi` and the band from the print area (checked: `render/**`, `ExportDialog`, `Preview`).
  Note that the same tape width has a different printable band per model: 24 mm is 128 dots
  (18.1 mm) on the PT-P710BT and 320 dots (22.6 mm) on the PT-P910BT.
- The virtual printer (`VirtualPrinter(model, mediaId)`) accepts any table model; its status
  frames carry that model's codes, so the connection reports it like a real printer.
- WebUSB requests vendor 0x04F9 (any model); Web Serial Bluetooth filters on the SPP UUID (any
  model). Nothing in the transports is PT-P710BT-specific except copy and the RFCOMM MTU default.

### 2.2 PT-P710BT / 24 mm assumptions in the studio

| Where | Assumption | Fixed by |
|---|---|---|
| `doc/schema.ts` `TapeWidthMm`, `TAPE_WIDTHS_MM`, `validateDoc` | 3.5–24 mm; 36 mm clamped to 24 | lead (schema 4) |
| `ui/state/studio.svelte.ts` `DEFAULT_MODEL`, `model`, `isTapeWidth`, `#sizingBand`, `useLoadedTape` copy "3.5–24 mm" | P710BT offline, P710BT band fallback | lead |
| `ui/state/text-defaults.ts` `FALLBACK_BAND_DOTS` (Record of TapeWidthMm) | P710BT bands | lead (`fallbackBand`) |
| `ui/media/MediaBar.svelte` widths from `TAPE_WIDTHS_MM` | fixed list | lead stub → P-core-ui |
| `ui/connect/ConnectDialog.svelte` subtitle, option hints, pairing steps | "Brother PT-P710BT", "cu.PT-P710BT…", "virtual PT-P710BT" | lead stub (virtual hint) → P-core-ui |
| `printer/problems.ts` `no-reply`/port hints | "cu.PT-P710BTxxxx" | P-core-ui |
| `printer/mock.ts` `DEFAULT_SCENARIO` | P710BT 24 mm | kept for tests; the Studio passes a scenario function (lead) |
| `ui/diagnostics/virtual.ts` `DEFAULT_MODEL`; `Diagnostics.svelte` width select `TAPE_WIDTHS_MM`, `widthMm = 24`, `conn.model ?? DEFAULT_MODEL` | P710BT | P-core-ui |
| `ui/editor/props/TextProps.svelte`, `TextSizeQuick.svelte` | `FALLBACK_BAND_DOTS[width]`, 180 dpi | lead (`fallbackBand`) |
| `render/text-size.ts` `MIN_READABLE_DOTS = 14` | 2 mm at 180 dpi (1 mm at 360) | P-render-templates |
| `render/export.ts`, `ExportDialog.svelte` comments "180 dpi" | comments only (code uses `area.dpi`) | P-render-templates |
| `render/units.ts` `mmToDots(mm, dpi = 180)` default | callers pass dpi; default stays | P-render-templates (audit callers) |
| `ui/templates/templates.ts` sizes, `QUICK_M_MM` (P710BT bands), widths 9/12/24 only | P710BT | P-render-templates |
| `ui/templates/TemplateThumb.svelte` `mediaForWidth(model, template.tapeWidthMm)` | throws for a width the model lacks (PT-P300BT + 24 mm template → broken thumbnail) | P-render-templates |
| `render/job.ts` `LEADER_MM = 24`, PrintBar/Batch/History "~24 mm leader" | P710BT leader (other models: unknown, see `docs/models.toml` quirks) | P-render-templates (keep 24 unless the table has a value; say "about") |
| `ui/editor/props/LabelProps.svelte` hint "at 180 dpi" | copy | P-render-templates |
| `e2e/**` chip `PT-P710BT · 24 mm` | virtual/stub printer is a P710BT | unchanged: the virtual printer of the default model still loads 24 mm |

---

## 3. Decisions

### 3.1 Schema 4 (bump: yes)

`TapeWidthMm` becomes `3.5 | 6 | 9 | 12 | 18 | 24 | 36`, `TapeSettings` gains `model?: string`,
`SCHEMA_VERSION = 4`. **Why bump:** a schema-3 app validating a 36 mm label maps it to 24 mm
("not a TZe width; using 24 mm") and its autosave writes that back: silent data loss. With the
bump the older app takes its newer-schema path and opens the label **read-only** (the first edit
forks a copy). Migration 3 → 4 only changes the version: nothing renders differently, so every
older label is pixel-identical (fixture `tests/unit/persist/fixtures/schema-4.json`, tests in
`migrate.test.ts`). `TAPE_WIDTHS_MM` is the universe of widths a *document* may have; which ones a
*printer* takes comes from its profile.

`tape.model` is informational: the model the width was last chosen for. The Studio writes it
whenever the tape width is set (tape picker, "Use loaded tape", a fresh label following the
cassette or the model, "Fit to …", `newLabel`), never on other edits, so older labels keep their
exact JSON until their width changes. It is used only to pick the stand-in model and to offer
"Design for PT-P910BT" when the active model lacks the width (§3.4). Unknown names are kept (a
newer table may know them); malformed ones are dropped with a notice.

### 3.2 Where the active model lives

- `prefs.designModel` (default `'PT-P710BT'`, additive, sanitized with `MODEL_NAME_RE`): the
  "Design for" model, remembered per browser, also the virtual printer's model.
- `Studio.model` = connected printer's model (`printerModel(conn)`: `conn.model ??
  conn.status.modelName` while the link is up), else `Studio.designModel` (= `prefs.designModel`
  resolved in the table; an unknown name falls back to `DEFAULT_MODEL` once the table is loaded).
  `Studio.modelSource` says which. A lost, silent or failed link keeps the old model in the
  snapshot until the next attach; it no longer counts (review fix), so the media bar shows the
  picker again and a pick takes effect, and the loaded tape is only used for the printer's model.
- Labels never change because the model changed, with one exception that already exists for the
  cassette: a **pristine** label (new and untouched) follows the model to the nearest width it
  takes (`#followModel`, on `setDesignModel`, at boot, and when a printer of another model
  connects, before its cassette is followed).
  - Integration: "pristine" means made here as a new label (first start, New label: `openDoc(…,
    { fresh: true })`) *and* untouched. Share links, imported files, templates and library
    labels also open with `createdAt === updatedAt` but never follow the model (they still follow
    a newly loaded cassette, with a toast and Undo, as before).
  - Following is a re-make, not an edit: no undo step, the label stays pristine (so a cassette
    loaded later still moves it), and its text gets the default size of the new model's band
    even when the width stays (M of a 180 dpi band is not M of a 360 dpi one).
  - Review fix: `prefs.freshLabelId` remembers that the last label was made as a new one, so a
    re-made label that was autosaved is still pristine after a reload.
  - Review fix: retaping (`#retaped`: tape picker, "Use loaded tape", following a cassette)
    measures a text block's old size in the band it was made in: `tape.model`'s (a label without
    one: the PT-P710BT's) when the size is a quick size or the default there, else the active
    model's. So M stays M, and an untouched label's default becomes the new default, across a
    180 → 360 dpi model change too.

### 3.3 Widths per model

`tapeWidthsOf(info)` = continuous **TZe** media of the model (kind `tze`, no `lengthMm`) that are
in `TAPE_WIDTHS_MM`, ascending. Results: 3.5–24 (P710BT and the other 24 mm models), 3.5–18
(D410/D450/D460BT/E310BT), 3.5–12 (P300BT, P300BTz, N25BT), 3.5–36 (360 dpi models). Before the
table loads: `FALLBACK_TAPE_WIDTHS` (the PT-P710BT's).

**Left out:** heat-shrink tube (hs2/hs3), self-laminating (sl) and FLe die-cut labels. The core
models them, but the document has no tube or die-cut concept: tube widths are not TZe widths
(11.7 mm, 23.6 mm…) and FLe needs a fixed 45 mm label with its own feed. Loading one still works
as before: the chip shows it, `useLoadedTape` says it can't be designed for yet (now with the
model's real width range). A later round can add `TapeKind` to the document.

### 3.4 A label on a width the active model does not take

`Studio.widthSupport` (§4.4) is `{ ok: false, … }`. Then:

- **Nothing changes silently.** The label keeps its width (and its items).
- **Notice** (`role="alert"`, in the media bar, replaces the tape-mismatch banner):
  "This label is 36 mm; PT-P710BT takes up to 24 mm." (`unsupportedWidthText`; a gap in the widths
  reads "…; PT-X doesn’t take 9 mm tape.") with a primary button **"Fit to 24 mm"**
  (`studio.fitToModel()`: retapes to `nearest`, quick sizes follow the new band, one undo step).
  When no printer is connected and the label's `tape.model` takes the width, a second button
  "Design for PT-P910BT" (`studio.setDesignModel(doc.tape.model)`) — P-core-ui.
- **Preview** keeps showing the label, rendered with the **stand-in model** (`widthSupport.standIn`:
  `tape.model` when it takes the width, else the first table model that does). Export (PNG/PDF)
  therefore exports the label at the stand-in's resolution (it says so in its "Resolution" row).
- **Print is blocked**: `printBlockReason` returns "This label is 36 mm; PT-P710BT takes up to
  24 mm. Fit it to 24 mm to print it." before any connection reason. History reprint and batch go
  through the same gate. (The encoder would also refuse: `UNSUPPORTED_MEDIA`.)
- The tape picker lists only the active model's widths; none is checked while unsupported.

### 3.5 Virtual printer ("No printer")

Any table model. The connect dialog's "Printer model" picker sets `prefs.designModel`; "No
printer" then starts a virtual printer of that model with its **widest TZe tape** loaded (24 mm on
the PT-P710BT, as before; 36 mm on the PT-P910BT), through `ConnectionManagerOptions.virtualScenario`
as a function (`virtualScenarioFor`, ui/state/virtual-printer.ts, shared with the Diagnostics
probe). A pristine label follows the cassette like with a real printer; a designed one gets
the mismatch banner. Changing the model while a virtual printer is connected needs a disconnect
(the connected printer always wins).

### 3.6 Model picker UX ("Printer model")

- A native `<select>` (accessible, works on iPhone) labelled **"Printer model"**, with two groups
  (`modelPickerGroups`): "Connects from this browser" (USB or Bluetooth Classic: `modelReach ===
  'browser'`; "Connect from Chrome or Edge on a computer" where this browser reaches no printer at
  all, e.g. iPhone, Safari) and "Design only (a browser can’t connect)" (PT-N25BT: Bluetooth LE
  only; any network-only model). Option
  text: `PT-P910BT · up to 36 mm`, `· tested` for verified models. Below it, `reachNote(info)` for
  a design-only model ("Bluetooth LE only: a browser can’t connect to it. Design and export labels
  here.").
- Shown in the connect dialog under the options (always, so "No printer" uses it) and in the media
  bar while `modelSource === 'design'`. While a printer is connected the media bar shows the
  printer's model instead (P-core-ui: "Designing for PT-P710BT (connected)").
- Design-only models stay fully usable for designing, exporting, sharing and hand-off.
- **USB first** guidance stays (support.paths order, "Most reliable" hint).

### 3.7 Untested-model notice

When a **real** (not virtual) printer of a model other than the verified ones connects
(`Studio.untestedModel`), show a short, dismissible notice (role `status`): "PT-P910BT hasn’t been
tested with ptouch studio yet. Printing should work; if anything looks wrong, please report it."
with "Open Diagnostics" (`studio.setView('diagnostics')`) and "Report an issue" (a GitHub issue
link with the model in the title, no identifiers) and "Dismiss" (`studio.dismissUntestedModel()`,
remembered per model in `prefs.dismissedUntested`). Lazy-loaded (budget).

### 3.8 Connect dialog and copy

Model-generic: "Brother P-touch label printer (e.g. PT-P710BT) over USB or Bluetooth…"; pairing
steps say "your printer (e.g. **PT-P710BTxxxx**)" and "cu.<printer name>"; "No printer" hint
"Design and test with a virtual <designModel>." (done). Problems copy in `printer/problems.ts`
the same way. Keep USB-first.

### 3.9 Templates

- Every template keeps its id, design and pixel output on its own width (existing template
  snapshots must not move).
- **36 mm variants** of the templates where 36 mm makes sense: Wi-Fi sticker, shelf/bin label,
  name tag, folder spine (P-render-templates designs them for the 360 dpi band: 454 dots = 32 mm).
- The gallery shows the templates whose width the **active model** takes. Others are behind
  "Show templates for other tape widths", marked "Needs 24 mm tape · PT-P300BT takes up to
  12 mm"; opening one is allowed and lands on the unsupported-width notice (§3.4), never broken.
- Thumbnails render with the active model when it takes the width, else with the stand-in
  (`standInModel`), so no thumbnail throws.
- Quick-size M in templates: `build(band?)` takes the band it is opened on, so "M" is M on any
  model's band; `build()` without a band stays byte-identical to today (§4.8).

### 3.10 360 dpi rendering (P-render-templates)

Everything takes `area.dpi`; remaining work: `MIN_READABLE_DOTS` becomes a physical minimum
(2 mm, compared through `dpi`), hints that say "at 180 dpi" say "at <dpi> dpi", and an audit that
no caller relies on `mmToDots`'s default dpi. Add browser snapshots of a 36 mm label at 360 dpi
(text, QR auto module, ruler) on both OSes.

### 3.11 Carry-through

- **History:** `PrintRecord.model` (additive) records the model printed on; the history dialog
  shows "24 mm · PT-P910BT" when it differs from the active model. Reprint goes through the
  normal print gate (blocked with the notice when the connected model lacks the width).
- **Batch:** uses `studio.target` (stand-in never prints: blocked). Nothing model-specific.
- **Export, share links, hand-off, files:** carry the doc (width + `tape.model`); the receiver
  renders for its own active model and shows §3.4 when it lacks the width. The iPhone design-only
  mode uses the media-bar picker (no connection possible): pick PT-P910BT on the phone, design
  36 mm, hand off; the Mac connected to a P910BT prints it, a Mac with PT-P710BT shows the notice.
  The hand-off subtitle names the active model only when it takes the label's width; otherwise
  the model the label was made for (the stand-in) plus the notice text (`handoffModel`).
- **Tape usage counter:** keyed by width, already width-agnostic (36 mm works).

---

## 4. Frozen contracts (implemented by the lead)

### 4.1 Schema 4 — `web/src/doc/schema.ts`

```ts
export const SCHEMA_VERSION = 4 as const
export type TapeWidthMm = 3.5 | 6 | 9 | 12 | 18 | 24 | 36
export const TAPE_WIDTHS_MM: readonly TapeWidthMm[] // [3.5, 6, 9, 12, 18, 24, 36]
export interface TapeSettings {
  widthMm: TapeWidthMm
  mediaId?: string
  /** Model the width was last chosen for (schema 4, informational). */
  model?: string
  colors?: { tape: string; ink: string }
}
/** A model name as the core's table spells it. */
export const MODEL_NAME_RE: RegExp // /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/
```

### 4.2 Migration — `web/src/doc/persist-migrate.ts`

`MIGRATIONS[3] = (raw) => ({ ...raw, schema: 4 })`. Fixture `schema-4.json` (36 mm, PT-P910BT).

### 4.3 Preferences — `web/src/doc/persist-prefs.ts` (additive)

```ts
export const DEFAULT_DESIGN_MODEL = 'PT-P710BT'
export const MAX_DISMISSED_MODELS = 40
interface Prefs {
  // …existing…
  /** "Design for" model; also the virtual printer's model. */
  designModel: string
  /** Models whose "untested model" notice was dismissed. */
  dismissedUntested: string[]
  /** The last label was made here as a new one (review fix, §3.2). */
  freshLabelId?: string
}
```

History record — `web/src/doc/persist-history.ts`: `PrintRecord.model?: string` (written by
`Studio.print`).

### 4.4 Models — `web/src/ui/state/models.ts` (new, pure, unit-tested)

```ts
export const DEFAULT_MODEL: string // = DEFAULT_DESIGN_MODEL
export const VERIFIED_MODELS: readonly string[] // ['PT-P710BT']
export const FALLBACK_TAPE_WIDTHS: readonly TapeWidthMm[] // [3.5, 6, 9, 12, 18, 24]
export type ModelReach = 'browser' | 'ble-only' | 'network-only' | 'none'
export function findModel(models: readonly ModelInfo[], name: string | null | undefined): ModelInfo | undefined
export function tapeWidthsOf(info: ModelInfo): TapeWidthMm[]
export function modelReach(info: Pick<ModelInfo, 'usbPid' | 'bluetooth' | 'ble' | 'network'>): ModelReach
export function reachNote(info: Pick<ModelInfo, 'usbPid' | 'bluetooth' | 'ble' | 'network'>): string | null
export function isVerifiedModel(name: string): boolean
export interface WidthSupported { ok: true }
export interface WidthUnsupported {
  ok: false
  model: string
  widthMm: TapeWidthMm
  widths: readonly TapeWidthMm[]
  maxMm: TapeWidthMm
  nearest: TapeWidthMm
  standIn: string | null
  message: string // "This label is 36 mm; PT-P710BT takes up to 24 mm."
}
export type WidthSupport = WidthSupported | WidthUnsupported
export function unsupportedWidthText(model: string, widthMm: number, widths: readonly number[]): string
export function standInModel(models: readonly ModelInfo[], widthMm: TapeWidthMm, preferred?: string | null): string | null
export function widthSupport(model: string, widthMm: TapeWidthMm, widths: readonly TapeWidthMm[], standIn: string | null): WidthSupport
```

wasm DTO (`crates/ptouch-wasm/src/dto.rs`): `ModelInfo.ble: boolean`, `ModelInfo.network: boolean`.

### 4.5 Text defaults — `web/src/ui/state/text-defaults.ts`

```ts
export const FALLBACK_BAND_DOTS: Readonly<Record<Exclude<TapeWidthMm, 36>, number>> // P710BT, 180 dpi
export function fallbackBand(widthMm: TapeWidthMm): { bandDots: number; dpi: number } // 36 → { 454, 360 }
export function retapeTextSize(size: TextSize, oldBandDots: number, newBandDots: number, dpi: number,
  fresh?: { from: TextSize; to: TextSize }, newDpi = dpi): TextSize
```

### 4.6 Studio — `web/src/ui/state/studio.svelte.ts`

```ts
export { DEFAULT_MODEL } // from ./models
readonly models: readonly ModelInfo[]          // [] until wasm is ready
readonly designModel: string                   // prefs.designModel resolved in the table
readonly modelSource: 'printer' | 'design'
readonly model: string                         // printer's, else designModel
readonly modelInfo: ModelInfo | null
readonly tapeWidths: readonly TapeWidthMm[]    // the tape picker's options
readonly widthSupport: WidthSupport
readonly target: TargetState                   // stand-in model when the width is unsupported
readonly untestedModel: string | null          // real printer, unverified, not dismissed
setDesignModel(name: string): void             // name or alias; pristine label follows
fitToModel(widthMm?: TapeWidthMm): void        // default: widthSupport.nearest; one undo step
dismissUntestedModel(): void
setTapeWidth(widthMm: TapeWidthMm): void       // now also writes tape.model
```

`printBlocked` includes the unsupported width (§4.7). The cassette rule and `useLoadedTape`
write `tape.model`; `print()` records `PrintRecord.model`.

### 4.7 Print gate — `web/src/ui/state/view-model.ts`

`PrintGate.unsupportedWidth?: string | null`, checked right after `blocking` (before variables
and the connection).

### 4.8 Hooks for the packages (signatures frozen; bodies by the owner)

- `ConnectionManagerOptions.virtualScenario?: Partial<MockScenario> | (() => Partial<MockScenario>)`
  (`printer/connect.ts`, lead; the Studio passes `#virtualScenario`).
- `ui/media/ModelPicker.svelte` props `{ label?: string }` (default "Printer model"); calls
  `studio.setDesignModel`. Lead stub; P-core-ui owns the body.
- `ui/templates/templates.ts` (P-render-templates):
  `TemplateDef.build(band?: { bandDots: number; dpi: number }): LabelDoc` (no band = today's
  output), `export function templateFits(t: Pick<TemplateDef, 'tapeWidthMm'>, widths: readonly
  TapeWidthMm[]): boolean`.

### 4.9 Frozen UI names (`e2e/models-entry.spec.ts`)

- combobox **"Printer model"** in the connect dialog and in region "Tape and length";
- radiogroup **"Tape width (mm)"** whose radios are the active model's widths (`36 •` when loaded);
- "No printer" button text contains **"virtual <model>"**;
- chip `PT-P910BT · 36 mm`; banner "Tape mismatch" with **"Use loaded 36 mm tape"**;
- alert text **"This label is 36 mm; PT-P710BT takes up to 24 mm."** with button **"Fit to 24 mm"**;
- preview figure "… on 36 mm tape"; connected dialog buttons "Disconnect", "Close".

---

## 5. Packages and ownership

| | P-core-ui | P-render-templates |
|---|---|---|
| **Source** | `web/src/ui/media/**` (MediaBar, ModelPicker, new UnsupportedWidthNotice / UntestedModelNotice), `web/src/ui/connect/**`, `web/src/ui/diagnostics/**` (incl. `virtual.ts`), `web/src/ui/print/PrintBar.svelte` (blocked-reason placement only), `web/src/ui/TopBar.svelte` (chip/notice mount), `web/src/printer/problems.ts` (copy), `web/src/printer/mock.ts` (doc comments; `DEFAULT_SCENARIO` stays), `web/src/ui/handoff/**` (design-only copy) | `web/src/render/**` except `types.ts`/`index.ts` (lead), `web/src/ui/templates/**`, `web/src/ui/editor/props/**` (TextProps, TextSizeQuick, LabelProps hints, SizeField use), `web/src/ui/common/SizeField.svelte`, `web/src/ui/export/**`, `web/src/ui/history/**`, `web/src/ui/batch/**` |
| **Tests** | new `tests/unit/ui/connect-copy.test.ts`, `tests/unit/printer/problems*.test.ts` (copy), `tests/unit/ui/view-model.test.ts` (chip lines only); `e2e/connect-print.spec.ts`, `e2e/diagnostics.spec.ts`, `e2e/iphone.spec.ts`, new `e2e/models-ui.spec.ts` | `tests/unit/render/**`, `tests/unit/ui/templates.test.ts`, `tests/unit/ui/text-defaults.test.ts` (no contract edits), `tests/browser/**` (new `models.browser.test.ts`, snapshots `m360-*`), `e2e/templates.spec.ts`, `e2e/fonts-export-history.spec.ts`, `e2e/batch.spec.ts`, new `e2e/models-render.spec.ts` |
| **Uses** | §4.3, §4.4, §4.6, §4.7, §4.8 (ModelPicker, virtualScenario), §4.9 | §4.1, §4.4, §4.5, §4.6 (`target`, `widthSupport`, `tapeWidths`, `models`), §4.8 (templates) |

`App.svelte`, `studio.svelte.ts`, `schema.ts`, `models.ts` stay lead-owned: mount points for new
notices go through the lead (ask with the exact line), or inside the files you own (MediaBar,
TopBar).

### P-core-ui — tasks and acceptance

- **Model picker** (§3.6): polish the stub (grouping, option text, reach note, verified marker),
  media-bar placement at 375 px, "Designing for <model> (connected)" text while connected.
- **Unsupported-width notice** (§3.4): own component, "Fit to …" and, when applicable, "Design for
  <tape.model>"; suppress the mismatch banner while it shows (stub does); announce the fit.
- **Untested-model notice** (§3.7), lazy-loaded; dismiss remembered per model.
- **Connect dialog / problems copy** (§3.8), model-generic, USB-first kept; no identifiers.
- **Diagnostics:** model = `studio.model`; width select = `studio.tapeWidths`; default width = the
  doc's (or the loaded) width; virtual runs use `studio.model`; report includes the model.
- **iPhone design-only:** the media-bar picker works in WebKit; the hand-off copy mentions the
  model when it is not the default.
- Tests: unit for copy helpers; e2e (`models-ui.spec.ts`): BLE-only model shows the note and is
  selectable; a real stubbed serial printer of another model (serial-stub with a P910BT status)
  shows the untested notice, Dismiss survives a reload; Diagnostics width list follows the model;
  375 px no horizontal scroll; WebKit iPhone project picks a 36 mm model and designs.
- **Acceptance:** every PT-P710BT string outside examples is gone from UI copy; the notice and the
  picker are keyboard- and screen-reader-usable; entry JS within allowance.

### P-render-templates — tasks and acceptance

- **360 dpi audit** (§3.10): physical readable minimum, dpi-correct hints, `mmToDots` callers.
- **Templates** (§3.9): 36 mm variants, `build(band?)`, `templateFits`, gallery filtering and
  "other widths" section, stand-in thumbnails; existing template snapshots unchanged.
- **Carry-through** (§3.11): history shows the model; reprint blocked with the notice when the
  width is unsupported; export dialog states the resolution of the stand-in when unsupported.
- **Leader copy:** "about 24 mm" stays unless the table has a per-model value.
- Tests: unit (template validity on every model's widths; `build(band)` gives "M" on 320- and
  454-dot bands); browser snapshots `m360-*` (36 mm text, QR auto, ruler; macOS + Linux);
  e2e (`models-render.spec.ts`): design for PT-P910BT, export PNG reports 360 dpi, print history
  shows the model, the gallery hides/marks 36 mm templates on the PT-P710BT.
- **Acceptance:** a 36 mm label renders, exports and prints (virtual) at 360 dpi with correct
  quick sizes, pt sizes, mm readouts and rulers; no template thumbnail throws on any model; old
  labels and templates render byte-identically.

---

## 6. Integration order and conflicts

1. Both packages start from the lead's tree (§7). No shared files: P-core-ui owns the media bar
   and connect dialog; P-render-templates owns templates, render and the editor props.
2. `ModelPicker.svelte` is used by the connect dialog and the media bar (both P-core-ui).
3. The template gallery may want a "Printer model" shortcut: P-render-templates mounts
   `<ModelPicker />` (props frozen) and does not edit it.
4. The lead integrates, runs §1.8 including Linux Docker (records `.linux.pbm` for new
   snapshots), checks the entry budget, then the PT-P710BT on real hardware (a 24 mm and a 12 mm
   label still print identically).

---

## 7. Lead's contract layer (2026-10-15)

Landed: §4.1–§4.8 (incl. the `TemplateBand` / `templateFits` hooks in `templates.ts`); `e2e/models-entry.spec.ts`; unit tests `tests/unit/ui/models.test.ts` (against
the real table), prefs, migration, schema, print gate, text defaults. Minimal UI: `ModelPicker`
in the connect dialog and media bar, the unsupported-width notice in the media bar, the "No
printer" hint. Updated for the bump: `e2e/fonts-and-size-integration.spec.ts` expects
`"schema":4` in share links. No snapshot was re-recorded; no file in `crates/ptouch` changed.

Results (macOS): `cargo fmt --check` ok; clippy workspace and wasm32 ok; `cargo test --workspace`
ok; `npm run check` 0 errors / 0 warnings; `npm test` 46 files / 860 tests; browser project
(`PW_CHANNEL=chrome`) 9 files / 99 tests; `npx playwright test` 117 passed; build ok, entry JS
118,362 B of 122,880 B. Linux Docker runs: at integration.

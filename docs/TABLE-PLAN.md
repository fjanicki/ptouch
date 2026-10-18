# ptouch studio — tables ("Table" block)

Status: **implemented, 2026-10-18** (not committed; HW-T1 pending). Where the code differs from
this plan, §11 says how and why. This is a studio feature. It needs no Rust or protocol change: the
core already has multi-page jobs, `CutMode::"every-label"` and `Bitmap1.cropLines`.

User requests (verbatim, in order):

1. "I'd like to add a way to print tiny tables … `DO RE MI FA SOL` / `C D E F G` … properly
   aligned and I can cut the tape myself or have the machine cut it automatically … With and
   without borders (option, disabled by default)."
2. "if we are doing a template, also add the # etc... keys"
3. "I might also want to print them 90deg rotated, so I can stick them on the long side of the
   keys but it still reads left to right. I want to have both options and I will test what fits"

What the code does today (the facts the decisions rest on):

- An item kind exists in four places: the `Item` union with `createItem` and `readItem`
  (doc/schema.ts), `prepareItem` (render/renderer.ts, a flow item = one `Prepared` box with a
  `crisp` draw callback), `KIND_META`/`itemSummary`/`docIsEmpty` (ui/state/view-model.ts) and
  the lazily loaded editor map in ui/editor/PropertiesPanel.svelte. Hit-testing uses one
  `ItemBox` per item (`RenderResult.boxes`, Preview.svelte `boxAt`).
- The renderer makes **one** `Bitmap1`, and that bitmap is the preview, the PNG/PDF export and
  the print. `buildPrintJob` encodes it as one page, repeated `copies` times inside the core.
  Batches (ui/batch/batch-job.ts) already send N bitmaps as **one** multi-page job: the leader is
  fed once, `cut: print.autoCut ? 'every-label' : 'none'`, chain is `print.chain`.
- `estimateTape(pages, feed, {leader})` counts each page plus 2 × feed margin, plus one 24 mm
  leader (`LEADER_MM`). The print bar, the batch note and the usage counter all use it.
- Cut capabilities (models.toml, PROTOCOL.md §5.6/§6.9). PT-P710BT: full cutter, chain, **no
  half cut**, min print data 4.4 mm incl. both 14-dot (≈ 2 mm) feed margins, ≈ 24.5 mm
  head-to-cutter leader. P300BT/N25BT: no cutter (`caps.autoCut = false`, cut marks instead).
  P910BT/E560BT family: half cut.
- Fonts (checked with tests/unit/render/font-library-woff2.ts over web/public/fonts): **only
  JetBrains Mono (core, precached, 400/700) has ♯ U+266F and ♭ U+266D.** Fira Sans is shipped
  unmodified (Reserved Font Name, so it cannot be subset or extended). The other families are
  already subset with U+2600–26FF kept, so the glyphs are missing upstream. Today a missing
  glyph falls back to the system `sans-serif`, which differs between machines.
- The entry budget is 122,880 B gzip. Measured on main: **122,087 B**, so 793 B are left.

---

## 0. Decisions

| # | Decision | Why |
|---|---|---|
| T1 | New item kind `'table'` (`TableItem`) in flow layout. It is one block, one `ItemBox` and one `Prepared`. Its cells are plain text. | It is the same shape as every other block: the list, select, duplicate, move, undo, autosave, history, share and export all work unchanged. |
| T2 | **One** font family, weight and size for the whole table. Cells are single-line (`\n`, `\t` → space). A cell holds at most 40 characters. Up to **6 rows** and **100 columns**. | This keeps text aligned across rows and pieces the same. 6 rows fit the 32 mm band of 36 mm tape. 100 columns cover an 88-key keyboard. Rows that come out smaller than 2 mm get the usual `small-text` warning. |
| T3 | Sizing is shared by the table: one em size computed from the **ink box of all cells together** (max ascent + max descent). Each row has one baseline, and column edges are whole dots. Text origins are snapped to whole dots, so the same string prints with the same dots in every cell. | User: "properly aligned". Sizing each cell would make `C` bigger than `SOL`. |
| T4 | `size: TextSize`. `'fit'` (default) is the largest size that fits a row (along) or the band (across). `'pt'` is a fixed point size, reduced to fit with a warning. `'mm'` is accepted (cap-to-descender) but the UI offers only Fit and Points. Tables never take part in "shrink to fit length". | Fit and pt are the existing modes that make sense. The quick sizes (XS–L) are fractions of the band, which means nothing for a row. |
| T5 | `direction: 'along' \| 'across-down' \| 'across-up'`, default `'along'`. **Across**: every column is still one piece along the tape. Inside a piece, the column's cells are laid out like a small text block (row 1 = first line) and that block is turned 90° (↓) or 270° (↑). `ItemFrame.rotation` is not used. | User request 3. Turning a whole piece by a quarter turn maps the dot grid onto itself, so every piece is identical dot for dot (exact alignment across pieces). Note: once pieces are cut, ↓ and ↑ are the same piece turned 180°. They differ on an uncut strip and in which tape edge "start" alignment uses. Both are offered as the user asked, and the preview shows which is which. |
| T6 | `columns`: `{mode:'auto'}` (each column = its widest cell + padding, default), `{mode:'equal'}` (every column = the widest) or `{mode:'mm', mm}` (fixed). In "across" this control is the **piece length**, and auto and equal are the same (pieces are always equal). A fixed width that is too small shrinks the whole table's font (one factor) with a warning. | Equal or fixed pieces line up on the keys. One factor keeps T3. |
| T7 | `align: Align` for the whole table, default `'center'` (UI: Left / Centre / Right; Start / Centre / End across). Per-column alignment is deferred. | The cheap version of "column alignment if cheap". Per column needs an array kept in sync with column insert and delete. |
| T8 | `grid` (off): outer and inner lines, 0.25 mm thick → `max(1, mmToDots(0.25))` dots (2 at 180 dpi, 4 at 360). `cutMarks` (off): short ticks at every column/piece edge at both tape edges. Neither has a thickness setting. | Request 1 ("borders … disabled by default") plus the scissors aid that was announced. |
| T9 | `cutBetween` (off): the machine cuts after each column. Each piece becomes **its own page of the existing multi-page job** (`Bitmap1.cropLines` at the column edges, `cut: 'every-label'`, leader fed once, chain/copies/mirror as today). **No core change.** | This is the batch mechanism, applied inside one label. The core already pads short pages and handles cuts. |
| T10 | Pieces are cut only when `print.autoCut` is on and the model has a cutter. Turning `cutBetween` on also turns on `print.autoCut`, in the same undo step. When the table is the only printing block, it also sets the label margins to 0, so every piece has the same length (announced). On a model without a cutter the option is hidden, and a note suggests cut marks. With `cutBetween` on, cut marks are not drawn. With `grid` on, every piece gets its own full box. | The first and last pieces would otherwise be longer by the 2 mm label margins. Cuts must never surprise the user. |
| T11 | No half cut in v1. | The PT-P710BT has none (D1), and nothing can be tested on the user's printer. A follow-up can add "Half cut between columns" for `caps.halfCut` models (`CutMode 'half-cut'`). |
| T12 | ♯/♭/♮ in a table cell are drawn with the bundled **JetBrains Mono** whatever the table's family. The table's CSS font stack is `"ptouch <Family>", "ptouch JetBrains Mono", <generic>`, and `fontsUsed` adds JetBrains Mono (700 when weight ≥ 600, else 400) when a cell contains U+266D–U+266F. The chromatic templates use JetBrains Mono Bold, which has the real glyphs. No font file changes. | Preview, export and print are then the same on every device, and a system font is never used. No "#"/"b" fallback is needed. Extending Fira Sans is not allowed (RFN). Scoped to tables, so existing text renders do not change. |
| T13 | Cells are literal text: `{{variables}}` are not resolved in v1. Custom fonts (`customFont`) are supported, the same way as text. | Variables cost entry bytes and were not requested. Custom fonts come for free with the reused FontPicker. |
| T14 | Schema **5**. `MIGRATIONS[4]` changes only the version. An older (schema-4) app opens a v5 label **read-only** through the existing newer-schema path: its validator drops the table with a notice, and the first edit forks a copy, so the original is never saved over. | The existing mechanism (persist-migrate.ts). |
| T15 | Entry budget: the table renderer (`render/table.ts` + `render/table-layout.ts`) and the editor (`TableProps.svelte`, `TableGrid.svelte`, `doc/table.ts`) are **lazy chunks**. To make room for the eager hooks, **LibraryDialog and ShortcutsDialog become lazy too**: they load on their first open and then stay mounted, like the v1 `DIALOGS` in App.svelte, so their `showModal` and focus logic is unchanged. The budget stays 122,880. | Measured, §6: the eager hooks cost ≈ 1.05 KB but only 793 B are left. Making the two dialogs lazy saves 1,385 B. |
| T16 | iPhone (design-only) has the same editor. At 375 px the grid scrolls inside its own container (the page never scrolls sideways), and every control is ≥ 44 px on a coarse pointer. | The existing iPhone rules (e2e/iphone.spec.ts). |

---

## 1. Schema (doc/schema.ts)

```ts
/** 5 (tables, docs/TABLE-PLAN.md): the `table` item. Nothing else changes (4 → 5 = version only). */
export const SCHEMA_VERSION = 5 as const

export type TableDirection = 'along' | 'across-down' | 'across-up'
export type TableColumns = { mode: 'auto' } | { mode: 'equal' } | { mode: 'mm'; mm: number }

export interface TableItem extends ItemBase {
  kind: 'table'
  /** Rows × columns, rectangular (every row has the same length), plain single-line text. */
  cells: string[][]
  fontFamily: FontFamilyId
  customFont?: FontSource
  fontWeight: FontWeight
  italic: boolean
  /** 'fit' = fit the row (along) / the band (across); 'pt' / 'mm' fixed (reduced to fit). */
  size: TextSize
  /** Text inside every cell (along: left/centre/right; across: start/centre/end of the band). */
  align: Align
  direction: TableDirection
  /** Column width along the tape (along) / piece length (across). */
  columns: TableColumns
  /** Space between the text and the column edges, along the text direction. */
  paddingMm: number
  grid: boolean
  cutMarks: boolean
  /** The printer cuts between columns (one page per column; needs Cut each and a cutter). */
  cutBetween: boolean
}
export type Item = … | TableItem
```

- `createItem('table')`: `cells [['A','B','C'],['1','2','3']]`, `fira-sans` 600, not italic,
  `{mode:'fit'}`, `'center'`, `'along'`, `{mode:'auto'}`, `paddingMm 1`, every switch off.
  The Insert tile also applies the user's default family and weight (`textDefaults`).
- `LIMITS`: `tableRows: 6`, `tableCols: 100`, `tableCellChars: 40`,
  `tablePaddingMm {0, 10}`, `tableColumnMm {2, 200}`.
- `readItem 'table'` (lenient, like the others): non-arrays become `[['']]`. Rows/cols/chars
  are clamped with notes. Short rows are padded to the longest, numbers become strings,
  `\r\n\t` become spaces, and an unknown direction or columns mode falls back to the default.
  `totalChars` counts every cell.
- `persist-migrate.ts`: `4: (raw) => ({ ...raw, schema: 5 })`. New fixture
  `tests/unit/persist/fixtures/schema-5.json`: one along table with grid and cut marks, one
  across-down table with cut between and fixed piece length, a ♯ cell and a text block.
- `persist-share.ts`: the custom-font notice also checks tables. Secrets: none.

## 2. Layout and drawing (render/table-layout.ts pure, render/table.ts canvas)

Units are dots. `H` = the band the table gets (inner band inside a label frame, as for every
flow item). `f` = crisp factor. `t` = grid line thickness (0 when `grid` is off). `padH =
mmToDots(paddingMm)` (along the text). Measuring: every non-empty cell is measured with
`canvasMeasure` (the T12 font stack) at a reference size. `asc = max(cap, max ink ascent)`
(the same rule as `layoutLines`), `desc = max ink descent`, `box(em) = (asc + desc)·em`.
`inkW(r,c)` = the cell's ink width.

**Along** (rows across the tape, columns along it):

1. Row edges: `y_k = round(k·H/R)`, k = 0…R. `padV = max(1, round(0.08·min row))`. Available
   text height `A = min_k(row_k − lines) − 2·padV`.
2. Em size. Fit: the largest em with `box(em) ≤ A` (re-measure ≤ 4 rounds, as `fitTextBlock`).
   pt/mm: the given size, reduced to `A` with a `content-overflow` warning. Pixel fonts: snap to
   `k·emPx` (`pixelScaleFor`, limit = true).
3. Column widths: `C_c = ceil(max_r inkW / f) + 2·padH + t`. Equal: `max C_c`. mm:
   `mmToDots(mm)`; when a cell does not fit, shrink the em by one common factor (re-measure)
   and warn "Text was made smaller to fit the column width". An empty column is
   `max(2·padH, round(em/2))`. Edges `x_0 = 0, x_{c+1} = x_c + C_c`, table length `x_n`.
4. Baseline of row k (whole dots): `y_k + lineTop + padV + round((A_k − box)/2) + asc`. Text
   origin: `x_c + lineLeft + padH + alignOffset(align, inner, inkW) − inkLeft`, snapped to `f`.
   Drawn with `drawTextBlock` (one line), with the grid for pixel fonts.

**Across** (each column is a piece. Inside it a block of R lines `W = H` wide and `P` long,
turned a quarter):

1. Em size. Fit: `max inkW ≤ H − 2·padH − 2t`. When the piece length is fixed, also
   `R·(box + 2·padV) ≤ P`. pt/mm: reduce to both with a warning.
2. Piece length `P`: auto = `R·(box + 2·padV) + lines` with `padV = max(1, round(0.12·box))`.
   mm = `mmToDots(mm)`, row edges inside it at `round(k·P/R)`.
3. Draw the block as in "along" (lines = rows, top to bottom) into a `H × P` box, then
   `rotate(+90°)` for `across-down` (text runs from the top tape edge down, glyph tops face the
   label's right end, row 1 at the piece's right end) or `rotate(270°)` for `across-up`
   (bottom edge up, glyph tops face the left end, row 1 at the left end). The block origin is
   snapped to whole dots.

**Lines** (both directions; all edges whole dots): grid = the outer box (lines inside the table:
`[0,t)` / `[len−t, len)`, `[0,t)` / `[H−t, H)`) plus inner lines centred on the edges
(`[e − ⌊t/2⌋, … + t)`). With `cutBetween`, each piece has its own box (`[e − t, e)` and
`[e, e + t)`). Cut marks: at every column/piece edge e, ticks `m = max(1, mmToDots(0.25))`
wide and `L = min(mmToDots(1.5), round(H/4))` long, from both band edges. Not drawn with
`cutBetween`.

**Renderer contract** (renderer.ts, eager and small):

- `prepareItem` case `'table'` → `await loadTables()` (render/table-set.ts, the same pattern as
  icon-set.ts) → `prepareTable(item, band, env, maxW?)`, which returns a `Prepared` (`w`, `h =
  band`, `crisp`, `text` info for the FontPicker hints, `cuts` = internal edges when
  `cutBetween`). When the chunk fails to load: new blocking warning code `'table-missing'`
  ("Reload the page while online").
- `RenderResult.cuts?: number[]`: absolute x (dots) of the machine cuts, sorted. Flow layout
  only; in a free-layout frame a table is drawn but never cut.
- Warnings: `small-text` (row text < 2 mm), `content-overflow` (reduced), `font-quality` (the
  existing rule, passed in through `env`), `font-missing`/`font-fallback` (existing).
- `fonts.ts`: `fontsUsed` and `customFontsUsed` include tables. JetBrains Mono is added as in
  T12.

## 3. Cut between columns → print path

- `render/job.ts`: `pageSpans(doc, result, cutter)` returns `[start, end)` per page: one span, or
  one per piece when `result.cuts` exist and `doc.print.autoCut && cutter`.
  `pageLengthsMm(…)` gives their lengths. `buildPrintJob(doc, result, target, {cutter})` crops
  one bitmap per span (`cropLines`), and `copies` repeats the list inside the core
  (A B C A B C). It throws when `pieces × copies > 999` ("lower the copies").
- `ui/batch/batch-job.ts`: every batch label is split the same way (pieces per label, then
  copies). batch-measure stores the piece lengths per label for the estimate.
- `studio.print`: `tapeMm = estimateTape(pageLengthsMm × copies, feed, {leader})`. Toast:
  "Label printed in 7 pieces". The usage counter and history count pages.
- What the user sees:
  - Preview: a dashed scissors line across the tape at each cut. The readout adds "Cut into 7
    pieces · 25.1 mm each (21.1 mm printed + 2 × 2.0 mm feed)", or lists first/last when they
    differ.
  - Print bar note: "Uses about 200 mm of tape incl. the ~24 mm leader before the first piece."
    (`singleTapeNote` takes the page lengths.)
  - Table panel: the same piece line, plus "Cut each is off: the strip won't be cut" or "This
    printer has no cutter" when that applies.
- Waste: every piece carries its two feed margins (≈ 2 mm each on the PT-P710BT; the printer
  adds them, they are not raster data). The leader is fed once per job. A chained print saves
  it, as today.
- Hardware: add **HW-T1** to HARDWARE-TESTS.md for the user to run: print "Piano notes" with
  Cut between columns on the PT-P710BT. Record the number of cuts, each piece length, and where
  the leader goes, and compare with the readout. Open risk: whether pieces shorter than the
  ≈ 24.5 mm head-to-cutter distance come out at their own length (PROTOCOL.md §5.6). Until
  HW-T1 runs, the UI says "about".

## 4. Editor (lazy: ui/editor/props/TableProps.svelte + TableGrid.svelte, doc/table.ts)

Order in the inspector:

1. **Grid** (`TableGrid`): a `<table>` with one `<input>` per cell, labelled "Row 2, column 3".
   Each column header has a remove button ("Remove column 3"), each row a remove button, and
   there are "Add column" / "Add row" buttons (disabled at the limits, with the reason as hint),
   plus "2 rows × 7 columns". Two buttons insert **♯** / **♭** at the caret of the focused cell
   (most keyboards have neither).
   - Keys: Tab / Shift+Tab = next / previous cell (native, row-major). ↑ / ↓ = row above /
     below. Enter = the cell below; on the last row, the first row of the next column, adding a
     column after the last one (so "DO ⏎ C ⏎ RE ⏎ D …" types notes in pairs). Shift+Enter = the
     cell above. IME composition is ignored (`isComposing`).
   - Undo: typing coalesces per cell (`${id}:cell:r:c`). Add/remove are one step each and are
     announced.
2. **Paste**: pasting text that contains a tab or a newline into any cell fills the grid from
   that cell, growing it up to the limits. A single value pastes normally. A "Type or paste the
   whole table" disclosure (textarea + "Fill table") replaces every cell; this is the path for
   iPhone. `doc/table.ts parseCells(text)`:
   - BOM is stripped, CRLF/CR become LF, empty lines are skipped, cells are trimmed;
   - delimiter = csv.ts `detectDelimiter` (tab > `;` > `,`, RFC 4180 quotes through
     `parseRecords`). With none in the first line, runs of spaces split the cells (typed
     `DO RE MI FA SOL`; a `"quoted cell"` keeps its spaces);
   - short rows are padded. A tall paste (more than 6 rows, at most 6 columns, e.g. a copied
     spreadsheet column) is transposed, with the notice "Turned into columns: a table has at
     most 6 rows";
   - limits are clamped with notices (toast + live region).
3. **Text direction**: Segmented "Along" / "Across ↓" / "Across ↑". Hints: ↓ "Reads from the
   top edge down: hold a piece with its left end toward you." ↑ "Reads from the bottom edge up:
   hold a piece with its right end toward you." The preview shows the result.
4. **Font**: the existing FontPicker through an adapter (a `TextItem` view of the table, `text`
   = the first row), plus Weight. FontPicker's frozen props stay the same.
5. **Size**: "Fit" / "Points" (+ pt field, `LIMITS.sizePt`).
6. **Columns** / **Piece length** (across): "Fit text" / "Equal" / "Fixed" (+ mm field). Across
   shows "Fit text" / "Fixed".
7. **Align in cell**, **Padding** (slider, mm).
8. **Grid lines**, **Cut marks** (disabled with a hint while Cut between is on).
9. **Cut between columns** (hidden without a cutter) + the piece line (§3).

Phone (≤ 640 px, coarse pointer): inputs ≥ 44 px tall and ≥ 64 px wide, the grid in an
`overflow-x: auto` box (`max-width: 100%`), remove buttons 44 × 44. Insert palette: a new
"Table" tile (icon `table`, which already exists). Block list: "Table · 2 × 7 · DO RE MI …".

## 5. Templates (ui/templates/templates.ts; new category `music`, "Music")

All 24 mm, `direction 'along'`, `columns {mode:'equal'}`, `cutMarks: true`, margins 0, auto
length. The direction and every option are one click away.

| id | Name | Cells | Font |
|---|---|---|---|
| `piano-white-24` | Piano notes | DO RE MI FA SOL LA SI / C D E F G A B | Fira Sans 700 |
| `piano-12-24` | Piano notes, all 12 keys | DO DO♯ RE RE♯ MI FA FA♯ SOL SOL♯ LA LA♯ SI / C C♯ D D♯ E F F♯ G G♯ A A♯ B | JetBrains Mono 700 |
| `piano-12-flats-24` | Piano notes, all 12 keys with flats | rows 1–2 as above + row 3 RE♭ … (black keys; empty under white keys) + row 4 D♭ … | JetBrains Mono 700 |

Flats decision: a separate 4-row variant rather than a third row on the main chromatic
template, and rather than a combined "DO♯/RE♭" cell. A 7-character cell would shrink every cell
of the table (T3). 4 rows on the 18 mm band give 4.5 mm rows (≈ 2.6 mm caps), which is legible
but small, so the 2-row template stays the default. Real ♯/♭ (JetBrains Mono has both, T12).
Measured on a PT-P710BT (tests/browser/table.browser.test.ts snapshots, templates length
budget): white keys along ≈ 20.5 mm per column (143 mm for 7; a white key is ≈ 23.5 mm wide, and
a cut piece is ≈ 24.5 mm with the two feed margins), chromatic along ≈ 25.3 mm per column
(303 mm for 12; wider than a ≈ 13 mm black key, which is why "across" and Points exist), the
flats variant ≈ 22.5 mm per column. Across, the chromatic pieces are ≈ 13.5 mm.

## 6. Lazy loading and the entry budget

Measured with `BASE_PATH=/ptouch/ npx vite build` + `scripts/entry-size.mjs` on a scratch copy:

| Build | Initial JS (gzip) |
|---|---|
| main today | 122,087 B |
| + LibraryDialog, ShortcutsDialog lazy (dynamic `import()` on first open) | 120,702 B (−1,385) |
| + the eager table hooks (prototype: schema + validator + migration, KIND_META, Insert tile, summary/empty, fonts, renderer hook + loader, `cuts`, page split, preview cut lines, studio estimate) | 121,743 B (+1,041) |

So the final build is ≈ 121.9 KB with the print bar and batch changes, leaving ≈ 1 KB of headroom.
Rules:

- Eager: only what is listed in the table above.
- Lazy chunk "table render": render/table.ts + render/table-layout.ts. It loads the first time a
  label with a table renders (label, thumbnail or template card) and is precached by the
  service worker (`**/*.js`), so it works offline.
- Lazy chunk "table editor": TableProps, TableGrid, doc/table.ts (+ csv.ts, already in the
  batch chunk).
- Making UnsupportedBrowser lazy was measured too and makes things **worse** (chunk split,
  120,842 B), so it is not done.
- CI keeps `node scripts/entry-size.mjs dist 122880`.

## 7. Export, hand-off, history, iPhone

- PNG/PDF export is the render bitmap (the whole strip), as today. Cut lines are not drawn: the
  printer cuts. The table chunk loads before the render resolves, so export always has the
  table. Thumbnails, library, print history, reprint, share links and the hand-off file carry
  the JSON (schema 5).
- iPhone: the same table editor (T16). Print stays design-only. "Send to computer" sends the
  table.
- Wi-Fi QR, batch and variables are unaffected (tables are ignored by `findVariables`).

## 8. Tests

**Unit (vitest, node)**

- `tests/unit/doc/schema.test.ts`: table defaults; validation (clamps, padding of short rows,
  `\n` → space, bad direction/columns → defaults, customFont); totalChars counts cells.
- `tests/unit/persist/migrate.test.ts`: schema-5 fixture unchanged; 4 → 5 version only (the
  schema-4 fixture still migrates); a v5 table doc with `schema: CURRENT + 1` and an unknown
  kind opens read-only, keeps the table and drops the unknown kind.
- `tests/unit/doc/table.test.ts`: `parseCells` (tab, `;`, `,`, spaces, quotes, CRLF, BOM,
  ragged rows, transpose, every limit notice); cell ops (insert/remove row/column stay
  rectangular, Enter-at-last-cell adds a column).
- `tests/unit/render/table-layout.test.ts`: whole-dot edges; auto/equal/mm widths; one
  baseline per row; alignment offsets; grid/cut-mark/cut geometry; each piece boxed in cut
  mode; across ↓/↑ mapping (row 1 at the right/left end); equal piece lengths; fixed length
  shrinks the em.
- `tests/unit/render/job.test.ts`: `pageSpans` (no cuts, cuts with Cut each off, no cutter);
  piece lengths; `estimateTape` with pieces × copies; the > 999 blocker.
- `tests/unit/render/fonts` / font-library: `fontsUsed` adds JetBrains Mono for ♯/♭; every
  character of every music template is covered by its font or JetBrains Mono (woff2 cmap).
- `tests/unit/ui/templates.test.ts`: the 3 templates are valid in both directions;
  view-model `itemSummary`/`docIsEmpty`.
- `tests/unit/layering.test.ts` (existing) covers the new files.

**Browser (vitest browser, `PW_CHANNEL=chrome` locally; .macos/.linux snapshots)**

- `tests/browser/table.browser.test.ts`, snapshots: `table-along-24mm`,
  `table-grid-cutmarks-24mm`, `table-equal-right-24mm`, `table-across-down-24mm`,
  `table-across-up-24mm`, `piano-white-24mm`, `piano-12-24mm` (♯ rendering),
  `piano-12-across-24mm`, `piano-12-flats-24mm`.
- Exactness: in every row the bottom ink line of the non-descender cells is the same dot row;
  ink stays inside its column; across pieces are dot-identical where their cells are.
- Identity: `exportPng` decodes to the render bitmap. The cut job decodes (`DecodedJob`) to
  `pages = cropLines` of the bitmap, `pageCount = columns × copies`.
- Linux snapshots are recorded in `mcr.microsoft.com/playwright:v1.64.0-noble` with
  `PW_CHANNEL=chromium` on a scratch copy of web/.

**e2e (Playwright)**

- `e2e/table.spec.ts`: insert Table; type with Tab/Enter; paste "DO RE MI FA SOL\nC D E F G"
  (2 × 5); grid and cut-mark switches; Across ↓/↑ re-render; Cut between → "5 pieces" readout
  and print bar note → print on the virtual printer ("No printer") → "Label printed in 5
  pieces"; undo; reload keeps the table (autosave).
- `e2e/templates.spec.ts`: open each piano template.
- `e2e/iphone.spec.ts` (webkit + 375/360 px): select a table, no horizontal page scroll, every
  control ≥ 44 px, fill from text, hand-off link contains the table.
- Full gate: the cargo checks (unchanged code), `npm run check`, vitest, playwright, the entry
  budget, and the Linux Docker run (`PW_WEBKIT=1`).

## 9. Files

New:

- `web/src/render/table-layout.ts`: pure geometry (lazy chunk).
- `web/src/render/table.ts`: measuring, sizing, drawing (lazy chunk).
- `web/src/render/table-set.ts`: lazy loader (eager, tiny).
- `web/src/doc/table.ts`: cell ops, `parseCells` (editor chunk).
- `web/src/ui/editor/props/TableProps.svelte`, `web/src/ui/editor/props/TableGrid.svelte`.
- `web/tests/unit/doc/table.test.ts`, `web/tests/unit/render/table-layout.test.ts`,
  `web/tests/browser/table.browser.test.ts` (+ snapshots), `web/e2e/table.spec.ts`,
  `web/tests/unit/persist/fixtures/schema-5.json`.

Changed:

- `web/src/doc/schema.ts`, `persist-migrate.ts`, `persist-share.ts`.
- `web/src/render/renderer.ts`, `types.ts`, `fonts.ts`, `job.ts`, `index.ts`.
- `web/src/ui/state/view-model.ts`, `studio.svelte.ts` (print estimate and toast).
- `web/src/ui/editor/InsertPanel.svelte`, `PropertiesPanel.svelte`.
- `web/src/ui/preview/Preview.svelte`, `web/src/ui/print/PrintBar.svelte`.
- `web/src/ui/batch/batch-job.ts`, `batch-measure.svelte.ts`, `batch-model.ts`.
- `web/src/ui/templates/templates.ts`, `web/src/App.svelte` (two lazy dialogs).
- The existing tests named in §8; `docs/HARDWARE-TESTS.md` (HW-T1).

Unchanged: `crates/*` (no core capability is missing) and `docs/PROTOCOL.md`.

## 10. Not in v1

Per-column alignment, half cut between columns, `{{variables}}` in cells, clicking a cell in
the preview to edit it, multi-line cells, header-row styles (bold/inverted), and the ♯/♭
fallback for plain text blocks.

## 11. Implementation notes (2026-10-18)

What was built follows §0–§10, except:

- **Who decides the cuts.** The renderer, not `pageSpans(doc, result, cutter)`: `RenderOptions.
  cutter` (the target model's `caps.autoCut`, default true) and `doc.print.autoCut` decide
  whether a table with `cutBetween` is cut; only then does `RenderResult.cuts` exist, and only
  then are the cut marks left out and every piece boxed. `pageSpans(result)` /
  `pageLengthsMm(result)` just split at `result.cuts`, so the preview, the print bar, the job and
  the batch can never disagree. The studio passes `cutterFor(target.model)` (also to the batch
  job and BatchMeasure).
- **The lazy table chunk has no run-time imports.** When render/table.ts imported text.ts /
  fonts.ts, Rolldown moved units, font-catalog, fonts, layout and text into a separate
  *preloaded* shared chunk, which cost ≈ 700 B of initial JS. So the renderer measures with the
  table's font stack (`tableFont`, `canvasMeasure(ctx, item, font)`) and passes the face
  metrics, the measure function, the CSS font and the pixel grid in (`TableCtx`); table-layout.ts
  repeats the two one-line unit conversions. icon-set.ts and table-set.ts share one tiny loader
  (render/lazy.ts `lazyModule`).
- **Entry budget, measured** (`BASE_PATH=/ptouch/ npx vite build` + `scripts/entry-size.mjs`):

  | Build | Initial JS (gzip) |
  |---|---|
  | main before the change | 122,087 B |
  | + LibraryDialog, ShortcutsDialog lazy | 120,788 B |
  | + every eager table hook (as built) | 122,737 B |
  | + batch-model.ts split: the print bar's numbers in ui/batch/batch-tape.ts (eager), the rest of the batch helpers load with the batch panel (batch-model re-exports them) | **121,394 B** |

  The eager hooks cost more than the prototype (≈ 1.9 KB: the batch piece splitting, the piece
  readout, the validator), hence the batch-model split. Budget unchanged (122,880 B); lazy chunks:
  table renderer 2.7 KB, table editor 7.0 KB gzipped.
- **Validator.** Repaired cells get one notice ("cells were repaired …") instead of one per
  kind of repair (smaller entry code); every clamp is still applied.
- **Editor keys.** Tab / Shift+Tab are handled by the grid (row by row) and leave it after the
  last / before the first cell; the per-column / per-row remove buttons are pointer targets
  (`tabindex="-1"`) and the toolbar has "Remove row N" / "Remove column N" for the current cell,
  so the keyboard never has to step over them. ♯ / ♭ keep the caret (mousedown does not take the
  focus).
- **Piece readout.** "Cut into 7 pieces · about 24.5 mm each (20.5 mm printed + 2 × 2 mm feed)",
  or "about A to B each (incl. 2 × 2 mm feed)" when the pieces differ (Fit text columns).
- **Print toast.** "Label printed in 7 pieces"; a batch or several copies of a cut label say
  "N pieces printed".
- **Tests.** As §8, plus tests/unit/render/table-fonts.test.ts (only JetBrains Mono has ♯ and ♭;
  every character of the Music templates is covered). The iPhone table test is in
  e2e/iphone.spec.ts (so it also runs in WebKit with `PW_WEBKIT=1`); `TABLE_SCREENS=<dir>` makes
  e2e/table.spec.ts save table-desktop.png (1280 × 720) and table-iphone.png (375 px). Existing
  tests updated for schema 5 and the three new templates (counts in templates.spec.ts and
  models-render.spec.ts, share-link schema in two specs).
- **Hardware.** HW-T1 is in docs/HARDWARE-TESTS.md §10.

- **Review fixes (2026-10-18, second pass).**
  - *Length.* A label with a table cut between its columns is not cut to the printer's maximum
    as one strip: the maximum is per page, so the renderer checks every piece instead and blocks
    printing (with the piece length) only when one piece is too long. An 88-key strip of 20 mm
    pieces (1760 mm) prints as 88 pages.
  - *Label frame.* Turning on "Cut between columns" when the table is the only block also turns
    the label frame off (announced, like the margins): the frame is one box around the strip, so
    the end pieces would be longer and the middle pieces open. With other blocks, a note says so
    and suggests Grid lines.
  - *Preview.* With cuts, the bold figure is the tape of the pieces (each with its feed margins,
    `estimateTape`, as the print bar counts it); the dimension under the strip says "strip,
    before cutting".
  - *Across grid.* Piece edges are doubled (like the edges the printer cuts at), so on an uncut
    strip they stand out from the row lines inside the pieces.
  - *Fonts.* The JetBrains Mono weight `fontsUsed` loads follows the table face's resolved weight
    (what the CSS font asks for), not the raw item weight (imported anton@600 asks for 400).
  - *Text box.* `cellsToText` is lossless for `parseCells` (property test): tabs whenever a cell
    is empty or has a space, quote, comma or semicolon (those cells quoted, RFC 4180); one column
    as quoted lines. `parseCells` keeps a line of empty cells as a row (a spreadsheet block keeps
    its shape) and keeps tab-separated cells untrimmed; a single comma or semicolon line pasted
    into the grid fills cells. The unsent draft belongs to its table and its cells (another table
    or an undo drops it), and "Fill table" is disabled until the text is changed.
  - *Editor.* "Add row" / "Add column" are named so; the limits are a visible hint the disabled
    button is described by; the only row / column cannot be removed (disabled). The padding
    slider goes to the schema's 10 mm.
  - *Batch toast / Diagnostics.* A batch with a cut table says "N pieces printed"; the
    Diagnostics virtual printer passes the model's cutter, as the studio does.

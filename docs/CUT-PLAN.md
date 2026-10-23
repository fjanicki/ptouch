# ptouch studio — cut lines ("Cut" block)

Status: **built, 2026-10-22** (see §10 "As built" for where the code differs from this plan;
HW-C1 still pending). This is a studio feature. It needs no Rust or
protocol change: it reuses the multi-page job that the Table block's "Cut between columns" already
uses (docs/TABLE-PLAN.md T9/T10, §3, §11).

User request (verbatim):

> "can we add a cutline item? So I can create a long strip and have the ptouch cut it at multiple
> places along the strip"

Goal: one long strip that the printer cuts into pieces, where **every piece looks like a label
printed on its own with the same settings**. Content never touches or straddles a cut.

What the code does today (the facts the decisions rest on, read from the code on main):

- **Item kinds.** A kind lives in `Item` / `createItem` / `readItem` (doc/schema.ts), `prepareItem`
  (render/renderer.ts), `KIND_META` / `itemSummary` / `docIsEmpty` (ui/state/view-model.ts), the
  lazy editor map in ui/editor/PropertiesPanel.svelte and the tiles in ui/editor/InsertPanel.svelte.
  A spacer is the model for a block with no ink: `prepareItem` returns `{ w, h: 0, spacer: true }`,
  and `layoutFlow` lets it replace the gap on both sides.
- **Flow layout** (render/layout.ts `layoutFlow`). Length (auto) = `start + content + end`, where
  `start = mmToDots(marginsMm.start) + insetDots` and the same for `end`. `insetDots` is the label
  frame's reserve (inset + line + padding). Fixed length centres the content between the margins.
  The length is then clamped to `[minLengthDots, maxLengthDots]`; padding up to the minimum
  centres the content. Gaps (`gapMm`, default 3 mm = 21 dots at 180 dpi) go only between two
  visible non-spacer blocks.
- **Cuts today.** A table with `cutBetween` gives `Prepared.cuts`. The renderer turns them into
  `RenderResult.cuts` (absolute x, dots) only when `doc.print.autoCut && opts.cutter !== false`
  (`Ctx.cut`). `render/job.ts pageSpans(result)` splits at `result.cuts`, and `buildPrintJob` sends
  one `cropLines` page per piece with `cut: 'every-label'`, copies repeated inside the core
  (A B C A B C, leader once). The batch job (ui/batch/batch-job.ts) and BatchMeasure split every
  record the same way. The preview draws a red dashed line per cut (Preview.svelte `.cut.piece`);
  the readout uses `piecesText`; the print bar uses `singleTapeNote(pageLengthsMm)`; the toast
  says "Label printed in N pieces". When cutting, the printer maximum is checked per piece and
  the strip is not clamped to it (renderer.ts, "A piece is … mm long").
- **Feed margins and minimums** (measured from crates/ptouch and the wasm `PrintArea`):

  | Value | PT-P710BT (180 dpi, 128 pins) | PT-P910BT (360 dpi, 560 pins) | E560BT family (180 dpi) | P300BT / N25BT (no cutter) |
  |---|---|---|---|---|
  | `defaultFeedDots` (`ESC i d`, per page, both ends) | 14 dots ≈ 1.98 mm | 14 dots ≈ 0.99 mm | 14 dots ≈ 1.98 mm | 14 dots ≈ 1.98 mm |
  | `min_length_mm` (incl. both feeds) | 4.4 mm = 31 dots | 4.0 mm = 57 dots | 4.8 mm = 34 dots | unknown → 4.8 mm fallback |
  | `minLengthDots` = min − 2 × feed (`min_lines`) | **3** (convert.rs test) | 29 | 6 | 6 |
  | Head-to-cutter distance (PROTOCOL.md §5.6) | ≈ 24.5 mm | ≈ 27 mm | ≈ 24.7 mm | – (≈ 25 mm leader) |
  | Default margins 2 mm (`mmToDots`) | 14 dots | 28 dots | 14 dots | 14 dots |

  The core pads a page shorter than `minLengthDots` with blank lines at the canvas end. The feed
  margin is added by the printer to **every page**, so every machine-cut piece has it at both ends.
- **Cut capabilities** (docs/models.toml, PROTOCOL.md §6.9, crates/ptouch/src/encode/mod.rs).
  `CutMode::EveryLabel` sends `ESC i M 40`: a full cut after every page on cutter models, and on
  P300BT / N25BT (`supports_cut_mark`) the printer's *own* cut mark. Half cut is a **job-level**
  `ESC i K` bit (half cut between every page, full cut at the end); it cannot differ per position.
  The PT-P710BT has no half cut. The studio exposes no half cut anywhere today (`jobOptions` sends
  `'every-label'` or `'none'`).
- **Free layout** has no editor in the studio: `layout.mode = 'free'` comes only from imported
  files and the diagnostics test labels. In a free label, items without a `frame` still flow.
- **Icons.** `scissors` already exists in ui/common/Icon.svelte.
- **Size.** There is no startup JS budget any more, and wasm size is not a constraint.

---

## 0. Decisions

| # | Decision | Why |
|---|---|---|
| C1 | New item kind **`'cut'`** (`CutItem`, no fields of its own). "Cut" in the Insert panel and the block list, icon `scissors`. It is a flow block: it is listed, selected, moved, duplicated, deleted, undone, saved and shared like every other block. | The same shape as every block, so the list, undo, autosave, history, share and export work unchanged. Nothing to configure: a cut is a position in the flow. |
| C2 | **A Cut splits the flow into pieces, and each piece is laid out as if it were the whole label**: the label's start and end margins, its frame reserve, gap, cross-axis alignment, length mode (auto / fixed), "shrink to fit length", auto-sized linear codes and the printer minimum all apply **per piece**. The Cut itself takes no space. Between two pieces the strip therefore has the end margin of the first and the start margin of the second (28 dots = 3.95 mm with the default 2 + 2 mm at 180 dpi), never a gap. | Measured: with machine cuts each piece is one page, and the printer adds its 14-dot feed to both ends of every page. A piece is then `feed + start + blocks + end + feed`, which is **dot for dot** the same label as those blocks printed on their own. Laying out each piece with the existing `layoutFlow` gives this for free (centring, min padding, overflow) and keeps one set of rules. |
| C3 | A Cut that would make an **empty piece** is **ignored**: one at the very start (nothing before it), one right after another Cut (nothing between them) or one at the very end (nothing after it). "Nothing" = no visible block; spacers and empty text do not count, and their space joins the neighbouring piece. An ignored Cut gets a non-blocking warning (`cut-ignored`, with its `itemId`) that says why, so the block list shows the warning icon and the panel explains it. | An empty piece wastes ≥ 2 × feed + leader-length risk and is never wanted. Ignoring (rather than blocking printing) keeps editing smooth: inserting a Cut after the last block is a normal step before adding the next block. |
| C4 | The printer cuts at a Cut only when **Cut each is on and the model has a cutter**: the same rule (`Ctx.cut`) as tables. **Inserting a Cut** on a cutter model turns on Cut each when it is off, **in the same undo step**, and announces it (live region + info toast "Cut each turned on"). Turning Cut each off later is allowed; the Cut's panel then says the strip won't be cut here. | T10's rule, so tables and Cuts never disagree. Cuts must never surprise the user, and one undo removes both the Cut and the Cut-each change. |
| C5 | When the printer does **not** cut at a Cut (no cutter, or Cut each off), the Cut **prints as a cut mark**: short ticks at both band edges, the table cut-mark geometry (`gridDots` wide, `min(1.5 mm, H/4)` long), centred on the piece boundary. The layout does not change (same pieces, same margins), so the user cuts at the marks with scissors. There is **no "Print a cut mark" option**: where the printer cuts, no mark is printed. | One rule, nothing to set. A mark next to a machine cut is useless: it would sit at the raster edge, a feed margin (≈ 2 mm) away from where the blade cuts. Rejected: the printer's own cut marks (`ESC i M 40` per page on P300BT/N25BT), because the spacing between pages on those models is not verified (PROTOCOL.md §6.6: "~2–3 mm apart", ~25 mm leader) and the preview could not show them; a dashed line across the band (more ink, looks like design). |
| C6 | Cuts from Cut blocks and from tables with "Cut between columns" **combine**: one sorted, de-duplicated list in `RenderResult.cuts`, inside `(0, length)`. A table inside a piece is cut between its columns exactly as today. | One page split, one readout, one job. |
| C7 | **Fixed label length means the length of each piece** (the media bar says "Length of each piece" while the label has an active Cut). "Shrink text to fit length" and auto linear codes work per piece. The printer **maximum** applies per piece when the printer cuts (as for tables), and to the whole strip otherwise. The printer **minimum** pads each piece. | "Each piece looks like a label printed on its own with the same settings." Six 30 mm name tags in one strip is the natural use. |
| C8 | The **label frame is drawn around every piece** made by a Cut (each piece is a framed label). At a table's column cuts the frame stays one box, as today (TableProps' note still applies). | Same rule as C2. A table's columns have no margins at their edges, so per-column frames would cover cell content. |
| C9 | **Copies, chain, mirror, batch** keep the table behaviour: copies repeat the whole strip (A B C A B C); chain keeps the last piece in the printer; mirror mirrors each piece in place (each piece is its own page); a batch record is one strip, split at its Cuts (A1 A2 A1 A2 B1 B2 …). Counters and variables are per record, not per piece. A Cut whose piece is empty **in one record** (an empty variable) is ignored for that record only. Pages per job stay ≤ 999 (`tooManyPages`). | Nothing new to learn; the batch and job code already split by `result.cuts`. |
| C10 | **Flow only.** A Cut never has a `frame` (the validator drops one with a note). In a free-layout label (import / diagnostics only), Cuts split the flowing blocks as above, and a block placed by its frame that crosses a cut gets a warning ("This block lies across a cut and will be cut through."). | The studio has no free-layout editor, so a draggable cut has nothing to live in. The rule keeps imported free labels safe and honest. |
| C11 | **Show the real piece lengths** the job produces: in the readout and the Cut's panel, as a list ("Cut into 3 pieces: about 30.5, 29.1 and 31.9 mm, each incl. 2 × 2 mm feed"; the table's range form above 8 pieces). Hand-cut pieces (marks) are listed without the per-piece feed (only the strip's ends have it). A **gentle hint** (not a warning) when a machine-cut piece is shorter than the head-to-cutter distance (≈ 24.5 mm at 180 dpi, ≈ 27 mm at 360 dpi): it may come out longer, not yet checked on a printer (HW-T1 / HW-C1), with the tip "set a fixed length of 25 mm". | D6. The raster minimum (3 dots on the P710BT) is already handled by the per-piece padding (C7); the open risk is the physical one. "About" stays until HW-C1 runs. |
| C12 | **Full cut only.** Half cut is deferred. | The core's half cut is a job-level `ESC i K` bit (half cut between *all* pages), so a per-Cut choice is not expressible; the studio has no half-cut path, the PT-P710BT has none, and nothing can be tested on the user's printer. Follow-up: a job-level "Half cut between pieces" on `caps.halfCut` models (hidden on the P710BT), with virtual-printer tests. |
| C13 | **Schema 6.** `MIGRATIONS[5]` changes only the version. A schema-5 app opens a schema-6 label **read-only** through the existing newer-schema path; its validator drops the Cut blocks with a notice ("unknown kind "cut"; dropped"), and the first edit forks a copy. | Exactly how schema 5 (tables) was done (T14). |
| C14 | **No Rust change.** | The core already has multi-page jobs, per-page feed margins, page padding, `cropLines` and `CutMode::EveryLabel`. |
| C15 | iPhone (design-only) has the same Insert tile and panel (≥ 44 px targets, no horizontal page scroll); share links and "Send to computer" carry the Cuts. | The existing iPhone rules (e2e/iphone.spec.ts). |

---

## 1. Schema (doc/schema.ts)

```ts
/** … 6 (cut lines, docs/CUT-PLAN.md): the `cut` item. Nothing else changes (5 → 6 = version
 * only); an older app opens a schema-6 label read-only and drops its cuts with a notice. */
export const SCHEMA_VERSION = 6 as const

/**
 * A cut (schema 6, docs/CUT-PLAN.md): splits the flow into pieces, each laid out like a label of
 * its own. The printer cuts here (Cut each + a cutter) or prints a cut mark. Never has a `frame`.
 */
export interface CutItem extends ItemBase {
  kind: 'cut'
}
export type Item = … | TableItem | CutItem
```

- `createItem('cut')` → `{ id, kind: 'cut' }`.
- `readItem` case `'cut'`: `{ id, kind: 'cut' }`. A `frame` is dropped with the note "a cut has no
  frame; removed" (`readItemFrame` runs first, so the note is added in the case). `totalChars`
  counts 0.
- No new `LIMITS`: `items: 200` and the 999-page job limit bound the number of pieces.
- `persist-migrate.ts`: `5: (raw) => ({ ...raw, schema: 6 })` with a comment in the style of 3 → 4
  and 4 → 5. New fixture `tests/unit/persist/fixtures/schema-6.json`: "Room tags", 24 mm, margins
  2 / 2, a label frame, fixed length 30 mm, items Text "Kitchen", Cut, Text "Office", Cut, Cut
  (ignored, double), QR code, and a Table with `cutBetween` after another Cut.
- Every exhaustive `switch (item.kind)` gets a `'cut'` case (TypeScript lists them): `docIsEmpty`
  (a Cut prints nothing → `false`), `itemSummary`, `prepareItem`, fonts (`fontsUsed` ignores it),
  variables (none).

## 2. Layout geometry (render/layout.ts, pure, dots)

`MeasuredItem` gets `cut?: true`. A label **without** a Cut takes the unchanged `layoutFlow` path,
so every existing render is bit-identical.

**Splitting** — `splitPieces(items: MeasuredItem[])` → `{ pieces: number[][]; cuts: string[];
ignored: { itemId, why: 'start' | 'double' | 'end' }[] }` (indices into `items`):

```
visible(p) = p has an item with w > 0 and not spacer and not cut
pieces = [[]]
for each item i:
  if item.cut:
    if visible(last piece): close it, start a new piece, cuts.push(item.itemId)
    else ignored.push(item, pieces.length === 1 ? 'start' : 'double')
  else last piece.push(i)
if pieces.length > 1 and !visible(last piece):
  merge the last piece into the one before; ignored.push(cuts.pop(), 'end')
```

**Laying out** — `layoutPieces(doc, items, band, dpi, limits, cutting)`:

1. For every piece k: `L_k = layoutFlow(doc, pieceItems, band, dpi, limitsFor(k))`, where
   `limitsFor` keeps `minLengthDots` and `insetDots`, and has `maxLengthDots` only when `cutting`
   (the printer cuts: the maximum is per page). So each piece has `start` / `end` margins incl.
   the frame reserve, its own gaps, fixed-length centring and minimum padding.
2. Offsets: `X_0 = 0`, `X_{k+1} = X_k + L_k.lengthDots`. Placements are shifted by `X_k`. A kept
   Cut sits at `x = X_{k+1}` with `w = 0`. An ignored Cut sits where it would flow, `w = 0`.
3. Strip length `len = X_n`. When not `cutting` and `len > maxLengthDots`, the strip is clamped
   to the maximum with `overflow` (today's "shortened to the printer maximum" warning).
4. Returns `FlowLayout` (placements, `lengthDots`, `overflow` = any piece or the strip, `clamped`,
   `contentDots` = sum) plus `pieceEdges: number[]` (the `X_k`, k = 1 … n−1), `cutAt` (itemId →
   x) and `ignored`.

**Worked example** (PT-P710BT, 24 mm: band H = 128 dots, margins 2 / 2 mm = 14 / 14 dots, gap
3 mm = 21 dots, feed 14 dots, no frame). Blocks: Text "Kitchen" (w₁ = 160), Cut, Text "Office"
(w₂ = 150), Cut, Text "Garage" (w₃ = 170).

| | Piece 1 | Piece 2 | Piece 3 |
|---|---|---|---|
| Raster (`14 + w + 14`) | 188 dots = 26.5 mm | 178 dots = 25.1 mm | 198 dots = 27.9 mm |
| As cut (`+ 2 × 14` feed) | 30.5 mm | 29.1 mm | 31.9 mm |
| Same blocks printed alone | 30.5 mm (identical dots) | 29.1 mm | 31.9 mm |

Strip = 564 dots = 79.6 mm; cuts at x = 188 and 366; between the pieces 28 blank dots (vs. a
21-dot gap without the Cut). Tape: 79.6 + 6 × 1.98 + 24 (leader) ≈ 115 mm. With fixed length
30 mm (212 dots) every piece is 212 dots, the blocks centred between the margins, strip 636 dots.

**Renderer** (render/renderer.ts):

- `prepareItem` case `'cut'` → `{ id, w: 0, h: 0, cut: true }` (new `Prepared.cut`).
- With any Cut in the flow: split the measured flow first (`splitPieces`; shrinking never takes a
  block's width to 0, so the split is stable), then run `shrinkTextToLength` and
  `sizeAutoLinearCodes` **once per piece** on that piece's blocks (index subsets written back),
  then `layoutPieces`.
- `cutting` (today: "a table is cut") becomes "the printer cuts anywhere": `c.cut` and (a table
  with cuts or a kept Cut).
- **Machine cuts** (`c.cut`): `cuts = sortUnique([...tableCuts, ...pieceEdges]).filter(0 < x <
  len)`. The existing per-piece maximum check runs on these; its message becomes "A piece is
  N mm long; this printer prints at most M mm per piece. Add a Cut, make the columns narrower or
  shorten the blocks."
- **Marks** (no `c.cut`): `marks = pieceEdges`. At each mark x, two rectangles are drawn on the
  crisp plane after the frame: `m = gridDots(dpi)` wide (2 dots at 180 dpi, 4 at 360), `L =
  max(1, min(mmToDots(1.5), round(H / 4)))` long (11 dots on 24 mm at 180 dpi; 21 on 36 mm at
  360 dpi), at `x − ⌊m/2⌋`, from `y = 0` and from `y = H − L`. Full band, like table cut marks.
- **Frame per piece**: `drawFrame` gets an x offset and runs once per piece span `[X_k, X_{k+1})`
  (one span = today's call). Inside a piece the frame is at `inset` from the piece's ends, so with
  inset 0 two neighbouring frames meet at the cut (each piece fully boxed, like the table's
  doubled piece edges).
- **Free layout**: a framed block whose `[x, x + w)` strictly contains a piece edge gets
  `content-overflow` "This block lies across a cut and will be cut through."
- **Minimum**: a piece padded up to `minLengthDots` gives one `length-clamped` warning "A piece was
  lengthened to the printer minimum." (rare: 3 dots on the P710BT).
- **Ignored Cuts**: warning `cut-ignored` (new code, non-blocking, `itemId`): start "Nothing is
  printed before this cut, so it is ignored." / double "Nothing is printed between this cut and
  the one before it, so it is ignored." / end "Nothing is printed after this cut, so it is
  ignored. Add a block after it to start the next piece."
- **Boxes** (hit-testing, selection outline): a kept Cut's box is the blank between the pieces,
  `[x − end, x + start)` with `end` / `start` incl. the frame reserve, widened symmetrically to at
  least `mmToDots(1.5)` so it can be clicked with margins 0; `y = 0`, `h = H`. An ignored Cut has
  no box (it is selected from the block list).

**RenderResult** (render/types.ts), additive:

```ts
export interface CutInfo {
  itemId: string
  /** 'printer' = in `cuts`, 'mark' = printed as a cut mark (in `marks`), 'ignored'. */
  how: 'printer' | 'mark' | 'ignored'
  /** Strip position (dots); absent when ignored. */
  x?: number
  why?: 'start' | 'double' | 'end'
}
/** Cut blocks printed as cut marks (no cutter, or Cut each off): x in dots, sorted. */
marks?: number[]
/** Every Cut block, in flow order (docs/CUT-PLAN.md). Absent when the label has none. */
cutItems?: CutInfo[]
```

`cuts` keeps its meaning (machine cuts), now from both sources.

## 3. Job and pages (render/job.ts, batch)

- `pageSpans` / `pageLengthsMm` / `buildPrintJob` are **unchanged**: they split at `result.cuts`.
  Every piece is one page, `cut: 'every-label'`, copies repeated inside the core, leader once.
- New `handPiecesMm(result)`: the pieces between `result.marks` (mm), the first and last with one
  feed margin each (the strip's ends), for the readout of an uncut strip.
- Batch (batch-job.ts, BatchMeasure, batch-tape.ts) is unchanged: it already splits every
  record at its `cuts` and counts per-piece feed margins.
- `studio.print`: tape estimate unchanged (`pageLengthsMm × copies`). Toast unchanged for machine
  cuts ("Label printed in 3 pieces", "N pieces printed"); for a strip with marks the detail line
  is "Cut the pieces apart at the marks." (instead of "Cut the label off at the printer.").
- Usage counter and history count pages, as today.
- Waste: every machine-cut piece carries its two feed margins (≈ 2 mm each at 180 dpi, ≈ 1 mm at
  360 dpi). That is the price of "looks like a label printed on its own"; a user who wants less
  tape sets the label margins to 0.

## 4. UI

**Insert tile** (InsertPanel.svelte): "Cut", icon `scissors`, after "Spacer". It calls a new
`studio.insertCut()`: `addItem` after the selection, plus (cutter model, Cut each off) `print.
autoCut = true`, as **one** `setDoc` (one undo step). Announced: "Added cut. The printer cuts
here" / "Added cut. Cut each turned on" (+ info toast "Cut each turned on") / "Added cut. This
printer has no cutter: a cut mark is printed" (as built, a Cut at the end says "Add a block after
it to start the next piece" instead: §10 B13). The new Cut is selected, so the next Insert goes
after it (Text → Cut → Text builds pieces left to right).

**Block list row** (BlockList.svelte, view-model `itemSummary` + new `cutSummary(info, piecesMm)`):
title "Cut", summary from the render: "Printer cuts · 30.5 | 29.1 mm" (the pieces before and
after), "Cut mark · cut by hand", "Ignored: nothing after it" (+ the warning icon); "Cut the strip
here" before the first render.

**Item panel** (new `ui/editor/props/CutProps.svelte`, lazy like SpacerProps; no controls):

1. Status (`role="status"`):
   - printer cuts: "The printer cuts here." + "Piece before: about 30.5 mm · piece after: about
     29.1 mm (each with the printer's 2 mm feed at both ends)."
   - Cut each off (cutter model): "Cut each is off: the strip won't be cut. A cut mark is printed
     here instead." + a **Turn on Cut each** button.
   - no cutter: "This printer has no cutter: a cut mark (short ticks at both tape edges) is printed
     here. Cut the strip with scissors."
   - ignored: the warning's sentence.
2. "Each piece is laid out like a label on its own: start and end margins (2 mm / 2 mm), length
   (auto | 30 mm each) and frame apply to every piece." (actual values from the doc).
3. The whole label: `pieceListText` (§0 C11).
4. The short-piece hint (C11) when it applies: "Piece 1 is about 17.4 mm. Pieces shorter than
   about 25 mm have not been checked on a printer yet and may come out longer. To be sure, set a
   fixed length of 25 mm." (`shortPieceHint(pagesMm, feedMm, dpi)`, threshold 24.5 mm below
   360 dpi, 27 mm at 360 dpi, incl. the feed margins.)

**Preview** (Preview.svelte):

- Machine cuts: the existing red dashed `.cut.piece` line, for table and Cut cuts alike. Marks: a
  muted dashed `.cut.mark` line (the printed ticks are visible in the bitmap). The "strip, before
  cutting" dimension and the "N pieces, X mm of tape" figure are unchanged.
- Design mode draws the start / end margin bands at **every piece** (at each `X_k`), not only at
  the strip ends.
- Selecting a Cut outlines its box (the blank between the pieces).

**Readout**: with Cut blocks, `pieceListText(pagesMm, feedMm)` ("Cut into 3 pieces: about 30.5,
29.1 and 31.9 mm, each incl. 2 × 2 mm feed"; above 8 pieces the existing `piecesText` range).
Labels whose only cuts come from tables keep `piecesText` (its unit tests are unchanged). With
marks: "3 pieces to cut apart at the marks: about 28.5, 25.1 and 29.9 mm" (`handPiecesMm`). The
short-piece hint is repeated in the readout as muted text.

**Print bar** (PrintBar.svelte): the note is unchanged (`singleTapeNote` already handles pieces
and "the ~24 mm leader before the first piece"). With Cut blocks, the Cut each switch gets a hint:
on "Cuts at every Cut block and after the label." / off "Off: the Cut blocks print as cut marks."

**Media bar** (MediaBar.svelte): with a kept Cut and a fixed length, "Printed length" reads
"Length of each piece" (hint "Every piece is this long."). LabelProps' Frame hint becomes "Border
around every piece" while the label has a kept Cut.

**TableProps**: the T10 "table is the only printing block" check also ignores Cut blocks.

**iPhone** (design-only): the tile is in the same palette; CutProps is text plus one 44 px button;
no horizontal page scroll at 375 / 360 px; the hand-off link and share link contain the Cuts.

## 5. Persistence and migration

- Schema 6 (C13): IndexedDB, library, history (reprint), share links, the hand-off file and
  exports carry the Cuts. No secrets.
- An older (schema-5) app: `migrate()` sees `schema 6 > CURRENT`, validates as schema 5 (the Cuts
  are dropped with notices), opens read-only, and the first edit saves a copy.
- Existing tests that hard-code the current version are updated, not weakened:
  `migrate.test.ts` "schema 4 → 5" expects `schema: CURRENT_SCHEMA`; the "current (schema 5)"
  test becomes "schema 5 → 6 changes nothing but the version"; the share-link schema checks in
  e2e/models-render.spec.ts and e2e/fonts-and-size-integration.spec.ts read 6.

## 6. Tests

**Unit (vitest, node)**

- `tests/unit/doc/schema.test.ts`: `createItem('cut')`; `readItem` keeps a Cut, drops its frame
  with a note; `docIsEmpty` is true for a label of Cuts only; `totalChars` counts 0.
- `tests/unit/persist/migrate.test.ts`: the schema-6 fixture is accepted unchanged; 5 → 6 is
  version only (schema-5 fixture); a schema-6 label opened by an older app is read-only and loses
  only its Cuts (newer-version path, as for tables).
- `tests/unit/render/layout.test.ts`: `splitPieces` (no Cut, one, several; start / double / end
  ignored with the right reason; spacers and empty text in an empty piece join the neighbour);
  `layoutPieces`: every piece equals `layoutFlow` of its blocks alone shifted by `X_k` (property
  test over random widths, margins, gaps and frame insets); no gap next to a Cut; fixed length per
  piece (centred); minimum per piece; maximum per piece when cutting, strip otherwise; ignored Cuts
  change nothing (same placements as without them).
- `tests/unit/render/job.test.ts`: `pageSpans` with combined table and Cut cuts; `handPiecesMm`
  (feed on the first and last piece only); `tooManyPages` for pieces × copies.
- `tests/unit/ui/view-model.test.ts`: `pieceListText` (2–8 pieces listed, 9+ as a range, equal
  pieces "each"); `cutSummary` for printer / mark / ignored; `shortPieceHint` thresholds at 180
  and 360 dpi; `KIND_META.cut`; `itemSummary`; `docIsEmpty`.
- `tests/unit/ui/batch-model.test.ts`: `batchTape` with records of different piece counts.
- `tests/unit/layering.test.ts` (existing) covers CutProps and the new layout functions.

**Browser (vitest browser, `PW_CHANNEL=chrome` locally; `.macos.pbm` / `.linux.pbm` snapshots)**

`tests/browser/cut.browser.test.ts`:

- Snapshots: `cut-three-pieces-24mm` (Text | Cut | Text | Cut | QR, printer cuts, no marks),
  `cut-marks-no-cutter-12mm` (PT-P300BT target, ticks), `cut-marks-cut-each-off-24mm`,
  `cut-frame-fixed-24mm` (frame around every piece, fixed 30 mm), `cut-table-combined-24mm` (a
  table cut between its columns next to Cut pieces), `m360-cut-36mm` (PT-P910BT, 1 mm feed).
- **Identity** (the C2 promise): each page of a cut label is bit-identical to the same blocks
  rendered as a label of their own (same doc settings), for auto and fixed length, with and without
  a frame, at 180 and 360 dpi.
- A label with start / double / end Cuts renders bit-identically to the same label without them,
  with one `cut-ignored` warning per ignored Cut.
- Job: `buildPrintJob` decodes (`decodeJob`) to `pages = cropLines` of the bitmap at `result.cuts`,
  `pageCount = pieces × copies`, no violations, `ESC i M 40` on every page and `ESC i K 08`
  (`00` with chain) on the PT-P710BT; mirror flips each page in place.
- Labels without Cuts: every existing snapshot is unchanged (the run itself is the check).
- Linux snapshots recorded in `mcr.microsoft.com/playwright:v1.64.0-noble` with
  `PW_CHANNEL=chromium` on a scratch copy of web/.

**e2e (Playwright)**

- `e2e/cut.spec.ts`: Text → Insert Cut (Cut each off before: it turns on, announced, toast) →
  Insert Text: one red cut line, readout "Cut into 2 pieces: about …", panel "The printer cuts
  here" with both piece lengths, block list "Printer cuts · …"; one Undo removes the Cut **and**
  restores Cut each off; Cut each off → panel note, "Turn on Cut each" works, muted mark line and
  "pieces to cut apart at the marks"; a trailing Cut shows "Ignored" and the warning icon; fixed
  length → "Length of each piece"; Design for PT-P300BT → the no-cutter sentence; print on the
  virtual printer → "Label printed in 3 pieces"; a batch of 2 records × 2 pieces → "4 pieces
  printed"; reload keeps the Cuts (autosave). `CUT_SCREENS=<dir>` saves `cut-desktop.png`
  (1280 × 800) and `cut-iphone.png` (375 px).
- `e2e/iphone.spec.ts` (webkit with `PW_WEBKIT=1`, 375 / 360 px): insert a Cut, no horizontal
  page scroll, the panel button ≥ 44 px, the hand-off link contains the Cut.
- Full gate: `npm run wasm && npm run check && PW_CHANNEL=chrome npx vitest run &&
  PW_CHANNEL=chrome npx playwright test && BASE_PATH=/ptouch/ npx vite build && node
  scripts/entry-size.mjs dist`, plus the Linux Docker run (unit + browser + e2e, `PW_WEBKIT=1`).
  crates/ do not change, so the cargo checks run unchanged.

## 7. Hardware test HW-C1 (add to docs/HARDWARE-TESTS.md §11, PENDING; do not print now)

**HW-C1: a strip cut at Cut blocks. PENDING.** In the studio on the PT-P710BT, 24 mm tape,
default margins (2 / 2 mm), Cut each on, chain off: Text "A", Cut, Text "Kitchen drawer", Cut,
QR code, Cut, Text "B". Note the readout ("Cut into 4 pieces: about …") and the print bar's
estimate, then print one copy. Record:

- the number of cuts and pieces (expected 4, plus the leader cut-off);
- each piece's length with a ruler, against the readout;
- whether each piece's blank ends match a label of the same block printed on its own (print
  "Kitchen drawer" alone and lay them side by side);
- whether the short pieces ("A", "B", well under 25 mm) come out at their own length or longer
  (the ≈ 24.5 mm head-to-cutter distance, PROTOCOL.md §5.6; the same open question as HW-T1);
- repeat with a fixed length of 30 mm and "Shrink text to fit length" on: all four pieces should
  be the same length (about 34 mm as cut);
- repeat with Cut each off: one strip with tick marks at the three cut positions.

Until HW-T1 / HW-C1 have run, the studio says "about" for piece lengths and shows the short-piece
hint.

## 8. Files

New: `web/src/ui/editor/props/CutProps.svelte`, `web/tests/browser/cut.browser.test.ts` (+
snapshots), `web/e2e/cut.spec.ts`, `web/tests/unit/persist/fixtures/schema-6.json`.

Changed: `web/src/doc/schema.ts`, `persist-migrate.ts`; `web/src/render/layout.ts`,
`renderer.ts`, `types.ts`, `job.ts`, `index.ts`; `web/src/ui/state/view-model.ts`,
`studio.svelte.ts`; `web/src/ui/editor/InsertPanel.svelte`, `BlockList.svelte`,
`PropertiesPanel.svelte`, `props/TableProps.svelte`, `props/LabelProps.svelte`;
`web/src/ui/media/MediaBar.svelte`; `web/src/ui/preview/Preview.svelte`;
`web/src/ui/print/PrintBar.svelte`; the tests named in §6; `docs/HARDWARE-TESTS.md` (HW-C1).

Unchanged: `crates/*`, `docs/PROTOCOL.md`, `docs/models.toml`, ui/batch (beyond what the renderer
already returns).

## 9. Not in this round

- **Half cut** at a Cut or between pieces (C12).
- A draggable cut position in a free layout (C10; there is no free-layout editor).
- "Cut every N mm" (automatic cuts in long text), copies per piece, counters that step per piece.
- An "exploded" preview that draws each piece with its feed margins apart.
- A "Print a cut mark" option where the printer cuts (C5), and cut lines in PNG / PDF export
  (export is the print bitmap, as today).
- Templates with Cuts (e.g. a strip of name tags); easy to add later.

## 10. As built (2026-10-22)

The plan was built as written, with these differences:

| # | Plan | Built | Why |
|---|---|---|---|
| B1 | §2 step 1: each piece is laid out with `maxLengthDots` when the printer cuts. | When the printer cuts, no piece is clamped in the layout. The renderer's per-piece check (blocking, "A piece is N mm long; this printer prints at most M mm per piece. Add a Cut, …") covers the pieces of Cut blocks and of tables alike. Without machine cuts the strip is cut to the maximum, as before. | A piece that holds a table cut between its columns is legitimately longer than one page; clamping it would cut the table off. One check for every piece is also what tables already do. |
| B2 | `splitPieces` returns item ids for the kept Cuts. | It returns indices: `pieces`, `kept` (index of the Cut that ends each piece) and `ignored` (`index`, `itemId`, `why`). Ignored Cuts stay in their piece as zero-width items. | The renderer works on index-aligned arrays; a zero-width item takes no space and no gap, so ignored Cuts change nothing by construction. |
| B3 | — | The crisp plane is tiled per piece (tiles start at every piece edge), and the frame is moved by the canvas transform instead of by its path coordinates. | Measured: without this, a long 360 dpi strip differed from the piece printed alone by 1 dot at a tile boundary, and a rounded frame corner by 1 dot (float rounding of the path at a large x). With it, every piece is bit-identical to the label of its blocks (browser test "every piece is the label of its blocks printed on its own"). |
| B4 | Worked example: fixed 30 mm = 212 dots. | 213 dots (`mmToDots(30)` = round(212.6)). | Arithmetic only; the unit test uses the real value. |
| B5 | Ignored Cut, panel status: "the warning's sentence". | The status says "This cut is ignored, so the strip is not cut here."; the reason is the `cut-ignored` warning that the properties panel already shows above it. | The sentence is not shown twice. |
| B6 | Short-piece hint names one piece and always says "set a fixed length of 25 mm". | It names every short piece ("Pieces 1 and 3 are about 14 and 16 mm.", equal lengths once: "both about 27 mm"). The tip depends on the pieces (`shortPieceHint`, `shortPieceHintFor`): **a fixed length** only when every Cut piece fits in it (`RenderResult.cutPieces[].autoDots`), and the shortest whole mm that clears the threshold with the model's real feed once rounded to dots (`safePieceMm`: 21 mm at 180 dpi, 26 mm at 360 dpi); **a Spacer** when a fixed length would cut off a longer piece; with a fixed length already set, the length that holds the longest piece; **wider table columns** for pieces of a table cut between its columns (a page that is not a whole Cut piece), which a fixed length cannot lengthen. Every length in the hint is as cut (feed included): the threshold is the real one ("shorter than about 24.5 mm as cut" at 180 dpi, "27 mm" at 360 dpi, not rounded up), a short piece that would round up to it is shown rounded down ("both about 26.9 mm", not "27 mm"), and the Spacer tip gives the target as cut with the printed length after it ("lengthen the short pieces to about 25 mm or more as cut (21 mm printed)"), as the fixed-length tip does ("a fixed length of 21 mm (about 25 mm as cut)"). | A strip often has several short pieces. Measured: 25 mm at 360 dpi is 354 dots = 24.98 mm, + 2 × 0.99 mm feed = 26.95 mm, still under 27 mm, so the old advice did not clear its own hint there; and following it clipped longer pieces and left table column pieces short. Review: the Spacer tip gave a printed length (21 mm) next to as-cut piece lengths (24.4 mm), and `Math.ceil` of the threshold said "shorter than about 25 mm" where 24.5 mm applies and "two pieces of about 27 mm are shorter than about 27 mm". |
| B7 | Media bar hint "Every piece is this long." | The field reads "Length of each piece" and the line under it "Each cut piece ≈ … with the printer’s feed". The "Shrink text to fit length" hint says "piece" too. | Keeps the existing hint line (cut length incl. feed), worded per piece. |
| B8 | Print bar hint on the Cut each switch. | Only on the plain-label switch; the batch switch keeps its own "Full cut after every label" hint. | The batch hint already describes the cut. |
| B9 | Mirror test: "mirror flips each page in place". | Two tests. PT-P710BT (hardware mirror): every page carries `ESC i M 0xC0` (cut + mirror, pieces × copies times) and decodes to the same pages, in the same order, as the plain job. PT-E560BT (a cutter model without hardware mirror, so the core mirrors in software): decoded page k is piece k read backwards, in order. | The decoder applies a software mirror (the raster is reversed) but not the hardware mirror flag (crates/ptouch/src/virtual_printer/mod.rs), so on the P710BT only the flag can be checked, and the in-place flip is checked on a software-mirror model. |
| B10 | `.cut.mark`: "muted dashed line". | A muted dotted line, so it reads differently from the strip's dashed end lines and the red machine cuts. | Legibility. |
| B11 | A piece that overflows a fixed length "is cut off" (§2: content starts at the start margin and overflows). | Each block of a piece is drawn inside its piece only (`PiecesLayout.pieceOf`, `Placed.clip`): the crisp plane is clipped to the piece (whole px), a photo that overflows is dithered whole on a raster of the piece's length and OR-ed in, a code is cut at the piece's ends (one dot per module), and a table's column cuts past its piece are dropped. Labels whose blocks fit are drawn exactly as before. | Measured: the overflow ran on into the next piece, across the cut (a 20 mm piece of "Kitchen drawer left side" put 180 dots of ink into the next piece's start margin; a table's column cuts landed in the next piece). Now both pieces are dot for dot the labels of their blocks alone (browser test "a piece that overflows a fixed length is cut off at its cut", text, QR code, photo and table, with and without the cutter). |
| B12 | — | A strip without machine cuts that is cut to the printer maximum: a kept Cut past the maximum reports `how: 'ignored'`, `why: 'max'`, with a `cut-ignored` warning ("The strip is cut off at the printer maximum before this cut, so it is ignored."). The preview draws piece margins only inside the strip. | It used to report 'mark' although no mark is printed, so the panel and the block list said "A cut mark is printed here" and the preview put margin bands past the strip. |
| B13 | Cut panel status: the state sentence and the piece lengths in one `role="status"`; "Turn on Cut each" also announces. | The live region holds the state sentence only, taken from the render (as the lengths are), so it changes once per render and never pairs a new state with old lengths; "Turn on Cut each" moves focus to the line that follows it (the button is gone once Cut each is on) and does not announce on its own. Before the first render of a Cut the sentence follows the document and the settings, which the render then confirms: "ignored" when no printed block follows it (`cutFate`, the `splitPieces` rule on the document, with the last render's boxes for empty blocks), so the usual insert at the end of the label does not flip from "The printer cuts here." to "ignored". `Studio.insertCut` announces with the same rule: "Added cut. Add a block after it to start the next piece" for a Cut at the end ("Added cut. Cut each turned on. Add a block …" when it turns Cut each on), "The printer cuts here" / "a cut mark is printed" only for a Cut between printed blocks. | Measured: every Cut each change announced twice (state first with the old lengths, then the lengths), once with "Cut each is off" next to "each with the printer's feed at both ends"; focus dropped to `<body>`. Review: a Cut inserted at the end was announced "The printer cuts here" (or "a cut mark is printed") though the render ignores it, and the status line then changed to "ignored". |
| B14 | Block list row: "Printer cuts · 30.5 \| 29.1 mm". | "30.5 / 29.1 mm" (printer cuts) or "30.5 / 29.1 mm, by hand" (a cut mark): led by the numbers, allowed to wrap (after the slash only), with a tooltip; the row's accessible name says it in words ("Cut: Printer cuts: pieces of 30.5 and 29.1 mm, block 2 of 5"). | The row's summary is one line with an ellipsis: at 1280 px it showed "Printer cu…" and never the lengths; screen readers read "\|" as "vertical bar". |
| B15 | Media bar: "Each cut piece ≈ … with the printer's feed" whenever the label has pieces. | Only when the printer cuts. Cut apart by hand at the marks, the feed is only at the strip's ends: "Each piece ≈ 27 mm when cut apart at the marks (incl. the printer's feed)" for two pieces, "Pieces ≈ 25 mm when cut apart at the marks; the first and last ≈ 27 mm with the printer's feed" for more (`pieceLengthHint`, from `handPiecesMm` as the readout). | The two figures on screen disagreed (29 mm vs "about 27 and 27 mm"). |
| B16 | — | Wording: equal lengths are given once ("about 27 mm each", "both about 27 mm"); the panel's settings sentence reads "start and end margins (2 mm / 2 mm) and length (auto) apply to every piece" ("…, length (30 mm each) and the frame …" with a frame). | Review. |
| B17 | C5: a cut mark is drawn like a table's cut marks (crisp plane). | The cut marks are drawn on the crisp plane and then blitted as protected all-dark dots before the codes (`renderer.ts`: tone → crisp → cut marks → codes), so a code's cleared, protected quiet zone that reaches its piece edge skips the mark's dots instead of clearing them. At margins 0 this takes at most the mark's dots (1 to 2 dots at 180 dpi) from the quiet zone at the piece edge. | Measured: with margins 0, [code, Cut, code] with Cut each off printed 0 of 22 dots in each tick for QR, Code 128 and DataMatrix, while the preview and the readout showed a mark. Browser test "cut marks next to codes" (QR, Code 128, DataMatrix at margins 0, 0.5 and 2 mm: both ticks in full). |
| B18 | — | Shrink to fit length per piece emits each piece's text warnings at their final size right after that piece is shrunk, before its auto linear codes are sized, so a label without a Cut lists its warnings in the same order as before Cut blocks ("small-text", then "code-too-small", then "content-overflow"), and each piece of a strip in that order. | Review: the text warnings were emitted after every piece, so a label without a Cut listed "code-too-small" first (bitmap unchanged). Checked: every no-Cut document of the comparison set renders the same bitmap and the same warnings, in the same order, as before Cut blocks. |

New helpers: `splitPieces`, `layoutPieces` (render/layout.ts), `handPiecesMm` (render/job.ts),
`pieceListText`, `handPiecesText`, `shortPieceMm`, `safePieceMm`, `shortPieceHint`,
`shortPieceHintFor`, `pieceLengthHint`, `cutNeighbours`, `cutSummary`, `cutFate` (ui/state/view-model.ts),
`Studio.insertCut`. RenderResult gains `marks`, `cutItems` and `cutPieces`; the warning code
`cut-ignored` is new.

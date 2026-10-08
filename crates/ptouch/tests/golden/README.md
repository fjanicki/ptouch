# Golden byte streams (owned by WP4)

Each golden is one file `<name>.hex`: the expected `EncodedJob::to_bytes()` of a job defined
in `tests/encode.rs` (`goldens()`: model, media id, pages, `JobOptions`). The source bitmaps are
built in code (deterministic patterns: tiny test label, ruler, orientation "F", text-like
blocks), so no PBM files are needed.

Format (human-reviewable, one command per line):

```text
# comment (the rest of the line after `#` is ignored)
00*100                                           # invalidate ×100
1B 40                                            # ESC @ initialize
1B 69 7A 84 00 18 00 05 00 00 00 00 00           # ESC i z n1=84 n2=00 width=24 length=0 lines=5 n9=0
47 02 00 F1 FF                                   # G raster line (2 bytes)
```

- Tokens are whitespace-separated hex bytes; `XX*N` repeats byte `XX` N times.
- The header comments record model, tape, page line counts and options; sections are marked
  `-- preamble --`, `-- page N --` and `-- epilogue --` (comments only: the bytes are compared
  as one concatenated stream).
- The comparison is byte-exact. On mismatch the test prints an annotated diff by command.

Regenerate only with `UPDATE_GOLDEN=1 cargo test -p ptouch --test encode goldens`, and review
the diff in the PR. The PT-P710BT (§6.3), E560BT (§6.4), P910BT (§6.5), P300BT (§6.6) and
N25BT (§6.7) sequences are additionally checked against hand-built vectors in `tests/encode.rs`
that do not depend on these files.

## Raster line order (regenerated 2026-10-08)

Raster lines are in **send order**, which is not canvas order: every PT model uses
`FeedOrder::LastColumnFirst` (`ModelProfile::feed_order`, PROTOCOL.md §5.3), so the first `G`/`Z`
line of a page is the **last** canvas column (the right end of the label when read) and the
last line is canvas column 0. Padding added to short pages sits at the canvas end, so it is
sent first. Each file says this in its header (`# Raster lines in send order = …`).

This was fixed by the hardware result "[HW] orientation test label, PT-P710BT" (24 mm TZe,
2026-10-08): with lines sent in canvas order the label printed mirrored along the tape
("START" mirrored, arrow pointing left) while the pin axis was correct. All files were then
regenerated with `UPDATE_GOLDEN=1 cargo test -p ptouch --test encode goldens` and reviewed
mechanically against the previous set: in every file the preamble, every control command,
the page framing and the epilogue are byte-identical, and the raster lines of each page are
exactly the previous lines in reverse order (`p710bt_24mm_blank` is all `Z`, so only its
header changed). No other byte changed.

Once a golden has been printed on hardware, add a comment line
`# verified_on = "PT-P710BT fw … 2026-…"` at the top of its file.

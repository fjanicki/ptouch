# Manual hardware tests

These are the tests that cannot run in CI. They answer the open questions in
[PROTOCOL.md §9.1](PROTOCOL.md) and [ARCHITECTURE.md §12](ARCHITECTURE.md) (H1–H9). Run them in
order on a **PT-P710BT** first, then on any other model you have.

Rules:

- Use placeholders in everything you commit: `PT-P710BTxxxx` for the device name and
  `XX:XX:XX:XX:XX:XX` for the Bluetooth address. Never paste a real address or name suffix
  into an issue, a log or this file.
- Close P-touch Editor, Brother iPrint&Label and any other program that may hold the printer.
  Only one host can be connected over Bluetooth at a time.
- Record every run in the log table at the end: date, OS and version, firmware (if known),
  transport, command, result, and the `-v` packet log (addresses removed).
- `-v` prints every frame sent (`>>`) and received (`<<`); `-vv` also prints session events
  with timestamps. Long buffers are truncated; `-vvv` prints them in full.

## 0. Before you start

```sh
cargo build --release -p ptouch-cli
alias ptouch=target/release/ptouch

ptouch list                       # candidates and their endpoint strings
ptouch info PT-P710BT             # print areas: 24/32/50/70/112/128 dots for 3.5–24 mm
```

Pick one connection and keep it for a whole session:

| Connection | Flag |
|---|---|
| macOS serial node | `--port /dev/cu.PT-P710BTxxxx` |
| macOS native RFCOMM (IOBluetooth) | `--bt XX:XX:XX:XX:XX:XX` or `--bt PT-P710BTxxxx` |
| Linux | `--port /dev/rfcomm0` or `--bt XX:XX:XX:XX:XX:XX` |
| USB | `--usb` |
| Any (default) | `--device <endpoint>` or `$PTOUCH_DEVICE` |

Below, `$C` stands for the chosen flag, e.g. `C="--port /dev/cu.PT-P710BTxxxx"`.

Every printing test can be checked offline first. `--preview` shows the label in the
terminal, `--preview-png out.png` writes an image, and `--dry-run --out job.bin` writes the
exact bytes and replays them through the virtual printer:

```sh
ptouch test-label orientation --tape 24 --preview
ptouch test-label ruler --tape 24 --dry-run --out ruler.bin && ptouch decode ruler.bin --preview
```

## 1. Status (reproduces the known-good sequence)

```sh
ptouch $C -v status
```

Expected with a 24 mm laminated white/black cassette (the fixture in
`crates/ptouch/tests/fixtures/status/`):

```
Printer       PT-P710BT (series 0x30, model 0x76)
Tape          laminated — 24 mm TZe (tze128-24, 128 printable dots)
Colours       black text on white tape
State         ready …
Raw           80 20 42 30 76 30 00 00 00 00 18 01 00 00 00 00 00 00 00 00 00 00 00 00 01 08 00 00 00 00 00 00
```

Then:

1. Run `status` **three times in a row** without power-cycling. Record whether the second and
   third runs work (the macOS "works once" problem, ARCHITECTURE.md §3.2, H2).
2. Open the cassette cover and run `status` again: exit code 1, an error listing
   "cover open", and a hint. Close the cover.
3. Remove the cassette: expect "no tape" / no-media errors.
4. `ptouch $C status --watch 2`: open and close the cover and swap cassettes while it runs.
   Record each printed change (stop with Ctrl-C).
5. Leave the printer idle and keep `--watch 60` running for 15 minutes. Record whether the
   printer still powers off after its auto-off time (H8).

## 2. Orientation (PROTOCOL.md §9.1 item 1, H4)

```sh
ptouch $C -vv test-label orientation --tape 24
```

The label contains (canvas coordinates, exactly what `--preview` shows):

- a solid bar on rows 0–7 (pins 0–7 on 24 mm) for canvas columns 0–49, then a bar on
  rows 120–127 for columns 50–99;
- a 1-dot line along row 0 for the whole label;
- "START" at canvas column 0 (left end), the asymmetric glyphs "F R 7" below it, and an
  arrow pointing right (towards higher columns).

The encoder sends the columns last first (PROTOCOL.md §5.3), so the printed label must look
like the preview.

Photograph the label next to the printer and record:

- which physical tape edge the row-0 line is on (towards the cassette's top or bottom when
  the printer stands normally);
- which end of the label came out first (the end with "START", or the arrow tip);
- whether "START", "F", "R" and "7" read correctly or mirrored.

**Result, PT-P710BT, 24 mm TZe, 2026-10-08** ([HW] orientation test label, PT-P710BT). Printed
with the previous encoder, which sent canvas column 0 first. Viewed from the front with the
text upright:

- across the tape (pin axis) **correct**: the 1-dot row-0 line and the short thick bar are at
  the top edge, "START" is above "F R 7", the bottom bar is at the bottom. Canvas row 0 → pin
  `left_margin_pins` is the top edge of upright text;
- along the tape **mirrored**: "START" read mirrored at the right end, the arrow pointed left.
  The first raster line received prints at the **right** end of the label when read.

Fix (in the core, for every UI): `encode_job` sends the last canvas column first
(`ModelProfile::feed_order()` = `FeedOrder::LastColumnFirst`), and the virtual printer and
`ptouch decode` undo that order, so a decoded job reads like the printed label. The same order
is applied to every PT model, but it is verified only on the PT-P710BT.

Still to do: print the label again with the fixed encoder and confirm that it reads correctly
("START" upright at the left end, arrow pointing right, same as `--preview`); then check
`--mirror` (must be the exact mirror image) and other models.

Repeat on 12 mm (`--tape 12`) to check the print-area offsets 29/70/29 (PROTOCOL.md §5.2):
the row-0 line and both bars must be fully visible, and no ink may be lost at either edge.

## 3. Ruler: scale and printable area (PROTOCOL.md §5.2, §9.1 items 1 and 3)

```sh
ptouch $C test-label ruler --tape 24 --length 100
ptouch $C test-label ruler --tape 12 --length 50
ptouch $C test-label ruler --tape 9  --length 50
```

Measure with a steel ruler and record:

- the distance between the 0 and 100 mm ticks (expected 100 mm ± 0.5 mm at 180 dpi);
- whether both border lines (first and last printable row) print. On 9 mm and 12 mm, count
  the pin-ruler ticks that print. Brother's tables give 50/70 dots, community measurements
  52/76–81;
- the total label length, and the blank length before the first tick and after the last.

Feed margin (§9.1 item 3): print the same ruler with `--margin 0` and with the default
(14 dots) and compare the total lengths.

## 4. Print text and copies (ARCHITECTURE.md §8.5)

```sh
ptouch $C -vv print --text "Hello 12mm" --tape 12 --copies 2
ptouch $C print --text "Two\nlines" --font Helvetica --tape 24
ptouch $C print --text "Left" --align left --length 40
```

Record for each job:

- every frame received during and after printing, in order (`<<` lines), and the time from
  the "printing" frame to "printing completed" (H3, §9.1 items 2 and 5);
- for `--copies 2`: whether a completion status arrives for each page, and whether there is a
  cut between the labels;
- whether a `status` run directly afterwards works.

Feed rate (§9.1 item 8): time a 100 mm and a 500 mm label (`--length 100`, `--length 500`)
from "printing" to "printing completed". These timings replace the `T_est` estimate.

## 5. Cutting, chaining, mirroring, high resolution

```sh
ptouch $C print --text "chain 1" --chain
ptouch $C print --text "chain 2"            # the first cut of this job releases "chain 1"
ptouch $C print --text "no cut" --no-cut
ptouch $C print --text "mirror" --mirror    # hardware mirror on P710BT
ptouch $C print --text "hi-res" --high-res  # §9.1 item 4: accepted, or st[9]=0x01?
ptouch $C print --text "x" --margin 0       # §9.1 item 7: minimum page (padded to min_lines)
```

Record the number of cuts, the leader length and any error frames (§9.1 item 6).

## 6. Error handling and resume (PROTOCOL.md §6.10)

1. Start `ptouch $C -vv print --text "page" --copies 3 --length 80` and open the cover while
   page 2 prints. Expect: an error naming the cover, the page to resume from, and
   `--from-page N` in the message.
2. Close the cover. Run `status`: it must show "ready" without a power cycle.
3. Resume with `--from-page N` and check that exactly the missing labels print.

## 7. macOS specifics (PROTOCOL.md §9.1 items 9–10, H1/H2)

- Run the native transport from Terminal.app and from another terminal app:
  `ptouch --bt PT-P710BTxxxx -v status`. Record whether a Bluetooth permission (TCC) prompt
  appears and whether access works after you grant it.
- Unpaired printer: check whether pairing works (PIN request, if any).
- Send a multi-KB job (`test-label ruler --length 200`) and check that it prints completely.
- Quit with Ctrl-C during the handshake, then run `status` again: the link must be released.

## 8. Browser matrix (later phase, ARCHITECTURE.md §12)

With the deployed web studio: H1 (macOS direct RFCOMM in Chrome), H2 (`/dev/cu.*` in Chrome,
close/reopen ×3), H5 (WebUSB on macOS), H6 (Windows 11 + Chrome), H7 (Android Chrome), H9
(Firefox on macOS). Log the OS, browser version, transport kind and packet log for each.

## Log

| Date | OS | Model / firmware | Transport | Test | Result | Notes |
|---|---|---|---|---|---|---|
| 2026-10-08 | macOS 27 | PT-P710BT | Native Bluetooth (IOBluetooth RFCOMM ch 1, main thread) | §2 orientation, 24 mm TZe | Pin axis correct; mirrored along the tape | Old encoder (column 0 sent first). First raster line = right end when reading. Encoder changed to send last column first (PROTOCOL.md §5.3). |
| 2026-10-08 | macOS 27 | PT-P710BT | Native Bluetooth (IOBluetooth RFCOMM ch 1, main thread) | §2 orientation, 24 mm TZe (fixed encoder) | ✅ Correct: reads like `--preview` | START reads normally, arrow points right, top edge features at the top. Status handshake: printing (06/01) → completed (01) → phase receiving (06/00), about 9 s. |

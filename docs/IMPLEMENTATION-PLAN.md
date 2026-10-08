# ptouch — Implementation plan (Phase 1: Rust core, transports, CLI)

Status: scaffold in place, 2026-10-08. `cargo build --workspace`, `cargo check-wasm`
(`cargo check -p ptouch --target wasm32-unknown-unknown`), `cargo check-nostd`, clippy and
`cargo doc` all pass with every body still `todo!()`.

This plan splits the work into seven packages (WP1–WP7) that can be implemented **in parallel**.
Each package owns a disjoint set of files. All shared files are complete: every dependency is
declared and every public type, enum, trait and signature exists. Implementers fill in bodies
and add tests. They do not touch manifests or `lib.rs`.

Normative references: `docs/PROTOCOL.md` (protocol), `docs/models.toml` (data),
`docs/ARCHITECTURE.md` (layout, APIs §4, data flow §5, tests §8, versions §10).

---

## 0. Rules for every work package

1. **Edit only the files you own** (listed per WP). Unit tests may live in owned source files
   (`#[cfg(test)] mod tests`) or in the owned `tests/*.rs` files.
2. **Shared files are frozen** (see §1). If a public signature, a manifest or a shared type
   must change, do not edit it yourself. Stop and report the exact change you need in your
   final message, so the integrator can apply it once for everyone.
3. **Core rules (crate `ptouch`):** `#![no_std]` + `alloc`. No I/O, clocks, threads, `HashMap`
   or floats in tables. No `unwrap`/`expect`/`panic!`/indexing that can go out of bounds on
   input-derived data (clippy warns on `unwrap_used`, `expect_used` and `panic`). Return
   `crate::Error`. Rustdoc on every public item.
4. **Native crates:** errors are `thiserror` enums. `unsafe` only inside
   `ptouch-transport/src/{macos,linux}/` (those modules already carry `#![allow(unsafe_code)]`).
5. **Spec over architecture:** where `PROTOCOL.md` and `ARCHITECTURE.md` §4.1 disagree, the
   scaffold follows the spec (§2 lists the deviations). Implement the scaffolded signatures.
6. **No GPL code.** Implement from the spec only (ptouch-print etc. are references for facts,
   never for code). **Never** commit a real Bluetooth address or a device-name suffix. Use
   `PT-P710BTxxxx` and `XX:XX:XX:XX:XX:XX`.
7. **No hardware.** Do not send anything to a real printer. Test against `VirtualPrinter`
   and fixtures.
8. **Definition of done:** no `todo!()` left in owned files. Delete the
   `#![allow(unused_variables…)] // TODO(WPn)` line at the top of each owned file. Then all of
   these pass:
   ```sh
   cargo fmt --all --check
   cargo clippy --workspace --all-targets -- -D warnings
   cargo test --workspace
   cargo check-wasm           # alias: check -p ptouch --target wasm32-unknown-unknown
   cargo check-nostd          # alias: build -p ptouch --no-default-features --target thumbv7em-none-eabihf
   RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps
   ```
   Also check Linux/Windows: `cargo check -p ptouch-transport -p ptouch-cli --target
   x86_64-unknown-linux-gnu` (and `x86_64-pc-windows-msvc`).
9. **Do not commit or push.** The integrator does that.

## 1. Shared files (frozen, owned by nobody)

| File | Content |
|---|---|
| `Cargo.toml` | workspace (resolver 3, edition 2024, rust-version 1.97); exact-pinned `[workspace.dependencies]`; lints; release profile |
| `rust-toolchain.toml`, `rustfmt.toml`, `clippy.toml`, `.cargo/config.toml` | toolchain 1.97.1 (+ wasm32, thumbv7em); fmt/clippy config; aliases `xtask`, `check-wasm`, `check-nostd` |
| `crates/ptouch/Cargo.toml` | features `std`, `serde`, `virtual` (default); dev-deps `proptest`, `toml`, `serde` |
| `crates/ptouch-transport/Cargo.toml` | `serialport`, `thiserror`; features `usb` (nusb), `macos-rfcomm` (objc2, block2, dispatch2, objc2-foundation, objc2-core-foundation, objc2-io-bluetooth; macOS only), `linux-rfcomm` (libc; Linux only), `virtual` |
| `crates/ptouch-cli/Cargo.toml` | bin `ptouch`; `clap` (derive, env), `fontdue`, `png`, `thiserror` |
| `xtask/Cargo.toml` | `toml`, `serde` |
| `crates/ptouch/src/lib.rs` | module tree and re-exports |
| `crates/ptouch/src/error.rs` | `Error`, `TimeoutKind`, `Error::code()`, `Display`, `core::error::Error` (**complete**) |
| `crates/ptouch-transport/src/lib.rs` | `Transport` trait, `TransportInfo`, `TransportKind`, module tree |
| `crates/ptouch/tests/fixtures/status/p710bt_24mm_laminated_idle.hex` | the real PT-P710BT status reply (read-only fixture) |

Implemented in the scaffold so that the work packages are unblocked:
- `Bitmap` storage primitives: `new`, `from_packed`, `get`, `set`, `line`, `as_packed`, `stride`.
- Model lookups: `profiles`, `profile`, `profile_by_codes`, `profile_by_usb_pid`, `profile_by_name`, `tape_spec`.
- A **seed** `model/generated.rs` with PT-P710BT and its 11 media entries, produced from
  `models.toml`.

These files belong to WP3 and WP1. Their owners may refine them but must keep them working.

## 2. Deviations from ARCHITECTURE.md §4.1 (adopted because the spec requires them)

| ARCHITECTURE §4.1 | Scaffold | Why |
|---|---|---|
| `Dialect` enum (Classic/D460/Cube/Wide560) | removed. Explicit parameters on `ModelProfile` instead: `page_command`, `null_bytes`, `caps`, `sends`, `cancel_command`, `protocol_version` | PROTOCOL.md §1 treats it as one protocol parameterised per model. models.toml carries those parameters. |
| `Model` with 7 variants | 27 variants (every `[[model]]`) | the table covers 27 models |
| `media.rs` (`TapeSpec`, `MediaType`, colours) | `model/media.rs` (`TapeSpec`, `TapeKind`, `Geometry`) + `status/codes.rs` (`MediaType`, `TapeColor`, `TextColor`) | the geometry comes from the table (WP1). The colour and type codes are status decoding (WP2). |
| `PrinterErrors(pub u16)` | `PrinterErrors { info1, info2, extended }` | §4.1/§4.5: bytes 7, 8, 9 are independent. `st[7]` must be evaluated too. |
| `Phase::Editing(u16)` | `Phase::Receiving(u16)`, plus `Other{kind, number}` | §4.3 wording, total decoding |
| `StatusType` | adds `ExitIfMode`; `Other(0x18)` counts as an error via `is_error()` | §4.2 |
| `encode_job(..)` → `EncodedJob { preamble, pages, total_lines }` | `EncodedJob { model, media_width_byte, media_type_byte, preamble, pages, page_lines, epilogue }` | session preflight (§6.1), per-page `T_est` (§6.8), `ESC i a FF` after completion (§6.10) |
| `JobOptions { auto_cut, mirror, chain, feed_margin_dots, compression, auto_status }` | `cut: CutMode`, `special_tape`, `high_resolution`, `feed_margin_dots: Option`, `compression: Option`, `z_for_blank_lines`, `pad_short_pages` | §3.2.2–§3.2.4, §5.4–§5.6, §6.9 |
| `Session::submit(job, job_media_mm, now)` | `submit(job, now)` (the job carries its media) | |
| `SessionConfig` (3 s / 30 s / 20 ms per line) | 5 s × 3 attempts, `T_est = 2.5 s + 10 ms/line` + 30 s margin, 10 s poll tick, 180 ticks | §2.1 "Wake-up", §6.8 |
| `Event::Failed(Error)` | `Event::Failed { error, resume_from_page }` | §6.10 resend rule |
| `SessionState` | adds `Draining`, `Recovering`; `Handshaking { attempt }` | §6.8, §6.10 |
| `VirtualPrinter::new(profile, media_width_mm, script)` | `new(profile, &TapeSpec, Behaviour)`, plus `parser::JobParser`, `decode_job` | needed for `ptouch decode` and the violation checks |
| `trim_blank() -> (u32, u32)` | `-> Option<(u32, u32)>` | a blank bitmap has no extent |
| Error variants | adds `DataLength`, `NoMedia`, `NotReady`, `PrinterOff`, `Cancelled`, `Unsupported`, `InvalidInput`, `Corrupt` (codes mirrored for TS later) | |
| `codes` feature (QR/Code128/EAN) | **deferred**. `ModuleMatrix` lives in `raster.rs`, so `LabelRaster::blit_code` already works with caller-supplied matrices. | not in Phase 1 scope |
| native `Transport { write_all, read, describe }` | `{ write_all, read, close, info }` with `TransportError` | task spec; typed errors |
| `ptouch-transport`: serial, nusb, IOBluetooth | + Linux raw RFCOMM (`libc`), TCP 9100, `virtual`, discovery, endpoint strings | task spec, PROTOCOL.md §2.3, §2.9 |
| `ptouch-wasm`, `web/` | not created yet (later phase); the core API stays wasm-friendly | |

---

## 3. Work packages

Dependency graph. An arrow means "needs it at **runtime/test time**". Everything compiles
today.

```
WP1 model ─┬──────────────► WP4 encode ─┬─► WP5 session + virtual ─┬─► WP6 transport (virtual, discovery hints)
WP3 bitmap ┼─ packbits ───►             │                          └─► WP7 CLI (uses all)
WP2 status ┴──────────────────────────► ┘
```
Suggested landing order: WP1, WP2, WP3 (small, no deps) → WP4 → WP5 → WP6, WP7. Packages that
depend on others write their code and tests against the scaffolded API now. Those tests pass
once the dependency lands (until then they hit `todo!()`).

### WP1 — Model tables and generator

**Owns**
- `crates/ptouch/src/model/mod.rs`, `crates/ptouch/src/model/media.rs`, `crates/ptouch/src/model/generated.rs`
- `xtask/src/**`
- `crates/ptouch/tests/model.rs`

**Public API to implement**
- `cargo xtask gen-models [--check]` (contract in `xtask/src/main.rs`). Parses `docs/models.toml`
  (serde, `deny_unknown_fields`, including `[meta]` and `schema_version`), validates, and emits
  `generated.rs` in the exact shape of the seed (one `static` per media id, `MEDIA`,
  `PROFILES`, mm values ×10, hex bytes). Then runs `rustfmt` on the output. `--check` exits 1
  when the file is stale.
- Regenerate `generated.rs` for all 27 models and 44 media.
- `ModelProfile::min_lines(margin_dots, high_res)` and `max_lines(high_res)` (§5.6).
  Use `round(min_length_mm × feed_dpi / 25.4) − 2 × margin`, minimum 1, and 4.8 mm when the
  value is unknown. Vectors: P710BT 3 @ margin 14, 31 @ 0; E560BT 6 / 34; P910BT 29 / 57;
  P710BT `max_lines(false) == 7086`.
- `profile_by_bt_name` (§2.1): exact name, else drop 4 chars, else drop 4 chars and a trailing `_`.
- `TapeKind::from_status_media_type`, `tape_for_status` (§4.6.1 resolution: `11`/`13`/`17`
  special tables; `16` tries SL then TZe; `00`/`FF` → `NoMedia`; others → TZe; `0x14` accepted).
- Keep the scaffolded lookups (`profiles`, `profile*`, `tape_spec`, `all_media`).

**Spec**: PROTOCOL.md §1, §2.1 (device name), §2.8 (PIDs), §3.3, §4.1, §4.6.1–§4.6.2, §4.7
(`battery_format`), §5.1–§5.2, §5.6, §7; the models.toml header.

**Tests** (`tests/model.rs` + unit tests)
- The generator round-trips: `gen-models --check` passes on the committed file (run it as a test
  through `std::process::Command`, or test the generator's pure function from `xtask` unit tests).
- Every media: `left + print + right == head_pins`. Every profile: `bytes_per_line × 8 ==
  head_pins`, `media` non-empty, unique `(series, model)` codes, unique PIDs.
- PT-P710BT: codes 0x30/0x76, PID 0x20AF, print pins 24/32/50/70/112/128 for widths 4/6/9/12/18/24,
  `null_bytes` 100, `StartEnd`, `special_tape_k` 0x18, `caps.cut_every == Some(false)`.
- Spot checks from §5.2: P300BT 12 mm = 32/64/32; P910BT 24 mm = 112/320/128; N25BT 12 mm = 0/64/0.
- `profile_by_bt_name("PT-P710BTxxxx")`, `("PT-E560BT_xxxx")`, `("PT-P710BT")` → the right model;
  `("Foo")` → None.
- `tape_for_status` for the fixture bytes (24, 0x01) → `tze128-24`; (0, 0x00) → `NoMedia`;
  (24, 0x11) → `hs2-128-23.6`; (24, 0x14) → TZe.
- `min_lines` / `max_lines` vectors above.

### WP2 — Status parsing and framing

**Owns**
- `crates/ptouch/src/status/mod.rs`, `crates/ptouch/src/status/codes.rs`, `crates/ptouch/src/status/framer.rs`
- `crates/ptouch/tests/status.rs`, new files under `crates/ptouch/tests/fixtures/status/` (not the existing fixture)

**Public API to implement**
- `parse_status`. `Status::{is_error, is_ready, has_media, battery, weak_battery}`.
- `StatusType`, `Phase`, `Notification`, `MediaType`, `TapeColor`, `TextColor`, `ExtendedError`:
  total `from_byte` and round-tripping `to_byte`. `TapeColor`/`TextColor` also need `name()` and
  `css()` (swatches approximating `ptemct.ini` colours).
- `PrinterErrors::{is_empty, iter, headline}`, `PrinterErrorIter`, `PrinterError::message`.
- `StatusFramer::{push, next_frame}` (resync on `80 20 42`, skip-one-byte on a bad frame,
  bounded buffer).

**Spec**: PROTOCOL.md §2.1 "Reads", §4.1–§4.7; ARCHITECTURE.md §8.1.

**Tests**
- The real fixture parses exactly as listed in the `status` module docs (ARCHITECTURE.md §8.1).
- Synthetic frames derived from the fixture for every status type (incl. `18` → error), both
  phase types and numbers (`0014`), every notification, every single error bit in `st[8]`/`st[9]`,
  multi-bit combinations (all reported, in precedence order), and every documented `st[7]` value.
- Battery: every row of the §4.7 tables per `BatteryFormat`. `Reserved`/`None` → `Unknown`.
- Header errors: wrong length → `StatusLength`; `80 20 43` → `StatusHeader`.
- Framer: the fixture split at every offset (1..31) → exactly one frame; two coalesced frames
  → two; garbage prefix (including a false `80 20` without `42`) → discarded and counted; 1-byte
  pushes; proptest: arbitrary chunking of N valid frames + noise yields those N frames in order
  and never panics.
- proptest: `parse_status` never panics on arbitrary 32-byte input.

### WP3 — Bitmap, raster composition, dithering, PackBits

**Owns**
- `crates/ptouch/src/bitmap.rs`, `crates/ptouch/src/raster.rs`, `crates/ptouch/src/dither.rs`, `crates/ptouch/src/packbits.rs`
- `crates/ptouch/tests/bitmap.rs`, `crates/ptouch/tests/dither.rs`, `crates/ptouch/tests/packbits.rs`, `crates/ptouch/tests/fixtures/pbm/**`

**Public API to implement**
- `Bitmap`: `from_fn`, `from_luma`, `is_line_blank`, `is_blank`, `trim_blank`, `crop_lines`,
  `padded_to`, `reversed`, `flipped_across`, `inverted`, `blit_or`, `to_rgba`, `to_pbm`, `from_pbm`.
  The storage primitives are already implemented. Keep them and their layout.
- `dither`: `rgba_to_luma`, `adjust_tone`, `dither` (Threshold, Floyd–Steinberg, Atkinson,
  Bayer 4/8). Integer-only and deterministic.
- `LabelRaster`: `blit_crisp` (box filter at `factor`×, coverage threshold), `blit_tone`,
  `blit_code` (integer modules, quiet zone, protected mask), `blit_bitmap`, `finish`.
- `packbits_encode`, `packbits_decode` (Brother variant, deterministic run splitting, literal
  fallback when the encoding is longer than raw).

**Spec**: ARCHITECTURE.md §4.1 (raster/dither), §5.1–§5.2; PROTOCOL.md §5.5.

**Tests**
- PackBits vectors in the `packbits` module docs (doc example, ARCH §8.1 vectors, 16×00 → `F1 00`,
  incompressible → `0F`+16, 12 mm worked example). proptest: `decode(encode(x)) == x` for
  arbitrary lines of 1..=128 bytes; encoded length ≤ `len + 1`; `decode` never panics on
  arbitrary input and rejects overrun/underrun.
- Bitmap: layout (MSB-first, line-major, padding bits zero after `from_packed`), `get`/`set`
  bounds, `trim_blank`, flips are involutions, `to_pbm`/`from_pbm` round-trip (P4 and P1), PBM
  errors (bad magic, truncated data, huge dimensions).
- Dither: threshold exactness; identity `ToneAdjust`; black/white inputs stay solid under every
  method; Bayer output matches a hand-computed 4×4 tile; alpha 0 → white in `rgba_to_luma`;
  length mismatches → `DataLength`.
- LabelRaster: a crisp 3× plane of one black 3×3 block → one dot; codes are not overwritten by a
  later tone blit; clipping with negative offsets; `module_dots == 0` → `InvalidInput`.

### WP4 — Encoder and job builder

**Owns**
- `crates/ptouch/src/encode/mod.rs`, `crates/ptouch/src/encode/commands.rs`, `crates/ptouch/src/encode/line.rs`
- `crates/ptouch/tests/encode.rs`, `crates/ptouch/tests/golden/**`

**Public API to implement**
- `commands::*`: all command builders (§3.1–§3.2 byte layouts).
- `line::head_line` (§5.1 pin mapping: dot `p` → transmitted bit `right + print − 1 − p`).
- `encode_job`, `EncodedJob::to_bytes`, `reset_sequence`, `cancel_sequence`,
  `handshake_sequence`, `generic_handshake_sequence`.
- Model gating from `ModelProfile`:
  - `ESC i !` only if `caps.status_notify && opts.auto_status`, on page 1.
  - `ESC i A` only if `caps.cut_every == Some(true)`.
  - `ESC i k c` per `sends.copies_command`. `ESC i p`/`L`/`C` per `sends`.
  - n9 per `page_command`. n1 = 0x84 (|0x02 + n2 high-res/special per §3.2.1).
  - K bits per §6.9 (`special_tape_k`; 0x40 high-res). P300BT order is K before M (§6.6).
  - `M 00`/`M 02` per option/default. `Z` only with PackBits. Literal fallback for long encodings.
  - Margin default = `tape.default_feed_dots` (×2 high-res).
  - Pad to `min_lines` / reject above `max_lines`. Unsupported options → `Error::Unsupported`.
  - `epilogue` = `1B 69 61 FF` iff `sends.mode_reset_at_end`.

**Spec**: PROTOCOL.md §3.1–§3.3, §5.1, §5.3–§5.6, §6.2–§6.7, §6.9–§6.10; ARCHITECTURE.md §5.3, §8.2.

**Tests**
- `head_line`: the 12 mm all-black worked example (`00 00 00 07 FF×8 E0 00 00 00`), 24 mm
  (full 16 bytes), 3.5 mm, single-dot positions p = 0 and p = print−1 (the bit positions are
  checked by hand against §5.1), and a 560-pin case (P910BT 24 mm: bytes 0–15 and 56–69 zero).
- P710BT 24 mm single page vs PROTOCOL.md §6.3, byte for byte (hand-built expected vector).
  Header matches the D1 dump: `1B 69 7A 84 00 18 00 <lines> 00 00`, page 2 `… 01 00`,
  `1B 69 4D 40`, `1B 69 4B 08`, `1B 69 64 0E 00`, `4D 02`, blank line `5A` (or `47 02 00 F1 00`
  with `z_for_blank_lines = false`).
- Multi-page: `0C` between pages, `1A` last, n9 0/1 (start_end) and 0/1/2 or 2 for single
  (start_next_end, using the E560BT profile once WP1 lands).
- Options: chain → `K 00`; no cut → `M 00`; mirror → `M C0`; special tape → `K 18`; half cut on
  P710BT → `Unsupported`; `Compression::None` → `47 10 00` + 16 raw bytes and no `5A`.
- Geometry errors: height ≠ print pins → `BitmapSize`; 0 pages → `Empty`; 7087 lines → `TooLong`;
  2 lines padded to 3 with margin 14; `pad_short_pages = false` → `TooShort`.
- Goldens (`tests/golden/`, format in its README): P710BT 24 mm blank / ruler / orientation,
  12 mm text, 2-page copies, chain on/off, mirror. PBM sources need WP3's `from_pbm`. Until it
  lands, build bitmaps in code. `UPDATE_GOLDEN=1` regenerates. A mismatch prints an annotated
  hex diff by command.
- Round-trip once WP5 lands: `virtual_printer::decode_job(encode_job(x)).pages == x`.

### WP5 — Session state machine and virtual printer

**Owns**
- `crates/ptouch/src/session.rs`
- `crates/ptouch/src/virtual_printer/mod.rs`, `crates/ptouch/src/virtual_printer/parser.rs`
- `crates/ptouch/tests/session.rs`, `crates/ptouch/tests/virtual_printer.rs`

**Public API to implement**
- `Session::{connect, request_status, submit, cancel, handle_input, handle_timeout}` (the poll
  accessors are already implemented). Private fields may be added freely.
  - Handshake: `generic_handshake_sequence` (or `handshake_sequence` with a known profile), drain
    `mode_switch_drain_ms`, `ESC i S`, wait `status_timeout_ms`, up to `status_attempts` attempts
    each re-sending the reset. Validate the header, detect or verify the model, emit `Ready`.
  - Preflight (§6.1.6), page pacing (§5.4, §6.8), completion table (§6.8.3) including the 2 s
    trailing phase frame on start_end models, `T_est` + margin on push models, the poll fallback
    for models without `caps.status_notify`, cooling suspends the clock, 180-tick limit, the
    error path with `resume_from_page` (§6.10), cancel → `cancel_sequence` → `Recovering` → poll
    until ready, post-job drain.
  - Never transmit during printing, except the documented poll fallback.
- `VirtualPrinter::{new, handle_input, poll_output, idle_status}`, `Behaviour` scripts,
  `parser::JobParser::{push, next_command}`, `decode_job`, `Violation` detection.

**Spec**: PROTOCOL.md §2.1 (wake-up, reads), §3.1, §4.2–§4.5, §6.1, §6.3 (expected frames
after `1A`), §6.8, §6.10; ARCHITECTURE.md §5.4–§5.6, §8.1.

**Tests** (`tests/session.rs` drives `Session` against `VirtualPrinter` with a simulated clock)
- Normal: connect → `Ready` with the fixture-equal status. 1-page and 3-page jobs → `PageStarted`
  / `PageCompleted` per page, then `JobCompleted`. Page n+1 is transmitted only after page n
  completed. Nothing is transmitted between a page and its completion.
- Fragmented input (frames split 7 + 25, 1-byte chunks, coalesced frames).
- Silent printer → 3 attempts → `Failed(Timeout(Handshake))`.
- Wrong media → `submit` returns `MediaMismatch`; no media → `NoMedia`; model mismatch → `UnknownModel`.
- Cover open on page 2 → `Failed { Printer(..), resume_from_page: Some(2) }`, cancel sequence
  sent, back to `Ready` after a ready status.
- `request_status` while printing → `Busy`. Cancel mid-job.
- `NoPush` behaviour on a profile without `status_notify` → poll fallback completes. On a push
  profile → `Timeout(Page)` only after `T_est` + margin.
- Cooling notification extends the deadline. Extra frames after the job are swallowed.
- Virtual printer: `idle_status()` equals the fixture bytes for PT-P710BT/24 mm. `printed()`
  equals the submitted bitmaps. Violations are detected (command while printing, data outside
  the print area, line-count mismatch). proptest: `JobParser` never panics on arbitrary bytes or
  chunking.

### WP6 — Native transports (`ptouch-transport`)

**Owns**
- every file under `crates/ptouch-transport/src/` **except** `lib.rs`:
  `error.rs`, `endpoint.rs`, `discovery.rs`, `runloop.rs`, `serial.rs`, `tcp.rs`, `usb.rs`,
  `virtual_transport.rs`, `macos/mod.rs`, `macos/rfcomm.rs`, `linux/mod.rs`, `linux/rfcomm.rs`
  (new private submodules may be added under `macos/`, `linux/`)
- `crates/ptouch-transport/tests/**`

**Public API to implement**
- `Endpoint` / `BtAddr` `FromStr` + `Display` (grammar in `endpoint.rs`), `open`, `OpenOptions`.
- `SerialTransport` (9600 8N1, no flow control, DTR/RTS, timeout → `Ok(0)`), `TcpTransport`,
  `UsbTransport` + `list` (nusb, interface 0, EP 0x02/0x81, never-abandoned IN transfer, Editor
  Lite PID rejection).
- `MacRfcommTransport::connect` + `run_main_loop` + `paired_devices` (PROTOCOL.md §2.2 steps 1–13,
  including SDP polling, multiplexer priming, fail-fast on `kIOReturnTimeout`, MTU-chunked
  `writeSync`, a clean close with run-loop drain). Port the *ideas* of the scratchpad prototype
  `proto/rfcomm-macos`, not its `MTU 0 → 65535` shortcut.
- `LinuxRfcommTransport::connect` (raw `AF_BLUETOOTH` socket, channel fallback, `EBUSY` retry).
- Channel acceptance (§2.1): a candidate channel counts only after a valid `80 20 42` status reply
  to `00×100 1B 40 1B 69 53` within the read timeout. Implement this as a private helper shared by
  the macOS and Linux backends.
- `VirtualTransport` (clock, fragmentation), `discover` (serial `PT-` names + `/dev/rfcomm*`, macOS
  paired devices, USB; model hints via `ptouch::profile_by_bt_name` / `profile_by_usb_pid`).

**Spec**: PROTOCOL.md §2.1–§2.4, §2.8, §2.9; ARCHITECTURE.md §3.2 (macOS serial-node caveats),
§4.4, §5.4 (chunking), §5.6.

**Tests** (no hardware)
- Endpoint parse/display round-trips and every error case. `BtAddr` parsing (case, separators,
  bad length).
- `TcpTransport` against a local `TcpListener` echo/fixture server: write_all, read timeout →
  `Ok(0)`, close idempotent.
- `VirtualTransport` + `ptouch::Session`: status round-trip with fragmentation `[7, 25]`.
- MTU chunking helper (pure function): never yields an empty chunk, MTU 0 → 320.
- Channel-candidate order helper (pure): SDP, then `rfcomm_channel_observed`, then 1, then 2,
  deduplicated.
- Backends that need hardware (serial, USB, RFCOMM) get `#[ignore]` smoke tests that read
  `PTOUCH_TEST_DEVICE` and only ever send `ESC i S`. They are never run in CI.

### WP7 — CLI (`ptouch` binary)

**Owns**
- every file under `crates/ptouch-cli/src/` (`main.rs`, `cli.rs`, `error.rs`, `driver.rs`,
  `commands/**`, `render/**`)
- `crates/ptouch-cli/tests/**`, `docs/HARDWARE-TESTS.md`

**Public API / behaviour to implement**
- `Driver` (pump loop in `driver.rs`: clock, transmit/event/timeout handling, `-v` hex log),
  `connect`, `status`, `print` with progress.
- Commands:
  - `status`: decoded fields and raw hex; exit 1 on a printer error.
  - `print --text/--image`: built-in 5×7 font or `fontdue`; PNG/PBM/PGM; dither options.
  - `test-label orientation|ruler`.
  - `list`/`discover`.
  - `info [model]`: offline table, print areas from §5.2.
  - `decode job.bin --out pages.pbm`: via `virtual_printer::decode_job`; print violations.
  - Shared: `--device`/`$PTOUCH_DEVICE`/single discovered device; `--model`;
    `--dry-run --out`; `--copies` → repeated pages; software mirror where `!caps.mirror`;
    tape = loaded tape (from status) unless `--tape`, mismatch → clear error.
- `CliError::hint` for the common failures (asleep → power-cycle; port busy → close other tools;
  TCC → grant the terminal Bluetooth access; Editor Lite on).
- The original 5×7 font (`render/font5x7.rs`, drawn by hand, no copied glyph tables).
- `docs/HARDWARE-TESTS.md`: the manual procedure from ARCHITECTURE.md §8.5 and §12 (H1…), using
  `PT-P710BTxxxx` placeholders only.

**Spec**: ARCHITECTURE.md §4.4, §5.1 (orientation label), §8.5; PROTOCOL.md §5.2 (ruler checks
print area), §6.10 (resend guidance in messages).

**Tests** (`crates/ptouch-cli/tests/cli.rs`, run the built binary via `env!("CARGO_BIN_EXE_ptouch")`)
- `ptouch info` lists PT-P710BT. `info PT-P710BT` shows 24/32/50/70/112/128.
- `print --text Hi --tape 24 --dry-run --out t.bin`, then `decode t.bin --out p.pbm` → a valid PBM
  with height 128. The `.bin` ends in `1A`.
- `--device virtual:24 status` prints the fixture fields. `--device virtual:24 print --text Hi`
  completes. `--device virtual:12 print --tape 24 …` fails with a media-mismatch message.
- `test-label ruler --tape 24 --dry-run` is deterministic (the same bytes twice).
- Unit tests: 5×7 glyph coverage for 0x20–0x7E. Ruler tick positions at 180 dpi (10 mm = 71 dots
  from origin, cumulative rounding). Text height scaling.

---

## 4. Ownership matrix (disjointness check)

| Path | Owner |
|---|---|
| `Cargo.toml`, `rust-toolchain.toml`, `rustfmt.toml`, `clippy.toml`, `.cargo/config.toml`, `crates/*/Cargo.toml`, `xtask/Cargo.toml` | shared (frozen) |
| `crates/ptouch/src/lib.rs`, `crates/ptouch/src/error.rs` | shared (frozen) |
| `crates/ptouch/src/model/**`, `xtask/src/**`, `crates/ptouch/tests/model.rs` | WP1 |
| `crates/ptouch/src/status/**`, `crates/ptouch/tests/status.rs`, `crates/ptouch/tests/fixtures/status/*` (new files) | WP2 |
| `crates/ptouch/src/{bitmap,raster,dither,packbits}.rs`, `crates/ptouch/tests/{bitmap,dither,packbits}.rs`, `crates/ptouch/tests/fixtures/pbm/**` | WP3 |
| `crates/ptouch/src/encode/**`, `crates/ptouch/tests/encode.rs`, `crates/ptouch/tests/golden/**` | WP4 |
| `crates/ptouch/src/session.rs`, `crates/ptouch/src/virtual_printer/**`, `crates/ptouch/tests/{session,virtual_printer}.rs` | WP5 |
| `crates/ptouch-transport/src/**` except `lib.rs`, `crates/ptouch-transport/tests/**` | WP6 |
| `crates/ptouch-cli/**` except `Cargo.toml`, `docs/HARDWARE-TESTS.md` | WP7 |

## 5. Follow-ups (not in Phase 1)

- `cargo-fuzz` targets (`parse_status`, `StatusFramer`, `Session::handle_input`,
  `packbits_decode`, `JobParser`). They need a `fuzz/` crate and nightly. Until then, the
  proptest "never panics" tests stand in.
- `codes` feature (QR / Code128 / EAN-13 → `ModuleMatrix`), `ptouch-wasm`, `web/`.
- SNMP status for network models (PROTOCOL.md §2.9). Windows Bluetooth (Winsock `AF_BTH`, §2.4).
  PT-N25BT BLE (§2.7).
- CI workflow (fmt, clippy, tests, `check-wasm`, `check-nostd`, `xtask gen-models --check`, Linux
  and Windows `cargo check`).

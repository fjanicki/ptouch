# ptouch

An open-source library and tools for printing to Brother P-touch label printers over Bluetooth, written in Rust.

The goal is a browser-based label print studio, hosted on GitHub Pages, that talks directly to a printer paired with your computer. No vendor app is needed.

**Status:** early development. Primary target: **PT-P710BT** (Cube Plus). The model table covers 27 P-touch models (PT-P300BT, PT-P910BT, PT-D460BT, PT-D610BT, PT-E310BT, PT-E560BT, …), but only the PT-P710BT has been checked against real hardware so far.

## Layout

| Crate | What it is |
|---|---|
| [`crates/ptouch`](crates/ptouch) | The protocol core. Sans-IO, `#![no_std]` + `alloc`, builds for WebAssembly. Model and media tables, status parsing, bitmaps and dithering, raster encoding with PackBits, the print session state machine, and a virtual printer for tests. |
| [`crates/ptouch-transport`](crates/ptouch-transport) | Native byte transports: serial ports (`/dev/cu.*`, `COMn`, `/dev/rfcommN`), Bluetooth RFCOMM (macOS IOBluetooth, Linux sockets), USB, raw TCP, and an in-process virtual printer. Device discovery. |
| [`crates/ptouch-cli`](crates/ptouch-cli) | The `ptouch` command-line tool, used for development and hardware testing. |
| `xtask` | Repository tooling (`cargo xtask gen-models` regenerates the model table from [`docs/models.toml`](docs/models.toml)). |
| `web/` (planned) | The browser studio (Web Serial). |

The library is kept strictly separate from any UI: the CLI (and later the web and TUI front ends) depend on the library, never the reverse.

Design documents: [`docs/PROTOCOL.md`](docs/PROTOCOL.md) (the normative protocol spec), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/HARDWARE-TESTS.md`](docs/HARDWARE-TESTS.md).

## Building

You need [rustup](https://rustup.rs). The toolchain (Rust 1.97.1, with the `wasm32-unknown-unknown` and `thumbv7em-none-eabihf` targets) is pinned in `rust-toolchain.toml` and installed automatically on first use.

```sh
cargo build --release -p ptouch-cli     # the binary is target/release/ptouch
cargo install --path crates/ptouch-cli  # or install `ptouch` into ~/.cargo/bin
```

Checks run by CI (`.github/workflows/ci.yml`):

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo check -p ptouch --target wasm32-unknown-unknown                       # alias: cargo check-wasm
cargo build -p ptouch --no-default-features --target thumbv7em-none-eabihf  # alias: cargo check-nostd
cargo xtask gen-models --check
```

No test talks to a real printer. The hardware smoke tests in `crates/ptouch-transport/tests/hardware.rs` are `#[ignore]`d and only run by hand (see [`docs/HARDWARE-TESTS.md`](docs/HARDWARE-TESTS.md)).

## Using the CLI

### Connecting

Pair the printer in your system's Bluetooth settings first. Then choose a connection with one of:

| Flag | Example |
|---|---|
| `--port PATH` | `--port /dev/cu.PT-P710BTxxxx` (macOS serial node of the paired printer), `--port COM5`, `--port /dev/rfcomm0` |
| `--bt ADDR\|NAME` | `--bt PT-P710BTxxxx` (paired device name) or a Bluetooth address |
| `--usb` | the first Brother USB printer |
| `--tcp HOST[:PORT]` | a network printer (raw TCP, port 9100) |
| `--device ENDPOINT` | `serial:/dev/cu.PT-P710BTxxxx`, `bt:…`, `usb:`, `tcp:host`, `virtual:24` |

`$PTOUCH_DEVICE` sets a default endpoint. With no flag and no variable, `ptouch` uses the printer it discovers, if there is exactly one (`ptouch list` shows the candidates). On macOS, native Bluetooth needs your terminal app to be allowed Bluetooth access (System Settings → Privacy & Security → Bluetooth).

`PT-P710BTxxxx` stands for your printer's device name; the last four characters differ per printer.

### Examples

```sh
# Status: model, loaded tape, colours, errors, and the raw 32-byte reply.
ptouch status --port /dev/cu.PT-P710BTxxxx

# Print text. The tape is read from the printer; --tape only double-checks it.
ptouch print --port /dev/cu.PT-P710BTxxxx --text "Hello"
ptouch print --port /dev/cu.PT-P710BTxxxx --text 'Line 1\nLine 2' --tape 12 --copies 2
ptouch print --port /dev/cu.PT-P710BTxxxx --text "Cables" --font "Helvetica" --length 80

# Print an image (PNG, PBM or PGM), scaled to the tape and dithered.
ptouch print --port /dev/cu.PT-P710BTxxxx --image logo.png --dither floyd-steinberg

# Built-in test labels (PROTOCOL.md §9.1).
ptouch test-label orientation --port /dev/cu.PT-P710BTxxxx
ptouch test-label ruler --tape 24 --port /dev/cu.PT-P710BTxxxx

# Discovery and the model/media table.
ptouch list
ptouch info PT-P710BT
ptouch fonts mono
```

Job options shared by `print` and `test-label` include `--tape`, `--copies`, `--chain`, `--no-cut`, `--half-cut`, `--mirror`, `--margin`, `--high-res`, `--no-compression` and `--from-page N` (resume after an error). `ptouch <command> --help` lists them all. Add `-v` for a hex packet log, `-vv` for session events as well.

### Offline: previews, dry runs and decoding

None of these needs a printer. Offline commands assume a PT-P710BT unless you pass `--model`.

```sh
ptouch print --text "Hello" --tape 24 --preview              # ASCII-art preview in the terminal
ptouch print --text "Hello" --tape 24 --preview-png hello.png
ptouch print --text "Hello" --tape 24 --dry-run --out job.bin
ptouch --model PT-E560BT test-label ruler --tape 12 --dry-run  # hex dump on stdout
ptouch decode job.bin --out pages.pbm --preview
ptouch --device virtual:24 print --text "Hello"              # full print against the in-process virtual printer
```

`--dry-run` writes the byte-exact job, then checks it twice: it decodes the bytes offline, and it prints them through the real print session against a simulated printer. It reports whether the result matches the rendered label and lists any protocol violations.

Exit codes: 0 on success, 1 on a printer, transport or rendering error (with a one-line hint for common problems), 2 on a usage error.

## Using the library

`ptouch` never opens a port or reads a clock. You render a 1-bit `Bitmap`, encode it for a model and tape, and move bytes and time in and out of a `Session`:

```rust
use ptouch::{Bitmap, JobOptions, Model, TapeKind, encode_job, profile, tape_spec};

let p710 = profile(Model::PtP710bt).expect("in the model table");
let tape = tape_spec(p710, 24, TapeKind::Tze).expect("24 mm TZe");
// Raster line x runs across the tape; y counts the printable dots (128 on 24 mm).
let label = Bitmap::from_fn(200, tape.print_pins, |x, y| (x / 16 + u32::from(y) / 16) % 2 == 0);
let job = encode_job(p710, tape, &[&label], &JobOptions::default())?;
// Either write job.to_bytes() directly, or hand the job to a ptouch::Session, which paces the
// pages against the printer's status replies (see crates/ptouch-cli/src/driver.rs).
```

## Disclaimer

This project is independent and is not affiliated with, endorsed by, or supported by Brother Industries, Ltd. "Brother" and "P-touch" are trademarks of Brother Industries, Ltd. The protocol is documented from Brother's public developer documentation and interoperability research.

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or [MIT license](LICENSE-MIT), at your option.

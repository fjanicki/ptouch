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
| [`crates/ptouch-wasm`](crates/ptouch-wasm) | WebAssembly bindings of the core for the browser (bindings only, no protocol logic). |
| `xtask` | Repository tooling (`cargo xtask gen-models` regenerates the model table from [`docs/models.toml`](docs/models.toml)). |
| [`web/`](web) | The browser print studio (Svelte + Vite; Web Serial / WebUSB), see [Web studio](#web-studio). |

The library is kept strictly separate from any UI: the CLI and the web studio (and later a TUI) depend on the library, never the reverse.

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

## Web studio

**https://fjanicki.github.io/ptouch/** is a label editor that prints straight from the browser. Nothing to install, no account. The protocol runs in the same Rust core as the CLI, compiled to WebAssembly; the page itself only edits, renders and moves bytes.

| Browser | Printing |
|---|---|
| Chrome / Edge 117+ on macOS, Windows, Linux, ChromeOS | Bluetooth (Web Serial), plus USB on macOS/Linux/ChromeOS |
| Chrome on Android 138+ | Bluetooth |
| Firefox 151+ | Serial ports only. On macOS the `/dev/cu.*` port of a Bluetooth printer stops answering after its first use, so use Chrome or Edge there |
| Safari, any browser on iOS | Not possible (no Web Serial). You can still design labels and send them to a computer to print (see *On an iPhone* below) |

To print over Bluetooth:

1. Pair the printer in your system's Bluetooth settings (it shows up as `PT-P710BTxxxx`).
2. Open the studio in Chrome or Edge and click **Connect printer → Bluetooth**, then pick the printer in the browser's list. If it is not listed, use **Choose port…**, which shows every serial port the browser can see.
3. Design the label and click **Print**. Tape width and colours are read from the printer.

On macOS the first connection after the printer has been idle often fails while it wakes up (the browser reports "Failed to open serial port" after about 10 s). The studio retries automatically and shows *Waking printer…*; the second attempt usually connects in under half a second. Chrome remembers the printer, so later visits reconnect without asking.

**What you can make.**

- **Blocks:** text, images, icons, QR codes, DataMatrix, Code 128 and EAN-13.
- **Templates** (*Labels → New from template…*): a Wi-Fi sticker (12 and 24 mm), a cable flag and a cable wrap, shelf, bin and drawer labels (including a 12 mm Gridfinity bin label), an asset tag with a running number, a folder spine and a name tag.
- **Wi-Fi QR codes:** choose *Wi-Fi network* as the content of a QR code and enter the network name, security type and password. The iPhone Camera app (and Android) offers to join the network when it scans the code. *Add network name label* prints the name next to the code.
- **Bigger codes on narrow tape:** the *Compact* quiet zone counts the tape's unprinted edge as the blank margin above and below the code. With the module size on *Auto* (the largest that fits), a code can then fill the printable height. The editor shows the printed size in mm and how well a phone will read it: 3 or more dots per module is good, 2 works close up, 1 is unreliable.
- **QR or DataMatrix:** QR is best for phone cameras. DataMatrix fits more on narrow tape but, as far as we know, the iPhone Camera app does not read it. It needs a scanner app, but no special hardware.
- **Variables and batches:** write `{{name}}` in a text or code block and paste a table (CSV, or copied from a spreadsheet; the first row names the columns). You can also use counters (`{{n}}`, for example `A-001`, `A-002`, …) and dates (`{{today}}`, `{{today+30d}}`). Each row becomes one label, and the whole batch prints as **one** job, so the ~24 mm leader is fed only once.
- **Your own fonts:** upload TTF, OTF, WOFF or WOFF2 files, or use fonts installed on the computer (Chrome and Edge on desktop).
- **Export the exact print** as a 1-bit PNG at 180 dpi or as a true-size PDF.
- **Print history:** the last 50 printed labels, ready to reprint or open again. A tape counter shows how much tape you have used for each width.

**On an iPhone.** Every iOS browser is built on Safari's engine (WebKit), which cannot reach printers. On the iPhone you can design labels in the studio. To print, use *Send to computer*: it shares the label as a link or a `.ptlabel.json` file over AirDrop or Messages, and you open it in Chrome or Edge on the computer. Use *Share → Add to Home Screen* to install the studio as an app.

**Privacy.** Everything stays in your browser. Labels are saved in the browser's IndexedDB, preferences in `localStorage`. The page makes no network requests after it has loaded (enforced by its Content Security Policy), and share links carry the label in the URL fragment (`#d=…`), which browsers never send to a server. After the first visit the studio also works offline and can be installed as an app. Wi-Fi passwords are saved only in this browser: share links and exported label files leave them out unless you tick *Include Wi-Fi password*. Uploaded fonts, print history and the tape counter are also stored only in the browser. The diagnostics report never includes your labels.

**Labels** autosave as you edit. *Export* writes a self-contained `.ptlabel.json` file with the images included. *Share link* puts the label into a link and leaves out images over 32 KB. Custom fonts are never included, so the receiver sees the built-in font unless they have the same font.

**Diagnostics** (top bar, or `…/ptouch/#diagnostics`) shows what the browser supports, probes the link by every connection path (status request, open/close ×3) with a hex packet log, prints orientation and ruler test labels, and encodes jobs against a virtual printer so you can download the exact bytes. *Copy diagnostics* produces a bug report with device names and addresses masked.

Running it locally (Node 24.18+, plus the Rust toolchain and wasm-pack 0.15.0):

```sh
cd web
npm ci
npm run wasm          # build the wasm bindings into src/wasm/pkg
npm run dev           # http://localhost:5173/
npm test              # unit tests; `npm run e2e` runs the Playwright suite against a production build
BASE_PATH=/ptouch/ npm run build && npx vite preview --base /ptouch/   # the site as GitHub Pages serves it
```

Bundled third-party code, fonts and icons are listed in [`web/THIRD_PARTY.md`](web/THIRD_PARTY.md). CI tests the web app on every push and pull request ([`.github/workflows/ci.yml`](.github/workflows/ci.yml) via [`web.yml`](.github/workflows/web.yml)), and [`.github/workflows/pages.yml`](.github/workflows/pages.yml) re-runs those checks and deploys the site on every push to `main`.

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

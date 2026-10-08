# ptouch — Architecture

Status: **accepted design, pre-implementation** · Date: 2026-10-08 · Primary model: **PT-P710BT**

This document fixes the stack, the module boundaries and the public APIs for a static, browser-based
P-touch label studio hosted on GitHub Pages, plus the Rust library and CLI that share its protocol core.
Where something is not yet proven on hardware it is marked **UNCERTAIN** and listed in §12; nothing
marked UNCERTAIN may be relied on without the hardware test that resolves it.

Evidence base (not in the repo): research notes `web-browser-transport.md`, `web-wasm-stack.md`,
`web-prior-art.md`, `official-docs.md`, `media-status.md`, `oss.md`, `rust-transport.md`, plus a
fact-check pass against Chromium/Gecko source, chromestatus, MDN BCD 8.1.5 and the registries
(all as of 2026-10-08). The protocol itself will be specified in `docs/PROTOCOL.md`.

---

## 1. Goals and non-goals

### Goals
1. **Print from a web page, no native app.** A static site at `https://<user>.github.io/ptouch/`
   prints to a P-touch printer that is already paired with (or plugged into) the computer, using
   **Web Serial** (Bluetooth SPP/RFCOMM) and, as a secondary path, **WebUSB**.
2. **WYSIWYG at the dot level.** The preview *is* the 1-bit bitmap that is sent, tinted with the tape
   and ink colours the printer reports.
3. **One protocol implementation.** A sans-IO, `no_std + alloc` Rust core is compiled to WebAssembly
   for the browser and linked natively into a CLI. Browser and CLI produce byte-identical jobs.
4. **PT-P710BT first, model-table driven.** Adding a model is adding a profile + golden tests, not
   new code paths (except for genuinely different dialects, see §4.1).
5. **Offline-capable and private.** No backend, no analytics, no network calls after load. Designs
   live in the browser (IndexedDB) and in user-exported files.
6. **Testable without hardware.** Every layer has a fake: a virtual printer in the core, a mock
   transport in TS, stubbed `navigator.serial`/`navigator.usb` in e2e tests.

### Non-goals
- **Safari / iOS / iPadOS.** WebKit ships neither Web Serial nor WebUSB and opposes both
  (WebKit standards-positions #199, #68). No workaround is attempted.
- **Web Bluetooth.** It is GATT-only (https://bluetooth.spec.whatwg.org/); PT-series Bluetooth
  models are Bluetooth Classic SPP. (PT-N25BT is BLE and is out of scope.)
- **A native helper / bridge**, a server mode, accounts or cloud sync.
- **Pairing from the page.** Browsers only list devices the OS has already paired.
- **WebUSB on Windows by default.** Chrome only opens WinUSB-bound devices and Windows binds P-touch
  printers to `usbprint.sys`. We document the Zadig workaround but do not recommend it.
- **QL / TD / RJ printers, two-colour tapes, 360-dpi high-resolution mode** (later, if ever).
- **A full-Rust UI** (Leptos/Dioxus/egui): text must render with web/system fonts through Canvas2D.

---

## 2. Decisions at a glance

| Area | Decision |
|---|---|
| Protocol core | Rust **2024 edition**, `no_std + alloc`, sans-IO, crate `ptouch` |
| Browser binding | `wasm-bindgen =0.2.129`, built by **wasm-pack 0.15.0 `--target web`** (no Vite wasm plugin) |
| Front-end | **Vite 8.3.4 + Svelte 5.57.2 + TypeScript 6.0.3** (not TS 7: svelte-check 4.7.6 peers TS ^5 \|\| ^6) |
| Rendering | Custom **Canvas2D** renderer (no Fabric/Konva in MVP); threshold/dither/barcodes/packing in wasm |
| Primary transport | **Web Serial**: Chromium direct-RFCOMM (SPP filter) → OS serial port fallback |
| Secondary transport | **WebUSB** (VID 0x04F9, printer class 0x07) on macOS, Linux, ChromeOS, Android |
| Persistence | IndexedDB via `idb-keyval 6.3.0`, versioned JSON `LabelDoc`, file export, share links |
| Offline | `vite-plugin-pwa 2.0.0` (`generateSW`, wasm + woff2 precached) |
| Native | `ptouch-transport` (serialport 4.10.1, nusb 0.2.7; IOBluetooth RFCOMM later) + `ptouch-cli` |
| Hosting | GitHub Pages via Actions (`configure-pages` `base_path` → Vite `base`) |
| Tests | cargo tests with real status fixture + golden byte streams, wasm-bindgen-test, Vitest with mock serial port, Playwright e2e with stubbed `navigator.serial` |

---

## 3. Browser support matrix

### 3.1 What works where (as of 2026-10-08)

| Platform / browser | PT over Bluetooth (Web Serial) | PT over USB (WebUSB) |
|---|---|---|
| **macOS + Chrome/Edge ≥117** | ✅ in code: direct RFCOMM ("PT-P710BTxxxx"), persistent grant; ⚠️ end-to-end **UNCERTAIN** (see 3.2). Fallback: OS port "cu.PT-P710BTxxxx", session-only grant | ✅ (proven by prior art on macOS 26 with this model) |
| macOS + Firefox ≥151 | ✅ OS port `/dev/cu.*` only (no direct RFCOMM in Gecko) | ❌ no WebUSB |
| macOS + Safari | ❌ | ❌ |
| **Windows + Chrome/Edge ≥117** | ✅ direct RFCOMM (recommended); fallback outgoing "Standard Serial over Bluetooth link (COMn)" | ❌ by default (`usbprint.sys`); ✅ only after WinUSB swap via Zadig (breaks Windows printing) |
| Windows + Firefox ≥151 | ✅ COM port | ❌ |
| **Linux + Chrome ≥117** | ✅ direct RFCOMM via BlueZ; fallback `/dev/rfcommN` (`rfcomm bind`, `dialout` group) | ✅ Chromium auto-detaches `usblp`; needs a udev `uaccess` rule |
| Linux + Firefox ≥151 | ✅ `/dev/rfcommN` only | ❌ |
| ChromeOS | ✅ direct RFCOMM | probably ✅ (**UNCERTAIN**) |
| **Android Chrome ≥138** | ✅ direct RFCOMM only (pair in Android settings first). `SerialPort.connected` and connect/disconnect events are **not** exposed on Android | ✅ (OTG) |
| Android WebView, Firefox Android | ❌ | ❌ |
| iOS / iPadOS (any browser) | ❌ | ❌ |
| Brave | Chromium, but Web Serial is disabled by default (mechanism **UNCERTAIN**); canvas readback may be randomized (see §6.5) | same |

Version facts (MDN BCD 8.1.5 + chromestatus + release notes):
- Chrome/Edge desktop: Web Serial 89; Bluetooth service-class filter/`getInfo().bluetoothServiceClassId`
  117; `SerialPort.connected` + RFCOMM connect/disconnect events 130; `forget()` 103.
- Chrome Android: Web Serial **RFCOMM-only from 138** (Finch-gated rollout); wired USB-serial from 148
  (needs Android SDK 37; irrelevant here).
- Firefox desktop: Web Serial **151** (2026-05-19), behind a one-time add-on-style site permission.
  **Disabled by default under Firefox Enterprise Policies** (`DefaultSerialGuardSetting`).
  Firefox **≥156** (2026-09-15) tags OS-mapped Bluetooth ports with the SPP service class; 151–155
  accept the filter in IDL but match nothing (empty chooser), and this cannot be feature-detected.
- WebUSB: Chrome 61 (desktop and Android). Not in Firefox or Safari.
- Spec homes: Web Serial is a WHATWG Living Standard (https://serial.spec.whatwg.org/); Permissions-Policy
  feature `serial` (and `usb`) default allowlist `'self'`. GitHub Pages sends no restricting header.

Requirements on every path: secure context (Pages is HTTPS; `http://localhost` in dev), a **user
gesture** for `requestPort()`/`requestDevice()` (call it synchronously in the click handler), non-opaque
top-level origin, and an `<iframe allow="serial; usb">` if ever embedded.

### 3.2 The macOS + PT-P710BT path, spelled out

Ground truth on the user's Mac (macOS 26): the paired printer exposes `/dev/cu.PT-P710BTxxxx`; a raw
open (CS8, no flow control) + `00×100 1B 40 1B 69 53` returned a valid 32-byte status within ~1 s.
Conflicting evidence: a native `serialport` probe on macOS 27.0.1 opened the same node but produced
no RFCOMM connection, while IOBluetooth RFCOMM channel 1 worked seconds later; Ircama#3 reports the
`/dev/cu` SPP node working **once** and hanging on later opens; obwat (macOS 26, Chrome 150/151) saw
Chrome's direct-RFCOMM entry fail `open()` with "Failed to open serial port". Hence the ladder:

1. **Pair** the printer in System Settings › Bluetooth (this also creates `/dev/cu.PT-P710BTxxxx`).
2. **"Connect via Bluetooth"** (default button) calls
   ```ts
   navigator.serial.requestPort({
     filters: [{ bluetoothServiceClassId: SPP_UUID }],     // "00001101-0000-1000-8000-00805f9b34fb"
     allowedBluetoothServiceClassIds: [SPP_UUID],          // NOT optional in practice, see below
   })
   ```
   - Passing `allowedBluetoothServiceClassIds` together with an all-Bluetooth filter list makes Chrome
     check that the adapter is present, **permitted and powered** and show a "grant Bluetooth
     permission / turn on Bluetooth" state instead of an empty list.
   - The first call triggers macOS's Bluetooth privacy (TCC) prompt for Chrome. `getPorts()` never
     triggers it (it skips the Bluetooth enumerator while permission is undetermined), so the first
     connection must go through `requestPort()`.
   - The user picks **"PT-P710BTxxxx"** (no `cu.` prefix). That is Chrome's own RFCOMM socket:
     SDP lookup of 0x1101 → RFCOMM channel (channel 1 on this printer), with a 10 s SDP timeout.
   - The grant is **persistent**: `getPorts()` returns it after a browser restart.
   - This filter **hides** the OS port: Chrome does not tag `/dev/cu.*`, COM or `/dev/rfcomm*` ports
     with a service class ID (the Chrome blog's claim to the contrary is not implemented).
   - **UNCERTAIN end-to-end** (Phase 0 test H1). Failure modes in Chromium's mac socket code: SDP
     failure/timeout, SPP not in the live SDP record, RFCOMM open failure if bluetoothd or another
     app still holds the printer's single SPP channel.
3. **Fallback A — "Choose serial port…"** calls `requestPort()` with **no filters**. The user picks
   **"cu.PT-P710BTxxxx"** (ignore `cu.Bluetooth-Incoming-Port`, `cu.debug-console`).
   - Open with `baudRate: 9600` (ignored by the Bluetooth driver; ≤38400 keeps Chrome on the
     `cfsetspeed` path instead of `IOSSIOSPEED`, which a BT pseudo-serial driver may reject).
   - The grant is **session-only** (no display name → not persisted); after a Chrome restart the user
     must pick it again. It is also revoked if the port disappears.
   - Chrome puts the tty in exclusive mode (`TIOCEXCL`). If `screen`, Python or our CLI holds the
     port, Chrome's `open()` fails with `NetworkError: Failed to open serial port.` — close other tools.
   - Because of the "works once" risk, the app **opens once and keeps the port open** for the whole
     session (§5.6), and if a status reply never arrives on an open port it tells the user to
     power-cycle the printer.
4. **Fallback B — "Connect via USB"**: cable + WebUSB (`requestDevice({filters:[{vendorId:0x04f9}]})`,
   interface 0 class 0x07, bulk OUT 0x02 / IN 0x81). Proven on macOS 26 with a PT-P710BT by obwat.
   Fails only if CUPS or P-touch Editor holds the device at that moment.
5. Firefox ≥151 on macOS: only step 3 (always unfiltered, see 3.3).

The error string "Failed to open serial port." is identical for both serial paths, so the UI records
*which* entry was opened (`getInfo().bluetoothServiceClassId` present ⇒ direct RFCOMM on Chromium).

### 3.3 Connect-flow logic (all browsers)

```
hasSerial = 'serial' in navigator && typeof navigator.serial.requestPort === 'function'
hasUsb    = 'usb' in navigator
isGecko   = navigator.userAgent includes 'Firefox/'

on load:      ports = await navigator.serial.getPorts()  → reopen remembered port (no prompt)
              devices = await navigator.usb.getDevices() → reopen remembered device
"Bluetooth":  if isGecko → requestPort()                 // unfiltered; 151–155 would show nothing
              else       → requestPort({SPP filter + allowed}); on NotFoundError offer "Choose serial port…"
                                                         // on TypeError (pre-117 Chromium) retry unfiltered
"Serial port":requestPort()                              // shows OS ports + RFCOMM entries
"USB":        navigator.usb.requestDevice({filters:[{vendorId:0x04f9}]})
neither API:  banner "Use Chrome or Edge on desktop or Android, or Firefox 151+ (Bluetooth via OS
              serial ports)"; the editor and file export still work.
```
`NotFoundError` from a cancelled picker is not an error. Remembered choice (`kind`, `info`) is stored
in prefs; a deliberate "Disconnect" clears auto-reconnect.

---

## 4. Repository layout and public APIs

```
ptouch/
├── Cargo.toml                    # [workspace] resolver = "3"; edition 2024; shared deps; release profile
├── rust-toolchain.toml           # channel = "1.97.1"; targets wasm32-unknown-unknown, thumbv7em-none-eabihf
├── crates/
│   ├── ptouch/                   # protocol core: no_std + alloc, sans-IO (the published library)
│   │   ├── src/{lib,error,model,media,status,raster,dither,packbits,encode,session,virtual_printer}.rs
│   │   ├── src/codes/            # feature "codes": QR / Code128 / EAN-13 → ModuleMatrix
│   │   └── tests/                # fixtures/, golden/, *.rs
│   ├── ptouch-wasm/              # wasm-bindgen + tsify bindings ONLY (cdylib + rlib), no logic
│   ├── ptouch-transport/         # native byte pipes: serialport, nusb (USB), IOBluetooth (later)
│   └── ptouch-cli/               # `ptouch` binary: status, print, test labels, job decode
├── web/                          # Vite + Svelte + TS studio
│   ├── src/
│   │   ├── wasm/                 # index.ts (lazy init); pkg/ = wasm-pack output (gitignored)
│   │   ├── printer/              # transport.ts, webserial.ts, webusb.ts, mock.ts, client.ts, support.ts
│   │   ├── doc/                  # schema.ts (LabelDoc), migrate.ts, history.ts (undo), layout.ts
│   │   ├── render/               # renderer.ts (Canvas2D), fonts.ts, antifp.ts, preview.ts
│   │   ├── store/                # db.ts (idb-keyval), prefs.ts, share.ts, files.ts
│   │   └── ui/                   # Svelte components
│   ├── public/fonts/             # bundled OFL woff2 + SOURCES.md
│   ├── tests/                    # Vitest (node + browser projects)
│   └── e2e/                      # Playwright
├── docs/                         # ARCHITECTURE.md, PROTOCOL.md, HARDWARE-TESTS.md
└── .github/workflows/pages.yml
```

Layering rule (enforced by crate deps and an ESLint `no-restricted-imports` rule in `web/`):
`ptouch` ← `ptouch-wasm` ← `web/src/wasm` ← `printer`, `render` ← `ui`; `doc` depends on nothing.
`printer` never imports `render`; `render` never touches transports.

### 4.1 `crates/ptouch` — the sans-IO core

`#![no_std]` + `extern crate alloc`. No I/O, no clocks, no threads, no `HashMap` (static tables and
`BTreeMap`). Time is passed in as `now_ms: u64`. Errors implement `core::error::Error`.
Features: `std` (convenience impls), `serde` (derive on public data types), `codes` (barcode/QR
encoders; may pull `std` — the no_std CI check builds without it), `virtual` (virtual printer;
on by default for tests).

```rust
// ---------- error.rs ----------
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Error {
    StatusLength { got: usize },
    StatusHeader { got: [u8; 4] },              // expected 80 20 42 xx
    UnknownModel { series: u8, model: u8 },
    UnsupportedMedia { width_mm: u8, media_type: u8 },
    BitmapSize { expected_height: u16, got_height: u16 },
    TooShort { dots: u32, min: u32 },
    TooLong { dots: u32, max: u32 },
    Empty,
    MediaMismatch { loaded_mm: u8, job_mm: u8 },
    Printer(PrinterErrors),                     // error status from the device
    Busy,                                       // operation not allowed in the current session state
    Timeout(TimeoutKind),
    Protocol(&'static str),                     // unexpected frame sequence
}
impl Error { pub fn code(&self) -> &'static str; }   // stable SCREAMING_SNAKE codes, mirrored in TS

// ---------- model.rs ----------
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Model { PtP710bt /* MVP */, PtP750w, PtE550w, PtP700, PtP300bt, PtE560bt, PtP910bt /* later */ }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Classic,     // P710BT/P750W/E550W/P700: ESC i z 0x84, PackBits, 0C/1A pages
    D460,        // D460BT/D610BT/E310BT/E560BT: n9=2, M 00 uncompressed, 1A every page (later)
    Cube,        // P300BT: 64 printable pins on 12 mm (later)
    Wide560,     // P900/P910BT: 70-byte lines, asymmetric margins (later)
}

pub struct ModelProfile {
    pub model: Model,
    pub name: &'static str,                 // "PT-P710BT"
    pub series_code: u8,                    // status[3], 0x30
    pub model_code: u8,                     // status[4], 0x76 for PT-P710BT
    pub usb_pid: Option<u16>,               // 0x20AF
    pub dialect: Dialect,
    pub head_pins: u16,                     // 128
    pub dpi: u16,                           // 180 (head and feed)
    pub invalidate_len: u16,                // 100 (128-pin family); 200 is harmless for all
    pub caps: Caps,                         // auto_status_cmd, cut_every_n, half_cut, chain, mirror
    pub min_feed_margin_dots: u16,          // 14 (2 mm)
    pub min_length_dots: u32,               // 31
    pub max_length_dots: u32,               // 7086 (1 m)
    pub media: &'static [TapeSpec],
}
pub fn profiles() -> &'static [ModelProfile];
pub fn profile_by_codes(series: u8, model: u8) -> Option<&'static ModelProfile>;
pub fn profile_by_usb_pid(pid: u16) -> Option<&'static ModelProfile>;

// ---------- media.rs ----------
pub struct TapeSpec {
    pub width_mm: u8,          // status[10] value
    pub kind: TapeKind,        // Laminated | NonLaminated | HeatShrink21 | ...
    pub left_margin_pins: u16, // PT-P710BT: 3.5→52, 6→48, 9→39, 12→29, 18→8, 24→0
    pub print_pins: u16,       //            3.5→24, 6→32, 9→50, 12→70, 18→112, 24→128
    pub right_margin_pins: u16,
}
pub enum MediaType { None, Laminated, NonLaminated, HeatShrink21, HeatShrink31, Incompatible, Other(u8) }
pub enum TapeColor { White, Clear, Red, Blue, Yellow, Green, Black, /* … full table */ Other(u8) }
pub enum TextColor { White, Red, Blue, Black, Gold, /* … */ Other(u8) }
impl TapeColor { pub fn css(&self) -> &'static str; }   // preview tint
pub fn tape_spec(profile: &ModelProfile, width_mm: u8, kind: TapeKind) -> Option<&'static TapeSpec>;

// ---------- status.rs ----------
pub const STATUS_LEN: usize = 32;
pub struct Status {
    pub series_code: u8, pub model_code: u8,
    pub battery: u8, pub ext_error: u8,           // bytes 6/7 (generic decode; reserved on D1 models)
    pub errors: PrinterErrors,                    // bytes 8–9, all set bits decoded
    pub media_width_mm: u8, pub media_type: MediaType, pub media_length_mm: u8,
    pub mode: u8,
    pub status_type: StatusType,                  // Reply | PrintingCompleted | Error | TurnedOff | Notification | PhaseChange | Other(u8)
    pub phase: Phase,                             // Editing(u16) | Printing(u16)
    pub notification: Notification,               // None | CoverOpen | CoverClosed | CoolingStarted | CoolingFinished | Other(u8)
    pub tape_color: TapeColor, pub text_color: TextColor,
    pub raw: [u8; STATUS_LEN],
}
pub struct PrinterErrors(pub u16);                // byte8 | byte9 << 8
impl PrinterErrors { pub fn is_empty(&self) -> bool; pub fn iter(&self) -> impl Iterator<Item = PrinterError>; }
pub fn parse_status(bytes: &[u8]) -> Result<Status, Error>;

/// Reassembles 32-byte frames from an arbitrary chunked byte stream, resyncing on `80 20 42`.
pub struct StatusFramer { /* … */ }
impl StatusFramer {
    pub fn new() -> Self;
    pub fn push(&mut self, bytes: &[u8]);
    pub fn next_frame(&mut self) -> Option<Result<Status, Error>>;
    pub fn discarded_bytes(&self) -> usize;
}

// ---------- raster.rs / dither.rs ----------
/// 1-bpp label image in PRINT order: `length` raster lines (feed direction), each `height` dots
/// (= TapeSpec::print_pins). Line-major; each line is ceil(height/8) bytes, MSB-first; bit y = dot y
/// across the tape (y = 0 is canvas row 0). Line x = canvas column x.
pub struct Bitmap { /* length: u32, height: u16, data: Vec<u8> */ }
impl Bitmap {
    pub fn new(length: u32, height: u16) -> Self;
    pub fn from_packed(length: u32, height: u16, data: Vec<u8>) -> Result<Self, Error>;
    pub fn length(&self) -> u32;  pub fn height(&self) -> u16;
    pub fn get(&self, x: u32, y: u16) -> bool;  pub fn set(&mut self, x: u32, y: u16, on: bool);
    pub fn line(&self, x: u32) -> &[u8];
    pub fn as_packed(&self) -> &[u8];
    pub fn trim_blank(&self) -> (u32, u32);    // first/last non-blank line, for auto length
}
pub enum Dither { Threshold { level: u8 }, FloydSteinberg, Atkinson, Bayer4, Bayer8 }
pub struct ToneAdjust { pub brightness: i8, pub contrast: i8, pub gamma_x100: u16, pub invert: bool }

/// Composes the final bitmap from the three render planes (see §5.2).
pub struct LabelRaster { /* bitmap + "protected" mask */ }
impl LabelRaster {
    pub fn new(length: u32, height: u16) -> Self;
    /// RGBA at `factor`× resolution (canvas row-major), box-filtered to coverage, thresholded.
    pub fn blit_crisp(&mut self, rgba: &[u8], w: u32, h: u32, factor: u8, threshold: u8) -> Result<(), Error>;
    /// RGBA at 1× for one image element at (x, y); dithered, written where alpha > 0.
    pub fn blit_tone(&mut self, rgba: &[u8], w: u32, h: u32, x: i32, y: i32, dither: Dither, adj: ToneAdjust) -> Result<(), Error>;
    /// Integer-dot barcode/QR modules at (x, y); marks the area protected (never dithered over).
    pub fn blit_code(&mut self, m: &ModuleMatrix, x: i32, y: i32, module_dots: u8, quiet_zone: bool) -> Result<(), Error>;
    pub fn finish(self) -> Bitmap;
}

// ---------- codes/ (feature "codes") ----------
pub struct ModuleMatrix { pub width: u32, pub height: u32, pub modules: Vec<u8> /* 0/1 row-major */ }
pub enum CodeSpec<'a> { Qr { data: &'a str, ecc: QrEcc }, Code128 { data: &'a str }, Ean13 { digits: &'a str } }
pub fn encode_code(spec: &CodeSpec) -> Result<ModuleMatrix, Error>;

// ---------- packbits.rs ----------
pub fn packbits_encode(line: &[u8], out: &mut Vec<u8>);          // Brother TIFF variant; literal fallback if > raw
pub fn packbits_decode(data: &[u8], expected: usize) -> Result<Vec<u8>, Error>;

// ---------- encode.rs ----------
pub struct JobOptions {
    pub auto_cut: bool,          // ESC i M bit 6 (default true)
    pub mirror: bool,            // ESC i M bit 7 (default false)
    pub chain: bool,             // ESC i K bit 3 cleared ⇒ last label stays in the printer (default false)
    pub feed_margin_dots: u16,   // ESC i d (default 14 = 2 mm, clamped to ≥ profile minimum)
    pub compression: Compression,// PackBits (default) | None
    pub auto_status: bool,       // ESC i ! 00 (default true; needed for completion pushes over BT)
}
/// A job split at page boundaries so the session can pace it page by page.
pub struct EncodedJob { pub preamble: Vec<u8>, pub pages: Vec<Vec<u8>>, pub total_lines: u32 }
impl EncodedJob { pub fn to_bytes(&self) -> Vec<u8>; }
pub fn encode_job(profile: &ModelProfile, tape: &TapeSpec, pages: &[&Bitmap], opts: &JobOptions)
    -> Result<EncodedJob, Error>;
pub fn reset_sequence(profile: &ModelProfile) -> Vec<u8>;        // 00×N 1B 40
pub const STATUS_REQUEST: [u8; 3] = [0x1B, 0x69, 0x53];

// ---------- session.rs ----------
pub struct SessionConfig {
    pub status_timeout_ms: u64,       // 3000
    pub status_attempts: u8,          // 3 (BT links are "half-awake" at first)
    pub page_timeout_base_ms: u64,    // 30_000
    pub page_timeout_per_line_ms: u64,// 20 (UNCERTAIN, calibrate on hardware)
    pub post_job_drain_ms: u64,       // 500 (swallow extra status frames)
}
pub enum SessionState { Idle, Handshaking, Ready, Printing { page: u16, of: u16 }, Failed }
pub enum Event {
    Status(Status),                         // every parsed frame
    Ready(Status),                          // handshake done, media known
    PageStarted { page: u16 },              // phase change → printing
    PageCompleted { page: u16 },            // printing completed / phase → receiving
    JobCompleted,
    Notification(Notification),
    Failed(Error),
}
/// Sans-IO state machine (quinn/str0m style). The caller moves bytes and time; the session decides.
pub struct Session { /* … */ }
impl Session {
    pub fn new(profile: Option<&'static ModelProfile>, cfg: SessionConfig) -> Self; // None ⇒ detect from status
    pub fn connect(&mut self, now_ms: u64);                       // queues reset + ESC i S
    pub fn request_status(&mut self, now_ms: u64) -> Result<(), Error>; // Err(Busy) while printing
    pub fn submit(&mut self, job: EncodedJob, job_media_mm: u8, now_ms: u64) -> Result<(), Error>; // preflight vs last status
    pub fn cancel(&mut self, now_ms: u64);                        // queues 00×N 1B 40
    pub fn handle_input(&mut self, bytes: &[u8], now_ms: u64);
    pub fn handle_timeout(&mut self, now_ms: u64);
    pub fn poll_transmit(&mut self) -> Option<Vec<u8>>;           // next buffer to write, in order
    pub fn poll_event(&mut self) -> Option<Event>;
    pub fn poll_timeout(&self) -> Option<u64>;                    // absolute ms deadline
    pub fn state(&self) -> SessionState;
    pub fn last_status(&self) -> Option<&Status>;
}

// ---------- virtual_printer.rs (feature "virtual") ----------
/// Device-side model used by tests, the TS MockTransport and `ptouch decode`.
pub struct VirtualPrinter { /* … */ }
impl VirtualPrinter {
    pub fn new(profile: &'static ModelProfile, media_width_mm: u8, script: Behaviour) -> Self; // Behaviour: Normal | CoverOpenOnPage(n) | Silent | WrongMedia | ...
    pub fn handle_input(&mut self, bytes: &[u8], now_ms: u64);
    pub fn poll_output(&mut self, now_ms: u64) -> Option<[u8; STATUS_LEN]>;
    pub fn printed(&self) -> &[Bitmap];                                  // decoded pages
}
```

### 4.2 `crates/ptouch-wasm` — browser bindings

Bindings only. Errors are thrown as real JS `Error`s with `name = "PtouchError"` and a stable `code`
(from `Error::code()`), declared via `typescript_custom_section` together with `isPtouchError`.
Structured values cross the boundary with **tsify 0.5.8 `Ts<T>`** (never the deprecated
`into_wasm_abi`/`from_wasm_abi`, which leak on bad input, tsify#65). Byte buffers are `&[u8]` in and
`Vec<u8>` out (copied; a 1 m label is ~113 KB). Times are `f64` milliseconds from `performance.now()`.

```rust
#[wasm_bindgen(typescript_custom_section)]
const TS: &str = r#"
export type PtouchErrorCode = "STATUS_LENGTH" | "STATUS_HEADER" | "UNKNOWN_MODEL" | "UNSUPPORTED_MEDIA"
  | "BITMAP_SIZE" | "TOO_SHORT" | "TOO_LONG" | "EMPTY" | "MEDIA_MISMATCH" | "PRINTER" | "BUSY"
  | "TIMEOUT" | "PROTOCOL";
export interface PtouchError extends Error { name: "PtouchError"; code: PtouchErrorCode; }
export function isPtouchError(e: unknown): e is PtouchError;
"#;

#[wasm_bindgen] pub fn version() -> String;
#[wasm_bindgen(js_name = listModels)]  pub fn list_models() -> Ts<Vec<ModelInfo>>;
#[wasm_bindgen(js_name = printArea)]   pub fn print_area(model_code: u8, width_mm: u8) -> Result<Ts<PrintArea>, JsValue>;
#[wasm_bindgen(js_name = parseStatus)] pub fn parse_status(bytes: &[u8]) -> Result<Ts<PrinterStatus>, JsValue>;
#[wasm_bindgen(js_name = encodeCode)]  pub fn encode_code(spec: Ts<CodeSpecJs>) -> Result<Ts<ModuleMatrixJs>, JsValue>;

#[wasm_bindgen] pub struct Raster { inner: ptouch::LabelRaster }
#[wasm_bindgen] impl Raster {
    #[wasm_bindgen(constructor)] pub fn new(length: u32, height: u16) -> Raster;
    #[wasm_bindgen(js_name = blitCrisp)] pub fn blit_crisp(&mut self, rgba: &[u8], w: u32, h: u32, factor: u8, threshold: u8) -> Result<(), JsValue>;
    #[wasm_bindgen(js_name = blitTone)]  pub fn blit_tone(&mut self, rgba: &[u8], w: u32, h: u32, x: i32, y: i32, opts: Ts<ToneOptions>) -> Result<(), JsValue>;
    #[wasm_bindgen(js_name = blitCode)]  pub fn blit_code(&mut self, m: Ts<ModuleMatrixJs>, x: i32, y: i32, module_dots: u8) -> Result<(), JsValue>;
    /// Consumes the raster; returns a handle that can be previewed and encoded.
    pub fn finish(self) -> Bitmap1;
}
#[wasm_bindgen] pub struct Bitmap1 { inner: ptouch::Bitmap }
#[wasm_bindgen] impl Bitmap1 {
    #[wasm_bindgen(getter)] pub fn length(&self) -> u32;
    #[wasm_bindgen(getter)] pub fn height(&self) -> u16;
    /// Tinted RGBA in canvas orientation (width = length) for an ImageData preview.
    #[wasm_bindgen(js_name = toRgba)] pub fn to_rgba(&self, tape_rgb: u32, ink_rgb: u32) -> Vec<u8>;
    #[wasm_bindgen(js_name = toPacked)] pub fn to_packed(&self) -> Vec<u8>;
}
#[wasm_bindgen(js_name = encodeJob)]
pub fn encode_job(model_code: u8, width_mm: u8, pages: Vec<Bitmap1>, opts: Ts<JobOptionsJs>) -> Result<Job, JsValue>;
#[wasm_bindgen] pub struct Job { inner: ptouch::EncodedJob }
#[wasm_bindgen] impl Job {
    #[wasm_bindgen(js_name = toBytes)] pub fn to_bytes(&self) -> Vec<u8>;      // "Download .bin"
    #[wasm_bindgen(getter, js_name = pageCount)] pub fn page_count(&self) -> u16;
}

#[wasm_bindgen] pub struct PrintSession { inner: ptouch::Session }
#[wasm_bindgen] impl PrintSession {
    #[wasm_bindgen(constructor)] pub fn new(config: Option<Ts<SessionConfigJs>>) -> PrintSession;
    pub fn connect(&mut self, now_ms: f64);
    #[wasm_bindgen(js_name = requestStatus)] pub fn request_status(&mut self, now_ms: f64) -> Result<(), JsValue>;
    pub fn submit(&mut self, job: Job, job_width_mm: u8, now_ms: f64) -> Result<(), JsValue>;
    pub fn cancel(&mut self, now_ms: f64);
    #[wasm_bindgen(js_name = handleInput)]   pub fn handle_input(&mut self, bytes: &[u8], now_ms: f64);
    #[wasm_bindgen(js_name = handleTimeout)] pub fn handle_timeout(&mut self, now_ms: f64);
    #[wasm_bindgen(js_name = pollTransmit)]  pub fn poll_transmit(&mut self) -> Option<Vec<u8>>;
    #[wasm_bindgen(js_name = pollEvent)]     pub fn poll_event(&mut self) -> Option<Ts<SessionEventJs>>;
    #[wasm_bindgen(js_name = pollTimeout)]   pub fn poll_timeout(&self) -> Option<f64>;
}

#[wasm_bindgen] pub struct VirtualPrinter { /* wraps ptouch::VirtualPrinter for MockTransport */ }
```

Size budget: the prototype with tsify + serde-wasm-bindgen is 70.4 KB (31.8 KB gzip); ≤ 150 KB gzip
total wasm is the ceiling. If it grows, drop serde on hot paths and move message formatting to TS.

### 4.3 `web/src/printer` — transport layer (TypeScript)

Transports are **dumb byte pipes**; all protocol decisions live in the wasm `PrintSession`. The
`PrinterClient` is the only thing that knows both.

```ts
// transport.ts
export type TransportKind = 'serial-rfcomm' | 'serial-os-port' | 'usb' | 'mock';

export interface TransportInfo {
  kind: TransportKind;
  label: string;                         // "PT-P710BTxxxx", "cu.PT-P710BTxxxx", "USB 04f9:20af"
  persistentGrant: boolean;              // false for macOS cu.* in Chrome
  usbProductId?: number;                 // model hint for WebUSB
  bluetoothServiceClassId?: string;
}

export type TransportEvent =
  | { type: 'data'; bytes: Uint8Array }
  | { type: 'lost'; error: unknown };    // read/write failure, port.readable === null, USB disconnect

export interface Transport {
  readonly info: TransportInfo;
  readonly isOpen: boolean;
  open(signal?: AbortSignal): Promise<void>;
  /** Resolves when the platform has ACCEPTED the bytes (backpressure), not when the printer got them. */
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  /** Single long-lived read pump; never a per-call read raced against a timer. */
  subscribe(listener: (e: TransportEvent) => void): () => void;
}

export interface WriteTuning {
  chunkSize: number;          // default 4096 (serial), 16384 (usb)
  interChunkDelayMs: number;  // default 0; "unreliable link" preset = 512 B / 10 ms
}
```

```ts
// webserial.ts
export const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';

/** Structural subset of SerialPort so tests can pass fakes (PortLike pattern). */
export interface PortLike {
  open(o: SerialOptions): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): SerialPortInfo;
  setSignals?(s: SerialOutputSignals): Promise<void>;
  readonly connected?: boolean;           // Chrome 130+ desktop, Firefox 151+; absent on Android
}

export type SerialMode = 'rfcomm' | 'os-port';

export interface WebSerialOptions {
  baudRate: 9600;                         // required by the API, ignored by BT; 9600 avoids IOSSIOSPEED
  bufferSize: number;                     // default 16384 (Chrome default is 255; max 16 MiB)
  assertSignals: boolean;                 // default true: setSignals({DTR,RTS}) in try/catch.
                                          // Harmless folklore from P300BT projects: Chrome already raises
                                          // DTR/RTS on open (Windows) and it is a no-op on direct RFCOMM.
  tuning: WriteTuning;
}

export class WebSerialTransport implements Transport {
  /** Chromium: SPP filter + allowedBluetoothServiceClassIds. Gecko: unfiltered. Needs a user gesture. */
  static requestBluetooth(): Promise<WebSerialTransport>;
  /** Unfiltered chooser: OS ports (cu.*, COMn, rfcommN) and RFCOMM entries. Needs a user gesture. */
  static requestAnyPort(): Promise<WebSerialTransport>;
  /** Re-open a previously granted port without a prompt (getPorts()). */
  static fromGranted(match?: Partial<TransportInfo>): Promise<WebSerialTransport | null>;
  constructor(port: PortLike, opts?: Partial<WebSerialOptions>);
  readonly mode: SerialMode;              // 'rfcomm' iff getInfo().bluetoothServiceClassId && !Gecko
  // + Transport members. write(): getWriter() → for each chunk { await w.ready; await w.write(c) }
  //   → releaseLock(). Abort ⇒ writer.abort() (discards queued data), then session.cancel().
  //   close(): reader.cancel() → releaseLock() → port.close().
  forget(): Promise<void>;                // revoke the grant (Chrome 103+, Firefox 151+)
}
```

```ts
// webusb.ts (optional transport; not offered on Windows unless the user opts in)
export interface UsbDeviceLike {
  open(): Promise<void>; close(): Promise<void>;
  selectConfiguration(n: number): Promise<void>; readonly configuration: USBConfiguration | null;
  claimInterface(n: number): Promise<void>; releaseInterface(n: number): Promise<void>;
  transferOut(ep: number, data: BufferSource): Promise<USBOutTransferResult>;
  transferIn(ep: number, len: number): Promise<USBInTransferResult>;
  readonly productId: number; readonly vendorId: number;
}
export class WebUsbTransport implements Transport {
  static request(): Promise<WebUsbTransport>;                    // filters: [{ vendorId: 0x04f9 }]
  static fromGranted(): Promise<WebUsbTransport | null>;         // getDevices(); empty ⇒ "printer asleep?"
  constructor(dev: UsbDeviceLike, opts?: Partial<WriteTuning>);
  // open: open → selectConfiguration(1) if null → claimInterface(0); endpoints from alternates[0]
  //       (expected OUT 2, IN 1). One transferIn(1, 64) loop feeds 'data'; it is only ever cancelled
  //       by close(), never abandoned (an orphaned transferIn eats the next frame).
  //       transferOut may block for the whole print (printer back-pressures USB): no write timeout,
  //       and a partially sent job is NEVER retried.
}
```

```ts
// mock.ts
export interface MockScenario {
  mediaWidthMm: number;                    // 24
  fragment?: number[];                     // split replies, e.g. [7, 25] like RFCOMM does
  latencyMs?: number;
  behaviour?: 'normal' | 'silent' | 'cover-open-on-page-2' | 'wrong-media' | 'disconnect-mid-job';
}
/** Backed by the wasm VirtualPrinter, so the mock speaks exactly the protocol the core encodes. */
export class MockTransport implements Transport {
  constructor(scenario: MockScenario);
  readonly written: Uint8Array[];          // for assertions
  printedPages(): Bitmap1[];               // decoded by the virtual printer → "virtual printer" PNGs
}
```

```ts
// client.ts — the only place bytes meet the session
export type PrinterEvent =
  | { type: 'state'; state: 'disconnected' | 'connecting' | 'ready' | 'printing' | 'asleep?' | 'error' }
  | { type: 'status'; status: PrinterStatus }
  | { type: 'progress'; page: number; of: number; phase: 'sending' | 'printing' | 'done' }
  | { type: 'error'; error: PtouchError | Error; hint: string };

export class PrinterClient {
  constructor(transport: Transport, opts?: { log?: (dir: '>>' | '<<', bytes: Uint8Array) => void });
  connect(): Promise<PrinterStatus>;        // open + session.connect + await Ready
  refreshStatus(): Promise<PrinterStatus>;  // rejected with BUSY while printing
  print(job: Job, widthMm: number, signal?: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
  on(listener: (e: PrinterEvent) => void): () => void;
}
// Pump: transport 'data' → session.handleInput(bytes, now); drain pollTransmit() → transport.write
// (sequential, awaited); drain pollEvent() → listeners; one setTimeout armed at pollTimeout().
```

### 4.4 `crates/ptouch-transport` and `crates/ptouch-cli` (native)

```rust
pub trait Transport {
    fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()>;
    fn read(&mut self, buf: &mut [u8], timeout: std::time::Duration) -> std::io::Result<usize>; // Ok(0) on timeout
    fn describe(&self) -> String;
}
pub struct SerialTransport;     // serialport 4.10.1: /dev/cu.*, COMn, /dev/rfcommN — 9600 8N1, no flow control
pub struct UsbTransport;        // feature "usb": nusb 0.2.7, iface 0, EP 0x02 OUT / 0x81 IN
pub struct MacRfcommTransport;  // feature "macos-rfcomm" (v1): objc2-io-bluetooth 0.3.2, CFRunLoop on the
                                // main thread, writes chunked to the channel MTU (320 on PT-P710BT),
                                // closeConnection() on drop; needs an .app bundle for Bluetooth TCC
```
The CLI drives the same `ptouch::Session` with a blocking loop. Commands:
`ptouch status --port <path>` · `ptouch print --port <path> --text "…" [--font f.ttf] [--copies N]
[--tape 24] [--dry-run --out job.bin]` · `ptouch test-label orientation|ruler --port <path>` ·
`ptouch decode job.bin --out pages.pbm` (virtual printer; no image-crate dependency).
CLI text rendering uses `fontdue 0.9.4` (test labels only; the studio renders text in the browser).

---

## 5. Data flow

```
 LabelDoc (JSON, mm)            Canvas2D (OffscreenCanvas)                 wasm (ptouch core)
 ─────────────────── layout ──► crisp plane @3× RGBA ───── blitCrisp ───►┐
   items, tape, length          tone plane per image @1× ─ blitTone ────►├─ LabelRaster ─ finish ─► Bitmap1
   (flow / free layout)         code items ── encodeCode ─ blitCode ────►┘         │
                                                                                   ├─ toRgba(tape, ink) ─► preview <canvas>
                                                                                   └─ encodeJob(model, width, pages, opts)
                                                                                                    │
 PrinterClient ◄─ events ── PrintSession ◄──── submit(Job) ──────────────────────────────────────────┘
      │  pollTransmit() buffers (preamble, page 1, page 2 …)
      ▼
 Transport.write  ── chunk 4 KiB ── await writer.ready ── await writer.write ──► Web Serial / WebUSB
 Transport 'data' ── single read pump ── session.handleInput ── StatusFramer ── Event(PageStarted/Completed…)
```

### 5.1 Geometry and orientation
- **Tape width runs along the print-head pins; label length runs along the feed direction.** One raster
  line = one column of the label.
- The renderer works in **canvas coordinates where x = length (dots) and y = across the tape**. Canvas
  height = `TapeSpec::print_pins` for the loaded tape (PT-P710BT: 24/32/50/70/112/128 for
  3.5/6/9/12/18/24 mm); canvas width = label length in dots (180 dpi = 7.087 dots/mm).
- `Bitmap` is stored line-major (line x = canvas column x); the encoder writes line bits into a
  16-byte head line starting at pin `left_margin_pins` (linear bit index from the MSB of byte 0 =
  margin + y). Two independent prior implementations agree on that mapping for 128-pin heads; Brother
  D1 places the first byte at the "right margin" end, which is symmetric for 128-pin tables.
  **UNCERTAIN** which physical edge and feed end correspond to canvas top/left, and whether the result
  is mirrored: the mapping is one `PinMap` per profile and is fixed by the **orientation test label**
  (arrow + "START" + asymmetric glyphs) in Phase 0. The UI never thinks in rotated space.
- Length: auto = content extent + margins, or fixed mm. The encoder enforces 31 ≤ lines ≤ 7086.
  The printer feeds at least ~24.5 mm regardless (cutter position) and adds the `ESC i d` feed margin
  (default 14 dots = 2 mm) at both ends; the editor shows both.

### 5.2 Rendering → 1-bit
- One renderer, two outputs: the same `Bitmap1` feeds the preview and the job (never resample after
  thresholding/dithering).
- **Crisp plane** (text, shapes, icons): drawn at **3×** (odd factor keeps centred stems centred),
  RGBA handed to `blitCrisp`, box-filtered to coverage in wasm and thresholded at 50 % (a "boldness"
  slider moves the threshold).
- **Tone plane** (photos): each image element drawn at 1× and dithered individually in wasm
  (threshold default for line art; Floyd–Steinberg, Atkinson, Bayer 4/8 + brightness/contrast/gamma/invert).
- **Code plane** (QR, Code128, EAN-13): module matrix from wasm, painted in wasm at an integer
  `module_dots` with quiet zones, never via canvas, never dithered; preflight blocks modules < 1 dot.
- Compositing order in MVP: tone → crisp → codes (codes always on top). Free z-order arrives with the
  v1 free-form editor.
- Fonts: `await document.fonts.load(\`${px}px "${family}"\`, text)` then assert `document.fonts.check`
  for every family/size used before drawing; report fallbacks in the print panel.

### 5.3 Encoding (PT-P710BT, Classic dialect)
Template, per Brother's PT-P710BT driver dump (D1 §2.2), with notifications enabled for Bluetooth:
```
00 ×100                         invalidate
1B 40                           initialize
per page:
  1B 69 61 01                   raster mode
  1B 69 21 00                   auto status notification ON (driver sends 01; BT host needs pushes) — UNCERTAIN
  1B 69 7A 84 00 <w> 00 <lines u32 LE> <n9: 0 first | 1 other> 00
  1B 69 4D <0x40 auto-cut | 0x80 mirror>
  1B 69 4B <0x08 no-chain | 0x00 chain>       (no ESC i A: unsupported on P710BT; no half cut)
  1B 69 64 0E 00                feed margin 14 dots
  4D 02                         PackBits
  { 5A | 47 <len u16 LE> <PackBits of the full 16-byte line> } × lines
  0C (more pages) | 1A (last page)
```
Copies = pages of one job (leader fed once; auto-cut between labels). The exact byte stream is
specified and versioned in `docs/PROTOCOL.md` and frozen by golden tests (§8.2).

### 5.4 Chunked write with backpressure
- The session releases **one page at a time**: preamble + page 1, then page *n+1* only after page *n*
  reports "printing completed" / phase → receiving (Brother's buffered USB/Bluetooth flow). This bounds
  printer-side buffering and makes progress truthful.
- `Transport.write` splits each buffer into `chunkSize` slices and for each does
  `await writer.ready; await writer.write(slice)`. Chrome's serial writable uses
  `CountQueuingStrategy(highWaterMark = 1)`, so `ready` means "previous chunk accepted" and `write()`
  resolves when bytes are copied into the `bufferSize` data pipe — **not** when the printer received
  them. Progress therefore comes from status frames, never from write completion.
- Cancel: `writer.abort()` (discards queued bytes) → `session.cancel()` (invalidate + `ESC @`).
- WebUSB: one `transferOut` per chunk; it may block for the duration of the print.
- Native: the macOS RFCOMM backend chunks to the channel MTU; serial/Winsock/BlueZ stream.

### 5.5 Status handshake and print state machine
```
connect:   [drain input] → 00×100 1B 40 → 1B 69 53 → wait 32 B (3 s) ×3 attempts
           validate 80 20 42 30, model 0x76 → profile → Ready(status)       none ⇒ "printer asleep / power-cycle"
preflight: errors empty; media_type ∉ {None, Incompatible}; media_width_mm == doc tape
           (mismatch ⇒ block with "switch design to loaded 12 mm tape")
print:     page n → expect  06/phase printing (PageStarted)
                           01 printing completed (PageCompleted)
                           06/phase receiving → next page or JobCompleted
           02 error ⇒ Failed(Printer(errors)); printer discards data; recovery = 00×N 1B 40 + new status
           05 notifications (cover open/closed, cooling) at any time
           page timeout = base + per-line estimate ⇒ Failed(Timeout)
after:     drain extra frames for 500 ms (P300BT-class printers send several), then Ready
idle:      keepalive ESC i S every 60 s while the tab is visible (effect on auto-off UNCERTAIN)
never:     no command (not even ESC i S) is sent while a page is printing (Brother docs)
```
Fallback if Phase 0 shows the P710BT does not push completion over Bluetooth: the session waits the
estimated print time, then polls `ESC i S` until phase = receiving (the E560BT pattern).

### 5.6 Connection lifecycle
- Open once per session and **keep the port open** between prints (macOS "works once" risk).
- Treat a rejected read/write, `port.readable === null`, a `disconnect` event or an empty
  `usb.getDevices()` as "link lost / printer asleep" — the PT-P710BT powers off after ~10 min idle.
  Offer **Reconnect** (re-`open()` the granted port; no new prompt while the grant exists).
- Show `port.connected` only where it exists (Chrome 130+ desktop; Firefox 151+); never on Android.
- Chrome auto-closes an opened wireless port when the device goes out of range (130+).
- Debug aids: hex packet log panel (`>>`/`<<`), `chrome://device-log`, `chrome://bluetooth-internals`.

---

## 6. Label editor

### 6.1 Document model (`web/src/doc/schema.ts`)
Editor-library-independent JSON, geometry in **mm** (device-independent; snapped to the dot grid at
render time so a 360-dpi model can reuse documents).
```ts
interface LabelDoc {
  schema: 1; id: string; name: string; createdAt: string; updatedAt: string;
  tape: { widthMm: 3.5 | 6 | 9 | 12 | 18 | 24; colorHint?: string };
  length: { mode: 'auto' } | { mode: 'fixed'; mm: number };
  marginsMm: { start: number; end: number };            // ≥ 2 mm effective (feed margin)
  layout: { mode: 'flow'; gapMm: number; align: 'start' | 'center' } | { mode: 'free' };
  items: Item[];                                        // order = flow order / z-order
  print: { copies: number; autoCut: boolean; chain: boolean; mirror: boolean; threshold: number };
}
type Item = TextItem | IconItem | CodeItem | ImageItem | ShapeItem | SpacerItem;
// every item: { id, kind, frame?: { xMm, yMm, wMm, hMm, rotation: 0 | 90 | 180 | 270 } }
// TextItem: { text, fontFamily, fontWeight, sizeMm | 'fit', align, lineHeight, invert }
// CodeItem: { symbology: 'qr' | 'code128' | 'ean13', data, moduleDots, quietZone }
// ImageItem: { blobRef, dither, adjust }  (blob in IndexedDB; inlined as data URL on export)
```

### 6.2 MVP ("print a nice label from GitHub Pages")
- **Connect panel** (§3.3): Bluetooth / Serial port / USB / No printer (virtual). Status chip with
  model, tape width/type, tape + ink colour, battery where reported, error text and "asleep?" hint.
- **Media**: tape width auto-selected from status; manual when offline; printable band and tape edges
  drawn; mismatch preflight with one-click switch.
- **Content (flow layout, blocks left → right)**: text (multiline, bundled fonts, weight, size or
  **auto-fit to band**, alignment, line spacing, invert), icon (bundled SVG set), QR, Code128, EAN-13,
  image (dither choice, invert), spacer, optional frame.
- **Length** auto or fixed; start/end margins.
- **Preview**: the exact `Bitmap1`, tape-tinted, real-size and zoom, length readout in mm.
- **Print**: copies (one job, leader once), auto-cut, chain toggle, progress by page/phase, cancel,
  clear error messages (no tape, wrong tape, cover open, cutter jam, overheating, weak battery).
- **Persist**: autosave, label list, JSON import/export, share link (§7).
- **Diagnostics** (Advanced): virtual printer (download job `.bin` + PNG of decoded pages), hex packet
  log, orientation test label, ruler/margin test label, "copy diagnostics" (UA, transport kind, last
  status hex) for bug reports.
- **Fonts**: 4 bundled OFL families chosen for 180 dpi (Fira Sans, Archivo Narrow, JetBrains Mono,
  Atkinson Hyperlegible), self-hosted woff2.

### 6.3 v1
- **Free-form editor** (`layout.mode = 'free'`): move/resize/rotate (90° steps), snapping and guides,
  multi-select, grouping, keyboard nudge, z-order. Custom SVG handle overlay; adopt Konva 10.7.1 only
  for the interaction layer if handles get complex.
- **Undo/redo** as a snapshot ring buffer of `structuredClone(doc)` (200 entries, drags coalesced).
- More symbologies (DataMatrix via `datamatrix 0.3.3`; PDF417/Aztec etc. via lazily `import()`ed
  bwip-js 4.11.4), symbol library (electrical, fasteners, arrows, hazard), shapes, per-element dither.
- **Variables and batch**: `{{column}}` from CSV/paste, date expressions, counters (start/step/pad),
  per-row preview grid, batch printed as one chained job.
- **Templates**: cable flag / wrap, Gridfinity bin label, asset tag with QR, fastener drawer, split label.
- Fonts: user upload (Blob in IndexedDB, `FontFace`), `queryLocalFonts()` where available (labelled
  "varies by machine"), pixel fonts at integer scale, crispness indicator.
- Interop: P-touch Editor `.lbx` import; PNG/PDF export.
- PWA install, file handlers for `.ptlabel.json`, more models (P750W, E550W, P700, then P300BT,
  E560BT/D-series dialect, P910BT 560-pin), i18n.

### 6.4 UX sketch
```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ ▣ ptouch studio  [Labels ▾] [New] [Open] [Share]        ● PT-P710BT · 24 mm white/black ▾ │
│                                                          Bluetooth · [Reconnect] [⏏]     │
├──────────────┬────────────────────────────────────────────────────────┬────────────────┤
│ INSERT       │  Tape 24 mm ▢ white / ■ black        Length [Auto ▾]   │ PROPERTIES     │
│ [T] Text     │  ┌──────────────────────────────────────────────────┐ │ Text           │
│ [◎] Icon     │  │░░ printable band 128 dots ░░░░░░░░░░░░░░░░░░░░░░░│ │ Font [Fira ▾]  │
│ [▦] QR       │  │ ⚡  M3 × 12   DIN 912        ▦▦                  │ │ Size [Fit ▾]   │
│ [|||] Code   │  │     stainless                ▦▦                  │ │ [B] [≡ ≡ ≡]    │
│ [▭] Frame    │  └──────────────────────────────────────────────────┘ │ Threshold ──●─ │
│ [🖼] Image    │   0    10    20    30    40 mm       ← 42.3 mm →      │ LABEL          │
│ [␣] Spacer   │   View: (•) Design  ( ) Exact dots   [−][100%][+]      │ Margins 2 / 2  │
├──────────────┴────────────────────────────────────────────────────────┴────────────────┤
│ Copies [3]  [✓] Cut each  [ ] Chain   ~24 mm leader once         [ 🖨 Print 3 labels ]    │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌ Connect your printer ──────────────────────────────────────────────┐
│ (•) Bluetooth  – pair it in system settings first; pick "PT-P710BT…" │
│ ( ) Serial port – advanced: pick "cu.PT-P710BT…" / "COMn"            │
│ ( ) USB cable  – most reliable on macOS (not Windows)                │
│ ( ) No printer – design only, virtual printer                       │
│                                       [Cancel]  [Choose device…]    │
└─────────────────────────────────────────────────────────────────────┘
States: ● ready (tape) · ◐ connecting · ○ asleep? press power · ✕ error + fix hint
```
Mobile (Android Chrome): single column — tape preview on top (pinch-zoom), block list below, sticky
Print bar.

### 6.5 Rendering hazards
- **Anti-fingerprinting canvas noise** (Brave Shields, Cromite) randomizes `getImageData` and prints
  as "snow". At startup a probe draws a solid colour and compares the readback; if noisy, printing is
  blocked with instructions to allow canvas for this site.
- Canvas text has no antialias switch; quality depends on supersampling + threshold. Small text
  (<2 mm) gets a warning in preflight.

---

## 7. Persistence

| Data | Store | Notes |
|---|---|---|
| Label documents | IndexedDB (`idb-keyval 6.3.0`, store `labels`) | key = doc id; autosave debounced 500 ms |
| Images, user fonts | IndexedDB (`blobs`) | referenced by `blobRef`; garbage-collected on save |
| Thumbnails | IndexedDB (`thumbs`) | 1-bit preview PNG for the label list |
| Prefs | `localStorage` (try/catch everywhere) | last transport kind/info, auto-reconnect flag, UI prefs |
| Export | `*.ptlabel.json` | self-contained (images inlined as data URLs; fonts by family + optional embedded) via `showSaveFilePicker` or Blob download; import via picker/drag-drop |
| Share link | URL fragment `#d=<base64url(deflate-raw(JSON))>` | `CompressionStream`; never sent to the server; images > 32 KB and fonts excluded with a notice |

- Call `navigator.storage.persist()` after the first save.
- `schema` is versioned; `migrate.ts` upgrades on load with unit-tested migrations; unknown future
  versions open read-only.
- No storage of anything printer-identifying beyond what `getPorts()`/`getDevices()` already holds.

---

## 8. Testing strategy

### 8.1 Rust unit tests (`cargo test -p ptouch`)
- **Real status fixture** from the user's PT-P710BT, `tests/fixtures/status/p710bt_24mm_laminated_idle.hex`:
  ```
  80 20 42 30 76 30 00 00 00 00 18 01 00 00 00 00 00 00 00 00 00 00 00 00 01 08 00 00 00 00 00 00
  ```
  must parse to: series 0x30, model 0x76 → PT-P710BT, no errors, media width 24 mm, media type
  laminated (0x01), status type Reply (0x00), phase Editing(0), notification None, tape colour White
  (0x01), text colour Black (0x08). Also: the same bytes split at every offset through
  `StatusFramer` yield exactly one frame; garbage prefixes are discarded and resynced.
- Synthetic frames derived from the fixture for every status type, phase, notification and error bit
  (Brother D1 tables) — including multi-bit error combinations.
- PackBits vectors from Brother's docs (`00×20 22 22 23 BA BF A2 22 2B` → `ED 00 FF 22 05 23 BA BF A2 22 2B`;
  16×00 → `F1 00`; incompressible → `0F` + 16 bytes) and `proptest` round-trips via `packbits_decode`.
- Geometry: print area per tape for every profile; encoder rejects bitmaps whose height ≠ print pins;
  length bounds; field-width overflow tests (copies, lines u32, margin u16).
- Session: scripted conversations against `VirtualPrinter` (normal, silent printer → timeout, cover
  open mid-job, wrong media, extra frames after print, fragmented input, cancel).
- `cargo-fuzz` targets: `parse_status`, `StatusFramer`, `Session::handle_input`, `packbits_decode`.
- no_std guard: `cargo build -p ptouch --no-default-features --target thumbv7em-none-eabihf`.

### 8.2 Golden byte-stream tests
- `tests/golden/*.bin` + `*.meta.toml` (model, tape, options, bitmap source). The test renders the
  bitmap (from a checked-in PBM), encodes, and compares **byte-exactly**; on mismatch it prints an
  annotated hex diff by command. Regenerate only with `UPDATE_GOLDEN=1`, reviewed in PR.
- Initial goldens: P710BT 24 mm blank/ruler/orientation, 12 mm text, 2-page copies, chain on/off,
  mirror. The header bytes are cross-checked by hand against Brother's PT-P710BT driver dump
  (`1B 69 7A 84 00 18 00 AA 02 00 00 00 00`, `… 01 00` for page 2, `1B 69 4D 40`, `1B 69 4B 08`,
  `1B 69 64 0E 00`, `4D 02`, `47 02 00 F1 00`), differing only where §5.3 says so (`ESC i ! 00`).
- Once hardware prints are confirmed, a golden is marked `verified_on = "PT-P710BT fw … 2026-…"`.
- Barcode correctness: render codes into a `Bitmap` and decode with `rxing 0.9.3` (dev-dependency).

### 8.3 wasm tests
`wasm-pack test --headless --chrome --chromedriver <matching driver>` (`$CHROMEWEBDRIVER/chromedriver`
on GitHub runners; locally `npx @puppeteer/browsers install chromedriver@<chrome version>` — wasm-pack's
auto-downloaded "latest" driver mismatches the installed Chrome). Covers error `code` propagation,
`isPtouchError`, tsify shapes, `Raster` → `Bitmap1` → `encodeJob` equals the native golden bytes, and
`PrintSession` driven by `VirtualPrinter` inside the browser.

### 8.4 Front-end tests
- **Vitest 5.0.3, node project**: `WebSerialTransport` against a `PortLike` fake built from real
  WHATWG streams (Node ≥18 globals) that fragments the 32-byte status (e.g. 7 + 25 bytes), delays,
  errors mid-stream (`port.readable` → null) and records writes; asserts chunking (`chunkSize`),
  `writer.ready` awaiting, `releaseLock` on error, the single read pump, abort/cancel paths.
  `WebUsbTransport` against a `UsbDeviceLike` fake. `PrinterClient` + `MockTransport` (wasm virtual
  printer) for connect → print → completion, wrong tape, cover open, asleep. Doc migrations, share-link
  round-trip, layout maths.
- **Vitest browser project** (`@vitest/browser-playwright 5.0.3`, Chromium): renderer + wasm raster
  snapshot tests with a bundled font (compare packed 1-bpp bytes), anti-fingerprinting probe.
- **Playwright 1.64.0 e2e** against `vite build` + `vite preview --base /ptouch/`:
  `page.addInitScript` replaces `navigator.serial` (and `navigator.usb`) with stubs backed by the
  mock; tests click Connect, assert the status chip ("24 mm", white/black), print, and assert the last
  written byte is `0x1A` and the decoded pages match the preview. This also proves the base path,
  wasm loading and the service worker.

### 8.5 Manual hardware tests (`docs/HARDWARE-TESTS.md`)
Native CLI over the OS serial node, reproducing the user's verified sequence first:
```
cargo run -p ptouch-cli -- status --port /dev/cu.PT-P710BTxxxx          # expect the fixture above
cargo run -p ptouch-cli -- test-label orientation --port /dev/cu.PT-P710BTxxxx
cargo run -p ptouch-cli -- test-label ruler --tape 24 --port /dev/cu.PT-P710BTxxxx
cargo run -p ptouch-cli -- print --text "Hello 12mm" --tape 12 --copies 2 --port /dev/cu.PT-P710BTxxxx
```
Record: status frames received during/after each print (count and order), completion latency, whether
a second `status` run works without power-cycling (macOS "works once"), and photos of the test labels.
Then the browser matrix (§12, H1–H9) with the deployed site, each result logged with OS, browser
version, transport kind and the packet log.

---

## 9. CI/CD to GitHub Pages

Single workflow `.github/workflows/pages.yml` (abridged below; the prototype of this workflow passed
actionlint 1.7.12, and the real file must too — actionlint runs in CI):
```yaml
on: { push: { branches: [main] }, pull_request: {}, workflow_dispatch: {} }
permissions: { contents: read }
concurrency: { group: pages-${{ github.ref }}, cancel-in-progress: false }   # don't cancel a deploy mid-flight
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: dtolnay/rust-toolchain@master
        with: { toolchain: 1.97.1, targets: "wasm32-unknown-unknown,thumbv7em-none-eabihf", components: "clippy,rustfmt" }
      - uses: Swatinem/rust-cache@v2
      - uses: taiki-e/install-action@v2
        with: { tool: wasm-pack@0.15.0 }
      - run: cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
      - run: cargo test --workspace
      - run: cargo build -p ptouch --no-default-features --target thumbv7em-none-eabihf
      - run: wasm-pack test --headless --chrome --chromedriver "$CHROMEWEBDRIVER/chromedriver" crates/ptouch-wasm
      - uses: actions/setup-node@v7
        with: { node-version: 24.18.0, cache: npm, cache-dependency-path: web/package-lock.json }
      - run: npm ci && npm run wasm && npm run check && npx vitest run
        working-directory: web
      - run: npx playwright install --with-deps chromium && npx playwright test
        working-directory: web
  build:
    needs: test
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - (toolchain, cache, wasm-pack, setup-node as above)
      - id: pages
        uses: actions/configure-pages@v6
      - run: npm ci && npm run wasm && npm run build
        working-directory: web
        env: { BASE_PATH: "${{ steps.pages.outputs.base_path }}" }
      - uses: actions/upload-pages-artifact@v5
        with: { path: web/dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    permissions: { pages: write, id-token: write }
    environment: { name: github-pages, url: "${{ steps.deployment.outputs.page_url }}" }
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
```
- `vite.config.ts`: `base: process.env.BASE_PATH ? \`${process.env.BASE_PATH.replace(/\/$/, '')}/\` : '/'`
  → `/ptouch/` on project pages. Runtime URLs use `import.meta.env.BASE_URL`. No router (single view;
  dialogs are state), so Pages' lack of SPA fallback is irrelevant.
- `npm run wasm` = `wasm-pack build ../crates/ptouch-wasm --target web --release --out-dir ../../web/src/wasm/pkg --out-name ptouch`.
  `ptouch-wasm/Cargo.toml` sets `wasm-opt = ["-Oz"]` (the extra `--enable-*` flags are redundant
  with binaryen 117 + rustc 1.97 and are dropped).
- PWA: `VitePWA({ registerType: 'autoUpdate', workbox: { globPatterns: ['**/*.{js,css,html,wasm,woff2,svg,png}'] } })`;
  scope and `start_url` follow `base`. An "update available — reload" toast avoids swapping wasm under
  a running print.
- Security: `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; connect-src 'self'">`
  (verify against the built output in e2e). Pages sends no COOP/COEP, so no wasm threads — not needed.
- Repository settings: Pages source = **GitHub Actions**. Dependabot for cargo, npm and actions;
  consider pinning actions by SHA (as Vite's own Pages workflow on `main` does).

---

## 10. Exact tool versions (pinned; verified against registries 2026-10-08)

**Rust**

| Item | Version |
|---|---|
| rustc / cargo | 1.97.1 (`rust-toolchain.toml`), edition 2024, resolver 3 |
| targets | `wasm32-unknown-unknown`; `thumbv7em-none-eabihf` (no_std check only) |
| wasm-pack | 0.15.0 (fetches binaryen `version_117`; upstream latest `version_133`) |
| wasm-bindgen | `=0.2.129` (exact; must equal the CLI wasm-pack downloads) |
| js-sys / web-sys | 0.3.106 |
| wasm-bindgen-test | 0.3.79 |
| tsify | 0.5.8 (`default-features = false, features = ["js"]`), `Ts<T>` only |
| serde / serde-wasm-bindgen | 1.x (`default-features = false, features = ["derive","alloc"]`) / 0.6.5 |
| thiserror | not used in core (hand-written `Display` keeps wasm small); 2.0.21 allowed in native crates |
| fast_qr / barcoders / datamatrix | 0.14.0 / 2.0.0 / 0.3.3 (v1) |
| rxing (dev-dependency) | 0.9.3 |
| serialport / nusb | 4.10.1 / 0.2.7 |
| objc2 / objc2-io-bluetooth (v1, macOS) | 0.6.5 / 0.3.2 |
| fontdue (CLI) | 0.9.4 |
| clap, proptest, cargo-fuzz | latest at scaffold time, recorded in `Cargo.lock` (not verified in research) |

**JavaScript** (exact pins in `web/package.json`; Node 24.18.0, npm 11.16.0)

| Package | Version |
|---|---|
| vite | 8.3.4 (Rolldown-based) |
| svelte / @sveltejs/vite-plugin-svelte | 5.57.2 / 7.3.1 |
| typescript / svelte-check / @tsconfig/svelte | 6.0.3 / 4.7.6 / 5.0.8 |
| vite-plugin-pwa | 2.0.0 |
| idb-keyval | 6.3.0 |
| vitest / @vitest/browser-playwright | 5.0.3 / 5.0.3 |
| @playwright/test | 1.64.0 |
| @types/w3c-web-serial / @types/w3c-web-usb | 1.0.8 / 1.0.14 |
| bwip-js (v1, lazy) / konva (v1, only if needed) | 4.11.4 / 10.7.1 |

**GitHub Actions**: actions/checkout@v7 (7.0.1), actions/setup-node@v7 (7.1.0),
actions/configure-pages@v6 (6.0.0), actions/upload-pages-artifact@v5 (5.0.0),
actions/deploy-pages@v5 (5.0.1), dtolnay/rust-toolchain@master, Swatinem/rust-cache@v2 (2.9.2),
taiki-e/install-action@v2 (2.87.26). Not `jetli/wasm-pack-action` (stale since 2022).
Runner: ubuntu-latest = ubuntu-24.04 (Chrome + matching ChromeDriver preinstalled; `$CHROMEWEBDRIVER`).

---

## 11. Delivery phases

| Phase | Deliverable | Exit criterion |
|---|---|---|
| **0 — Hardware spike** (first) | `web/` skeleton deployed to Pages with a **Diagnostics** page (connect by each path, send `00×100 1B 40 1B 69 53`, packet log, open/close ×3); `ptouch status` CLI | H1–H5 in §12 answered and written into `docs/HARDWARE-TESTS.md`; default connect order confirmed |
| 1 — Core + CLI | `ptouch` core (status, profiles, PackBits, encoder, session, virtual printer), golden tests, CLI print of text and test labels | orientation/ruler labels printed and photographed; goldens marked verified |
| 2 — Web MVP | §6.2 complete, PWA, CI deploy | prints from the deployed site on macOS Chrome (some path) and Windows or Android |
| 3 — v1 | §6.3 | per-feature |

---

## 12. Risks and open questions

### Hardware questions (resolve in Phase 0, in this order)
- **H1 — macOS direct RFCOMM in Chrome.** Does "PT-P710BTxxxx" (SPP filter) open and return status
  on the user's Mac? Prior art (obwat) saw `open()` fail on macOS 26 / Chrome 150–151; Chromium code
  supports it. Run with nothing else holding the printer (P-touch Editor/CLI closed).
- **H2 — macOS `/dev/cu.*` in Chrome.** Does the unfiltered "cu.PT-P710BTxxxx" entry work, and does
  it survive close/reopen ×3 (Ircama#3 "works once"; a macOS 27 native probe got no RFCOMM link)?
- **H3 — Completion signalling.** Which frames does the P710BT push during/after a print with
  `ESC i ! 00`, how many, and is "printing completed" always sent? Does chain mode hold the last label?
- **H4 — Orientation/mirroring** of the pin map (test label).
- **H5 — WebUSB on macOS** with this printer while CUPS/P-touch Editor are installed.
- H6 — Windows 11 + Chrome: direct-RFCOMM entry and COM-port grant persistence.
- H7 — Android Chrome 138+: RFCOMM print and disconnect detection without `connected`.
- H8 — Does a periodic `ESC i S` defer the ~10 min auto power-off?
- H9 — Firefox ≥156 on macOS: OS port tagging, print, grant persistence across restarts.

### Risks
| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| **macOS Bluetooth unusable from Chrome** (both H1 and H2 fail) | Medium / High — the user's primary setup | WebUSB cable path on macOS is proven; native CLI with IOBluetooth RFCOMM (`MacRfcommTransport`) for power users; keep the port open once it works; clear "power-cycle printer" guidance |
| Protocol details wrong (`ESC i !` on P710BT, n9 semantics, pin map) | Medium / Medium | Phase 0/1 hardware loop, golden tests frozen only after real prints, virtual printer encodes our understanding explicitly |
| Printer prints garbage or blocks (e.g. job stuck across power cycle as seen on E560BT with wrong n9) | Low for P710BT / High | Model-specific dialects; never retry a partially sent job; invalidate + `ESC @` recovery; per-model quirks table |
| Firefox users on 151–155 get an empty Bluetooth chooser | Medium / Low | Always unfiltered `requestPort()` on Gecko |
| Firefox enterprise installs have Web Serial off; Brave disables Web Serial | Low / Low | Detect missing API → support banner with browser-specific hint |
| Canvas readback randomized (Brave/Cromite) prints snow | Medium / Medium | Probe + block printing with instructions (§6.5) |
| Chrome's Web Serial grant for macOS `cu.*` is session-only | Certain / Low | Prefer direct RFCOMM; explain re-pick after restart |
| Exclusive tty lock: CLI and browser contend for `/dev/cu.*` | Certain / Low | Error hint "close other apps using the printer" |
| WebUSB unusable on Windows by default | Certain / Low | Hide USB on Windows unless "I installed WinUSB" is ticked; Bluetooth is the Windows path |
| Text quality at 180 dpi | Medium / Medium | 3× supersampling, threshold slider, fonts chosen for low dpi, small-text warning, real-tape tuning |
| Toolchain drift (wasm-bindgen CLI/crate mismatch, TS 7, binaryen 117 lag) | Medium / Low | Exact pins, Dependabot grouped bumps, CI builds from clean |
| Unproven browser-side `connected`/events (Android lacks them) | Certain / Low | Errors on read/write are the source of truth |

### Open design questions (decide after Phase 0, not before)
- Default connect order on macOS (direct RFCOMM vs `cu.*` vs USB) — set from H1/H2/H5 data.
- Whether to run I/O + wasm in a dedicated worker (Web Serial `getPorts`/`open` are exposed in
  workers; `requestPort` is not). MVP runs on the main thread.
- Whether to move text rasterization into Rust later (immune to canvas noise, bit-identical across
  browsers) at the cost of shipping fonts as bytes.

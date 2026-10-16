# ptouch — printer settings (Auto Power Off, Auto Power On)

Status: **spec frozen by the protocol lead, 2026-10-16.** The wire facts are in
[PROTOCOL.md §3.6](PROTOCOL.md). The model data is the `settings_profile` key in
[models.toml](models.toml), already generated into `ModelProfile::settings_profile` /
`ptouch::model::SettingsProfile`. This document freezes the API that the implementation packages
build. Hardware status: **nothing verified on a real printer yet**. The read-only probe was skipped
because the PT-P710BT was off (PROTOCOL.md §9.1 items 12–14).

User request: "download the app [Brother's Printer Setting Tool], reverse engineer it to add those
power commands to our CLI or webapp so we can control this without Brother's tools". The
PT-P710BT's tool shows "Auto Power Off" (USB/AC: None, 10–60 min), "Auto Power Off (Li-ion)", and
"Auto Power On".

---

## 0. Decisions (frozen)

| # | Decision | Why |
|---|---|---|
| D1 | Scope v1 = three settings: `auto-power-on`, `auto-power-off`, `auto-power-off-battery`. All other §3.6.4 items (report contents, length adjustment, margins, print log, special tape feed, Bluetooth) are catalogued only. | They are the user's request. The other items need other reply formats, or have unresolved bytes (§8 #37). |
| D2 | Models: every model with a `settings_profile`: P710BT, P715eBT (`p710bt`); P900W, P950NW, D800W, E800W (`p900w`); P910BT (`p910bt`). Others: the feature is hidden. | The bytes come from Brother's own definition for each of these models [PST-Mac]. |
| D3 | Follow Brother's per-model selector: on P710BT `auto-power-off` = selector `01`, battery = `00`. The other profiles use the reverse. | It keeps `ptouch` and Brother's tool in step for the same setting name (PROTOCOL.md §8 #34). Which physical timer each selector controls can only be settled by timing the auto-off (§9.1 item 12), not by comparing with Brother's tool or by a read-back. Until then the CLI and the studio name these rows by Brother's labels and say the mapping is unverified (`SettingSpec::selector_unverified`). |
| D4 | Values are typed: `Enabled(bool)` or `Minutes(u16)` (0 = never). Each profile maps bytes to values by an explicit table, never by formula. Unlisted bytes are never sent. An unlisted byte in a reply is reported raw (`Unlisted(u8)`). | The P900W-family AC timer is an index (`07` = 2 h); the P910BT one counts 10-minute units (`0C` = 2 h). |
| D5 | Sequence = Brother's commands and order (§3.6.2), on one open connection, each command a separate transport write. Input is drained before every get (anti-stale), the reply timeout is 1000 ms, and `1B 7E 53` is sent after writes. | It matches the vendor tool; the drain fixes the stale-reply hazard [toml0006]. |
| D6 | A write sends only the requested items. It is always followed by an automatic read-back of the same items. The result carries `verified`. | Brother never verifies. We must, because the commit (`ESC ~ S`) and the 3-byte replies are unverified. A read-back cannot detect a swapped selector, because the write and the read use the same selector. That is why D3's rows are flagged instead. |
| D7 | Settings run only from the session's `Ready` state, never during a job. While a settings transaction runs, the session is busy: status requests and submits return `Error::Busy`. | Protocol safety (§6.8). |
| D8 | Writes need an explicit user confirmation: `--yes` or an interactive prompt in the CLI, a confirm dialog in the studio. Reads need none. | User's printer, persistent state. |
| D9 | No API emits any byte sequence on the §3.6.6 never-send list. A unit test enforces this over every table. | Safety. |
| D10 | USB and Bluetooth use the same code path. Bluetooth is flagged as untested in the UI until a hardware run. | The bytes are the same on every transport (§1). The Mac tool is USB-only. |

---

## 1. Core: `crates/ptouch` (sans-IO, `no_std` + `alloc`)

### 1.1 New module `crates/ptouch/src/settings.rs`

The public API below is frozen. Private helpers are free.

```rust
//! Printer-stored settings (PROTOCOL.md §3.6). Pure tables + encode/decode; the transaction
//! state machine lives in `session.rs`.

/// A setting `ptouch` can read and change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "kebab-case"))]
#[non_exhaustive]
pub enum SettingId {
    /// "Auto Power On": turn on when external power (USB/AC) is connected.
    AutoPowerOn,
    /// "Auto Power Off" on external power (P710BT: USB/AC adapter or computer; P900W family:
    /// AC/DC; P910BT: USB connection).
    AutoPowerOff,
    /// "Auto Power Off (Li-ion)": on battery.
    AutoPowerOffBattery,
}

impl SettingId {
    /// All ids, in display order.
    pub const ALL: [SettingId; 3];
    /// `"auto-power-on"`, `"auto-power-off"`, `"auto-power-off-battery"` (CLI/wasm names).
    pub const fn as_str(self) -> &'static str;
    /// Inverse of `as_str`; also accepts `"auto-power-off-li-ion"` as an alias of the battery id.
    pub fn parse(s: &str) -> Option<SettingId>;
}

/// A typed setting value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[non_exhaustive]
pub enum SettingValue {
    /// On/off settings.
    Enabled(bool),
    /// Durations; `0` = never ("None").
    Minutes(u16),
}
// Display: "on" / "off"; "never", "10 min" … "50 min", "60 min" (P710BT list) or "1 h", "2 h" …
// Use whole hours when minutes % 60 == 0 && minutes >= 60, except that 60 is shown as
// "60 min" on profiles whose list ends at 60 min (p710bt).

/// How the printer answers a get (PROTOCOL.md §3.6.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[non_exhaustive]
pub enum ReplyFormat {
    /// 32-byte status frame, `st[18] = F0`, value `st[30]`.
    StatusF0,
    /// 3 bytes, value at offset 2; bytes 0–1 not checked (the `01 00` prefix is INFERRED).
    LenValue,
}
impl ReplyFormat {
    /// Reply length in bytes (32 / 3).
    pub const fn len(self) -> usize;
}

/// One allowed value and its wire byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct Choice {
    pub byte: u8,
    pub value: SettingValue,
}

/// One setting on one profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[non_exhaustive]
pub struct SettingSpec {
    pub id: SettingId,
    /// Complete get command, e.g. `1B 69 55 41 01 01`.
    pub get: &'static [u8],
    /// Set command without the value byte, e.g. `1B 69 55 41 00 01`.
    pub set_prefix: &'static [u8],
    pub reply: ReplyFormat,
    /// Allowed values in Brother's order.
    pub choices: &'static [Choice],
    /// Brother's UI label for this model (PROTOCOL.md §3.6.5), e.g. "Auto Power Off (Li-ion)".
    pub brother_label: &'static str,
}

impl SettingSpec {
    /// The get command (`self.get`).
    pub const fn encode_read(&self) -> &'static [u8];
    /// `set_prefix + byte`.
    /// Errors: `Error::InvalidInput("value not offered by this model")` (also for a value of
    /// the wrong kind).
    pub fn encode_write(&self, value: SettingValue) -> Result<Vec<u8>, Error>;
    /// Decodes a complete reply of `self.reply.len()` bytes.
    /// - `StatusF0`: `Error::StatusLength` / `Error::StatusHeader` for a malformed frame;
    ///   `Error::Protocol("not a settings reply")` when `st[18] != F0`.
    /// - `LenValue`: `Error::Protocol("bad settings reply")` unless exactly 3 bytes (value =
    ///   byte 2, bytes 0–1 not checked; a status frame is told apart by the session).
    pub fn decode_reply(&self, reply: &[u8]) -> Result<SettingReading, Error>;
    pub fn byte_for(&self, value: SettingValue) -> Option<u8>;
    pub fn value_for(&self, byte: u8) -> Option<SettingValue>;
}

/// A decoded value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub enum SettingReading {
    /// A byte from the model's list.
    Value(SettingValue),
    /// A byte the model's list does not contain (changed by other software / firmware).
    Unlisted(u8),
}

/// One item of a read result.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct SettingReport {
    pub id: SettingId,
    pub reading: SettingReading,
    /// The full reply as received (32 or 3 bytes), for logs and hardware reports.
    pub raw: Vec<u8>,
}

/// Every setting the model supports (empty slice when `settings_profile` is `None`).
pub fn settings_for(profile: &ModelProfile) -> &'static [SettingSpec];
/// One setting, or `None` when the model lacks it.
pub fn setting_spec(profile: &ModelProfile, id: SettingId) -> Option<&'static SettingSpec>;

/// `1B 40 1B 69 61 01`: sent before the gets or sets of a transaction.
pub const SETTINGS_PROLOGUE: [u8; 6];
/// `1B 69 61 FF`: ends a read transaction.
pub const SETTINGS_READ_EPILOGUE: [u8; 4];
/// `1B 7E 53 1B 69 61 FF`: ends a write transaction (`ESC ~ S` = commit, INFERRED).
pub const SETTINGS_WRITE_EPILOGUE: [u8; 7];
```

The tables (private `static`s), copied from PROTOCOL.md §3.6.4. Every byte is a fact; no Brother
text is copied apart from the short UI labels.

| Profile | Id | get | set_prefix | reply | choices (byte → value) |
|---|---|---|---|---|---|
| `P710bt` | AutoPowerOn | `1B 69 55 70 01` | `1B 69 55 70 00` | StatusF0 | `00` off, `01` on |
| `P710bt` | AutoPowerOff | `1B 69 55 41 01 01` | `1B 69 55 41 00 01` | StatusF0 | `00` 0, `01` 10, `02` 20, `03` 30, `04` 40, `05` 50, `06` 60 |
| `P710bt` | AutoPowerOffBattery | `1B 69 55 41 01 00` | `1B 69 55 41 00 00` | StatusF0 | as AutoPowerOff |
| `P900w` | AutoPowerOn | `1B 69 55 70 01` | `1B 69 55 70 00` | StatusF0 | `00`/`01` |
| `P900w` | AutoPowerOff | `1B 69 55 41 01 00` | `1B 69 55 41 00 00` | LenValue | `00` 0, `01`–`05` 10–50, `06` 60, `07` 120, `08` 240, `09` 480, `0A` 720 |
| `P900w` | AutoPowerOffBattery | `1B 69 55 41 01 01` | `1B 69 55 41 00 01` | LenValue | `00` 0, `01`–`05` 10–50, `06` 60 |
| `P910bt` | AutoPowerOn | as P900w | | StatusF0 | `00`/`01` |
| `P910bt` | AutoPowerOff | `1B 69 55 41 01 00` | `1B 69 55 41 00 00` | LenValue | `00` 0, `01`–`06` 10–60, `0C` 120, `18` 240, `30` 480, `48` 720 |
| `P910bt` | AutoPowerOffBattery | `1B 69 55 41 01 01` | `1B 69 55 41 00 01` | LenValue | `00` 0, `01`–`06` 10–60 |

Brother labels: P710bt "Auto Power On" / "Auto Power Off" / "Auto Power Off (Li-ion)"; P900w
"Auto Power On" / "Auto Power Off (AC/DC)" / "Auto Power Off (Li-ion)"; P910bt "Auto Power On" /
"Auto Power Off (USB Connection)" / "Auto Power Off (Li-ion)".

Re-exports from `lib.rs`: `pub mod settings;` and `pub use settings::{SettingId, SettingValue,
SettingReading, SettingReport, SettingSpec, settings_for, setting_spec};`.

### 1.2 Session additions (`crates/ptouch/src/session.rs`)

```rust
impl Session {
    /// Reads `ids` (in the given order) from the printer.
    /// Errors (nothing queued): `Error::Busy` unless `SessionState::Ready`;
    /// `Error::Unsupported("printer settings are not supported on this model")` when the
    /// profile is unknown or lacks an id; `Error::Empty` for an empty list;
    /// `Error::InvalidInput("duplicate setting")`.
    pub fn read_settings(&mut self, ids: &[SettingId], now_ms: u64) -> Result<(), Error>;

    /// Writes `values`, then reads the same ids back.
    /// Errors as `read_settings`, plus `Error::InvalidInput("value not offered by this model")`
    /// (checked for every item before anything is queued).
    pub fn write_settings(
        &mut self,
        values: &[(SettingId, SettingValue)],
        now_ms: u64,
    ) -> Result<(), Error>;
}

// SessionState (non_exhaustive): new variant
    /// A settings read or write transaction is running.
    Settings,

// Event (non_exhaustive): new variants
    /// A `read_settings` finished; items in request order.
    SettingsRead(Vec<SettingReport>),
    /// A `write_settings` finished: the read-back values, and whether each one equals what
    /// was written.
    SettingsWritten { report: Vec<SettingReport>, verified: bool },

// TimeoutKind (non_exhaustive): new variant
    /// No complete reply to a settings get within `settings_reply_timeout_ms`.
    SettingsReply,

// SessionConfig: new fields (Default in parentheses); update every struct literal
// (tests/session.rs, ptouch-cli commands/mod.rs, ptouch-wasm convert.rs + dto.rs).
    /// Input discarded after the settings prologue (100).
    pub settings_drain_ms: u64,
    /// Input discarded before each get, and the gap between set writes (50).
    pub settings_gap_ms: u64,
    /// Wait for a complete get reply (1000).
    pub settings_reply_timeout_ms: u64,
    /// Input discarded after the write epilogue, before the read-back (500).
    pub settings_settle_ms: u64,
```

Transaction state machine (normative). Each arrow is one `poll_transmit` buffer or one timer.

```text
Ready --read_settings--> tx PROLOGUE, deadline +drain                [discard input]
  drain elapsed: for each item:
    clear framer + raw buffer; deadline +gap                          [discard input]
    gap elapsed: tx item.get, deadline +reply_timeout                 [collect]
      StatusF0: frames via StatusFramer; a frame with st[18] != F0 is skipped (not an
        error, not last_status) unless it carries an error (st[7..9] != 0 or type 02/18)
        → fail(Printer(errors)); type 04 → fail(PrinterOff), state Failed.
      LenValue: append raw bytes until 3 collected; decode.
      decode error → fail(Protocol(..)).
      reply_timeout → fail(Timeout(SettingsReply)).
  all items: tx READ_EPILOGUE → emit SettingsRead → Ready

Ready --write_settings--> tx PROLOGUE, deadline +gap
  for each item: tx set bytes, deadline +gap                          [discard input]
  tx WRITE_EPILOGUE, deadline +settle                                 [discard input]
  then the read sub-transaction above (with its own PROLOGUE/EPILOGUE) for the same ids
  → emit SettingsWritten { verified = every reading == Value(written) } → Ready

fail(e): queue READ_EPILOGUE (always restores the default command mode), emit
         Failed { error: e, resume_from_page: None }, back to Ready (Failed for PrinterOff).
cancel() during Settings: queue READ_EPILOGUE, emit Failed { Cancelled, None }, Ready.
connect() during Settings: as cancel, then the handshake.
```

A failure after at least one set was sent makes the printer's state unknown. The `Failed` event
is the same; callers say "the printer may have stored the new value; read the settings again".

### 1.3 Virtual printer (`crates/ptouch/src/virtual_printer/`)

- **Parser** (`parser.rs`): new `Command` variants, framed independently of the model (every
  table model is a series-`30` PT, so `ESC i U A` always carries a selector):
  - `SettingGet { op: u8, selector: Option<u8> }`: `1B 69 55 70 01` (5 bytes), `1B 69 55 41 01 s` (6).
  - `SettingSet { op: u8, selector: Option<u8>, value: u8 }`: `1B 69 55 70 00 v` (6),
    `1B 69 55 41 00 s v` (7).
  - `SettingsCommit`: `1B 7E 53` (3). Other `1B 7E xx` stays `Unknown`.
- **State:** `settings: BTreeMap<(u8 op, Option<u8> sel), u8>`. The defaults are virtual and not
  hardware facts: auto power on `00`; selector `00` and `01` timers `03` (30 min) on p710bt;
  index `03` on p900w/p910bt.
  - `pub fn setting_byte(&self, op: u8, selector: Option<u8>) -> Option<u8>`
  - `pub fn with_setting(self, op: u8, selector: Option<u8>, byte: u8) -> Self`
  - `pub fn commits(&self) -> usize`
- **Replies:** only for models with a `settings_profile`. Other models record
  `Violation::UnsupportedCommand` and stay silent, so the host times out.
  - `StatusF0`: the idle status with `st[18] = F0` and `st[30] = byte`, after
    `timing.reply_delay_ms`.
  - `LenValue`: `01 00 byte`.
- **Writes** apply immediately. A byte outside the profile's list is a new
  `Violation::InvalidSettingValue { offset, byte }` and is not stored. A settings command while
  printing is the existing `Violation::CommandWhilePrinting`.
- **Output API change** (all callers are in the workspace):
  `pub fn poll_output(&mut self, now_ms: u64) -> Option<Vec<u8>>` (was `Option<[u8; 32]>`),
  because the queue now holds 3-byte replies too. Callers to update:
  - `ptouch-transport/src/virtual_transport.rs`
  - `ptouch-cli/src/commands/simulate.rs`
  - `ptouch-wasm/src/{convert.rs, virtual_printer.rs}`, `ptouch-wasm/tests/web.rs`
  - `crates/ptouch/tests/{session,virtual_printer}.rs`
  The JS `pollOutput` already returns `Uint8Array`.
- **New `Behaviour` variants (tests):**
  - `SettingsSilent`: never answers a get.
  - `SettingsWritesIgnored`: accepts sets but keeps the old values, which gives `verified = false`.
  - `StaleFrameBeforeSettingsReply`: pushes one type-`00` status between the prologue and the
    first get, to exercise the drain.

### 1.4 Core tests (must pass before the CLI/wasm packages merge)

- Exact transmit sequences (one `Vec` per `poll_transmit`):
  - P710BT read all: `[1B 40 1B 69 61 01] [1B 69 55 70 01] [1B 69 55 41 01 01] [1B 69 55 41 01 00] [1B 69 61 FF]`.
  - P710BT write `auto-power-off = 10`: `[1B 40 1B 69 61 01] [1B 69 55 41 00 01 01] [1B 7E 53 1B 69 61 FF]`, then the read-back `[1B 40 1B 69 61 01] [1B 69 55 41 01 01] [1B 69 61 FF]`.
- Encoding:
  - P900W `auto-power-off = 120` → `1B 69 55 41 00 00 07`.
  - P910BT `auto-power-off = 120` → `… 00 00 0C`.
  - P710BT `= 70` or `= 120` → `InvalidInput`. `AutoPowerOn = Minutes(10)` → `InvalidInput`.
- Decoding:
  - F0 frame with `st[30] = 06` → `Value(Minutes(60))`.
  - `st[30] = 07` → `Unlisted(0x07)`.
  - A type-`00` frame during collect is skipped. An error frame fails the transaction.
  - A short reply ends in `Timeout(SettingsReply)`, and the read epilogue is still sent.
- Session gating:
  - `Busy` while printing or handshaking.
  - `Unsupported` on PT-E560BT / PT-P300BT / unknown model.
  - `request_status` and `submit` return `Busy` during `Settings`.
- Virtual printer end-to-end for each profile:
  - read → write → `SettingsWritten { verified: true }`, with `commits() == 1`.
  - `SettingsWritesIgnored` → `verified: false`.
  - `SettingsSilent` → timeout.
  - `StaleFrameBeforeSettingsReply` → the correct value.
- Safety (D9): no table byte string starts with any §3.6.6 never-send sequence
  (`1B 69 55 58/69/5A/4E/78`, `1B 7E 63`, `1B 7E 52`, `54 0C`, `1B 69 61 FA`). Checked over
  `get`, `set_prefix`, the prologue and both epilogues.
- `cargo check-wasm` and `cargo check-nostd` stay clean.

---

## 2. CLI: `crates/ptouch-cli`

```text
ptouch [connection] settings get [all|auto-power-on|auto-power-off|auto-power-off-battery]…
ptouch [connection] settings set <setting> <value> [--yes] [--dry-run [--model M]]
ptouch settings list [--model M]                      offline: settings + allowed values
```

- **Values:**
  - `auto-power-on`: `on|off|enable|disable|1|0`.
  - Timers: `never|none|off|0`, `<n>` (minutes), `<n>min`, `<n>h` (e.g. `2h`). The value must be
    in the model's list; otherwise exit 2 with the allowed list
    (`allowed for PT-P710BT: never, 10, 20, 30, 40, 50, 60 min`).
- **`get` output** (one line per item, aligned; the Brother label in parentheses):
  ```
  auto-power-on            off      (Auto Power On)
  auto-power-off           30 min   (Auto Power Off: USB/AC power)
  auto-power-off-battery   never    (Auto Power Off (Li-ion))
  ```
  - `Unlisted(b)` prints `unknown (0xNN)`.
  - `-v` also prints each raw reply (`<<` hex), as the driver already does for frames.
- **`set` flow:**
  1. Connect (handshake).
  2. Read the current value and print `current: 30 min`.
  3. Confirm:
     - without `--yes` on a TTY, prompt `Change auto-power-off on PT-P710BT from 30 min to 10 min? [y/N]`;
     - without `--yes` off a TTY, exit 2 (`refusing to change a printer setting without --yes`).
  4. Write and read back. Print `auto-power-off = 10 min (verified)`.
  5. When `verified == false`, exit 1 with `printer reports 30 min after writing 10 min`.
  6. Unchanged value: print `already 10 min` and send no write.
- **Warnings:**
  - Every `set` prints a one-line warning while the model's settings are not hardware-verified
    (a const list in the CLI, empty today: `settings support on PT-P710BT is untested on
    hardware`).
  - Bluetooth adds `(Bluetooth path untested)`.
- **`--dry-run`** prints the exact buffers a `set` would send, one per line, with no connection
  and with `--model` (default PT-P710BT). Use it in CLI tests and for review.
- **Driver** (`driver.rs`):
  - `Driver::read_settings(&mut self, ids) -> Result<Vec<SettingReport>, CliError>`
  - `Driver::write_settings(&mut self, values) -> Result<(Vec<SettingReport>, bool), CliError>`
  Both pump until `SettingsRead` / `SettingsWritten` / `Failed`. Ctrl-C calls `session.cancel`.
- **Errors:** `CliError::Protocol(Unsupported)` → `printer settings are not supported on <model>`
  (exit 2). A timeout gives the hint `the printer did not answer the settings request; it may
  not support it over this link`.
- **Tests** (`tests/cli.rs`, offline, `virtual:24` endpoint):
  - `settings get` on the virtual P710BT;
  - `settings set auto-power-off 10 --yes`, then `get`;
  - `--dry-run` byte output;
  - refusal without `--yes` (stdin not a TTY);
  - an unsupported model.
- Update `docs/HARDWARE-TESTS.md` with tests HW-S1 to HW-S3, which mirror PROTOCOL.md §9.1
  items 13, 12 and 14.

---

## 3. wasm: `crates/ptouch-wasm`

```ts
// free functions
export function settingsFor(model: string): SettingInfo[]      // [] if unsupported/unknown model
// PrintSession
readSettings(ids: SettingId[], nowMs: number): void              // throws ErrorInfo (BUSY, UNSUPPORTED, …)
writeSettings(values: SettingWrite[], nowMs: number): void
// types (tsify)
type SettingId = 'auto-power-on' | 'auto-power-off' | 'auto-power-off-battery'
type SettingValue = { kind: 'enabled'; enabled: boolean } | { kind: 'minutes'; minutes: number }
interface SettingInfo { id: SettingId; brotherLabel: string; kind: 'toggle' | 'duration'; choices: SettingValue[] }
interface SettingWrite { id: SettingId; value: SettingValue }
interface SettingReport { id: SettingId; value?: SettingValue; unlistedByte?: number; raw: number[] }
// SessionEvent additions
| { type: 'settings-read'; report: SettingReport[] }
| { type: 'settings-written'; report: SettingReport[]; verified: boolean }
// SessionState addition: { state: 'settings' } (same shape as the other unit states)
// SessionConfig dto: settingsDrainMs, settingsGapMs, settingsReplyTimeoutMs, settingsSettleMs (optional)
// ErrorInfo code for TimeoutKind::SettingsReply: 'TIMEOUT' with detail kind 'settings-reply'
```

Test (`tests/web.rs`): virtual P710BT read/write round trip through `PrintSession` and the wasm
`VirtualPrinter`. Clippy on `wasm32-unknown-unknown` stays clean. Run `npm run wasm` to refresh
`web/src/wasm/pkg`.

---

## 4. Web studio: `web/`

- **Client** (`printer/client.ts`):
  - `readSettings(ids?: SettingId[]): Promise<SettingReport[]>` (default: every id in
    `settingsFor(model)`).
  - `writeSettings(values: SettingWrite[]): Promise<{ report: SettingReport[]; verified: boolean }>`.
  - New `ClientState` `'settings'`. The idle keepalive is suppressed while in it, and print is
    disabled (the print gate shows "Busy: printer settings").
  - Both calls are serialized on the existing `#tx` chain and are abortable (abort → `session.cancel`).
- **ConnectionManager** (`printer/connect.ts`): pass-through `readSettings` / `writeSettings`.
  Failures become a `Problem` with stage `'settings'`.
- **UI:** a new lazy chunk, `web/src/ui/printer-settings/PrinterSettings.svelte`, loaded with
  `import()` only when opened.
  - **Entry points:**
    - a "Printer settings…" button in `ConnectDialog` when connected (`state === 'ready'`) and
      `settingsFor(model).length > 0`;
    - a "Printer settings" card in Diagnostics (same component, embedded).
    - Hidden for models without support, in the iPhone design-only mode, and when not connected.
  - **On open:** read all and show a spinner per row. Rows:
    - "Auto power on" (switch);
    - "Auto power off: on external power" (select);
    - "Auto power off: on battery" (select).
    Where the selector is unverified (PT-P710BT), the two timer rows are named by Brother's
    label instead ("Auto power off: “Auto Power Off”"), and a note says which timer each
    controls is unverified.
    The select options are the model's `choices` (`Never`, `10 min` … `60 min`, `1 h`, `2 h` …).
    A subtitle names Brother's label ("Same as 'Auto Power Off' in Brother's Printer Setting
    Tool").
  - **Change:** choosing a duration only stages it, and an Apply button opens the confirmation.
    On Windows, Linux and ChromeOS, arrow keys change a closed select at once, so `change` must
    not open a dialog. The confirm dialog says `Change auto power off (external power) from 30 min
    to 10 min? The printer stores this setting.`, with buttons [Cancel] [Change]. Then write, read
    back, and show one of:
    - ✓ "Saved and verified";
    - ⚠ "The printer still reports 30 min" (with a Try again button that asks again);
    - ✕ the error and "The printer may have stored the new value. Read again."
    One change at a time; controls are disabled while a transaction runs, and while a print the
    user asked for is being prepared or sent. Focus returns to the row's control afterwards.
  - **Unlisted reading:** shows "Unknown (0xNN)" with the select unselected. Picking a value is
    allowed (it is a normal write).
  - A "Read again" button. Notes: "untested on this printer model" for every model until
    hardware-verified, and "Bluetooth: untested" on the Bluetooth path.
  - USB, Bluetooth (Web Serial) and the virtual printer all go through `PrinterClient`, so there
    is no path-specific code.
- **Tests:**
  - Unit: the client against `MockTransport` (wasm virtual printer) for read, write, verify, and
    busy gating.
  - Component: hidden for PT-E560BT, shown for PT-P710BT.
  - Playwright e2e on the virtual printer: open the dialog, see "30 min", change to 10, confirm,
    see "Saved and verified".
  - The layering rules in `web/tests/unit/layering.test.ts` still apply.
- **Copy and diagnostics:** `report.ts` includes the last settings read (values, not raw bytes)
  in "Copy diagnostics". Device names stay masked.

---

## 5. Packages and order

| Package | Owns | Depends on |
|---|---|---|
| P-core | `crates/ptouch/src/{settings.rs, session.rs, error.rs, lib.rs, virtual_printer/**}`, `crates/ptouch/tests/**`, and the `poll_output` caller fixes in other crates | — (`settings_profile` already generated) |
| P-cli | `crates/ptouch-cli/**`, `docs/HARDWARE-TESTS.md` | P-core |
| P-wasm | `crates/ptouch-wasm/**`, `web/src/wasm/pkg` | P-core |
| P-web | `web/src/printer/**`, `web/src/ui/printer-settings/**`, the ConnectDialog/Diagnostics entry points, web tests | P-wasm |

Lead-owned and frozen: `docs/PROTOCOL.md §3.6`, `docs/models.toml` (`settings_profile`), and this
file. A package that needs a change to a frozen item reports it instead of editing it.

Done = `cargo test --workspace`, `cargo clippy --workspace --all-targets`, `cargo xtask
gen-models --check`, `cargo check-wasm`, `cargo check-nostd`, the web unit tests and Playwright
are green. No hardware writes happen in any package. A hardware run (§9.1 items 13 → 12 → 14)
happens only with the user present and their go-ahead for item 14.

---

## 6. Unknowns carried into implementation (see PROTOCOL.md §3.6.7)

- **P710BT selector mapping (D3).** Settled only by timing the physical auto-off (PROTOCOL.md
  §9.1 item 12, HARDWARE-TESTS.md HW-S2 step 3). If it shows the reverse, swap the two `P710bt`
  rows' selectors, clear `selector_unverified` and update §3.6.4. The API does not change.
- **`st[30]` and `F0` on the P710BT.** If the reply turns out to be a different layout, only
  `ReplyFormat` / the table changes.
- **`ESC ~ S` effect, immediate vs. after-restart effect.** The UI copy says "stored". If a
  restart turns out to be needed, add a note.
- **The 3-byte `ESC i U A` reply on the P900W family / P910BT.** Unverified. The virtual printer
  follows the table.
- **Bluetooth behaviour.** Unknown; the UI and CLI say "untested".

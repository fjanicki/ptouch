//! Model and media tables (WP1).
//!
//! # Contract
//! - The single source of truth is `docs/models.toml`. `cargo xtask gen-models` turns it into
//!   `model/generated.rs` (checked in; `cargo xtask gen-models --check` fails CI when stale). Nothing
//!   in this module may hard-code a per-model value that the table carries.
//! - The protocol is **one protocol parameterised per model** (PROTOCOL.md §1): instead of the
//!   ARCHITECTURE.md §4.1 `Dialect` enum, the encoder and session branch on the explicit
//!   parameters below ([`PageCommand`], [`ModelProfile::null_bytes`], [`Caps`], [`Sends`],
//!   [`CancelCommand`], [`ModelProfile::protocol_version`]).
//! - Unknown values from the TOML (`unknown = [...]`) are `None` here, never a guessed value.
//! - Lengths that the TOML gives in (fractional) millimetres are stored in **tenths of a
//!   millimetre** (`*_mm_x10`) so the tables stay integer-only.
//! - Lookups are total and allocation-free: they return `Option`/`Result`, never panic.
//!
//! # Spec references
//! PROTOCOL.md §1 (parameters), §2.1 (BT device-name → model), §2.8 (USB PIDs), §3.3
//! (protocol-version gates), §4.1 (`st[3]`/`st[4]`), §4.6 (media geometry key), §4.7 (battery
//! format), §5.1–§5.2 (pins), §5.6 (page length), §7 (quirks); models.toml header comments.

mod generated;
mod media;

pub use media::{Geometry, TapeKind, TapeSpec};

use crate::error::Error;

/// Brother USB vendor ID (PROTOCOL.md §2.8; models.toml `meta.usb_vendor_id`).
pub const USB_VENDOR_ID: u16 = generated::USB_VENDOR_ID;
/// USB bulk OUT endpoint (data to the printer; `meta.usb_out_endpoint`).
pub const USB_OUT_ENDPOINT: u8 = generated::USB_OUT_ENDPOINT;
/// USB bulk IN endpoint (status from the printer; `meta.usb_in_endpoint`).
pub const USB_IN_ENDPOINT: u8 = generated::USB_IN_ENDPOINT;
/// USB interface class "printer".
pub const USB_PRINTER_CLASS: u8 = 0x07;
/// Bluetooth Serial Port Profile UUID16 (PROTOCOL.md §2.1).
pub const SPP_UUID16: u16 = 0x1101;
/// Bluetooth Serial Port Profile UUID, lower-case canonical form (Web Serial filters use it;
/// `meta.spp_uuid`).
pub const SPP_UUID: &str = generated::SPP_UUID;
/// PT-N25BT BLE service UUID, lower-case (PROTOCOL.md §2.7; `meta.ble_service_uuid`).
pub const BLE_SERVICE_UUID: &str = generated::BLE_SERVICE_UUID;
/// PT-N25BT BLE read characteristic UUID, lower-case (`meta.ble_read_uuid`).
pub const BLE_READ_UUID: &str = generated::BLE_READ_UUID;
/// PT-N25BT BLE write characteristic UUID, lower-case (`meta.ble_write_uuid`).
pub const BLE_WRITE_UUID: &str = generated::BLE_WRITE_UUID;
/// PT-N25BT BLE write-without-response characteristic UUID, lower-case
/// (`meta.ble_write_no_response_uuid`).
pub const BLE_WRITE_NO_RESPONSE_UUID: &str = generated::BLE_WRITE_NO_RESPONSE_UUID;
/// PT-N25BT BLE notify characteristic UUID, lower-case (`meta.ble_notify_uuid`).
pub const BLE_NOTIFY_UUID: &str = generated::BLE_NOTIFY_UUID;
/// SNMP OID that returns the 32-byte status on network models (PROTOCOL.md §2.9;
/// `meta.snmp_status_oid`).
pub const SNMP_STATUS_OID: &str = generated::SNMP_STATUS_OID;
/// TCP port for raw printing on network models (PROTOCOL.md §2.9).
pub const RAW_TCP_PORT: u16 = 9100;
/// Default SDK command-protocol version when the table omits it (PROTOCOL.md §3.3).
pub const DEFAULT_PROTOCOL_VERSION: u8 = 89;
/// Minimum print-data length used when a model's `min_length_mm` is unknown: 4.8 mm, the
/// largest documented value (PROTOCOL.md §5.6 resolution).
pub const FALLBACK_MIN_LENGTH_MM_X10: u16 = 48;
/// Maximum print length on heat-shrink tube, 0.1 mm: 500 mm on every model with heat-shrink
/// media (PROTOCOL.md §5.6 "Heat-shrink" column; D1/D2/D3/D4 §2.3.4: 3543 dots at 180 dpi).
pub const HEAT_SHRINK_MAX_LENGTH_MM_X10: u32 = 5000;
/// Largest `ESC i d` margin, in inches of feed: the PROTOCOL.md §3.2.4 table gives 900 dots
/// at 180 dpi, 1800 at 360 dpi and 3600 at 720 dpi, i.e. 5 in (127 mm) at every feed
/// resolution [D1 §2.3.3, D2, D4].
const MAX_MARGIN_INCHES: u32 = 5;

// The status framing constants live in `status`; the table's `[meta]` must agree with them.
const _: () = assert!(generated::STATUS_LENGTH == crate::status::STATUS_LEN);
const _: () = {
    let (a, b) = (generated::STATUS_HEADER, crate::status::STATUS_HEADER);
    assert!(a[0] == b[0] && a[1] == b[1] && a[2] == b[2]);
};

/// Converts a length in 0.1 mm to dots at `dpi`, rounded to nearest (half up).
/// `round(mm_x10 × dpi / 254)`; exact integer arithmetic.
const fn mm_x10_to_dots_round(mm_x10: u32, dpi: u16) -> u32 {
    let num = mm_x10 as u64 * dpi as u64;
    ((num + 127) / 254) as u32
}

/// Converts a length in 0.1 mm to dots at `dpi`, rounded down: `floor(mm_x10 × dpi / 254)`.
const fn mm_x10_to_dots_floor(mm_x10: u32, dpi: u16) -> u32 {
    let num = mm_x10 as u64 * dpi as u64;
    (num / 254) as u32
}

/// Every model in `docs/models.toml`, in table order.
///
/// Variant names are the marketing name without `PT-`, in UpperCamelCase
/// (`PT-P710BT` → `PtP710bt`). The generator asserts that the TOML and this enum agree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[non_exhaustive]
#[allow(missing_docs)] // the variant names are the model names
pub enum Model {
    PtP710bt,
    PtP715ebt,
    PtP300bt,
    PtP300btz,
    PtP910bt,
    PtE560bt,
    PtE310bt,
    PtD610bt,
    PtD460bt,
    PtE720bt,
    PtE920bt,
    PtN25bt,
    PtE510,
    PtD410,
    PtE550w,
    PtP750w,
    PtP700,
    PtH500,
    PtE500,
    PtD600,
    PtD450,
    PtP900,
    PtP900w,
    PtP950nw,
    PtD800w,
    PtE800w,
    PtE850tkw,
}

/// How `ESC i z` n9 marks page position (models.toml `page_command`, PROTOCOL.md §3.2.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum PageCommand {
    /// n9 = 0 on the first page, 1 on later pages (PT-P710BT).
    StartEnd,
    /// n9 = 0 first, 1 middle, 2 last; a single-page job sends 2.
    StartNextEnd,
}

/// Raster line compression (`M n`, PROTOCOL.md §5.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum Compression {
    /// `4D 00`: every line is `47 W 00` + W raw bytes; `Z` is not allowed.
    None,
    /// `4D 02`: TIFF PackBits per line; all-zero lines may be `5A`.
    #[default]
    PackBits,
}

/// Cancel sequence after the invalidate run (models.toml `cancel_command`, PROTOCOL.md §6.10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum CancelCommand {
    /// `00×N 1B 40`.
    EscAt,
    /// `00×N 1B 69 18`.
    EscI18,
}

/// Order in which the encoder sends a page's raster lines (PROTOCOL.md §5.3).
///
/// Pages are canvases that read left to right: canvas column 0 is the **left** end of the
/// label when it is read with the text upright, canvas row 0 the top edge. The pin axis is
/// fixed by PROTOCOL.md §5.1 (row `y` → pin `left_margin_pins + y`); this type fixes the feed
/// axis, i.e. which canvas column the printer receives first.
///
/// ```
/// use ptouch::FeedOrder;
/// // A 5-line page: the first raster line sent carries canvas column 4.
/// assert_eq!(FeedOrder::LastColumnFirst.column(0, 5), 4);
/// assert_eq!(FeedOrder::LastColumnFirst.column(4, 5), 0);
/// assert_eq!(FeedOrder::FirstColumnFirst.column(0, 5), 0);
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[non_exhaustive]
pub enum FeedOrder {
    /// The printer prints the first raster line it receives at the **right** end of the label
    /// (where reading ends), so the last canvas column is sent first.
    /// Hardware-verified on PT-P710BT (\[HW\] orientation test label, PT-P710BT, 2026-10-08).
    #[default]
    LastColumnFirst,
    /// The first raster line received prints at the left end: canvas column 0 is sent first.
    /// No PT model is known to behave like this; it exists so that a model found to differ on
    /// hardware can be described without encoder changes.
    FirstColumnFirst,
}

impl FeedOrder {
    /// Canvas column carried by raster line `line` (0 = first sent) of a page of `length`
    /// lines. The mapping is its own inverse: it also gives the raster line of a column.
    /// For `line ≥ length` the result is meaningless but never panics.
    #[must_use]
    pub const fn column(self, line: u32, length: u32) -> u32 {
        match self {
            Self::LastColumnFirst => length.saturating_sub(1).saturating_sub(line),
            Self::FirstColumnFirst => line,
        }
    }
}

/// How to decode the battery byte `st[6]` (models.toml `battery_format`, PROTOCOL.md §4.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum BatteryFormat {
    /// Documented as reserved `00`: always report unknown (use `st[8] & 0x08`).
    Reserved,
    /// `00`–`04`/`FF` legacy encoding (P900 family).
    Legacy,
    /// `2x`/`3x`/`37` level + AC encoding (P910BT, D4 generation).
    LevelAc,
    /// No battery data at all (PT-N25BT).
    None,
}

/// Android SDK RFCOMM socket security (informational, PROTOCOL.md §2.1 "Link security").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum BtSocketSecurity {
    /// Unauthenticated socket.
    Insecure,
    /// Authenticated, encrypted socket.
    Secure,
}

/// Which physical links the model offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[non_exhaustive] // generated from docs/models.toml: new columns must not break users
pub struct Transports {
    /// Bluetooth Classic SPP/RFCOMM.
    pub bluetooth: bool,
    /// Bluetooth Low Energy (PT-N25BT only).
    pub ble: bool,
    /// TCP 9100 (Wi-Fi/Ethernet).
    pub network: bool,
}

/// Feature support flags (models.toml `supports_*`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[non_exhaustive]
pub struct Caps {
    /// Printer accepts `M 02` (PackBits).
    pub compression: bool,
    /// `ESC i M` 0x40 is an automatic full cut.
    pub auto_cut: bool,
    /// `ESC i M` 0x40 prints cut marks (models without a cutter).
    pub cut_mark: bool,
    /// `ESC i A n` accepted (`None` = unknown: do not send).
    pub cut_every: Option<bool>,
    /// Chain printing selectable via `ESC i K` 0x08 (`None` = unknown).
    pub chain: Option<bool>,
    /// `ESC i K` 0x04 half cut.
    pub half_cut: bool,
    /// `ESC i K` 0x10 special tape (no cut); see [`ModelProfile::special_tape_k`].
    pub special_tape: bool,
    /// `ESC i M` 0x80 hardware mirror (otherwise mirror in software).
    pub mirror: bool,
    /// Two-colour printing (false for every PT model).
    pub two_color: bool,
    /// `ESC i K` 0x40 high-resolution feed.
    pub high_resolution: bool,
    /// `ESC i K` 0x01 draft / low-resolution feed.
    pub draft: bool,
    /// Library sends `ESC i ! 00` to get pushed status frames.
    pub status_notify: bool,
}

/// Optional commands the library sends for this model (models.toml `sends_*`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[non_exhaustive]
pub struct Sends {
    /// `ESC i p 01` (protocol gate, PROTOCOL.md §3.3).
    pub stored_up_print: bool,
    /// `ESC i L 00 01 01` + `ESC i C 01 FF FF FF` (protocol gate).
    pub color_info: bool,
    /// `ESC i k c 01 00` (PROTOCOL.md §3.1 rule).
    pub copies_command: bool,
    /// `ESC i a FF` after the last page has completed (PROTOCOL.md §6.10).
    pub mode_reset_at_end: bool,
}

/// One printer model: everything the encoder and session need (one `[[model]]` in the TOML).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[non_exhaustive]
pub struct ModelProfile {
    /// Enum identity.
    pub model: Model,
    /// Marketing name, e.g. `"PT-P710BT"`.
    pub name: &'static str,
    /// Other names, e.g. `["Cube Plus"]`.
    pub aliases: &'static [&'static str],
    /// Status `st[3]` (0x30 for every PT model except PT-N25BT = 0x41).
    pub series_code: u8,
    /// Status `st[4]` (0x76 for PT-P710BT).
    pub model_code: u8,
    /// USB product ID (vendor [`USB_VENDOR_ID`]); `None` for BT-only models or unknown.
    pub usb_pid: Option<u16>,
    /// Available links.
    pub transports: Transports,
    /// Head resolution across the tape (and normal feed resolution), dots per inch.
    pub dpi: u16,
    /// Feed resolution in high-resolution mode, if supported.
    pub high_res_feed_dpi: Option<u16>,
    /// Print-head pins = bits per raster line (64, 128 or 560).
    pub head_pins: u16,
    /// `head_pins / 8`: length of an uncompressed `G` line.
    pub bytes_per_line: u16,
    /// Largest print area among supported media.
    pub max_print_pins: u16,
    /// Widest supported tape, whole mm.
    pub max_tape_mm: u8,
    /// Invalidate length (`00 × null_bytes`).
    pub null_bytes: u16,
    /// Page-position semantics of `ESC i z` n9.
    pub page_command: PageCommand,
    /// SDK command-protocol version (`None` = unknown; use [`ModelProfile::protocol`]).
    pub protocol_version: Option<u8>,
    /// Send `ESC i a 01` before raster data.
    pub needs_mode_switch: bool,
    /// Raster is the power-on mode (`None` = unknown).
    pub raster_is_default: Option<bool>,
    /// What the library sends by default (PROTOCOL.md §5.5).
    pub default_compression: Compression,
    /// Support flags.
    pub caps: Caps,
    /// Full `ESC i K` value for special tape (0x18 on PT-P710BT), if supported.
    pub special_tape_k: Option<u8>,
    /// Optional commands the library sends.
    pub sends: Sends,
    /// Cancel sequence.
    pub cancel_command: CancelCommand,
    /// Android SDK socket security (informational).
    pub bt_socket_security: Option<BtSocketSecurity>,
    /// SPP RFCOMM channel seen on hardware (fallback only; resolve via SDP first).
    pub rfcomm_channel_observed: Option<u8>,
    /// Documented minimum / default `ESC i d` at normal resolution (dots).
    pub min_feed_dots: u16,
    /// Brother minimum print-data length incl. both feed margins, 0.1 mm (`None` = unknown).
    pub min_length_mm_x10: Option<u16>,
    /// P-touch Editor UI minimum, 0.1 mm. Never use it to pad raster data.
    pub editor_min_label_mm_x10: Option<u16>,
    /// Maximum print length, 0.1 mm.
    pub max_length_mm_x10: Option<u32>,
    /// Battery byte decoding (`None` = unknown: report unknown).
    pub battery_format: Option<BatteryFormat>,
    /// Supported media, in table order.
    pub media: &'static [&'static TapeSpec],
    /// Human-readable notes from the TOML (normative behaviour lives in PROTOCOL.md).
    pub quirks: &'static [&'static str],
    /// TOML keys whose value is unknown for this model.
    pub unknown: &'static [&'static str],
}

impl ModelProfile {
    /// Order in which the encoder sends raster lines so that a left-to-right canvas prints
    /// readable (PROTOCOL.md §5.3): [`FeedOrder::LastColumnFirst`] for every PT model.
    ///
    /// Hardware-verified only on PT-P710BT (\[HW\] orientation test label, PT-P710BT). The
    /// other models use the same print mechanism family (head across the tape, tape fed
    /// towards the cutter) and are assumed to match until a hardware test says otherwise; a
    /// model that differs gets its own arm here (or a `models.toml` key) and nothing else
    /// changes: the encoder and the virtual printer both read this value.
    #[must_use]
    pub const fn feed_order(&self) -> FeedOrder {
        FeedOrder::LastColumnFirst
    }

    /// SDK command-protocol version, defaulting to [`DEFAULT_PROTOCOL_VERSION`].
    #[must_use]
    pub fn protocol(&self) -> u8 {
        self.protocol_version.unwrap_or(DEFAULT_PROTOCOL_VERSION)
    }

    /// `true` when the model has a USB interface (a known PID).
    #[must_use]
    pub fn has_usb(&self) -> bool {
        self.usb_pid.is_some()
    }

    /// Feed-direction resolution for the requested mode (dpi; `high_res` doubles it where
    /// supported, PROTOCOL.md §5.4). Returns `None` if high-res is requested but unsupported.
    #[must_use]
    pub fn feed_dpi(&self, high_res: bool) -> Option<u16> {
        if high_res {
            self.high_res_feed_dpi
        } else {
            Some(self.dpi)
        }
    }

    /// Minimum number of raster lines per page for a given `ESC i d` margin (dots, in feed
    /// resolution), per PROTOCOL.md §5.6:
    /// `max(1, round(min_length_mm × feed_dpi / 25.4) − 2 × margin_dots)`, with
    /// [`FALLBACK_MIN_LENGTH_MM_X10`] when `min_length_mm` is unknown.
    ///
    /// Test vectors (PROTOCOL.md §5.6): P710BT margin 14 → 3; E560BT (4.8 mm) margin 14 → 6;
    /// P910BT (4.0 mm @ 360 dpi) margin 14 → 29; margin 0 → 31 / 34 / 57.
    ///
    /// `feed_dpi` is [`ModelProfile::feed_dpi`]; if `high_res` is requested on a model without
    /// high-resolution support, the normal resolution is used (the encoder rejects that
    /// combination separately). `margin_dots` must be in the same feed resolution.
    #[must_use]
    pub fn min_lines(&self, margin_dots: u16, high_res: bool) -> u32 {
        let feed_dpi = self.feed_dpi(high_res).unwrap_or(self.dpi);
        let min_len = self.min_length_mm_x10.unwrap_or(FALLBACK_MIN_LENGTH_MM_X10);
        let total = mm_x10_to_dots_round(u32::from(min_len), feed_dpi);
        total.saturating_sub(2 * u32::from(margin_dots)).max(1)
    }

    /// Maximum number of raster lines per page. `None` when the maximum is unknown.
    ///
    /// At normal resolution this is `floor(max_length_mm × dpi / 25.4)` (7086 for PT-P710BT,
    /// D1 §2.3.4). In high-resolution mode every line is sent twice (PROTOCOL.md §5.4), so the
    /// maximum is the normal value times the feed factor (`high_res_feed_dpi / dpi`): 14172 for
    /// PT-P710BT, which is the D1 "180dpi×360dpi" value, and 28346 for PT-P910BT (D2). For the
    /// D4 models (E560BT family) this is one dot below the D4 table (7087 / 14173), which
    /// rounds instead of truncating; the stricter value is kept.
    ///
    /// As for [`ModelProfile::min_lines`], an unsupported `high_res` falls back to the normal
    /// feed resolution. Media-specific limits are applied by [`ModelProfile::max_lines_for`].
    #[must_use]
    pub fn max_lines(&self, high_res: bool) -> Option<u32> {
        let normal = self
            .max_length_mm_x10
            .map(|max| mm_x10_to_dots_floor(max, self.dpi))?;
        Some(normal.saturating_mul(self.feed_factor(high_res)))
    }

    /// Maximum number of raster lines per page on `tape`: [`ModelProfile::max_lines`], further
    /// capped by the tape's `printable_length_dots` (FLe labels) and, on heat-shrink tube, by
    /// [`HEAT_SHRINK_MAX_LENGTH_MM_X10`] (3543 dots at 180 dpi; PROTOCOL.md §5.6).
    ///
    /// ```
    /// use ptouch::{Model, profile};
    /// let p710 = profile(Model::PtP710bt).ok_or(ptouch::Error::Empty)?;
    /// let hs = ptouch::media_by_id("hs2-128-23.6").ok_or(ptouch::Error::Empty)?;
    /// let tze = ptouch::media_by_id("tze128-24").ok_or(ptouch::Error::Empty)?;
    /// assert_eq!(p710.max_lines_for(hs, false), Some(3543));
    /// assert_eq!(p710.max_lines_for(tze, false), Some(7086));
    /// # Ok::<(), ptouch::Error>(())
    /// ```
    #[must_use]
    pub fn max_lines_for(&self, tape: &TapeSpec, high_res: bool) -> Option<u32> {
        let factor = self.feed_factor(high_res);
        let heat_shrink = tape.kind.is_heat_shrink().then(|| {
            mm_x10_to_dots_floor(HEAT_SHRINK_MAX_LENGTH_MM_X10, self.dpi).saturating_mul(factor)
        });
        [
            self.max_lines(high_res),
            tape.printable_length_dots.map(u32::from),
            heat_shrink,
        ]
        .into_iter()
        .flatten()
        .min()
    }

    /// Largest `ESC i d` feed margin in dots at the feed resolution of the requested mode
    /// (PROTOCOL.md §3.2.4 table): 900 at 180 dpi, 1800 at 360 dpi, 3600 at 720 dpi. As for
    /// [`ModelProfile::min_lines`], an unsupported `high_res` uses the normal resolution.
    #[must_use]
    pub fn max_margin_dots(&self, high_res: bool) -> u32 {
        let feed_dpi = self.feed_dpi(high_res).unwrap_or(self.dpi);
        u32::from(feed_dpi).saturating_mul(MAX_MARGIN_INCHES)
    }

    /// Raster lines sent per normal-resolution line: `high_res_feed_dpi / dpi` (2) in
    /// high-resolution mode where supported, else 1 (PROTOCOL.md §5.4).
    #[must_use]
    pub fn feed_factor(&self, high_res: bool) -> u32 {
        match self.feed_dpi(high_res) {
            Some(feed) if high_res && self.dpi > 0 => {
                (u32::from(feed) / u32::from(self.dpi)).max(1)
            }
            _ => 1,
        }
    }

    /// Finds the media entry for a width byte and kind among this model's media.
    #[must_use]
    pub fn tape(&self, media_width_byte: u8, kind: TapeKind) -> Option<&'static TapeSpec> {
        tape_spec(self, media_width_byte, kind)
    }
}

/// All model profiles, in `docs/models.toml` order.
#[must_use]
pub fn profiles() -> &'static [ModelProfile] {
    generated::PROFILES
}

/// All media entries, in `docs/models.toml` order.
#[must_use]
pub fn all_media() -> &'static [&'static TapeSpec] {
    generated::MEDIA
}

/// The profile for a model. Every [`Model`] variant has one (the generator enforces it), so
/// this returns `None` only for a variant added without regenerating the table.
#[must_use]
pub fn profile(model: Model) -> Option<&'static ModelProfile> {
    profiles().iter().find(|p| p.model == model)
}

/// Looks up a profile by the status bytes `st[3]` (series) and `st[4]` (model).
#[must_use]
pub fn profile_by_codes(series: u8, model: u8) -> Option<&'static ModelProfile> {
    profiles()
        .iter()
        .find(|p| p.series_code == series && p.model_code == model)
}

/// Looks up a profile by USB product ID (vendor [`USB_VENDOR_ID`]).
///
/// Returns the first match in table order; see [`profiles_by_usb_pid`] for the one known
/// collision (`0x2083`: PT-P900 and PT-E850TKW).
#[must_use]
pub fn profile_by_usb_pid(pid: u16) -> Option<&'static ModelProfile> {
    profiles().iter().find(|p| p.usb_pid == Some(pid))
}

/// Looks up a profile by marketing name or alias, case-insensitively (`"pt-p710bt"`,
/// `"Cube Plus"`).
#[must_use]
pub fn profile_by_name(name: &str) -> Option<&'static ModelProfile> {
    let name = name.trim();
    profiles().iter().find(|p| {
        p.name.eq_ignore_ascii_case(name) || p.aliases.iter().any(|a| a.eq_ignore_ascii_case(name))
    })
}

/// Derives the model from a Bluetooth device name (PROTOCOL.md §2.1 "Device identification"):
/// exact name first, then drop the last 4 characters (the per-unit suffix, e.g.
/// `PT-P710BTxxxx`), then a trailing `_` (`PT-E560BT_xxxx`). Only a hint: the authoritative
/// identification is `st[4]` from the first status reply.
///
/// Names are compared case-insensitively against marketing names only (not aliases), after
/// trimming surrounding whitespace.
///
/// ```
/// use ptouch::{Model, profile_by_bt_name};
/// assert_eq!(profile_by_bt_name("PT-P710BTxxxx").map(|p| p.model), Some(Model::PtP710bt));
/// assert_eq!(profile_by_bt_name("PT-E560BT_xxxx").map(|p| p.model), Some(Model::PtE560bt));
/// assert!(profile_by_bt_name("Foo").is_none());
/// ```
#[must_use]
pub fn profile_by_bt_name(device_name: &str) -> Option<&'static ModelProfile> {
    let name = device_name.trim();
    let by_marketing_name = |n: &str| profiles().iter().find(|p| p.name.eq_ignore_ascii_case(n));
    if let Some(p) = by_marketing_name(name) {
        return Some(p);
    }
    // Drop the 4-character per-unit suffix (characters, not bytes: names are user-visible
    // and may contain non-ASCII).
    let cut = name.char_indices().rev().nth(3).map(|(i, _)| i)?;
    let stem = name.get(..cut)?;
    by_marketing_name(stem).or_else(|| by_marketing_name(stem.strip_suffix('_')?))
}

/// Finds the media entry of `profile` with this width byte (`st[10]`, `ESC i z` n3) and kind.
#[must_use]
pub fn tape_spec(
    profile: &ModelProfile,
    media_width_byte: u8,
    kind: TapeKind,
) -> Option<&'static TapeSpec> {
    profile
        .media
        .iter()
        .copied()
        .find(|t| t.media_width_byte == media_width_byte && t.kind == kind)
}

/// Resolves the geometry for the loaded media from raw status bytes (PROTOCOL.md §4.6.1
/// resolution): `st[11]` ∈ {`11`, `13`, `17`} selects the HS 2:1 / FLe / HS 3:1 table,
/// `16` (self-laminating) tries the SL entry first and then TZe, every other non-zero value
/// uses TZe. `0x14` is never rejected.
///
/// # Errors
/// [`Error::NoMedia`] for `st[11]` ∈ {`00`, `FF`}; [`Error::UnsupportedMedia`] when the model
/// has no entry for the width/kind.
///
/// `st[11] = 12` (tube, PT-E850TKW) is out of scope and reported as
/// [`Error::UnsupportedMedia`].
///
/// ```
/// use ptouch::{Model, profile, tape_for_status};
/// let p710 = profile(Model::PtP710bt).ok_or(ptouch::Error::Empty)?;
/// // The real PT-P710BT status: st[10] = 0x18 (24 mm), st[11] = 0x01 (laminated).
/// assert_eq!(tape_for_status(p710, 0x18, 0x01)?.id, "tze128-24");
/// # Ok::<(), ptouch::Error>(())
/// ```
pub fn tape_for_status(
    profile: &ModelProfile,
    media_width_byte: u8,
    media_type_byte: u8,
) -> Result<&'static TapeSpec, Error> {
    let unsupported = Error::UnsupportedMedia {
        width_mm: media_width_byte,
        media_type: media_type_byte,
    };
    if matches!(media_type_byte, 0x00 | 0xFF) {
        return Err(Error::NoMedia);
    }
    let kind = TapeKind::from_status_media_type(media_type_byte).ok_or(unsupported.clone())?;
    let found = match kind {
        // Self-laminating: a dedicated SL entry if the model has one, else TZe geometry
        // (the SDK maps status 0x16 to paper type 1).
        TapeKind::Sl => tape_spec(profile, media_width_byte, TapeKind::Sl)
            .or_else(|| tape_spec(profile, media_width_byte, TapeKind::Tze)),
        kind => tape_spec(profile, media_width_byte, kind),
    };
    found.ok_or(unsupported)
}

/// All profiles that use a USB product ID, in table order.
///
/// Unlike [`profile_by_usb_pid`] this exposes PID collisions: `0x2083` is documented for both
/// PT-P900 (Brother raster reference D2) and PT-E850TKW (SDK spec DB), see the models.toml quirks; disambiguate with `st[4]`.
pub fn profiles_by_usb_pid(pid: u16) -> impl Iterator<Item = &'static ModelProfile> {
    profiles().iter().filter(move |p| p.usb_pid == Some(pid))
}

/// Looks up a media entry by its stable id (e.g. `"tze128-24"`).
#[must_use]
pub fn media_by_id(id: &str) -> Option<&'static TapeSpec> {
    all_media().iter().copied().find(|t| t.id == id)
}

/// Looks up a media entry by head geometry, kind and width byte, independent of a model
/// (e.g. `(Geometry::Pt560, TapeKind::Tze, 24)` → `tze560-24`).
#[must_use]
pub fn media_for_geometry(
    geometry: Geometry,
    kind: TapeKind,
    media_width_byte: u8,
) -> Option<&'static TapeSpec> {
    all_media().iter().copied().find(|t| {
        t.geometry == geometry && t.kind == kind && t.media_width_byte == media_width_byte
    })
}

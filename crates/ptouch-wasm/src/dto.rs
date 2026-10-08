//! Data transfer objects that cross the JS boundary as tsify `Ts<T>`.
//!
//! These are the **TypeScript-facing shapes** (generated into `ptouch.d.ts`). They mirror core
//! types without depending on the core's optional `serde` feature, so the wire format is owned
//! here and stays stable even if core types gain fields. Conventions: camelCase fields,
//! kebab-case string enums, `Option` fields are optional properties (`field?: T`).
//!
//! The pure `From`/conversion functions (core → DTO) are plain Rust and unit-testable natively;
//! only the `Ts` wrapping touches JS.

use serde::{Deserialize, Serialize};
use tsify::Tsify;

// ---------------------------------------------------------------------------------------------
// Models and media
// ---------------------------------------------------------------------------------------------

/// Tape family (core `TapeKind`).
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TapeKind {
    /// TZe laminated / non-laminated and TZe-geometry variants.
    #[default]
    Tze,
    /// Heat-shrink tube 2:1.
    Hs2,
    /// Heat-shrink tube 3:1.
    Hs3,
    /// Self-laminating.
    Sl,
    /// FLe die-cut labels.
    Fle,
}

/// One media entry of a model (core `TapeSpec`).
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    /// Stable id, e.g. `"tze128-24"`.
    pub id: String,
    /// Tape family.
    pub kind: TapeKind,
    /// Nominal width in mm for display and `LabelDoc.tape.widthMm` (3.5, 6, 9, 12, 18, 24…).
    pub width_mm: f64,
    /// Width byte as reported in `st[10]` / sent in `ESC i z` (3.5 mm → 4).
    pub width_byte: u8,
    /// Printable pins across the tape = bitmap height in dots.
    pub print_pins: u16,
    /// Unprinted pins on the left/top of the head.
    pub left_margin_pins: u16,
    /// Unprinted pins on the right/bottom of the head.
    pub right_margin_pins: u16,
    /// Physical tape width in dots (for drawing tape edges around the printable band).
    pub tape_width_dots: u16,
    /// Default `ESC i d` feed margin in dots.
    pub default_feed_dots: u16,
    /// Fixed label length in mm for die-cut media; absent for continuous tape.
    #[tsify(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length_mm: Option<u8>,
}

/// Capabilities relevant to the studio UI (subset of core `Caps`).
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelCaps {
    /// Has a full cutter.
    pub auto_cut: bool,
    /// Supports chain printing.
    pub chain: bool,
    /// Supports half cut.
    pub half_cut: bool,
    /// Hardware mirror (otherwise the core mirrors in software).
    pub mirror: bool,
    /// 180×360 high-resolution feed.
    pub high_resolution: bool,
    /// Pushes status frames after `ESC i ! 00`.
    pub status_notify: bool,
}

/// One printer model (core `ModelProfile`).
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// Marketing name, e.g. `"PT-P710BT"`.
    pub name: String,
    /// Other accepted names.
    pub aliases: Vec<String>,
    /// `st[3]`.
    pub series_code: u8,
    /// `st[4]`.
    pub model_code: u8,
    /// USB product id (vendor 0x04F9), if the model has USB.
    #[tsify(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usb_pid: Option<u16>,
    /// Head (and normal feed) resolution.
    pub dpi: u16,
    /// Head pins.
    pub head_pins: u16,
    /// Bluetooth Classic (SPP) available.
    pub bluetooth: bool,
    /// Capabilities.
    pub caps: ModelCaps,
    /// Supported media.
    pub media: Vec<MediaInfo>,
}

/// Geometry the renderer needs for one (model, media) pair.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrintArea {
    /// Model name.
    pub model: String,
    /// Media id.
    pub media_id: String,
    /// Feed (length) resolution in dots per inch (normal resolution).
    pub dpi: u16,
    /// Bitmap height in dots (= `MediaInfo.printPins`).
    pub height_dots: u16,
    /// Physical tape width in dots.
    pub tape_width_dots: u16,
    /// Pins left/right of the printable band.
    pub left_margin_pins: u16,
    /// Pins left/right of the printable band.
    pub right_margin_pins: u16,
    /// Minimum page length in raster lines with the default feed margin (shorter pages are
    /// padded by the encoder).
    pub min_length_dots: u32,
    /// Maximum page length in raster lines, if limited.
    #[tsify(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length_dots: Option<u32>,
    /// Default feed margin (`ESC i d`) in dots, applied at both ends by the printer.
    pub default_feed_dots: u16,
    /// Largest accepted feed margin in dots.
    pub max_feed_dots: u32,
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

/// `st[18]` status type.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StatusType {
    /// `00`.
    Reply,
    /// `01`.
    PrintingCompleted,
    /// `02`.
    Error,
    /// `03`.
    ExitIfMode,
    /// `04`.
    TurnedOff,
    /// `05`.
    Notification,
    /// `06`.
    PhaseChange,
    /// Anything else (raw byte in `PrinterStatus.raw[18]`).
    Other,
}

/// `st[22]` notification.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationKind {
    /// `00`.
    None,
    /// `01`.
    CoverOpen,
    /// `02`.
    CoverClosed,
    /// `03`.
    CoolingStarted,
    /// `04`.
    CoolingFinished,
    /// `05`.
    WaitingForPeeling,
    /// `07`.
    Paused,
    /// `0B`.
    WaitingForCut,
    /// `0C`.
    CutWaitFinished,
    /// Anything else.
    Other,
}

/// `st[19..22]` phase.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PhaseInfo {
    /// `"receiving"` (editing/ready) or `"printing"`.
    pub kind: PhaseKind,
    /// Phase number (`st[20..22]`, big-endian).
    pub number: u16,
}

/// Phase type.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PhaseKind {
    /// Receiving / editing state.
    Receiving,
    /// Printing state.
    Printing,
    /// Any other phase-type byte (`st[19]`, raw value in `PrinterStatus.raw[19]`).
    Other,
}

/// One decoded printer error.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrinterErrorInfo {
    /// Stable kebab-case id, e.g. `"no-media"`, `"cover-open"`, `"cutter-jam"`,
    /// `"weak-batteries"`, `"overheating"`, `"wrong-media"`, `"extended"`.
    pub id: String,
    /// English message from the core (`PrinterError::message`); the UI maps `id` to its own
    /// actionable hint text.
    pub message: String,
}

/// Tape or ink colour.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColorInfo {
    /// Raw byte (`st[24]` / `st[25]`).
    pub byte: u8,
    /// Human name, e.g. `"white"`, `"black"`.
    pub name: String,
    /// CSS colour for the preview tint, e.g. `"#ffffff"`.
    pub css: String,
}

/// Decoded battery information.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BatteryInfo {
    /// `"battery"`, `"ac"` or absent when unknown.
    #[tsify(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// 0–100 when known.
    #[tsify(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    /// Weak-battery error bit set.
    pub weak: bool,
}

/// A decoded 32-byte status frame (core `Status`) plus convenience predicates.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrinterStatus {
    /// Model name if (series, model) is known.
    #[tsify(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    /// `st[3]`.
    pub series_code: u8,
    /// `st[4]`.
    pub model_code: u8,
    /// `Status::is_ready()`.
    pub ready: bool,
    /// `Status::is_error()`.
    pub error: bool,
    /// `Status::is_turned_off()`.
    pub turned_off: bool,
    /// Every set error bit.
    pub errors: Vec<PrinterErrorInfo>,
    /// `st[10]` width byte (3.5 mm reports 4).
    pub media_width_mm: u8,
    /// `st[11]` raw media type.
    pub media_type_byte: u8,
    /// Media type name (core `MediaType::name`, except `"none"` when no cassette is loaded),
    /// e.g. `"laminated"`, `"non-laminated"`, `"heat-shrink tube 2:1"`, `"none"`.
    pub media_type: String,
    /// Resolved media id for the model (`tape_for_status`), when model and media are known.
    #[tsify(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_id: Option<String>,
    /// `st[17]` (0 = continuous).
    pub media_length_mm: u8,
    /// `st[18]`.
    pub status_type: StatusType,
    /// `st[19..22]`.
    pub phase: PhaseInfo,
    /// `st[22]`.
    pub notification: NotificationKind,
    /// `st[24]`.
    pub tape_color: ColorInfo,
    /// `st[25]`.
    pub text_color: ColorInfo,
    /// Battery.
    pub battery: BatteryInfo,
    /// The 32 raw bytes.
    pub raw: Vec<u8>,
}

// ---------------------------------------------------------------------------------------------
// Rendering inputs
// ---------------------------------------------------------------------------------------------

/// QR error-correction level.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum QrEcc {
    /// ~7 %.
    L,
    /// ~15 % (default).
    #[default]
    M,
    /// ~25 %.
    Q,
    /// ~30 %.
    H,
}

/// What to encode with `encodeCode`.
///
/// Deserialized through the flat [`CodeSpecWire`] (a derived internally-tagged `Deserialize`
/// costs ~14 KB of wasm); the TS type is still the tagged union.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(
    tag = "symbology",
    rename_all = "kebab-case",
    try_from = "CodeSpecWire"
)]
pub enum CodeSpec {
    /// QR code (UTF-8; fast_qr picks the most compact mode, which decodes to the same text).
    Qr {
        /// Payload.
        data: String,
        /// Error correction (default `"M"`).
        #[tsify(optional)]
        #[serde(default)]
        ecc: Option<QrEcc>,
    },
    /// Code 128 (auto code set).
    Code128 {
        /// Payload (ASCII).
        data: String,
    },
    /// EAN-13 (12 digits, check digit computed; or 13 digits, check digit verified).
    Ean13 {
        /// Digits.
        data: String,
    },
}

/// Symbology tag of [`CodeSpec`].
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Symbology {
    /// QR.
    Qr,
    /// Code 128.
    Code128,
    /// EAN-13.
    Ean13,
}

/// Wire form of [`CodeSpec`] (flat struct; cheap to deserialize).
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct CodeSpecWire {
    /// Tag.
    pub symbology: Symbology,
    /// Payload.
    pub data: String,
    /// QR only.
    #[serde(default)]
    pub ecc: Option<QrEcc>,
}

impl From<CodeSpecWire> for CodeSpec {
    fn from(w: CodeSpecWire) -> Self {
        match w.symbology {
            Symbology::Qr => Self::Qr {
                data: w.data,
                ecc: w.ecc,
            },
            Symbology::Code128 => Self::Code128 { data: w.data },
            Symbology::Ean13 => Self::Ean13 { data: w.data },
        }
    }
}

/// Module matrix (row-major 0/1), linear codes have `height == 1`.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleMatrix {
    /// Modules per row.
    pub width: u32,
    /// Rows (1 for linear symbologies).
    pub height: u32,
    /// `width × height` entries, 1 = dark.
    pub modules: Vec<u8>,
}

/// Dither method for photos.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum DitherKind {
    /// Threshold at `ToneOptions.level` (default 128).
    #[default]
    Threshold,
    /// Floyd–Steinberg.
    FloydSteinberg,
    /// Atkinson.
    Atkinson,
    /// Bayer 4×4.
    Bayer4,
    /// Bayer 8×8.
    Bayer8,
}

/// Options for `Raster.blitTone` (core `Dither` + `ToneAdjust`). All fields optional.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ToneOptions {
    /// Method (default threshold).
    #[tsify(optional)]
    pub dither: Option<DitherKind>,
    /// Threshold level 0–255 (default 128; threshold only).
    #[tsify(optional)]
    pub level: Option<u8>,
    /// −100…100.
    #[tsify(optional)]
    pub brightness: Option<i8>,
    /// −100…100.
    #[tsify(optional)]
    pub contrast: Option<i8>,
    /// Gamma × 100 (100 = linear).
    #[tsify(optional)]
    pub gamma_x100: Option<u16>,
    /// Invert.
    #[tsify(optional)]
    pub invert: Option<bool>,
}

// ---------------------------------------------------------------------------------------------
// Job encoding
// ---------------------------------------------------------------------------------------------

/// Cut behaviour.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CutMode {
    /// Full cut after every label (default).
    #[default]
    EveryLabel,
    /// Half cut between labels (half-cut models only).
    HalfCut,
    /// No cut.
    None,
}

/// Options for `encodeJob` (core `JobOptions`). All fields optional; defaults = core defaults.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct JobOptions {
    /// Cut behaviour (default `"every-label"`).
    #[tsify(optional)]
    pub cut: Option<CutMode>,
    /// Mirror (hardware or software).
    #[tsify(optional)]
    pub mirror: Option<bool>,
    /// Chain printing (last label stays in the printer).
    #[tsify(optional)]
    pub chain: Option<bool>,
    /// High-resolution feed (180×360 dpi). Pages are passed at **normal** resolution; the core
    /// (`prepare_pages`) doubles every line. `feedMarginDots` is then in 360-dpi dots.
    #[tsify(optional)]
    pub high_resolution: Option<bool>,
    /// `ESC i d` feed margin in dots (default: the tape's default).
    #[tsify(optional)]
    pub feed_margin_dots: Option<u16>,
    /// PackBits compression (default: model default).
    #[tsify(optional)]
    pub compress: Option<bool>,
    /// `ESC i ! 00` (default true; needed for completion pushes over Bluetooth).
    #[tsify(optional)]
    pub auto_status: Option<bool>,
    /// Pad short pages to the model minimum (default true).
    #[tsify(optional)]
    pub pad_short_pages: Option<bool>,
    /// Repeat the page list this many times (default 1, 1–999). Copies share one job, so the
    /// tape leader is fed once. Equivalent to repeating the pages yourself, without clones.
    #[tsify(optional)]
    pub copies: Option<u16>,
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

/// Session timing (core `SessionConfig`); every field optional, defaults = core defaults.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionConfig {
    /// Status reply wait per handshake attempt (5000).
    #[tsify(optional)]
    pub status_timeout_ms: Option<f64>,
    /// Handshake attempts (3).
    #[tsify(optional)]
    pub status_attempts: Option<u8>,
    /// Drain after `ESC i a 01` (100).
    #[tsify(optional)]
    pub mode_switch_drain_ms: Option<f64>,
    /// Page time estimate base (2500).
    #[tsify(optional)]
    pub page_time_base_ms: Option<f64>,
    /// Page time estimate per raster line (10).
    #[tsify(optional)]
    pub page_time_per_line_ms: Option<f64>,
    /// Silence tolerated after the estimate (30000).
    #[tsify(optional)]
    pub page_margin_ms: Option<f64>,
    /// Poll interval for non-push models (10000).
    #[tsify(optional)]
    pub poll_interval_ms: Option<f64>,
    /// Swallow trailing frames after a job (500).
    #[tsify(optional)]
    pub post_job_drain_ms: Option<f64>,
    /// Poll ticks without completion before giving up on non-push models (180).
    #[tsify(optional)]
    pub max_ticks: Option<u16>,
    /// Wait for the trailing phase-change frame after "printing completed" (2000).
    #[tsify(optional)]
    pub phase_frame_wait_ms: Option<f64>,
}

/// Coarse session state (core `SessionState`).
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum SessionState {
    /// Not connected.
    Idle,
    /// Waking the printer.
    Handshaking {
        /// 1-based attempt.
        attempt: u8,
    },
    /// Ready for a job.
    Ready,
    /// Printing.
    Printing {
        /// 1-based page.
        page: u16,
        /// Total pages.
        of: u16,
    },
    /// Swallowing trailing frames after a job.
    Draining,
    /// Cancel / error recovery in progress.
    Recovering,
    /// Needs a new `connect()`.
    Failed,
}

/// Error payload of a `failed` event.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorInfo {
    /// `PtouchErrorCode`.
    pub code: String,
    /// Core `Display` text.
    pub message: String,
    /// For `PRINTER` errors: the decoded printer errors.
    pub printer_errors: Vec<PrinterErrorInfo>,
    /// For `TIMEOUT` errors: what timed out (`"handshake"` = the printer never answered).
    #[tsify(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<TimeoutKind>,
}

/// What timed out (core `TimeoutKind`).
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TimeoutKind {
    /// No valid status reply during the handshake (asleep, wrong port, dead OS port).
    Handshake,
    /// No reply to an explicit status request.
    Status,
    /// A page never completed.
    Page,
}

/// Session event (core `Event`).
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SessionEvent {
    /// Every parsed status frame.
    Status {
        /// The frame.
        status: PrinterStatus,
    },
    /// Handshake done / recovered: model and media known.
    Ready {
        /// The frame.
        status: PrinterStatus,
    },
    /// Page started printing.
    PageStarted {
        /// 1-based page.
        page: u16,
    },
    /// Page completed.
    PageCompleted {
        /// 1-based page.
        page: u16,
    },
    /// All pages completed.
    JobCompleted,
    /// Notification frame.
    Notification {
        /// Which.
        notification: NotificationKind,
    },
    /// Handshake / job / status request failed (or cancelled: code `CANCELLED`).
    Failed {
        /// Why.
        error: ErrorInfo,
        /// For job errors: 1-based page to resume from.
        #[tsify(optional)]
        #[serde(
            rename = "resumeFromPage",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        resume_from_page: Option<u16>,
    },
}

// ---------------------------------------------------------------------------------------------
// Virtual printer
// ---------------------------------------------------------------------------------------------

/// Scripted virtual-printer behaviour (core `Behaviour`). Deserialized through the flat
/// [`VirtualBehaviourWire`] (see [`CodeSpec`]).
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    try_from = "VirtualBehaviourWire"
)]
pub enum VirtualBehaviour {
    /// Healthy printer.
    #[default]
    Normal,
    /// Never answers (asleep / dead port).
    Silent,
    /// Answers status requests but never pushes progress.
    NoPush,
    /// Cover opens while printing `page`.
    CoverOpenOnPage {
        /// 1-based page.
        page: u16,
    },
    /// Rejects every job with wrong-media.
    WrongMedia,
    /// `count` extra phase frames after each completion.
    ExtraFrames {
        /// Extra frames.
        count: u8,
    },
    /// Cooling pause during `page`.
    CoolingOnPage {
        /// 1-based page.
        page: u16,
    },
    /// No cassette loaded.
    NoMedia,
}

/// Tag of [`VirtualBehaviour`].
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BehaviourKind {
    /// See [`VirtualBehaviour::Normal`].
    Normal,
    /// See [`VirtualBehaviour::Silent`].
    Silent,
    /// See [`VirtualBehaviour::NoPush`].
    NoPush,
    /// See [`VirtualBehaviour::CoverOpenOnPage`].
    CoverOpenOnPage,
    /// See [`VirtualBehaviour::WrongMedia`].
    WrongMedia,
    /// See [`VirtualBehaviour::ExtraFrames`].
    ExtraFrames,
    /// See [`VirtualBehaviour::CoolingOnPage`].
    CoolingOnPage,
    /// See [`VirtualBehaviour::NoMedia`].
    NoMedia,
}

/// Wire form of [`VirtualBehaviour`].
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub struct VirtualBehaviourWire {
    /// Tag.
    pub kind: BehaviourKind,
    /// `cover-open-on-page` / `cooling-on-page`.
    #[serde(default)]
    pub page: Option<u16>,
    /// `extra-frames`.
    #[serde(default)]
    pub count: Option<u8>,
}

impl TryFrom<VirtualBehaviourWire> for VirtualBehaviour {
    type Error = &'static str;

    fn try_from(w: VirtualBehaviourWire) -> Result<Self, &'static str> {
        let page = || w.page.ok_or("missing field `page`");
        Ok(match w.kind {
            BehaviourKind::Normal => Self::Normal,
            BehaviourKind::Silent => Self::Silent,
            BehaviourKind::NoPush => Self::NoPush,
            BehaviourKind::CoverOpenOnPage => Self::CoverOpenOnPage { page: page()? },
            BehaviourKind::WrongMedia => Self::WrongMedia,
            BehaviourKind::ExtraFrames => Self::ExtraFrames {
                count: w.count.ok_or("missing field `count`")?,
            },
            BehaviourKind::CoolingOnPage => Self::CoolingOnPage { page: page()? },
            BehaviourKind::NoMedia => Self::NoMedia,
        })
    }
}

/// Virtual printer timing (core `VirtualTiming`); every field optional.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VirtualTiming {
    /// Status reply delay (20).
    #[tsify(optional)]
    pub reply_delay_ms: Option<f64>,
    /// Delay to "printing" phase (50).
    #[tsify(optional)]
    pub start_delay_ms: Option<f64>,
    /// Base print time per page (500).
    #[tsify(optional)]
    pub base_print_ms: Option<f64>,
    /// Print time per raster line (5).
    #[tsify(optional)]
    pub per_line_ms: Option<f64>,
    /// Completed → receiving delay (30).
    #[tsify(optional)]
    pub phase_delay_ms: Option<f64>,
    /// Cooling pause (60000).
    #[tsify(optional)]
    pub cooling_ms: Option<f64>,
}

//! Core ↔ DTO conversions as plain Rust (no JS), so they are unit-testable natively
//! (`cargo test -p ptouch-wasm`). The `#[wasm_bindgen]` wrappers only add `Ts` (de)serialization
//! and error-to-JS mapping on top of these.

use ptouch::encode::CutMode as CoreCutMode;
use ptouch::status::{Battery, PowerSource};
use ptouch::{
    Compression, Dither, Event, MediaType, ModelProfile, Notification, Phase, PrinterError, Status,
    StatusType as CoreStatusType, TapeSpec, TimeoutKind as CoreTimeoutKind, ToneAdjust,
};

use crate::dto;
use crate::error::BindError;
use crate::session::ms;

// ---------------------------------------------------------------------------------------------
// Models and media
// ---------------------------------------------------------------------------------------------

/// Core tape kind → DTO.
#[must_use]
pub fn tape_kind_dto(k: ptouch::TapeKind) -> dto::TapeKind {
    match k {
        ptouch::TapeKind::Tze => dto::TapeKind::Tze,
        ptouch::TapeKind::Hs2 => dto::TapeKind::Hs2,
        ptouch::TapeKind::Hs3 => dto::TapeKind::Hs3,
        ptouch::TapeKind::Sl => dto::TapeKind::Sl,
        ptouch::TapeKind::Fle => dto::TapeKind::Fle,
    }
}

/// DTO tape kind → core.
#[must_use]
pub fn tape_kind_core(k: dto::TapeKind) -> ptouch::TapeKind {
    match k {
        dto::TapeKind::Tze => ptouch::TapeKind::Tze,
        dto::TapeKind::Hs2 => ptouch::TapeKind::Hs2,
        dto::TapeKind::Hs3 => ptouch::TapeKind::Hs3,
        dto::TapeKind::Sl => ptouch::TapeKind::Sl,
        dto::TapeKind::Fle => ptouch::TapeKind::Fle,
    }
}

/// Core `TapeSpec` → [`dto::MediaInfo`].
#[must_use]
pub fn media_dto(t: &TapeSpec) -> dto::MediaInfo {
    dto::MediaInfo {
        id: t.id.to_owned(),
        kind: tape_kind_dto(t.kind),
        width_mm: f64::from(t.width_mm_x10) / 10.0,
        width_byte: t.media_width_byte,
        print_pins: t.print_pins,
        left_margin_pins: t.left_margin_pins,
        right_margin_pins: t.right_margin_pins,
        tape_width_dots: t.tape_width_dots,
        default_feed_dots: t.default_feed_dots,
        length_mm: t.length_mm,
    }
}

/// Core `ModelProfile` → [`dto::ModelInfo`].
#[must_use]
pub fn model_dto(p: &ModelProfile) -> dto::ModelInfo {
    dto::ModelInfo {
        name: p.name.to_owned(),
        aliases: p.aliases.iter().map(|a| (*a).to_owned()).collect(),
        series_code: p.series_code,
        model_code: p.model_code,
        usb_pid: p.usb_pid,
        dpi: p.dpi,
        head_pins: p.head_pins,
        bluetooth: p.transports.bluetooth,
        caps: dto::ModelCaps {
            auto_cut: p.caps.auto_cut,
            chain: p.caps.chain.unwrap_or(false),
            half_cut: p.caps.half_cut,
            mirror: p.caps.mirror,
            high_resolution: p.caps.high_resolution,
            status_notify: p.caps.status_notify,
        },
        media: p.media.iter().map(|t| media_dto(t)).collect(),
    }
}

/// Renderer geometry for (`p`, `t`) at normal resolution with the tape's default feed margin.
#[must_use]
pub fn print_area_dto(p: &ModelProfile, t: &TapeSpec) -> dto::PrintArea {
    dto::PrintArea {
        model: p.name.to_owned(),
        media_id: t.id.to_owned(),
        dpi: p.dpi,
        height_dots: t.print_pins,
        tape_width_dots: t.tape_width_dots,
        left_margin_pins: t.left_margin_pins,
        right_margin_pins: t.right_margin_pins,
        min_length_dots: p.min_lines(t.default_feed_dots, false),
        max_length_dots: p.max_lines_for(t, false),
        default_feed_dots: t.default_feed_dots,
        max_feed_dots: p.max_margin_dots(false),
    }
}

/// Model by marketing name or alias (case-insensitive).
///
/// # Errors
/// `UNKNOWN_MODEL`.
pub fn resolve_model(name: &str) -> Result<&'static ModelProfile, BindError> {
    ptouch::profile_by_name(name).ok_or_else(|| BindError::unknown_model(name))
}

/// Media entry `id` of model `p` (must be in the model's media list).
///
/// # Errors
/// `UNSUPPORTED_MEDIA`.
pub fn resolve_media(p: &ModelProfile, id: &str) -> Result<&'static TapeSpec, BindError> {
    p.media
        .iter()
        .copied()
        .find(|t| t.id == id)
        .ok_or_else(|| BindError::unsupported_media(p.name, &format!("\"{id}\"")))
}

/// Nominal width in mm → status/`ESC i z` width byte (3.5 mm → 4; others rounded).
///
/// # Errors
/// `INVALID_INPUT` for NaN, ≤ 0 or > 255.
pub fn width_byte_for_mm(width_mm: f64) -> Result<u8, BindError> {
    if !width_mm.is_finite() || width_mm <= 0.0 || width_mm > 255.0 {
        return Err(BindError::invalid("tape width is out of range"));
    }
    if (width_mm - 3.5).abs() < 0.05 {
        return Ok(4);
    }
    // In range 0 < w ≤ 255 checked above.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let b = width_mm.round() as u8;
    Ok(b)
}

/// Media of `p` for a nominal width and kind (default TZe).
///
/// # Errors
/// `INVALID_INPUT` (bad width), `UNSUPPORTED_MEDIA`.
pub fn media_for_width_mm(
    p: &ModelProfile,
    width_mm: f64,
    kind: Option<dto::TapeKind>,
) -> Result<&'static TapeSpec, BindError> {
    let byte = width_byte_for_mm(width_mm)?;
    let kind = tape_kind_core(kind.unwrap_or_default());
    // Integer formatting only: f64 `Display` pulls ~13 KB of float printing into the wasm.
    p.tape(byte, kind).ok_or_else(|| {
        BindError::unsupported_media(p.name, &format!("width byte {byte} ({kind:?})"))
    })
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

/// Stable kebab-case id of a printer error bit (the UI maps ids to its own hint text).
#[must_use]
pub fn printer_error_id(e: PrinterError) -> &'static str {
    match e {
        PrinterError::NoMedia => "no-media",
        PrinterError::EndOfMedia => "end-of-media",
        PrinterError::CutterJam => "cutter-jam",
        PrinterError::WeakBatteries => "weak-batteries",
        PrinterError::PrinterInUse => "printer-in-use",
        PrinterError::PowerTurnedOff => "power-turned-off",
        PrinterError::HighVoltageAdapter => "high-voltage-adapter",
        PrinterError::SystemErrorInfo1 | PrinterError::SystemErrorInfo2 => "system-error",
        PrinterError::WrongMedia => "wrong-media",
        PrinterError::ExpansionBufferFull => "expansion-buffer-full",
        PrinterError::CommunicationError => "communication-error",
        PrinterError::CommunicationBufferFull => "communication-buffer-full",
        PrinterError::CoverOpen => "cover-open",
        PrinterError::Overheating => "overheating",
        PrinterError::BlackMarkNotDetected => "black-mark-not-detected",
        PrinterError::Extended(_) => "extended",
    }
}

/// Every set error bit of `errors` as DTOs.
#[must_use]
pub fn printer_errors_dto(errors: ptouch::PrinterErrors) -> Vec<dto::PrinterErrorInfo> {
    errors
        .iter()
        .map(|e| dto::PrinterErrorInfo {
            id: printer_error_id(e).to_owned(),
            message: e.to_string(),
        })
        .collect()
}

fn status_type_dto(t: CoreStatusType) -> dto::StatusType {
    match t {
        CoreStatusType::Reply => dto::StatusType::Reply,
        CoreStatusType::PrintingCompleted => dto::StatusType::PrintingCompleted,
        CoreStatusType::Error => dto::StatusType::Error,
        CoreStatusType::ExitIfMode => dto::StatusType::ExitIfMode,
        CoreStatusType::TurnedOff => dto::StatusType::TurnedOff,
        CoreStatusType::Notification => dto::StatusType::Notification,
        CoreStatusType::PhaseChange => dto::StatusType::PhaseChange,
        CoreStatusType::Other(_) => dto::StatusType::Other,
    }
}

/// Core notification → DTO.
#[must_use]
pub fn notification_dto(n: Notification) -> dto::NotificationKind {
    match n {
        Notification::None => dto::NotificationKind::None,
        Notification::CoverOpen => dto::NotificationKind::CoverOpen,
        Notification::CoverClosed => dto::NotificationKind::CoverClosed,
        Notification::CoolingStarted => dto::NotificationKind::CoolingStarted,
        Notification::CoolingFinished => dto::NotificationKind::CoolingFinished,
        Notification::WaitingForPeeling => dto::NotificationKind::WaitingForPeeling,
        Notification::Paused => dto::NotificationKind::Paused,
        Notification::WaitingForCut => dto::NotificationKind::WaitingForCut,
        Notification::CutWaitFinished => dto::NotificationKind::CutWaitFinished,
        Notification::Other(_) => dto::NotificationKind::Other,
    }
}

fn phase_dto(p: Phase) -> dto::PhaseInfo {
    let (kind, number) = match p {
        Phase::Receiving(n) => (dto::PhaseKind::Receiving, n),
        Phase::Printing(n) => (dto::PhaseKind::Printing, n),
        Phase::Other { number, .. } => (dto::PhaseKind::Other, number),
    };
    dto::PhaseInfo { kind, number }
}

fn battery_dto(s: &Status, profile: Option<&ModelProfile>) -> dto::BatteryInfo {
    let source = |src: PowerSource| {
        Some(
            match src {
                PowerSource::Battery => "battery",
                PowerSource::Ac => "ac",
            }
            .to_owned(),
        )
    };
    let (src, percent) = match s.battery(profile.and_then(|p| p.battery_format)) {
        Battery::Unknown => (None, None),
        Battery::Level {
            source: src,
            percent,
        } => (source(src), percent),
        Battery::NoBattery { source: src } => (source(src), None),
    };
    dto::BatteryInfo {
        source: src,
        percent,
        weak: s.weak_battery(),
    }
}

/// Core `Status` → [`dto::PrinterStatus`] (model and media resolved where known).
#[must_use]
pub fn status_dto(s: &Status) -> dto::PrinterStatus {
    let profile = ptouch::profile_by_codes(s.series_code, s.model_code);
    let media_id = profile
        .and_then(|p| ptouch::tape_for_status(p, s.media_width_mm, s.media_type.to_byte()).ok())
        .map(|t| t.id.to_owned());
    let media_type = match s.media_type {
        MediaType::None => "none",
        other => other.name(),
    };
    dto::PrinterStatus {
        model_name: profile.map(|p| p.name.to_owned()),
        series_code: s.series_code,
        model_code: s.model_code,
        ready: s.is_ready(),
        error: s.is_error(),
        turned_off: s.is_turned_off(),
        errors: printer_errors_dto(s.errors),
        media_width_mm: s.media_width_mm,
        media_type_byte: s.media_type.to_byte(),
        media_type: media_type.to_owned(),
        media_id,
        media_length_mm: s.media_length_mm,
        status_type: status_type_dto(s.status_type),
        phase: phase_dto(s.phase),
        notification: notification_dto(s.notification),
        tape_color: dto::ColorInfo {
            byte: s.tape_color.to_byte(),
            name: s.tape_color.name().to_owned(),
            css: s.tape_color.css().to_owned(),
        },
        text_color: dto::ColorInfo {
            byte: s.text_color.to_byte(),
            name: s.text_color.name().to_owned(),
            css: s.text_color.css().to_owned(),
        },
        battery: battery_dto(s, profile),
        raw: s.raw.to_vec(),
    }
}

// ---------------------------------------------------------------------------------------------
// Errors, events, state
// ---------------------------------------------------------------------------------------------

/// Error payload of a `failed` event.
#[must_use]
pub fn error_info(e: &ptouch::Error) -> dto::ErrorInfo {
    let printer_errors = match e {
        ptouch::Error::Printer(errs) => printer_errors_dto(*errs),
        _ => Vec::new(),
    };
    let timeout = match e {
        ptouch::Error::Timeout(CoreTimeoutKind::Handshake) => Some(dto::TimeoutKind::Handshake),
        ptouch::Error::Timeout(CoreTimeoutKind::Status) => Some(dto::TimeoutKind::Status),
        ptouch::Error::Timeout(CoreTimeoutKind::Page { .. }) => Some(dto::TimeoutKind::Page),
        _ => None,
    };
    dto::ErrorInfo {
        code: e.code().to_owned(),
        message: e.to_string(),
        printer_errors,
        timeout,
    }
}

/// Core session event → DTO (`None` for a future core variant the bindings do not know yet).
#[must_use]
pub fn event_dto(e: &Event) -> Option<dto::SessionEvent> {
    Some(match e {
        Event::Status(s) => dto::SessionEvent::Status {
            status: status_dto(s),
        },
        Event::Ready(s) => dto::SessionEvent::Ready {
            status: status_dto(s),
        },
        Event::PageStarted { page } => dto::SessionEvent::PageStarted { page: *page },
        Event::PageCompleted { page } => dto::SessionEvent::PageCompleted { page: *page },
        Event::JobCompleted => dto::SessionEvent::JobCompleted,
        Event::Notification(n) => dto::SessionEvent::Notification {
            notification: notification_dto(*n),
        },
        Event::Failed {
            error,
            resume_from_page,
        } => dto::SessionEvent::Failed {
            error: error_info(error),
            resume_from_page: *resume_from_page,
        },
        _ => return None,
    })
}

/// Core session state → DTO.
#[must_use]
pub fn state_dto(s: ptouch::SessionState) -> dto::SessionState {
    use ptouch::SessionState as S;
    match s {
        S::Idle => dto::SessionState::Idle,
        S::Handshaking { attempt } => dto::SessionState::Handshaking { attempt },
        S::Ready => dto::SessionState::Ready,
        S::Printing { page, of } => dto::SessionState::Printing { page, of },
        S::Draining => dto::SessionState::Draining,
        S::Recovering => dto::SessionState::Recovering,
        _ => dto::SessionState::Failed,
    }
}

/// Session timing DTO → core (unset fields keep the core defaults).
#[must_use]
pub fn session_config(d: &dto::SessionConfig) -> ptouch::SessionConfig {
    let mut c = ptouch::SessionConfig::default();
    if let Some(v) = d.status_timeout_ms {
        c.status_timeout_ms = ms(v);
    }
    if let Some(v) = d.status_attempts {
        c.status_attempts = v.max(1);
    }
    if let Some(v) = d.mode_switch_drain_ms {
        c.mode_switch_drain_ms = ms(v);
    }
    if let Some(v) = d.page_time_base_ms {
        c.page_time_base_ms = ms(v);
    }
    if let Some(v) = d.page_time_per_line_ms {
        c.page_time_per_line_ms = ms(v);
    }
    if let Some(v) = d.page_margin_ms {
        c.page_margin_ms = ms(v);
    }
    if let Some(v) = d.poll_interval_ms {
        c.poll_interval_ms = ms(v);
    }
    if let Some(v) = d.post_job_drain_ms {
        c.post_job_drain_ms = ms(v);
    }
    if let Some(v) = d.max_ticks {
        c.max_ticks = v;
    }
    if let Some(v) = d.phase_frame_wait_ms {
        c.phase_frame_wait_ms = ms(v);
    }
    c
}

// ---------------------------------------------------------------------------------------------
// Rendering / job options
// ---------------------------------------------------------------------------------------------

/// `ToneOptions` → core (`Dither`, `ToneAdjust`).
#[must_use]
pub fn tone(o: &dto::ToneOptions) -> (Dither, ToneAdjust) {
    let dither = match o.dither.unwrap_or_default() {
        dto::DitherKind::Threshold => Dither::Threshold {
            level: o.level.unwrap_or(128),
        },
        dto::DitherKind::FloydSteinberg => Dither::FloydSteinberg,
        dto::DitherKind::Atkinson => Dither::Atkinson,
        dto::DitherKind::Bayer4 => Dither::Bayer4,
        dto::DitherKind::Bayer8 => Dither::Bayer8,
    };
    let mut adj = ToneAdjust::default();
    if let Some(v) = o.brightness {
        adj.brightness = v.clamp(-100, 100);
    }
    if let Some(v) = o.contrast {
        adj.contrast = v.clamp(-100, 100);
    }
    if let Some(v) = o.gamma_x100 {
        adj.gamma_x100 = v;
    }
    if let Some(v) = o.invert {
        adj.invert = v;
    }
    (dither, adj)
}

/// `JobOptions` DTO → core options (unset fields keep the core defaults).
#[must_use]
pub fn job_options(o: &dto::JobOptions) -> ptouch::JobOptions {
    let mut j = ptouch::JobOptions::default();
    if let Some(cut) = o.cut {
        j.cut = match cut {
            dto::CutMode::EveryLabel => CoreCutMode::EveryLabel,
            dto::CutMode::HalfCut => CoreCutMode::HalfCut,
            dto::CutMode::None => CoreCutMode::None,
        };
    }
    if let Some(v) = o.mirror {
        j.mirror = v;
    }
    if let Some(v) = o.chain {
        j.chain = v;
    }
    if let Some(v) = o.high_resolution {
        j.high_resolution = v;
    }
    if o.feed_margin_dots.is_some() {
        j.feed_margin_dots = o.feed_margin_dots;
    }
    if let Some(v) = o.compress {
        j.compression = Some(if v {
            Compression::PackBits
        } else {
            Compression::None
        });
    }
    if let Some(v) = o.auto_status {
        j.auto_status = v;
    }
    if let Some(v) = o.pad_short_pages {
        j.pad_short_pages = v;
    }
    j
}

/// Maximum `JobOptions.copies`.
pub const MAX_COPIES: u16 = 999;

/// Encodes `pages` × `copies` for (`p`, `t`): `prepare_pages` (high-res stretch, software
/// mirror) then `encode_job`. Copies reuse the prepared pages (no bitmap clones).
///
/// # Errors
/// Core encoder errors; `INVALID_INPUT` for `copies` outside 1–999.
pub fn encode_pages(
    p: &ModelProfile,
    t: &TapeSpec,
    pages: &[ptouch::Bitmap],
    o: &dto::JobOptions,
) -> Result<ptouch::EncodedJob, BindError> {
    let copies = o.copies.unwrap_or(1);
    if copies == 0 || copies > MAX_COPIES {
        return Err(BindError::invalid(format!(
            "copies must be between 1 and {MAX_COPIES}"
        )));
    }
    let (prepared, opts) = ptouch::prepare_pages(p, t, pages, &job_options(o))?;
    let refs: Vec<&ptouch::Bitmap> = (0..copies).flat_map(|_| prepared.iter()).collect();
    Ok(ptouch::encode_job(p, t, &refs, &opts)?)
}

// ---------------------------------------------------------------------------------------------
// Virtual printer
// ---------------------------------------------------------------------------------------------

/// Behaviour DTO → core.
#[must_use]
pub fn behaviour(b: dto::VirtualBehaviour) -> ptouch::Behaviour {
    match b {
        dto::VirtualBehaviour::Normal => ptouch::Behaviour::Normal,
        dto::VirtualBehaviour::Silent => ptouch::Behaviour::Silent,
        dto::VirtualBehaviour::NoPush => ptouch::Behaviour::NoPush,
        dto::VirtualBehaviour::CoverOpenOnPage { page } => ptouch::Behaviour::CoverOpenOnPage(page),
        dto::VirtualBehaviour::WrongMedia => ptouch::Behaviour::WrongMedia,
        dto::VirtualBehaviour::ExtraFrames { count } => ptouch::Behaviour::ExtraFrames(count),
        dto::VirtualBehaviour::CoolingOnPage { page } => ptouch::Behaviour::CoolingOnPage(page),
        dto::VirtualBehaviour::NoMedia => ptouch::Behaviour::NoMedia,
    }
}

/// Timing DTO → core (unset fields keep the core defaults).
#[must_use]
pub fn timing(d: &dto::VirtualTiming) -> ptouch::VirtualTiming {
    let mut t = ptouch::VirtualTiming::default();
    if let Some(v) = d.reply_delay_ms {
        t.reply_delay_ms = ms(v);
    }
    if let Some(v) = d.start_delay_ms {
        t.start_delay_ms = ms(v);
    }
    if let Some(v) = d.base_print_ms {
        t.base_print_ms = ms(v);
    }
    if let Some(v) = d.per_line_ms {
        t.per_line_ms = ms(v);
    }
    if let Some(v) = d.phase_delay_ms {
        t.phase_delay_ms = ms(v);
    }
    if let Some(v) = d.cooling_ms {
        t.cooling_ms = ms(v);
    }
    t
}

/// A new virtual printer for (`model`, `media_id`).
///
/// # Errors
/// `UNKNOWN_MODEL`, `UNSUPPORTED_MEDIA`.
pub fn virtual_printer(
    model: &str,
    media_id: &str,
    b: dto::VirtualBehaviour,
    t: &dto::VirtualTiming,
) -> Result<ptouch::VirtualPrinter, BindError> {
    let p = resolve_model(model)?;
    let tape = resolve_media(p, media_id)?;
    Ok(ptouch::VirtualPrinter::new(p, tape, behaviour(b)).with_timing(timing(t)))
}

/// One diagnostics line per decoded command: `Debug` text, except raster lines, which show
/// only their payload size (a 1 m label has ~7000 of them).
#[must_use]
pub fn command_text(c: &ptouch::virtual_printer::parser::Command) -> String {
    use ptouch::virtual_printer::parser::Command;
    match c {
        Command::RasterLine(data) => format!("RasterLine({} bytes)", data.len()),
        other => format!("{other:?}"),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;

    /// The real PT-P710BT reply (24 mm laminated white tape, black text; 2026-10-08).
    pub(crate) const P710BT_STATUS_24MM: [u8; 32] = [
        0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00,
    ];

    fn p710() -> &'static ModelProfile {
        resolve_model("PT-P710BT").unwrap()
    }

    fn tze24() -> &'static TapeSpec {
        resolve_media(p710(), "tze128-24").unwrap()
    }

    #[test]
    fn real_status_fixture_maps_to_dto() {
        let s = ptouch::parse_status(&P710BT_STATUS_24MM).unwrap();
        let d = status_dto(&s);
        assert_eq!(d.model_name.as_deref(), Some("PT-P710BT"));
        assert_eq!(d.media_width_mm, 24);
        assert_eq!(d.media_id.as_deref(), Some("tze128-24"));
        assert_eq!(d.media_type, "laminated");
        assert_eq!(d.media_type_byte, 0x01);
        assert_eq!(d.tape_color.name, "white");
        assert_eq!(d.tape_color.css, "#ffffff");
        assert_eq!(d.text_color.name, "black");
        assert!(d.ready);
        assert!(!d.error);
        assert!(!d.turned_off);
        assert!(d.errors.is_empty());
        assert_eq!(d.status_type, dto::StatusType::Reply);
        assert_eq!(d.phase.kind, dto::PhaseKind::Receiving);
        assert_eq!(d.phase.number, 0);
        assert_eq!(d.notification, dto::NotificationKind::None);
        assert_eq!(d.raw, P710BT_STATUS_24MM.to_vec());
    }

    #[test]
    fn status_errors_and_phases() {
        let mut raw = P710BT_STATUS_24MM;
        raw[8] = 0x01 | 0x08; // no media + weak batteries
        raw[9] = 0x10; // cover open
        raw[11] = 0x00;
        raw[18] = 0x02;
        raw[19] = 0x01;
        raw[22] = 0x01;
        let d = status_dto(&ptouch::parse_status(&raw).unwrap());
        let ids: Vec<&str> = d.errors.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["no-media", "weak-batteries", "cover-open"]);
        assert!(d.error && !d.ready);
        assert!(d.battery.weak);
        assert_eq!(d.media_type, "none");
        assert_eq!(d.media_id, None);
        assert_eq!(d.status_type, dto::StatusType::Error);
        assert_eq!(d.phase.kind, dto::PhaseKind::Printing);
        assert_eq!(d.notification, dto::NotificationKind::CoverOpen);
        raw[19] = 0x07;
        let d = status_dto(&ptouch::parse_status(&raw).unwrap());
        assert_eq!(d.phase.kind, dto::PhaseKind::Other);
        // Unknown model codes: no model name, no media id.
        raw[4] = 0xEE;
        let d = status_dto(&ptouch::parse_status(&raw).unwrap());
        assert_eq!(d.model_name, None);
    }

    #[test]
    fn every_error_code_is_in_the_ts_union() {
        use ptouch::Error as E;
        let all = [
            E::StatusLength { got: 1 },
            E::StatusHeader { got: [0; 4] },
            E::UnknownModel {
                series: 0,
                model: 0,
            },
            E::UnsupportedMedia {
                width_mm: 0,
                media_type: 0,
            },
            E::BitmapSize {
                expected_height: 1,
                got_height: 2,
            },
            E::DataLength {
                expected: 1,
                got: 2,
            },
            E::TooShort { dots: 1, min: 2 },
            E::TooLong { dots: 2, max: 1 },
            E::Empty,
            E::MediaMismatch {
                loaded_mm: 12,
                job_mm: 24,
            },
            E::NoMedia,
            E::NotReady,
            E::Printer(ptouch::PrinterErrors::new(0, 0x10, 0)),
            E::PrinterOff,
            E::Busy,
            E::Timeout(CoreTimeoutKind::Handshake),
            E::Cancelled,
            E::Unsupported("x"),
            E::InvalidInput("x"),
            E::Corrupt {
                what: "x",
                offset: 0,
            },
            E::Protocol("x"),
        ];
        let mut codes: Vec<&str> = all.iter().map(ptouch::Error::code).collect();
        for c in &codes {
            assert!(
                crate::TS_ERRORS.contains(&format!("\"{c}\"")),
                "{c} missing from PtouchErrorCode"
            );
        }
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), 21);
        // The union lists exactly these 21 codes, nothing else.
        let union = crate::TS_ERRORS
            .split("export type PtouchErrorCode =")
            .nth(1)
            .and_then(|r| r.split(';').next())
            .unwrap();
        let mut declared: Vec<&str> = union.split('"').skip(1).step_by(2).collect();
        declared.sort_unstable();
        assert_eq!(declared, codes);
        for e in [
            BindError::unknown_model("x"),
            BindError::unsupported_media("PT-P710BT", "x"),
            BindError::invalid("x"),
        ] {
            assert!(crate::TS_ERRORS.contains(&format!("\"{}\"", e.code())));
        }
    }

    #[test]
    fn error_info_carries_printer_errors_and_timeout() {
        let i = error_info(&ptouch::Error::Printer(ptouch::PrinterErrors::new(
            0, 0x10, 0,
        )));
        assert_eq!(i.code, "PRINTER");
        assert_eq!(i.printer_errors.len(), 1);
        assert_eq!(i.printer_errors[0].id, "cover-open");
        assert_eq!(i.timeout, None);
        let i = error_info(&ptouch::Error::Timeout(CoreTimeoutKind::Handshake));
        assert_eq!(i.code, "TIMEOUT");
        assert_eq!(i.timeout, Some(dto::TimeoutKind::Handshake));
    }

    #[test]
    fn model_and_media_lookups() {
        assert_eq!(resolve_model("pt-p710bt").unwrap().name, "PT-P710BT");
        assert_eq!(resolve_model("nope").unwrap_err().code(), "UNKNOWN_MODEL");
        assert_eq!(
            resolve_media(p710(), "tze560-24").unwrap_err().code(),
            "UNSUPPORTED_MEDIA"
        );
        assert_eq!(width_byte_for_mm(3.5).unwrap(), 4);
        assert_eq!(width_byte_for_mm(24.0).unwrap(), 24);
        assert_eq!(
            width_byte_for_mm(f64::NAN).unwrap_err().code(),
            "INVALID_INPUT"
        );
        let m = media_for_width_mm(p710(), 3.5, None).unwrap();
        assert_eq!(m.media_width_byte, 4);
        assert_eq!(media_dto(m).width_mm, 3.5);
        assert_eq!(
            media_for_width_mm(p710(), 24.0, None).unwrap().id,
            "tze128-24"
        );
        assert_eq!(
            media_for_width_mm(p710(), 36.0, None).unwrap_err().code(),
            "UNSUPPORTED_MEDIA"
        );

        let models: Vec<dto::ModelInfo> = ptouch::profiles().iter().map(model_dto).collect();
        assert_eq!(models[0].name, "PT-P710BT");
        assert!(models[0].bluetooth);
        assert!(models[0].caps.auto_cut);
        assert!(models[0].media.iter().any(|m| m.id == "tze128-24"));

        let a = print_area_dto(p710(), tze24());
        assert_eq!(a.media_id, "tze128-24");
        assert_eq!(a.dpi, 180);
        assert_eq!(a.height_dots, tze24().print_pins);
        assert_eq!(a.min_length_dots, 3); // PROTOCOL.md §5.6 vector (margin 14)
        assert_eq!(a.max_length_dots, Some(7086));
        assert_eq!(a.max_feed_dots, 900);
        assert_eq!(a.default_feed_dots, 14);
    }

    #[test]
    fn option_mappings() {
        let (d, adj) = tone(&dto::ToneOptions::default());
        assert_eq!(d, Dither::Threshold { level: 128 });
        assert!(adj.is_identity());
        let (d, adj) = tone(&dto::ToneOptions {
            dither: Some(dto::DitherKind::Atkinson),
            brightness: Some(-120),
            invert: Some(true),
            ..Default::default()
        });
        assert_eq!(d, Dither::Atkinson);
        assert_eq!(adj.brightness, -100);
        assert!(adj.invert);

        let j = job_options(&dto::JobOptions::default());
        assert_eq!(j, ptouch::JobOptions::default());
        let j = job_options(&dto::JobOptions {
            cut: Some(dto::CutMode::None),
            chain: Some(true),
            compress: Some(false),
            feed_margin_dots: Some(0),
            ..Default::default()
        });
        assert_eq!(j.cut, CoreCutMode::None);
        assert!(j.chain);
        assert_eq!(j.compression, Some(Compression::None));
        assert_eq!(j.feed_margin_dots, Some(0));

        let c = session_config(&dto::SessionConfig::default());
        assert_eq!(c, ptouch::SessionConfig::default());
        let c = session_config(&dto::SessionConfig {
            status_timeout_ms: Some(1234.9),
            max_ticks: Some(3),
            ..Default::default()
        });
        assert_eq!(c.status_timeout_ms, 1234);
        assert_eq!(c.max_ticks, 3);
    }

    /// A 60-line label with an asymmetric mark so orientation errors show up.
    fn label() -> ptouch::Bitmap {
        let t = tze24();
        ptouch::Bitmap::from_fn(60, t.print_pins, |x, y| x < 5 || (x == 30 && y < 10))
    }

    #[test]
    fn encode_pages_matches_core_and_repeats_copies() {
        let page = label();
        let golden = ptouch::encode_job(
            p710(),
            tze24(),
            &[&page, &page],
            &ptouch::JobOptions::default(),
        )
        .unwrap();
        let ours = encode_pages(
            p710(),
            tze24(),
            core::slice::from_ref(&page),
            &dto::JobOptions {
                copies: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(ours.to_bytes(), golden.to_bytes());
        assert_eq!(ours.page_count(), 2);
        assert_eq!(ours.to_bytes().last(), Some(&0x1A));
        let e = encode_pages(
            p710(),
            tze24(),
            core::slice::from_ref(&page),
            &dto::JobOptions {
                copies: Some(0),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(e.code(), "INVALID_INPUT");
        let e = encode_pages(p710(), tze24(), &[], &dto::JobOptions::default()).unwrap_err();
        assert_eq!(e.code(), "EMPTY");
        let wrong = ptouch::Bitmap::new(60, 10);
        let e = encode_pages(p710(), tze24(), &[wrong], &dto::JobOptions::default()).unwrap_err();
        assert_eq!(e.code(), "BITMAP_SIZE");
    }

    /// Drives a session against the virtual printer on a fake clock (same order as the core's
    /// session harness: pump, advance, deliver, timeout, pump); returns the event DTOs.
    fn run(
        session: &mut ptouch::Session,
        vp: &mut ptouch::VirtualPrinter,
        now: &mut u64,
        until: impl Fn(&[dto::SessionEvent]) -> bool,
    ) -> Vec<dto::SessionEvent> {
        let mut events = Vec::new();
        let pump = |session: &mut ptouch::Session,
                    vp: &mut ptouch::VirtualPrinter,
                    events: &mut Vec<dto::SessionEvent>,
                    now: u64| {
            while let Some(bytes) = session.poll_transmit() {
                vp.handle_input(&bytes, now);
            }
            while let Some(e) = session.poll_event() {
                events.extend(event_dto(&e));
            }
        };
        for _ in 0..100_000 {
            pump(session, vp, &mut events, *now);
            if until(&events) {
                return events;
            }
            let Some(next) = [vp.next_output_at(), session.poll_timeout()]
                .into_iter()
                .flatten()
                .min()
            else {
                break;
            };
            *now = (*now).max(next);
            while let Some(frame) = vp.poll_output(*now) {
                // RFCOMM-like fragmentation: 7 + 25 bytes.
                session.handle_input(&frame[..7], *now);
                session.handle_input(&frame[7..], *now);
            }
            if session.poll_timeout().is_some_and(|t| t <= *now) {
                session.handle_timeout(*now);
            }
        }
        pump(session, vp, &mut events, *now);
        assert!(
            until(&events),
            "session did not reach the expected state: {events:?}"
        );
        events
    }

    #[test]
    fn session_and_virtual_printer_full_job() {
        let mut vp = virtual_printer(
            "PT-P710BT",
            "tze128-24",
            dto::VirtualBehaviour::Normal,
            &dto::VirtualTiming::default(),
        )
        .unwrap();
        let mut s = ptouch::Session::new(None, session_config(&dto::SessionConfig::default()));
        let mut now = 1_000;
        s.connect(now);
        let ev = run(&mut s, &mut vp, &mut now, |e| {
            e.iter()
                .any(|e| matches!(e, dto::SessionEvent::Ready { .. }))
        });
        let Some(dto::SessionEvent::Ready { status }) = ev.last() else {
            panic!("{ev:?}")
        };
        assert_eq!(status.media_id.as_deref(), Some("tze128-24"));
        assert_eq!(state_dto(s.state()), dto::SessionState::Ready);

        let page = label();
        let job = encode_pages(
            p710(),
            tze24(),
            core::slice::from_ref(&page),
            &dto::JobOptions {
                copies: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        s.submit(job, now).unwrap();
        assert_eq!(
            state_dto(s.state()),
            dto::SessionState::Printing { page: 1, of: 2 }
        );
        let ev = run(&mut s, &mut vp, &mut now, |e| {
            e.iter()
                .any(|e| matches!(e, dto::SessionEvent::JobCompleted))
        });
        let progress: Vec<&dto::SessionEvent> = ev
            .iter()
            .filter(|e| !matches!(e, dto::SessionEvent::Status { .. }))
            .collect();
        assert_eq!(
            progress,
            [
                &dto::SessionEvent::PageStarted { page: 1 },
                &dto::SessionEvent::PageCompleted { page: 1 },
                &dto::SessionEvent::PageStarted { page: 2 },
                &dto::SessionEvent::PageCompleted { page: 2 },
                &dto::SessionEvent::JobCompleted,
            ]
        );
        assert_eq!(vp.printed().len(), 2);
        assert_eq!(
            vp.printed()[0],
            page,
            "virtual printer page is in label orientation"
        );
        assert!(vp.violations().is_empty(), "{:?}", vp.violations());
    }

    #[test]
    fn session_reports_cover_open_with_printer_errors() {
        let mut vp = virtual_printer(
            "PT-P710BT",
            "tze128-24",
            dto::VirtualBehaviour::CoverOpenOnPage { page: 1 },
            &dto::VirtualTiming::default(),
        )
        .unwrap();
        let mut s = ptouch::Session::new(Some(p710()), ptouch::SessionConfig::default());
        let mut now = 0;
        s.connect(now);
        run(&mut s, &mut vp, &mut now, |e| {
            e.iter()
                .any(|e| matches!(e, dto::SessionEvent::Ready { .. }))
        });
        let job = encode_pages(p710(), tze24(), &[label()], &dto::JobOptions::default()).unwrap();
        s.submit(job, now).unwrap();
        let ev = run(&mut s, &mut vp, &mut now, |e| {
            e.iter()
                .any(|e| matches!(e, dto::SessionEvent::Failed { .. }))
        });
        let Some(dto::SessionEvent::Failed {
            error,
            resume_from_page,
        }) = ev
            .iter()
            .find(|e| matches!(e, dto::SessionEvent::Failed { .. }))
        else {
            panic!("{ev:?}")
        };
        assert_eq!(error.code, "PRINTER");
        assert!(error.printer_errors.iter().any(|e| e.id == "cover-open"));
        assert_eq!(*resume_from_page, Some(1));
    }

    #[test]
    fn silent_printer_times_out_as_handshake() {
        let mut vp = virtual_printer(
            "PT-P710BT",
            "tze128-24",
            dto::VirtualBehaviour::Silent,
            &dto::VirtualTiming::default(),
        )
        .unwrap();
        let mut s = ptouch::Session::new(None, ptouch::SessionConfig::default());
        let mut now = 0;
        s.connect(now);
        let ev = run(&mut s, &mut vp, &mut now, |e| {
            e.iter()
                .any(|e| matches!(e, dto::SessionEvent::Failed { .. }))
        });
        let Some(dto::SessionEvent::Failed { error, .. }) = ev.last() else {
            panic!("{ev:?}")
        };
        assert_eq!(error.code, "TIMEOUT");
        assert_eq!(error.timeout, Some(dto::TimeoutKind::Handshake));
        assert_eq!(state_dto(s.state()), dto::SessionState::Failed);
    }

    #[test]
    fn decoded_commands_are_compact() {
        let job = encode_pages(p710(), tze24(), &[label()], &dto::JobOptions::default()).unwrap();
        let d = ptouch::decode_job(p710(), &job.to_bytes()).unwrap();
        assert_eq!(d.pages.len(), 1);
        assert_eq!(d.pages[0], label());
        let text: Vec<String> = d.commands.iter().map(command_text).collect();
        assert!(
            text.iter()
                .any(|t| t.starts_with("RasterLine(") && t.ends_with(" bytes)"))
        );
        assert!(text.iter().any(|t| t == "PrintLast"));
    }
}

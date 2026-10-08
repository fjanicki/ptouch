//! The 32-byte status reply (WP2).
//!
//! # Contract
//! - [`parse_status`] turns exactly [`STATUS_LEN`] bytes into a [`Status`]. It validates only
//!   the header `80 20 42` (PROTOCOL.md §4.1 validation); the series/model check against a
//!   [`crate::ModelProfile`] is the session's job. Every other byte is decoded totally: unknown
//!   values become `Other(u8)` variants, never errors.
//! - Bytes 7, 8 and 9 are three **independent** error bytes (never one u16; PROTOCOL.md §4.1
//!   "community conventions are wrong"). Byte 6 is battery, byte 7 extended error.
//! - The phase number `st[20..22]` is **big-endian**.
//! - [`Status::raw`] always holds the original bytes, so nothing is lost.
//! - [`StatusFramer`] reassembles frames from arbitrarily chunked input and resyncs on
//!   `80 20 42` (PROTOCOL.md §2.1 "Reads").
//!
//! # Spec references
//! PROTOCOL.md §4.1 layout, §4.2 status type, §4.3 phase + ready predicate, §4.4 notification,
//! §4.5 errors, §4.6 media/colours, §4.7 battery; ARCHITECTURE.md §8.1 fixture expectations.
//!
//! # Fixture
//! `tests/fixtures/status/p710bt_24mm_laminated_idle.hex` (real PT-P710BT reply) must parse
//! to: series 0x30, model 0x76, no errors, width 24, [`MediaType::Laminated`],
//! [`StatusType::Reply`], [`Phase::Receiving`]`(0)`, [`Notification::None`],
//! [`TapeColor::White`], [`TextColor::Black`].
//!
//! ```
//! use ptouch::{parse_status, MediaType, Phase, StatusType};
//!
//! let frame = [
//!     0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00,
//!     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00,
//!     0x00, 0x00,
//! ];
//! let status = parse_status(&frame)?;
//! assert_eq!(status.media_width_mm, 24);
//! assert_eq!(status.media_type, MediaType::Laminated);
//! assert_eq!(status.status_type, StatusType::Reply);
//! assert_eq!(status.phase, Phase::Receiving(0));
//! assert!(status.is_ready());
//! assert_eq!(
//!     status.to_string(),
//!     "model 0x30/0x76: 24 mm laminated tape, black on white; status reply, receiving (ready); no errors"
//! );
//! # Ok::<(), ptouch::Error>(())
//! ```

mod codes;
mod framer;

pub use codes::{
    Battery, ExtendedError, MediaType, Notification, Phase, PowerSource, PrinterError,
    PrinterErrorIter, PrinterErrors, StatusType, TapeColor, TextColor,
};
pub use framer::StatusFramer;

use core::fmt;

use crate::error::Error;
use crate::model::BatteryFormat;

/// Length of every status frame.
pub const STATUS_LEN: usize = 32;
/// First three bytes of every status frame: print head mark, size (32), `'B'`.
pub const STATUS_HEADER: [u8; 3] = [0x80, 0x20, 0x42];

/// A decoded 32-byte status frame (PROTOCOL.md §4.1).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct Status {
    /// `st[3]` series code (0x30 for PT models).
    pub series_code: u8,
    /// `st[4]` model code (0x76 for PT-P710BT).
    pub model_code: u8,
    /// `st[5]` country code.
    pub country_code: u8,
    /// `st[6]` raw battery byte; decode with [`Status::battery`].
    pub battery_raw: u8,
    /// `st[7]`, `st[8]`, `st[9]`: all error bits.
    pub errors: PrinterErrors,
    /// `st[10]` media width byte (whole mm; 3.5 mm tape reports 4).
    pub media_width_mm: u8,
    /// `st[11]` media type.
    pub media_type: MediaType,
    /// `st[12]` number of colours (ignore; PROTOCOL.md §4.1).
    pub colors: u8,
    /// `st[15]` mode: echo of the last `ESC i M`.
    pub mode: u8,
    /// `st[17]` media length in mm (0 = continuous; 45 for FLe).
    pub media_length_mm: u8,
    /// `st[18]` status type.
    pub status_type: StatusType,
    /// `st[19]` phase type + `st[20..22]` phase number (big-endian).
    pub phase: Phase,
    /// `st[22]` notification.
    pub notification: Notification,
    /// `st[24]` tape (background) colour.
    pub tape_color: TapeColor,
    /// `st[25]` text (ink) colour.
    pub text_color: TextColor,
    /// The original frame.
    pub raw: [u8; STATUS_LEN],
}

impl Status {
    /// `true` if any of `st[7]`, `st[8]`, `st[9]` is non-zero **or** the status type is an
    /// error type (`02`, undocumented `18`). Evaluated on every frame type, `00` included
    /// (PROTOCOL.md §4.2 resolution).
    ///
    /// Also `true` for the two cover-open signals the SDK treats as errors: phase
    /// printing / `0014` (§4.3) and notification `01` (§4.4). Status type `04` "turned off" is
    /// reported separately by [`Status::is_turned_off`].
    #[must_use]
    pub fn is_error(&self) -> bool {
        !self.errors.is_empty()
            || self.status_type.is_error()
            || self.phase.is_cover_open_error()
            || self.notification == Notification::CoverOpen
    }

    /// `true` for status type `04` "turned off" (fatal, PROTOCOL.md §4.2).
    #[must_use]
    pub fn is_turned_off(&self) -> bool {
        self.status_type == StatusType::TurnedOff
    }

    /// The §4.3 ready predicate: no error byte set and phase = receiving with number `0000`.
    ///
    /// Stricter than the bare byte predicate: a frame for which [`Status::is_error`] is `true`
    /// (e.g. status type `02` with all error bytes zero) is never ready.
    #[must_use]
    pub fn is_ready(&self) -> bool {
        !self.is_error() && self.phase.is_ready()
    }

    /// `true` when a cassette that can be printed on is loaded (`st[11]` ∉ {`00`, `FF`}).
    #[must_use]
    pub fn has_media(&self) -> bool {
        self.media_type.is_loaded()
    }

    /// Decodes `st[6]` for the model's battery format (PROTOCOL.md §4.7). `None` (format
    /// unknown) and [`BatteryFormat::Reserved`] yield [`Battery::Unknown`].
    #[must_use]
    pub fn battery(&self, format: Option<BatteryFormat>) -> Battery {
        match format {
            Some(BatteryFormat::Legacy) => Battery::from_legacy(self.battery_raw),
            Some(BatteryFormat::LevelAc) => Battery::from_level_ac(self.battery_raw),
            Some(BatteryFormat::Reserved | BatteryFormat::None) | None => Battery::Unknown,
        }
    }

    /// Low-battery signal valid on every model: `st[8] & 0x08` (PROTOCOL.md §4.7).
    #[must_use]
    pub fn weak_battery(&self) -> bool {
        self.errors.info1 & 0x08 != 0
    }

    /// Re-encodes the frame: starts from [`Status::raw`] and overwrites every decoded field,
    /// so a `Status` whose public fields were edited (virtual printer, tests) yields the
    /// matching bytes. For a freshly parsed frame this returns `raw` unchanged.
    #[must_use]
    pub fn to_bytes(&self) -> [u8; STATUS_LEN] {
        let mut b = self.raw;
        b[..3].copy_from_slice(&STATUS_HEADER);
        b[3] = self.series_code;
        b[4] = self.model_code;
        b[5] = self.country_code;
        b[6] = self.battery_raw;
        b[7] = self.errors.extended;
        b[8] = self.errors.info1;
        b[9] = self.errors.info2;
        b[10] = self.media_width_mm;
        b[11] = self.media_type.to_byte();
        b[12] = self.colors;
        b[15] = self.mode;
        b[17] = self.media_length_mm;
        b[18] = self.status_type.to_byte();
        let (kind, hi, lo) = self.phase.to_bytes();
        b[19] = kind;
        b[20] = hi;
        b[21] = lo;
        b[22] = self.notification.to_byte();
        b[24] = self.tape_color.to_byte();
        b[25] = self.text_color.to_byte();
        b
    }
}

/// One-line human-readable summary, e.g.
/// `model 0x30/0x76: 24 mm laminated tape, black on white; status reply, receiving (ready); no errors`.
///
/// Battery is not included because decoding it needs the model's [`BatteryFormat`]; use
/// [`Status::battery`].
impl fmt::Display for Status {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "model 0x{:02X}/0x{:02X}: ",
            self.series_code, self.model_code
        )?;
        match self.media_type {
            MediaType::None => f.write_str("no tape")?,
            MediaType::Incompatible => f.write_str("incompatible cassette")?,
            media => {
                write!(f, "{} mm {media} tape", self.media_width_mm)?;
                if self.media_length_mm != 0 {
                    write!(f, " ({} mm labels)", self.media_length_mm)?;
                }
                write!(f, ", {} on {}", self.text_color, self.tape_color)?;
            }
        }
        write!(f, "; {}, {}", self.status_type, self.phase)?;
        if self.notification != Notification::None {
            write!(f, ", notification: {}", self.notification)?;
        }
        if self.errors.is_empty() {
            f.write_str("; no errors")
        } else {
            write!(f, "; errors: {}", self.errors)
        }
    }
}

/// Parses one 32-byte status frame.
///
/// Only the header `80 20 42` is validated; every other byte decodes totally (see the
/// module docs).
///
/// # Errors
/// [`Error::StatusLength`] if `bytes.len() != 32`; [`Error::StatusHeader`] if the frame does
/// not start with `80 20 42`.
pub fn parse_status(bytes: &[u8]) -> Result<Status, Error> {
    let raw: [u8; STATUS_LEN] = bytes
        .try_into()
        .map_err(|_| Error::StatusLength { got: bytes.len() })?;
    if raw[..3] != STATUS_HEADER {
        return Err(Error::StatusHeader {
            got: [raw[0], raw[1], raw[2], raw[3]],
        });
    }
    Ok(Status {
        series_code: raw[3],
        model_code: raw[4],
        country_code: raw[5],
        battery_raw: raw[6],
        errors: PrinterErrors::new(raw[8], raw[9], raw[7]),
        media_width_mm: raw[10],
        media_type: MediaType::from_byte(raw[11]),
        colors: raw[12],
        mode: raw[15],
        media_length_mm: raw[17],
        status_type: StatusType::from_byte(raw[18]),
        phase: Phase::from_bytes(raw[19], raw[20], raw[21]),
        notification: Notification::from_byte(raw[22]),
        tape_color: TapeColor::from_byte(raw[24]),
        text_color: TextColor::from_byte(raw[25]),
        raw,
    })
}

impl TryFrom<&[u8]> for Status {
    type Error = Error;

    /// Same as [`parse_status`].
    fn try_from(bytes: &[u8]) -> Result<Self, Error> {
        parse_status(bytes)
    }
}

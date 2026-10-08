//! Crate-wide error type.
//!
//! Shared file: complete as scaffolded, no work package needs to edit it. Every fallible
//! function in the crate returns [`Error`]. Each variant has a stable SCREAMING_SNAKE code
//! ([`Error::code`]) that is mirrored by the TypeScript `PtouchErrorCode` union in
//! `ptouch-wasm` (ARCHITECTURE.md §4.2), so codes must never be renamed once released.
//!
//! The type is `no_std`: it implements [`core::fmt::Display`] and [`core::error::Error`] by hand
//! (no `thiserror`, ARCHITECTURE.md §10).

use core::fmt;

use crate::status::PrinterErrors;

/// Which wait ran out (see [`Error::Timeout`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[non_exhaustive]
pub enum TimeoutKind {
    /// No valid status reply after all handshake attempts (printer asleep / wrong channel).
    /// PROTOCOL.md §2.1 "Wake-up and first contact", §6.1 step 4.
    Handshake,
    /// No reply to an explicit status request while idle.
    Status,
    /// A page did not complete within the estimated print time plus margin (PROTOCOL.md §6.8).
    Page {
        /// 1-based page number that was printing.
        page: u16,
    },
}

/// Every error the protocol core can report.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[non_exhaustive]
pub enum Error {
    /// A status frame was not exactly [`crate::STATUS_LEN`] bytes.
    StatusLength {
        /// Number of bytes received.
        got: usize,
    },
    /// A status frame did not start with `80 20 42` (PROTOCOL.md §4.1).
    StatusHeader {
        /// The first four bytes received.
        got: [u8; 4],
    },
    /// The (series, model) code pair from `st[3]`/`st[4]` is not in the model table.
    UnknownModel {
        /// `st[3]`.
        series: u8,
        /// `st[4]`.
        model: u8,
    },
    /// The model has no media entry for this width / media type (PROTOCOL.md §4.6).
    UnsupportedMedia {
        /// Media width byte (`st[10]`, `ESC i z` n3).
        width_mm: u8,
        /// Media type byte (`st[11]`).
        media_type: u8,
    },
    /// The bitmap height does not equal the tape's printable pins (ARCHITECTURE.md §5.1).
    BitmapSize {
        /// `TapeSpec::print_pins`.
        expected_height: u16,
        /// `Bitmap::height()`.
        got_height: u16,
    },
    /// A buffer had the wrong length for the stated dimensions.
    DataLength {
        /// Required length in bytes.
        expected: usize,
        /// Supplied length in bytes.
        got: usize,
    },
    /// A page is shorter than the model minimum and padding was disabled (PROTOCOL.md §5.6).
    TooShort {
        /// Raster lines in the page.
        dots: u32,
        /// Minimum raster lines.
        min: u32,
    },
    /// A page is longer than the model maximum (PROTOCOL.md §5.6).
    TooLong {
        /// Raster lines in the page.
        dots: u32,
        /// Maximum raster lines.
        max: u32,
    },
    /// A job has no pages, or a bitmap has zero length.
    Empty,
    /// The loaded tape does not match the job (preflight, PROTOCOL.md §6.1 step 6).
    MediaMismatch {
        /// Width reported by the printer (`st[10]`).
        loaded_mm: u8,
        /// Width the job was encoded for.
        job_mm: u8,
    },
    /// No tape (`st[11] = 00`) or an incompatible cassette (`st[11] = FF`) is loaded.
    NoMedia,
    /// The printer is not in the ready phase (PROTOCOL.md §4.3 ready predicate).
    NotReady,
    /// The printer reported an error (any non-zero `st[7]`, `st[8]`, `st[9]`, or status type
    /// `02`/`18`). PROTOCOL.md §4.5.
    Printer(PrinterErrors),
    /// The printer reported status type `04` "turned off" (PROTOCOL.md §4.2).
    PrinterOff,
    /// Operation not allowed in the current session state (e.g. a status request while a
    /// page is printing, PROTOCOL.md §6.8 step 2).
    Busy,
    /// A wait ran out.
    Timeout(TimeoutKind),
    /// The job was cancelled by the caller.
    Cancelled,
    /// The requested option is not supported by this model (e.g. half cut on PT-P710BT).
    Unsupported(&'static str),
    /// A caller-supplied argument is out of range.
    InvalidInput(&'static str),
    /// Malformed input data (PackBits stream, job byte stream, PBM file).
    Corrupt {
        /// What was being decoded, e.g. `"packbits"`.
        what: &'static str,
        /// Byte offset of the first invalid byte.
        offset: usize,
    },
    /// An unexpected frame sequence from the printer.
    Protocol(&'static str),
}

impl Error {
    /// Stable machine-readable code (SCREAMING_SNAKE_CASE), mirrored in TypeScript.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::StatusLength { .. } => "STATUS_LENGTH",
            Self::StatusHeader { .. } => "STATUS_HEADER",
            Self::UnknownModel { .. } => "UNKNOWN_MODEL",
            Self::UnsupportedMedia { .. } => "UNSUPPORTED_MEDIA",
            Self::BitmapSize { .. } => "BITMAP_SIZE",
            Self::DataLength { .. } => "DATA_LENGTH",
            Self::TooShort { .. } => "TOO_SHORT",
            Self::TooLong { .. } => "TOO_LONG",
            Self::Empty => "EMPTY",
            Self::MediaMismatch { .. } => "MEDIA_MISMATCH",
            Self::NoMedia => "NO_MEDIA",
            Self::NotReady => "NOT_READY",
            Self::Printer(_) => "PRINTER",
            Self::PrinterOff => "PRINTER_OFF",
            Self::Busy => "BUSY",
            Self::Timeout(_) => "TIMEOUT",
            Self::Cancelled => "CANCELLED",
            Self::Unsupported(_) => "UNSUPPORTED",
            Self::InvalidInput(_) => "INVALID_INPUT",
            Self::Corrupt { .. } => "CORRUPT",
            Self::Protocol(_) => "PROTOCOL",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StatusLength { got } => {
                write!(
                    f,
                    "status frame has {got} bytes, expected {}",
                    crate::STATUS_LEN
                )
            }
            Self::StatusHeader { got } => write!(
                f,
                "status frame header {:02X} {:02X} {:02X} {:02X} is not 80 20 42 xx",
                got[0], got[1], got[2], got[3]
            ),
            Self::UnknownModel { series, model } => {
                write!(
                    f,
                    "unknown printer model (series 0x{series:02X}, model 0x{model:02X})"
                )
            }
            Self::UnsupportedMedia {
                width_mm,
                media_type,
            } => write!(
                f,
                "unsupported media: width {width_mm} mm, media type 0x{media_type:02X}"
            ),
            Self::BitmapSize {
                expected_height,
                got_height,
            } => write!(
                f,
                "bitmap height {got_height} does not match the tape's {expected_height} printable dots"
            ),
            Self::DataLength { expected, got } => {
                write!(f, "buffer has {got} bytes, expected {expected}")
            }
            Self::TooShort { dots, min } => {
                write!(f, "label is {dots} dots long, minimum is {min}")
            }
            Self::TooLong { dots, max } => write!(f, "label is {dots} dots long, maximum is {max}"),
            Self::Empty => f.write_str("nothing to print"),
            Self::MediaMismatch { loaded_mm, job_mm } => write!(
                f,
                "loaded tape is {loaded_mm} mm but the label was made for {job_mm} mm"
            ),
            Self::NoMedia => f.write_str("no tape cassette (or an incompatible one) is loaded"),
            Self::NotReady => f.write_str("printer is not ready to receive"),
            Self::Printer(e) => write!(
                f,
                "printer error (info1 0x{:02X}, info2 0x{:02X}, extended 0x{:02X})",
                e.info1, e.info2, e.extended
            ),
            Self::PrinterOff => f.write_str("printer turned off"),
            Self::Busy => f.write_str("operation not allowed while the printer is busy"),
            Self::Timeout(TimeoutKind::Handshake) => {
                f.write_str("no status reply from the printer (asleep? power-cycle it)")
            }
            Self::Timeout(TimeoutKind::Status) => f.write_str("status request timed out"),
            Self::Timeout(TimeoutKind::Page { page }) => {
                write!(f, "page {page} did not complete in time")
            }
            Self::Cancelled => f.write_str("cancelled"),
            Self::Unsupported(what) => write!(f, "not supported by this model: {what}"),
            Self::InvalidInput(what) => write!(f, "invalid input: {what}"),
            Self::Corrupt { what, offset } => write!(f, "corrupt {what} data at byte {offset}"),
            Self::Protocol(what) => write!(f, "protocol error: {what}"),
        }
    }
}

impl core::error::Error for Error {}

#[cfg(feature = "std")]
impl From<Error> for std::io::Error {
    fn from(e: Error) -> Self {
        std::io::Error::other(e)
    }
}

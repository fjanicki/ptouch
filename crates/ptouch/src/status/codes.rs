//! Status byte enumerations (WP2): status type, phase, notification, errors, media type,
//! colours and battery (PROTOCOL.md §4.2–§4.7).
//!
//! Every `from_byte` is total (unknown → `Other(u8)` / `Unknown(u8)`), and every enum
//! round-trips through `to_byte` so the virtual printer and tests can synthesise frames.
//! Round-tripping holds for every byte value: a code that has a named variant never decodes
//! to the catch-all variant, so `from_byte(b).to_byte() == b` for all `b`.
//!
//! Every type implements [`core::fmt::Display`] with a short, lower-case English text meant
//! for logs and CLI output.

use core::fmt;
use core::iter::FusedIterator;

// ---------------------------------------------------------------------------------------------
// st[18] status type
// ---------------------------------------------------------------------------------------------

/// `st[18]` status type (PROTOCOL.md §4.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum StatusType {
    /// `00` reply to a status request.
    Reply,
    /// `01` printing completed.
    PrintingCompleted,
    /// `02` error occurred (the printer has discarded its buffer).
    Error,
    /// `03` exit IF mode (unexpected).
    ExitIfMode,
    /// `04` turned off (fatal).
    TurnedOff,
    /// `05` notification, see `st[22]`.
    Notification,
    /// `06` phase change, see `st[19..22]`.
    PhaseChange,
    /// Anything else, including the undocumented `18` (treated as an error).
    Other(u8),
}

impl StatusType {
    /// The undocumented status type that Brother's macOS SDK routes to the error branch.
    pub const UNDOCUMENTED_ERROR: u8 = 0x18;

    /// Decodes `st[18]`.
    #[must_use]
    pub const fn from_byte(b: u8) -> Self {
        match b {
            0x00 => Self::Reply,
            0x01 => Self::PrintingCompleted,
            0x02 => Self::Error,
            0x03 => Self::ExitIfMode,
            0x04 => Self::TurnedOff,
            0x05 => Self::Notification,
            0x06 => Self::PhaseChange,
            other => Self::Other(other),
        }
    }

    /// Encodes back to `st[18]`.
    #[must_use]
    pub const fn to_byte(self) -> u8 {
        match self {
            Self::Reply => 0x00,
            Self::PrintingCompleted => 0x01,
            Self::Error => 0x02,
            Self::ExitIfMode => 0x03,
            Self::TurnedOff => 0x04,
            Self::Notification => 0x05,
            Self::PhaseChange => 0x06,
            Self::Other(b) => b,
        }
    }

    /// `true` for `02` and the undocumented `18` (PROTOCOL.md §4.2 resolution).
    #[must_use]
    pub const fn is_error(self) -> bool {
        matches!(self, Self::Error | Self::Other(Self::UNDOCUMENTED_ERROR))
    }
}

impl fmt::Display for StatusType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Reply => f.write_str("status reply"),
            Self::PrintingCompleted => f.write_str("printing completed"),
            Self::Error => f.write_str("error occurred"),
            Self::ExitIfMode => f.write_str("exit IF mode"),
            Self::TurnedOff => f.write_str("turned off"),
            Self::Notification => f.write_str("notification"),
            Self::PhaseChange => f.write_str("phase change"),
            Self::Other(Self::UNDOCUMENTED_ERROR) => f.write_str("error (undocumented type 0x18)"),
            Self::Other(b) => write!(f, "unknown status type 0x{b:02X}"),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// st[19..22] phase
// ---------------------------------------------------------------------------------------------

/// `st[19]` phase type with the big-endian phase number `st[20..22]` (PROTOCOL.md §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum Phase {
    /// Phase type `00` editing / receiving; number `0000` = ready, `0001` = feeding.
    Receiving(u16),
    /// Phase type `01` printing; number `0014` = cover open while receiving (error).
    Printing(u16),
    /// Any other phase type.
    Other {
        /// `st[19]`.
        kind: u8,
        /// `st[20..22]`, big-endian.
        number: u16,
    },
}

impl Phase {
    /// Phase number `0000` in the receiving phase: ready to receive.
    pub const READY: u16 = 0x0000;
    /// Phase number `0001` in the receiving phase: feeding (D1–D3).
    pub const FEEDING: u16 = 0x0001;
    /// Phase number `0014` in the printing phase: cover open while receiving (an error).
    pub const COVER_OPEN_WHILE_RECEIVING: u16 = 0x0014;

    /// Decodes `st[19]`, `st[20]`, `st[21]`.
    #[must_use]
    pub const fn from_bytes(kind: u8, hi: u8, lo: u8) -> Self {
        let number = u16::from_be_bytes([hi, lo]);
        match kind {
            0x00 => Self::Receiving(number),
            0x01 => Self::Printing(number),
            kind => Self::Other { kind, number },
        }
    }

    /// Encodes back to `(st[19], st[20], st[21])`.
    #[must_use]
    pub const fn to_bytes(self) -> (u8, u8, u8) {
        let (kind, number) = match self {
            Self::Receiving(n) => (0x00, n),
            Self::Printing(n) => (0x01, n),
            Self::Other { kind, number } => (kind, number),
        };
        let [hi, lo] = number.to_be_bytes();
        (kind, hi, lo)
    }

    /// `true` for receiving / `0000`, the phase part of the §4.3 ready predicate.
    #[must_use]
    pub const fn is_ready(self) -> bool {
        matches!(self, Self::Receiving(Self::READY))
    }

    /// `true` for printing / `0014` ("cover open while receiving", an error per the SDK).
    #[must_use]
    pub const fn is_cover_open_error(self) -> bool {
        matches!(self, Self::Printing(Self::COVER_OPEN_WHILE_RECEIVING))
    }
}

impl fmt::Display for Phase {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            Self::Receiving(Self::READY) => f.write_str("receiving (ready)"),
            Self::Receiving(Self::FEEDING) => f.write_str("receiving (feeding)"),
            Self::Receiving(n) => write!(f, "receiving (0x{n:04X})"),
            Self::Printing(0) => f.write_str("printing"),
            Self::Printing(Self::COVER_OPEN_WHILE_RECEIVING) => {
                f.write_str("printing (cover open while receiving)")
            }
            Self::Printing(n) => write!(f, "printing (0x{n:04X})"),
            Self::Other { kind, number } => write!(f, "phase 0x{kind:02X} (0x{number:04X})"),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// st[22] notification
// ---------------------------------------------------------------------------------------------

/// `st[22]` notification number (PROTOCOL.md §4.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum Notification {
    /// `00` not available.
    None,
    /// `01` cover open (an error for the session).
    CoverOpen,
    /// `02` cover closed.
    CoverClosed,
    /// `03` cooling started: printing pauses, extend timeouts.
    CoolingStarted,
    /// `04` cooling finished.
    CoolingFinished,
    /// `05` waiting for peeling (SDK only).
    WaitingForPeeling,
    /// `07` printer paused (SDK).
    Paused,
    /// `0B` waiting for label cut (E310BT).
    WaitingForCut,
    /// `0C` cut wait finished (E310BT).
    CutWaitFinished,
    /// Anything else.
    Other(u8),
}

impl Notification {
    /// Decodes `st[22]`.
    #[must_use]
    pub const fn from_byte(b: u8) -> Self {
        match b {
            0x00 => Self::None,
            0x01 => Self::CoverOpen,
            0x02 => Self::CoverClosed,
            0x03 => Self::CoolingStarted,
            0x04 => Self::CoolingFinished,
            0x05 => Self::WaitingForPeeling,
            0x07 => Self::Paused,
            0x0B => Self::WaitingForCut,
            0x0C => Self::CutWaitFinished,
            other => Self::Other(other),
        }
    }

    /// Encodes back to `st[22]`.
    #[must_use]
    pub const fn to_byte(self) -> u8 {
        match self {
            Self::None => 0x00,
            Self::CoverOpen => 0x01,
            Self::CoverClosed => 0x02,
            Self::CoolingStarted => 0x03,
            Self::CoolingFinished => 0x04,
            Self::WaitingForPeeling => 0x05,
            Self::Paused => 0x07,
            Self::WaitingForCut => 0x0B,
            Self::CutWaitFinished => 0x0C,
            Self::Other(b) => b,
        }
    }
}

impl fmt::Display for Notification {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::None => f.write_str("none"),
            Self::CoverOpen => f.write_str("cover open"),
            Self::CoverClosed => f.write_str("cover closed"),
            Self::CoolingStarted => f.write_str("cooling started"),
            Self::CoolingFinished => f.write_str("cooling finished"),
            Self::WaitingForPeeling => f.write_str("waiting for peeling"),
            Self::Paused => f.write_str("paused"),
            Self::WaitingForCut => f.write_str("waiting for label cut"),
            Self::CutWaitFinished => f.write_str("cut wait finished"),
            Self::Other(b) => write!(f, "unknown notification 0x{b:02X}"),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// st[7], st[8], st[9] errors
// ---------------------------------------------------------------------------------------------

/// `st[8]` (error information 1) bits, LSB first (PROTOCOL.md §4.5.1).
const INFO1_ERRORS: [PrinterError; 8] = [
    PrinterError::NoMedia,
    PrinterError::EndOfMedia,
    PrinterError::CutterJam,
    PrinterError::WeakBatteries,
    PrinterError::PrinterInUse,
    PrinterError::PowerTurnedOff,
    PrinterError::HighVoltageAdapter,
    PrinterError::SystemErrorInfo1,
];

/// `st[9]` (error information 2) bits, LSB first (PROTOCOL.md §4.5.2).
const INFO2_ERRORS: [PrinterError; 8] = [
    PrinterError::WrongMedia,
    PrinterError::ExpansionBufferFull,
    PrinterError::CommunicationError,
    PrinterError::CommunicationBufferFull,
    PrinterError::CoverOpen,
    PrinterError::Overheating,
    PrinterError::BlackMarkNotDetected,
    PrinterError::SystemErrorInfo2,
];

/// The three raw error bytes of a status frame (PROTOCOL.md §4.5). Decode with
/// [`PrinterErrors::iter`]; every set bit is reported (never compare with `==`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct PrinterErrors {
    /// `st[8]` error information 1 (bitfield, §4.5.1).
    pub info1: u8,
    /// `st[9]` error information 2 (bitfield, §4.5.2).
    pub info2: u8,
    /// `st[7]` extended error (a value, not a bitfield, §4.5.3).
    pub extended: u8,
}

impl PrinterErrors {
    /// Builds the error set from `st[8]`, `st[9]` and `st[7]` (in that order, matching the
    /// field order).
    #[must_use]
    pub const fn new(info1: u8, info2: u8, extended: u8) -> Self {
        Self {
            info1,
            info2,
            extended,
        }
    }

    /// `true` when all three bytes are zero.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.info1 == 0 && self.info2 == 0 && self.extended == 0
    }

    /// `true` if `error` is reported by these bytes.
    #[must_use]
    pub fn contains(&self, error: PrinterError) -> bool {
        self.iter().any(|e| e == error)
    }

    /// Iterates every error in headline precedence order: byte 8 bits (LSB first), then
    /// byte 9 bits, then the extended byte (PROTOCOL.md §4.5).
    #[must_use]
    pub const fn iter(&self) -> PrinterErrorIter {
        PrinterErrorIter {
            errors: *self,
            pos: 0,
        }
    }

    /// The single headline error (first item of [`PrinterErrors::iter`]), if any.
    #[must_use]
    pub fn headline(&self) -> Option<PrinterError> {
        self.iter().next()
    }
}

impl IntoIterator for PrinterErrors {
    type Item = PrinterError;
    type IntoIter = PrinterErrorIter;
    fn into_iter(self) -> PrinterErrorIter {
        self.iter()
    }
}

impl IntoIterator for &PrinterErrors {
    type Item = PrinterError;
    type IntoIter = PrinterErrorIter;
    fn into_iter(self) -> PrinterErrorIter {
        self.iter()
    }
}

/// Lists every error separated by `", "`, or `"no errors"`.
impl fmt::Display for PrinterErrors {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_empty() {
            return f.write_str("no errors");
        }
        for (i, e) in self.iter().enumerate() {
            if i > 0 {
                f.write_str(", ")?;
            }
            fmt::Display::fmt(&e, f)?;
        }
        Ok(())
    }
}

/// Iterator over the individual errors in a [`PrinterErrors`].
#[derive(Debug, Clone)]
pub struct PrinterErrorIter {
    errors: PrinterErrors,
    /// Next position: 0–7 = `info1` bits, 8–15 = `info2` bits, 16 = extended, 17 = done.
    pos: u8,
}

impl Iterator for PrinterErrorIter {
    type Item = PrinterError;

    fn next(&mut self) -> Option<PrinterError> {
        while self.pos < 17 {
            let pos = self.pos;
            self.pos += 1;
            match pos {
                0..=7 => {
                    if self.errors.info1 & (1 << pos) != 0 {
                        return Some(INFO1_ERRORS[usize::from(pos)]);
                    }
                }
                8..=15 => {
                    let bit = pos - 8;
                    if self.errors.info2 & (1 << bit) != 0 {
                        return Some(INFO2_ERRORS[usize::from(bit)]);
                    }
                }
                _ => {
                    if self.errors.extended != 0 {
                        return Some(PrinterError::Extended(ExtendedError::from_byte(
                            self.errors.extended,
                        )));
                    }
                }
            }
        }
        None
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        // Upper bound: the remaining positions.
        (0, Some(usize::from(17u8.saturating_sub(self.pos))))
    }
}

impl FusedIterator for PrinterErrorIter {}

/// One decoded printer error (PROTOCOL.md §4.5.1–§4.5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum PrinterError {
    /// `st[8]` 0x01.
    NoMedia,
    /// `st[8]` 0x02.
    EndOfMedia,
    /// `st[8]` 0x04.
    CutterJam,
    /// `st[8]` 0x08 (the reliable low-battery signal).
    WeakBatteries,
    /// `st[8]` 0x10.
    PrinterInUse,
    /// `st[8]` 0x20.
    PowerTurnedOff,
    /// `st[8]` 0x40.
    HighVoltageAdapter,
    /// `st[8]` 0x80.
    SystemErrorInfo1,
    /// `st[9]` 0x01: wrong / replace media (also "missing `ESC i z`" on P710BT).
    WrongMedia,
    /// `st[9]` 0x02.
    ExpansionBufferFull,
    /// `st[9]` 0x04.
    CommunicationError,
    /// `st[9]` 0x08.
    CommunicationBufferFull,
    /// `st[9]` 0x10.
    CoverOpen,
    /// `st[9]` 0x20.
    Overheating,
    /// `st[9]` 0x40.
    BlackMarkNotDetected,
    /// `st[9]` 0x80.
    SystemErrorInfo2,
    /// Non-zero `st[7]`.
    Extended(ExtendedError),
}

impl PrinterError {
    /// Where this error lives in the frame: `(status byte index, mask or value)`.
    ///
    /// Bit errors return `(8, mask)` or `(9, mask)`; extended errors return `(7, value)`.
    /// Useful to synthesise frames (virtual printer, tests).
    #[must_use]
    pub const fn location(&self) -> (usize, u8) {
        match self {
            Self::NoMedia => (8, 0x01),
            Self::EndOfMedia => (8, 0x02),
            Self::CutterJam => (8, 0x04),
            Self::WeakBatteries => (8, 0x08),
            Self::PrinterInUse => (8, 0x10),
            Self::PowerTurnedOff => (8, 0x20),
            Self::HighVoltageAdapter => (8, 0x40),
            Self::SystemErrorInfo1 => (8, 0x80),
            Self::WrongMedia => (9, 0x01),
            Self::ExpansionBufferFull => (9, 0x02),
            Self::CommunicationError => (9, 0x04),
            Self::CommunicationBufferFull => (9, 0x08),
            Self::CoverOpen => (9, 0x10),
            Self::Overheating => (9, 0x20),
            Self::BlackMarkNotDetected => (9, 0x40),
            Self::SystemErrorInfo2 => (9, 0x80),
            Self::Extended(e) => (7, e.to_byte()),
        }
    }

    /// Short English description for UIs and logs.
    #[must_use]
    pub const fn message(&self) -> &'static str {
        match self {
            Self::NoMedia => "no tape cassette",
            Self::EndOfMedia => "end of tape",
            Self::CutterJam => "cutter jam",
            Self::WeakBatteries => "weak batteries",
            Self::PrinterInUse => "printer in use",
            Self::PowerTurnedOff => "power turned off",
            Self::HighVoltageAdapter => "high-voltage adapter",
            Self::SystemErrorInfo1 => "system error (out of order)",
            Self::WrongMedia => "wrong tape or unsupported setting (replace the cassette)",
            Self::ExpansionBufferFull => "expansion buffer full",
            Self::CommunicationError => "communication error",
            Self::CommunicationBufferFull => "communication buffer full",
            Self::CoverOpen => "cover open",
            Self::Overheating => "print head overheated",
            Self::BlackMarkNotDetected => "black mark not detected (cannot feed)",
            Self::SystemErrorInfo2 => "system error",
            Self::Extended(e) => e.message(),
        }
    }
}

impl fmt::Display for PrinterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Extended(e) => fmt::Display::fmt(e, f),
            other => f.write_str(other.message()),
        }
    }
}

/// `st[7]` extended error values (PROTOCOL.md §4.5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum ExtendedError {
    /// `10` FLe tape end.
    FleTapeEnd,
    /// `14` tube ribbon not loaded.
    TubeRibbonNotLoaded,
    /// `1D` cannot print at the selected resolution (wrong tape / no AC adapter).
    ResolutionUnavailable,
    /// `1E` AC adapter pulled or inserted during printing.
    AdapterChangedWhilePrinting,
    /// `1F` unable to charge battery.
    BatteryChargeFailed,
    /// `20` tube not inserted correctly.
    TubeNotInserted,
    /// `21` incompatible / unsupported media.
    IncompatibleMedia,
    /// `22` tube cutter failure.
    TubeCutterFailure,
    /// `23` paper does not support two-colour.
    NoTwoColorSupport,
    /// `24` paper does not support monochrome.
    NoMonochromeSupport,
    /// `26` transport motor slowing (jam).
    TransportMotorSlow,
    /// `27` unsupported USB power source.
    UnsupportedPowerSource,
    /// `28` unsupported optional equipment.
    UnsupportedOption,
    /// Any other non-zero value.
    Other(u8),
}

impl ExtendedError {
    /// Decodes a **non-zero** `st[7]` (`0` decodes to `Other(0)`; [`PrinterErrors::iter`]
    /// never yields it).
    #[must_use]
    pub const fn from_byte(b: u8) -> Self {
        match b {
            0x10 => Self::FleTapeEnd,
            0x14 => Self::TubeRibbonNotLoaded,
            0x1D => Self::ResolutionUnavailable,
            0x1E => Self::AdapterChangedWhilePrinting,
            0x1F => Self::BatteryChargeFailed,
            0x20 => Self::TubeNotInserted,
            0x21 => Self::IncompatibleMedia,
            0x22 => Self::TubeCutterFailure,
            0x23 => Self::NoTwoColorSupport,
            0x24 => Self::NoMonochromeSupport,
            0x26 => Self::TransportMotorSlow,
            0x27 => Self::UnsupportedPowerSource,
            0x28 => Self::UnsupportedOption,
            other => Self::Other(other),
        }
    }

    /// Encodes back to `st[7]`.
    #[must_use]
    pub const fn to_byte(self) -> u8 {
        match self {
            Self::FleTapeEnd => 0x10,
            Self::TubeRibbonNotLoaded => 0x14,
            Self::ResolutionUnavailable => 0x1D,
            Self::AdapterChangedWhilePrinting => 0x1E,
            Self::BatteryChargeFailed => 0x1F,
            Self::TubeNotInserted => 0x20,
            Self::IncompatibleMedia => 0x21,
            Self::TubeCutterFailure => 0x22,
            Self::NoTwoColorSupport => 0x23,
            Self::NoMonochromeSupport => 0x24,
            Self::TransportMotorSlow => 0x26,
            Self::UnsupportedPowerSource => 0x27,
            Self::UnsupportedOption => 0x28,
            Self::Other(b) => b,
        }
    }

    /// Short English description for UIs and logs (`Other` yields a generic text; its
    /// [`Display`](fmt::Display) includes the code).
    #[must_use]
    pub const fn message(&self) -> &'static str {
        match self {
            Self::FleTapeEnd => "FLe tape end",
            Self::TubeRibbonNotLoaded => "tube ribbon not loaded",
            Self::ResolutionUnavailable => {
                "cannot print at the selected resolution (wrong tape or no AC adapter)"
            }
            Self::AdapterChangedWhilePrinting => "AC adapter pulled or inserted during printing",
            Self::BatteryChargeFailed => "unable to charge the battery",
            Self::TubeNotInserted => "tube not inserted correctly",
            Self::IncompatibleMedia => "incompatible or unsupported media",
            Self::TubeCutterFailure => "tube cutter failure",
            Self::NoTwoColorSupport => "media does not support two-colour printing",
            Self::NoMonochromeSupport => "media does not support monochrome printing",
            Self::TransportMotorSlow => "transport motor slowing (jam or mechanical problem)",
            Self::UnsupportedPowerSource => "unsupported USB power source or charger",
            Self::UnsupportedOption => "unsupported optional equipment",
            Self::Other(_) => "unknown extended error",
        }
    }
}

impl fmt::Display for ExtendedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Other(b) => write!(f, "unknown extended error 0x{b:02X}"),
            other => f.write_str(other.message()),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// st[11] media type
// ---------------------------------------------------------------------------------------------

/// `st[11]` media type (PROTOCOL.md §4.6.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum MediaType {
    /// `00` no media.
    None,
    /// `01` laminated TZe.
    Laminated,
    /// `03` non-laminated.
    NonLaminated,
    /// `04` fabric.
    Fabric,
    /// `11` heat-shrink 2:1.
    HeatShrink21,
    /// `12` tube (E850TKW).
    Tube,
    /// `13` FLe.
    Fle,
    /// `14` flexible ID.
    FlexibleId,
    /// `15` satin.
    Satin,
    /// `16` self-laminating.
    SelfLaminating,
    /// `17` heat-shrink 3:1.
    HeatShrink31,
    /// `FF` incompatible.
    Incompatible,
    /// Anything else.
    Other(u8),
}

impl MediaType {
    /// Decodes `st[11]`.
    #[must_use]
    pub const fn from_byte(b: u8) -> Self {
        match b {
            0x00 => Self::None,
            0x01 => Self::Laminated,
            0x03 => Self::NonLaminated,
            0x04 => Self::Fabric,
            0x11 => Self::HeatShrink21,
            0x12 => Self::Tube,
            0x13 => Self::Fle,
            0x14 => Self::FlexibleId,
            0x15 => Self::Satin,
            0x16 => Self::SelfLaminating,
            0x17 => Self::HeatShrink31,
            0xFF => Self::Incompatible,
            other => Self::Other(other),
        }
    }

    /// Encodes back to `st[11]`.
    #[must_use]
    pub const fn to_byte(self) -> u8 {
        match self {
            Self::None => 0x00,
            Self::Laminated => 0x01,
            Self::NonLaminated => 0x03,
            Self::Fabric => 0x04,
            Self::HeatShrink21 => 0x11,
            Self::Tube => 0x12,
            Self::Fle => 0x13,
            Self::FlexibleId => 0x14,
            Self::Satin => 0x15,
            Self::SelfLaminating => 0x16,
            Self::HeatShrink31 => 0x17,
            Self::Incompatible => 0xFF,
            Self::Other(b) => b,
        }
    }

    /// `true` unless no cassette (`00`) or an incompatible one (`FF`) is loaded.
    #[must_use]
    pub const fn is_loaded(self) -> bool {
        !matches!(self, Self::None | Self::Incompatible)
    }

    /// English name for UIs.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Self::None => "no media",
            Self::Laminated => "laminated",
            Self::NonLaminated => "non-laminated",
            Self::Fabric => "fabric",
            Self::HeatShrink21 => "heat-shrink tube 2:1",
            Self::Tube => "tube",
            Self::Fle => "FLe",
            Self::FlexibleId => "flexible ID",
            Self::Satin => "satin",
            Self::SelfLaminating => "self-laminating",
            Self::HeatShrink31 => "heat-shrink tube 3:1",
            Self::Incompatible => "incompatible",
            Self::Other(_) => "unknown media",
        }
    }
}

impl fmt::Display for MediaType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Other(b) => write!(f, "unknown media 0x{b:02X}"),
            other => f.write_str(other.name()),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// st[24] tape colour, st[25] text colour
// ---------------------------------------------------------------------------------------------

/// Generates a colour enum's `from_byte`/`to_byte`/`name`/`css` from one table so the four
/// cannot drift apart. `$unknown_*` are used for the `Unknown(u8)` catch-all.
macro_rules! colour_table {
    (
        $ty:ident, unknown_name = $unknown_name:literal, unknown_css = $unknown_css:literal,
        [ $( $code:literal => $variant:ident, $name:literal, $css:literal; )* ]
    ) => {
        impl $ty {
            /// Decodes the status byte (unknown codes → `Unknown(code)`).
            #[must_use]
            pub const fn from_byte(b: u8) -> Self {
                match b {
                    $( $code => Self::$variant, )*
                    other => Self::Unknown(other),
                }
            }

            /// Encodes back to the status byte.
            #[must_use]
            pub const fn to_byte(self) -> u8 {
                match self {
                    $( Self::$variant => $code, )*
                    Self::Unknown(b) => b,
                }
            }

            /// English name for UIs.
            #[must_use]
            pub const fn name(&self) -> &'static str {
                match self {
                    $( Self::$variant => $name, )*
                    Self::Unknown(_) => $unknown_name,
                }
            }

            /// CSS colour (`#rrggbb`) for previews: an approximate swatch, taken from the
            /// P-touch Editor media colour table (`ptemct.ini`) where it has an entry.
            #[must_use]
            pub const fn css(&self) -> &'static str {
                match self {
                    $( Self::$variant => $css, )*
                    Self::Unknown(_) => $unknown_css,
                }
            }
        }

        impl fmt::Display for $ty {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                match self {
                    Self::Unknown(b) => write!(f, "{} (0x{b:02X})", $unknown_name),
                    other => f.write_str(other.name()),
                }
            }
        }
    };
}

/// `st[24]` tape (background) colour (PROTOCOL.md §4.6.3, full table).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[allow(missing_docs)] // variant names are the colour names of the spec table
pub enum TapeColor {
    White,
    Other,
    Clear,
    Red,
    Blue,
    Yellow,
    Green,
    Black,
    ClearWhiteInk,
    PremiumGold,
    PremiumSilver,
    PremiumOther,
    MaskingOther,
    LightBlueSatin,
    MintSatin,
    SilverSatin,
    MatteWhite,
    /// `0x21` (docs/INI say Matte Clear; SDKs say Matte White — resolution: Matte Clear).
    MatteClear,
    MatteSilver,
    SatinGold,
    SatinSilver,
    PastelPurple,
    BlueWhiteInk,
    RedWhiteInk,
    FluorescentOrange,
    FluorescentYellow,
    BerryPink,
    LightGray,
    LimeGreen,
    NavyBlueSatin,
    WineRedSatin,
    YellowFabric,
    PinkFabric,
    BlueFabric,
    WhiteHeatShrinkTube,
    HeatShrinkTube,
    WhiteSelfLaminating,
    WhiteFlexibleId,
    YellowFlexibleId,
    Cleaning,
    Stencil,
    Incompatible,
    /// A code not in the table (the spec says to treat it as "other").
    Unknown(u8),
}

colour_table!(TapeColor, unknown_name = "other", unknown_css = "#fffefe", [
    0x01 => White, "white", "#ffffff";
    0x02 => Other, "other", "#fffefe";
    0x03 => Clear, "clear", "#eefbfe";
    0x04 => Red, "red", "#ff3e4a";
    0x05 => Blue, "blue", "#6699ff";
    0x06 => Yellow, "yellow", "#ffed00";
    0x07 => Green, "green", "#43d1ad";
    0x08 => Black, "black", "#000000";
    0x09 => ClearWhiteInk, "clear (white ink)", "#e1ecee";
    0x0B => PremiumGold, "premium gold", "#b28d12";
    0x0C => PremiumSilver, "premium silver", "#616161";
    0x0D => PremiumOther, "premium other", "#fefffe";
    0x0E => MaskingOther, "masking other", "#fefefe";
    0x0F => LightBlueSatin, "light blue satin", "#b4e4e6";
    0x10 => MintSatin, "mint green satin", "#a4f4ac";
    0x11 => SilverSatin, "silver satin", "#e5e1e1";
    0x20 => MatteWhite, "matte white", "#fffffe";
    0x21 => MatteClear, "matte clear", "#eefbfd";
    0x22 => MatteSilver, "matte silver", "#8b8b8b";
    0x23 => SatinGold, "satin gold", "#fddc77";
    0x24 => SatinSilver, "satin silver", "#8a8b8b";
    0x25 => PastelPurple, "pastel purple", "#c5b4e3";
    0x30 => BlueWhiteInk, "blue (white ink)", "#2f4ea7";
    0x31 => RedWhiteInk, "red (white ink)", "#c40f0f";
    0x40 => FluorescentOrange, "fluorescent orange", "#ff6100";
    0x41 => FluorescentYellow, "fluorescent yellow", "#d7e816";
    0x50 => BerryPink, "berry pink", "#f25ab8";
    0x51 => LightGray, "light gray", "#c3c3c3";
    0x52 => LimeGreen, "lime green", "#7ac143";
    0x53 => NavyBlueSatin, "navy blue satin", "#2c3447";
    0x54 => WineRedSatin, "wine red satin", "#960014";
    0x60 => YellowFabric, "yellow fabric", "#ffffb3";
    0x61 => PinkFabric, "pink fabric", "#ffe7eb";
    0x62 => BlueFabric, "blue fabric", "#badbff";
    0x70 => WhiteHeatShrinkTube, "white heat-shrink tube", "#fffeff";
    0x71 => HeatShrinkTube, "heat-shrink tube", "#fffeff";
    0x80 => WhiteSelfLaminating, "white self-laminating", "#feffff";
    0x90 => WhiteFlexibleId, "white flexible ID", "#fefeff";
    0x91 => YellowFlexibleId, "yellow flexible ID", "#feed00";
    0xF0 => Cleaning, "cleaning", "#ffffff";
    0xF1 => Stencil, "stencil", "#f9f9f9";
    0xFF => Incompatible, "incompatible", "#ffffff";
]);

/// `st[25]` text (ink) colour (PROTOCOL.md §4.6.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[allow(missing_docs)] // variant names are the colour names of the spec table
pub enum TextColor {
    White,
    Other,
    Red,
    Blue,
    Black,
    Gold,
    BlueFabric,
    RedAndBlack,
    Cleaning,
    Stencil,
    Incompatible,
    /// A code not in the table.
    Unknown(u8),
}

colour_table!(TextColor, unknown_name = "other", unknown_css = "#000000", [
    0x01 => White, "white", "#ffffff";
    0x02 => Other, "other", "#000001";
    0x04 => Red, "red", "#ff0000";
    0x05 => Blue, "blue", "#0033ff";
    0x08 => Black, "black", "#000000";
    0x0A => Gold, "gold", "#f2b706";
    0x62 => BlueFabric, "blue (fabric)", "#124688";
    0x81 => RedAndBlack, "red and black", "#000000";
    0xF0 => Cleaning, "cleaning", "#000000";
    0xF1 => Stencil, "stencil", "#000100";
    0xFF => Incompatible, "incompatible", "#000000";
]);

// ---------------------------------------------------------------------------------------------
// st[6] battery
// ---------------------------------------------------------------------------------------------

/// Power source reported by `st[6]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum PowerSource {
    /// Running on battery.
    Battery,
    /// AC adapter connected.
    Ac,
}

impl fmt::Display for PowerSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Battery => "battery",
            Self::Ac => "AC adapter",
        })
    }
}

/// Decoded battery information (PROTOCOL.md §4.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum Battery {
    /// No usable information (reserved byte, unknown format, `FF`, or no battery data).
    Unknown,
    /// Known source and level.
    Level {
        /// Power source.
        source: PowerSource,
        /// Residual charge in percent (0–100), if the encoding carries one.
        percent: Option<u8>,
    },
    /// Source known but no battery mounted (`27`, `37`).
    NoBattery {
        /// Power source.
        source: PowerSource,
    },
}

impl Battery {
    /// Decodes the legacy P900-family encoding: `00`–`03` residual `(3 − b)/3` on battery,
    /// `04` AC with unknown level, anything else unknown.
    #[must_use]
    pub(crate) const fn from_legacy(b: u8) -> Self {
        match b {
            0x00..=0x03 => Self::Level {
                source: PowerSource::Battery,
                // (3 − b) / 3 in percent, rounded to the nearest integer.
                percent: Some(match b {
                    0x00 => 100,
                    0x01 => 67,
                    0x02 => 33,
                    _ => 0,
                }),
            },
            0x04 => Self::Level {
                source: PowerSource::Ac,
                percent: None,
            },
            _ => Self::Unknown,
        }
    }

    /// Decodes the level + AC encoding (P910BT, D4 generation): `2x` on battery, `3x` on AC,
    /// residual `(4 − (b & 7))/4` (clamped at 0), `27`/`37` no battery mounted.
    #[must_use]
    pub(crate) const fn from_level_ac(b: u8) -> Self {
        let source = match b & 0xF8 {
            0x20 => PowerSource::Battery,
            0x30 => PowerSource::Ac,
            _ => return Self::Unknown,
        };
        let level = b & 0x07;
        if level == 0x07 {
            return Self::NoBattery { source };
        }
        let quarters = 4u8.saturating_sub(level);
        Self::Level {
            source,
            percent: Some(quarters * 25),
        }
    }
}

impl fmt::Display for Battery {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unknown => f.write_str("unknown"),
            Self::Level {
                source,
                percent: Some(p),
            } => write!(f, "{p}% ({source})"),
            Self::Level {
                source,
                percent: None,
            } => write!(f, "level unknown ({source})"),
            Self::NoBattery { source } => write!(f, "no battery ({source})"),
        }
    }
}

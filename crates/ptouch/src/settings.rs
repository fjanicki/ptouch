//! Printer-stored settings (PROTOCOL.md §3.6). Pure tables + encode/decode; the transaction
//! state machine lives in [`crate::session`].
//!
//! # Contract
//! - v1 covers three settings ([`SettingId`]): Auto Power On and the two Auto Power Off timers,
//!   on the models whose `settings_profile` is known (models.toml; PROTOCOL.md §3.6.4).
//! - Every byte in the tables is a fact from PROTOCOL.md §3.6.4 ([PST-Mac]); nothing is derived
//!   by formula. Values map to bytes **per profile** through an explicit list of [`Choice`]s:
//!   the P900W-family AC timer is an index (`07` = 2 h) whereas the P910BT USB timer counts
//!   10-minute units (`0C` = 2 h).
//! - A value that is not in the model's list is never encoded ([`SettingSpec::encode_write`]
//!   fails). A reply byte that is not in the list decodes to [`SettingReading::Unlisted`].
//! - Decoding never panics on malformed input; every problem is an [`Error`].
//! - No table entry, prologue or epilogue starts with a sequence of the PROTOCOL.md §3.6.6
//!   "never send" list ([`NEVER_SEND`]; enforced by tests).
//!
//! Hardware-verified (PT-P710BT over USB, 2026-10-16, PROTOCOL.md §8 #34): the P710BT read
//! path and its timer selectors (`00` = USB/AC adapter, `01` = battery, as on every other
//! two-timer model; Brother's Mac definition labels them the other way round).
//!
//! UNVERIFIED on hardware: every write (`ESC i U … 00 …` + `ESC ~ S`), the meaning of
//! `ESC ~ S`, and the 3-byte reply of the P900W family / P910BT (Brother's definition gives
//! only its length and the value offset 2; bytes 0–1 are not checked).

use alloc::string::String;
use alloc::vec::Vec;
use core::fmt;

use crate::error::Error;
use crate::model::{ModelProfile, SettingsProfile};
use crate::status::{STATUS_HEADER, STATUS_LEN};

/// A setting `ptouch` can read and change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "kebab-case"))]
#[non_exhaustive]
pub enum SettingId {
    /// Auto power on: turn on when external power (USB/AC) is connected.
    AutoPowerOn,
    /// Auto power off on external power (P710BT/P715eBT: USB/AC adapter or computer; P900W
    /// family: AC/DC; P910BT: USB connection). Brother's per-model name is
    /// [`SettingSpec::brother_label`]; on the P710BT/P715eBT it comes from the printer's
    /// information report (PROTOCOL.md §3.6.5).
    AutoPowerOff,
    /// Auto power off on battery. Brother's per-model name is [`SettingSpec::brother_label`].
    AutoPowerOffBattery,
}

impl SettingId {
    /// All ids, in display order.
    pub const ALL: [SettingId; 3] = [
        SettingId::AutoPowerOn,
        SettingId::AutoPowerOff,
        SettingId::AutoPowerOffBattery,
    ];

    /// `"auto-power-on"`, `"auto-power-off"`, `"auto-power-off-battery"` (CLI/wasm names).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            SettingId::AutoPowerOn => "auto-power-on",
            SettingId::AutoPowerOff => "auto-power-off",
            SettingId::AutoPowerOffBattery => "auto-power-off-battery",
        }
    }

    /// Inverse of [`SettingId::as_str`]; also accepts `"auto-power-off-li-ion"` as an alias of
    /// the battery id. Case-sensitive.
    #[must_use]
    pub fn parse(s: &str) -> Option<SettingId> {
        match s {
            "auto-power-on" => Some(SettingId::AutoPowerOn),
            "auto-power-off" => Some(SettingId::AutoPowerOff),
            "auto-power-off-battery" | "auto-power-off-li-ion" => {
                Some(SettingId::AutoPowerOffBattery)
            }
            _ => None,
        }
    }

    /// Whether the setting is an on/off switch or a duration.
    #[must_use]
    pub const fn kind(self) -> SettingKind {
        match self {
            SettingId::AutoPowerOn => SettingKind::Toggle,
            SettingId::AutoPowerOff | SettingId::AutoPowerOffBattery => SettingKind::Duration,
        }
    }
}

impl fmt::Display for SettingId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The shape of a setting's values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "kebab-case"))]
#[non_exhaustive]
pub enum SettingKind {
    /// Values are [`SettingValue::Enabled`].
    Toggle,
    /// Values are [`SettingValue::Minutes`].
    Duration,
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

impl SettingValue {
    /// The kind of this value.
    #[must_use]
    pub const fn kind(self) -> SettingKind {
        match self {
            SettingValue::Enabled(_) => SettingKind::Toggle,
            SettingValue::Minutes(_) => SettingKind::Duration,
        }
    }

    /// Parses user input for a setting of `kind` (syntax only; whether the model offers the
    /// value is checked by [`SettingSpec::encode_write`]). ASCII case-insensitive, surrounding
    /// whitespace ignored.
    ///
    /// - [`SettingKind::Toggle`]: values `on|off|enable|disable|enabled|disabled|true|false|yes|no|1|0`.
    /// - [`SettingKind::Duration`]: values `never|none|off|0`, `<n>` (minutes), `<n>min`, `<n>m`,
    ///   `<n>h` (whole hours), with optional spaces before the unit.
    #[must_use]
    pub fn parse(kind: SettingKind, s: &str) -> Option<SettingValue> {
        let t = s.trim();
        let lower = |w: &str| t.eq_ignore_ascii_case(w);
        match kind {
            SettingKind::Toggle => {
                if ["on", "enable", "enabled", "true", "yes", "1"]
                    .iter()
                    .any(|w| lower(w))
                {
                    Some(SettingValue::Enabled(true))
                } else if ["off", "disable", "disabled", "false", "no", "0"]
                    .iter()
                    .any(|w| lower(w))
                {
                    Some(SettingValue::Enabled(false))
                } else {
                    None
                }
            }
            SettingKind::Duration => {
                if ["never", "none", "off"].iter().any(|w| lower(w)) {
                    return Some(SettingValue::Minutes(0));
                }
                let digits = t.bytes().take_while(u8::is_ascii_digit).count();
                let (num, unit) = t.split_at(digits);
                if num.is_empty() {
                    return None;
                }
                let n: u16 = num.parse().ok()?;
                let unit = unit.trim();
                let minutes = if unit.is_empty()
                    || ["min", "mins", "m", "minute", "minutes"]
                        .iter()
                        .any(|w| unit.eq_ignore_ascii_case(w))
                {
                    n
                } else if ["h", "hr", "hour", "hours"]
                    .iter()
                    .any(|w| unit.eq_ignore_ascii_case(w))
                {
                    n.checked_mul(60)?
                } else {
                    return None;
                };
                Some(SettingValue::Minutes(minutes))
            }
        }
    }
}

impl fmt::Display for SettingValue {
    /// `on` / `off`; `never`, `10 min` … `50 min`, then whole hours (`1 h`, `2 h`, …) for
    /// multiples of 60. [`SettingSpec::display_value`] applies the per-model exception
    /// (`60 min` on the P710BT, whose list ends at 60 min).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            SettingValue::Enabled(true) => f.write_str("on"),
            SettingValue::Enabled(false) => f.write_str("off"),
            SettingValue::Minutes(0) => f.write_str("never"),
            SettingValue::Minutes(m) if m >= 60 && m % 60 == 0 => write!(f, "{} h", m / 60),
            SettingValue::Minutes(m) => write!(f, "{m} min"),
        }
    }
}

/// How the printer answers a get (PROTOCOL.md §3.6.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[non_exhaustive]
pub enum ReplyFormat {
    /// 32-byte status frame, `st[18] = F0`, value `st[30]`.
    StatusF0,
    /// 3 bytes, value at offset 2 ([PST-Mac]: `getSize="3" index="2"`). Bytes 0–1 are not
    /// checked: Brother's definition says nothing about them (`01 00`, as in `ESC i X`
    /// replies, is INFERRED only).
    LenValue,
}

impl ReplyFormat {
    /// Reply length in bytes (32 / 3).
    #[must_use]
    #[allow(clippy::len_without_is_empty)]
    pub const fn len(self) -> usize {
        match self {
            ReplyFormat::StatusF0 => STATUS_LEN,
            ReplyFormat::LenValue => 3,
        }
    }
}

/// One allowed value and its wire byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct Choice {
    /// The byte sent in a set and received in a reply.
    pub byte: u8,
    /// The value it stands for.
    pub value: SettingValue,
}

/// How whole hours are displayed for a setting (private table detail).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HourStyle {
    /// `60` → `1 h`.
    Hours,
    /// `60` → `60 min` (the list ends at 60 min).
    Minutes,
}

/// Where [`SettingSpec::brother_label`] comes from (PROTOCOL.md §3.6.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[non_exhaustive]
pub enum LabelSource {
    /// The label of Brother's Printer Setting Tool for this model.
    SettingTool,
    /// The name in the `[Printer Settings]` section of the printer's own printed information
    /// report. Used where the Setting Tool's label is wrong for the model (the PT-P710BT /
    /// P715eBT timers, PROTOCOL.md §8 #34).
    InfoReport,
}

/// One setting on one profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[non_exhaustive]
pub struct SettingSpec {
    /// Which setting.
    pub id: SettingId,
    /// Complete get command, e.g. `1B 69 55 41 01 01`.
    pub get: &'static [u8],
    /// Set command without the value byte, e.g. `1B 69 55 41 00 01`.
    pub set_prefix: &'static [u8],
    /// Reply format of the get.
    pub reply: ReplyFormat,
    /// Allowed values in Brother's order.
    pub choices: &'static [Choice],
    /// Brother's name for this setting on this model (PROTOCOL.md §3.6.5), e.g.
    /// "Auto Power Off (Li-ion)" or, on the PT-P710BT, "AutoPowerOff(Bat)".
    pub brother_label: &'static str,
    /// Where [`SettingSpec::brother_label`] comes from.
    pub label_source: LabelSource,
    #[cfg_attr(feature = "serde", serde(skip))]
    hours: HourStyle,
}

impl SettingSpec {
    /// The get command (`self.get`).
    #[must_use]
    pub const fn encode_read(&self) -> &'static [u8] {
        self.get
    }

    /// `set_prefix + byte`.
    ///
    /// # Errors
    /// [`Error::InvalidInput`] (`"value not offered by this model"`) when `value` is not in
    /// [`SettingSpec::choices`] (also for a value of the wrong kind).
    pub fn encode_write(&self, value: SettingValue) -> Result<Vec<u8>, Error> {
        let byte = self
            .byte_for(value)
            .ok_or(Error::InvalidInput("value not offered by this model"))?;
        let mut v = Vec::with_capacity(self.set_prefix.len() + 1);
        v.extend_from_slice(self.set_prefix);
        v.push(byte);
        Ok(v)
    }

    /// Decodes a complete reply of `self.reply.len()` bytes.
    ///
    /// # Errors
    /// - [`ReplyFormat::StatusF0`]: [`Error::StatusLength`] / [`Error::StatusHeader`] for a
    ///   malformed frame; [`Error::Protocol`] (`"not a settings reply"`) when `st[18] != F0`.
    /// - [`ReplyFormat::LenValue`]: [`Error::Protocol`] (`"bad settings reply"`) unless the
    ///   reply is exactly 3 bytes; the value is `reply[2]`, bytes 0–1 are kept in the raw
    ///   reply but not checked (as Brother's tool does). Telling a status frame apart from the
    ///   reply is the session's job.
    pub fn decode_reply(&self, reply: &[u8]) -> Result<SettingReading, Error> {
        let byte = match self.reply {
            ReplyFormat::StatusF0 => {
                if reply.len() != STATUS_LEN {
                    return Err(Error::StatusLength { got: reply.len() });
                }
                if reply.get(..3) != Some(&STATUS_HEADER[..]) {
                    let b = |i: usize| reply.get(i).copied().unwrap_or(0);
                    return Err(Error::StatusHeader {
                        got: [b(0), b(1), b(2), b(3)],
                    });
                }
                if reply.get(STATUS_TYPE_INDEX) != Some(&SETTINGS_STATUS_TYPE) {
                    return Err(Error::Protocol("not a settings reply"));
                }
                reply
                    .get(STATUS_VALUE_INDEX)
                    .copied()
                    .ok_or(Error::StatusLength { got: reply.len() })?
            }
            ReplyFormat::LenValue => match reply {
                [_, _, v] => *v,
                _ => return Err(Error::Protocol("bad settings reply")),
            },
        };
        Ok(self.reading_for(byte))
    }

    /// The reading a reply byte stands for.
    #[must_use]
    pub fn reading_for(&self, byte: u8) -> SettingReading {
        self.value_for(byte)
            .map_or(SettingReading::Unlisted(byte), SettingReading::Value)
    }

    /// The wire byte of `value`, if the model offers it.
    #[must_use]
    pub fn byte_for(&self, value: SettingValue) -> Option<u8> {
        self.choices
            .iter()
            .find(|c| c.value == value)
            .map(|c| c.byte)
    }

    /// The value of a wire byte, if it is in the model's list.
    #[must_use]
    pub fn value_for(&self, byte: u8) -> Option<SettingValue> {
        self.choices
            .iter()
            .find(|c| c.byte == byte)
            .map(|c| c.value)
    }

    /// Whether the setting is a switch or a duration.
    #[must_use]
    pub const fn kind(&self) -> SettingKind {
        self.id.kind()
    }

    /// Parses user input ([`SettingValue::parse`]) and checks that the model offers it.
    ///
    /// # Errors
    /// [`Error::InvalidInput`]: `"unrecognised setting value"` for bad syntax,
    /// `"value not offered by this model"` for a value outside the list.
    pub fn parse_value(&self, s: &str) -> Result<SettingValue, Error> {
        let v = SettingValue::parse(self.kind(), s)
            .ok_or(Error::InvalidInput("unrecognised setting value"))?;
        self.byte_for(v)
            .map(|_| v)
            .ok_or(Error::InvalidInput("value not offered by this model"))
    }

    /// `value` formatted for this model: like [`SettingValue`]'s `Display`, except that
    /// 60 minutes reads `60 min` where the model's list ends at 60 min (PT-P710BT).
    #[must_use]
    pub fn display_value(&self, value: SettingValue) -> String {
        match (value, self.hours) {
            (SettingValue::Minutes(60), HourStyle::Minutes) => String::from("60 min"),
            _ => alloc::format!("{value}"),
        }
    }

    /// `reading` formatted for this model: the value, or `unknown (0xNN)`.
    #[must_use]
    pub fn display_reading(&self, reading: SettingReading) -> String {
        match reading {
            SettingReading::Value(v) => self.display_value(v),
            SettingReading::Unlisted(b) => alloc::format!("unknown (0x{b:02X})"),
        }
    }

    /// The allowed values formatted for messages, e.g. `never, 10, 20, 30, 40, 50, 60 min`
    /// or `on, off`.
    #[must_use]
    pub fn allowed_values_text(&self) -> String {
        let mut out = String::new();
        let minutes_only = self.choices.iter().all(|c| match c.value {
            SettingValue::Minutes(m) => m < 60 || self.hours == HourStyle::Minutes,
            SettingValue::Enabled(_) => false,
        });
        for (i, c) in self.choices.iter().enumerate() {
            if i > 0 {
                out.push_str(", ");
            }
            match c.value {
                SettingValue::Minutes(m) if minutes_only && m > 0 => {
                    out.push_str(&alloc::format!("{m}"));
                }
                v => out.push_str(&self.display_value(v)),
            }
        }
        if minutes_only {
            out.push_str(" min");
        }
        out
    }
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
    /// Which setting.
    pub id: SettingId,
    /// The decoded value.
    pub reading: SettingReading,
    /// The full reply as received (32 or 3 bytes), for logs and hardware reports.
    pub raw: Vec<u8>,
}

/// `1B 40 1B 69 61 01`: sent before the gets or sets of a transaction.
pub const SETTINGS_PROLOGUE: [u8; 6] = [0x1B, 0x40, 0x1B, 0x69, 0x61, 0x01];
/// `1B 69 61 FF`: ends a read transaction.
pub const SETTINGS_READ_EPILOGUE: [u8; 4] = [0x1B, 0x69, 0x61, 0xFF];
/// `1B 7E 53 1B 69 61 FF`: ends a write transaction (`ESC ~ S` = commit, INFERRED).
pub const SETTINGS_WRITE_EPILOGUE: [u8; 7] = [0x1B, 0x7E, 0x53, 0x1B, 0x69, 0x61, 0xFF];

/// PROTOCOL.md §3.6.6 "never send": factory resets, report/test prints, cleaning, reboot.
/// No byte string this module produces contains any of these (enforced by tests). The
/// P910BT test print `1B 69 21 01 1B 69 11 43 42 …` is covered by its `ESC i DC1 C B` part
/// (`1B 69 21 01` alone is the ordinary status-notification mode command).
pub const NEVER_SEND: &[&[u8]] = &[
    &[0x1B, 0x69, 0x55, 0x58],
    &[0x1B, 0x69, 0x55, 0x69],
    &[0x1B, 0x69, 0x55, 0x5A],
    &[0x1B, 0x69, 0x55, 0x4E],
    &[0x1B, 0x69, 0x55, 0x78],
    &[0x1B, 0x7E, 0x63],
    &[0x1B, 0x7E, 0x52],
    &[0x54, 0x0C],
    &[0x1B, 0x69, 0x61, 0xFA],
    &[0x1B, 0x69, 0x11, 0x43, 0x42],
];

/// `true` if `bytes` contains a [`NEVER_SEND`] sequence anywhere.
#[must_use]
pub fn contains_never_send(bytes: &[u8]) -> bool {
    NEVER_SEND
        .iter()
        .any(|bad| bytes.windows(bad.len()).any(|w| w == *bad))
}

/// `st[18]` of a settings reply.
pub(crate) const SETTINGS_STATUS_TYPE: u8 = 0xF0;
const STATUS_TYPE_INDEX: usize = 18;
const STATUS_VALUE_INDEX: usize = 30;

// ----- tables (PROTOCOL.md §3.6.4) -----

const GET_POWER_ON: &[u8] = &[0x1B, 0x69, 0x55, 0x70, 0x01];
const SET_POWER_ON: &[u8] = &[0x1B, 0x69, 0x55, 0x70, 0x00];
const GET_POWER_OFF_00: &[u8] = &[0x1B, 0x69, 0x55, 0x41, 0x01, 0x00];
const SET_POWER_OFF_00: &[u8] = &[0x1B, 0x69, 0x55, 0x41, 0x00, 0x00];
const GET_POWER_OFF_01: &[u8] = &[0x1B, 0x69, 0x55, 0x41, 0x01, 0x01];
const SET_POWER_OFF_01: &[u8] = &[0x1B, 0x69, 0x55, 0x41, 0x00, 0x01];

const fn on_off(byte: u8, on: bool) -> Choice {
    Choice {
        byte,
        value: SettingValue::Enabled(on),
    }
}

const fn min(byte: u8, minutes: u16) -> Choice {
    Choice {
        byte,
        value: SettingValue::Minutes(minutes),
    }
}

static ON_OFF: [Choice; 2] = [on_off(0x00, false), on_off(0x01, true)];

/// `00` never, `01`–`06` = 10–60 min (P710BT both timers; P900W/P910BT battery timer).
static UP_TO_60: [Choice; 7] = [
    min(0x00, 0),
    min(0x01, 10),
    min(0x02, 20),
    min(0x03, 30),
    min(0x04, 40),
    min(0x05, 50),
    min(0x06, 60),
];

/// P900W family AC/DC timer: an **index** up to 12 h.
static P900W_AC: [Choice; 11] = [
    min(0x00, 0),
    min(0x01, 10),
    min(0x02, 20),
    min(0x03, 30),
    min(0x04, 40),
    min(0x05, 50),
    min(0x06, 60),
    min(0x07, 120),
    min(0x08, 240),
    min(0x09, 480),
    min(0x0A, 720),
];

/// P910BT USB timer: **10-minute units** up to 12 h.
static P910BT_USB: [Choice; 11] = [
    min(0x00, 0),
    min(0x01, 10),
    min(0x02, 20),
    min(0x03, 30),
    min(0x04, 40),
    min(0x05, 50),
    min(0x06, 60),
    min(0x0C, 120),
    min(0x18, 240),
    min(0x30, 480),
    min(0x48, 720),
];

const LABEL_POWER_ON: &str = "Auto Power On";
const LABEL_LI_ION: &str = "Auto Power Off (Li-ion)";

const POWER_ON: SettingSpec = SettingSpec {
    id: SettingId::AutoPowerOn,
    get: GET_POWER_ON,
    set_prefix: SET_POWER_ON,
    reply: ReplyFormat::StatusF0,
    choices: &ON_OFF,
    brother_label: LABEL_POWER_ON,
    label_source: LabelSource::SettingTool,
    hours: HourStyle::Hours,
};

/// PT-P710BT / PT-P715eBT. Selector `00` = USB/AC adapter ("adp"), `01` = battery ("Bat"), as
/// on every other two-timer model: hardware-verified on a PT-P710BT (2026-10-16, a read
/// matched the printer's own information report; PROTOCOL.md §8 #34). Brother's Mac
/// definition pairs the labels the other way round, so the timer rows are named after the
/// information report instead. The PT-P715eBT shares the definition; its mapping is INFERRED
/// from the P710BT.
static P710BT: [SettingSpec; 3] = [
    POWER_ON,
    SettingSpec {
        id: SettingId::AutoPowerOff,
        get: GET_POWER_OFF_00,
        set_prefix: SET_POWER_OFF_00,
        reply: ReplyFormat::StatusF0,
        choices: &UP_TO_60,
        brother_label: "AutoPowerOff(adp)",
        label_source: LabelSource::InfoReport,
        hours: HourStyle::Minutes,
    },
    SettingSpec {
        id: SettingId::AutoPowerOffBattery,
        get: GET_POWER_OFF_01,
        set_prefix: SET_POWER_OFF_01,
        reply: ReplyFormat::StatusF0,
        choices: &UP_TO_60,
        brother_label: "AutoPowerOff(Bat)",
        label_source: LabelSource::InfoReport,
        hours: HourStyle::Minutes,
    },
];

/// PT-P900W, PT-P950NW, PT-D800W, PT-E800W.
static P900W: [SettingSpec; 3] = [
    POWER_ON,
    SettingSpec {
        id: SettingId::AutoPowerOff,
        get: GET_POWER_OFF_00,
        set_prefix: SET_POWER_OFF_00,
        reply: ReplyFormat::LenValue,
        choices: &P900W_AC,
        brother_label: "Auto Power Off (AC/DC)",
        label_source: LabelSource::SettingTool,
        hours: HourStyle::Hours,
    },
    SettingSpec {
        id: SettingId::AutoPowerOffBattery,
        get: GET_POWER_OFF_01,
        set_prefix: SET_POWER_OFF_01,
        reply: ReplyFormat::LenValue,
        choices: &UP_TO_60,
        brother_label: LABEL_LI_ION,
        label_source: LabelSource::SettingTool,
        hours: HourStyle::Hours,
    },
];

/// PT-P910BT.
static P910BT: [SettingSpec; 3] = [
    POWER_ON,
    SettingSpec {
        id: SettingId::AutoPowerOff,
        get: GET_POWER_OFF_00,
        set_prefix: SET_POWER_OFF_00,
        reply: ReplyFormat::LenValue,
        choices: &P910BT_USB,
        brother_label: "Auto Power Off (USB Connection)",
        label_source: LabelSource::SettingTool,
        hours: HourStyle::Hours,
    },
    SettingSpec {
        id: SettingId::AutoPowerOffBattery,
        get: GET_POWER_OFF_01,
        set_prefix: SET_POWER_OFF_01,
        reply: ReplyFormat::LenValue,
        choices: &UP_TO_60,
        brother_label: LABEL_LI_ION,
        label_source: LabelSource::SettingTool,
        hours: HourStyle::Hours,
    },
];

/// The settings of one profile.
#[must_use]
pub fn settings_for_profile(profile: SettingsProfile) -> &'static [SettingSpec] {
    match profile {
        SettingsProfile::P710bt => &P710BT,
        SettingsProfile::P900w => &P900W,
        SettingsProfile::P910bt => &P910BT,
    }
}

/// Every setting the model supports (empty slice when `settings_profile` is `None`).
#[must_use]
pub fn settings_for(profile: &ModelProfile) -> &'static [SettingSpec] {
    profile.settings_profile.map_or(&[], settings_for_profile)
}

/// One setting, or `None` when the model lacks it.
#[must_use]
pub fn setting_spec(profile: &ModelProfile, id: SettingId) -> Option<&'static SettingSpec> {
    settings_for(profile).iter().find(|s| s.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    const ALL_PROFILES: [SettingsProfile; 3] = [
        SettingsProfile::P710bt,
        SettingsProfile::P900w,
        SettingsProfile::P910bt,
    ];

    fn spec(p: SettingsProfile, id: SettingId) -> &'static SettingSpec {
        settings_for_profile(p)
            .iter()
            .find(|s| s.id == id)
            .expect("spec")
    }

    fn f0(value: u8) -> [u8; 32] {
        let mut f = [0u8; 32];
        f[..3].copy_from_slice(&STATUS_HEADER);
        f[3] = 0x30;
        f[4] = 0x76;
        f[18] = 0xF0;
        f[30] = value;
        f
    }

    #[test]
    fn ids_round_trip() {
        for id in SettingId::ALL {
            assert_eq!(SettingId::parse(id.as_str()), Some(id));
        }
        assert_eq!(
            SettingId::parse("auto-power-off-li-ion"),
            Some(SettingId::AutoPowerOffBattery)
        );
        assert_eq!(SettingId::parse("Auto-Power-On"), None);
        assert_eq!(SettingId::parse(""), None);
    }

    #[test]
    fn exact_bytes_per_profile() {
        // P710BT: selector 00 = USB/AC adapter, 01 = battery (hardware, PROTOCOL.md §8 #34).
        let p = spec(SettingsProfile::P710bt, SettingId::AutoPowerOff);
        assert_eq!(p.get, [0x1B, 0x69, 0x55, 0x41, 0x01, 0x00]);
        assert_eq!(
            p.encode_write(SettingValue::Minutes(10)),
            Ok(vec![0x1B, 0x69, 0x55, 0x41, 0x00, 0x00, 0x01])
        );
        let b = spec(SettingsProfile::P710bt, SettingId::AutoPowerOffBattery);
        assert_eq!(b.get, [0x1B, 0x69, 0x55, 0x41, 0x01, 0x01]);
        assert_eq!(
            b.encode_write(SettingValue::Minutes(60)),
            Ok(vec![0x1B, 0x69, 0x55, 0x41, 0x00, 0x01, 0x06])
        );
        let on = spec(SettingsProfile::P710bt, SettingId::AutoPowerOn);
        assert_eq!(on.encode_read(), [0x1B, 0x69, 0x55, 0x70, 0x01]);
        assert_eq!(
            on.encode_write(SettingValue::Enabled(true)),
            Ok(vec![0x1B, 0x69, 0x55, 0x70, 0x00, 0x01])
        );
        // P900W AC index vs P910BT 10-minute units.
        assert_eq!(
            spec(SettingsProfile::P900w, SettingId::AutoPowerOff)
                .encode_write(SettingValue::Minutes(120)),
            Ok(vec![0x1B, 0x69, 0x55, 0x41, 0x00, 0x00, 0x07])
        );
        assert_eq!(
            spec(SettingsProfile::P910bt, SettingId::AutoPowerOff)
                .encode_write(SettingValue::Minutes(120)),
            Ok(vec![0x1B, 0x69, 0x55, 0x41, 0x00, 0x00, 0x0C])
        );
        assert_eq!(
            spec(SettingsProfile::P900w, SettingId::AutoPowerOffBattery).get,
            [0x1B, 0x69, 0x55, 0x41, 0x01, 0x01]
        );
    }

    #[test]
    fn values_outside_the_list_are_rejected() {
        let p = spec(SettingsProfile::P710bt, SettingId::AutoPowerOff);
        let invalid = Err(Error::InvalidInput("value not offered by this model"));
        assert_eq!(p.encode_write(SettingValue::Minutes(70)), invalid);
        assert_eq!(p.encode_write(SettingValue::Minutes(120)), invalid);
        assert_eq!(p.encode_write(SettingValue::Enabled(true)), invalid);
        let on = spec(SettingsProfile::P710bt, SettingId::AutoPowerOn);
        assert_eq!(on.encode_write(SettingValue::Minutes(10)), invalid);
        let bat = spec(SettingsProfile::P900w, SettingId::AutoPowerOffBattery);
        assert_eq!(bat.encode_write(SettingValue::Minutes(120)), invalid);
    }

    #[test]
    fn decode_status_f0() {
        let p = spec(SettingsProfile::P710bt, SettingId::AutoPowerOff);
        assert_eq!(
            p.decode_reply(&f0(0x06)),
            Ok(SettingReading::Value(SettingValue::Minutes(60)))
        );
        assert_eq!(
            p.decode_reply(&f0(0x07)),
            Ok(SettingReading::Unlisted(0x07))
        );
        let mut not_f0 = f0(0x01);
        not_f0[18] = 0x00;
        assert_eq!(
            p.decode_reply(&not_f0),
            Err(Error::Protocol("not a settings reply"))
        );
        assert_eq!(
            p.decode_reply(&f0(0x01)[..31]),
            Err(Error::StatusLength { got: 31 })
        );
        assert_eq!(p.decode_reply(&[]), Err(Error::StatusLength { got: 0 }));
        let mut bad = f0(0x01);
        bad[1] = 0x21;
        assert_eq!(
            p.decode_reply(&bad),
            Err(Error::StatusHeader {
                got: [0x80, 0x21, 0x42, 0x30]
            })
        );
        let on = spec(SettingsProfile::P710bt, SettingId::AutoPowerOn);
        assert_eq!(
            on.decode_reply(&f0(0x01)),
            Ok(SettingReading::Value(SettingValue::Enabled(true)))
        );
        assert_eq!(on.decode_reply(&f0(0x02)), Ok(SettingReading::Unlisted(2)));
    }

    #[test]
    fn decode_len_value() {
        let p = spec(SettingsProfile::P910bt, SettingId::AutoPowerOff);
        assert_eq!(
            p.decode_reply(&[0x01, 0x00, 0x48]),
            Ok(SettingReading::Value(SettingValue::Minutes(720)))
        );
        assert_eq!(
            p.decode_reply(&[0x01, 0x00, 0x07]),
            Ok(SettingReading::Unlisted(0x07))
        );
        // Brother reads only byte 2; bytes 0-1 are not checked.
        assert_eq!(
            p.decode_reply(&[0x00, 0x00, 0x01]),
            Ok(SettingReading::Value(SettingValue::Minutes(10)))
        );
        assert_eq!(
            p.decode_reply(&[0x03, 0x00, 0x03]),
            Ok(SettingReading::Value(SettingValue::Minutes(30)))
        );
        let bad = Err(Error::Protocol("bad settings reply"));
        assert_eq!(p.decode_reply(&[0x01, 0x00]), bad);
        assert_eq!(p.decode_reply(&[0x01, 0x00, 0x01, 0x00]), bad);
        assert_eq!(p.decode_reply(&[]), bad);
        let p9 = spec(SettingsProfile::P900w, SettingId::AutoPowerOff);
        assert_eq!(
            p9.decode_reply(&[0x01, 0x00, 0x07]),
            Ok(SettingReading::Value(SettingValue::Minutes(120)))
        );
    }

    #[test]
    fn tables_are_consistent() {
        for p in ALL_PROFILES {
            let specs = settings_for_profile(p);
            let ids: Vec<SettingId> = specs.iter().map(|s| s.id).collect();
            assert_eq!(ids, SettingId::ALL, "{p:?} order");
            for s in specs {
                assert!(!s.choices.is_empty());
                // Bytes and values are unique; every value has the setting's kind.
                for (i, a) in s.choices.iter().enumerate() {
                    assert_eq!(a.value.kind(), s.kind(), "{p:?} {:?}", s.id);
                    for b in &s.choices[i + 1..] {
                        assert_ne!(a.byte, b.byte, "{p:?} {:?}", s.id);
                        assert_ne!(a.value, b.value, "{p:?} {:?}", s.id);
                    }
                    assert_eq!(s.byte_for(a.value), Some(a.byte));
                    assert_eq!(s.value_for(a.byte), Some(a.value));
                }
                // Get = family + 01 (+ selector); set prefix = family + 00 (+ selector).
                assert_eq!(s.get.len(), s.set_prefix.len());
                assert_eq!(s.get[..4], s.set_prefix[..4]);
                assert_eq!(s.get[4], 0x01);
                assert_eq!(s.set_prefix[4], 0x00);
                assert_eq!(s.get[5..], s.set_prefix[5..]);
            }
            // The two timers use different selectors.
            assert_ne!(specs[1].get, specs[2].get);
        }
    }

    #[test]
    fn never_send_is_unreachable() {
        assert!(!contains_never_send(&SETTINGS_PROLOGUE));
        assert!(!contains_never_send(&SETTINGS_READ_EPILOGUE));
        assert!(!contains_never_send(&SETTINGS_WRITE_EPILOGUE));
        for p in ALL_PROFILES {
            for s in settings_for_profile(p) {
                assert!(!contains_never_send(s.get), "{p:?} {:?}", s.id);
                assert!(!contains_never_send(s.set_prefix), "{p:?} {:?}", s.id);
                for c in s.choices {
                    let w = s.encode_write(c.value).expect("listed");
                    assert!(!contains_never_send(&w), "{p:?} {:?} {w:02X?}", s.id);
                }
            }
        }
        assert!(contains_never_send(&[0x00, 0x1B, 0x69, 0x55, 0x58]));
        // P910BT length/margin test print (PROTOCOL.md §3.6.6).
        assert!(contains_never_send(&[
            0x1B, 0x69, 0x21, 0x01, 0x1B, 0x69, 0x11, 0x43, 0x42, 0x01, 0x02, 0x00, 0x20, 0x80
        ]));
    }

    #[test]
    fn display() {
        assert_eq!(alloc::format!("{}", SettingValue::Enabled(true)), "on");
        assert_eq!(alloc::format!("{}", SettingValue::Minutes(0)), "never");
        assert_eq!(alloc::format!("{}", SettingValue::Minutes(30)), "30 min");
        assert_eq!(alloc::format!("{}", SettingValue::Minutes(60)), "1 h");
        assert_eq!(alloc::format!("{}", SettingValue::Minutes(90)), "90 min");
        assert_eq!(alloc::format!("{}", SettingValue::Minutes(720)), "12 h");
        let p710 = spec(SettingsProfile::P710bt, SettingId::AutoPowerOff);
        assert_eq!(p710.display_value(SettingValue::Minutes(60)), "60 min");
        assert_eq!(
            p710.display_reading(SettingReading::Unlisted(0x0A)),
            "unknown (0x0A)"
        );
        assert_eq!(
            p710.allowed_values_text(),
            "never, 10, 20, 30, 40, 50, 60 min"
        );
        let p900 = spec(SettingsProfile::P900w, SettingId::AutoPowerOff);
        assert_eq!(p900.display_value(SettingValue::Minutes(60)), "1 h");
        assert_eq!(
            p900.allowed_values_text(),
            "never, 10 min, 20 min, 30 min, 40 min, 50 min, 1 h, 2 h, 4 h, 8 h, 12 h"
        );
        let on = spec(SettingsProfile::P900w, SettingId::AutoPowerOn);
        assert_eq!(on.allowed_values_text(), "off, on");
    }

    /// Real PT-P710BT replies (USB, 2026-10-16; HARDWARE-TESTS.md §9 HW-S1). The printer's
    /// own information report showed "AutoPowerOff(adp) = 60 Minutes" and an empty
    /// "AutoPowerOff(Bat)" (never) at the same time.
    const HW_REPLY_POWER_ON: [u8; 32] = [
        0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0xF0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x01, 0x01,
    ];
    /// Reply to `1B 69 55 41 01 01` (selector `01`).
    const HW_REPLY_SEL_01: [u8; 32] = [
        0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0xF0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x01,
    ];
    /// Reply to `1B 69 55 41 01 00` (selector `00`).
    const HW_REPLY_SEL_00: [u8; 32] = [
        0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0xF0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x06, 0x01,
    ];

    /// Regression (PROTOCOL.md §8 #34): the P710BT USB/AC timer is selector `00` and the
    /// battery timer `01`. With the old (Brother Mac tool) pairing the user's "never" on USB
    /// read as the battery value and the printer still switched itself off after 60 min.
    #[test]
    fn p710bt_hardware_replies_decode_to_the_right_timers() {
        let read = |id, get: &[u8], reply: &[u8]| {
            let s = spec(SettingsProfile::P710bt, id);
            assert_eq!(s.encode_read(), get, "{id:?}");
            s.decode_reply(reply)
        };
        assert_eq!(
            read(
                SettingId::AutoPowerOn,
                &[0x1B, 0x69, 0x55, 0x70, 0x01],
                &HW_REPLY_POWER_ON
            ),
            Ok(SettingReading::Value(SettingValue::Enabled(true)))
        );
        assert_eq!(
            read(
                SettingId::AutoPowerOff,
                &[0x1B, 0x69, 0x55, 0x41, 0x01, 0x00],
                &HW_REPLY_SEL_00
            ),
            Ok(SettingReading::Value(SettingValue::Minutes(60)))
        );
        assert_eq!(
            read(
                SettingId::AutoPowerOffBattery,
                &[0x1B, 0x69, 0x55, 0x41, 0x01, 0x01],
                &HW_REPLY_SEL_01
            ),
            Ok(SettingReading::Value(SettingValue::Minutes(0)))
        );
    }

    #[test]
    fn every_profile_uses_selector_00_for_external_power() {
        for p in ALL_PROFILES {
            let ac = spec(p, SettingId::AutoPowerOff);
            let bat = spec(p, SettingId::AutoPowerOffBattery);
            assert_eq!(ac.get, GET_POWER_OFF_00, "{p:?}");
            assert_eq!(ac.set_prefix, SET_POWER_OFF_00, "{p:?}");
            assert_eq!(bat.get, GET_POWER_OFF_01, "{p:?}");
            assert_eq!(bat.set_prefix, SET_POWER_OFF_01, "{p:?}");
        }
    }

    #[test]
    fn labels_name_their_source() {
        let p710 = settings_for_profile(SettingsProfile::P710bt);
        let labels: Vec<(&str, LabelSource)> = p710
            .iter()
            .map(|s| (s.brother_label, s.label_source))
            .collect();
        assert_eq!(
            labels,
            [
                ("Auto Power On", LabelSource::SettingTool),
                ("AutoPowerOff(adp)", LabelSource::InfoReport),
                ("AutoPowerOff(Bat)", LabelSource::InfoReport),
            ]
        );
        for p in [SettingsProfile::P900w, SettingsProfile::P910bt] {
            assert!(
                settings_for_profile(p)
                    .iter()
                    .all(|s| s.label_source == LabelSource::SettingTool),
                "{p:?}"
            );
        }
    }

    #[test]
    fn parse_values() {
        use SettingKind::{Duration, Toggle};
        use SettingValue::{Enabled, Minutes};
        assert_eq!(SettingValue::parse(Toggle, "ON"), Some(Enabled(true)));
        assert_eq!(SettingValue::parse(Toggle, "disable"), Some(Enabled(false)));
        assert_eq!(SettingValue::parse(Toggle, "0"), Some(Enabled(false)));
        assert_eq!(SettingValue::parse(Toggle, "maybe"), None);
        assert_eq!(SettingValue::parse(Duration, "never"), Some(Minutes(0)));
        assert_eq!(SettingValue::parse(Duration, "Off"), Some(Minutes(0)));
        assert_eq!(SettingValue::parse(Duration, "0"), Some(Minutes(0)));
        assert_eq!(SettingValue::parse(Duration, "10"), Some(Minutes(10)));
        assert_eq!(SettingValue::parse(Duration, "10min"), Some(Minutes(10)));
        assert_eq!(SettingValue::parse(Duration, " 10 min "), Some(Minutes(10)));
        assert_eq!(SettingValue::parse(Duration, "2h"), Some(Minutes(120)));
        assert_eq!(SettingValue::parse(Duration, "2 hours"), Some(Minutes(120)));
        assert_eq!(SettingValue::parse(Duration, "h"), None);
        assert_eq!(SettingValue::parse(Duration, "-10"), None);
        assert_eq!(SettingValue::parse(Duration, "10s"), None);
        assert_eq!(SettingValue::parse(Duration, "99999"), None);
        assert_eq!(SettingValue::parse(Duration, "2000h"), None);
        assert_eq!(SettingValue::parse(Duration, ""), None);
        let p710 = spec(SettingsProfile::P710bt, SettingId::AutoPowerOff);
        assert_eq!(p710.parse_value("1h"), Ok(Minutes(60)));
        assert_eq!(
            p710.parse_value("2h"),
            Err(Error::InvalidInput("value not offered by this model"))
        );
        assert_eq!(
            p710.parse_value("soon"),
            Err(Error::InvalidInput("unrecognised setting value"))
        );
    }
}

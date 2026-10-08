//! Media (tape) geometry types (WP1).
//!
//! One [`TapeSpec`] per `[[media]]` entry of `docs/models.toml`. Pin numbering follows
//! PROTOCOL.md §5.1 (normative): pin 0 is the LSB of the **last** byte of a raster line, and
//! the media table gives `left_margin_pins` = pins `[0, left)`, the print area
//! `[left, left + print)` and the right margin `[left + print, head_pins)`.
//! Invariant (checked by the generator and by WP1 tests):
//! `left_margin_pins + print_pins + right_margin_pins == head_pins`.

/// Head geometry family (models.toml `geometry`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum Geometry {
    /// 128-pin head, standard margins (PT-P710BT and most models).
    Pt128,
    /// 128-pin head with PT-P300BT ("PT3") margins.
    Pt3,
    /// 64-pin head (PT-N25BT).
    Aura64,
    /// 560-pin head (PT-P910BT, P900 family).
    Pt560,
}

/// Tape family (models.toml `kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum TapeKind {
    /// TZe laminated/non-laminated and every TZe-geometry variant (fabric, satin, flexible ID).
    Tze,
    /// Heat-shrink tube 2:1 (HSe).
    Hs2,
    /// Heat-shrink tube 3:1.
    Hs3,
    /// Self-laminating tape.
    Sl,
    /// FLe die-cut labels (21 × 45 mm).
    Fle,
}

impl TapeKind {
    /// Geometry key for a status media-type byte `st[11]` (PROTOCOL.md §4.6.1):
    /// `11` → [`TapeKind::Hs2`], `13` → [`TapeKind::Fle`], `17` → [`TapeKind::Hs3`],
    /// `16` → [`TapeKind::Sl`], `00`/`FF`/`12` → `None`, anything else → [`TapeKind::Tze`].
    #[must_use]
    pub const fn from_status_media_type(media_type: u8) -> Option<Self> {
        match media_type {
            0x00 | 0xFF | 0x12 => None,
            0x11 => Some(Self::Hs2),
            0x13 => Some(Self::Fle),
            0x16 => Some(Self::Sl),
            0x17 => Some(Self::Hs3),
            // 01 laminated, 03 non-laminated, 04 fabric, 14 flexible ID, 15 satin, and any
            // undocumented value: TZe geometry. 0x14 is never rejected (§4.6.1).
            _ => Some(Self::Tze),
        }
    }

    /// `true` for heat-shrink tube media (2:1 or 3:1).
    #[must_use]
    pub const fn is_heat_shrink(self) -> bool {
        matches!(self, Self::Hs2 | Self::Hs3)
    }
}

/// Geometry of one tape on one head family.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[non_exhaustive] // generated from docs/models.toml; copy an entry and edit it for test media
pub struct TapeSpec {
    /// Stable id from the TOML, e.g. `"tze128-24"`.
    pub id: &'static str,
    /// Head geometry family.
    pub geometry: Geometry,
    /// Head pins of the family this entry applies to.
    pub head_pins: u16,
    /// Tape family.
    pub kind: TapeKind,
    /// Nominal width in 0.1 mm (3.5 mm → 35).
    pub width_mm_x10: u16,
    /// Width byte as reported in `st[10]` and sent in `ESC i z` n3 (3.5 mm → 4).
    pub media_width_byte: u8,
    /// FLe only: label length in mm (`st[17]`, `ESC i z` n4).
    pub length_mm: Option<u8>,
    /// Expected `st[11]`.
    pub status_media_type: u8,
    /// `ESC i z` n2 at normal resolution.
    pub print_info_media_type: u8,
    /// `ESC i z` n2 in high-resolution / draft mode, if any.
    pub print_info_media_type_high_res: Option<u8>,
    /// Pins `[0, left)`.
    pub left_margin_pins: u16,
    /// Printable pins = required [`crate::Bitmap::height`].
    pub print_pins: u16,
    /// Pins `[left + print, head_pins)`.
    pub right_margin_pins: u16,
    /// Physical tape width in head dots.
    pub tape_width_dots: u16,
    /// Default `ESC i d` for this media (dots, normal resolution).
    pub default_feed_dots: u16,
    /// FLe: physical label length in dots.
    pub physical_length_dots: Option<u16>,
    /// FLe: maximum raster lines per label.
    pub printable_length_dots: Option<u16>,
}

impl TapeSpec {
    /// Printable head pins `[left_margin_pins, left_margin_pins + print_pins)` (PROTOCOL.md
    /// §5.1 numbering: pin 0 is the LSB of the last byte of a raster line).
    #[must_use]
    pub const fn print_area(&self) -> core::ops::Range<u16> {
        self.left_margin_pins..self.left_margin_pins + self.print_pins
    }

    /// `true` when `pin` lies in the printable area.
    #[must_use]
    pub const fn is_printable_pin(&self, pin: u16) -> bool {
        pin >= self.left_margin_pins && pin - self.left_margin_pins < self.print_pins
    }
}

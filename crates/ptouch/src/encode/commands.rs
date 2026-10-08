//! Individual command builders (WP4). Each function appends one command to `out`.
//!
//! # Contract
//! Byte layouts per PROTOCOL.md §3.1–§3.2. Builders do no model gating — that is
//! [`super::encode_job`]'s job — but they do validate field widths (no silent truncation:
//! callers pass already-checked values, and builders take exactly-sized integer types).
//!
//! # Example
//! ```
//! use ptouch::encode::commands;
//!
//! let mut out = Vec::new();
//! commands::margin(&mut out, 14);
//! commands::compression(&mut out, true);
//! assert_eq!(out, [0x1B, 0x69, 0x64, 0x0E, 0x00, 0x4D, 0x02]);
//! ```

use alloc::vec::Vec;

/// `ESC` (0x1B).
const ESC: u8 = 0x1B;
/// `i` (0x69), the second byte of every `ESC i …` command.
const I: u8 = 0x69;

/// `ESC i z` page-position byte n9 (PROTOCOL.md §3.2.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PagePosition {
    /// `00`.
    First,
    /// `01`.
    Other,
    /// `02` (start_next_end models: last page or single page).
    Last,
}

impl PagePosition {
    /// The n9 byte value.
    #[must_use]
    pub const fn to_byte(self) -> u8 {
        match self {
            Self::First => 0x00,
            Self::Other => 0x01,
            Self::Last => 0x02,
        }
    }
}

/// Fields of `ESC i z` (PROTOCOL.md §3.2.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PrintInfo {
    /// n1 valid flags (0x84 normally; |0x02 when n2 must be checked).
    pub valid_flags: u8,
    /// n2 media type.
    pub media_type: u8,
    /// n3 width byte.
    pub width: u8,
    /// n4 length in mm (0 continuous).
    pub length: u8,
    /// n5–n8 raster lines in the page.
    pub lines: u32,
    /// n9.
    pub position: PagePosition,
}

/// `00 × n` invalidate.
pub fn invalidate(out: &mut Vec<u8>, n: u16) {
    out.resize(out.len() + usize::from(n), 0x00);
}

/// `1B 40` initialize.
pub fn initialize(out: &mut Vec<u8>) {
    out.extend_from_slice(&[ESC, 0x40]);
}

/// `1B 69 61 n` switch command mode (`01` raster, `FF` default).
pub fn command_mode(out: &mut Vec<u8>, mode: u8) {
    out.extend_from_slice(&[ESC, I, 0x61, mode]);
}

/// `1B 69 21 n` automatic status notification (`00` = notify).
pub fn status_notification(out: &mut Vec<u8>, notify: bool) {
    out.extend_from_slice(&[ESC, I, 0x21, if notify { 0x00 } else { 0x01 }]);
}

/// `1B 69 7A n1..n10` print information. n10 is always `00` (PROTOCOL.md §3.2.1).
pub fn print_info(out: &mut Vec<u8>, info: &PrintInfo) {
    out.extend_from_slice(&[
        ESC,
        I,
        0x7A,
        info.valid_flags,
        info.media_type,
        info.width,
        info.length,
    ]);
    out.extend_from_slice(&info.lines.to_le_bytes());
    out.extend_from_slice(&[info.position.to_byte(), 0x00]);
}

/// `1B 69 4D n` various mode (bit 6 auto-cut / cut mark, bit 7 mirror).
pub fn various_mode(out: &mut Vec<u8>, n: u8) {
    out.extend_from_slice(&[ESC, I, 0x4D, n]);
}

/// `1B 69 41 n` cut every n labels.
pub fn cut_every(out: &mut Vec<u8>, n: u8) {
    out.extend_from_slice(&[ESC, I, 0x41, n]);
}

/// `1B 69 4B n` advanced mode (bit 2 half cut, bit 3 no-chain, bit 4 special, bit 6 high-res).
pub fn advanced_mode(out: &mut Vec<u8>, n: u8) {
    out.extend_from_slice(&[ESC, I, 0x4B, n]);
}

/// `1B 69 6B 63 nL nH` number of copies.
pub fn copies(out: &mut Vec<u8>, n: u16) {
    out.extend_from_slice(&[ESC, I, 0x6B, 0x63]);
    out.extend_from_slice(&n.to_le_bytes());
}

/// `1B 69 70 01` stored-up (buffered) printing.
pub fn stored_up_print(out: &mut Vec<u8>) {
    out.extend_from_slice(&[ESC, I, 0x70, 0x01]);
}

/// `1B 69 4C 00 01 01` + `1B 69 43 01 FF FF FF` mono line control + colour info.
pub fn mono_color_info(out: &mut Vec<u8>) {
    out.extend_from_slice(&[ESC, I, 0x4C, 0x00, 0x01, 0x01]);
    out.extend_from_slice(&[ESC, I, 0x43, 0x01, 0xFF, 0xFF, 0xFF]);
}

/// `1B 69 64 nL nH` feed margin in dots.
pub fn margin(out: &mut Vec<u8>, dots: u16) {
    out.extend_from_slice(&[ESC, I, 0x64]);
    out.extend_from_slice(&dots.to_le_bytes());
}

/// `4D 00` / `4D 02` compression mode.
pub fn compression(out: &mut Vec<u8>, packbits: bool) {
    out.extend_from_slice(&[0x4D, if packbits { 0x02 } else { 0x00 }]);
}

/// `47 nL nH data` raster line with an already-encoded payload (`data.len() ≤ u16::MAX`).
///
/// A payload longer than `u16::MAX` bytes cannot be expressed; only its first `u16::MAX` bytes
/// are written (with a matching length field, so the stream stays well-formed). The encoder
/// never produces such a payload: an encoded head line is at most 71 bytes.
pub fn raster_line(out: &mut Vec<u8>, data: &[u8]) {
    let len = u16::try_from(data.len()).unwrap_or(u16::MAX);
    out.push(0x47);
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(data.get(..usize::from(len)).unwrap_or(data));
}

/// `5A` all-zero raster line (PackBits mode only).
pub fn zero_line(out: &mut Vec<u8>) {
    out.push(0x5A);
}

/// `0C` print (more pages follow).
pub fn print_page(out: &mut Vec<u8>) {
    out.push(0x0C);
}

/// `1A` print with feed (last page).
pub fn print_last(out: &mut Vec<u8>) {
    out.push(0x1A);
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn build(f: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
        let mut out = Vec::new();
        f(&mut out);
        out
    }

    #[test]
    fn simple_commands() {
        assert_eq!(build(|o| invalidate(o, 3)), [0, 0, 0]);
        assert_eq!(build(|o| invalidate(o, 0)), [0u8; 0]);
        assert_eq!(build(initialize), [0x1B, 0x40]);
        assert_eq!(build(|o| command_mode(o, 0x01)), [0x1B, 0x69, 0x61, 0x01]);
        assert_eq!(build(|o| command_mode(o, 0xFF)), [0x1B, 0x69, 0x61, 0xFF]);
        assert_eq!(
            build(|o| status_notification(o, true)),
            [0x1B, 0x69, 0x21, 0x00]
        );
        assert_eq!(
            build(|o| status_notification(o, false)),
            [0x1B, 0x69, 0x21, 0x01]
        );
        assert_eq!(build(|o| various_mode(o, 0xC0)), [0x1B, 0x69, 0x4D, 0xC0]);
        assert_eq!(build(|o| cut_every(o, 1)), [0x1B, 0x69, 0x41, 0x01]);
        assert_eq!(build(|o| advanced_mode(o, 0x18)), [0x1B, 0x69, 0x4B, 0x18]);
        assert_eq!(
            build(|o| copies(o, 0x0102)),
            [0x1B, 0x69, 0x6B, 0x63, 0x02, 0x01]
        );
        assert_eq!(build(stored_up_print), [0x1B, 0x69, 0x70, 0x01]);
        assert_eq!(
            build(mono_color_info),
            [
                0x1B, 0x69, 0x4C, 0x00, 0x01, 0x01, 0x1B, 0x69, 0x43, 0x01, 0xFF, 0xFF, 0xFF
            ]
        );
        assert_eq!(build(|o| margin(o, 14)), [0x1B, 0x69, 0x64, 0x0E, 0x00]);
        assert_eq!(build(|o| margin(o, 0x0384)), [0x1B, 0x69, 0x64, 0x84, 0x03]);
        assert_eq!(build(|o| compression(o, true)), [0x4D, 0x02]);
        assert_eq!(build(|o| compression(o, false)), [0x4D, 0x00]);
        assert_eq!(build(zero_line), [0x5A]);
        assert_eq!(build(print_page), [0x0C]);
        assert_eq!(build(print_last), [0x1A]);
    }

    #[test]
    fn print_info_layout() {
        let info = PrintInfo {
            valid_flags: 0x84,
            media_type: 0x00,
            width: 24,
            length: 0,
            lines: 0x0000_02AA,
            position: PagePosition::Other,
        };
        assert_eq!(
            build(|o| print_info(o, &info)),
            [
                0x1B, 0x69, 0x7A, 0x84, 0x00, 0x18, 0x00, 0xAA, 0x02, 0x00, 0x00, 0x01, 0x00
            ]
        );
        let info = PrintInfo {
            lines: 0x0403_0201,
            position: PagePosition::Last,
            ..info
        };
        let bytes = build(|o| print_info(o, &info));
        assert_eq!(bytes.get(7..13), Some(&[1, 2, 3, 4, 2, 0][..]));
    }

    #[test]
    fn page_position_bytes() {
        assert_eq!(PagePosition::First.to_byte(), 0);
        assert_eq!(PagePosition::Other.to_byte(), 1);
        assert_eq!(PagePosition::Last.to_byte(), 2);
    }

    #[test]
    fn raster_line_layout() {
        assert_eq!(
            build(|o| raster_line(o, &[0xF1, 0x00])),
            [0x47, 0x02, 0x00, 0xF1, 0x00]
        );
        let data = vec![0xAB; 70];
        let bytes = build(|o| raster_line(o, &data));
        assert_eq!(bytes.len(), 73);
        assert_eq!(bytes.get(..3), Some(&[0x47, 70, 0][..]));
        // Oversized payloads are clipped consistently with the length field.
        let big = vec![0u8; usize::from(u16::MAX) + 5];
        let bytes = build(|o| raster_line(o, &big));
        assert_eq!(bytes.len(), 3 + usize::from(u16::MAX));
        assert_eq!(bytes.get(..3), Some(&[0x47, 0xFF, 0xFF][..]));
    }

    #[test]
    fn builders_append() {
        let mut out = vec![0xEE];
        initialize(&mut out);
        print_last(&mut out);
        assert_eq!(out, [0xEE, 0x1B, 0x40, 0x1A]);
    }
}

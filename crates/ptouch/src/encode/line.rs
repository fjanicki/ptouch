//! Bitmap line → head line pin mapping (WP4).
//!
//! # Contract (PROTOCOL.md §5.1, normative)
//! - A head line is `profile.bytes_per_line` bytes. Transmitted bit `t` (t = 0 is the MSB of
//!   byte 0, counting MSB-first) drives pin `head_pins − 1 − t`.
//! - Bitmap dot `p` (0 ≤ p < `print_pins`) of a line goes to pin `left_margin_pins + p`,
//!   i.e. transmitted bit `right_margin_pins + (print_pins − 1 − p)`.
//! - Everything outside the print area is zero.
//! - Worked example (P710BT 12 mm, all 70 dots set):
//!   `00 00 00 07 FF FF FF FF FF FF FF FF E0 00 00 00`.

use crate::model::TapeSpec;

/// Writes bitmap line `src` (packed MSB-first, `tape.print_pins` dots) into `dst`
/// (`head_pins / 8` bytes, cleared first) per the module contract.
///
/// Out-of-range input is clipped, never panics: extra source dots are ignored and a short
/// `dst` receives only the bits that fit.
///
/// ```
/// let tape = ptouch::profile(ptouch::Model::PtP710bt)
///     .and_then(|p| p.media.iter().copied().find(|t| t.id == "tze128-12"))
///     .unwrap();
/// let src = [0xFF; 9]; // 70 dots set (and two padding bits, ignored)
/// let mut dst = [0u8; 16];
/// ptouch::encode::line::head_line(&src, tape, &mut dst);
/// assert_eq!(
///     dst,
///     [0x00, 0x00, 0x00, 0x07, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xE0, 0x00, 0x00, 0x00]
/// );
/// ```
pub fn head_line(src: &[u8], tape: &TapeSpec, dst: &mut [u8]) {
    dst.fill(0);
    let print = usize::from(tape.print_pins);
    let right = usize::from(tape.right_margin_pins);
    // Only dots that exist in `src` (and in the print area) are considered.
    let dots = print.min(src.len().saturating_mul(8));
    for (byte_index, &byte) in src.iter().enumerate() {
        if byte == 0 {
            continue;
        }
        for bit in 0..8 {
            if byte & (0x80 >> bit) == 0 {
                continue;
            }
            let p = byte_index * 8 + bit;
            if p >= dots {
                return;
            }
            // p < print, so `print - 1 - p` cannot underflow.
            let t = right + (print - 1 - p);
            if let Some(b) = dst.get_mut(t / 8) {
                *b |= 0x80 >> (t % 8);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Geometry, TapeKind};

    fn tape(left: u16, print: u16, right: u16) -> TapeSpec {
        TapeSpec {
            id: "test",
            geometry: Geometry::Pt128,
            head_pins: left + print + right,
            kind: TapeKind::Tze,
            width_mm_x10: 0,
            media_width_byte: 0,
            length_mm: None,
            status_media_type: 0x01,
            print_info_media_type: 0x01,
            print_info_media_type_high_res: None,
            left_margin_pins: left,
            print_pins: print,
            right_margin_pins: right,
            tape_width_dots: print,
            default_feed_dots: 14,
            physical_length_dots: None,
            printable_length_dots: None,
        }
    }

    #[test]
    fn worked_example_12mm() {
        let t = tape(29, 70, 29);
        let mut dst = [0xAAu8; 16];
        head_line(&[0xFF; 9], &t, &mut dst);
        assert_eq!(
            dst,
            [
                0x00, 0x00, 0x00, 0x07, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xE0, 0x00,
                0x00, 0x00
            ]
        );
    }

    #[test]
    fn short_src_and_dst_are_clipped() {
        let t = tape(0, 128, 0);
        // dot 0 → bit 127 (LSB of byte 15), which does not fit an 8-byte dst.
        let mut dst = [0u8; 8];
        head_line(&[0x80], &t, &mut dst);
        assert_eq!(dst, [0; 8]);
        // dot 127 → bit 0 (MSB of byte 0).
        let mut src = [0u8; 16];
        src[15] = 0x01;
        head_line(&src, &t, &mut dst);
        assert_eq!(dst, [0x80, 0, 0, 0, 0, 0, 0, 0]);
        // empty src leaves a cleared line.
        let mut dst = [0xFFu8; 16];
        head_line(&[], &t, &mut dst);
        assert_eq!(dst, [0; 16]);
    }
}

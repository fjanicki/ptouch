//! Built-in test labels.
//!
//! # Contract (ARCHITECTURE.md §5.1, PROTOCOL.md §5.3/§9.1)
//! - `orientation`: the PROTOCOL.md §9.1 test — a solid bar on rows 0–7 (pins `left`…`left+7`;
//!   pins 0–7 on 24 mm) for canvas columns 0–49, then a bar on the last 8 rows for columns
//!   50–99 — plus a 1-dot line along row 0 for the whole label, the word "START" at x = 0,
//!   asymmetric glyphs ("F", "R", "7") and an arrow pointing to increasing x, so a photo
//!   of the printed label shows which physical edge/end canvas top/left map to, and whether
//!   output is mirrored. Bar lengths and thickness scale with `dpi` (values above are for
//!   180 dpi) and shrink on narrow tapes.
//!   Result on PT-P710BT (24 mm, 2026-10-08, PROTOCOL.md §5.3): with the core's feed order
//!   (last column first) the label must read exactly like `--preview`: row-0 line and the
//!   short thick bar at the top edge, "START" upright at the left end, arrow pointing right.
//!   Before the feed order was applied it printed mirrored along the tape.
//! - `ruler`: ticks every 1 mm / 5 mm / 10 mm along the length (180 dpi → 7.087 dots/mm,
//!   each tick rounded from its own mm value, so errors do not accumulate), numbers every
//!   10 mm, border lines on the first and last printable rows, plus a pin ruler across the
//!   tape (tick every 8 dots, longer every 32) to measure the real printable area
//!   (PROTOCOL.md §5.2 conflict on 9/12 mm).
//! - Deterministic output (used for goldens).

use ptouch::{Bitmap, TapeSpec};

use super::font5x7;
use super::mm_to_dots;

/// Draws `text` with the built-in font at integer `scale`, top-left at (`x`, `y`). Returns
/// the x just past the text.
fn draw_text(bm: &mut Bitmap, text: &str, x: u32, y: u32, scale: u32) -> u32 {
    let advance = (font5x7::GLYPH_WIDTH + 1) * scale;
    let mut pen = x;
    for c in text.chars() {
        for gy in 0..font5x7::GLYPH_HEIGHT {
            for gx in 0..font5x7::GLYPH_WIDTH {
                if font5x7::dot(c, gx, gy) {
                    fill(bm, pen + gx * scale, y + gy * scale, scale, scale);
                }
            }
        }
        pen += advance;
    }
    pen.saturating_sub(scale)
}

/// Width of `text` in dots at `scale`.
fn text_width(text: &str, scale: u32) -> u32 {
    let n = u32::try_from(text.chars().count()).unwrap_or(0);
    (n * (font5x7::GLYPH_WIDTH + 1)).saturating_sub(1) * scale
}

/// Fills a `w`×`h` rectangle (clipped).
fn fill(bm: &mut Bitmap, x: u32, y: u32, w: u32, h: u32) {
    for yy in y..y.saturating_add(h) {
        let Ok(yy) = u16::try_from(yy) else { break };
        for xx in x..x.saturating_add(w) {
            bm.set(xx, yy, true);
        }
    }
}

/// Scales a 180-dpi dot count to `dpi`.
fn at_dpi(dots_180: u32, dpi: u16) -> u32 {
    (dots_180 * u32::from(dpi) / 180).max(1)
}

/// Orientation test pattern for `tape` at `dpi` (feed resolution).
#[must_use]
pub fn orientation(tape: &TapeSpec, dpi: u16) -> Bitmap {
    let h = u32::from(tape.print_pins).max(1);
    let bar = at_dpi(8, dpi).min((h / 4).max(1));
    let bar_len = at_dpi(50, dpi);
    let gap = (bar / 4).max(1);
    let band_top = bar + gap;
    let band_h = h.saturating_sub(2 * (bar + gap));

    // Text: two lines ("START" / "F R 7") when they fit, else one line, else none.
    let two_line_scale = band_h / (2 * font5x7::GLYPH_HEIGHT + 2);
    let one_line_scale = band_h / font5x7::GLYPH_HEIGHT;
    let cap = (h / 16).max(1);
    let (lines, scale): (&[&str], u32) = if two_line_scale >= 2 {
        (&["START", "F R 7"], two_line_scale.min(cap))
    } else if one_line_scale >= 1 {
        (&["START F R 7"], one_line_scale.min(cap))
    } else {
        (&[], 0)
    };
    let text_h = if lines.is_empty() {
        0
    } else {
        let n = u32::try_from(lines.len()).unwrap_or(1);
        n * font5x7::GLYPH_HEIGHT * scale + (n - 1) * 2 * scale
    };
    let text_w = lines
        .iter()
        .map(|l| text_width(l, scale))
        .max()
        .unwrap_or(0);

    // Arrow after the text, as tall as the band.
    let arrow_h = band_h.max(3);
    let arrow_x = if text_w > 0 {
        text_w + 2 * scale.max(2)
    } else {
        0
    };
    let arrow_len = arrow_h * 3 / 2;
    let length = (2 * bar_len).max(arrow_x + arrow_len + 1);
    let height = u16::try_from(h).unwrap_or(u16::MAX);
    let mut bm = Bitmap::new(length, height);

    // §9.1 bars: rows [0, bar) for lines [0, bar_len); last rows for [bar_len, 2·bar_len).
    fill(&mut bm, 0, 0, bar_len, bar);
    fill(&mut bm, bar_len, h - bar, bar_len, bar);
    // Row-0 edge line along the whole label (pin `left_margin_pins`).
    fill(&mut bm, 0, 0, length, 1);

    // Text, vertically centred in the band, starting at x = 0.
    let mut y = band_top + band_h.saturating_sub(text_h) / 2;
    for line in lines {
        draw_text(&mut bm, line, 0, y, scale);
        y += (font5x7::GLYPH_HEIGHT + 2) * scale;
    }

    // Arrow → (increasing x): shaft + triangular head.
    if band_h >= 3 {
        let mid = band_top + band_h / 2;
        let shaft_t = (arrow_h / 5).max(1);
        let head_len = arrow_h / 2;
        let shaft_len = arrow_len - head_len;
        fill(&mut bm, arrow_x, mid - shaft_t / 2, shaft_len, shaft_t);
        for i in 0..=head_len {
            // Half-height of the head shrinks linearly to the tip.
            let half = (arrow_h / 2) * (head_len - i) / head_len.max(1);
            fill(
                &mut bm,
                arrow_x + shaft_len + i,
                mid - half,
                1,
                2 * half + 1,
            );
        }
    }
    bm
}

/// Tick lengths (1 mm, 5 mm, 10 mm) across the tape for a print height.
fn tick_lengths(h: u32) -> (u32, u32, u32) {
    ((h / 8).max(2), (h / 5).max(3), (h * 2 / 5).max(4))
}

/// Position of the `mm` tick (rounded independently: no cumulative error).
#[must_use]
pub fn tick_x(mm: u16, dpi: u16) -> u32 {
    mm_to_dots(f64::from(mm), dpi)
}

/// Ruler test pattern of `length_mm` for `tape` at `dpi` (feed resolution).
#[must_use]
pub fn ruler(tape: &TapeSpec, dpi: u16, length_mm: u16) -> Bitmap {
    let h = u32::from(tape.print_pins).max(1);
    let (t1, t5, t10) = tick_lengths(h);
    let ruler_len = tick_x(length_mm, dpi) + 1;
    let digit_scale = ((h.saturating_sub(t5 + 4)) / (2 * font5x7::GLYPH_HEIGHT)).clamp(1, 4);
    let label_room = h >= t5 + 2 + font5x7::GLYPH_HEIGHT;

    // Pin ruler segment after the mm ruler (and after the last number, which may overhang).
    let labels_end = if label_room {
        (0..=length_mm)
            .step_by(10)
            .map(|mm| tick_x(mm, dpi) + 2 + text_width(&mm.to_string(), digit_scale))
            .max()
            .unwrap_or(0)
    } else {
        0
    };
    let pin_x = ruler_len.max(labels_end) + 8;
    let pin_numbers = h >= 32;
    let length = pin_x
        + if pin_numbers {
            9 + text_width("000", 1) + 2
        } else {
            10
        };
    let height = u16::try_from(h).unwrap_or(u16::MAX);
    let mut bm = Bitmap::new(length, height);

    // Borders on the first and last printable rows.
    fill(&mut bm, 0, 0, ruler_len, 1);
    fill(&mut bm, 0, h - 1, ruler_len, 1);

    for mm in 0..=length_mm {
        let x = tick_x(mm, dpi);
        let t = if mm % 10 == 0 {
            t10
        } else if mm % 5 == 0 {
            t5
        } else {
            t1
        };
        fill(&mut bm, x, 0, 1, t);
        if mm % 10 == 0 && label_room {
            draw_text(&mut bm, &mm.to_string(), x + 2, t5 + 2, digit_scale);
        }
    }

    // Pin ruler: a line across the whole print height with ticks every 8 dots.
    fill(&mut bm, pin_x, 0, 1, h);
    for y in (0..h).step_by(8).chain(std::iter::once(h - 1)) {
        let len = if y % 32 == 0 || y == h - 1 { 8 } else { 4 };
        fill(&mut bm, pin_x + 1, y, len, 1);
        if pin_numbers && y % 32 == 0 && y + 1 + font5x7::GLYPH_HEIGHT < h {
            draw_text(&mut bm, &y.to_string(), pin_x + 10, y + 1, 1);
        }
    }
    bm
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tape(mm: u8) -> &'static TapeSpec {
        let p = ptouch::model::profile_by_name("PT-P710BT").unwrap();
        ptouch::tape_spec(p, mm, ptouch::TapeKind::Tze).unwrap()
    }

    #[test]
    fn orientation_bars_per_spec_9_1() {
        let t = tape(24);
        let bm = orientation(t, 180);
        assert_eq!(bm.height(), 128);
        // Bar on rows 0–7 for lines 0–49, nothing there afterwards (except the row-0 line).
        for x in 0..50 {
            assert!((0..8).all(|y| bm.get(x, y)), "line {x}");
            assert!(!bm.get(x, 127));
        }
        for x in 50..100 {
            assert!((120..128).all(|y| bm.get(x, y)), "line {x}");
            assert!(bm.get(x, 0) && !(1..8).any(|y| bm.get(x, y)));
        }
        // Row-0 line runs the whole label.
        assert!((0..bm.length()).all(|x| bm.get(x, 0)));
        // "START" begins at x = 0 inside the band.
        assert!((10..118).any(|y| bm.get(0, y)));
        assert!(bm.length() > 100);
    }

    #[test]
    fn orientation_fits_every_width() {
        for mm in [4u8, 6, 9, 12, 18, 24] {
            let t = tape(mm);
            let bm = orientation(t, 180);
            assert_eq!(bm.height(), t.print_pins);
            assert!(bm.length() >= 100);
        }
    }

    #[test]
    fn ruler_ticks_at_180_dpi() {
        let t = tape(24);
        let (t1, t5, t10) = tick_lengths(128);
        let bm = ruler(t, 180, 60);
        assert_eq!(tick_x(10, 180), 71);
        assert_eq!(tick_x(1, 180), 7);
        assert_eq!(tick_x(5, 180), 35);
        assert_eq!(tick_x(60, 180), 425);
        // 10 mm tick: t10 rows below the border.
        assert!((0..t10).all(|y| bm.get(71, y as u16)));
        assert!(!bm.get(71, t10 as u16));
        assert!(!bm.get(70, 1) && !bm.get(72, 1));
        assert!((0..t1).all(|y| bm.get(7, y as u16)) && !bm.get(7, t1 as u16));
        assert!((0..t5).all(|y| bm.get(35, y as u16)) && !bm.get(35, t5 as u16));
        // Borders on the first and last printable row.
        assert!(bm.get(200, 0) && bm.get(200, 127));
        // Pin ruler line spans the full height (after the overhanging "60").
        let pin_x = 425 + 2 + text_width("60", 4) + 8;
        assert!((0..128).all(|y| bm.get(pin_x, y)));
    }

    #[test]
    fn ruler_is_deterministic_and_fits_narrow_tape() {
        let t = tape(4);
        assert_eq!(ruler(t, 180, 30), ruler(t, 180, 30));
        assert_eq!(ruler(t, 180, 30).height(), 24);
    }
}

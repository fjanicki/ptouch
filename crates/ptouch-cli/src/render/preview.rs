//! Label previews: ASCII art for the terminal and a PNG file.
//!
//! Both show the bitmap in canvas orientation (x along the label, row 0 at the top), i.e.
//! the label as it reads when printed (column 0 = left end with the text upright; \[HW\]
//! orientation test label, PT-P710BT), without printing anything. The core encoder sends
//! these dots in the model's feed order (last column first, PROTOCOL.md §5.3), so neither the
//! preview nor `decode` (which undoes that order) shows a reversed image.

use std::path::Path;

use ptouch::Bitmap;

use crate::error::CliError;

/// Widest ASCII preview in characters before it is downscaled.
pub const MAX_ASCII_COLUMNS: u32 = 120;

/// Renders `bm` with Unicode half blocks (two rows per text line), framed. The bitmap is
/// downscaled by an integer factor (any ink in a cell counts) so it is at most `max_cols`
/// characters wide.
#[must_use]
pub fn ascii(bm: &Bitmap, max_cols: u32) -> String {
    let factor = bm.length().div_ceil(max_cols.max(1)).max(1);
    let cols = bm.length().div_ceil(factor);
    let rows = u32::from(bm.height()).div_ceil(factor);
    let cell = |cx: u32, cy: u32| -> bool {
        (0..factor).any(|dy| {
            let y = cy * factor + dy;
            u16::try_from(y).is_ok_and(|y| (0..factor).any(|dx| bm.get(cx * factor + dx, y)))
        })
    };
    let mut out = String::new();
    let border: String = "─".repeat(cols as usize);
    out.push('┌');
    out.push_str(&border);
    out.push_str("┐\n");
    for ty in 0..rows.div_ceil(2) {
        out.push('│');
        for cx in 0..cols {
            let top = cell(cx, ty * 2);
            let bottom = ty * 2 + 1 < rows && cell(cx, ty * 2 + 1);
            out.push(match (top, bottom) {
                (true, true) => '█',
                (true, false) => '▀',
                (false, true) => '▄',
                (false, false) => ' ',
            });
        }
        out.push_str("│\n");
    }
    out.push('└');
    out.push_str(&border);
    out.push('┘');
    if factor > 1 {
        out.push_str(&format!("  (1:{factor})"));
    }
    out.push('\n');
    out
}

/// Colours and geometry for [`write_png`].
#[derive(Debug, Clone, Copy)]
pub struct PngStyle {
    /// Tape (background) colour, `0xRRGGBB`.
    pub tape_rgb: u32,
    /// Ink colour, `0xRRGGBB`.
    pub ink_rgb: u32,
    /// Blank lines drawn before and after the content (feed margins).
    pub margin_dots: u32,
    /// Extra tape drawn on each edge across the tape (outside the print area).
    pub edge_dots: u32,
    /// Integer magnification.
    pub scale: u32,
}

impl Default for PngStyle {
    fn default() -> Self {
        Self {
            tape_rgb: 0xFF_FF_FF,
            ink_rgb: 0x00_00_00,
            margin_dots: 0,
            edge_dots: 0,
            scale: 4,
        }
    }
}

/// Builds the RGB8 pixels of the preview (width, height, data).
#[must_use]
pub fn rgb_pixels(bm: &Bitmap, style: &PngStyle) -> (u32, u32, Vec<u8>) {
    let s = style.scale.clamp(1, 16);
    let w = (bm.length() + 2 * style.margin_dots) * s;
    let h = (u32::from(bm.height()) + 2 * style.edge_dots) * s;
    let rgb = |c: u32| [(c >> 16) as u8, (c >> 8) as u8, c as u8];
    let (tape, ink) = (rgb(style.tape_rgb), rgb(style.ink_rgb));
    let mut data = Vec::with_capacity((w * h * 3) as usize);
    for py in 0..h {
        let y = (py / s).checked_sub(style.edge_dots);
        for px in 0..w {
            let x = (px / s).checked_sub(style.margin_dots);
            let on = match (x, y) {
                (Some(x), Some(y)) => u16::try_from(y).is_ok_and(|y| bm.get(x, y)),
                _ => false,
            };
            data.extend_from_slice(if on { &ink } else { &tape });
        }
    }
    (w, h, data)
}

/// Writes the preview PNG.
///
/// # Errors
/// [`CliError::File`] on I/O or encoding failure.
pub fn write_png(bm: &Bitmap, path: &Path, style: &PngStyle) -> Result<(), CliError> {
    let (w, h, data) = rgb_pixels(bm, style);
    let err =
        |e: &dyn std::fmt::Display| CliError::file(path, std::io::Error::other(e.to_string()));
    let file = std::fs::File::create(path).map_err(|e| CliError::file(path, e))?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w.max(1), h.max(1));
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Eight);
    let mut writer = enc.write_header().map_err(|e| err(&e))?;
    writer.write_image_data(&data).map_err(|e| err(&e))?;
    writer.finish().map_err(|e| err(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_half_blocks() {
        let mut bm = Bitmap::new(3, 3);
        bm.set(0, 0, true);
        bm.set(1, 1, true);
        bm.set(2, 0, true);
        bm.set(2, 1, true);
        bm.set(2, 2, true);
        let s = ascii(&bm, 120);
        assert_eq!(s, "┌───┐\n│▀▄█│\n│  ▀│\n└───┘\n");
    }

    #[test]
    fn ascii_downscales_long_labels() {
        let bm = Bitmap::new(1000, 128);
        let s = ascii(&bm, 100);
        let first = s.lines().next().unwrap();
        assert_eq!(first.chars().count(), 100 + 2);
        assert!(s.contains("(1:10)"));
    }

    #[test]
    fn pixels_with_margins() {
        let mut bm = Bitmap::new(1, 1);
        bm.set(0, 0, true);
        let style = PngStyle {
            margin_dots: 1,
            scale: 1,
            ..PngStyle::default()
        };
        let (w, h, data) = rgb_pixels(&bm, &style);
        assert_eq!((w, h), (3, 1));
        assert_eq!(data, vec![255, 255, 255, 0, 0, 0, 255, 255, 255]);
    }
}

//! CLI-side rendering to `ptouch::Bitmap`. The browser studio renders in Canvas2D; this
//! is only for the CLI (text, images, test labels, previews).
//!
//! All renderers produce bitmaps in print order with `height == tape.print_pins` and use the
//! core's `Bitmap`/`dither` APIs — no protocol knowledge. Canvas coordinates: x runs along the
//! label (one raster line per x), y across the tape (row 0 → pin `left_margin_pins`).

pub mod font5x7;
pub mod fonts;
pub mod image;
pub mod preview;
pub mod test_labels;
pub mod text;

use ptouch::Bitmap;

use crate::cli::Align;
use crate::error::CliError;

/// Millimetres → dots at `dpi`, rounded to the nearest dot.
#[must_use]
pub fn mm_to_dots(mm: f64, dpi: u16) -> u32 {
    let dots = (mm * f64::from(dpi) / 25.4).round();
    if dots.is_finite() && dots > 0.0 {
        // Saturating float → int conversion is the intent here.
        dots.min(f64::from(u32::MAX)) as u32
    } else {
        0
    }
}

/// Adds `before` and `after` blank lines along the label.
#[must_use]
pub fn pad_length(bm: &Bitmap, before: u32, after: u32) -> Bitmap {
    if before == 0 && after == 0 {
        return bm.clone();
    }
    let stride = bm.stride();
    let total = bm.length().saturating_add(before).saturating_add(after);
    let mut data = vec![0u8; usize::try_from(before).unwrap_or(0) * stride];
    data.extend_from_slice(bm.as_packed());
    data.resize(usize::try_from(total).unwrap_or(0) * stride, 0);
    Bitmap::from_packed(total, bm.height(), data)
        .unwrap_or_else(|_| Bitmap::new(total, bm.height()))
}

/// Places `bm` in a label of exactly `length` lines, aligned per `align`.
///
/// # Errors
/// [`CliError::Usage`] when the content is longer than `length`.
pub fn fit_length(bm: &Bitmap, length: u32, align: Align) -> Result<Bitmap, CliError> {
    let Some(free) = length.checked_sub(bm.length()) else {
        return Err(CliError::Usage(format!(
            "the content is {} dots long and does not fit in the requested length of {length} dots",
            bm.length()
        )));
    };
    let before = match align {
        Align::Left => 0,
        Align::Center => free / 2,
        Align::Right => free,
    };
    Ok(pad_length(bm, before, free - before))
}

/// Builds a bitmap from a row-major coverage grid (`width` along the label, `height` across):
/// ink where coverage ≥ `threshold`.
#[must_use]
pub fn from_coverage(coverage: &[u8], width: u32, height: u16, threshold: u8) -> Bitmap {
    let mut bm = Bitmap::new(width, height);
    let w = usize::try_from(width).unwrap_or(0);
    if w == 0 {
        return bm;
    }
    for (y, row) in (0..height).zip(coverage.chunks_exact(w)) {
        for (x, &c) in (0..width).zip(row) {
            if c >= threshold {
                bm.set(x, y, true);
            }
        }
    }
    bm
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dot_bitmap(len: u32, h: u16, dots: &[(u32, u16)]) -> Bitmap {
        let mut bm = Bitmap::new(len, h);
        for &(x, y) in dots {
            bm.set(x, y, true);
        }
        bm
    }

    #[test]
    fn mm_conversion() {
        assert_eq!(mm_to_dots(10.0, 180), 71);
        assert_eq!(mm_to_dots(1.0, 180), 7);
        assert_eq!(mm_to_dots(-1.0, 180), 0);
    }

    #[test]
    fn padding_and_fit() {
        let bm = dot_bitmap(3, 10, &[(0, 0), (2, 9)]);
        let p = pad_length(&bm, 2, 1);
        assert_eq!(p.length(), 6);
        assert!(p.get(2, 0) && p.get(4, 9) && !p.get(0, 0));
        let f = fit_length(&bm, 7, Align::Right).unwrap();
        assert!(f.get(4, 0) && f.get(6, 9));
        let f = fit_length(&bm, 7, Align::Center).unwrap();
        assert!(f.get(2, 0));
        assert!(fit_length(&bm, 2, Align::Left).is_err());
    }

    #[test]
    fn coverage_threshold() {
        let cov = [0u8, 200, 127, 128];
        let bm = from_coverage(&cov, 2, 2, 128);
        assert!(!bm.get(0, 0) && bm.get(1, 0) && !bm.get(0, 1) && bm.get(1, 1));
    }
}

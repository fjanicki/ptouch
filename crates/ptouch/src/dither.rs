//! Grey → 1-bit conversion: tone adjustment, thresholding and dithering (WP3).
//!
//! # Contract (ARCHITECTURE.md §5.2)
//! - Input is 8-bit luminance in **canvas row-major** order (`width` = label length in dots,
//!   `height` = dots across the tape), 0 = black, 255 = white. Output dots are ink (`true`)
//!   where the converted pixel is black.
//! - [`ToneAdjust`] is applied first (brightness, contrast, gamma, invert), then the method.
//! - Deterministic and integer-only (no `f32` in hot loops, so wasm and native match
//!   bit-for-bit). Error diffusion scans left-to-right, top-to-bottom (no serpentine), with
//!   errors clamped to `i16`.
//! - [`rgba_to_luma`] composites RGBA over white using alpha, Rec. 601 weights
//!   (`(299 R + 587 G + 114 B) / 1000`).
//!
//! # Exact rules
//! - Error diffusion (Floyd–Steinberg, Atkinson) quantises at 128: a pixel whose value plus
//!   accumulated error is `< 128` becomes ink (0), otherwise paper (255). Error shares are
//!   computed with truncating integer division (`e × 7 / 16`, `e / 8`, …).
//! - Ordered dither: ink where `luma < (2 M + 1) × 128 / n²`, with `M` the Bayer index at
//!   (`x mod n`, `y mod n`) (`n` = 4 or 8). Solid black and solid white stay solid.
//!
//! # Example
//! ```
//! use ptouch::dither::{dither, Dither, ToneAdjust};
//!
//! // 4 columns × 2 rows: dark left half.
//! let luma = [0, 10, 200, 255, 0, 10, 200, 255];
//! let bmp = dither(&luma, 4, 2, Dither::Threshold { level: 128 }, &ToneAdjust::default()).unwrap();
//! assert!(bmp.get(0, 0) && bmp.get(1, 1));
//! assert!(!bmp.get(2, 0) && !bmp.get(3, 1));
//! ```

use alloc::vec;
use alloc::vec::Vec;

use crate::bitmap::Bitmap;
use crate::error::Error;

/// Bi-level conversion method.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum Dither {
    /// Ink where luma `< level` (line art; default level 128).
    Threshold {
        /// Cut-off, 0–255.
        level: u8,
    },
    /// Floyd–Steinberg error diffusion (7/16, 3/16, 5/16, 1/16).
    FloydSteinberg,
    /// Atkinson error diffusion (6 × 1/8; 3/4 of the error propagated).
    Atkinson,
    /// Ordered dither, 4×4 Bayer matrix.
    Bayer4,
    /// Ordered dither, 8×8 Bayer matrix.
    Bayer8,
}

impl Default for Dither {
    fn default() -> Self {
        Self::Threshold { level: 128 }
    }
}

/// Tone adjustment applied before conversion. The default is the identity.
///
/// Applied in this order, each step clamped to 0…255:
/// 1. brightness: `v + brightness × 255 / 100`;
/// 2. contrast `c` (clamped to −100…100) around 128: `128 + (v − 128) × (100 + c) / 100` for
///    `c ≤ 0`, `128 + (v − 128) × 100 / (100 − c)` for `0 < c < 100`, and a hard threshold at
///    128 for `c = 100`;
/// 3. gamma: `255 × (v / 255)^(100 / gamma_x100)`, so values above 100 lighten mid-tones and
///    values below 100 darken them (computed in fixed point);
/// 4. invert: `255 − v`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ToneAdjust {
    /// −100…100, added as `brightness × 255 / 100`.
    pub brightness: i8,
    /// −100…100; 0 = unchanged.
    pub contrast: i8,
    /// Gamma × 100 (100 = linear; clamped to 10…1000).
    pub gamma_x100: u16,
    /// Invert after the other adjustments.
    pub invert: bool,
}

impl Default for ToneAdjust {
    fn default() -> Self {
        Self {
            brightness: 0,
            contrast: 0,
            gamma_x100: 100,
            invert: false,
        }
    }
}

impl ToneAdjust {
    /// `true` when this adjustment leaves every value unchanged.
    #[must_use]
    pub fn is_identity(&self) -> bool {
        self.brightness == 0 && self.contrast == 0 && self.gamma_x100 == 100 && !self.invert
    }

    /// 256-entry lookup table implementing the adjustment.
    fn lut(&self) -> [u8; 256] {
        let mut lut = [0u8; 256];
        let brightness = i32::from(self.brightness.clamp(-100, 100)) * 255 / 100;
        let contrast = i32::from(self.contrast.clamp(-100, 100));
        let gamma = self.gamma_x100.clamp(10, 1000);
        for (v, slot) in (0i32..).zip(lut.iter_mut()) {
            let mut x = (v + brightness).clamp(0, 255);
            x = match contrast {
                0 => x,
                100 => {
                    if x >= 128 {
                        255
                    } else {
                        0
                    }
                }
                c if c < 0 => 128 + (x - 128) * (100 + c) / 100,
                c => 128 + (x - 128) * 100 / (100 - c),
            }
            .clamp(0, 255);
            if gamma != 100 {
                x = i32::from(gamma_map(clamp_u8(x), gamma));
            }
            if self.invert {
                x = 255 - x;
            }
            *slot = clamp_u8(x);
        }
        lut
    }
}

/// Clamps to `0..=255` and narrows.
fn clamp_u8(v: i32) -> u8 {
    u8::try_from(v.clamp(0, 255)).unwrap_or(u8::MAX)
}

/// `2^(2^-i)` for `i = 1..=16`, Q30.
const EXP2_FRAC_Q30: [u64; 16] = [
    1_518_500_250,
    1_276_901_417,
    1_170_923_762,
    1_121_280_436,
    1_097_253_708,
    1_085_434_106,
    1_079_572_136,
    1_076_653_033,
    1_075_196_443,
    1_074_468_888,
    1_074_105_294,
    1_073_923_544,
    1_073_832_680,
    1_073_787_251,
    1_073_764_537,
    1_073_753_181,
];

/// `log2(v)` in Q16 for `v ≥ 1`.
fn log2_q16(v: u32) -> i64 {
    if v == 0 {
        return 0;
    }
    let int = 31 - i64::from(v.leading_zeros());
    // Normalise to [1, 2) in Q30.
    let mut x: u64 = (u64::from(v) << 30) >> int;
    let mut frac: i64 = 0;
    for bit in (0..16).rev() {
        x = (x * x) >> 30;
        if x >= 2 << 30 {
            x >>= 1;
            frac |= 1 << bit;
        }
    }
    (int << 16) + frac
}

/// `2^y` in Q30 for `y ≤ 0` given in Q16.
fn exp2_q30(y: i64) -> u64 {
    let int = y >> 16; // floor
    let frac = (y & 0xFFFF) as u32; // ∈ [0, 1) Q16
    let mut r: u64 = 1 << 30;
    for (i, &k) in EXP2_FRAC_Q30.iter().enumerate() {
        if frac & (0x8000 >> i) != 0 {
            r = (r * k) >> 30;
        }
    }
    // int ≤ 0 here; r < 2^31.
    let shift = u32::try_from(-int).unwrap_or(u32::MAX);
    if int >= 0 {
        r
    } else if shift >= 63 {
        0
    } else {
        r >> shift
    }
}

/// `255 × (v / 255)^(100 / gamma_x100)`, rounded, in fixed point.
fn gamma_map(v: u8, gamma_x100: u16) -> u8 {
    if v == 0 || v == 255 || gamma_x100 == 0 {
        return v;
    }
    let exponent_q16 = (100i64 << 16) / i64::from(gamma_x100);
    let l = log2_q16(u32::from(v)) - log2_q16(255); // ≤ 0, Q16
    let y = (l * exponent_q16) >> 16;
    let r = exp2_q30(y.min(0));
    clamp_u8(i32::try_from((255 * r + (1 << 29)) >> 30).unwrap_or(255))
}

/// Luminance of an RGBA pixel composited over white (Rec. 601).
pub(crate) fn pixel_luma(r: u8, g: u8, b: u8, a: u8) -> u8 {
    let y = (299 * u32::from(r) + 587 * u32::from(g) + 114 * u32::from(b)) / 1000;
    let a = u32::from(a);
    let composited = (y * a + 255 * (255 - a) + 127) / 255;
    u8::try_from(composited).unwrap_or(u8::MAX)
}

/// `width × height × per_pixel` with overflow checking.
pub(crate) fn buffer_len(width: u32, height: u32, per_pixel: usize) -> Result<usize, Error> {
    (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(per_pixel))
        .ok_or(Error::InvalidInput("image dimensions too large"))
}

/// Converts RGBA (row-major, 4 bytes per pixel) to luminance composited over white.
///
/// # Errors
/// [`Error::DataLength`] if `rgba.len() != width * height * 4`.
pub fn rgba_to_luma(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, Error> {
    let expected = buffer_len(width, height, 4)?;
    if rgba.len() != expected {
        return Err(Error::DataLength {
            expected,
            got: rgba.len(),
        });
    }
    Ok(rgba
        .chunks_exact(4)
        .map(|p| match *p {
            [r, g, b, a] => pixel_luma(r, g, b, a),
            _ => 255,
        })
        .collect())
}

/// Applies [`ToneAdjust`] in place.
pub fn adjust_tone(luma: &mut [u8], adj: &ToneAdjust) {
    if adj.is_identity() {
        return;
    }
    let lut = adj.lut();
    for v in luma {
        *v = lut[usize::from(*v)];
    }
}

/// 4×4 Bayer index matrix, `[row][col]`.
const BAYER4: [[u8; 4]; 4] = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

/// 8×8 Bayer index matrix, `[row][col]`.
const BAYER8: [[u8; 8]; 8] = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
];

/// Error-diffusion kernel: `(dx, dy, weight)` with a common divisor.
struct Kernel {
    taps: &'static [(i32, usize, i32)],
    divisor: i32,
}

const FLOYD_STEINBERG: Kernel = Kernel {
    taps: &[(1, 0, 7), (-1, 1, 3), (0, 1, 5), (1, 1, 1)],
    divisor: 16,
};

const ATKINSON: Kernel = Kernel {
    taps: &[
        (1, 0, 1),
        (2, 0, 1),
        (-1, 1, 1),
        (0, 1, 1),
        (1, 1, 1),
        (0, 2, 1),
    ],
    divisor: 8,
};

/// Converts adjusted luma (row-major `width × height`) to ink flags (`true` = ink), same
/// order. `luma.len()` must equal `width × height` (checked by callers).
pub(crate) fn to_ink(luma: &[u8], width: usize, method: Dither) -> Vec<bool> {
    match method {
        Dither::Threshold { level } => luma.iter().map(|&v| v < level).collect(),
        Dither::Bayer4 => ordered(luma, width, |x, y| BAYER4[y % 4][x % 4], 4),
        Dither::Bayer8 => ordered(luma, width, |x, y| BAYER8[y % 8][x % 8], 8),
        Dither::FloydSteinberg => diffuse(luma, width, &FLOYD_STEINBERG),
        Dither::Atkinson => diffuse(luma, width, &ATKINSON),
    }
}

fn ordered(luma: &[u8], width: usize, m: impl Fn(usize, usize) -> u8, n: u32) -> Vec<bool> {
    let width = width.max(1);
    let cells = n * n;
    luma.iter()
        .enumerate()
        .map(|(i, &v)| {
            let t = (2 * u32::from(m(i % width, i / width)) + 1) * 128 / cells;
            u32::from(v) < t
        })
        .collect()
}

fn diffuse(luma: &[u8], width: usize, k: &Kernel) -> Vec<bool> {
    let mut out = vec![false; luma.len()];
    if width == 0 {
        return out;
    }
    // Rolling error rows: rows[0] = current row, rows[1], rows[2] = the next ones.
    let mut rows: [Vec<i16>; 3] = [vec![0; width], vec![0; width], vec![0; width]];
    for (row_in, row_out) in luma.chunks(width).zip(out.chunks_mut(width)) {
        for (x, (&v, ink)) in row_in.iter().zip(row_out.iter_mut()).enumerate() {
            let p = i32::from(v) + i32::from(rows[0][x]);
            let q = if p < 128 { 0 } else { 255 };
            *ink = q == 0;
            let e = p - q;
            if e == 0 {
                continue;
            }
            for &(dx, dy, w) in k.taps {
                let Some(nx) = x.checked_add_signed(dx as isize) else {
                    continue;
                };
                if let Some(slot) = rows.get_mut(dy).and_then(|r| r.get_mut(nx)) {
                    let sum = i32::from(*slot) + e * w / k.divisor;
                    *slot = i16::try_from(sum.clamp(i32::from(i16::MIN), i32::from(i16::MAX)))
                        .unwrap_or(0);
                }
            }
        }
        rows.rotate_left(1);
        rows[2].fill(0);
    }
    out
}

/// Converts luminance to a [`Bitmap`] of `width` lines × `height` dots with `method` after
/// `adj`.
///
/// # Errors
/// [`Error::DataLength`] if `luma.len() != width * height`.
pub fn dither(
    luma: &[u8],
    width: u32,
    height: u16,
    method: Dither,
    adj: &ToneAdjust,
) -> Result<Bitmap, Error> {
    let expected = buffer_len(width, u32::from(height), 1)?;
    if luma.len() != expected {
        return Err(Error::DataLength {
            expected,
            got: luma.len(),
        });
    }
    let mut work = luma.to_vec();
    adjust_tone(&mut work, adj);
    let ink = to_ink(&work, width as usize, method);
    let mut bmp = Bitmap::new(width, height);
    for (i, _) in ink.iter().enumerate().filter(|&(_, &on)| on) {
        let x = (i % width as usize) as u32;
        let y = (i / width as usize) as u16;
        bmp.set(x, y, true);
    }
    Ok(bmp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_and_exp_are_accurate() {
        // log2(128) = 7, log2(255) ≈ 7.99435
        assert_eq!(log2_q16(128), 7 << 16);
        assert!((log2_q16(255) - 523_918).abs() <= 2);
        assert_eq!(exp2_q30(0), 1 << 30);
        assert_eq!(exp2_q30(-(1 << 16)), 1 << 29);
    }

    #[test]
    fn gamma_identity_endpoints() {
        for g in [10, 50, 100, 220, 1000] {
            assert_eq!(gamma_map(0, g), 0);
            assert_eq!(gamma_map(255, g), 255);
        }
        // Gamma 100 is the identity.
        for v in 0..=255u8 {
            assert_eq!(gamma_map(v, 100), v);
        }
    }

    #[test]
    fn lut_identity() {
        let lut = ToneAdjust::default().lut();
        for (i, &v) in lut.iter().enumerate() {
            assert_eq!(usize::from(v), i);
        }
    }
}

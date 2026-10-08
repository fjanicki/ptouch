//! Image file → bitmap.
//!
//! # Contract
//! - PNG via `png` (any colour type/bit depth, converted to RGBA8 and composited over white by
//!   `ptouch::dither::rgba_to_luma`), PBM (`P1`/`P4`) and PGM (`P2`/`P5`) parsed here.
//!   JPEG is recognised and rejected with a clear message (no JPEG decoder dependency).
//! - Canvas orientation: image width = label length, image height = across the tape; scaled
//!   (box filter down, nearest up) to `height` unless `no_scale`, then converted with
//!   `ptouch::dither`. A smaller image with `no_scale` is centred across the tape.

use std::path::Path;

use ptouch::{Bitmap, Dither, ToneAdjust};

use crate::error::CliError;

/// Largest accepted image side (dots / pixels), to keep memory bounded.
const MAX_SIDE: u32 = 20_000;

/// Grey image, row-major, 0 = black.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Luma {
    /// Pixels per row.
    pub width: u32,
    /// Rows.
    pub height: u32,
    /// `width × height` bytes.
    pub data: Vec<u8>,
}

/// Loads and converts an image to a bitmap of `height` dots.
///
/// # Errors
/// [`CliError::File`] (unreadable), [`CliError::Image`] (unsupported/corrupt, or too tall
/// with `no_scale`), core errors from dithering.
pub fn load_image(
    path: &Path,
    height: u16,
    no_scale: bool,
    dither: Dither,
    adj: ToneAdjust,
) -> Result<Bitmap, CliError> {
    let bytes = std::fs::read(path).map_err(|e| CliError::file(path, e))?;
    let img = decode(&bytes).map_err(|reason| CliError::Image {
        path: path.to_path_buf(),
        reason,
    })?;
    let fitted = if no_scale {
        if img.height > u32::from(height) {
            return Err(CliError::Image {
                path: path.to_path_buf(),
                reason: format!(
                    "the image is {} pixels tall but the tape prints {height} dots; drop --no-scale",
                    img.height
                ),
            });
        }
        center_vertically(&img, u32::from(height))
    } else {
        scale_to_height(&img, u32::from(height))
    };
    Ok(ptouch::dither::dither(
        &fitted.data,
        fitted.width,
        height,
        dither,
        &adj,
    )?)
}

/// Decodes PNG / PBM / PGM bytes to luminance.
///
/// # Errors
/// A human-readable reason.
pub fn decode(bytes: &[u8]) -> Result<Luma, String> {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => decode_png(bytes),
        [0xFF, 0xD8, 0xFF, ..] => Err("JPEG is not supported in this build; convert it to PNG \
             (e.g. `sips -s format png in.jpg --out in.png` on macOS)"
            .into()),
        [b'P', b'1' | b'2' | b'4' | b'5', ..] => decode_pnm(bytes),
        _ => Err("unknown format (supported: PNG, PBM, PGM)".into()),
    }
}

fn decode_png(bytes: &[u8]) -> Result<Luma, String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| "image too large".to_owned())?;
    let mut buf = vec![0u8; size];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let (w, h) = (info.width, info.height);
    check_size(w, h)?;
    let pixels = usize::try_from(u64::from(w) * u64::from(h)).map_err(|e| e.to_string())?;
    let buf = buf.get(..info.buffer_size()).unwrap_or(&buf);
    let channels = match info.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => return Err("unexpanded palette image".into()),
    };
    let mut rgba = Vec::with_capacity(pixels * 4);
    for row in buf.chunks_exact(info.line_size).take(h as usize) {
        for px in row.chunks_exact(channels).take(w as usize) {
            let (r, g, b, a) = match *px {
                [l] => (l, l, l, 255),
                [l, a] => (l, l, l, a),
                [r, g, b] => (r, g, b, 255),
                [r, g, b, a] => (r, g, b, a),
                _ => (255, 255, 255, 0),
            };
            rgba.extend_from_slice(&[r, g, b, a]);
        }
    }
    let data = ptouch::dither::rgba_to_luma(&rgba, w, h).map_err(|e| e.to_string())?;
    Ok(Luma {
        width: w,
        height: h,
        data,
    })
}

fn check_size(w: u32, h: u32) -> Result<(), String> {
    if w == 0 || h == 0 {
        Err("the image is empty".into())
    } else if w > MAX_SIDE || h > MAX_SIDE {
        Err(format!(
            "the image is too large ({w}×{h}; limit {MAX_SIDE})"
        ))
    } else {
        Ok(())
    }
}

/// PNM tokenizer: skips whitespace and `#` comments.
struct Tokens<'a> {
    b: &'a [u8],
    pos: usize,
}

impl Tokens<'_> {
    fn skip_space(&mut self) {
        while let Some(&c) = self.b.get(self.pos) {
            if c == b'#' {
                while self.b.get(self.pos).is_some_and(|&c| c != b'\n') {
                    self.pos += 1;
                }
            } else if c.is_ascii_whitespace() {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn number(&mut self) -> Result<u32, String> {
        self.skip_space();
        let start = self.pos;
        while self.b.get(self.pos).is_some_and(u8::is_ascii_digit) {
            self.pos += 1;
        }
        std::str::from_utf8(self.b.get(start..self.pos).unwrap_or_default())
            .ok()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| format!("bad PNM header at byte {start}"))
    }

    /// One plain-PBM bit (`0`/`1`, whitespace optional between them).
    fn bit(&mut self) -> Result<bool, String> {
        self.skip_space();
        let c = self.b.get(self.pos).copied();
        self.pos += 1;
        match c {
            Some(b'0') => Ok(false),
            Some(b'1') => Ok(true),
            _ => Err("truncated PBM data".into()),
        }
    }
}

fn decode_pnm(bytes: &[u8]) -> Result<Luma, String> {
    let kind = bytes.get(1).copied().unwrap_or(0);
    let mut t = Tokens { b: bytes, pos: 2 };
    let width = t.number()?;
    let height = t.number()?;
    check_size(width, height)?;
    let maxval = if matches!(kind, b'2' | b'5') {
        t.number()?
    } else {
        1
    };
    if maxval == 0 || maxval > 65_535 {
        return Err(format!("bad PGM maxval {maxval}"));
    }
    let (w, h) = (width as usize, height as usize);
    let mut data = Vec::with_capacity(w * h);
    match kind {
        b'1' => {
            for _ in 0..w * h {
                data.push(if t.bit()? { 0 } else { 255 });
            }
        }
        b'4' => {
            t.pos += 1; // single whitespace after the header
            let stride = w.div_ceil(8);
            let raster = bytes
                .get(t.pos..t.pos + stride * h)
                .ok_or("truncated PBM data")?;
            for row in raster.chunks_exact(stride) {
                for x in 0..w {
                    let on = row[x / 8] & (0x80 >> (x % 8)) != 0;
                    data.push(if on { 0 } else { 255 });
                }
            }
        }
        b'2' => {
            for _ in 0..w * h {
                data.push(scale_sample(t.number()?, maxval));
            }
        }
        _ => {
            t.pos += 1;
            let bpp = if maxval > 255 { 2 } else { 1 };
            let raster = bytes
                .get(t.pos..t.pos + w * h * bpp)
                .ok_or("truncated PGM data")?;
            for s in raster.chunks_exact(bpp) {
                let v = match *s {
                    [v] => u32::from(v),
                    [hi, lo] => u32::from(u16::from_be_bytes([hi, lo])),
                    _ => 0,
                };
                data.push(scale_sample(v, maxval));
            }
        }
    }
    Ok(Luma {
        width,
        height,
        data,
    })
}

fn scale_sample(v: u32, maxval: u32) -> u8 {
    u8::try_from(v.min(maxval) * 255 / maxval).unwrap_or(255)
}

/// Pads a short image with white rows so it is `height` tall, centred.
#[must_use]
pub fn center_vertically(img: &Luma, height: u32) -> Luma {
    let w = img.width as usize;
    let top = (height.saturating_sub(img.height) / 2) as usize;
    let mut data = vec![255u8; w * height as usize];
    for (y, row) in img.data.chunks_exact(w.max(1)).enumerate() {
        if let Some(dst) = data.get_mut((top + y) * w..(top + y + 1) * w) {
            dst.copy_from_slice(row);
        }
    }
    Luma {
        width: img.width,
        height,
        data,
    }
}

/// Scales to `height` rows keeping the aspect ratio (box filter when shrinking, nearest
/// neighbour when enlarging).
#[must_use]
pub fn scale_to_height(img: &Luma, height: u32) -> Luma {
    if img.height == height || img.height == 0 || img.width == 0 {
        return img.clone();
    }
    let new_w = ((u64::from(img.width) * u64::from(height) + u64::from(img.height) / 2)
        / u64::from(img.height))
    .max(1);
    let new_w = u32::try_from(new_w).unwrap_or(u32::MAX).min(MAX_SIDE * 4);
    let (sw, sh) = (u64::from(img.width), u64::from(img.height));
    let (dw, dh) = (u64::from(new_w), u64::from(height));
    let mut data = Vec::with_capacity((dw * dh) as usize);
    for y in 0..dh {
        let y0 = y * sh / dh;
        let y1 = ((y + 1) * sh / dh).max(y0 + 1).min(sh);
        for x in 0..dw {
            let x0 = x * sw / dw;
            let x1 = ((x + 1) * sw / dw).max(x0 + 1).min(sw);
            let mut sum = 0u64;
            for yy in y0..y1 {
                for xx in x0..x1 {
                    sum += u64::from(
                        img.data
                            .get((yy * sw + xx) as usize)
                            .copied()
                            .unwrap_or(255),
                    );
                }
            }
            let n = (y1 - y0) * (x1 - x0);
            data.push(u8::try_from(sum / n.max(1)).unwrap_or(255));
        }
    }
    Luma {
        width: new_w,
        height,
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_bytes(w: u32, h: u32, color: png::ColorType, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, w, h);
            enc.set_color(color);
            enc.set_depth(png::BitDepth::Eight);
            let mut wr = enc.write_header().unwrap();
            wr.write_image_data(data).unwrap();
        }
        out
    }

    #[test]
    fn pgm_and_pbm() {
        let img = decode(b"P2\n# c\n2 2\n255\n0 255\n128 64\n").unwrap();
        assert_eq!((img.width, img.height), (2, 2));
        assert_eq!(img.data, vec![0, 255, 128, 64]);
        let img = decode(b"P5 2 1 255\n\x00\xff").unwrap();
        assert_eq!(img.data, vec![0, 255]);
        let img = decode(b"P1\n3 1\n101").unwrap();
        assert_eq!(img.data, vec![0, 255, 0]);
        let img = decode(b"P4\n3 2\n\xa0\x40").unwrap();
        assert_eq!(img.data, vec![0, 255, 0, 255, 0, 255]);
        assert!(decode(b"P4\n3 2\n\xa0").is_err());
        assert!(decode(b"P2\n0 2\n255\n").is_err());
    }

    #[test]
    fn rejects_jpeg_and_garbage() {
        assert!(
            decode(&[0xFF, 0xD8, 0xFF, 0xE0])
                .unwrap_err()
                .contains("JPEG")
        );
        assert!(decode(b"hello").is_err());
    }

    #[test]
    fn png_grayscale() {
        let bytes = png_bytes(2, 1, png::ColorType::Grayscale, &[0, 255]);
        let img = decode(&bytes).unwrap();
        assert_eq!(img.data, vec![0, 255]);
    }

    #[test]
    fn scaling() {
        let img = Luma {
            width: 4,
            height: 4,
            data: vec![0; 16],
        };
        let s = scale_to_height(&img, 2);
        assert_eq!((s.width, s.height), (2, 2));
        let s = scale_to_height(&img, 8);
        assert_eq!((s.width, s.height), (8, 8));
        assert!(s.data.iter().all(|&v| v == 0));
        // Box filter averages a black/white checker to grey.
        let img = Luma {
            width: 2,
            height: 2,
            data: vec![0, 255, 255, 0],
        };
        assert_eq!(scale_to_height(&img, 1).data, vec![127]);
        let c = center_vertically(&img, 4);
        assert_eq!(c.data, vec![255, 255, 0, 255, 255, 0, 255, 255]);
    }
}

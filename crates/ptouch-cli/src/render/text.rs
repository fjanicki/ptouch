//! Text → bitmap.
//!
//! # Contract
//! - [`render_text`] lays out one or more lines (`\n`) across the tape, each line aligned per
//!   [`TextOptions::align`], the block centred across the tape. Without a size the block is
//!   scaled to fill `height` minus a 1-dot inset on each edge. Length = text extent.
//! - With a font file: `fontdue` rasterises coverage, thresholded at 50 %. The fit uses the
//!   real ink extent of the text (so "ace" and "ACE" both fill the tape) and the font's line
//!   pitch between lines. Without a font: the built-in 5×7 font scaled by an integer factor.

use std::path::Path;

use ptouch::Bitmap;

use super::{font5x7, fonts};
use crate::cli::Align;
use crate::error::CliError;

/// Font choice.
pub enum FontSource {
    /// Built-in 5×7 bitmap font.
    Builtin,
    /// Parsed TrueType/OpenType font.
    Ttf(fontdue::Font),
}

impl std::fmt::Debug for FontSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Builtin => f.write_str("Builtin"),
            Self::Ttf(font) => write!(f, "Ttf({:?})", font.name()),
        }
    }
}

impl FontSource {
    /// Loads a font file (face 0 of a collection).
    ///
    /// # Errors
    /// [`CliError::File`] if unreadable, [`CliError::Font`] if not a usable font.
    pub fn load(path: &Path) -> Result<Self, CliError> {
        Self::load_face(path, 0)
    }

    /// Loads face `index` of a font file or collection.
    ///
    /// # Errors
    /// [`CliError::File`] if unreadable, [`CliError::Font`] if not a usable font.
    pub fn load_face(path: &Path, index: u32) -> Result<Self, CliError> {
        let data = std::fs::read(path).map_err(|e| CliError::file(path, e))?;
        let settings = fontdue::FontSettings {
            collection_index: index,
            ..fontdue::FontSettings::default()
        };
        fontdue::Font::from_bytes(data, settings)
            .map(Self::Ttf)
            .map_err(|e| CliError::Font(format!("{}: {e}", path.display())))
    }

    /// Resolves a `--font` argument: `None`/`builtin` → built-in font, an existing path →
    /// that file, anything else → a system font by name (see [`fonts::find`]). Returns the
    /// font and a description for messages.
    ///
    /// # Errors
    /// [`CliError::Font`] when no font matches.
    pub fn resolve(spec: Option<&str>) -> Result<(Self, String), CliError> {
        let Some(spec) = spec.map(str::trim).filter(|s| !s.is_empty()) else {
            return Ok((Self::Builtin, "built-in 5×7".to_owned()));
        };
        if spec.eq_ignore_ascii_case("builtin") {
            return Ok((Self::Builtin, "built-in 5×7".to_owned()));
        }
        let path = Path::new(spec);
        if path.is_file() {
            return Ok((Self::load(path)?, path.display().to_string()));
        }
        let face = fonts::find(spec).ok_or_else(|| {
            CliError::Font(format!(
                "no font file or installed font named {spec:?} (try `ptouch fonts {spec}`)"
            ))
        })?;
        let font = Self::load_face(&face.path, face.index)?;
        Ok((
            font,
            format!("{} ({})", face.full_name, face.path.display()),
        ))
    }
}

/// Layout options for [`render_text`].
#[derive(Debug, Clone, Copy, Default)]
pub struct TextOptions {
    /// Font size in dots (built-in font: rounded to a multiple of 7); `None` = fill the tape.
    pub size: Option<f32>,
    /// Alignment of lines relative to each other.
    pub align: Align,
}

/// Normalises user text: literal `\n` → newline, CRLF → LF, tabs → 4 spaces.
#[must_use]
pub fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace("\\n", "\n")
        .replace('\t', "    ")
}

/// Renders `text` to a bitmap of `height` dots across the tape.
///
/// # Errors
/// [`CliError::Usage`] for empty text or text that cannot fit the tape.
pub fn render_text(
    text: &str,
    font: &FontSource,
    height: u16,
    opts: TextOptions,
) -> Result<Bitmap, CliError> {
    let text = normalize(text);
    if text.trim().is_empty() {
        return Err(CliError::Usage(
            "nothing to print: the text is empty".into(),
        ));
    }
    let lines: Vec<&str> = text.split('\n').collect();
    match font {
        FontSource::Builtin => render_builtin(&lines, height, opts),
        FontSource::Ttf(f) => render_ttf(&lines, f, height, opts),
    }
}

/// 1-dot inset on both tape edges when there is room for it.
fn inset_for(height: u16) -> u16 {
    if height > 8 { 1 } else { 0 }
}

fn align_offset(align: Align, block: u32, line: u32) -> u32 {
    let free = block.saturating_sub(line);
    match align {
        Align::Left => 0,
        Align::Center => free / 2,
        Align::Right => free,
    }
}

/// Characters the built-in font cannot draw (rendered as `?`).
#[must_use]
pub fn unsupported_builtin_chars(text: &str) -> Vec<char> {
    let mut out: Vec<char> = normalize(text)
        .chars()
        .filter(|&c| c != '\n' && font5x7::glyph(c).is_none())
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

fn render_builtin(lines: &[&str], height: u16, opts: TextOptions) -> Result<Bitmap, CliError> {
    const GAP: u32 = 2; // unscaled rows between lines
    const ADVANCE: u32 = font5x7::GLYPH_WIDTH + 1;
    let n = u32::try_from(lines.len()).unwrap_or(u32::MAX);
    let inset = inset_for(height);
    let avail = u32::from(height.saturating_sub(2 * inset));
    let unit_h = n
        .saturating_mul(font5x7::GLYPH_HEIGHT)
        .saturating_add((n - 1).saturating_mul(GAP));
    let scale = match opts.size {
        Some(px) if px.is_finite() && px > 0.0 => {
            ((px / font5x7::GLYPH_HEIGHT as f32).round() as u32).max(1)
        }
        Some(_) => return Err(CliError::Usage("--size must be a positive number".into())),
        None => avail / unit_h.max(1),
    };
    let block_h = unit_h.saturating_mul(scale);
    if scale == 0 || block_h > avail {
        return Err(CliError::Usage(format!(
            "{n} line(s) of text need {} dots across the tape, but it prints only {avail}",
            unit_h.max(1) * scale.max(1)
        )));
    }

    let widths: Vec<u32> = lines
        .iter()
        .map(|l| {
            let chars = u32::try_from(l.chars().count()).unwrap_or(u32::MAX);
            chars
                .saturating_mul(ADVANCE)
                .saturating_sub(1)
                .saturating_mul(scale)
        })
        .collect();
    let block_w = widths.iter().copied().max().unwrap_or(0).max(1);
    let mut bm = Bitmap::new(block_w, height);
    let top = u32::from(inset) + (avail - block_h) / 2;

    for (i, (line, &w)) in (0u32..).zip(lines.iter().zip(&widths)) {
        let y0 = top + i * (font5x7::GLYPH_HEIGHT + GAP) * scale;
        let x0 = align_offset(opts.align, block_w, w);
        for (ci, c) in (0u32..).zip(line.chars()) {
            let c = if font5x7::glyph(c).is_some() { c } else { '?' };
            let gx = x0 + ci * ADVANCE * scale;
            for gy in 0..font5x7::GLYPH_HEIGHT {
                for gxx in 0..font5x7::GLYPH_WIDTH {
                    if !font5x7::dot(c, gxx, gy) {
                        continue;
                    }
                    for dy in 0..scale {
                        for dx in 0..scale {
                            let y = u16::try_from(y0 + gy * scale + dy).unwrap_or(u16::MAX);
                            bm.set(gx + gxx * scale + dx, y, true);
                        }
                    }
                }
            }
        }
    }
    Ok(bm)
}

/// One positioned glyph of a TrueType layout.
struct Placed {
    c: char,
    /// Pen x of the glyph origin (dots, may be fractional).
    pen_x: f32,
    /// Line index.
    line: usize,
}

/// Layout result at one pixel size.
struct Layout {
    glyphs: Vec<Placed>,
    /// Per line: (min x, max x) horizontal extent including advances.
    line_extent: Vec<(f32, f32)>,
    /// Line pitch (baseline to baseline).
    pitch: f32,
    /// Ink extent relative to the first baseline, y down: (top, bottom).
    ink_y: Option<(f32, f32)>,
}

fn layout(lines: &[&str], font: &fontdue::Font, px: f32) -> Layout {
    let pitch = font
        .horizontal_line_metrics(px)
        .map_or(px * 1.2, |m| m.ascent - m.descent + m.line_gap.max(0.0));
    let mut glyphs = Vec::new();
    let mut line_extent = Vec::new();
    let mut ink_y: Option<(f32, f32)> = None;
    for (li, line) in lines.iter().enumerate() {
        let mut pen = 0.0f32;
        let mut prev: Option<char> = None;
        let (mut min_x, mut max_x) = (0.0f32, 0.0f32);
        let baseline = pitch * li as f32;
        for c in line.chars() {
            if let Some(p) = prev {
                pen += font.horizontal_kern(p, c, px).unwrap_or(0.0);
            }
            let m = font.metrics(c, px);
            if m.width > 0 && m.height > 0 {
                let left = pen + m.xmin as f32;
                min_x = min_x.min(left);
                max_x = max_x.max(left + m.width as f32);
                // fontdue: ymin = bottom edge above the baseline (y up).
                let top = baseline - (m.ymin as f32 + m.height as f32);
                let bottom = baseline - m.ymin as f32;
                ink_y = Some(match ink_y {
                    Some((t, b)) => (t.min(top), b.max(bottom)),
                    None => (top, bottom),
                });
            }
            glyphs.push(Placed {
                c,
                pen_x: pen,
                line: li,
            });
            pen += m.advance_width;
            prev = Some(c);
        }
        max_x = max_x.max(pen);
        line_extent.push((min_x, max_x));
    }
    Layout {
        glyphs,
        line_extent,
        pitch,
        ink_y,
    }
}

/// Characters `font` has no glyph for (rendered as the font's missing-glyph box).
#[must_use]
pub fn missing_glyphs(text: &str, font: &FontSource) -> Vec<char> {
    let FontSource::Ttf(f) = font else {
        return unsupported_builtin_chars(text);
    };
    let mut out: Vec<char> = normalize(text)
        .chars()
        .filter(|&c| !c.is_whitespace() && !f.has_glyph(c))
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

fn render_ttf(
    lines: &[&str],
    font: &fontdue::Font,
    height: u16,
    opts: TextOptions,
) -> Result<Bitmap, CliError> {
    let inset = inset_for(height);
    let avail = f32::from(height.saturating_sub(2 * inset));
    let mut px = match opts.size {
        Some(px) if px.is_finite() && px > 0.0 => px,
        Some(_) => return Err(CliError::Usage("--size must be a positive number".into())),
        None => {
            const REFERENCE: f32 = 100.0;
            let reference = layout(lines, font, REFERENCE);
            let Some((t, b)) = reference.ink_y else {
                return Err(CliError::Usage(
                    "nothing to print: the text has no ink".into(),
                ));
            };
            REFERENCE * avail / (b - t).max(1.0)
        }
    };

    // Rasterisation rounds glyph boxes outward; shrink slightly until the ink fits.
    for _ in 0..24 {
        let lay = layout(lines, font, px);
        let Some((top, bottom)) = lay.ink_y else {
            return Err(CliError::Usage(
                "nothing to print: the text has no ink".into(),
            ));
        };
        let ink_h = bottom - top;
        if ink_h <= avail || opts.size.is_some() {
            if ink_h > avail {
                return Err(CliError::Usage(format!(
                    "text at size {px} needs {} dots across the tape, but it prints only {avail}",
                    ink_h.ceil()
                )));
            }
            return Ok(rasterize(&lay, font, px, height, inset, opts.align));
        }
        px *= (avail / ink_h).min(0.98);
    }
    Err(CliError::Usage(
        "the text cannot be fitted to the tape".into(),
    ))
}

fn rasterize(
    lay: &Layout,
    font: &fontdue::Font,
    px: f32,
    height: u16,
    inset: u16,
    align: Align,
) -> Bitmap {
    let (ink_top, ink_bottom) = lay.ink_y.unwrap_or((0.0, 0.0));
    let widths: Vec<f32> = lay.line_extent.iter().map(|(a, b)| b - a).collect();
    let block_w = widths
        .iter()
        .copied()
        .fold(0.0f32, f32::max)
        .ceil()
        .max(1.0);
    let width = block_w as u32;
    let avail = f32::from(height.saturating_sub(2 * inset));
    // Baseline of line 0 in canvas rows: centre the ink block.
    let y_shift = f32::from(inset) + ((avail - (ink_bottom - ink_top)) / 2.0).floor() - ink_top;

    let w = width as usize;
    let h = usize::from(height);
    let mut coverage = vec![0u8; w * h];
    for g in &lay.glyphs {
        let (m, bitmap) = font.rasterize(g.c, px);
        if m.width == 0 || m.height == 0 {
            continue;
        }
        let (min_x, _) = lay.line_extent.get(g.line).copied().unwrap_or((0.0, 0.0));
        let line_w = widths.get(g.line).copied().unwrap_or(0.0);
        let x_off = match align {
            Align::Left => 0.0,
            Align::Center => ((block_w - line_w) / 2.0).floor(),
            Align::Right => (block_w - line_w).floor(),
        } - min_x;
        let baseline = y_shift + lay.pitch * g.line as f32;
        let gx0 = (g.pen_x + m.xmin as f32 + x_off).round() as i64;
        let gy0 = (baseline - (m.ymin as f32 + m.height as f32)).round() as i64;
        for (row, src_row) in bitmap.chunks_exact(m.width).enumerate() {
            let y = gy0 + row as i64;
            if y < 0 || y >= h as i64 {
                continue;
            }
            for (col, &v) in src_row.iter().enumerate() {
                let x = gx0 + col as i64;
                if x < 0 || x >= w as i64 {
                    continue;
                }
                if let Some(dst) = coverage.get_mut(y as usize * w + x as usize) {
                    *dst = (*dst).max(v);
                }
            }
        }
    }
    super::from_coverage(&coverage, width, height, 128)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ink_rows(bm: &Bitmap) -> (u16, u16) {
        let rows: Vec<u16> = (0..bm.height())
            .filter(|&y| (0..bm.length()).any(|x| bm.get(x, y)))
            .collect();
        (*rows.first().unwrap(), *rows.last().unwrap())
    }

    #[test]
    fn builtin_fills_height() {
        // 24 mm: 128 dots, inset 1 → 126 available → scale 18 (126 / 7).
        let bm = render_text("H", &FontSource::Builtin, 128, TextOptions::default()).unwrap();
        assert_eq!(bm.height(), 128);
        assert_eq!(bm.length(), 5 * 18);
        assert_eq!(ink_rows(&bm), (1, 126));
    }

    #[test]
    fn builtin_height_scaling() {
        // 12 mm: 70 dots → 68 available → scale 9 → 63 rows, centred (top 1 + 2).
        let bm = render_text("H", &FontSource::Builtin, 70, TextOptions::default()).unwrap();
        assert_eq!(ink_rows(&bm), (3, 65));
        // 3.5 mm: 24 dots → 22 available → scale 3.
        let bm = render_text("H", &FontSource::Builtin, 24, TextOptions::default()).unwrap();
        assert_eq!(bm.length(), 15);
        // Explicit size: 14 dots → scale 2.
        let opts = TextOptions {
            size: Some(14.0),
            ..TextOptions::default()
        };
        let bm = render_text("Hi", &FontSource::Builtin, 128, opts).unwrap();
        assert_eq!(bm.length(), (2 * 6 - 1) * 2);
    }

    #[test]
    fn builtin_multiline_and_alignment() {
        let opts = |align| TextOptions { size: None, align };
        // Two lines: 7+2+7 = 16 unit rows; 126 / 16 = 7.
        let bm = render_text("AB\nC", &FontSource::Builtin, 128, opts(Align::Left)).unwrap();
        assert_eq!(bm.length(), 11 * 7);
        // Left: the 'C' starts at x = 0 on the second line.
        let second_line_y = 1 + (126 - 16 * 7) / 2 + 9 * 7 + 3 * 7;
        assert!((0..7).any(|x| bm.get(x, second_line_y)));
        let bm = render_text("AB\\nC", &FontSource::Builtin, 128, opts(Align::Right)).unwrap();
        assert!(!(0..7).any(|x| bm.get(x, second_line_y)));
    }

    #[test]
    fn builtin_errors() {
        assert!(render_text("  ", &FontSource::Builtin, 128, TextOptions::default()).is_err());
        let many = "a\nb\nc\nd";
        // 3.5 mm tape: 4 lines need 34 rows > 22.
        assert!(render_text(many, &FontSource::Builtin, 24, TextOptions::default()).is_err());
        assert_eq!(unsupported_builtin_chars("héllo€"), vec!['é', '€']);
    }

    #[test]
    fn resolve_builtin() {
        let (f, _) = FontSource::resolve(None).unwrap();
        assert!(matches!(f, FontSource::Builtin));
        let (f, _) = FontSource::resolve(Some("BUILTIN")).unwrap();
        assert!(matches!(f, FontSource::Builtin));
        assert!(FontSource::resolve(Some("No Such Font Family 1234")).is_err());
    }

    #[test]
    fn ttf_fills_height_when_a_system_font_exists() {
        // Environment-dependent: skipped silently on machines without any system font.
        let Some(face) = fonts::scan().into_iter().find(|f| {
            let n = f.full_name.to_ascii_lowercase();
            n.contains("helvetica") || n.contains("arial") || n.contains("dejavu sans")
        }) else {
            return;
        };
        let Ok(font) = FontSource::load_face(&face.path, face.index) else {
            return;
        };
        let bm = render_text("Hello", &font, 128, TextOptions::default()).unwrap();
        let (top, bottom) = ink_rows(&bm);
        assert!(top >= 1 && bottom <= 126, "{top}..{bottom}");
        assert!(
            bottom - top >= 110,
            "{top}..{bottom} should nearly fill the tape"
        );
    }
}

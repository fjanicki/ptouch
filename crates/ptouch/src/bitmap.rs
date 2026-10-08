//! 1-bit label bitmap in canvas (reading) order (WP3).
//!
//! # Contract (ARCHITECTURE.md §4.1, §5.1)
//! - A [`Bitmap`] has `length` lines (feed direction, = label length in dots) of `height`
//!   dots each (across the tape, = `TapeSpec::print_pins`).
//! - Storage is **line-major**: line `x` occupies `stride = ceil(height / 8)` bytes starting at
//!   `x * stride`; within a line, dot `y` is bit `7 - (y % 8)` of byte `y / 8` (MSB-first).
//!   Padding bits after `height` are always zero.
//! - Canvas coordinates: x = length (columns), y = across the tape (rows). Line `x` = canvas
//!   column `x`; dot `y` = canvas row `y` (row 0 at the top of the canvas).
//! - A bitmap is the label **as it reads**: column 0 is the left end and row 0 the top edge
//!   when the printed label is held with the text upright (\[HW\] orientation test label,
//!   PT-P710BT). Turning that into head pins and a send order is the **encoder's** job:
//!   row `y` goes to pin `left_margin_pins + y` (PROTOCOL.md §5.1) and the lines are sent in
//!   [`crate::ModelProfile::feed_order`] (PROTOCOL.md §5.3; last column first on PT models).
//!   No caller has to reverse or flip a page to get a readable label.
//! - All accessors are total: out-of-range `get` returns `false`, out-of-range `set` is a
//!   no-op, out-of-range `line` is empty (also on 32-bit targets, where `x × stride` could
//!   otherwise wrap). Constructors that decode caller data validate sizes and return
//!   [`Error`]. For caller-chosen dimensions (a length from a UI or from JavaScript) use the
//!   fallible [`Bitmap::try_new`] / [`crate::LabelRaster::try_new`]: they reject buffers above
//!   [`Bitmap::MAX_BYTES`] instead of aborting on allocation. The infallible [`Bitmap::new`]
//!   is meant for sizes the program controls.
//!
//!
//! # Orientation helpers (PROTOCOL.md §5.1, §5.3)
//! A UI supplies a normal, left-to-right label image (text reads along the tape). Every
//! canvas-order input ([`Bitmap::from_luma`], [`Bitmap::from_fn`], [`Bitmap::from_pbm`],
//! [`crate::LabelRaster`]) is stored transposed, so canvas column `x` *is* bitmap line `x`:
//! the 90° rotation between screen and print head happens in the storage layout, not in a
//! separate pass (and the reversed send order happens in the encoder). On top of that:
//! - [`Bitmap::reversed`] mirrors along the feed (left↔right; the software mirror for clear
//!   tape, §5.3), [`Bitmap::flipped_across`] mirrors across the tape, and
//!   [`Bitmap::rotated_180`] does both;
//! - [`Bitmap::rotated_cw`] / [`Bitmap::rotated_ccw`] turn a canvas by 90° (vertical text);
//! - [`Bitmap::centered_across`] / [`Bitmap::for_tape`] / [`Bitmap::placed_across`] fit an
//!   image of any height into the printable dots of a tape (`TapeSpec::print_pins`), centred
//!   across the tape. The encoder then puts dot `p` on head pin `left_margin_pins + p`.
//!
//! The storage primitives (constructors, `get`/`set`, `line`) were implemented in the scaffold
//! because every other work package depends on them.
//!
//! # Example
//! ```
//! use ptouch::Bitmap;
//!
//! // A 3-dot wide, 2-dot high canvas with ink at the top-left and bottom-right.
//! let bmp = Bitmap::from_fn(3, 2, |x, y| (x, y) == (0, 0) || (x, y) == (2, 1));
//! assert_eq!(bmp.line(0), [0b1000_0000]); // line 0 = canvas column 0
//! assert_eq!(bmp.line(2), [0b0100_0000]);
//! assert_eq!(bmp.trim_blank(), Some((0, 2)));
//! // Centre it on a 6-dot print area: two blank rows above, two below.
//! assert!(bmp.centered_across(6).get(0, 2));
//! ```

use alloc::format;
use alloc::vec;
use alloc::vec::Vec;

use crate::error::Error;
use crate::model::TapeSpec;

/// A 1-bpp label image in canvas (reading) order (see the module docs for the exact layout).
#[derive(Clone, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))] // no Deserialize: it would bypass the size invariant
pub struct Bitmap {
    length: u32,
    height: u16,
    data: Vec<u8>,
}

impl core::fmt::Debug for Bitmap {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Bitmap")
            .field("length", &self.length)
            .field("height", &self.height)
            .field("bytes", &self.data.len())
            .finish()
    }
}

impl Bitmap {
    /// Largest packed buffer [`Bitmap::try_new`] accepts: 256 MiB, far above any printable
    /// label (the longest page, 28 346 lines × 70 bytes on a 560-pin head, is ≈ 2 MB) and
    /// within `isize::MAX` on 32-bit targets (wasm32).
    pub const MAX_BYTES: usize = 256 * 1024 * 1024;

    /// Bytes per raster line for a given height: `ceil(height / 8)`.
    #[must_use]
    pub const fn stride_for(height: u16) -> usize {
        (height as usize).div_ceil(8)
    }

    /// Packed size of a `length × height` bitmap, if it is at most [`Bitmap::MAX_BYTES`].
    fn checked_len(length: u32, height: u16) -> Option<usize> {
        usize::try_from(length)
            .ok()?
            .checked_mul(Self::stride_for(height))
            .filter(|&n| n <= Self::MAX_BYTES)
    }

    /// An all-white bitmap, checking the size first.
    ///
    /// # Errors
    /// [`Error::InvalidInput`] if `length × ceil(height / 8)` overflows or exceeds
    /// [`Bitmap::MAX_BYTES`].
    ///
    /// ```
    /// use ptouch::Bitmap;
    /// assert_eq!(Bitmap::try_new(40, 128)?.length(), 40);
    /// assert!(Bitmap::try_new(u32::MAX, u16::MAX).is_err());
    /// # Ok::<(), ptouch::Error>(())
    /// ```
    pub fn try_new(length: u32, height: u16) -> Result<Self, Error> {
        let len =
            Self::checked_len(length, height).ok_or(Error::InvalidInput("bitmap too large"))?;
        Ok(Self {
            length,
            height,
            data: vec![0; len],
        })
    }

    /// An all-white bitmap.
    ///
    /// For sizes the program controls. The buffer is allocated unchecked, so a huge
    /// `length × height` aborts (or, on 32-bit targets, panics with a capacity overflow);
    /// use [`Bitmap::try_new`] for untrusted dimensions.
    #[must_use]
    pub fn new(length: u32, height: u16) -> Self {
        let len = (length as usize).saturating_mul(Self::stride_for(height));
        Self {
            length,
            height,
            data: vec![0; len],
        }
    }

    /// Wraps packed line-major data (the layout described in the module docs).
    ///
    /// # Errors
    /// [`Error::DataLength`] if `data.len() != length * ceil(height / 8)`.
    /// Padding bits beyond `height` are cleared rather than rejected.
    pub fn from_packed(length: u32, height: u16, mut data: Vec<u8>) -> Result<Self, Error> {
        let stride = Self::stride_for(height);
        let expected = (length as usize)
            .checked_mul(stride)
            .ok_or(Error::InvalidInput("bitmap too large"))?;
        if data.len() != expected {
            return Err(Error::DataLength {
                expected,
                got: data.len(),
            });
        }
        let pad = (stride * 8) as u32 - u32::from(height);
        if pad > 0 && stride > 0 {
            let mask = 0xFFu8 << pad;
            for line in data.chunks_exact_mut(stride) {
                if let Some(last) = line.last_mut() {
                    *last &= mask;
                }
            }
        }
        Ok(Self {
            length,
            height,
            data,
        })
    }

    /// Number of raster lines (label length in dots).
    #[must_use]
    pub fn length(&self) -> u32 {
        self.length
    }

    /// Dots per line (across the tape).
    #[must_use]
    pub fn height(&self) -> u16 {
        self.height
    }

    /// Bytes per line.
    #[must_use]
    pub fn stride(&self) -> usize {
        Self::stride_for(self.height)
    }

    /// Dot at line `x`, row `y`; `false` when out of range.
    #[must_use]
    pub fn get(&self, x: u32, y: u16) -> bool {
        if x >= self.length || y >= self.height {
            return false;
        }
        let i = x as usize * self.stride() + usize::from(y / 8);
        self.data.get(i).is_some_and(|b| b & (0x80 >> (y % 8)) != 0)
    }

    /// Sets dot at line `x`, row `y`; ignored when out of range.
    pub fn set(&mut self, x: u32, y: u16, on: bool) {
        if x >= self.length || y >= self.height {
            return;
        }
        let i = x as usize * self.stride() + usize::from(y / 8);
        if let Some(b) = self.data.get_mut(i) {
            let m = 0x80 >> (y % 8);
            if on { *b |= m } else { *b &= !m }
        }
    }

    /// Packed bytes of line `x` (`stride()` bytes); empty when out of range.
    #[must_use]
    pub fn line(&self, x: u32) -> &[u8] {
        if x >= self.length {
            return &[];
        }
        let s = self.stride();
        usize::try_from(x)
            .ok()
            .and_then(|x| x.checked_mul(s))
            .and_then(|start| self.data.get(start..start.checked_add(s)?))
            .unwrap_or(&[])
    }

    /// The whole packed buffer (line-major).
    #[must_use]
    pub fn as_packed(&self) -> &[u8] {
        &self.data
    }

    /// Consumes the bitmap and returns the packed buffer.
    #[must_use]
    pub fn into_packed(self) -> Vec<u8> {
        self.data
    }

    /// Builds a bitmap from a predicate `f(x, y)` (canvas coordinates).
    ///
    /// `f` is called once per dot, line by line (`x` outer, `y` inner).
    #[must_use]
    pub fn from_fn(length: u32, height: u16, mut f: impl FnMut(u32, u16) -> bool) -> Self {
        let mut bmp = Self::new(length, height);
        for x in 0..length {
            for y in 0..height {
                if f(x, y) {
                    bmp.set(x, y, true);
                }
            }
        }
        bmp
    }

    /// Builds a bitmap from 8-bit luminance in **canvas row-major** order (`width = length`,
    /// `rows = height`), setting dots whose luma is `< threshold` (dark = ink).
    ///
    /// # Errors
    /// [`Error::DataLength`] if `luma.len() != width * height`.
    pub fn from_luma(luma: &[u8], width: u32, height: u16, threshold: u8) -> Result<Self, Error> {
        let expected = crate::dither::buffer_len(width, u32::from(height), 1)?;
        if luma.len() != expected {
            return Err(Error::DataLength {
                expected,
                got: luma.len(),
            });
        }
        let mut bmp = Self::new(width, height);
        if width == 0 {
            return Ok(bmp);
        }
        for (y, row) in (0..height).zip(luma.chunks_exact(width as usize)) {
            for (x, &v) in (0..width).zip(row) {
                if v < threshold {
                    bmp.set(x, y, true);
                }
            }
        }
        Ok(bmp)
    }

    /// `true` when line `x` has no ink (also for an out-of-range `x`).
    #[must_use]
    pub fn is_line_blank(&self, x: u32) -> bool {
        self.line(x).iter().all(|&b| b == 0)
    }

    /// `true` when no dot is set.
    #[must_use]
    pub fn is_blank(&self) -> bool {
        self.data.iter().all(|&b| b == 0)
    }

    /// First and last non-blank line (inclusive), for auto length; `None` if blank.
    #[must_use]
    pub fn trim_blank(&self) -> Option<(u32, u32)> {
        let first = (0..self.length).find(|&x| !self.is_line_blank(x))?;
        let last = (first..self.length)
            .rev()
            .find(|&x| !self.is_line_blank(x))?;
        Some((first, last))
    }

    /// Copy of lines `[start, end)`.
    ///
    /// # Errors
    /// [`Error::InvalidInput`] if the range is empty or out of bounds.
    pub fn crop_lines(&self, start: u32, end: u32) -> Result<Self, Error> {
        if start >= end || end > self.length {
            return Err(Error::InvalidInput("crop range empty or out of bounds"));
        }
        let s = self.stride();
        let bytes = self
            .data
            .get(start as usize * s..end as usize * s)
            .ok_or(Error::InvalidInput("crop range empty or out of bounds"))?;
        Ok(Self {
            length: end - start,
            height: self.height,
            data: bytes.to_vec(),
        })
    }

    /// Copy padded with blank lines to at least `min_length` lines; `lead` of the padding goes
    /// before the content (0 = all at the end).
    ///
    /// `lead` is capped at the padding amount; a bitmap that is already long enough is
    /// returned unchanged.
    #[must_use]
    pub fn padded_to(&self, min_length: u32, lead: u32) -> Self {
        if self.length >= min_length {
            return self.clone();
        }
        let pad = min_length - self.length;
        let lead = lead.min(pad);
        let s = self.stride();
        let mut out = Self::new(min_length, self.height);
        let at = lead as usize * s;
        if let Some(dst) = out.data.get_mut(at..at + self.data.len()) {
            dst.copy_from_slice(&self.data);
        }
        out
    }

    /// Copy with the line order reversed (feed-direction flip, i.e. horizontal canvas flip).
    ///
    /// This is the software mirror of PROTOCOL.md §5.3 (printing on the back of clear tape on
    /// models without `ESC i M` mirror). It is not needed for normal printing: the encoder
    /// already sends lines in the model's feed order ([`crate::ModelProfile::feed_order`]).
    #[must_use]
    pub fn reversed(&self) -> Self {
        let s = self.stride();
        let mut data = Vec::with_capacity(self.data.len());
        if s > 0 {
            for line in self.data.chunks_exact(s).rev() {
                data.extend_from_slice(line);
            }
        }
        Self {
            length: self.length,
            height: self.height,
            data,
        }
    }

    /// Copy with every raster line repeated `factor` times along the feed: a normal-resolution
    /// label for the high-resolution feed (PROTOCOL.md §5.4; the factor is
    /// [`crate::ModelProfile::feed_factor`]). `factor` 0 or 1 returns a plain copy.
    ///
    /// # Errors
    /// [`Error::InvalidInput`] if the result would be longer than `u32::MAX` lines or larger
    /// than [`Bitmap::MAX_BYTES`].
    ///
    /// ```
    /// use ptouch::Bitmap;
    /// let bmp = Bitmap::from_fn(2, 8, |x, _| x == 1);
    /// let hr = bmp.stretched_feed(2)?;
    /// assert_eq!(hr.length(), 4);
    /// assert!(!hr.get(1, 0) && hr.get(2, 0) && hr.get(3, 0));
    /// # Ok::<(), ptouch::Error>(())
    /// ```
    pub fn stretched_feed(&self, factor: u32) -> Result<Self, Error> {
        if factor <= 1 {
            return Ok(self.clone());
        }
        let length = self
            .length
            .checked_mul(factor)
            .ok_or(Error::InvalidInput("bitmap too large"))?;
        let len = Self::checked_len(length, self.height)
            .ok_or(Error::InvalidInput("bitmap too large"))?;
        let mut data = Vec::with_capacity(len);
        let s = self.stride();
        if s > 0 {
            for line in self.data.chunks_exact(s) {
                for _ in 0..factor {
                    data.extend_from_slice(line);
                }
            }
        }
        Ok(Self {
            length,
            height: self.height,
            data,
        })
    }

    /// Copy mirrored across the tape (`y → height − 1 − y`, i.e. vertical canvas flip).
    #[must_use]
    pub fn flipped_across(&self) -> Self {
        let h = self.height;
        Self::from_fn(self.length, h, |x, y| self.get(x, h - 1 - y))
    }

    /// Copy rotated by 180° ([`Bitmap::reversed`] + [`Bitmap::flipped_across`]).
    #[must_use]
    pub fn rotated_180(&self) -> Self {
        self.reversed().flipped_across()
    }

    /// Canvas rotated 90° clockwise: the result has `length = height()` and
    /// `height = length()`. Old canvas pixel (`x`, `y`) moves to (`height − 1 − y`, `x`).
    ///
    /// # Errors
    /// [`Error::InvalidInput`] if `length()` exceeds `u16::MAX` (it becomes the new height).
    pub fn rotated_cw(&self) -> Result<Self, Error> {
        let new_height = u16::try_from(self.length)
            .map_err(|_| Error::InvalidInput("bitmap too long to rotate"))?;
        let h = u32::from(self.height);
        Ok(Self::from_fn(h, new_height, |nx, ny| {
            // nx = h − 1 − y  ⇒  y = h − 1 − nx;  ny = x
            self.get(u32::from(ny), u16::try_from(h - 1 - nx).unwrap_or(u16::MAX))
        }))
    }

    /// Canvas rotated 90° counter-clockwise: the result has `length = height()` and
    /// `height = length()`. Old canvas pixel (`x`, `y`) moves to (`y`, `length − 1 − x`).
    ///
    /// # Errors
    /// [`Error::InvalidInput`] if `length()` exceeds `u16::MAX` (it becomes the new height).
    pub fn rotated_ccw(&self) -> Result<Self, Error> {
        let new_height = u16::try_from(self.length)
            .map_err(|_| Error::InvalidInput("bitmap too long to rotate"))?;
        let w = self.length;
        Ok(Self::from_fn(
            u32::from(self.height),
            new_height,
            |nx, ny| {
                // nx = y, ny = w − 1 − x  ⇒  x = w − 1 − ny
                self.get(w - 1 - u32::from(ny), u16::try_from(nx).unwrap_or(u16::MAX))
            },
        ))
    }

    /// Copy re-framed to `height` dots across the tape, with old row `y` placed at row
    /// `y + offset`. Rows that fall outside `0..height` are dropped; new rows are blank.
    #[must_use]
    pub fn placed_across(&self, height: u16, offset: i32) -> Self {
        let mut out = Self::new(self.length, height);
        out.blit_or(self, 0, i64::from(offset));
        out
    }

    /// Copy re-framed to `height` dots across the tape with the content centred. When the
    /// bitmap is taller than `height`, the middle `height` rows are kept. An odd difference
    /// puts the extra blank row (or the extra cropped row) at the bottom.
    #[must_use]
    pub fn centered_across(&self, height: u16) -> Self {
        let diff = i32::from(height) - i32::from(self.height);
        self.placed_across(height, diff.div_euclid(2))
    }

    /// [`Bitmap::centered_across`] the printable dots of `tape` (`tape.print_pins`), giving a
    /// bitmap whose height the encoder accepts for that tape.
    #[must_use]
    pub fn for_tape(&self, tape: &TapeSpec) -> Self {
        self.centered_across(tape.print_pins)
    }

    /// Copy with every dot inverted (padding bits stay zero).
    #[must_use]
    pub fn inverted(&self) -> Self {
        let mut data: Vec<u8> = self.data.iter().map(|b| !b).collect();
        let s = self.stride();
        let pad = (s * 8) as u32 - u32::from(self.height);
        if pad > 0 && s > 0 {
            let mask = 0xFFu8 << pad;
            for line in data.chunks_exact_mut(s) {
                if let Some(last) = line.last_mut() {
                    *last &= mask;
                }
            }
        }
        Self {
            length: self.length,
            height: self.height,
            data,
        }
    }

    /// Draws `other` onto `self` with its line 0 / row 0 at (`x`, `y`), OR-ing ink and clipping
    /// at the edges.
    pub fn blit_or(&mut self, other: &Bitmap, x: i64, y: i64) {
        self.blit_with(other, x, y, |_, _| true);
    }

    /// OR-blit restricted to destination dots for which `allow(dx, dy)` is `true`.
    pub(crate) fn blit_with(
        &mut self,
        other: &Bitmap,
        x: i64,
        y: i64,
        mut allow: impl FnMut(u32, u16) -> bool,
    ) {
        let (sx0, sx1) = clip_range(x, i64::from(other.length), i64::from(self.length));
        let (sy0, sy1) = clip_range(y, i64::from(other.height), i64::from(self.height));
        for sx in sx0..sx1 {
            for sy in sy0..sy1 {
                let (Ok(sxu), Ok(syu)) = (u32::try_from(sx), u16::try_from(sy)) else {
                    continue;
                };
                if !other.get(sxu, syu) {
                    continue;
                }
                let (Ok(dx), Ok(dy)) = (u32::try_from(sx + x), u16::try_from(sy + y)) else {
                    continue;
                };
                if allow(dx, dy) {
                    self.set(dx, dy, true);
                }
            }
        }
    }

    /// Tinted RGBA preview in **canvas orientation** (`width = length`, `height = height`,
    /// row-major, 4 bytes per pixel). Colours are `0xRRGGBB`; alpha is always 255.
    #[must_use]
    pub fn to_rgba(&self, tape_rgb: u32, ink_rgb: u32) -> Vec<u8> {
        let rgba = |c: u32| {
            let [_, r, g, b] = c.to_be_bytes();
            [r, g, b, 0xFF]
        };
        let (tape, ink) = (rgba(tape_rgb), rgba(ink_rgb));
        let mut out = Vec::with_capacity(
            (self.length as usize)
                .saturating_mul(usize::from(self.height))
                .saturating_mul(4),
        );
        for y in 0..self.height {
            for x in 0..self.length {
                out.extend_from_slice(if self.get(x, y) { &ink } else { &tape });
            }
        }
        out
    }

    /// Encodes as binary PBM (`P4`) in canvas orientation (`width = length`, rows = height;
    /// 1 = black). Used for goldens and `ptouch decode`.
    ///
    /// The header is `P4\n<width> <height>\n`; each row is padded to a whole byte with zero bits.
    #[must_use]
    pub fn to_pbm(&self) -> Vec<u8> {
        let row_bytes = (self.length as usize).div_ceil(8);
        let mut out = format!("P4\n{} {}\n", self.length, self.height).into_bytes();
        out.reserve(row_bytes.saturating_mul(usize::from(self.height)));
        for y in 0..self.height {
            let mut byte = 0u8;
            for x in 0..self.length {
                if self.get(x, y) {
                    byte |= 0x80 >> (x % 8);
                }
                if x % 8 == 7 {
                    out.push(byte);
                    byte = 0;
                }
            }
            if !self.length.is_multiple_of(8) {
                out.push(byte);
            }
        }
        out
    }

    /// Decodes a PBM (`P4` binary or `P1` ASCII, comments allowed) in canvas orientation.
    ///
    /// Only the first image of a multi-image file is read; trailing bytes are ignored. The
    /// input length is checked against the header before anything is allocated, so a forged
    /// header cannot cause a large allocation.
    ///
    /// # Errors
    /// [`Error::Corrupt`] with `what = "pbm"` on malformed input; [`Error::InvalidInput`] if
    /// dimensions exceed `u32` length / `u16` height.
    pub fn from_pbm(bytes: &[u8]) -> Result<Self, Error> {
        let mut p = PbmReader { bytes, pos: 0 };
        let binary = match bytes.get(..2) {
            Some(b"P4") => true,
            Some(b"P1") => false,
            _ => return Err(p.corrupt()),
        };
        p.pos = 2;
        // The magic number must be followed by whitespace (or a comment).
        if !p.peek().is_some_and(|c| is_pbm_space(c) || c == b'#') {
            return Err(p.corrupt());
        }
        let width = p.header_number()?;
        let height = p.header_number()?;
        let length = u32::try_from(width).map_err(|_| Error::InvalidInput("pbm too wide"))?;
        let height = u16::try_from(height).map_err(|_| Error::InvalidInput("pbm too tall"))?;
        let mut bmp;
        if binary {
            // Exactly one whitespace byte separates the header from the raster.
            if !p.peek().is_some_and(is_pbm_space) {
                return Err(p.corrupt());
            }
            p.pos += 1;
            let row_bytes = (length as usize).div_ceil(8);
            let need = row_bytes
                .checked_mul(usize::from(height))
                .ok_or(Error::InvalidInput("pbm too large"))?;
            let raster = bytes
                .get(p.pos..)
                .and_then(|r| r.get(..need))
                .ok_or(Error::Corrupt {
                    what: "pbm",
                    offset: bytes.len(),
                })?;
            bmp = Self::new(length, height);
            if row_bytes > 0 {
                for (y, row) in (0..height).zip(raster.chunks_exact(row_bytes)) {
                    for x in 0..length {
                        let byte = row.get((x / 8) as usize).copied().unwrap_or(0);
                        if byte & (0x80 >> (x % 8)) != 0 {
                            bmp.set(x, y, true);
                        }
                    }
                }
            }
        } else {
            let pixels = u64::from(length) * u64::from(height);
            let remaining = bytes.len().saturating_sub(p.pos) as u64;
            if remaining < pixels {
                return Err(Error::Corrupt {
                    what: "pbm",
                    offset: bytes.len(),
                });
            }
            bmp = Self::new(length, height);
            for y in 0..height {
                for x in 0..length {
                    p.skip_space_and_comments();
                    match p.peek() {
                        Some(b'1') => bmp.set(x, y, true),
                        Some(b'0') => {}
                        _ => return Err(p.corrupt()),
                    }
                    p.pos += 1;
                }
            }
        }
        Ok(bmp)
    }
}

/// Source index range `[lo, hi)` of a `src_len`-long span placed at `offset` that lands inside
/// `0..dst_len`.
fn clip_range(offset: i64, src_len: i64, dst_len: i64) -> (i64, i64) {
    let lo = (-offset).clamp(0, src_len);
    let hi = (dst_len - offset).clamp(lo, src_len);
    (lo, hi)
}

/// PBM whitespace (netpbm: blank, TAB, CR, LF, VT, FF).
fn is_pbm_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0B | 0x0C)
}

/// Cursor over a PBM byte stream.
struct PbmReader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl PbmReader<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn corrupt(&self) -> Error {
        Error::Corrupt {
            what: "pbm",
            offset: self.pos.min(self.bytes.len()),
        }
    }

    /// Skips whitespace and `#` comments (to the end of the line).
    fn skip_space_and_comments(&mut self) {
        while let Some(c) = self.peek() {
            if is_pbm_space(c) {
                self.pos += 1;
            } else if c == b'#' {
                while self.peek().is_some_and(|c| c != b'\n' && c != b'\r') {
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    /// Reads one decimal header field (after whitespace/comments).
    fn header_number(&mut self) -> Result<u64, Error> {
        self.skip_space_and_comments();
        let start = self.pos;
        let mut n: u64 = 0;
        while let Some(c @ b'0'..=b'9') = self.peek() {
            n = n
                .checked_mul(10)
                .and_then(|n| n.checked_add(u64::from(c - b'0')))
                .ok_or(Error::InvalidInput("pbm dimensions too large"))?;
            self.pos += 1;
        }
        if self.pos == start {
            return Err(self.corrupt());
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_range_cases() {
        assert_eq!(clip_range(0, 5, 10), (0, 5));
        assert_eq!(clip_range(-2, 5, 10), (2, 5));
        assert_eq!(clip_range(8, 5, 10), (0, 2));
        assert_eq!(clip_range(20, 5, 10), (0, 0));
        assert_eq!(clip_range(-20, 5, 10), (5, 5));
    }
}

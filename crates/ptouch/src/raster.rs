//! Label composition from render planes (WP3).
//!
//! # Contract (ARCHITECTURE.md §4.1 `LabelRaster`, §5.2)
//! - A [`LabelRaster`] is a [`Bitmap`] under construction plus a *protected* mask.
//! - Compositing order in the MVP: tone → crisp → codes. Codes mark their area (including the
//!   quiet zone) protected; later tone blits never write into protected dots.
//! - All blits clip at the raster edges (negative offsets allowed) and validate buffer sizes.
//! - [`LabelRaster::blit_crisp`]: RGBA at `factor`× resolution in canvas row-major order,
//!   box-filtered to per-dot coverage (fraction of dark pixels, after compositing over white)
//!   and set where coverage ≥ `threshold`/255. `w`/`h` must be `length × factor` and
//!   `height × factor`.
//! - [`LabelRaster::blit_tone`]: RGBA at 1× for one image element at (x, y), converted with
//!   [`crate::dither`], written only where alpha > 0.
//! - [`LabelRaster::blit_code`]: modules painted at an integer `module_dots ≥ 1` (never
//!   dithered), with an optional 4-module (QR) / 10-module (1-D) quiet zone cleared to white.
//!
//! # Exact rules
//! - Crisp coverage of a dot is the mean darkness `255 − luma` of its `factor × factor` source
//!   pixels (luma composited over white, [`crate::dither::rgba_to_luma`]), rounded. The dot
//!   is inked when `coverage > 0` and `coverage ≥ threshold`. Crisp blits only add ink.
//! - Tone blits write ink *and* paper for every source pixel with alpha > 0.
//! - Code blits clear their whole area (modules and quiet zone) to paper, ink the dark
//!   modules and mark the area protected.
//! - No blit changes a protected dot, so codes painted earlier stay intact whatever the order.
//! - A [`ModuleMatrix`] whose rows are all identical (in particular `height == 1`) is a linear
//!   (1-D) barcode: its quiet zone is 10 modules on the left and right only, and its bar height
//!   is `height × module_dots` dots (repeat the row to make taller bars). Any other matrix is
//!   2-D: 4 modules on all four sides.
//!
//! # Example
//! ```
//! use ptouch::{LabelRaster, ModuleMatrix};
//!
//! let mut r = LabelRaster::new(40, 16);
//! // A black 3x3 pixel block at 3x resolution covers exactly dot (1, 1).
//! let (w, h) = (40 * 3, 16 * 3);
//! let mut rgba = vec![255u8; (w * h * 4) as usize];
//! for py in 3..6 {
//!     for px in 3..6 {
//!         let i = ((py * w + px) * 4) as usize;
//!         rgba[i..i + 3].copy_from_slice(&[0, 0, 0]);
//!     }
//! }
//! r.blit_crisp(&rgba, w, h, 3, 128).unwrap();
//! let m = ModuleMatrix { width: 2, height: 2, modules: vec![1, 0, 0, 1] };
//! r.blit_code(&m, 20, 4, 2, false).unwrap();
//! let bmp = r.finish();
//! assert!(bmp.get(1, 1) && !bmp.get(0, 0));
//! assert!(bmp.get(20, 4) && bmp.get(21, 5) && !bmp.get(22, 4) && bmp.get(23, 7));
//! ```

use alloc::vec;
use alloc::vec::Vec;

use crate::bitmap::Bitmap;
use crate::dither::{self, Dither, ToneAdjust};
use crate::error::Error;

/// A barcode / QR module matrix: `modules[y * width + x]` is 1 for a dark module.
/// Produced by the (future) `codes` feature or by the caller.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ModuleMatrix {
    /// Modules per row.
    pub width: u32,
    /// Rows (1 for linear barcodes).
    pub height: u32,
    /// Row-major 0/1 modules, `width × height` entries.
    pub modules: Vec<u8>,
}

/// Composes the final [`Bitmap`] from the crisp, tone and code planes.
#[derive(Debug, Clone)]
pub struct LabelRaster {
    bitmap: Bitmap,
    protected: Bitmap,
}

impl LabelRaster {
    /// A blank raster of `length` lines × `height` dots, checking the size first (use this
    /// for dimensions that come from a UI or from JavaScript).
    ///
    /// # Errors
    /// [`crate::Error::InvalidInput`] if a plane would exceed [`Bitmap::MAX_BYTES`].
    pub fn try_new(length: u32, height: u16) -> Result<Self, crate::Error> {
        Ok(Self {
            bitmap: Bitmap::try_new(length, height)?,
            protected: Bitmap::try_new(length, height)?,
        })
    }

    /// A blank raster of `length` lines × `height` dots.
    ///
    /// For sizes the program controls (see [`Bitmap::new`]); use [`LabelRaster::try_new`] for
    /// untrusted dimensions.
    #[must_use]
    pub fn new(length: u32, height: u16) -> Self {
        Self {
            bitmap: Bitmap::new(length, height),
            protected: Bitmap::new(length, height),
        }
    }

    /// Lines (label length in dots).
    #[must_use]
    pub fn length(&self) -> u32 {
        self.bitmap.length()
    }

    /// Dots across the tape.
    #[must_use]
    pub fn height(&self) -> u16 {
        self.bitmap.height()
    }

    /// `true` when dot (`x`, `y`) belongs to a code area and can no longer be changed.
    #[must_use]
    pub fn is_protected(&self, x: u32, y: u16) -> bool {
        self.protected.get(x, y)
    }

    /// Sets a dot unless it is protected.
    fn put(&mut self, x: u32, y: u16, on: bool) {
        if !self.protected.get(x, y) {
            self.bitmap.set(x, y, on);
        }
    }

    /// Composites a crisp (text/shape) plane rendered at `factor`× resolution.
    ///
    /// # Errors
    /// [`Error::InvalidInput`] if `factor == 0` or `w`/`h` do not match `length × factor` /
    /// `height × factor`; [`Error::DataLength`] if `rgba.len() != w × h × 4`.
    pub fn blit_crisp(
        &mut self,
        rgba: &[u8],
        w: u32,
        h: u32,
        factor: u8,
        threshold: u8,
    ) -> Result<(), Error> {
        if factor == 0 {
            return Err(Error::InvalidInput("crisp factor must be at least 1"));
        }
        let f = u64::from(factor);
        if u64::from(w) != u64::from(self.length()) * f
            || u64::from(h) != u64::from(self.height()) * f
        {
            return Err(Error::InvalidInput(
                "crisp plane must be (length x factor) by (height x factor)",
            ));
        }
        let expected = dither::buffer_len(w, h, 4)?;
        if rgba.len() != expected {
            return Err(Error::DataLength {
                expected,
                got: rgba.len(),
            });
        }
        let f = usize::from(factor);
        let n = u32::from(factor) * u32::from(factor);
        let row_bytes = w as usize * 4;
        let mut sums = vec![0u32; self.length() as usize];
        if row_bytes == 0 {
            return Ok(());
        }
        for (y, block) in (0..self.height()).zip(rgba.chunks_exact(row_bytes * f)) {
            sums.fill(0);
            for row in block.chunks_exact(row_bytes) {
                for (i, px) in row.chunks_exact(4).enumerate() {
                    if let (&[r, g, b, a], Some(sum)) = (px, sums.get_mut(i / f)) {
                        *sum += 255 - u32::from(dither::pixel_luma(r, g, b, a));
                    }
                }
            }
            for (x, &sum) in (0..self.length()).zip(&sums) {
                let coverage = (sum + n / 2) / n;
                if coverage > 0 && coverage >= u32::from(threshold) {
                    self.put(x, y, true);
                }
            }
        }
        Ok(())
    }

    /// Composites one image element (1× RGBA, `w × h`) at (`x`, `y`) with dithering.
    ///
    /// The whole element is dithered (so error diffusion does not depend on clipping), then
    /// every pixel with alpha > 0 that lands inside the raster overwrites the dot.
    ///
    /// # Errors
    /// [`Error::DataLength`] if `rgba.len() != w × h × 4`.
    #[allow(clippy::too_many_arguments)]
    pub fn blit_tone(
        &mut self,
        rgba: &[u8],
        w: u32,
        h: u32,
        x: i32,
        y: i32,
        dither: Dither,
        adj: ToneAdjust,
    ) -> Result<(), Error> {
        let mut luma = dither::rgba_to_luma(rgba, w, h)?;
        dither::adjust_tone(&mut luma, &adj);
        let ink = dither::to_ink(&luma, w as usize, dither);
        let alpha = rgba.chunks_exact(4).map(|p| p.get(3).copied().unwrap_or(0));
        for (i, (&on, a)) in ink.iter().zip(alpha).enumerate() {
            if a == 0 {
                continue;
            }
            let (Ok(sx), Ok(sy)) = (i64::try_from(i % w as usize), i64::try_from(i / w as usize))
            else {
                continue;
            };
            if let Some((dx, dy)) = self.dest(i64::from(x) + sx, i64::from(y) + sy) {
                self.put(dx, dy, on);
            }
        }
        Ok(())
    }

    /// Converts signed raster coordinates to a valid dot position.
    fn dest(&self, x: i64, y: i64) -> Option<(u32, u16)> {
        let x = u32::try_from(x).ok().filter(|&x| x < self.length())?;
        let y = u16::try_from(y).ok().filter(|&y| y < self.height())?;
        Some((x, y))
    }

    /// Paints a module matrix at (`x`, `y`) with `module_dots` dots per module and marks the
    /// area protected.
    ///
    /// (`x`, `y`) is the top-left corner of the first module; the quiet zone, if requested,
    /// extends outside it. Everything is clipped at the raster edges.
    ///
    /// # Errors
    /// [`Error::InvalidInput`] if `module_dots == 0` or `m.modules.len() != width × height`.
    pub fn blit_code(
        &mut self,
        m: &ModuleMatrix,
        x: i32,
        y: i32,
        module_dots: u8,
        quiet_zone: bool,
    ) -> Result<(), Error> {
        if module_dots == 0 {
            return Err(Error::InvalidInput("module_dots must be at least 1"));
        }
        let cells = dither::buffer_len(m.width, m.height, 1)?;
        if m.modules.len() != cells {
            return Err(Error::InvalidInput("module matrix size mismatch"));
        }
        let md = i64::from(module_dots);
        let width = m.width as usize;
        let linear = width == 0 || {
            let mut rows = m.modules.chunks_exact(width);
            let first = rows.next();
            rows.all(|r| Some(r) == first)
        };
        let (qx, qy) = match (quiet_zone, linear) {
            (false, _) => (0, 0),
            (true, true) => (10 * md, 0),
            (true, false) => (4 * md, 4 * md),
        };
        let (x0, y0) = (i64::from(x), i64::from(y));
        let code_w = i64::from(m.width) * md;
        let code_h = i64::from(m.height) * md;
        let ax0 = (x0 - qx).max(0);
        let ax1 = (x0 + code_w + qx).min(i64::from(self.length()));
        let ay0 = (y0 - qy).max(0);
        let ay1 = (y0 + code_h + qy).min(i64::from(self.height()));
        for dx in ax0..ax1 {
            for dy in ay0..ay1 {
                let Some((ux, uy)) = self.dest(dx, dy) else {
                    continue;
                };
                let (rx, ry) = (dx - x0, dy - y0);
                let dark = rx >= 0
                    && ry >= 0
                    && rx < code_w
                    && ry < code_h
                    && usize::try_from(ry / md * i64::from(m.width) + rx / md)
                        .ok()
                        .and_then(|i| m.modules.get(i))
                        .is_some_and(|&v| v != 0);
                if self.protected.get(ux, uy) {
                    continue;
                }
                self.bitmap.set(ux, uy, dark);
                self.protected.set(ux, uy, true);
            }
        }
        Ok(())
    }

    /// Composites an existing bitmap (OR) at (`x`, `y`), e.g. CLI-rendered text.
    /// Protected dots are left unchanged.
    pub fn blit_bitmap(&mut self, src: &Bitmap, x: i32, y: i32) {
        let protected = &self.protected;
        self.bitmap
            .blit_with(src, i64::from(x), i64::from(y), |dx, dy| {
                !protected.get(dx, dy)
            });
    }

    /// Finishes composition.
    #[must_use]
    pub fn finish(self) -> Bitmap {
        self.bitmap
    }
}

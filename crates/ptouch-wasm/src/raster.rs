//! `Raster` (core `LabelRaster`) and `Bitmap1` (core `Bitmap`) handles.

use tsify::Ts;
use wasm_bindgen::prelude::*;

use crate::convert::tone;
use crate::dto::{ModuleMatrix, ToneOptions};
use crate::error::{from_ts, from_ts_or_default, js_err};

/// Compositor for one label page: crisp plane, tone (photo) planes and code planes
/// (ARCHITECTURE.md §5.2). Canvas coordinates: x = length (feed), y = across the tape.
#[wasm_bindgen]
#[derive(Debug)]
pub struct Raster {
    inner: ptouch::LabelRaster,
}

#[wasm_bindgen]
impl Raster {
    /// A blank raster of `length` × `height` dots (`height` = `PrintArea.heightDots`).
    ///
    /// # Errors
    /// `INVALID_INPUT` if the bitmap would exceed the core's size limit.
    #[wasm_bindgen(constructor)]
    pub fn new(length: u32, height: u16) -> Result<Raster, JsValue> {
        ptouch::LabelRaster::try_new(length, height)
            .map(|inner| Raster { inner })
            .map_err(js_err)
    }

    /// Length in dots.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn length(&self) -> u32 {
        self.inner.length()
    }

    /// Height in dots.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn height(&self) -> u16 {
        self.inner.height()
    }

    /// Composites the crisp plane: RGBA (`ImageData.data`) of `w × h` =
    /// `(length × factor) × (height × factor)`, box-filtered to coverage and thresholded
    /// (`threshold` 0–255 of coverage; 128 = 50 %).
    ///
    /// # Errors
    /// `INVALID_INPUT` (factor 0 / wrong dimensions), `DATA_LENGTH`.
    #[wasm_bindgen(js_name = blitCrisp)]
    pub fn blit_crisp(
        &mut self,
        rgba: &[u8],
        w: u32,
        h: u32,
        factor: u8,
        threshold: u8,
    ) -> Result<(), JsValue> {
        self.inner
            .blit_crisp(rgba, w, h, factor, threshold)
            .map_err(js_err)
    }

    /// Composites one image element (1× RGBA `w × h`) at (`x`, `y`) with dithering.
    ///
    /// The whole element is dithered (error diffusion does not depend on clipping); pixels
    /// with alpha 0 leave the raster untouched; protected (code) dots never change.
    ///
    /// # Errors
    /// `DATA_LENGTH`, `INVALID_INPUT` (bad options shape).
    #[wasm_bindgen(js_name = blitTone)]
    #[allow(clippy::too_many_arguments)]
    pub fn blit_tone(
        &mut self,
        rgba: &[u8],
        w: u32,
        h: u32,
        x: i32,
        y: i32,
        opts: Option<Ts<ToneOptions>>,
    ) -> Result<(), JsValue> {
        let (dither, adj) = tone(&from_ts_or_default(opts)?);
        self.inner
            .blit_tone(rgba, w, h, x, y, dither, adj)
            .map_err(js_err)
    }

    /// Paints a module matrix at (`x`, `y`) with `moduleDots` dots per module, optionally with
    /// a quiet zone (4 modules around 2D codes; 10 modules left/right of linear codes, i.e.
    /// matrices whose rows are all equal), and protects the area from later planes.
    /// (`x`, `y`) is the first module's top-left corner; the quiet zone extends outside it.
    ///
    /// # Errors
    /// `INVALID_INPUT` (module_dots 0, matrix size mismatch, bad shape).
    #[wasm_bindgen(js_name = blitCode)]
    pub fn blit_code(
        &mut self,
        m: Ts<ModuleMatrix>,
        x: i32,
        y: i32,
        module_dots: u8,
        quiet_zone: bool,
    ) -> Result<(), JsValue> {
        let m = from_ts(&m)?;
        let m = ptouch::ModuleMatrix {
            width: m.width,
            height: m.height,
            modules: m.modules,
        };
        self.inner
            .blit_code(&m, x, y, module_dots, quiet_zone)
            .map_err(js_err)
    }

    /// ORs an existing bitmap at (`x`, `y`) (protected dots unchanged).
    #[wasm_bindgen(js_name = blitBitmap)]
    pub fn blit_bitmap(&mut self, src: &Bitmap1, x: i32, y: i32) {
        self.inner.blit_bitmap(&src.inner, x, y);
    }

    /// Consumes the raster (the JS handle becomes unusable) and returns the final bitmap.
    #[must_use]
    pub fn finish(self) -> Bitmap1 {
        Bitmap1 {
            inner: self.inner.finish(),
        }
    }
}

/// A 1-bpp label image in print order (core `Bitmap`): the exact dots that are previewed and
/// sent. Column 0 = left end of the label as read.
#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct Bitmap1 {
    pub(crate) inner: ptouch::Bitmap,
}

impl Bitmap1 {
    /// Wraps a core bitmap (crate-internal).
    #[must_use]
    pub(crate) fn from_core(inner: ptouch::Bitmap) -> Self {
        Self { inner }
    }
}

#[wasm_bindgen]
impl Bitmap1 {
    /// From packed line-major data (`ceil(height/8)` bytes per line, MSB first).
    ///
    /// # Errors
    /// `DATA_LENGTH`.
    #[wasm_bindgen(js_name = fromPacked)]
    pub fn from_packed(length: u32, height: u16, data: Vec<u8>) -> Result<Bitmap1, JsValue> {
        ptouch::Bitmap::from_packed(length, height, data)
            .map(Bitmap1::from_core)
            .map_err(js_err)
    }

    /// From 8-bit luminance in canvas row-major order (`width` = length, `height` rows),
    /// converted with `opts` (threshold at 128 by default; dithering and tone adjustments
    /// optional). Dark = ink.
    ///
    /// # Errors
    /// `DATA_LENGTH`, `INVALID_INPUT`.
    #[wasm_bindgen(js_name = fromLuma)]
    pub fn from_luma(
        luma: &[u8],
        width: u32,
        height: u16,
        opts: Option<Ts<ToneOptions>>,
    ) -> Result<Bitmap1, JsValue> {
        let (dither, adj) = tone(&from_ts_or_default(opts)?);
        ptouch::dither::dither(luma, width, height, dither, &adj)
            .map(Bitmap1::from_core)
            .map_err(js_err)
    }

    /// From RGBA (`ImageData.data`, composited over white) in canvas orientation, converted
    /// like [`Bitmap1::from_luma`].
    ///
    /// # Errors
    /// `DATA_LENGTH`, `INVALID_INPUT`.
    #[wasm_bindgen(js_name = fromRgba)]
    pub fn from_rgba(
        rgba: &[u8],
        width: u32,
        height: u16,
        opts: Option<Ts<ToneOptions>>,
    ) -> Result<Bitmap1, JsValue> {
        let luma = ptouch::dither::rgba_to_luma(rgba, width, u32::from(height)).map_err(js_err)?;
        Self::from_luma(&luma, width, height, opts)
    }

    /// Length in dots (raster lines).
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn length(&self) -> u32 {
        self.inner.length()
    }

    /// Copy of lines `[start, end)` (e.g. with `trimBlank()` for auto length).
    ///
    /// # Errors
    /// `INVALID_INPUT` for an empty or out-of-bounds range.
    #[wasm_bindgen(js_name = cropLines)]
    pub fn crop_lines(&self, start: u32, end: u32) -> Result<Bitmap1, JsValue> {
        self.inner
            .crop_lines(start, end)
            .map(Bitmap1::from_core)
            .map_err(js_err)
    }

    /// Height in dots (across the tape).
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn height(&self) -> u16 {
        self.inner.height()
    }

    /// Dot at (x, y).
    #[must_use]
    pub fn get(&self, x: u32, y: u16) -> bool {
        self.inner.get(x, y)
    }

    /// `true` if no dot is set.
    #[wasm_bindgen(js_name = isBlank)]
    #[must_use]
    pub fn is_blank(&self) -> bool {
        self.inner.is_blank()
    }

    /// `[first, last]` non-blank line, or `undefined` for a blank bitmap.
    #[wasm_bindgen(js_name = trimBlank)]
    #[must_use]
    pub fn trim_blank(&self) -> Option<Vec<u32>> {
        self.inner.trim_blank().map(|(a, b)| vec![a, b])
    }

    /// Tinted RGBA in canvas orientation (`width = length`, `height = height`) for
    /// `new ImageData(...)`. Colours are `0xRRGGBB`.
    #[wasm_bindgen(js_name = toRgba)]
    #[must_use]
    pub fn to_rgba(&self, tape_rgb: u32, ink_rgb: u32) -> Vec<u8> {
        self.inner.to_rgba(tape_rgb, ink_rgb)
    }

    /// Packed line-major bytes (snapshot tests, thumbnails).
    #[wasm_bindgen(js_name = toPacked)]
    #[must_use]
    pub fn to_packed(&self) -> Vec<u8> {
        self.inner.as_packed().to_vec()
    }

    /// Binary PBM (P4) for "download decoded page".
    #[wasm_bindgen(js_name = toPbm)]
    #[must_use]
    pub fn to_pbm(&self) -> Vec<u8> {
        self.inner.to_pbm()
    }

    /// A copy with its own handle (e.g. to pass copies to `encodeJob`, which consumes pages).
    #[wasm_bindgen(js_name = clone)]
    #[must_use]
    pub fn clone_handle(&self) -> Bitmap1 {
        self.clone()
    }
}

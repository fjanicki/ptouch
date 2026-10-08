//! Job encoding (core `encode_job`) and decoding (core `decode_job`).

use tsify::Ts;
use wasm_bindgen::prelude::*;

use crate::convert::{command_text, encode_pages, resolve_media, resolve_model};
use crate::dto::JobOptions;
use crate::error::{from_ts_or_default, js_err};
use crate::raster::Bitmap1;

/// Encodes `pages` (one bitmap per printed label, normal resolution, canvas orientation) for
/// `model` / `mediaId`. Applies `prepare_pages` (high-res stretch, software mirror) then
/// `encode_job`; `opts.copies` repeats the page list inside the same job.
/// **Consumes** the page handles; pass `bitmap.clone()` to keep a preview.
///
/// # Errors
/// `UNKNOWN_MODEL`, `UNSUPPORTED_MEDIA`, `EMPTY`, `BITMAP_SIZE`, `TOO_SHORT`, `TOO_LONG`,
/// `UNSUPPORTED`, `INVALID_INPUT`.
#[wasm_bindgen(js_name = encodeJob)]
pub fn encode_job(
    model: &str,
    media_id: &str,
    pages: Vec<Bitmap1>,
    opts: Option<Ts<JobOptions>>,
) -> Result<Job, JsValue> {
    let opts = from_ts_or_default(opts)?;
    let p = resolve_model(model).map_err(js_err)?;
    let t = resolve_media(p, media_id).map_err(js_err)?;
    let pages: Vec<ptouch::Bitmap> = pages.into_iter().map(|b| b.inner).collect();
    encode_pages(p, t, &pages, &opts)
        .map(|inner| Job { inner })
        .map_err(js_err)
}

/// An encoded print job (core `EncodedJob`).
#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct Job {
    pub(crate) inner: ptouch::EncodedJob,
}

#[wasm_bindgen]
impl Job {
    /// Unpaced byte stream (`preamble ‖ pages ‖ epilogue`) for "Download .bin".
    #[wasm_bindgen(js_name = toBytes)]
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        self.inner.to_bytes()
    }

    /// Number of pages (labels).
    #[wasm_bindgen(getter, js_name = pageCount)]
    #[must_use]
    pub fn page_count(&self) -> u16 {
        self.inner.page_count()
    }

    /// Raster lines per page actually sent (after padding).
    #[wasm_bindgen(js_name = pageLines)]
    #[must_use]
    pub fn page_lines(&self) -> Vec<u32> {
        self.inner.page_lines.clone()
    }

    /// Total raster lines (for print-time estimates).
    #[wasm_bindgen(getter, js_name = totalLines)]
    #[must_use]
    pub fn total_lines(&self) -> u32 {
        self.inner.total_lines()
    }

    /// Width byte the job was encoded for (`st[10]` must match).
    #[wasm_bindgen(getter, js_name = mediaWidthByte)]
    #[must_use]
    pub fn media_width_byte(&self) -> u8 {
        self.inner.media_width_byte
    }

    /// Model name the job was encoded for.
    #[wasm_bindgen(getter, js_name = modelName)]
    #[must_use]
    pub fn model_name(&self) -> Option<String> {
        ptouch::profile(self.inner.model).map(|p| p.name.to_owned())
    }

    /// `true` if the job uses the 180×360 high-resolution feed.
    #[wasm_bindgen(getter, js_name = highResolution)]
    #[must_use]
    pub fn high_resolution(&self) -> bool {
        self.inner.high_resolution
    }

    /// Total encoded size in bytes (same as `toBytes().length`, without the copy).
    #[wasm_bindgen(getter, js_name = byteLength)]
    #[must_use]
    pub fn byte_length(&self) -> u32 {
        let n = self.inner.preamble.len()
            + self.inner.pages.iter().map(Vec::len).sum::<usize>()
            + self.inner.epilogue.len();
        u32::try_from(n).unwrap_or(u32::MAX)
    }
}

/// Decodes a job byte stream with the core's device-side parser (virtual printer view).
///
/// # Errors
/// `UNKNOWN_MODEL`, `CORRUPT`, `UNSUPPORTED_MEDIA`.
#[wasm_bindgen(js_name = decodeJob)]
pub fn decode_job(model: &str, bytes: &[u8]) -> Result<DecodedJob, JsValue> {
    let p = resolve_model(model).map_err(js_err)?;
    let d = ptouch::decode_job(p, bytes).map_err(js_err)?;
    Ok(DecodedJob {
        violations: d.violations.iter().map(|v| format!("{v:?}")).collect(),
        commands: d.commands.iter().map(command_text).collect(),
        pages: d.pages,
    })
}

/// Result of [`decode_job`].
#[wasm_bindgen]
#[derive(Debug)]
pub struct DecodedJob {
    pub(crate) pages: Vec<ptouch::Bitmap>,
    pub(crate) violations: Vec<String>,
    pub(crate) commands: Vec<String>,
}

#[wasm_bindgen]
impl DecodedJob {
    /// Number of decoded pages (without copying them).
    #[wasm_bindgen(getter, js_name = pageCount)]
    #[must_use]
    pub fn page_count(&self) -> u32 {
        u32::try_from(self.pages.len()).unwrap_or(u32::MAX)
    }

    /// Decoded pages as bitmaps (label orientation, same as the preview).
    #[must_use]
    pub fn pages(&self) -> Vec<Bitmap1> {
        self.pages.iter().cloned().map(Bitmap1::from_core).collect()
    }

    /// Protocol rule violations found while decoding (empty for a well-formed job).
    #[must_use]
    pub fn violations(&self) -> Vec<String> {
        self.violations.clone()
    }

    /// One line per decoded command (`Debug` text; raster lines as `RasterLine(n bytes)`),
    /// for the diagnostics view.
    #[must_use]
    pub fn commands(&self) -> Vec<String> {
        self.commands.clone()
    }
}

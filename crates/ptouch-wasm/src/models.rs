//! Model and media table lookups (core `model` module).

use tsify::Ts;
use wasm_bindgen::prelude::*;

use crate::convert::{
    media_dto, media_for_width_mm, model_dto, print_area_dto, resolve_media, resolve_model,
};
use crate::dto::{MediaInfo, ModelInfo, PrintArea, TapeKind};
use crate::error::{from_ts, js_err, ts};

/// Every model in the core table, in table order (PT-P710BT first).
///
/// # Errors
/// Only on an internal serialization failure.
#[wasm_bindgen(js_name = listModels)]
pub fn list_models() -> Result<Vec<Ts<ModelInfo>>, JsValue> {
    ptouch::profiles()
        .iter()
        .map(|p| ts(&model_dto(p)))
        .collect()
}

/// Geometry for rendering a label of `media_id` on `model` (normal resolution, the tape's
/// default feed margin).
///
/// # Errors
/// `UNKNOWN_MODEL` (name not found), `UNSUPPORTED_MEDIA` (id not in the model's media list).
#[wasm_bindgen(js_name = printArea)]
pub fn print_area(model: &str, media_id: &str) -> Result<Ts<PrintArea>, JsValue> {
    let p = resolve_model(model).map_err(js_err)?;
    let t = resolve_media(p, media_id).map_err(js_err)?;
    ts(&print_area_dto(p, t))
}

/// Media entry of `model` for a nominal width (3.5 → width byte 4) and kind (default TZe).
/// Used when designing offline (no status yet).
///
/// # Errors
/// `UNKNOWN_MODEL`, `UNSUPPORTED_MEDIA`, `INVALID_INPUT` (width not a positive number).
#[wasm_bindgen(js_name = mediaForWidth)]
pub fn media_for_width(
    model: &str,
    width_mm: f64,
    kind: Option<Ts<TapeKind>>,
) -> Result<Ts<MediaInfo>, JsValue> {
    let p = resolve_model(model).map_err(js_err)?;
    let kind = kind.map(|k| from_ts(&k)).transpose()?;
    let t = media_for_width_mm(p, width_mm, kind).map_err(js_err)?;
    ts(&media_dto(t))
}

/// Media entry for raw status bytes `st[10]` / `st[11]` (core `tape_for_status`).
///
/// # Errors
/// `UNKNOWN_MODEL`, `NO_MEDIA`, `UNSUPPORTED_MEDIA`.
#[wasm_bindgen(js_name = mediaForStatus)]
pub fn media_for_status(
    model: &str,
    width_byte: u8,
    media_type_byte: u8,
) -> Result<Ts<MediaInfo>, JsValue> {
    let p = resolve_model(model).map_err(js_err)?;
    let t = ptouch::tape_for_status(p, width_byte, media_type_byte).map_err(js_err)?;
    ts(&media_dto(t))
}

//! Consistency checks on the parsed table, run before anything is emitted.
//!
//! Every rule here mirrors a statement in the `docs/models.toml` header or in PROTOCOL.md; a
//! violation means the table (or the generator) is wrong, so generation stops.

use std::collections::{BTreeMap, BTreeSet};

use super::schema::{CancelCommand, MediaRow, ModelRow, SCHEMA_VERSION, Table, TapeKind};

/// Model keys that are always carried by the table: when absent they MUST be listed in
/// `unknown` (models.toml header, "A key whose value is UNKNOWN is OMITTED and its name is
/// listed in the model's `unknown` array").
const REQUIRED_UNLESS_UNKNOWN: &[&str] = &[
    "protocol_version",
    "raster_is_default",
    "supports_cut_every",
    "supports_chain",
    "min_length_mm",
    "battery_format",
    "editor_min_label_mm",
    "max_length_mm",
];

/// `ptouch::Model` variant name for a marketing name: drop `PT-`, then `Pt` + the first
/// character upper-cased + the rest lower-cased (`PT-P710BT` → `PtP710bt`,
/// `PT-P715eBT` → `PtP715ebt`).
pub fn variant_name(name: &str) -> Result<String, String> {
    let rest = name
        .strip_prefix("PT-")
        .ok_or_else(|| format!("model name {name:?} does not start with \"PT-\""))?;
    let mut chars = rest.chars();
    let first = chars
        .next()
        .ok_or_else(|| format!("model name {name:?} is empty after \"PT-\""))?;
    if !rest.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!(
            "model name {name:?} has non-alphanumeric characters"
        ));
    }
    let mut out = String::from("Pt");
    out.push(first.to_ascii_uppercase());
    out.extend(chars.map(|c| c.to_ascii_lowercase()));
    Ok(out)
}

/// Rust `static` name for a media id: upper-case, `-` and `.` become `_`
/// (`tze128-3.5` → `TZE128_3_5`).
pub fn static_name(id: &str) -> String {
    id.chars()
        .map(|c| match c {
            '-' | '.' => '_',
            c => c.to_ascii_uppercase(),
        })
        .collect()
}

/// Converts a millimetre value to tenths, requiring it to be an exact multiple of 0.1 mm.
pub fn mm_x10(value: f64, what: &str) -> Result<u32, String> {
    let scaled = value * 10.0;
    let rounded = scaled.round();
    if !(0.0..=f64::from(u32::MAX)).contains(&rounded) || (scaled - rounded).abs() > 1e-6 {
        return Err(format!(
            "{what} = {value} is not a non-negative multiple of 0.1 mm"
        ));
    }
    // In range and integral (checked above), so the conversion is exact.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Ok(rounded as u32)
}

/// Expected status `st[11]` for a media kind (PROTOCOL.md §4.6.1).
fn status_type_for(kind: TapeKind) -> u8 {
    match kind {
        TapeKind::Tze => 0x01,
        TapeKind::Hs2 => 0x11,
        TapeKind::Fle => 0x13,
        TapeKind::Sl => 0x16,
        TapeKind::Hs3 => 0x17,
    }
}

/// Validates the whole table. `enum_variants` are the `ptouch::Model` variants in source
/// order. Returns every problem found, not just the first.
pub fn validate(table: &Table, enum_variants: &[String]) -> Result<(), Vec<String>> {
    let mut errs = Vec::new();
    if table.schema_version != SCHEMA_VERSION {
        errs.push(format!(
            "schema_version = {} but the generator implements {SCHEMA_VERSION}",
            table.schema_version
        ));
    }
    validate_meta(table, &mut errs);

    let mut media_by_id: BTreeMap<&str, &MediaRow> = BTreeMap::new();
    let mut static_names = BTreeSet::new();
    for m in &table.media {
        if media_by_id.insert(&m.id, m).is_some() {
            errs.push(format!("duplicate media id {:?}", m.id));
        }
        if !static_names.insert(static_name(&m.id)) {
            errs.push(format!(
                "media id {:?} collides with another static name",
                m.id
            ));
        }
        validate_media(m, &mut errs);
    }

    let mut variants = Vec::new();
    let mut names = BTreeSet::new();
    let mut codes = BTreeSet::new();
    let mut referenced = BTreeSet::new();
    for m in &table.model {
        match variant_name(&m.name) {
            Ok(v) => variants.push(v),
            Err(e) => errs.push(e),
        }
        if !names.insert(m.name.to_ascii_lowercase()) {
            errs.push(format!("duplicate model name {:?}", m.name));
        }
        if !codes.insert((m.series_code, m.model_code)) {
            errs.push(format!(
                "{}: duplicate (series, model) code ({:#04x}, {:#04x})",
                m.name, m.series_code, m.model_code
            ));
        }
        validate_model(m, &media_by_id, &mut errs);
        referenced.extend(m.media.iter().map(String::as_str));
    }
    for id in media_by_id.keys() {
        if !referenced.contains(id) {
            errs.push(format!("media {id:?} is not used by any model"));
        }
    }
    if variants != enum_variants {
        errs.push(format!(
            "ptouch::Model variants do not match the [[model]] entries (same order required)\n  \
             enum:  {enum_variants:?}\n  table: {variants:?}"
        ));
    }

    if errs.is_empty() { Ok(()) } else { Err(errs) }
}

fn validate_meta(table: &Table, errs: &mut Vec<String>) {
    let meta = &table.meta;
    if meta.status_header.len() != 3 {
        errs.push(format!(
            "meta.status_header must have 3 bytes, has {}",
            meta.status_header.len()
        ));
    }
    for (key, uuid) in [
        ("spp_uuid", &meta.spp_uuid),
        ("ble_service_uuid", &meta.ble_service_uuid),
        ("ble_read_uuid", &meta.ble_read_uuid),
        ("ble_write_uuid", &meta.ble_write_uuid),
        (
            "ble_write_no_response_uuid",
            &meta.ble_write_no_response_uuid,
        ),
        ("ble_notify_uuid", &meta.ble_notify_uuid),
    ] {
        let shape_ok = uuid.len() == 36
            && uuid.char_indices().all(|(i, c)| {
                if matches!(i, 8 | 13 | 18 | 23) {
                    c == '-'
                } else {
                    c.is_ascii_hexdigit()
                }
            });
        if !shape_ok {
            errs.push(format!("meta.{key} = {uuid:?} is not a canonical UUID"));
        }
    }
}

fn validate_media(m: &MediaRow, errs: &mut Vec<String>) {
    let id = &m.id;
    let sum =
        u32::from(m.left_margin_pins) + u32::from(m.print_pins) + u32::from(m.right_margin_pins);
    if sum != u32::from(m.head_pins) {
        errs.push(format!(
            "media {id}: left {} + print {} + right {} = {sum} != head_pins {}",
            m.left_margin_pins, m.print_pins, m.right_margin_pins, m.head_pins
        ));
    }
    if m.print_pins == 0 {
        errs.push(format!("media {id}: print_pins is 0"));
    }
    if let Err(e) = mm_x10(m.width_mm, &format!("media {id}: width_mm")) {
        errs.push(e);
    }
    if m.status_media_type != status_type_for(m.kind) {
        errs.push(format!(
            "media {id}: status_media_type {:#04x} does not match kind {:?}",
            m.status_media_type, m.kind
        ));
    }
    let is_fle = m.kind == TapeKind::Fle;
    for (key, present) in [
        ("length_mm", m.length_mm.is_some()),
        ("physical_length_dots", m.physical_length_dots.is_some()),
        ("printable_length_dots", m.printable_length_dots.is_some()),
    ] {
        if present != is_fle {
            errs.push(format!(
                "media {id}: {key} must be present exactly for FLe media"
            ));
        }
    }
}

fn validate_model(m: &ModelRow, media_by_id: &BTreeMap<&str, &MediaRow>, errs: &mut Vec<String>) {
    let name = &m.name;
    let mut err = |msg: String| errs.push(format!("{name}: {msg}"));

    // `unknown` must only name optional keys that are actually absent.
    let mut seen_unknown = BTreeSet::new();
    for key in &m.unknown {
        if !seen_unknown.insert(key.as_str()) {
            err(format!("unknown lists {key:?} twice"));
        }
        match m.optional_key_present(key) {
            None => err(format!(
                "unknown lists {key:?}, which is not an optional model key"
            )),
            Some(true) => err(format!("unknown lists {key:?} but the key has a value")),
            Some(false) => {}
        }
    }
    let is_unknown = |key: &str| m.unknown.iter().any(|k| k == key);
    for key in REQUIRED_UNLESS_UNKNOWN {
        if m.optional_key_present(key) == Some(false) && !is_unknown(key) {
            err(format!("{key} is absent but not listed in unknown"));
        }
    }
    if (m.bluetooth || m.ble) && m.bt_socket_security.is_none() && !is_unknown("bt_socket_security")
    {
        err("Bluetooth model without bt_socket_security (or unknown entry)".into());
    }
    if m.bluetooth && m.rfcomm_channel_observed.is_none() && !is_unknown("rfcomm_channel_observed")
    {
        err("Bluetooth model without rfcomm_channel_observed (or unknown entry)".into());
    }
    if !m.bluetooth && m.rfcomm_channel_observed.is_some() {
        err("rfcomm_channel_observed on a model without Bluetooth Classic".into());
    }

    // Head geometry.
    if !matches!(m.head_pins, 64 | 128 | 560) {
        err(format!("head_pins {} is not 64, 128 or 560", m.head_pins));
    }
    if u32::from(m.bytes_per_line) * 8 != u32::from(m.head_pins) {
        err(format!(
            "bytes_per_line {} * 8 != head_pins {}",
            m.bytes_per_line, m.head_pins
        ));
    }
    if m.supports_high_resolution != m.high_res_feed_dpi.is_some() {
        err("high_res_feed_dpi must be present exactly when supports_high_resolution".into());
    }
    if let Some(hr) = m.high_res_feed_dpi
        && u32::from(hr) != 2 * u32::from(m.dpi)
    {
        err(format!("high_res_feed_dpi {hr} != 2 x dpi {}", m.dpi));
    }
    if m.supports_special_tape != m.special_tape_k.is_some() {
        err("special_tape_k must be present exactly when supports_special_tape".into());
    }
    if !m.supports_compression && m.default_compression == super::schema::Compression::PackBits {
        err("default_compression = packbits but supports_compression = false".into());
    }

    // Protocol-version gates (PROTOCOL.md §3.3), with the default of 89.
    let v = m.protocol_version.unwrap_or(89);
    let gate_93 = matches!(v, 93 | 94) || v > 104;
    if m.sends_stored_up_print != gate_93 || m.sends_color_info != gate_93 {
        err(format!(
            "sends_stored_up_print / sends_color_info disagree with protocol_version {v} (§3.3)"
        ));
    }
    let wants_i18 = v > 99 || matches!(v, 91 | 92);
    if (m.cancel_command == CancelCommand::EscI18) != wants_i18 {
        err(format!(
            "cancel_command disagrees with protocol_version {v} (§3.3)"
        ));
    }

    // Lengths must be whole tenths of a millimetre.
    for (key, value) in [
        ("min_length_mm", m.min_length_mm),
        ("editor_min_label_mm", m.editor_min_label_mm),
        ("max_length_mm", m.max_length_mm),
    ] {
        if let Some(v) = value
            && let Err(e) = mm_x10(v, key)
        {
            err(e);
        }
    }

    // Media references.
    if m.media.is_empty() {
        err("media list is empty".into());
    }
    let mut seen = BTreeSet::new();
    let mut lookup_keys = BTreeSet::new();
    let mut max_print = 0u16;
    let mut max_width = 0u8;
    for id in &m.media {
        if !seen.insert(id.as_str()) {
            err(format!("media {id:?} listed twice"));
        }
        let Some(media) = media_by_id.get(id.as_str()) else {
            err(format!("references unknown media {id:?}"));
            continue;
        };
        if media.head_pins != m.head_pins {
            err(format!(
                "media {id} has head_pins {} but the model has {}",
                media.head_pins, m.head_pins
            ));
        }
        if !lookup_keys.insert((media.media_width_byte, media.kind)) {
            err(format!(
                "media {id}: (width byte {}, kind {:?}) is not unique for this model",
                media.media_width_byte, media.kind
            ));
        }
        max_print = max_print.max(media.print_pins);
        max_width = max_width.max(media.media_width_byte);
    }
    if max_print != m.max_print_pins {
        err(format!(
            "max_print_pins {} != largest media print_pins {max_print}",
            m.max_print_pins
        ));
    }
    if max_width != m.max_tape_mm {
        err(format!(
            "max_tape_mm {} != largest media width byte {max_width}",
            m.max_tape_mm
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variant_names() {
        assert_eq!(variant_name("PT-P710BT").unwrap(), "PtP710bt");
        assert_eq!(variant_name("PT-P715eBT").unwrap(), "PtP715ebt");
        assert_eq!(variant_name("PT-P300BTz").unwrap(), "PtP300btz");
        assert_eq!(variant_name("PT-E850TKW").unwrap(), "PtE850tkw");
        assert!(variant_name("QL-800").is_err());
        assert!(variant_name("PT-").is_err());
    }

    #[test]
    fn static_names() {
        assert_eq!(static_name("tze128-3.5"), "TZE128_3_5");
        assert_eq!(static_name("fle560-21x45"), "FLE560_21X45");
    }

    #[test]
    fn mm_conversion() {
        assert_eq!(mm_x10(4.4, "x").unwrap(), 44);
        assert_eq!(mm_x10(1000.0, "x").unwrap(), 10000);
        assert_eq!(mm_x10(23.6, "x").unwrap(), 236);
        assert!(mm_x10(4.45, "x").is_err());
        assert!(mm_x10(-1.0, "x").is_err());
    }
}

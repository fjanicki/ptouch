//! WP1: model and media tables (`ptouch::model`).
//!
//! Checks the generated tables against `docs/models.toml` field by field (an independent
//! parse with the `toml` crate, so a hand edit of `generated.rs` is caught even without the
//! `xtask` drift test), the structural invariants, the PROTOCOL.md §5.2 margin rows and the
//! lookup functions.

// Test helpers outside `#[test]` functions are not covered by clippy.toml's
// `allow-*-in-tests`; failing loudly is the point of a test.
#![allow(clippy::unwrap_used, clippy::panic)]

use std::collections::BTreeSet;

use ptouch::model::{
    self, BatteryFormat, CancelCommand, Geometry, PageCommand, all_media, media_by_id,
    media_for_geometry, profile_by_name, profiles_by_usb_pid,
};
use ptouch::{
    Compression, Error, Model, ModelProfile, TapeKind, TapeSpec, profile, profile_by_bt_name,
    profile_by_codes, profile_by_usb_pid, profiles, tape_for_status, tape_spec,
};

fn p710() -> &'static ModelProfile {
    profile(Model::PtP710bt).unwrap()
}

fn margins(t: &TapeSpec) -> (u16, u16, u16) {
    (t.left_margin_pins, t.print_pins, t.right_margin_pins)
}

/// (left, print, right) for a model's media entry with this width byte and kind.
fn lpr(model: Model, width: u8, kind: TapeKind) -> (u16, u16, u16) {
    let p = profile(model).unwrap();
    margins(tape_spec(p, width, kind).unwrap_or_else(|| panic!("{model:?} {width} {kind:?}")))
}

// ---------------------------------------------------------------------------------------------
// Cross-check against docs/models.toml
// ---------------------------------------------------------------------------------------------

fn models_toml() -> toml::Table {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/models.toml");
    std::fs::read_to_string(path).unwrap().parse().unwrap()
}

fn int(t: &toml::Table, key: &str) -> Option<i64> {
    t.get(key).map(|v| v.as_integer().unwrap())
}

fn boolean(t: &toml::Table, key: &str) -> Option<bool> {
    t.get(key).map(|v| v.as_bool().unwrap())
}

fn x10(t: &toml::Table, key: &str) -> Option<i64> {
    // Values are multiples of 0.1 mm; rounding removes binary representation noise.
    t.get(key)
        .map(|v| (v.as_float().unwrap() * 10.0).round() as i64)
}

fn string_list(t: &toml::Table, key: &str) -> Vec<String> {
    t.get(key)
        .map(|v| {
            v.as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn every_toml_model_is_generated_with_identical_values() {
    let doc = models_toml();
    let rows = doc["model"].as_array().unwrap();
    assert_eq!(rows.len(), 27);
    assert_eq!(profiles().len(), rows.len());

    for (row, p) in rows.iter().zip(profiles()) {
        let r = row.as_table().unwrap();
        let name = r["name"].as_str().unwrap();
        assert_eq!(p.name, name);
        let ctx = name;
        assert_eq!(string_list(r, "aliases"), p.aliases, "{ctx} aliases");
        assert_eq!(int(r, "model_code"), Some(i64::from(p.model_code)), "{ctx}");
        assert_eq!(
            int(r, "series_code"),
            Some(i64::from(p.series_code)),
            "{ctx}"
        );
        assert_eq!(int(r, "usb_pid"), p.usb_pid.map(i64::from), "{ctx}");
        assert_eq!(
            boolean(r, "bluetooth"),
            Some(p.transports.bluetooth),
            "{ctx}"
        );
        assert_eq!(boolean(r, "ble"), Some(p.transports.ble), "{ctx}");
        assert_eq!(boolean(r, "network"), Some(p.transports.network), "{ctx}");
        assert_eq!(int(r, "dpi"), Some(i64::from(p.dpi)), "{ctx}");
        assert_eq!(
            int(r, "high_res_feed_dpi"),
            p.high_res_feed_dpi.map(i64::from),
            "{ctx}"
        );
        assert_eq!(int(r, "head_pins"), Some(i64::from(p.head_pins)), "{ctx}");
        assert_eq!(
            int(r, "bytes_per_line"),
            Some(i64::from(p.bytes_per_line)),
            "{ctx}"
        );
        assert_eq!(
            int(r, "max_print_pins"),
            Some(i64::from(p.max_print_pins)),
            "{ctx}"
        );
        assert_eq!(
            int(r, "max_tape_mm"),
            Some(i64::from(p.max_tape_mm)),
            "{ctx}"
        );
        assert_eq!(int(r, "null_bytes"), Some(i64::from(p.null_bytes)), "{ctx}");
        let page = match p.page_command {
            PageCommand::StartEnd => "start_end",
            PageCommand::StartNextEnd => "start_next_end",
        };
        assert_eq!(r["page_command"].as_str(), Some(page), "{ctx}");
        assert_eq!(
            int(r, "protocol_version"),
            p.protocol_version.map(i64::from),
            "{ctx}"
        );
        assert_eq!(
            boolean(r, "needs_mode_switch"),
            Some(p.needs_mode_switch),
            "{ctx}"
        );
        assert_eq!(
            boolean(r, "raster_is_default"),
            p.raster_is_default,
            "{ctx}"
        );
        let comp = match p.default_compression {
            Compression::None => "none",
            Compression::PackBits => "packbits",
        };
        assert_eq!(r["default_compression"].as_str(), Some(comp), "{ctx}");
        let c = &p.caps;
        assert_eq!(
            boolean(r, "supports_compression"),
            Some(c.compression),
            "{ctx}"
        );
        assert_eq!(boolean(r, "supports_auto_cut"), Some(c.auto_cut), "{ctx}");
        assert_eq!(boolean(r, "supports_cut_mark"), Some(c.cut_mark), "{ctx}");
        assert_eq!(boolean(r, "supports_cut_every"), c.cut_every, "{ctx}");
        assert_eq!(boolean(r, "supports_chain"), c.chain, "{ctx}");
        assert_eq!(boolean(r, "supports_half_cut"), Some(c.half_cut), "{ctx}");
        assert_eq!(
            boolean(r, "supports_special_tape"),
            Some(c.special_tape),
            "{ctx}"
        );
        assert_eq!(boolean(r, "supports_mirror"), Some(c.mirror), "{ctx}");
        assert_eq!(boolean(r, "supports_two_color"), Some(c.two_color), "{ctx}");
        assert_eq!(
            boolean(r, "supports_high_resolution"),
            Some(c.high_resolution),
            "{ctx}"
        );
        assert_eq!(boolean(r, "supports_draft"), Some(c.draft), "{ctx}");
        assert_eq!(
            boolean(r, "supports_status_notify"),
            Some(c.status_notify),
            "{ctx}"
        );
        assert_eq!(
            int(r, "special_tape_k"),
            p.special_tape_k.map(i64::from),
            "{ctx}"
        );
        let s = &p.sends;
        assert_eq!(
            boolean(r, "sends_stored_up_print"),
            Some(s.stored_up_print),
            "{ctx}"
        );
        assert_eq!(boolean(r, "sends_color_info"), Some(s.color_info), "{ctx}");
        assert_eq!(
            boolean(r, "sends_copies_command"),
            Some(s.copies_command),
            "{ctx}"
        );
        assert_eq!(
            boolean(r, "sends_mode_reset_at_end"),
            Some(s.mode_reset_at_end),
            "{ctx}"
        );
        let cancel = match p.cancel_command {
            CancelCommand::EscAt => "esc_at",
            CancelCommand::EscI18 => "esc_i_18",
        };
        assert_eq!(r["cancel_command"].as_str(), Some(cancel), "{ctx}");
        let sec = p.bt_socket_security.map(|s| match s {
            model::BtSocketSecurity::Insecure => "insecure",
            model::BtSocketSecurity::Secure => "secure",
        });
        assert_eq!(
            r.get("bt_socket_security").and_then(|v| v.as_str()),
            sec,
            "{ctx}"
        );
        assert_eq!(
            int(r, "rfcomm_channel_observed"),
            p.rfcomm_channel_observed.map(i64::from),
            "{ctx}"
        );
        assert_eq!(
            int(r, "min_feed_dots"),
            Some(i64::from(p.min_feed_dots)),
            "{ctx}"
        );
        assert_eq!(
            x10(r, "min_length_mm"),
            p.min_length_mm_x10.map(i64::from),
            "{ctx}"
        );
        assert_eq!(
            x10(r, "editor_min_label_mm"),
            p.editor_min_label_mm_x10.map(i64::from),
            "{ctx}"
        );
        assert_eq!(
            x10(r, "max_length_mm"),
            p.max_length_mm_x10.map(i64::from),
            "{ctx}"
        );
        let battery = p.battery_format.map(|b| match b {
            BatteryFormat::Reserved => "reserved",
            BatteryFormat::Legacy => "legacy",
            BatteryFormat::LevelAc => "level_ac",
            BatteryFormat::None => "none",
        });
        assert_eq!(
            r.get("battery_format").and_then(|v| v.as_str()),
            battery,
            "{ctx}"
        );
        let media_ids: Vec<&str> = p.media.iter().map(|t| t.id).collect();
        assert_eq!(string_list(r, "media"), media_ids, "{ctx} media");
        assert_eq!(string_list(r, "quirks"), p.quirks, "{ctx} quirks");
        assert_eq!(string_list(r, "unknown"), p.unknown, "{ctx} unknown");
    }
}

#[test]
fn every_toml_media_is_generated_with_identical_values() {
    let doc = models_toml();
    let rows = doc["media"].as_array().unwrap();
    assert_eq!(rows.len(), 44);
    assert_eq!(all_media().len(), rows.len());
    for (row, t) in rows.iter().zip(all_media()) {
        let r = row.as_table().unwrap();
        let id = r["id"].as_str().unwrap();
        assert_eq!(t.id, id);
        let geometry = match t.geometry {
            Geometry::Pt128 => "pt128",
            Geometry::Pt3 => "pt3",
            Geometry::Aura64 => "aura64",
            Geometry::Pt560 => "pt560",
        };
        assert_eq!(r["geometry"].as_str(), Some(geometry), "{id}");
        let kind = match t.kind {
            TapeKind::Tze => "tze",
            TapeKind::Hs2 => "hs2",
            TapeKind::Hs3 => "hs3",
            TapeKind::Sl => "sl",
            TapeKind::Fle => "fle",
        };
        assert_eq!(r["kind"].as_str(), Some(kind), "{id}");
        assert_eq!(int(r, "head_pins"), Some(i64::from(t.head_pins)), "{id}");
        assert_eq!(x10(r, "width_mm"), Some(i64::from(t.width_mm_x10)), "{id}");
        assert_eq!(
            int(r, "media_width_byte"),
            Some(i64::from(t.media_width_byte)),
            "{id}"
        );
        assert_eq!(int(r, "length_mm"), t.length_mm.map(i64::from), "{id}");
        assert_eq!(
            int(r, "status_media_type"),
            Some(i64::from(t.status_media_type)),
            "{id}"
        );
        assert_eq!(
            int(r, "print_info_media_type"),
            Some(i64::from(t.print_info_media_type)),
            "{id}"
        );
        assert_eq!(
            int(r, "print_info_media_type_high_res"),
            t.print_info_media_type_high_res.map(i64::from),
            "{id}"
        );
        assert_eq!(
            int(r, "left_margin_pins"),
            Some(i64::from(t.left_margin_pins)),
            "{id}"
        );
        assert_eq!(int(r, "print_pins"), Some(i64::from(t.print_pins)), "{id}");
        assert_eq!(
            int(r, "right_margin_pins"),
            Some(i64::from(t.right_margin_pins)),
            "{id}"
        );
        assert_eq!(
            int(r, "tape_width_dots"),
            Some(i64::from(t.tape_width_dots)),
            "{id}"
        );
        assert_eq!(
            int(r, "default_feed_dots"),
            Some(i64::from(t.default_feed_dots)),
            "{id}"
        );
        assert_eq!(
            int(r, "physical_length_dots"),
            t.physical_length_dots.map(i64::from),
            "{id}"
        );
        assert_eq!(
            int(r, "printable_length_dots"),
            t.printable_length_dots.map(i64::from),
            "{id}"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------------------------

#[test]
fn every_media_margins_sum_to_head_pins() {
    for t in all_media() {
        assert_eq!(
            t.left_margin_pins + t.print_pins + t.right_margin_pins,
            t.head_pins,
            "{}",
            t.id
        );
        assert_eq!(t.print_area().len(), usize::from(t.print_pins), "{}", t.id);
    }
}

#[test]
fn every_profile_is_consistent() {
    let mut codes = BTreeSet::new();
    let mut names = BTreeSet::new();
    for p in profiles() {
        assert_eq!(
            u32::from(p.bytes_per_line) * 8,
            u32::from(p.head_pins),
            "{}",
            p.name
        );
        assert!(!p.media.is_empty(), "{}", p.name);
        assert!(
            codes.insert((p.series_code, p.model_code)),
            "{} code clash",
            p.name
        );
        assert!(names.insert(p.name), "{}", p.name);
        assert_eq!(profile(p.model).map(|q| q.name), Some(p.name));
        for t in p.media {
            assert_eq!(t.head_pins, p.head_pins, "{} / {}", p.name, t.id);
            // Every listed media resolves through the lookup that the session uses.
            assert_eq!(
                tape_spec(p, t.media_width_byte, t.kind),
                Some(*t),
                "{}",
                t.id
            );
        }
        let max_print = p.media.iter().map(|t| t.print_pins).max();
        assert_eq!(max_print, Some(p.max_print_pins), "{}", p.name);
        assert!(p.min_lines(p.min_feed_dots, false) >= 1);
        assert!(p.null_bytes >= 100, "{}", p.name);
    }
}

#[test]
fn usb_pids_are_unique_except_the_documented_p900_e850tkw_collision() {
    let mut seen = BTreeSet::new();
    let mut dupes = Vec::new();
    for pid in profiles().iter().filter_map(|p| p.usb_pid) {
        if !seen.insert(pid) {
            dupes.push(pid);
        }
    }
    assert_eq!(dupes, [0x2083]);
    let names: Vec<&str> = profiles_by_usb_pid(0x2083).map(|p| p.name).collect();
    assert_eq!(names, ["PT-P900", "PT-E850TKW"]);
    assert_eq!(
        profile_by_usb_pid(0x2083).map(|p| p.model),
        Some(Model::PtP900)
    );
}

#[test]
fn meta_constants_match_the_table() {
    assert_eq!(model::USB_VENDOR_ID, 0x04F9);
    assert_eq!(model::USB_OUT_ENDPOINT, 0x02);
    assert_eq!(model::USB_IN_ENDPOINT, 0x81);
    assert_eq!(model::SPP_UUID, "00001101-0000-1000-8000-00805f9b34fb");
    assert_eq!(
        model::BLE_SERVICE_UUID,
        "a76eb9e0-f3ac-4990-84cf-3a94d2426b2b"
    );
    assert_eq!(
        model::BLE_NOTIFY_UUID,
        "a76eb9e4-f3ac-4990-84cf-3a94d2426b2b"
    );
    assert_eq!(model::SNMP_STATUS_OID, "1.3.6.1.4.1.2435.3.3.9.1.6.1.0");
}

// ---------------------------------------------------------------------------------------------
// PT-P710BT (primary model)
// ---------------------------------------------------------------------------------------------

#[test]
fn p710bt_profile() {
    let p = p710();
    assert_eq!(p.name, "PT-P710BT");
    assert_eq!((p.series_code, p.model_code), (0x30, 0x76));
    assert_eq!(p.usb_pid, Some(0x20AF));
    assert_eq!(p.head_pins, 128);
    assert_eq!(p.bytes_per_line, 16);
    assert_eq!(p.dpi, 180);
    assert_eq!(p.null_bytes, 100);
    assert_eq!(p.page_command, PageCommand::StartEnd);
    assert_eq!(p.special_tape_k, Some(0x18));
    assert_eq!(p.caps.cut_every, Some(false));
    assert!(!p.caps.half_cut);
    assert_eq!(p.default_compression, Compression::PackBits);
    assert_eq!(p.cancel_command, CancelCommand::EscAt);
    assert_eq!(p.protocol(), 89);
    assert_eq!(p.battery_format, Some(BatteryFormat::Reserved));
    assert_eq!(p.rfcomm_channel_observed, Some(1));
    assert!(p.transports.bluetooth && !p.transports.ble);
    assert!(p.has_usb());
    assert_eq!(p.feed_dpi(true), Some(360));
}

#[test]
fn p710bt_lookups() {
    assert_eq!(
        profile_by_codes(0x30, 0x76).map(|p| p.model),
        Some(Model::PtP710bt)
    );
    assert_eq!(
        profile_by_usb_pid(0x20AF).map(|p| p.model),
        Some(Model::PtP710bt)
    );
    assert_eq!(
        profile_by_name("pt-p710bt").map(|p| p.model),
        Some(Model::PtP710bt)
    );
    assert_eq!(
        profile_by_name("Cube Plus").map(|p| p.model),
        Some(Model::PtP710bt)
    );
    assert_eq!(
        profile_by_name(" PT-P710BT ").map(|p| p.model),
        Some(Model::PtP710bt)
    );
    assert!(profile_by_codes(0x30, 0x00).is_none());
    assert!(profile_by_usb_pid(0x0000).is_none());
    assert!(profile_by_name("PT-P710").is_none());
}

#[test]
fn p710bt_print_pins_per_width() {
    let p = p710();
    let pins: Vec<(u8, u16)> = [4u8, 6, 9, 12, 18, 24]
        .into_iter()
        .map(|w| (w, tape_spec(p, w, TapeKind::Tze).unwrap().print_pins))
        .collect();
    assert_eq!(
        pins,
        [(4, 24), (6, 32), (9, 50), (12, 70), (18, 112), (24, 128)]
    );
    // No HS 3:1, no SL, nothing wider than 24 mm.
    assert!(tape_spec(p, 9, TapeKind::Hs3).is_none());
    assert!(tape_spec(p, 24, TapeKind::Sl).is_none());
    assert!(tape_spec(p, 36, TapeKind::Tze).is_none());
}

// ---------------------------------------------------------------------------------------------
// PROTOCOL.md §5.2 margin rows
// ---------------------------------------------------------------------------------------------

#[test]
fn margins_128_pin_tze_rows() {
    let rows = [
        (4, (52, 24, 52)),
        (6, (48, 32, 48)),
        (9, (39, 50, 39)),
        (12, (29, 70, 29)),
        (18, (8, 112, 8)),
        (24, (0, 128, 0)),
    ];
    for (w, expected) in rows {
        assert_eq!(lpr(Model::PtP710bt, w, TapeKind::Tze), expected, "{w} mm");
        // Every 128-pin standard-geometry model shares the table.
        for p in profiles().iter().filter(|p| p.head_pins == 128) {
            if let Some(t) = tape_spec(p, w, TapeKind::Tze)
                && t.geometry == Geometry::Pt128
            {
                assert_eq!(margins(t), expected, "{} {w} mm", p.name);
            }
        }
    }
}

#[test]
fn margins_128_pin_heat_shrink_rows() {
    let hs2 = [
        (6, (50, 28, 50)),
        (9, (40, 48, 40)),
        (12, (31, 66, 31)),
        (18, (11, 106, 11)),
        (24, (0, 128, 0)),
    ];
    for (w, expected) in hs2 {
        assert_eq!(lpr(Model::PtP710bt, w, TapeKind::Hs2), expected, "HS2 {w}");
    }
    let hs3 = [
        (5, (54, 20, 54)),
        (9, (42, 44, 42)),
        (11, (39, 50, 39)),
        (21, (4, 120, 4)),
    ];
    for (w, expected) in hs3 {
        assert_eq!(lpr(Model::PtE560bt, w, TapeKind::Hs3), expected, "HS3 {w}");
    }
    assert_eq!(lpr(Model::PtE560bt, 24, TapeKind::Sl), (0, 128, 0));
}

#[test]
fn margins_p300bt_and_n25bt_rows() {
    for (w, expected) in [
        (4, (55, 18, 55)),
        (6, (48, 32, 48)),
        (9, (39, 50, 39)),
        (12, (32, 64, 32)),
    ] {
        assert_eq!(
            lpr(Model::PtP300bt, w, TapeKind::Tze),
            expected,
            "P300BT {w}"
        );
    }
    for (w, expected) in [
        (4, (20, 24, 20)),
        (6, (16, 32, 16)),
        (9, (7, 50, 7)),
        (12, (0, 64, 0)),
    ] {
        assert_eq!(lpr(Model::PtN25bt, w, TapeKind::Tze), expected, "N25BT {w}");
    }
}

#[test]
fn margins_560_pin_rows() {
    let tze = [
        (4, (248, 48, 264)),
        (6, (240, 64, 256)),
        (9, (219, 106, 235)),
        (12, (197, 150, 213)),
        (18, (155, 234, 171)),
        (24, (112, 320, 128)),
        (36, (45, 454, 61)),
    ];
    for (w, expected) in tze {
        assert_eq!(
            lpr(Model::PtP910bt, w, TapeKind::Tze),
            expected,
            "P910BT {w}"
        );
        assert_eq!(lpr(Model::PtP900, w, TapeKind::Tze), expected, "P900 {w}");
    }
    // Asymmetric: right = left + 16 for TZe/HS, left + 14 for FLe; centre pin 272.
    for t in all_media().iter().filter(|t| t.geometry == Geometry::Pt560) {
        let extra = if t.kind == TapeKind::Fle { 14 } else { 16 };
        assert_eq!(t.right_margin_pins, t.left_margin_pins + extra, "{}", t.id);
    }
    assert_eq!(lpr(Model::PtP900, 24, TapeKind::Hs2), (144, 256, 160));
    assert_eq!(lpr(Model::PtP900, 31, TapeKind::Hs3), (92, 360, 108));
    assert_eq!(lpr(Model::PtP900, 21, TapeKind::Fle), (146, 254, 160));
    // P910BT: TZe only.
    assert!(tape_spec(profile(Model::PtP910bt).unwrap(), 24, TapeKind::Hs2).is_none());
}

#[test]
fn spot_checks_from_protocol_5_2() {
    assert_eq!(lpr(Model::PtP300bt, 12, TapeKind::Tze), (32, 64, 32));
    assert_eq!(lpr(Model::PtP910bt, 24, TapeKind::Tze), (112, 320, 128));
    assert_eq!(lpr(Model::PtN25bt, 12, TapeKind::Tze), (0, 64, 0));
}

#[test]
fn media_global_lookups() {
    assert_eq!(media_by_id("tze128-24").map(|t| t.print_pins), Some(128));
    assert!(media_by_id("tze128-25").is_none());
    let t = media_for_geometry(Geometry::Pt560, TapeKind::Tze, 24).unwrap();
    assert_eq!(t.id, "tze560-24");
    assert_eq!(t.print_area(), 112..432);
    assert!(t.is_printable_pin(112) && t.is_printable_pin(431));
    assert!(!t.is_printable_pin(111) && !t.is_printable_pin(432));
    assert!(media_for_geometry(Geometry::Pt3, TapeKind::Tze, 24).is_none());
}

// ---------------------------------------------------------------------------------------------
// Bluetooth device names (PROTOCOL.md §2.1)
// ---------------------------------------------------------------------------------------------

#[test]
fn bt_names() {
    let m = |n: &str| profile_by_bt_name(n).map(|p| p.model);
    assert_eq!(m("PT-P710BTxxxx"), Some(Model::PtP710bt));
    assert_eq!(m("PT-E560BT_xxxx"), Some(Model::PtE560bt));
    assert_eq!(m("PT-P710BT"), Some(Model::PtP710bt));
    assert_eq!(m("pt-p710btxxxx"), Some(Model::PtP710bt));
    assert_eq!(m("PT-P300BTzxxxx"), Some(Model::PtP300btz));
    assert_eq!(m("PT-P300BTxxxx"), Some(Model::PtP300bt));
    assert_eq!(m("PT-P715eBTxxxx"), Some(Model::PtP715ebt));
    assert_eq!(m("PT-D610BT_xxxx"), Some(Model::PtD610bt));
    assert_eq!(m("Foo"), None);
    assert_eq!(m(""), None);
    assert_eq!(m("xxx"), None);
    // Suffix of non-ASCII characters is dropped by character, not byte.
    assert_eq!(m("PT-P710BTäöüß"), Some(Model::PtP710bt));
    // Aliases are not Bluetooth names.
    assert_eq!(m("Cube Plus"), None);
}

// ---------------------------------------------------------------------------------------------
// Status media resolution (PROTOCOL.md §4.6.1)
// ---------------------------------------------------------------------------------------------

#[test]
fn kind_from_status_media_type() {
    use TapeKind::*;
    let k = TapeKind::from_status_media_type;
    assert_eq!(k(0x00), None);
    assert_eq!(k(0xFF), None);
    assert_eq!(k(0x12), None);
    assert_eq!(k(0x11), Some(Hs2));
    assert_eq!(k(0x13), Some(Fle));
    assert_eq!(k(0x16), Some(Sl));
    assert_eq!(k(0x17), Some(Hs3));
    for t in [0x01, 0x03, 0x04, 0x14, 0x15, 0x42] {
        assert_eq!(k(t), Some(Tze), "{t:#04x}");
    }
    assert!(Hs2.is_heat_shrink() && Hs3.is_heat_shrink() && !Tze.is_heat_shrink());
}

#[test]
fn tape_for_status_fixture_and_vectors() {
    let p = p710();
    // Real status fixture: st[10] = 0x18, st[11] = 0x01.
    assert_eq!(tape_for_status(p, 24, 0x01).unwrap().id, "tze128-24");
    assert_eq!(tape_for_status(p, 0, 0x00), Err(Error::NoMedia));
    assert_eq!(tape_for_status(p, 24, 0xFF), Err(Error::NoMedia));
    assert_eq!(tape_for_status(p, 24, 0x11).unwrap().id, "hs2-128-23.6");
    assert_eq!(tape_for_status(p, 24, 0x14).unwrap().id, "tze128-24");
    assert_eq!(tape_for_status(p, 12, 0x03).unwrap().id, "tze128-12");
    // SL on a model without an SL entry falls back to TZe geometry.
    assert_eq!(tape_for_status(p, 24, 0x16).unwrap().id, "tze128-24");
    // SL on a model with one uses it.
    let e560 = profile(Model::PtE560bt).unwrap();
    assert_eq!(tape_for_status(e560, 24, 0x16).unwrap().id, "sl128-24");
    // FLe on the P900.
    let p900 = profile(Model::PtP900).unwrap();
    assert_eq!(tape_for_status(p900, 21, 0x13).unwrap().id, "fle560-21x45");
    // Unsupported combinations.
    let unsupported = |w, t| {
        Err(Error::UnsupportedMedia {
            width_mm: w,
            media_type: t,
        })
    };
    assert_eq!(tape_for_status(p, 36, 0x01), unsupported(36, 0x01));
    assert_eq!(tape_for_status(p, 9, 0x17), unsupported(9, 0x17));
    assert_eq!(tape_for_status(p, 21, 0x13), unsupported(21, 0x13));
    assert_eq!(tape_for_status(p, 24, 0x12), unsupported(24, 0x12));
    assert_eq!(tape_for_status(p, 0, 0x01), unsupported(0, 0x01));
}

#[test]
fn tape_for_status_from_the_real_status_fixture() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/status/p710bt_24mm_laminated_idle.hex"
    );
    let text = std::fs::read_to_string(path).unwrap();
    let bytes: Vec<u8> = text
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .flat_map(str::split_whitespace)
        .map(|h| u8::from_str_radix(h, 16).unwrap())
        .collect();
    assert_eq!(bytes.len(), 32);
    let p = profile_by_codes(bytes[3], bytes[4]).unwrap();
    assert_eq!(p.model, Model::PtP710bt);
    assert_eq!(
        tape_for_status(p, bytes[10], bytes[11]).unwrap().id,
        "tze128-24"
    );
}

// ---------------------------------------------------------------------------------------------
// Page length (PROTOCOL.md §5.6)
// ---------------------------------------------------------------------------------------------

#[test]
fn min_and_max_lines_vectors() {
    let p710 = p710();
    let e560 = profile(Model::PtE560bt).unwrap();
    let p910 = profile(Model::PtP910bt).unwrap();
    assert_eq!(p710.min_lines(14, false), 3);
    assert_eq!(p710.min_lines(0, false), 31);
    assert_eq!(e560.min_lines(14, false), 6);
    assert_eq!(e560.min_lines(0, false), 34);
    assert_eq!(p910.min_lines(14, false), 29);
    assert_eq!(p910.min_lines(0, false), 57);
    assert_eq!(p710.max_lines(false), Some(7086));
    // A huge margin never underflows: at least one line.
    assert_eq!(p710.min_lines(u16::MAX, false), 1);
    assert_eq!(p710.min_lines(16, false), 1);
}

#[test]
fn min_and_max_lines_high_res_and_fallbacks() {
    let p710 = p710();
    // 4.4 mm at 360 dpi = 62.36 → 62 lines; margin doubled to 28 dots.
    assert_eq!(p710.min_lines(0, true), 62);
    assert_eq!(p710.min_lines(28, true), 6);
    // D1 §2.3.4 (PT-P710BT): 180×360 maximum 14172 = 2 × 7086 (regression: was 14173).
    assert_eq!(p710.max_lines(true), Some(14172));
    assert_eq!(p710.feed_factor(true), 2);
    assert_eq!(p710.feed_factor(false), 1);
    // E560BT: D4 lists 7087 / 14173 (rounded); the library keeps the truncated 7086 and its
    // double, one dot stricter.
    let e560 = profile(Model::PtE560bt).unwrap();
    assert_eq!(e560.max_lines(false), Some(7086));
    assert_eq!(e560.max_lines(true), Some(14172));
    assert_eq!(e560.min_lines(0, true), 68);
    // P910BT (360 dpi, 1000 mm): 14173.
    assert_eq!(
        profile(Model::PtP910bt).unwrap().max_lines(false),
        Some(14173)
    );
    // Unknown min_length_mm → 4.8 mm fallback (P300BT, N25BT, E720BT).
    for m in [Model::PtP300bt, Model::PtN25bt, Model::PtE720bt] {
        let p = profile(m).unwrap();
        assert_eq!(p.min_length_mm_x10, None);
        assert_eq!(p.min_lines(0, false), 34, "{}", p.name);
        assert_eq!(p.min_lines(14, false), 6, "{}", p.name);
    }
    // P300BT max 500 mm → 3543 lines (§5.6 "max printable length 0.499 m").
    assert_eq!(
        profile(Model::PtP300bt).unwrap().max_lines(false),
        Some(3543)
    );
    // Unknown max_length_mm → None.
    assert_eq!(profile(Model::PtP300btz).unwrap().max_lines(false), None);
    // High-res requested on a model without it: normal resolution.
    let p910 = profile(Model::PtP910bt).unwrap();
    assert_eq!(p910.feed_dpi(true), None);
    assert_eq!(p910.min_lines(14, true), p910.min_lines(14, false));
}

#[test]
fn protocol_defaults_and_gates() {
    // P900's protocol_version is unknown → default 89 → ESC @ cancel.
    let p900 = profile(Model::PtP900).unwrap();
    assert_eq!(p900.protocol_version, None);
    assert_eq!(p900.protocol(), 89);
    assert_eq!(p900.cancel_command, CancelCommand::EscAt);
    let n25 = profile(Model::PtN25bt).unwrap();
    assert_eq!(n25.protocol(), 105);
    assert_eq!(n25.cancel_command, CancelCommand::EscI18);
    assert_eq!((n25.series_code, n25.model_code), (0x41, 0x30));
    assert!(n25.transports.ble && !n25.transports.bluetooth);
    assert_eq!(n25.head_pins, 64);
    assert_eq!(n25.default_compression, Compression::None);
}

#[test]
fn heat_shrink_and_margin_limits() {
    // PROTOCOL.md §5.6: heat-shrink tube is capped at 500 mm = 3543 dots at 180 dpi.
    let p710 = p710();
    let hs = ptouch::media_by_id("hs2-128-23.6").unwrap();
    let tze = ptouch::media_by_id("tze128-24").unwrap();
    assert_eq!(p710.max_lines_for(hs, false), Some(3543));
    assert_eq!(p710.max_lines_for(tze, false), Some(7086));
    assert_eq!(p710.max_lines_for(tze, true), Some(14172));
    // PROTOCOL.md §3.2.4: ESC i d maximum 900 (180×180) / 1800 (180×360).
    assert_eq!(p710.max_margin_dots(false), 900);
    assert_eq!(p710.max_margin_dots(true), 1800);
    let p910 = profile(Model::PtP910bt).unwrap();
    assert_eq!(p910.max_margin_dots(false), 1800);
}

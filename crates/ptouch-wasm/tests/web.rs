//! Browser tests (ARCHITECTURE.md §8.3), headless Chrome:
//! `wasm-pack test --headless --chrome --chromedriver <path> crates/ptouch-wasm`
//! (ChromeDriver must match the installed Chrome: `npx @puppeteer/browsers install
//! chromedriver@<version>`).
//!
//! Covers what native tests cannot: thrown error objects (`code`, `isPtouchError`), the tsify
//! shapes as JS sees them (including the hand-written wire forms of tagged unions), the
//! `Raster` → `Bitmap1` → `encodeJob` path against the core golden, and a full job through
//! `PrintSession` driven by `VirtualPrinter`.
#![cfg(target_arch = "wasm32")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

use js_sys::{JSON, Reflect};
use ptouch_wasm::dto::{CodeSpec, PrinterStatus, SessionEvent, SessionState};
use ptouch_wasm::{
    Bitmap1, PrintSession, Raster, StatusFramer, VirtualPrinter, encode_code, encode_job,
    is_ptouch_error, list_models, media_for_width, parse_status, print_area, settings_for,
};
use tsify::Ts;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

wasm_bindgen_test_configure!(run_in_browser);

/// The real PT-P710BT reply (24 mm laminated white tape, black text; 2026-10-08).
const FIXTURE: [u8; 32] = [
    0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

fn get(v: &JsValue, path: &str) -> JsValue {
    path.split('.').fold(v.clone(), |o, k| {
        Reflect::get(&o, &JsValue::from_str(k)).unwrap()
    })
}

fn code_of(err: &JsValue) -> String {
    assert!(is_ptouch_error(err), "not a PtouchError: {err:?}");
    get(err, "code").as_string().unwrap()
}

fn js<T: tsify::Tsify>(json: &str) -> Ts<T> {
    Ts::new_unchecked(JSON::parse(json).unwrap())
}

#[wasm_bindgen_test]
fn version_matches_core() {
    assert_eq!(ptouch_wasm::version(), ptouch::VERSION);
}

#[wasm_bindgen_test]
fn errors_are_real_errors_with_codes() {
    let mut r = Raster::new(10, 8).expect("raster");
    let err = r.blit_crisp(&[0; 4], 1, 1, 0, 128).unwrap_err();
    assert_eq!(code_of(&err), "INVALID_INPUT");
    assert!(err.is_instance_of::<js_sys::Error>());
    assert_eq!(
        get(&err, "name").as_string().as_deref(),
        Some("PtouchError")
    );

    assert_eq!(
        code_of(&parse_status(&[0; 5]).unwrap_err()),
        "STATUS_LENGTH"
    );
    assert_eq!(
        code_of(&print_area("PT-NOPE", "tze128-24").unwrap_err()),
        "UNKNOWN_MODEL"
    );
    assert_eq!(
        code_of(&print_area("PT-P710BT", "tze560-24").unwrap_err()),
        "UNSUPPORTED_MEDIA"
    );
    assert!(!is_ptouch_error(&js_sys::Error::new("plain").into()));
    assert!(!is_ptouch_error(&JsValue::from_str("PtouchError")));
}

#[wasm_bindgen_test]
fn status_framer_resyncs_and_reassembles() {
    let mut f = StatusFramer::new();
    f.push(&[0xAA, 0xBB]);
    f.push(&FIXTURE[..7]);
    assert!(f.next_frame().unwrap().is_none());
    f.push(&FIXTURE[7..]);
    let s: JsValue = f.next_frame().unwrap().unwrap().into();
    assert_eq!(get(&s, "mediaWidthMm").as_f64(), Some(24.0));
    assert_eq!(f.discarded_bytes(), 2);
    // A truncated frame followed by a full one yields the full one only.
    f.push(&FIXTURE[..10]);
    f.push(&FIXTURE);
    let s: JsValue = f.next_frame().unwrap().unwrap().into();
    assert_eq!(
        get(&s, "modelName").as_string().as_deref(),
        Some("PT-P710BT")
    );
    assert!(f.next_frame().unwrap().is_none());
    assert_eq!(f.pending_bytes(), 0);
}

#[wasm_bindgen_test]
fn status_fixture_shape() {
    let s: JsValue = parse_status(&FIXTURE).unwrap().into();
    assert_eq!(
        get(&s, "modelName").as_string().as_deref(),
        Some("PT-P710BT")
    );
    assert_eq!(get(&s, "mediaId").as_string().as_deref(), Some("tze128-24"));
    assert_eq!(get(&s, "mediaWidthMm").as_f64(), Some(24.0));
    assert_eq!(
        get(&s, "mediaType").as_string().as_deref(),
        Some("laminated")
    );
    assert_eq!(
        get(&s, "tapeColor.name").as_string().as_deref(),
        Some("white")
    );
    assert_eq!(
        get(&s, "textColor.name").as_string().as_deref(),
        Some("black")
    );
    assert_eq!(get(&s, "ready").as_bool(), Some(true));
    assert_eq!(get(&s, "statusType").as_string().as_deref(), Some("reply"));
    assert_eq!(
        get(&s, "phase.kind").as_string().as_deref(),
        Some("receiving")
    );
    assert_eq!(get(&s, "notification").as_string().as_deref(), Some("none"));
    assert!(js_sys::Array::is_array(&get(&s, "errors")));
    // Optional fields are absent, not null.
    assert!(!Reflect::has(&get(&s, "battery"), &"percent".into()).unwrap());
    // Round trip through the generated type.
    let back: PrinterStatus = Ts::<PrinterStatus>::new_unchecked(s).to_rust().unwrap();
    assert_eq!(back.raw, FIXTURE.to_vec());
}

#[wasm_bindgen_test]
fn model_and_media_shapes() {
    let models = list_models().unwrap();
    let first: JsValue = models[0].clone().into();
    assert_eq!(
        get(&first, "name").as_string().as_deref(),
        Some("PT-P710BT")
    );
    assert_eq!(get(&first, "caps.autoCut").as_bool(), Some(true));
    let m: JsValue = media_for_width("PT-P710BT", 3.5, None).unwrap().into();
    assert_eq!(get(&m, "widthByte").as_f64(), Some(4.0));
    assert_eq!(get(&m, "widthMm").as_f64(), Some(3.5));
    let a: JsValue = print_area("PT-P710BT", "tze128-24").unwrap().into();
    assert_eq!(get(&a, "minLengthDots").as_f64(), Some(3.0));
    assert_eq!(get(&a, "maxLengthDots").as_f64(), Some(7086.0));
}

#[wasm_bindgen_test]
fn encode_code_from_js_objects() {
    let qr: JsValue = encode_code(js::<CodeSpec>(r#"{"symbology":"qr","data":"HELLO"}"#))
        .unwrap()
        .into();
    assert_eq!(get(&qr, "width").as_f64(), Some(21.0));
    assert_eq!(get(&qr, "height").as_f64(), Some(21.0));
    let ean: JsValue = encode_code(js::<CodeSpec>(
        r#"{"symbology":"ean13","data":"400638133393"}"#,
    ))
    .unwrap()
    .into();
    assert_eq!(get(&ean, "width").as_f64(), Some(95.0));
    assert_eq!(get(&ean, "height").as_f64(), Some(1.0));
    let c128: JsValue = encode_code(js::<CodeSpec>(r#"{"symbology":"code128","data":"1234"}"#))
        .unwrap()
        .into();
    assert_eq!(get(&c128, "width").as_f64(), Some(57.0));
    let dm: JsValue = encode_code(js::<CodeSpec>(r#"{"symbology":"datamatrix","data":"A1"}"#))
        .unwrap()
        .into();
    assert_eq!(get(&dm, "width").as_f64(), Some(10.0));
    assert_eq!(get(&dm, "height").as_f64(), Some(10.0));
    for bad in [
        r#"{"symbology":"pdf417","data":"x"}"#,
        r#"{"data":"x"}"#,
        r#"{"symbology":"qr"}"#,
        r#"{"symbology":"qr","data":"x","ecc":"Z"}"#,
        r#"{"symbology":"ean13","data":"4006381333932"}"#,
        r#"{"symbology":"datamatrix","data":""}"#,
    ] {
        let err = encode_code(js::<CodeSpec>(bad)).unwrap_err();
        assert_eq!(code_of(&err), "INVALID_INPUT", "{bad}");
    }
}

/// The same label built through the wasm API and through the core directly.
fn label_rgba(length: u32, height: u16) -> Vec<u8> {
    // 1× crisp plane: a black bar on the left and a dot pattern.
    let mut rgba = vec![255u8; length as usize * usize::from(height) * 4];
    for y in 0..usize::from(height) {
        for x in 0..length as usize {
            if x < 8 || (x % 7 == 0 && y % 5 == 0) {
                let i = (y * length as usize + x) * 4;
                rgba[i..i + 3].fill(0);
            }
        }
    }
    rgba
}

#[wasm_bindgen_test]
fn raster_to_job_equals_core_golden() {
    let tape = ptouch::media_by_id("tze128-24").unwrap();
    let p710 = ptouch::profile_by_name("PT-P710BT").unwrap();
    let (len, h) = (120u32, tape.print_pins);
    let rgba = label_rgba(len, h);
    let qr = ptouch_wasm::codes::encode(&CodeSpec::Qr {
        data: "HELLO".into(),
        ecc: None,
    })
    .unwrap();

    // wasm API
    let mut r = Raster::new(len, h).unwrap();
    r.blit_crisp(&rgba, len, u32::from(h), 1, 128).unwrap();
    r.blit_code(Ts::from_rust(&qr).unwrap(), 60, 10, 3, true)
        .unwrap();
    let page = r.finish();
    let packed = page.to_packed();
    let job = encode_job(
        "PT-P710BT",
        "tze128-24",
        vec![page.clone_handle(), page],
        Some(js(r#"{"cut":"every-label","chain":false}"#)),
    )
    .unwrap();

    // core
    let mut cr = ptouch::LabelRaster::new(len, h);
    cr.blit_crisp(&rgba, len, u32::from(h), 1, 128).unwrap();
    let m = ptouch::ModuleMatrix {
        width: qr.width,
        height: qr.height,
        modules: qr.modules.clone(),
    };
    cr.blit_code(&m, 60, 10, 3, true).unwrap();
    let cpage = cr.finish();
    assert_eq!(packed, cpage.as_packed());
    let golden = ptouch::encode_job(
        p710,
        tape,
        &[&cpage, &cpage],
        &ptouch::JobOptions::default(),
    )
    .unwrap();
    assert_eq!(job.to_bytes(), golden.to_bytes());
    assert_eq!(job.page_count(), 2);
    assert_eq!(job.byte_length() as usize, golden.to_bytes().len());
    assert_eq!(job.to_bytes().last(), Some(&0x1A));

    // decodeJob gives the page back in label orientation.
    let d = ptouch_wasm::decode_job("PT-P710BT", &job.to_bytes()).unwrap();
    assert_eq!(d.page_count(), 2);
    assert_eq!(d.pages()[0].to_packed(), packed);
    assert!(d.violations().is_empty());
}

#[wasm_bindgen_test]
fn tone_and_bitmap_helpers() {
    let (w, h) = (16u32, 8u16);
    let luma: Vec<u8> = (0..u32::from(h) * w).map(|i| (i * 2) as u8).collect();
    let thr = Bitmap1::from_luma(&luma, w, h, None).unwrap();
    let fs = Bitmap1::from_luma(&luma, w, h, Some(js(r#"{"dither":"floyd-steinberg"}"#))).unwrap();
    assert_eq!((thr.length(), thr.height()), (w, h));
    assert_ne!(thr.to_packed(), fs.to_packed());
    let err = Bitmap1::from_luma(&luma[1..], w, h, None).unwrap_err();
    assert_eq!(code_of(&err), "DATA_LENGTH");
    let bad = Bitmap1::from_luma(&luma, w, h, Some(js(r#"{"dither":"nope"}"#))).unwrap_err();
    assert_eq!(code_of(&bad), "INVALID_INPUT");

    let mut r = Raster::new(w, h).unwrap();
    let rgba: Vec<u8> = luma.iter().flat_map(|&v| [v, v, v, 255]).collect();
    r.blit_tone(
        &rgba,
        w,
        u32::from(h),
        0,
        0,
        Some(js(r#"{"dither":"bayer4"}"#)),
    )
    .unwrap();
    let toned = r.finish();
    assert!(!toned.is_blank());
    let cropped = toned.crop_lines(2, 6).unwrap();
    assert_eq!(cropped.length(), 4);
    assert_eq!(
        code_of(&toned.crop_lines(6, 2).unwrap_err()),
        "INVALID_INPUT"
    );
}

/// One step of the core harness order: pump, advance, deliver (7 + 25 byte fragments),
/// timeout. `false` when nothing is pending.
fn step(
    s: &mut PrintSession,
    vp: &mut VirtualPrinter,
    now: &mut f64,
    events: &mut Vec<SessionEvent>,
) -> bool {
    while let Some(b) = s.poll_transmit() {
        vp.handle_input(&b, *now);
    }
    while let Some(e) = s.poll_event().unwrap() {
        events.push(e.to_rust().unwrap());
    }
    let next = [vp.next_output_at(), s.poll_timeout()]
        .into_iter()
        .flatten()
        .fold(f64::INFINITY, f64::min);
    if !next.is_finite() {
        return false;
    }
    *now = now.max(next);
    while let Some(f) = vp.poll_output(*now) {
        // 3-byte settings replies arrive whole.
        let (a, b) = f.split_at(f.len().min(7));
        s.handle_input(a, *now);
        s.handle_input(b, *now);
    }
    if s.poll_timeout().is_some_and(|t| t <= *now) {
        s.handle_timeout(*now);
    }
    true
}

#[wasm_bindgen_test]
fn session_prints_against_virtual_printer() {
    let mut vp = VirtualPrinter::new("PT-P710BT", "tze128-24", None, None).unwrap();
    let mut s = PrintSession::new(None, Some(js(r#"{"statusTimeoutMs":2000}"#))).unwrap();
    let mut now = 1000.0;
    let mut events: Vec<SessionEvent> = Vec::new();
    s.connect(now);
    for _ in 0..1000 {
        if s.state().unwrap().to_rust().unwrap() == SessionState::Ready {
            break;
        }
        assert!(step(&mut s, &mut vp, &mut now, &mut events));
    }
    assert_eq!(s.model_name().as_deref(), Some("PT-P710BT"));
    let last: JsValue = s.last_status().unwrap().unwrap().into();
    assert_eq!(
        get(&last, "mediaId").as_string().as_deref(),
        Some("tze128-24")
    );

    let tape = ptouch::media_by_id("tze128-24").unwrap();
    let mut r = Raster::new(80, tape.print_pins).unwrap();
    let rgba = label_rgba(80, tape.print_pins);
    r.blit_crisp(&rgba, 80, u32::from(tape.print_pins), 1, 128)
        .unwrap();
    let page = r.finish();
    let packed = page.to_packed();
    let job = encode_job(
        "PT-P710BT",
        "tze128-24",
        vec![page],
        Some(js(r#"{"copies":2}"#)),
    )
    .unwrap();
    s.submit(&job, now).unwrap();
    // The job handle is still usable after submit (borrowed).
    assert_eq!(job.page_count(), 2);
    assert_eq!(
        code_of(&s.submit(&job, now).unwrap_err()),
        "BUSY",
        "second submit while printing"
    );
    let mut done = false;
    for _ in 0..10_000 {
        if s.state().unwrap().to_rust().unwrap() == SessionState::Ready
            && events
                .iter()
                .any(|e| matches!(e, SessionEvent::JobCompleted))
        {
            done = true;
            break;
        }
        if !step(&mut s, &mut vp, &mut now, &mut events) {
            break;
        }
    }
    assert!(done, "{events:?}");
    let pages: Vec<&SessionEvent> = events
        .iter()
        .filter(|e| {
            matches!(
                e,
                SessionEvent::PageStarted { .. }
                    | SessionEvent::PageCompleted { .. }
                    | SessionEvent::JobCompleted
            )
        })
        .collect();
    assert_eq!(pages.len(), 5, "{pages:?}");
    assert_eq!(vp.printed_count(), 2);
    assert_eq!(vp.printed_page(1).unwrap().to_packed(), packed);
    assert!(vp.violations().is_empty());
}

#[wasm_bindgen_test]
fn virtual_printer_behaviours_from_js() {
    let vp = VirtualPrinter::new(
        "PT-P710BT",
        "tze128-12",
        Some(js(r#"{"kind":"cover-open-on-page","page":2}"#)),
        Some(js(r#"{"replyDelayMs":5}"#)),
    )
    .unwrap();
    let status: JsValue = parse_status(&vp.idle_status()).unwrap().into();
    assert_eq!(
        get(&status, "mediaId").as_string().as_deref(),
        Some("tze128-12")
    );
    let err = VirtualPrinter::new(
        "PT-P710BT",
        "tze128-12",
        Some(js(r#"{"kind":"cover-open-on-page"}"#)),
        None,
    )
    .unwrap_err();
    assert_eq!(code_of(&err), "INVALID_INPUT");
    let none = VirtualPrinter::new(
        "PT-P710BT",
        "tze128-24",
        Some(js(r#"{"kind":"no-media"}"#)),
        None,
    )
    .unwrap();
    let st: JsValue = parse_status(&none.idle_status()).unwrap().into();
    assert_eq!(get(&st, "mediaType").as_string().as_deref(), Some("none"));
}

/// Steps until `done(events)` (or panics after 10 000 steps).
fn run_until(
    s: &mut PrintSession,
    vp: &mut VirtualPrinter,
    now: &mut f64,
    events: &mut Vec<SessionEvent>,
    done: impl Fn(&[SessionEvent]) -> bool,
) {
    for _ in 0..10_000 {
        if done(events) {
            return;
        }
        // `step` drains events before it finds nothing left to wait for.
        if !step(s, vp, now, events) {
            assert!(done(events), "stalled: {events:?}");
            return;
        }
    }
    panic!("not done: {events:?}");
}

#[wasm_bindgen_test]
fn settings_round_trip_through_print_session() {
    // settingsFor: shapes as JS sees them.
    let info: Vec<JsValue> = settings_for("PT-P710BT")
        .unwrap()
        .into_iter()
        .map(Into::into)
        .collect();
    assert_eq!(info.len(), 3);
    assert_eq!(
        get(&info[1], "id").as_string().as_deref(),
        Some("auto-power-off")
    );
    assert_eq!(
        get(&info[1], "kind").as_string().as_deref(),
        Some("duration")
    );
    // P710BT timers are named after the printer's information report (PROTOCOL.md §8 #34).
    assert_eq!(
        get(&info[1], "brotherLabel").as_string().as_deref(),
        Some("AutoPowerOff(adp)")
    );
    assert_eq!(
        get(&info[1], "brotherLabelSource").as_string().as_deref(),
        Some("info-report")
    );
    assert_eq!(
        get(&info[0], "brotherLabelSource").as_string().as_deref(),
        Some("setting-tool")
    );
    assert!(get(&info[1], "selectorUnverified").is_undefined());
    assert_eq!(
        JSON::stringify(&get(&info[0], "choices"))
            .unwrap()
            .as_string()
            .as_deref(),
        Some(r#"[{"kind":"enabled","enabled":false},{"kind":"enabled","enabled":true}]"#)
    );
    assert!(settings_for("PT-E560BT").unwrap().is_empty());
    assert!(settings_for("nope").unwrap().is_empty());

    let mut vp = VirtualPrinter::new("PT-P710BT", "tze128-24", None, None).unwrap();
    // Selector 01 = battery on the PT-P710BT.
    assert!(vp.set_setting_byte(0x41, Some(1), 0x07));
    let mut s = PrintSession::new(None, None).unwrap();
    let mut now = 1000.0;
    let mut events: Vec<SessionEvent> = Vec::new();
    s.connect(now);
    run_until(&mut s, &mut vp, &mut now, &mut events, |e| {
        e.iter().any(|e| matches!(e, SessionEvent::Ready { .. }))
    });
    let err = s.read_settings(js("[]"), now).unwrap_err();
    assert_eq!(code_of(&err), "EMPTY");
    let err = s
        .write_settings(
            js(r#"[{"id":"auto-power-off","value":{"kind":"minutes","minutes":120}}]"#),
            now,
        )
        .unwrap_err();
    assert_eq!(code_of(&err), "INVALID_INPUT");
    let err = s.read_settings(js(r#"["bogus"]"#), now).unwrap_err();
    assert_eq!(code_of(&err), "INVALID_INPUT");

    s.read_settings(
        js(r#"["auto-power-on","auto-power-off","auto-power-off-battery"]"#),
        now,
    )
    .unwrap();
    let state: JsValue = s.state().unwrap().into();
    assert_eq!(
        get(&state, "state").as_string().as_deref(),
        Some("settings")
    );
    assert_eq!(code_of(&s.request_status(now).unwrap_err()), "BUSY");
    run_until(&mut s, &mut vp, &mut now, &mut events, |e| {
        e.iter()
            .any(|e| matches!(e, SessionEvent::SettingsRead { .. }))
    });
    let read = events
        .iter()
        .find(|e| matches!(e, SessionEvent::SettingsRead { .. }))
        .unwrap();
    let read_js: JsValue = Ts::<SessionEvent>::from_rust(read).unwrap().into();
    assert_eq!(
        get(&read_js, "type").as_string().as_deref(),
        Some("settings-read")
    );
    let report = get(&read_js, "report");
    let battery = Reflect::get(&report, &JsValue::from(2)).unwrap();
    assert_eq!(get(&battery, "unlistedByte").as_f64(), Some(7.0));
    assert_eq!(
        get(&battery, "text").as_string().as_deref(),
        Some("unknown (0x07)")
    );
    let ac = Reflect::get(&report, &JsValue::from(1)).unwrap();
    assert_eq!(get(&ac, "value.minutes").as_f64(), Some(30.0));
    assert_eq!(get(&ac, "text").as_string().as_deref(), Some("30 min"));

    s.write_settings(
        js(r#"[{"id":"auto-power-off-battery","value":{"kind":"minutes","minutes":60}}]"#),
        now,
    )
    .unwrap();
    run_until(&mut s, &mut vp, &mut now, &mut events, |e| {
        e.iter()
            .any(|e| matches!(e, SessionEvent::SettingsWritten { .. }))
    });
    let written = events
        .iter()
        .find(|e| matches!(e, SessionEvent::SettingsWritten { .. }))
        .unwrap();
    let w: JsValue = Ts::<SessionEvent>::from_rust(written).unwrap().into();
    assert_eq!(
        get(&w, "type").as_string().as_deref(),
        Some("settings-written")
    );
    assert_eq!(get(&w, "verified").as_bool(), Some(true));
    let r0 = Reflect::get(&get(&w, "report"), &JsValue::from(0)).unwrap();
    assert_eq!(get(&r0, "text").as_string().as_deref(), Some("60 min"));
    assert_eq!(vp.setting_byte(0x41, Some(1)), Some(6));
    assert_eq!(
        vp.setting_byte(0x41, Some(0)),
        Some(3),
        "USB/AC timer untouched"
    );
    assert_eq!(vp.commits(), 1);
    assert!(vp.violations().is_empty());
}

#[wasm_bindgen_test]
fn settings_timeout_is_reported() {
    let mut vp = VirtualPrinter::new(
        "PT-P710BT",
        "tze128-24",
        Some(js(r#"{"kind":"settings-silent"}"#)),
        None,
    )
    .unwrap();
    let mut s = PrintSession::new(None, Some(js(r#"{"settingsReplyTimeoutMs":200}"#))).unwrap();
    let mut now = 0.0;
    let mut events: Vec<SessionEvent> = Vec::new();
    s.connect(now);
    run_until(&mut s, &mut vp, &mut now, &mut events, |e| {
        e.iter().any(|e| matches!(e, SessionEvent::Ready { .. }))
    });
    s.read_settings(js(r#"["auto-power-on"]"#), now).unwrap();
    run_until(&mut s, &mut vp, &mut now, &mut events, |e| {
        e.iter().any(|e| matches!(e, SessionEvent::Failed { .. }))
    });
    let failed = events
        .iter()
        .find(|e| matches!(e, SessionEvent::Failed { .. }))
        .unwrap();
    let f: JsValue = Ts::<SessionEvent>::from_rust(failed).unwrap().into();
    assert_eq!(
        get(&f, "error.code").as_string().as_deref(),
        Some("TIMEOUT")
    );
    assert_eq!(
        get(&f, "error.timeout").as_string().as_deref(),
        Some("settings-reply")
    );
    let state: JsValue = s.state().unwrap().into();
    assert_eq!(get(&state, "state").as_string().as_deref(), Some("ready"));
}

/// A real PT-P710BT settings reply (USB, 2026-10-16; HARDWARE-TESTS.md §9 HW-S1).
fn hw_settings_reply(value: u8) -> [u8; 32] {
    let mut f = [
        0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0xF0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x01,
    ];
    f[30] = value;
    f
}

/// Regression (PROTOCOL.md §8 #34): the real replies of a PT-P710BT whose information report
/// said "AutoPowerOff(adp) = 60 Minutes" and "AutoPowerOff(Bat)" empty read as USB/AC = 60 min
/// and battery = never.
#[wasm_bindgen_test]
fn p710bt_hardware_settings_replies() {
    let mut s = PrintSession::new(None, None).unwrap();
    let mut now = 0.0;
    s.connect(now);
    while s.poll_transmit().is_some() {}
    now += 100.0;
    s.handle_timeout(now);
    while s.poll_transmit().is_some() {}
    s.handle_input(&FIXTURE, now);
    while s.poll_event().unwrap().is_some() {}
    s.read_settings(
        js(r#"["auto-power-on","auto-power-off","auto-power-off-battery"]"#),
        now,
    )
    .unwrap();
    let mut gets: Vec<Vec<u8>> = Vec::new();
    let mut read = None;
    for _ in 0..1000 {
        let mut replied = false;
        while let Some(b) = s.poll_transmit() {
            let reply = match b.as_slice() {
                [0x1B, 0x69, 0x55, 0x70, 0x01] => Some(hw_settings_reply(0x01)),
                [0x1B, 0x69, 0x55, 0x41, 0x01, 0x01] => Some(hw_settings_reply(0x00)),
                [0x1B, 0x69, 0x55, 0x41, 0x01, 0x00] => Some(hw_settings_reply(0x06)),
                _ => None,
            };
            if let Some(r) = reply {
                gets.push(b);
                s.handle_input(&r, now);
                replied = true;
            }
        }
        while let Some(e) = s.poll_event().unwrap() {
            let e: SessionEvent = e.to_rust().unwrap();
            if matches!(e, SessionEvent::SettingsRead { .. }) {
                read = Some(e);
            }
        }
        if read.is_some() {
            break;
        }
        if !replied {
            now = s.poll_timeout().unwrap_or(now);
            s.handle_timeout(now);
        }
    }
    assert_eq!(
        gets,
        [
            vec![0x1B, 0x69, 0x55, 0x70, 0x01],
            vec![0x1B, 0x69, 0x55, 0x41, 0x01, 0x00],
            vec![0x1B, 0x69, 0x55, 0x41, 0x01, 0x01],
        ]
    );
    let read: JsValue = Ts::<SessionEvent>::from_rust(&read.unwrap())
        .unwrap()
        .into();
    let text = |i: u32| {
        let r = Reflect::get(&get(&read, "report"), &JsValue::from(i)).unwrap();
        (
            get(&r, "id").as_string().unwrap(),
            get(&r, "text").as_string().unwrap(),
        )
    };
    assert_eq!(text(0), ("auto-power-on".into(), "on".into()));
    assert_eq!(text(1), ("auto-power-off".into(), "60 min".into()));
    assert_eq!(text(2), ("auto-power-off-battery".into(), "never".into()));
}

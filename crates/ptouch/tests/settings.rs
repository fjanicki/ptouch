//! Printer settings (PROTOCOL.md §3.6, docs/SETTINGS-PLAN.md §1.4): exact transmit sequences,
//! encode/decode, session gating, failure paths and VirtualPrinter round trips per profile.

// Test helpers outside `#[test]` fns are not covered by clippy's `allow-*-in-tests`;
// failing loudly is the point of a test.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use proptest::prelude::*;

use ptouch::encode::JobOptions;
use ptouch::model::SettingsProfile;
use ptouch::settings::{
    NEVER_SEND, ReplyFormat, SETTINGS_PROLOGUE, SETTINGS_READ_EPILOGUE, SETTINGS_WRITE_EPILOGUE,
    contains_never_send,
};
use ptouch::virtual_printer::parser::Violation;
use ptouch::virtual_printer::{Behaviour, VirtualPrinter};
use ptouch::{
    Bitmap, Error, Event, Model, ModelProfile, Session, SessionConfig, SessionState, SettingId,
    SettingReading, SettingReport, SettingValue, TapeSpec, TimeoutKind, encode_job, profile,
    profiles, setting_spec, settings_for,
};

/// The real PT-P710BT reply (tests/fixtures/status/p710bt_24mm_laminated_idle.hex).
const FIXTURE: [u8; 32] = [
    0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

const GET_ON: [u8; 5] = [0x1B, 0x69, 0x55, 0x70, 0x01];
const GET_OFF_01: [u8; 6] = [0x1B, 0x69, 0x55, 0x41, 0x01, 0x01];
const GET_OFF_00: [u8; 6] = [0x1B, 0x69, 0x55, 0x41, 0x01, 0x00];
/// PT-P710BT Auto Power Off (USB/AC adapter) set prefix: selector `00` (PROTOCOL.md §8 #34).
const SET_OFF_00: [u8; 6] = [0x1B, 0x69, 0x55, 0x41, 0x00, 0x00];

/// Real PT-P710BT settings replies (USB, 2026-10-16; HARDWARE-TESTS.md §9 HW-S1), in the
/// order they were read: Auto Power On (`st[30]` = 01, on), selector `01` (00, never),
/// selector `00` (06, 60 min). The printer's information report showed
/// "AutoPowerOff(adp) = 60 Minutes" and an empty "AutoPowerOff(Bat)".
const HW_POWER_ON: [u8; 32] = [
    0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0xF0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01,
];
const HW_SEL_01: [u8; 32] = [
    0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0xF0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
];
const HW_SEL_00: [u8; 32] = [
    0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0xF0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x01,
];

use SettingId::{AutoPowerOff, AutoPowerOffBattery, AutoPowerOn};
use SettingValue::{Enabled, Minutes};

fn model(m: Model) -> &'static ModelProfile {
    profile(m).expect("model in table")
}

fn tape(p: &'static ModelProfile) -> &'static TapeSpec {
    p.media
        .iter()
        .copied()
        .find(|t| t.kind == ptouch::TapeKind::Tze)
        .expect("tape in table")
}

fn printer(m: Model, behaviour: Behaviour) -> VirtualPrinter {
    let p = model(m);
    VirtualPrinter::new(p, tape(p), behaviour)
}

/// A settings reply frame: the fixture with `st[18] = F0`, `st[30] = v`.
fn f0(v: u8) -> [u8; 32] {
    let mut f = FIXTURE;
    f[18] = 0xF0;
    f[30] = v;
    f
}

/// Drives a [`Session`] against a [`VirtualPrinter`] on a simulated clock.
struct Harness {
    s: Session,
    vp: VirtualPrinter,
    now: u64,
    bytewise: bool,
    events: Vec<Event>,
    sent: Vec<Vec<u8>>,
}

impl Harness {
    fn new(vp: VirtualPrinter) -> Self {
        Self {
            s: Session::new(None, SessionConfig::default()),
            vp,
            now: 1_000,
            bytewise: false,
            events: Vec::new(),
            sent: Vec::new(),
        }
    }

    fn pump(&mut self) {
        while let Some(buf) = self.s.poll_transmit() {
            self.vp.handle_input(&buf, self.now);
            self.sent.push(buf);
        }
        while let Some(ev) = self.s.poll_event() {
            self.events.push(ev);
        }
    }

    fn step(&mut self) -> bool {
        self.pump();
        let next = [self.vp.next_output_at(), self.s.poll_timeout()]
            .into_iter()
            .flatten()
            .min();
        let Some(next) = next else {
            return false;
        };
        self.now = self.now.max(next);
        let mut rx = Vec::new();
        while let Some(f) = self.vp.poll_output(self.now) {
            rx.extend_from_slice(&f);
        }
        if self.bytewise {
            for b in &rx {
                self.s.handle_input(std::slice::from_ref(b), self.now);
            }
        } else if !rx.is_empty() {
            self.s.handle_input(&rx, self.now);
        }
        if self.s.poll_timeout().is_some_and(|d| d <= self.now) {
            self.s.handle_timeout(self.now);
        }
        self.pump();
        true
    }

    /// Steps until an event matches (returns it) or 60 s of simulated time pass.
    fn run_until(&mut self, pred: impl Fn(&Event) -> bool) -> Option<Event> {
        let end = self.now + 60_000;
        let mut seen = self.events.len();
        loop {
            if let Some(e) = self.events[seen..].iter().find(|e| pred(e)) {
                return Some(e.clone());
            }
            seen = self.events.len();
            if self.now > end || !self.step() {
                return None;
            }
        }
    }

    fn connect(&mut self) {
        self.s.connect(self.now);
        self.run_until(|e| matches!(e, Event::Ready(_)))
            .expect("handshake completes");
        self.sent.clear();
    }

    fn settings_done(&mut self) -> Event {
        self.run_until(|e| {
            matches!(
                e,
                Event::SettingsRead(_) | Event::SettingsWritten { .. } | Event::Failed { .. }
            )
        })
        .expect("settings transaction ends")
    }

    fn read(&mut self, ids: &[SettingId]) -> Vec<SettingReport> {
        self.s.read_settings(ids, self.now).expect("read starts");
        assert_eq!(self.s.state(), SessionState::Settings);
        match self.settings_done() {
            Event::SettingsRead(r) => r,
            other => panic!("unexpected {other:?}"),
        }
    }

    fn write(&mut self, values: &[(SettingId, SettingValue)]) -> (Vec<SettingReport>, bool) {
        self.s
            .write_settings(values, self.now)
            .expect("write starts");
        match self.settings_done() {
            Event::SettingsWritten { report, verified } => (report, verified),
            other => panic!("unexpected {other:?}"),
        }
    }
}

fn readings(r: &[SettingReport]) -> Vec<(SettingId, SettingReading)> {
    r.iter().map(|r| (r.id, r.reading)).collect()
}

fn v(value: SettingValue) -> SettingReading {
    SettingReading::Value(value)
}

// ---------------------------------------------------------------------------------------------
// Exact transmit sequences (SETTINGS-PLAN.md §1.4)
// ---------------------------------------------------------------------------------------------

#[test]
fn p710bt_read_all_sequence() {
    // Selector 00 = USB/AC adapter, 01 = battery (PROTOCOL.md §8 #34).
    let vp = printer(Model::PtP710bt, Behaviour::Normal)
        .with_setting(0x41, Some(0x00), 0x01)
        .with_setting(0x41, Some(0x01), 0x00);
    let mut h = Harness::new(vp);
    h.connect();
    let report = h.read(&SettingId::ALL);
    assert_eq!(
        h.sent,
        vec![
            SETTINGS_PROLOGUE.to_vec(),
            GET_ON.to_vec(),
            GET_OFF_00.to_vec(),
            GET_OFF_01.to_vec(),
            SETTINGS_READ_EPILOGUE.to_vec(),
        ]
    );
    assert_eq!(
        readings(&report),
        vec![
            (AutoPowerOn, v(Enabled(false))),
            (AutoPowerOff, v(Minutes(10))),
            (AutoPowerOffBattery, v(Minutes(0))),
        ]
    );
    for r in &report {
        assert_eq!(r.raw.len(), 32);
        assert_eq!(r.raw[18], 0xF0);
    }
    assert_eq!(h.s.state(), SessionState::Ready);
    assert_eq!(h.s.poll_timeout(), None);
    assert!(h.vp.violations().is_empty(), "{:?}", h.vp.violations());
    // A settings reply never becomes the last status.
    assert_eq!(h.s.last_status().map(|s| s.raw), Some(h.vp.idle_status()));
}

#[test]
fn p710bt_write_sequence_and_verify() {
    let mut h = Harness::new(printer(Model::PtP710bt, Behaviour::Normal));
    h.connect();
    let (report, verified) = h.write(&[(AutoPowerOff, Minutes(10))]);
    assert_eq!(
        h.sent,
        vec![
            SETTINGS_PROLOGUE.to_vec(),
            vec![0x1B, 0x69, 0x55, 0x41, 0x00, 0x00, 0x01],
            SETTINGS_WRITE_EPILOGUE.to_vec(),
            SETTINGS_PROLOGUE.to_vec(),
            GET_OFF_00.to_vec(),
            SETTINGS_READ_EPILOGUE.to_vec(),
        ]
    );
    assert!(verified);
    assert_eq!(readings(&report), vec![(AutoPowerOff, v(Minutes(10)))]);
    assert_eq!(h.vp.setting_byte(0x41, Some(0x00)), Some(0x01));
    assert_eq!(
        h.vp.setting_byte(0x41, Some(0x01)),
        Some(0x03),
        "battery untouched"
    );
    assert_eq!(h.vp.commits(), 1);
    assert_eq!(h.s.state(), SessionState::Ready);
    assert!(h.vp.violations().is_empty(), "{:?}", h.vp.violations());
}

/// Regression (PROTOCOL.md §8 #34; HARDWARE-TESTS.md §9 HW-S1): the real replies of a
/// PT-P710BT whose information report said "AutoPowerOff(adp) = 60 Minutes" and
/// "AutoPowerOff(Bat)" empty. The old (Brother Mac tool) selector pairing showed the USB timer
/// as "never", and the printer, left on USB overnight, switched itself off.
#[test]
fn p710bt_hardware_replies_read_as_the_information_report() {
    let (mut s, mut now) = ready_session();
    s.read_settings(&SettingId::ALL, now).unwrap();
    let mut gets = Vec::new();
    for _ in 0..3 {
        let sent = to_first_get(&mut s, &mut now);
        let get = sent.last().cloned().unwrap();
        let reply = match get.as_slice() {
            g if g == GET_ON => HW_POWER_ON,
            g if g == GET_OFF_01 => HW_SEL_01,
            g if g == GET_OFF_00 => HW_SEL_00,
            g => panic!("unexpected get {g:02X?}"),
        };
        gets.push(get);
        s.handle_input(&reply, now);
    }
    assert_eq!(
        gets,
        vec![GET_ON.to_vec(), GET_OFF_00.to_vec(), GET_OFF_01.to_vec()]
    );
    let ev = drain_events(&mut s);
    let [Event::SettingsRead(report)] = &ev[..] else {
        panic!("{ev:?}");
    };
    assert_eq!(
        readings(report),
        vec![
            (AutoPowerOn, v(Enabled(true))),
            (AutoPowerOff, v(Minutes(60))),
            (AutoPowerOffBattery, v(Minutes(0))),
        ]
    );
    assert_eq!(report[1].raw, HW_SEL_00.to_vec());
    assert_eq!(report[2].raw, HW_SEL_01.to_vec());
    assert_eq!(s.poll_transmit(), Some(SETTINGS_READ_EPILOGUE.to_vec()));
}

/// A P710BT write of the USB/AC timer uses selector `00` (set and read-back); the battery
/// timer uses `01`. The write path itself is UNVERIFIED on hardware (HW-S3).
#[test]
fn p710bt_write_selectors() {
    let mut h = Harness::new(printer(Model::PtP710bt, Behaviour::Normal));
    h.connect();
    let (_, verified) = h.write(&[(AutoPowerOff, Minutes(0))]);
    assert!(verified);
    let mut set = SET_OFF_00.to_vec();
    set.push(0x00);
    assert!(h.sent.contains(&set), "{:02X?}", h.sent);
    assert!(h.sent.contains(&GET_OFF_00.to_vec()));
    // Nothing touches selector 01 (the battery timer).
    assert!(
        !h.sent
            .iter()
            .any(|b| b[..] == GET_OFF_01 || b.starts_with(&[0x1B, 0x69, 0x55, 0x41, 0x00, 0x01])),
        "{:02X?}",
        h.sent
    );
    assert_eq!(h.vp.setting_byte(0x41, Some(0x00)), Some(0x00));
    assert_eq!(h.vp.setting_byte(0x41, Some(0x01)), Some(0x03));

    let mut h = Harness::new(printer(Model::PtP710bt, Behaviour::Normal));
    h.connect();
    let (_, verified) = h.write(&[(AutoPowerOffBattery, Minutes(60))]);
    assert!(verified);
    assert_eq!(
        h.sent,
        vec![
            SETTINGS_PROLOGUE.to_vec(),
            vec![0x1B, 0x69, 0x55, 0x41, 0x00, 0x01, 0x06],
            SETTINGS_WRITE_EPILOGUE.to_vec(),
            SETTINGS_PROLOGUE.to_vec(),
            GET_OFF_01.to_vec(),
            SETTINGS_READ_EPILOGUE.to_vec(),
        ]
    );
    assert_eq!(h.vp.setting_byte(0x41, Some(0x01)), Some(0x06));
    assert_eq!(h.vp.setting_byte(0x41, Some(0x00)), Some(0x03));
}

#[test]
fn write_timing_follows_the_config() {
    let mut h = Harness::new(printer(Model::PtP710bt, Behaviour::Normal));
    h.connect();
    let t0 = h.now;
    h.s.write_settings(
        &[(AutoPowerOn, Enabled(true)), (AutoPowerOff, Minutes(20))],
        t0,
    )
    .unwrap();
    let cfg = SessionConfig::default();
    assert_eq!(h.s.poll_transmit(), Some(SETTINGS_PROLOGUE.to_vec()));
    assert_eq!(h.s.poll_transmit(), None);
    assert_eq!(h.s.poll_timeout(), Some(t0 + cfg.settings_gap_ms));
    h.s.handle_timeout(t0 + cfg.settings_gap_ms - 1);
    assert_eq!(h.s.poll_transmit(), None, "no-op before the deadline");
    let mut t = t0 + cfg.settings_gap_ms;
    h.s.handle_timeout(t);
    assert_eq!(
        h.s.poll_transmit(),
        Some(vec![0x1B, 0x69, 0x55, 0x70, 0x00, 0x01])
    );
    t += cfg.settings_gap_ms;
    h.s.handle_timeout(t);
    assert_eq!(
        h.s.poll_transmit(),
        Some(vec![0x1B, 0x69, 0x55, 0x41, 0x00, 0x00, 0x02])
    );
    t += cfg.settings_gap_ms;
    h.s.handle_timeout(t);
    assert_eq!(h.s.poll_transmit(), Some(SETTINGS_WRITE_EPILOGUE.to_vec()));
    assert_eq!(h.s.poll_timeout(), Some(t + cfg.settings_settle_ms));
    t += cfg.settings_settle_ms;
    h.s.handle_timeout(t);
    assert_eq!(h.s.poll_transmit(), Some(SETTINGS_PROLOGUE.to_vec()));
    assert_eq!(h.s.poll_timeout(), Some(t + cfg.settings_drain_ms));
    t += cfg.settings_drain_ms;
    h.s.handle_timeout(t);
    assert_eq!(h.s.poll_transmit(), None, "gap before the first get");
    t += cfg.settings_gap_ms;
    h.s.handle_timeout(t);
    assert_eq!(h.s.poll_transmit(), Some(GET_ON.to_vec()));
    assert_eq!(h.s.poll_timeout(), Some(t + cfg.settings_reply_timeout_ms));
}

// ---------------------------------------------------------------------------------------------
// Round trips per profile (virtual printer)
// ---------------------------------------------------------------------------------------------

/// Read → write every setting to a different listed value → verified → read again.
fn round_trip(m: Model) {
    let p = model(m);
    let specs = settings_for(p);
    assert_eq!(specs.len(), 3, "{m:?}");
    let mut h = Harness::new(printer(m, Behaviour::Normal));
    h.connect();
    let before = h.read(&SettingId::ALL);
    assert_eq!(
        readings(&before),
        vec![
            (AutoPowerOn, v(Enabled(false))),
            (AutoPowerOff, v(Minutes(30))),
            (AutoPowerOffBattery, v(Minutes(30))),
        ],
        "{m:?} virtual defaults"
    );
    for (r, spec) in before.iter().zip(specs) {
        assert_eq!(r.raw.len(), spec.reply.len(), "{m:?}");
    }
    // The largest listed value of each setting (12 h on the P900W/P910BT AC/USB timer).
    let target: Vec<(SettingId, SettingValue)> = specs
        .iter()
        .map(|s| (s.id, s.choices.last().expect("choices").value))
        .collect();
    let (after, verified) = h.write(&target);
    assert!(verified, "{m:?}");
    assert_eq!(
        readings(&after),
        target
            .iter()
            .map(|(id, val)| (*id, v(*val)))
            .collect::<Vec<_>>()
    );
    assert_eq!(h.vp.commits(), 1);
    let again = h.read(&[AutoPowerOffBattery, AutoPowerOff]);
    assert_eq!(
        readings(&again),
        vec![
            (AutoPowerOffBattery, v(target[2].1)),
            (AutoPowerOff, v(target[1].1))
        ]
    );
    assert!(
        h.vp.violations().is_empty(),
        "{m:?}: {:?}",
        h.vp.violations()
    );
    for buf in &h.sent {
        assert!(!contains_never_send(buf), "{m:?} sent {buf:02X?}");
    }
}

#[test]
fn round_trip_every_settings_model() {
    let mut seen = Vec::new();
    for p in profiles() {
        if let Some(sp) = p.settings_profile {
            round_trip(p.model);
            seen.push(sp);
        }
    }
    for sp in [
        SettingsProfile::P710bt,
        SettingsProfile::P900w,
        SettingsProfile::P910bt,
    ] {
        assert!(seen.contains(&sp), "{sp:?} covered");
    }
}

#[test]
fn p900w_and_p910bt_encode_hours_differently() {
    for (m, byte) in [(Model::PtP900w, 0x07), (Model::PtP910bt, 0x0C)] {
        let mut h = Harness::new(printer(m, Behaviour::Normal));
        h.connect();
        let (_, verified) = h.write(&[(AutoPowerOff, Minutes(120))]);
        assert!(verified);
        assert!(
            h.sent
                .contains(&vec![0x1B, 0x69, 0x55, 0x41, 0x00, 0x00, byte])
        );
        assert_eq!(h.vp.setting_byte(0x41, Some(0x00)), Some(byte));
    }
}

#[test]
fn byte_by_byte_delivery() {
    for m in [Model::PtP710bt, Model::PtP900w] {
        let mut h = Harness::new(printer(m, Behaviour::Normal));
        h.bytewise = true;
        h.connect();
        let r = h.read(&SettingId::ALL);
        assert_eq!(r.len(), 3, "{m:?}");
    }
}

#[test]
fn writes_ignored_reads_back_unverified() {
    let mut h = Harness::new(printer(Model::PtP710bt, Behaviour::SettingsWritesIgnored));
    h.connect();
    let (report, verified) = h.write(&[(AutoPowerOff, Minutes(10))]);
    assert!(!verified);
    assert_eq!(readings(&report), vec![(AutoPowerOff, v(Minutes(30)))]);
    assert_eq!(h.vp.commits(), 1);
}

#[test]
fn silent_printer_times_out_and_restores_command_mode() {
    let mut h = Harness::new(printer(Model::PtP710bt, Behaviour::SettingsSilent));
    h.connect();
    h.s.read_settings(&[AutoPowerOn], h.now).unwrap();
    let start = h.now;
    let ev = h.settings_done();
    assert_eq!(
        ev,
        Event::Failed {
            error: Error::Timeout(TimeoutKind::SettingsReply),
            resume_from_page: None
        }
    );
    let cfg = SessionConfig::default();
    assert_eq!(
        h.now - start,
        cfg.settings_drain_ms + cfg.settings_gap_ms + cfg.settings_reply_timeout_ms
    );
    assert_eq!(h.sent.last(), Some(&SETTINGS_READ_EPILOGUE.to_vec()));
    assert_eq!(h.s.state(), SessionState::Ready);
    // The session is usable again.
    h.s.request_status(h.now).expect("ready again");
}

#[test]
fn stale_frame_is_drained() {
    for m in [Model::PtP710bt, Model::PtP900w, Model::PtP910bt] {
        let vp = printer(m, Behaviour::StaleFrameBeforeSettingsReply).with_setting(
            0x41,
            Some(0x01),
            0x02,
        );
        let mut h = Harness::new(vp);
        h.connect();
        let r = h.read(&SettingId::ALL);
        // Selector 01 is the battery timer on every profile.
        let got = r.iter().find(|r| r.id == AutoPowerOffBattery).unwrap();
        assert_eq!(got.reading, v(Minutes(20)), "{m:?}");
    }
}

#[test]
fn unlisted_byte_is_reported_raw() {
    let vp = printer(Model::PtP710bt, Behaviour::Normal).with_setting(0x41, Some(0x00), 0x07);
    let mut h = Harness::new(vp);
    h.connect();
    let r = h.read(&[AutoPowerOff]);
    assert_eq!(r[0].reading, SettingReading::Unlisted(0x07));
    assert_eq!(r[0].raw[30], 0x07);
}

// ---------------------------------------------------------------------------------------------
// Session gating and errors
// ---------------------------------------------------------------------------------------------

#[test]
fn unsupported_models() {
    for m in [Model::PtE560bt, Model::PtP300bt] {
        let mut h = Harness::new(printer(m, Behaviour::Normal));
        h.connect();
        assert!(settings_for(model(m)).is_empty());
        let unsupported = Err(Error::Unsupported(
            "printer settings are not supported on this model",
        ));
        assert_eq!(h.s.read_settings(&[AutoPowerOn], h.now), unsupported);
        assert_eq!(
            h.s.write_settings(&[(AutoPowerOn, Enabled(true))], h.now),
            unsupported
        );
        assert_eq!(h.s.poll_transmit(), None);
        assert_eq!(h.s.state(), SessionState::Ready);
    }
}

#[test]
fn request_validation_queues_nothing() {
    let mut h = Harness::new(printer(Model::PtP710bt, Behaviour::Normal));
    // Not connected.
    assert_eq!(h.s.read_settings(&[AutoPowerOn], h.now), Err(Error::Busy));
    h.connect();
    assert_eq!(h.s.read_settings(&[], h.now), Err(Error::Empty));
    assert_eq!(h.s.write_settings(&[], h.now), Err(Error::Empty));
    assert_eq!(
        h.s.read_settings(&[AutoPowerOn, AutoPowerOn], h.now),
        Err(Error::InvalidInput("duplicate setting"))
    );
    let not_offered = Err(Error::InvalidInput("value not offered by this model"));
    assert_eq!(
        h.s.write_settings(
            &[
                (AutoPowerOff, Minutes(10)),
                (AutoPowerOffBattery, Minutes(70))
            ],
            h.now
        ),
        not_offered
    );
    assert_eq!(
        h.s.write_settings(&[(AutoPowerOff, Minutes(120))], h.now),
        not_offered
    );
    assert_eq!(
        h.s.write_settings(&[(AutoPowerOn, Minutes(10))], h.now),
        not_offered
    );
    assert_eq!(h.s.poll_transmit(), None);
    assert_eq!(h.s.state(), SessionState::Ready);
    // A status request outstanding: busy.
    h.s.request_status(h.now).unwrap();
    assert_eq!(h.s.read_settings(&[AutoPowerOn], h.now), Err(Error::Busy));
}

#[test]
fn busy_while_handshaking_and_printing() {
    let p = model(Model::PtP710bt);
    let t = p
        .media
        .iter()
        .copied()
        .find(|t| t.media_width_byte == 24 && t.kind == ptouch::TapeKind::Tze)
        .unwrap();
    let mut h = Harness::new(VirtualPrinter::new(p, t, Behaviour::Normal));
    h.s.connect(h.now);
    assert!(matches!(h.s.state(), SessionState::Handshaking { .. }));
    assert_eq!(h.s.read_settings(&[AutoPowerOn], h.now), Err(Error::Busy));
    h.run_until(|e| matches!(e, Event::Ready(_))).unwrap();
    let page = Bitmap::from_fn(40, t.print_pins, |x, y| u32::from(y) == x % 10);
    let job = encode_job(p, t, &[&page], &JobOptions::default()).unwrap();
    h.s.submit(job, h.now).unwrap();
    assert!(matches!(h.s.state(), SessionState::Printing { .. }));
    assert_eq!(h.s.read_settings(&[AutoPowerOn], h.now), Err(Error::Busy));
    assert_eq!(
        h.s.write_settings(&[(AutoPowerOn, Enabled(true))], h.now),
        Err(Error::Busy)
    );
}

#[test]
fn status_and_submit_are_busy_during_settings() {
    let p = model(Model::PtP710bt);
    let t = p
        .media
        .iter()
        .copied()
        .find(|t| t.media_width_byte == 24 && t.kind == ptouch::TapeKind::Tze)
        .unwrap();
    let mut h = Harness::new(VirtualPrinter::new(p, t, Behaviour::Normal));
    h.connect();
    h.s.read_settings(&[AutoPowerOn], h.now).unwrap();
    assert_eq!(h.s.request_status(h.now), Err(Error::Busy));
    let page = Bitmap::from_fn(40, t.print_pins, |x, y| u32::from(y) == x % 10);
    let job = encode_job(p, t, &[&page], &JobOptions::default()).unwrap();
    assert_eq!(h.s.submit(job, h.now), Err(Error::Busy));
    assert_eq!(h.s.read_settings(&[AutoPowerOn], h.now), Err(Error::Busy));
    assert!(matches!(h.settings_done(), Event::SettingsRead(_)));
}

#[test]
fn cancel_during_settings() {
    let mut h = Harness::new(printer(Model::PtP710bt, Behaviour::Normal));
    h.connect();
    h.s.write_settings(&[(AutoPowerOff, Minutes(10))], h.now)
        .unwrap();
    h.s.cancel(h.now);
    h.pump();
    assert_eq!(
        h.sent,
        vec![SETTINGS_READ_EPILOGUE.to_vec()],
        "the unsent prologue is dropped"
    );
    assert_eq!(
        h.events.last(),
        Some(&Event::Failed {
            error: Error::Cancelled,
            resume_from_page: None
        })
    );
    assert_eq!(h.s.state(), SessionState::Ready);
    assert_eq!(h.s.poll_timeout(), None);
    assert_eq!(h.vp.setting_byte(0x41, Some(0x00)), Some(0x03));
}

#[test]
fn connect_during_settings_cancels_then_handshakes() {
    let mut h = Harness::new(printer(Model::PtP710bt, Behaviour::Normal));
    h.connect();
    h.s.read_settings(&SettingId::ALL, h.now).unwrap();
    h.pump();
    h.s.connect(h.now);
    assert!(matches!(h.s.state(), SessionState::Handshaking { .. }));
    assert_eq!(h.s.poll_transmit(), Some(SETTINGS_READ_EPILOGUE.to_vec()));
    let handshake = h.s.poll_transmit().unwrap();
    assert!(handshake.ends_with(&[0x1B, 0x40, 0x1B, 0x69, 0x61, 0x01]));
    assert!(h.s.poll_event().is_some_and(|e| e
        == Event::Failed {
            error: Error::Cancelled,
            resume_from_page: None
        }));
}

// ---------------------------------------------------------------------------------------------
// Scripted replies (no virtual printer)
// ---------------------------------------------------------------------------------------------

/// A Ready P710BT session (handshake answered with the fixture) and its clock.
fn ready_session() -> (Session, u64) {
    let mut s = Session::new(None, SessionConfig::default());
    let mut now = 0;
    s.connect(now);
    while s.poll_transmit().is_some() {}
    now += 100;
    s.handle_timeout(now);
    while s.poll_transmit().is_some() {}
    s.handle_input(&FIXTURE, now);
    assert_eq!(s.state(), SessionState::Ready);
    while s.poll_event().is_some() {}
    (s, now)
}

/// Advances the session to the point where the first get has been sent.
fn to_first_get(s: &mut Session, now: &mut u64) -> Vec<Vec<u8>> {
    let mut sent = Vec::new();
    while let Some(d) = s.poll_timeout() {
        *now = d;
        s.handle_timeout(*now);
        while let Some(b) = s.poll_transmit() {
            sent.push(b);
        }
        if sent.iter().any(|b| b.starts_with(&[0x1B, 0x69, 0x55])) {
            break;
        }
    }
    sent
}

fn drain_events(s: &mut Session) -> Vec<Event> {
    std::iter::from_fn(|| s.poll_event()).collect()
}

#[test]
fn input_during_drain_and_gap_is_discarded() {
    let (mut s, mut now) = ready_session();
    s.read_settings(&[AutoPowerOff], now).unwrap();
    // An F0 frame during the drain must not count as the reply.
    s.handle_input(&f0(0x05), now + 1);
    let sent = to_first_get(&mut s, &mut now);
    assert_eq!(sent.last(), Some(&GET_OFF_00.to_vec()));
    assert!(drain_events(&mut s).is_empty());
    s.handle_input(&f0(0x02), now + 10);
    assert_eq!(
        drain_events(&mut s),
        vec![Event::SettingsRead(vec![SettingReport {
            id: AutoPowerOff,
            reading: v(Minutes(20)),
            raw: f0(0x02).to_vec()
        }])]
    );
    assert_eq!(s.poll_transmit(), Some(SETTINGS_READ_EPILOGUE.to_vec()));
}

#[test]
fn unsolicited_status_during_collect_is_skipped() {
    let (mut s, mut now) = ready_session();
    s.read_settings(&[AutoPowerOn], now).unwrap();
    to_first_get(&mut s, &mut now);
    let mut both = FIXTURE.to_vec();
    both.extend_from_slice(&f0(0x01));
    // Split mid-frame, as RFCOMM does.
    let (a, b) = both.split_at(39);
    s.handle_input(a, now);
    s.handle_input(b, now);
    let ev = drain_events(&mut s);
    assert_eq!(ev.len(), 1, "no Status event for skipped frames: {ev:?}");
    assert!(matches!(&ev[0], Event::SettingsRead(r) if r[0].reading == v(Enabled(true))));
}

#[test]
fn error_frame_during_collect_fails() {
    let (mut s, mut now) = ready_session();
    s.read_settings(&[AutoPowerOn], now).unwrap();
    to_first_get(&mut s, &mut now);
    let mut err = FIXTURE;
    err[18] = 0x02;
    err[9] = 0x10;
    s.handle_input(&err, now);
    let ev = drain_events(&mut s);
    assert!(
        matches!(&ev[..], [Event::Failed { error: Error::Printer(e), resume_from_page: None }] if e.info2 == 0x10),
        "{ev:?}"
    );
    assert_eq!(s.poll_transmit(), Some(SETTINGS_READ_EPILOGUE.to_vec()));
    assert_eq!(s.state(), SessionState::Ready);
}

#[test]
fn turned_off_during_collect_is_fatal() {
    let (mut s, mut now) = ready_session();
    s.read_settings(&[AutoPowerOn], now).unwrap();
    to_first_get(&mut s, &mut now);
    let mut off = FIXTURE;
    off[18] = 0x04;
    s.handle_input(&off, now);
    assert_eq!(
        drain_events(&mut s),
        vec![Event::Failed {
            error: Error::PrinterOff,
            resume_from_page: None
        }]
    );
    assert_eq!(s.state(), SessionState::Failed);
}

#[test]
fn short_reply_times_out_and_sends_epilogue() {
    let (mut s, mut now) = ready_session();
    s.read_settings(&[AutoPowerOn], now).unwrap();
    to_first_get(&mut s, &mut now);
    s.handle_input(&f0(0x01)[..20], now);
    assert!(drain_events(&mut s).is_empty());
    now = s.poll_timeout().unwrap();
    s.handle_timeout(now);
    assert_eq!(
        drain_events(&mut s),
        vec![Event::Failed {
            error: Error::Timeout(TimeoutKind::SettingsReply),
            resume_from_page: None
        }]
    );
    assert_eq!(s.poll_transmit(), Some(SETTINGS_READ_EPILOGUE.to_vec()));
    assert_eq!(s.state(), SessionState::Ready);
}

/// A Ready PT-P910BT session (3-byte Auto Power Off replies).
fn ready_p910() -> (Session, u64) {
    let p = model(Model::PtP910bt);
    let mut s = Session::new(Some(p), SessionConfig::default());
    let mut now = 0;
    s.connect(now);
    while s.poll_transmit().is_some() {}
    now += 100;
    s.handle_timeout(now);
    while s.poll_transmit().is_some() {}
    let vp = VirtualPrinter::new(p, tape(p), Behaviour::Normal);
    s.handle_input(&vp.idle_status(), now);
    assert_eq!(s.state(), SessionState::Ready);
    while s.poll_event().is_some() {}
    (s, now)
}

#[test]
fn len_value_reply_validation() {
    let (mut s, mut now) = ready_p910();
    s.read_settings(&[AutoPowerOff], now).unwrap();
    to_first_get(&mut s, &mut now);
    s.handle_input(&[0x01], now);
    s.handle_input(&[0x00, 0x30, 0xEE], now);
    let ev = drain_events(&mut s);
    assert!(
        matches!(&ev[..], [Event::SettingsRead(r)] if r[0].reading == v(Minutes(480)) && r[0].raw == [0x01, 0x00, 0x30]),
        "{ev:?}"
    );

    // An unsolicited status frame where 3 bytes are expected is skipped (split anywhere),
    // and the reply after it is still read.
    let (mut s, mut now) = ready_p910();
    s.read_settings(&[AutoPowerOff], now).unwrap();
    to_first_get(&mut s, &mut now);
    s.handle_input(&FIXTURE[..2], now);
    assert!(drain_events(&mut s).is_empty());
    let mut rest = FIXTURE[2..].to_vec();
    rest.extend_from_slice(&[0x01, 0x00]);
    s.handle_input(&rest, now);
    assert!(drain_events(&mut s).is_empty());
    assert_eq!(s.state(), SessionState::Settings);
    s.handle_input(&[0x03], now);
    let ev = drain_events(&mut s);
    assert!(
        matches!(&ev[..], [Event::SettingsRead(r)] if r[0].reading == v(Minutes(30))),
        "{ev:?}"
    );
}

/// Regression: Brother's definition gives only the reply length and the value offset 2 for
/// `ESC i U A` on the P900W family / P910BT, so bytes 0-1 are not checked.
#[test]
fn len_value_reply_prefix_is_not_checked() {
    for prefix in [[0x00, 0x00], [0x03, 0x00], [0x01, 0x00]] {
        let (mut s, mut now) = ready_p910();
        s.read_settings(&[AutoPowerOff], now).unwrap();
        to_first_get(&mut s, &mut now);
        s.handle_input(&[prefix[0], prefix[1], 0x03], now);
        let ev = drain_events(&mut s);
        assert!(
            matches!(&ev[..], [Event::SettingsRead(r)]
                if r[0].reading == v(Minutes(30)) && r[0].raw == [prefix[0], prefix[1], 0x03]),
            "{prefix:02X?}: {ev:?}"
        );
    }
    let spec = setting_spec(model(Model::PtP900w), AutoPowerOff).unwrap();
    assert_eq!(spec.decode_reply(&[0x00, 0x00, 0x03]), Ok(v(Minutes(30))));
}

/// Regression: a "turned off" or error status frame while a 3-byte reply is expected ends the
/// transaction like on the 32-byte path (PrinterOff → Failed).
#[test]
fn len_value_turned_off_and_error_frames() {
    let off_frame = |m: Model| {
        let p = model(m);
        let mut f = VirtualPrinter::new(p, tape(p), Behaviour::Normal).idle_status();
        f[18] = 0x04;
        f
    };
    for m in [Model::PtP910bt, Model::PtP900w] {
        let p = model(m);
        let mut s = Session::new(Some(p), SessionConfig::default());
        let mut now = 0;
        s.connect(now);
        while s.poll_transmit().is_some() {}
        now += 100;
        s.handle_timeout(now);
        while s.poll_transmit().is_some() {}
        s.handle_input(
            &VirtualPrinter::new(p, tape(p), Behaviour::Normal).idle_status(),
            now,
        );
        assert_eq!(s.state(), SessionState::Ready);
        drain_events(&mut s);
        s.read_settings(&[AutoPowerOff], now).unwrap();
        to_first_get(&mut s, &mut now);
        let off = off_frame(m);
        s.handle_input(&off[..10], now);
        s.handle_input(&off[10..], now);
        assert_eq!(
            drain_events(&mut s),
            vec![Event::Failed {
                error: Error::PrinterOff,
                resume_from_page: None
            }],
            "{m:?}"
        );
        assert_eq!(s.state(), SessionState::Failed, "{m:?}");
    }

    let (mut s, mut now) = ready_p910();
    s.read_settings(&[AutoPowerOff], now).unwrap();
    to_first_get(&mut s, &mut now);
    let mut err = off_frame(Model::PtP910bt);
    err[18] = 0x02;
    err[9] = 0x10;
    s.handle_input(&err, now);
    let ev = drain_events(&mut s);
    assert!(
        matches!(&ev[..], [Event::Failed { error: Error::Printer(e), resume_from_page: None }] if e.info2 == 0x10),
        "{ev:?}"
    );
    assert_eq!(s.poll_transmit(), Some(SETTINGS_READ_EPILOGUE.to_vec()));
    assert_eq!(s.state(), SessionState::Ready);
}

/// Advances timeouts up to `until` (inclusive), collecting what is sent.
fn advance_to(s: &mut Session, now: &mut u64, until: u64) -> Vec<Vec<u8>> {
    let mut sent = Vec::new();
    while let Some(d) = s.poll_timeout().filter(|d| *d <= until) {
        *now = d;
        s.handle_timeout(*now);
        while let Some(b) = s.poll_transmit() {
            sent.push(b);
        }
    }
    *now = until;
    sent
}

/// Times out a read of Auto Power Off; returns the time of the failure.
fn time_out_a_read(s: &mut Session, now: &mut u64) -> u64 {
    s.read_settings(&[AutoPowerOff], *now).unwrap();
    to_first_get(s, now);
    *now = s.poll_timeout().unwrap();
    s.handle_timeout(*now);
    assert_eq!(
        drain_events(s),
        vec![Event::Failed {
            error: Error::Timeout(TimeoutKind::SettingsReply),
            resume_from_page: None
        }]
    );
    while s.poll_transmit().is_some() {}
    *now
}

/// Regression: a late reply to a timed-out get must not be taken as the reply to the next
/// transaction's get (a settings reply carries no id).
#[test]
fn late_reply_after_timeout_is_not_taken_for_the_next_read() {
    let (mut s, mut now) = ready_session();
    let failed_at = time_out_a_read(&mut s, &mut now);
    s.read_settings(&[AutoPowerOn], now).unwrap();
    let sent = advance_to(&mut s, &mut now, failed_at + 200);
    assert!(
        !sent.contains(&GET_ON.to_vec()),
        "no get while a late reply may still arrive: {sent:02X?}"
    );
    // The late Auto Power Off reply ("10 min" = 01) arrives.
    s.handle_input(&f0(0x01), now);
    assert!(drain_events(&mut s).is_empty());
    let sent = to_first_get(&mut s, &mut now);
    assert_eq!(sent.last(), Some(&GET_ON.to_vec()));
    assert!(now >= failed_at + SessionConfig::default().settings_reply_timeout_ms);
    s.handle_input(&f0(0x00), now);
    let ev = drain_events(&mut s);
    assert!(
        matches!(&ev[..], [Event::SettingsRead(r)] if r[0].id == AutoPowerOn && r[0].reading == v(Enabled(false))),
        "{ev:?}"
    );
}

/// Regression: the same late reply must not verify a write's read-back.
#[test]
fn late_reply_after_timeout_does_not_verify_a_write() {
    let (mut s, mut now) = ready_session();
    let failed_at = time_out_a_read(&mut s, &mut now);
    s.write_settings(&[(AutoPowerOff, Minutes(10))], now)
        .unwrap();
    let sent = advance_to(&mut s, &mut now, failed_at + 750);
    assert!(!sent.contains(&GET_OFF_00.to_vec()), "{sent:02X?}");
    s.handle_input(&f0(0x01), now);
    assert!(drain_events(&mut s).is_empty());
    // Run on to the read-back get; the printer then still reports 30 min.
    let mut sent = Vec::new();
    while !sent.contains(&GET_OFF_00.to_vec()) {
        now = s.poll_timeout().expect("transaction running");
        s.handle_timeout(now);
        while let Some(b) = s.poll_transmit() {
            sent.push(b);
        }
    }
    assert!(sent.contains(&vec![0x1B, 0x69, 0x55, 0x41, 0x00, 0x00, 0x01]));
    s.handle_input(&f0(0x03), now);
    let ev = drain_events(&mut s);
    assert!(
        matches!(&ev[..], [Event::SettingsWritten { verified: false, report }] if report[0].reading == v(Minutes(30))),
        "{ev:?}"
    );
}

/// Regression: Brother always follows sets with `ESC ~ S`; a cancel after a set went out
/// still sends it (and not a second time once the write epilogue went out).
#[test]
fn cancel_after_a_set_still_sends_the_commit() {
    let set = vec![0x1B, 0x69, 0x55, 0x41, 0x00, 0x00, 0x01];
    let mut h = Harness::new(printer(Model::PtP710bt, Behaviour::Normal));
    h.connect();
    h.s.write_settings(&[(AutoPowerOff, Minutes(10))], h.now)
        .unwrap();
    while !h.sent.contains(&set) {
        assert!(h.step());
    }
    assert_eq!(h.vp.commits(), 0);
    h.sent.clear();
    h.s.cancel(h.now);
    h.pump();
    assert_eq!(h.sent, vec![SETTINGS_WRITE_EPILOGUE.to_vec()]);
    assert_eq!(h.vp.commits(), 1);
    assert_eq!(
        h.events.last(),
        Some(&Event::Failed {
            error: Error::Cancelled,
            resume_from_page: None
        })
    );
    assert_eq!(h.s.state(), SessionState::Ready);

    // Cancel during the settle, after the write epilogue went out: no second commit.
    let mut h = Harness::new(printer(Model::PtP710bt, Behaviour::Normal));
    h.connect();
    h.s.write_settings(&[(AutoPowerOff, Minutes(10))], h.now)
        .unwrap();
    while !h.sent.contains(&SETTINGS_WRITE_EPILOGUE.to_vec()) {
        assert!(h.step());
    }
    h.sent.clear();
    h.s.cancel(h.now);
    h.pump();
    assert_eq!(h.sent, vec![SETTINGS_READ_EPILOGUE.to_vec()]);
    assert_eq!(h.vp.commits(), 1);

    // Reconnect after a set: the commit goes out before the handshake.
    let mut h = Harness::new(printer(Model::PtP710bt, Behaviour::Normal));
    h.connect();
    h.s.write_settings(&[(AutoPowerOff, Minutes(10))], h.now)
        .unwrap();
    while !h.sent.contains(&set) {
        assert!(h.step());
    }
    h.s.connect(h.now);
    assert_eq!(h.s.poll_transmit(), Some(SETTINGS_WRITE_EPILOGUE.to_vec()));
}

#[test]
fn late_settings_reply_is_not_a_status() {
    let (mut s, now) = ready_session();
    s.handle_input(&f0(0x01), now);
    assert!(drain_events(&mut s).is_empty());
    assert_eq!(s.last_status().map(|st| st.raw), Some(FIXTURE));
    s.request_status(now).unwrap();
    s.handle_input(&f0(0x01), now);
    assert_eq!(s.state(), SessionState::Ready);
    assert!(
        s.poll_timeout().is_some(),
        "still waiting for the real reply"
    );
}

// ---------------------------------------------------------------------------------------------
// Virtual printer details
// ---------------------------------------------------------------------------------------------

#[test]
fn virtual_printer_rejects_unlisted_and_unsupported() {
    let mut vp = printer(Model::PtP710bt, Behaviour::Normal);
    vp.handle_input(&[0x1B, 0x69, 0x55, 0x41, 0x00, 0x00, 0x07], 0);
    assert_eq!(
        vp.violations(),
        &[Violation::InvalidSettingValue {
            offset: 0,
            byte: 0x07
        }]
    );
    assert_eq!(vp.setting_byte(0x41, Some(0x00)), Some(0x03));
    // Unknown selector.
    vp.handle_input(&[0x1B, 0x69, 0x55, 0x41, 0x01, 0x02], 0);
    assert!(matches!(
        vp.violations().last(),
        Some(Violation::UnsupportedCommand { offset: 7, .. })
    ));
    assert_eq!(vp.next_output_at(), None);

    let mut e560 = printer(Model::PtE560bt, Behaviour::Normal);
    e560.handle_input(&GET_ON, 0);
    assert!(matches!(
        e560.violations(),
        [Violation::UnsupportedCommand { .. }]
    ));
    assert_eq!(e560.poll_output(u64::MAX), None, "silent");
    assert_eq!(e560.setting_byte(0x70, None), None);
}

#[test]
fn virtual_printer_reply_formats() {
    let mut vp = printer(Model::PtP900w, Behaviour::Normal).with_setting(0x41, Some(0x00), 0x0A);
    vp.handle_input(&GET_OFF_00, 0);
    vp.handle_input(&GET_ON, 0);
    let delay = vp.timing().reply_delay_ms;
    assert_eq!(vp.poll_output(delay - 1), None);
    assert_eq!(vp.poll_output(delay), Some(vec![0x01, 0x00, 0x0A]));
    let frame = vp.poll_output(delay).unwrap();
    assert_eq!(frame.len(), 32);
    assert_eq!((frame[18], frame[30]), (0xF0, 0x00));
    assert_eq!(frame[..3], [0x80, 0x20, 0x42]);
}

// ---------------------------------------------------------------------------------------------
// Tables and safety (D9)
// ---------------------------------------------------------------------------------------------

#[test]
fn table_models_and_labels() {
    let labels = |m: Model| -> Vec<&'static str> {
        settings_for(model(m))
            .iter()
            .map(|s| s.brother_label)
            .collect()
    };
    // P710BT timers: named as in the printer's information report (Brother's Mac tool labels
    // are reversed on this model, PROTOCOL.md §8 #34).
    assert_eq!(
        labels(Model::PtP710bt),
        ["Auto Power On", "AutoPowerOff(adp)", "AutoPowerOff(Bat)"]
    );
    assert_eq!(labels(Model::PtP715ebt), labels(Model::PtP710bt));
    assert_eq!(
        labels(Model::PtP950nw),
        [
            "Auto Power On",
            "Auto Power Off (AC/DC)",
            "Auto Power Off (Li-ion)"
        ]
    );
    assert_eq!(
        labels(Model::PtP910bt),
        [
            "Auto Power On",
            "Auto Power Off (USB Connection)",
            "Auto Power Off (Li-ion)"
        ]
    );
    // The PT-P715eBT shares the P710BT profile (mapping INFERRED from the P710BT).
    let spec = setting_spec(model(Model::PtP715ebt), AutoPowerOffBattery).unwrap();
    assert_eq!(spec.get, GET_OFF_01);
    let spec = setting_spec(model(Model::PtP715ebt), AutoPowerOff).unwrap();
    assert_eq!(spec.get, GET_OFF_00);
    assert_eq!(spec.reply, ReplyFormat::StatusF0);
    assert!(setting_spec(model(Model::PtE560bt), AutoPowerOn).is_none());
}

#[test]
fn never_send_list_matches_protocol() {
    // PROTOCOL.md §3.6.6.
    for bad in [
        &[0x1B, 0x69, 0x55, 0x58][..],
        &[0x1B, 0x69, 0x55, 0x69],
        &[0x1B, 0x69, 0x55, 0x5A],
        &[0x1B, 0x69, 0x55, 0x4E],
        &[0x1B, 0x69, 0x55, 0x78],
        &[0x1B, 0x7E, 0x63],
        &[0x1B, 0x7E, 0x52],
        &[0x54, 0x0C],
        &[0x1B, 0x69, 0x61, 0xFA],
        &[0x1B, 0x69, 0x11, 0x43, 0x42],
    ] {
        assert!(NEVER_SEND.contains(&bad), "{bad:02X?}");
    }
    // Every byte string of the §3.6.6 table is caught (`<ii> <v>` filled in).
    for seq in [
        &[0x1B, 0x69, 0x55, 0x58][..],
        &[0x1B, 0x69, 0x55, 0x4E],
        &[0x1B, 0x7E, 0x63, 0x01, 0x00],
        &[0x54, 0x0C, 0x05],
        &[0x1B, 0x69, 0x61, 0xFA, 0x54, 0x07, 0x05, 0x00],
        &[
            0x1B, 0x69, 0x21, 0x01, 0x1B, 0x69, 0x11, 0x43, 0x42, 0x01, 0x02, 0x00, 0x20, 0x80,
        ],
        &[0x1B, 0x69, 0x55, 0x78],
        &[0x1B, 0x7E, 0x52],
    ] {
        assert!(contains_never_send(seq), "{seq:02X?}");
    }
    for p in profiles() {
        for s in settings_for(p) {
            for bytes in [s.get, s.set_prefix] {
                for bad in NEVER_SEND {
                    assert!(!bytes.starts_with(bad), "{:?} {:?}", p.model, s.id);
                }
                assert!(!contains_never_send(bytes));
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

fn any_spec() -> impl Strategy<Value = &'static ptouch::SettingSpec> {
    let all: Vec<&'static ptouch::SettingSpec> = [Model::PtP710bt, Model::PtP900w, Model::PtP910bt]
        .into_iter()
        .flat_map(|m| settings_for(model(m)).iter())
        .collect();
    proptest::sample::select(all)
}

proptest! {
    #[test]
    fn decode_never_panics(spec in any_spec(), bytes in proptest::collection::vec(any::<u8>(), 0..40)) {
        let _ = spec.decode_reply(&bytes);
    }

    #[test]
    fn every_byte_decodes_to_listed_or_unlisted(spec in any_spec(), byte in any::<u8>()) {
        let reply = match spec.reply {
            ReplyFormat::StatusF0 => f0(byte).to_vec(),
            ReplyFormat::LenValue => vec![0x01, 0x00, byte],
            _ => unreachable!(),
        };
        let reading = spec.decode_reply(&reply).unwrap();
        match spec.value_for(byte) {
            Some(val) => {
                prop_assert_eq!(reading, SettingReading::Value(val));
                let w = spec.encode_write(val).unwrap();
                prop_assert_eq!(&w[..w.len() - 1], spec.set_prefix);
                prop_assert_eq!(w.last().copied(), Some(byte));
            }
            None => prop_assert_eq!(reading, SettingReading::Unlisted(byte)),
        }
    }

    #[test]
    fn unlisted_minutes_are_never_encoded(spec in any_spec(), minutes in any::<u16>()) {
        let val = Minutes(minutes);
        prop_assert_eq!(spec.encode_write(val).is_ok(), spec.byte_for(val).is_some());
    }

    #[test]
    fn session_never_panics_on_arbitrary_settings_input(
        chunks in proptest::collection::vec(proptest::collection::vec(any::<u8>(), 0..70), 0..12),
        p910 in any::<bool>(),
    ) {
        let (mut s, mut now) = if p910 { ready_p910() } else { ready_session() };
        s.read_settings(&SettingId::ALL, now).unwrap();
        for (i, mut chunk) in chunks.into_iter().enumerate() {
            if i % 2 == 0 {
                chunk.splice(0..0, [0x80, 0x20, 0x42]);
            }
            now += 37;
            s.handle_input(&chunk, now);
            s.handle_timeout(now);
            while s.poll_transmit().is_some() {}
        }
        // Whatever happened, the transaction ends within the reply timeouts.
        let mut ended = false;
        for _ in 0..64 {
            match s.poll_timeout() {
                Some(d) => { now = now.max(d); s.handle_timeout(now); }
                None => { ended = true; break; }
            }
        }
        prop_assert!(ended);
        prop_assert!(matches!(s.state(), SessionState::Ready | SessionState::Failed));
        let events: Vec<Event> = std::iter::from_fn(|| s.poll_event()).collect();
        let finished = events
            .iter()
            .any(|e| matches!(e, Event::SettingsRead(_) | Event::Failed { .. }));
        prop_assert!(finished, "no final event in {:?}", events);
    }
}

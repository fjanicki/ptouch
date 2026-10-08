//! WP2 status parsing and framing tests (PROTOCOL.md §2.1 "Reads", §4; ARCHITECTURE.md §8.1).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use proptest::prelude::*;
use ptouch::model::BatteryFormat;
use ptouch::status::{Battery, ExtendedError, PowerSource};
use ptouch::{
    Error, MediaType, Notification, Phase, PrinterError, PrinterErrors, STATUS_LEN, Status,
    StatusFramer, StatusType, TapeColor, TextColor, parse_status, profile_by_codes,
};

const FIXTURE_HEX: &str = include_str!("fixtures/status/p710bt_24mm_laminated_idle.hex");
const COMPLETION_HEX: &str = include_str!("fixtures/status/synthetic_p710bt_print_sequence.hex");

fn parse_hex(s: &str) -> Vec<u8> {
    s.split_whitespace()
        .map(|t| u8::from_str_radix(t, 16).expect("hex byte"))
        .collect()
}

fn fixture() -> [u8; STATUS_LEN] {
    parse_hex(FIXTURE_HEX).try_into().expect("32 bytes")
}

/// The fixture with some bytes replaced.
fn with(edits: &[(usize, u8)]) -> [u8; STATUS_LEN] {
    let mut f = fixture();
    for &(i, b) in edits {
        f[i] = b;
    }
    f
}

fn parse(bytes: &[u8]) -> Status {
    parse_status(bytes).expect("valid frame")
}

// ---------------------------------------------------------------------------------------------
// Real fixture
// ---------------------------------------------------------------------------------------------

#[test]
fn fixture_parses_as_documented() {
    let bytes = fixture();
    let s = parse(&bytes);
    assert_eq!(s.series_code, 0x30);
    assert_eq!(s.model_code, 0x76);
    assert_eq!(s.country_code, 0x30);
    assert_eq!(s.battery_raw, 0x00);
    assert!(s.errors.is_empty());
    assert_eq!(s.errors, PrinterErrors::default());
    assert_eq!(s.media_width_mm, 24);
    assert_eq!(s.media_type, MediaType::Laminated);
    assert_eq!(s.colors, 0);
    assert_eq!(s.mode, 0);
    assert_eq!(s.media_length_mm, 0);
    assert_eq!(s.status_type, StatusType::Reply);
    assert_eq!(s.phase, Phase::Receiving(0));
    assert_eq!(s.notification, Notification::None);
    assert_eq!(s.tape_color, TapeColor::White);
    assert_eq!(s.text_color, TextColor::Black);
    assert_eq!(s.raw, bytes);
    assert_eq!(s.to_bytes(), bytes);

    assert!(!s.is_error());
    assert!(s.is_ready());
    assert!(s.has_media());
    assert!(!s.weak_battery());
    assert!(!s.is_turned_off());
    assert_eq!(s.errors.headline(), None);
    assert_eq!(s.errors.iter().count(), 0);
}

#[test]
fn fixture_identifies_p710bt_and_its_battery_format() {
    let s = parse(&fixture());
    let profile = profile_by_codes(s.series_code, s.model_code).expect("known model");
    assert_eq!(profile.name, "PT-P710BT");
    assert_eq!(profile.battery_format, Some(BatteryFormat::Reserved));
    assert_eq!(s.battery(profile.battery_format), Battery::Unknown);
}

#[test]
fn fixture_display() {
    let s = parse(&fixture());
    assert_eq!(
        s.to_string(),
        "model 0x30/0x76: 24 mm laminated tape, black on white; status reply, receiving (ready); \
         no errors"
    );
    let err = parse(&with(&[(8, 0x01), (9, 0x10), (11, 0x00), (10, 0)]));
    assert_eq!(
        err.to_string(),
        "model 0x30/0x76: no tape; status reply, receiving (ready); errors: no tape cassette, \
         cover open"
    );
    let cooling = parse(&with(&[(18, 0x05), (22, 0x03), (19, 0x01)]));
    assert_eq!(
        cooling.to_string(),
        "model 0x30/0x76: 24 mm laminated tape, black on white; notification, printing, \
         notification: cooling started; no errors"
    );
    let fle = parse(&with(&[(10, 21), (11, 0x13), (17, 45)]));
    assert!(fle.to_string().contains("21 mm FLe tape (45 mm labels)"));
}

#[test]
fn try_from_slice() {
    let bytes = fixture();
    let s = Status::try_from(&bytes[..]).unwrap();
    assert_eq!(s, parse(&bytes));
}

// ---------------------------------------------------------------------------------------------
// Header / length validation
// ---------------------------------------------------------------------------------------------

#[test]
fn wrong_length_is_rejected() {
    let bytes = fixture();
    for len in [0, 1, 3, 31, 33, 64] {
        let mut v = bytes.to_vec();
        v.resize(len, 0);
        assert_eq!(parse_status(&v), Err(Error::StatusLength { got: len }));
    }
}

#[test]
fn wrong_header_is_rejected() {
    let bad = with(&[(2, 0x43)]);
    assert_eq!(
        parse_status(&bad),
        Err(Error::StatusHeader {
            got: [0x80, 0x20, 0x43, 0x30]
        })
    );
    for (i, b) in [(0, 0x81), (1, 0x21), (2, 0x00)] {
        assert!(matches!(
            parse_status(&with(&[(i, b)])),
            Err(Error::StatusHeader { .. })
        ));
    }
    // Series / model are not validated here (that is the session's job).
    assert!(parse_status(&with(&[(3, 0x41), (4, 0x00)])).is_ok());
}

// ---------------------------------------------------------------------------------------------
// st[18] status type
// ---------------------------------------------------------------------------------------------

#[test]
fn every_status_type() {
    let cases = [
        (0x00, StatusType::Reply, false),
        (0x01, StatusType::PrintingCompleted, false),
        (0x02, StatusType::Error, true),
        (0x03, StatusType::ExitIfMode, false),
        (0x04, StatusType::TurnedOff, false),
        (0x05, StatusType::Notification, false),
        (0x06, StatusType::PhaseChange, false),
        (0x07, StatusType::Other(0x07), false),
        (0x18, StatusType::Other(0x18), true),
        (0x21, StatusType::Other(0x21), false),
        (0xFF, StatusType::Other(0xFF), false),
    ];
    for (byte, ty, error) in cases {
        let s = parse(&with(&[(18, byte)]));
        assert_eq!(s.status_type, ty, "st[18] = {byte:02X}");
        assert_eq!(ty.is_error(), error);
        assert_eq!(s.is_error(), error, "st[18] = {byte:02X}");
        assert_eq!(s.is_ready(), !error, "st[18] = {byte:02X}");
        assert_eq!(s.is_turned_off(), byte == 0x04);
        assert_eq!(s.to_bytes()[18], byte);
    }
}

#[test]
fn status_type_round_trips_every_byte() {
    for b in 0..=u8::MAX {
        assert_eq!(StatusType::from_byte(b).to_byte(), b);
    }
}

// ---------------------------------------------------------------------------------------------
// st[19..22] phase
// ---------------------------------------------------------------------------------------------

#[test]
fn phases() {
    let cases = [
        ((0x00, 0x00, 0x00), Phase::Receiving(0), true, false),
        ((0x00, 0x00, 0x01), Phase::Receiving(1), false, false),
        ((0x01, 0x00, 0x00), Phase::Printing(0), false, false),
        ((0x01, 0x00, 0x0A), Phase::Printing(0x000A), false, false),
        ((0x01, 0x00, 0x14), Phase::Printing(0x0014), false, true),
        ((0x01, 0x00, 0x19), Phase::Printing(0x0019), false, false),
        // Big-endian: hi byte first.
        ((0x00, 0x01, 0x00), Phase::Receiving(0x0100), false, false),
        ((0x01, 0x14, 0x00), Phase::Printing(0x1400), false, false),
        (
            (0x02, 0x12, 0x34),
            Phase::Other {
                kind: 2,
                number: 0x1234,
            },
            false,
            false,
        ),
    ];
    for ((kind, hi, lo), phase, ready, error) in cases {
        let s = parse(&with(&[(19, kind), (20, hi), (21, lo)]));
        assert_eq!(s.phase, phase);
        assert_eq!(phase.to_bytes(), (kind, hi, lo));
        assert_eq!(s.is_ready(), ready, "{phase:?}");
        assert_eq!(s.is_error(), error, "{phase:?}");
    }
}

#[test]
fn phase_round_trips() {
    for kind in 0..=u8::MAX {
        for (hi, lo) in [(0, 0), (0, 1), (0, 0x14), (0x12, 0x34), (0xFF, 0xFF)] {
            assert_eq!(Phase::from_bytes(kind, hi, lo).to_bytes(), (kind, hi, lo));
        }
    }
}

#[test]
fn phase_display() {
    assert_eq!(Phase::Receiving(0).to_string(), "receiving (ready)");
    assert_eq!(Phase::Receiving(1).to_string(), "receiving (feeding)");
    assert_eq!(Phase::Printing(0).to_string(), "printing");
    assert_eq!(
        Phase::Printing(0x14).to_string(),
        "printing (cover open while receiving)"
    );
    assert_eq!(
        Phase::Other {
            kind: 7,
            number: 0x0102
        }
        .to_string(),
        "phase 0x07 (0x0102)"
    );
}

// ---------------------------------------------------------------------------------------------
// st[22] notification
// ---------------------------------------------------------------------------------------------

#[test]
fn every_notification() {
    let cases = [
        (0x00, Notification::None),
        (0x01, Notification::CoverOpen),
        (0x02, Notification::CoverClosed),
        (0x03, Notification::CoolingStarted),
        (0x04, Notification::CoolingFinished),
        (0x05, Notification::WaitingForPeeling),
        (0x06, Notification::Other(0x06)),
        (0x07, Notification::Paused),
        (0x0B, Notification::WaitingForCut),
        (0x0C, Notification::CutWaitFinished),
        (0x0D, Notification::Other(0x0D)),
    ];
    for (byte, n) in cases {
        let s = parse(&with(&[(18, 0x05), (22, byte)]));
        assert_eq!(s.status_type, StatusType::Notification);
        assert_eq!(s.notification, n);
        // Cover open is the only notification that is an error for the session.
        assert_eq!(s.is_error(), n == Notification::CoverOpen, "{n:?}");
    }
    for b in 0..=u8::MAX {
        assert_eq!(Notification::from_byte(b).to_byte(), b);
    }
}

// ---------------------------------------------------------------------------------------------
// st[7], st[8], st[9] errors
// ---------------------------------------------------------------------------------------------

const INFO1: [PrinterError; 8] = [
    PrinterError::NoMedia,
    PrinterError::EndOfMedia,
    PrinterError::CutterJam,
    PrinterError::WeakBatteries,
    PrinterError::PrinterInUse,
    PrinterError::PowerTurnedOff,
    PrinterError::HighVoltageAdapter,
    PrinterError::SystemErrorInfo1,
];

const INFO2: [PrinterError; 8] = [
    PrinterError::WrongMedia,
    PrinterError::ExpansionBufferFull,
    PrinterError::CommunicationError,
    PrinterError::CommunicationBufferFull,
    PrinterError::CoverOpen,
    PrinterError::Overheating,
    PrinterError::BlackMarkNotDetected,
    PrinterError::SystemErrorInfo2,
];

const EXTENDED: [(u8, ExtendedError); 13] = [
    (0x10, ExtendedError::FleTapeEnd),
    (0x14, ExtendedError::TubeRibbonNotLoaded),
    (0x1D, ExtendedError::ResolutionUnavailable),
    (0x1E, ExtendedError::AdapterChangedWhilePrinting),
    (0x1F, ExtendedError::BatteryChargeFailed),
    (0x20, ExtendedError::TubeNotInserted),
    (0x21, ExtendedError::IncompatibleMedia),
    (0x22, ExtendedError::TubeCutterFailure),
    (0x23, ExtendedError::NoTwoColorSupport),
    (0x24, ExtendedError::NoMonochromeSupport),
    (0x26, ExtendedError::TransportMotorSlow),
    (0x27, ExtendedError::UnsupportedPowerSource),
    (0x28, ExtendedError::UnsupportedOption),
];

fn assert_single_error(s: &Status, expected: PrinterError) {
    let all: Vec<_> = s.errors.iter().collect();
    assert_eq!(all, vec![expected]);
    assert_eq!(s.errors.headline(), Some(expected));
    assert!(s.errors.contains(expected));
    assert!(!s.errors.is_empty());
    assert!(s.is_error());
    assert!(!s.is_ready());
    assert!(!expected.message().is_empty());
}

#[test]
fn every_info1_bit() {
    for (bit, &expected) in INFO1.iter().enumerate() {
        let mask = 1u8 << bit;
        let s = parse(&with(&[(8, mask)]));
        assert_eq!(s.errors.info1, mask);
        assert_single_error(&s, expected);
        assert_eq!(expected.location(), (8, mask));
        assert_eq!(s.weak_battery(), mask == 0x08);
    }
}

#[test]
fn every_info2_bit() {
    for (bit, &expected) in INFO2.iter().enumerate() {
        let mask = 1u8 << bit;
        let s = parse(&with(&[(9, mask)]));
        assert_eq!(s.errors.info2, mask);
        assert_single_error(&s, expected);
        assert_eq!(expected.location(), (9, mask));
        assert!(!s.weak_battery());
    }
}

#[test]
fn every_documented_extended_error() {
    for (byte, ext) in EXTENDED {
        assert_eq!(ExtendedError::from_byte(byte), ext);
        assert_eq!(ext.to_byte(), byte);
        // Reported on a type-00 reply too (PROTOCOL.md §4.2 resolution).
        let s = parse(&with(&[(7, byte)]));
        assert_eq!(s.status_type, StatusType::Reply);
        assert_eq!(s.errors.extended, byte);
        assert_single_error(&s, PrinterError::Extended(ext));
        assert_eq!(PrinterError::Extended(ext).location(), (7, byte));
    }
    let s = parse(&with(&[(7, 0x99)]));
    assert_single_error(&s, PrinterError::Extended(ExtendedError::Other(0x99)));
    assert_eq!(
        PrinterError::Extended(ExtendedError::Other(0x99)).to_string(),
        "unknown extended error 0x99"
    );
}

#[test]
fn extended_error_round_trips() {
    for b in 1..=u8::MAX {
        assert_eq!(ExtendedError::from_byte(b).to_byte(), b);
    }
}

#[test]
fn multi_bit_errors_are_all_reported_in_precedence_order() {
    let s = parse(&with(&[(7, 0x21), (8, 0xFF), (9, 0xFF), (18, 0x02)]));
    let all: Vec<_> = s.errors.iter().collect();
    let mut expected: Vec<_> = INFO1.to_vec();
    expected.extend(INFO2);
    expected.push(PrinterError::Extended(ExtendedError::IncompatibleMedia));
    assert_eq!(all, expected);
    assert_eq!(all.len(), 17);
    assert_eq!(s.errors.into_iter().count(), 17);

    // Headline precedence: byte 8, then 9, then 7.
    let s = parse(&with(&[(7, 0x1D), (8, 0x10), (9, 0x01)]));
    assert_eq!(s.errors.headline(), Some(PrinterError::PrinterInUse));
    assert_eq!(
        s.errors.iter().collect::<Vec<_>>(),
        [
            PrinterError::PrinterInUse,
            PrinterError::WrongMedia,
            PrinterError::Extended(ExtendedError::ResolutionUnavailable)
        ]
    );
    let s = parse(&with(&[(7, 0x1D), (9, 0x30)]));
    assert_eq!(s.errors.headline(), Some(PrinterError::CoverOpen));
    assert_eq!(
        s.errors.iter().collect::<Vec<_>>(),
        [
            PrinterError::CoverOpen,
            PrinterError::Overheating,
            PrinterError::Extended(ExtendedError::ResolutionUnavailable)
        ]
    );
    // Combined values are never compared with `==`: bit 0x01 plus 0x04 gives both.
    let s = parse(&with(&[(8, 0x05)]));
    assert_eq!(
        s.errors.iter().collect::<Vec<_>>(),
        [PrinterError::NoMedia, PrinterError::CutterJam]
    );
    assert_eq!(s.errors.to_string(), "no tape cassette, cutter jam");
}

#[test]
fn error_iterator_is_fused() {
    let mut it = PrinterErrors::new(0x01, 0, 0).iter();
    assert_eq!(it.next(), Some(PrinterError::NoMedia));
    assert_eq!(it.next(), None);
    assert_eq!(it.next(), None);
}

#[test]
fn printer_errors_display() {
    assert_eq!(PrinterErrors::default().to_string(), "no errors");
    assert_eq!(
        PrinterErrors::new(0, 0x10, 0x21).to_string(),
        "cover open, incompatible or unsupported media"
    );
}

// ---------------------------------------------------------------------------------------------
// st[6] battery
// ---------------------------------------------------------------------------------------------

fn battery(format: Option<BatteryFormat>, byte: u8) -> Battery {
    parse(&with(&[(6, byte)])).battery(format)
}

fn level(source: PowerSource, percent: Option<u8>) -> Battery {
    Battery::Level { source, percent }
}

#[test]
fn battery_legacy() {
    let f = Some(BatteryFormat::Legacy);
    use PowerSource::{Ac, Battery as Bat};
    assert_eq!(battery(f, 0x00), level(Bat, Some(100)));
    assert_eq!(battery(f, 0x01), level(Bat, Some(67)));
    assert_eq!(battery(f, 0x02), level(Bat, Some(33)));
    assert_eq!(battery(f, 0x03), level(Bat, Some(0)));
    assert_eq!(battery(f, 0x04), level(Ac, None));
    assert_eq!(battery(f, 0xFF), Battery::Unknown);
    assert_eq!(battery(f, 0x05), Battery::Unknown);
    assert_eq!(battery(f, 0x20), Battery::Unknown);
}

#[test]
fn battery_level_ac() {
    let f = Some(BatteryFormat::LevelAc);
    use PowerSource::{Ac, Battery as Bat};
    // 20 full, 21/22 half-ish, 23 low, 24 needs charging; (4 - (b & 7)) / 4, clamped at 0.
    let pct = [100, 75, 50, 25, 0, 0, 0];
    for (i, &p) in pct.iter().enumerate() {
        let i = u8::try_from(i).unwrap();
        assert_eq!(
            battery(f, 0x20 + i),
            level(Bat, Some(p)),
            "0x{:02X}",
            0x20 + i
        );
        assert_eq!(
            battery(f, 0x30 + i),
            level(Ac, Some(p)),
            "0x{:02X}",
            0x30 + i
        );
    }
    assert_eq!(battery(f, 0x27), Battery::NoBattery { source: Bat });
    assert_eq!(battery(f, 0x37), Battery::NoBattery { source: Ac });
    assert_eq!(battery(f, 0xFF), Battery::Unknown);
    assert_eq!(battery(f, 0x00), Battery::Unknown);
    assert_eq!(battery(f, 0x04), Battery::Unknown);
    assert_eq!(battery(f, 0x28), Battery::Unknown);
    assert_eq!(battery(f, 0x40), Battery::Unknown);
}

#[test]
fn battery_reserved_none_and_unknown_formats() {
    for b in 0..=u8::MAX {
        assert_eq!(battery(Some(BatteryFormat::Reserved), b), Battery::Unknown);
        assert_eq!(battery(Some(BatteryFormat::None), b), Battery::Unknown);
        assert_eq!(battery(None, b), Battery::Unknown);
    }
}

#[test]
fn battery_display() {
    assert_eq!(Battery::Unknown.to_string(), "unknown");
    assert_eq!(
        level(PowerSource::Battery, Some(75)).to_string(),
        "75% (battery)"
    );
    assert_eq!(
        level(PowerSource::Ac, None).to_string(),
        "level unknown (AC adapter)"
    );
    assert_eq!(
        Battery::NoBattery {
            source: PowerSource::Ac
        }
        .to_string(),
        "no battery (AC adapter)"
    );
}

#[test]
fn weak_battery_is_info1_bit_3_only() {
    assert!(parse(&with(&[(8, 0x08)])).weak_battery());
    assert!(parse(&with(&[(8, 0xFF)])).weak_battery());
    assert!(!parse(&with(&[(8, 0xF7)])).weak_battery());
    assert!(!parse(&with(&[(6, 0x24)])).weak_battery());
}

// ---------------------------------------------------------------------------------------------
// st[10], st[11] media; st[24], st[25] colours
// ---------------------------------------------------------------------------------------------

#[test]
fn media_types() {
    let cases = [
        (0x00, MediaType::None, false),
        (0x01, MediaType::Laminated, true),
        (0x03, MediaType::NonLaminated, true),
        (0x04, MediaType::Fabric, true),
        (0x11, MediaType::HeatShrink21, true),
        (0x12, MediaType::Tube, true),
        (0x13, MediaType::Fle, true),
        (0x14, MediaType::FlexibleId, true),
        (0x15, MediaType::Satin, true),
        (0x16, MediaType::SelfLaminating, true),
        (0x17, MediaType::HeatShrink31, true),
        (0xFF, MediaType::Incompatible, false),
        (0x02, MediaType::Other(0x02), true),
    ];
    for (byte, mt, loaded) in cases {
        let s = parse(&with(&[(11, byte)]));
        assert_eq!(s.media_type, mt);
        assert_eq!(s.has_media(), loaded, "{mt:?}");
    }
    for b in 0..=u8::MAX {
        assert_eq!(MediaType::from_byte(b).to_byte(), b);
    }
    // No tape: width 0, type 00, error bit st[8] 0x01.
    let s = parse(&with(&[(8, 0x01), (10, 0), (11, 0)]));
    assert!(!s.has_media());
    assert_eq!(s.media_width_mm, 0);
    assert_single_error(&s, PrinterError::NoMedia);
}

fn is_css_hex(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

#[test]
fn tape_colours() {
    let documented: &[(u8, TapeColor)] = &[
        (0x01, TapeColor::White),
        (0x02, TapeColor::Other),
        (0x03, TapeColor::Clear),
        (0x04, TapeColor::Red),
        (0x05, TapeColor::Blue),
        (0x06, TapeColor::Yellow),
        (0x07, TapeColor::Green),
        (0x08, TapeColor::Black),
        (0x09, TapeColor::ClearWhiteInk),
        (0x0B, TapeColor::PremiumGold),
        (0x0C, TapeColor::PremiumSilver),
        (0x0D, TapeColor::PremiumOther),
        (0x0E, TapeColor::MaskingOther),
        (0x0F, TapeColor::LightBlueSatin),
        (0x10, TapeColor::MintSatin),
        (0x11, TapeColor::SilverSatin),
        (0x20, TapeColor::MatteWhite),
        (0x21, TapeColor::MatteClear),
        (0x22, TapeColor::MatteSilver),
        (0x23, TapeColor::SatinGold),
        (0x24, TapeColor::SatinSilver),
        (0x25, TapeColor::PastelPurple),
        (0x30, TapeColor::BlueWhiteInk),
        (0x31, TapeColor::RedWhiteInk),
        (0x40, TapeColor::FluorescentOrange),
        (0x41, TapeColor::FluorescentYellow),
        (0x50, TapeColor::BerryPink),
        (0x51, TapeColor::LightGray),
        (0x52, TapeColor::LimeGreen),
        (0x53, TapeColor::NavyBlueSatin),
        (0x54, TapeColor::WineRedSatin),
        (0x60, TapeColor::YellowFabric),
        (0x61, TapeColor::PinkFabric),
        (0x62, TapeColor::BlueFabric),
        (0x70, TapeColor::WhiteHeatShrinkTube),
        (0x71, TapeColor::HeatShrinkTube),
        (0x80, TapeColor::WhiteSelfLaminating),
        (0x90, TapeColor::WhiteFlexibleId),
        (0x91, TapeColor::YellowFlexibleId),
        (0xF0, TapeColor::Cleaning),
        (0xF1, TapeColor::Stencil),
        (0xFF, TapeColor::Incompatible),
    ];
    for &(b, c) in documented {
        assert_eq!(TapeColor::from_byte(b), c);
        assert_eq!(parse(&with(&[(24, b)])).tape_color, c);
    }
    assert_eq!(TapeColor::from_byte(0x00), TapeColor::Unknown(0x00));
    assert_eq!(TapeColor::from_byte(0x0A), TapeColor::Unknown(0x0A));
    assert_eq!(TapeColor::MatteClear.name(), "matte clear");
    assert_eq!(TapeColor::White.css(), "#ffffff");
    assert_eq!(TapeColor::Unknown(0x0A).to_string(), "other (0x0A)");
    for b in 0..=u8::MAX {
        let c = TapeColor::from_byte(b);
        assert_eq!(c.to_byte(), b);
        assert!(!c.name().is_empty());
        assert!(is_css_hex(c.css()), "{c:?} -> {}", c.css());
        assert!(
            matches!(c, TapeColor::Unknown(_)) == !documented.iter().any(|&(d, _)| d == b),
            "{b:02X}"
        );
    }
}

#[test]
fn text_colours() {
    let documented: &[(u8, TextColor)] = &[
        (0x01, TextColor::White),
        (0x02, TextColor::Other),
        (0x04, TextColor::Red),
        (0x05, TextColor::Blue),
        (0x08, TextColor::Black),
        (0x0A, TextColor::Gold),
        (0x62, TextColor::BlueFabric),
        (0x81, TextColor::RedAndBlack),
        (0xF0, TextColor::Cleaning),
        (0xF1, TextColor::Stencil),
        (0xFF, TextColor::Incompatible),
    ];
    for &(b, c) in documented {
        assert_eq!(TextColor::from_byte(b), c);
        assert_eq!(parse(&with(&[(25, b)])).text_color, c);
    }
    assert_eq!(TextColor::Black.css(), "#000000");
    assert_eq!(TextColor::Gold.name(), "gold");
    for b in 0..=u8::MAX {
        let c = TextColor::from_byte(b);
        assert_eq!(c.to_byte(), b);
        assert!(!c.name().is_empty());
        assert!(is_css_hex(c.css()), "{c:?} -> {}", c.css());
        assert!(
            matches!(c, TextColor::Unknown(_)) == !documented.iter().any(|&(d, _)| d == b),
            "{b:02X}"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Re-encoding (for the virtual printer / synthesised frames)
// ---------------------------------------------------------------------------------------------

#[test]
fn to_bytes_reflects_edited_fields() {
    let mut s = parse(&fixture());
    s.status_type = StatusType::PhaseChange;
    s.phase = Phase::Printing(0x0014);
    s.errors = PrinterErrors::new(0x08, 0x10, 0x1D);
    s.media_type = MediaType::HeatShrink21;
    s.media_width_mm = 12;
    s.notification = Notification::CoolingStarted;
    s.tape_color = TapeColor::Yellow;
    s.text_color = TextColor::Red;
    s.battery_raw = 0x33;
    let bytes = s.to_bytes();
    let back = parse(&bytes);
    assert_eq!(back.status_type, s.status_type);
    assert_eq!(back.phase, s.phase);
    assert_eq!(back.errors, s.errors);
    assert_eq!(back.media_type, s.media_type);
    assert_eq!(back.media_width_mm, 12);
    assert_eq!(back.notification, s.notification);
    assert_eq!(back.tape_color, s.tape_color);
    assert_eq!(back.text_color, s.text_color);
    assert_eq!(back.battery_raw, 0x33);
    assert_eq!(&bytes[19..22], &[0x01, 0x00, 0x14]);
    assert_eq!(&bytes[7..10], &[0x1D, 0x08, 0x10]);
}

// ---------------------------------------------------------------------------------------------
// Completion / phase sequences
// ---------------------------------------------------------------------------------------------

/// The frame sequence of a one-page print (§6.8): ready reply, phase change to printing,
/// printing completed, phase change back to receiving.
fn print_sequence() -> Vec<[u8; STATUS_LEN]> {
    vec![
        fixture(),
        with(&[(18, 0x06), (19, 0x01)]),
        with(&[(18, 0x01), (19, 0x01)]),
        with(&[(18, 0x06), (19, 0x00)]),
    ]
}

#[test]
fn completion_sequence_fixture_matches_synthesised_frames() {
    let stream = parse_hex(COMPLETION_HEX);
    let expected: Vec<u8> = print_sequence().concat();
    assert_eq!(stream, expected);
}

#[test]
fn completion_sequence_decodes_in_order() {
    let stream = parse_hex(COMPLETION_HEX);
    for chunk in [1, 5, 7, 31, 32, 33, 64, stream.len()] {
        let mut framer = StatusFramer::new();
        let mut got = Vec::new();
        for c in stream.chunks(chunk) {
            framer.push(c);
            while let Some(r) = framer.next_frame() {
                got.push(r.unwrap());
            }
        }
        let kinds: Vec<_> = got.iter().map(|s| (s.status_type, s.phase)).collect();
        assert_eq!(
            kinds,
            [
                (StatusType::Reply, Phase::Receiving(0)),
                (StatusType::PhaseChange, Phase::Printing(0)),
                (StatusType::PrintingCompleted, Phase::Printing(0)),
                (StatusType::PhaseChange, Phase::Receiving(0)),
            ],
            "chunk size {chunk}"
        );
        assert!(got[0].is_ready());
        assert!(!got[1].is_ready());
        assert!(!got[2].is_ready());
        assert!(got[3].is_ready());
        assert!(got.iter().all(|s| !s.is_error()));
        assert_eq!(framer.discarded_bytes(), 0);
        assert_eq!(framer.pending_bytes(), 0);
    }
}

#[test]
fn error_during_print_sequence() {
    // Cover opened mid-job: phase change to printing, then an error frame (type 02, st[9]
    // 0x10), then the printer returns to receiving with the error still set.
    let frames = [
        with(&[(18, 0x06), (19, 0x01)]),
        with(&[(18, 0x02), (19, 0x01), (9, 0x10)]),
        with(&[(18, 0x06), (19, 0x00), (9, 0x10)]),
    ];
    let mut framer = StatusFramer::new();
    framer.push(&frames.concat());
    let got: Vec<_> = core::iter::from_fn(|| framer.next_frame())
        .map(Result::unwrap)
        .collect();
    assert_eq!(got.len(), 3);
    assert!(!got[0].is_error());
    assert!(got[1].is_error());
    assert_eq!(got[1].errors.headline(), Some(PrinterError::CoverOpen));
    assert!(got[2].is_error());
    assert!(!got[2].is_ready());
}

// ---------------------------------------------------------------------------------------------
// StatusFramer
// ---------------------------------------------------------------------------------------------

fn drain(framer: &mut StatusFramer) -> Vec<Status> {
    let mut out = Vec::new();
    while let Some(r) = framer.next_frame() {
        out.push(r.expect("frame parses"));
    }
    out
}

#[test]
fn framer_split_at_every_offset() {
    let bytes = fixture();
    for split in 1..STATUS_LEN {
        let mut framer = StatusFramer::new();
        framer.push(&bytes[..split]);
        assert!(framer.next_frame().is_none(), "split {split}");
        assert_eq!(framer.pending_bytes(), split);
        framer.push(&bytes[split..]);
        let frames = drain(&mut framer);
        assert_eq!(frames.len(), 1, "split {split}");
        assert_eq!(frames[0].raw, bytes);
        assert_eq!(framer.discarded_bytes(), 0);
        assert_eq!(framer.pending_bytes(), 0);
    }
}

#[test]
fn framer_one_byte_pushes() {
    let bytes = fixture();
    let mut framer = StatusFramer::new();
    let mut frames = Vec::new();
    for b in bytes.iter().chain(bytes.iter()) {
        framer.push(core::slice::from_ref(b));
        frames.extend(drain(&mut framer));
    }
    assert_eq!(frames.len(), 2);
    assert!(frames.iter().all(|s| s.raw == bytes));
}

#[test]
fn framer_two_coalesced_frames() {
    let a = fixture();
    let b = with(&[(18, 0x01)]);
    let mut framer = StatusFramer::new();
    framer.push(&[a, b].concat());
    let frames = drain(&mut framer);
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0].status_type, StatusType::Reply);
    assert_eq!(frames[1].status_type, StatusType::PrintingCompleted);
}

#[test]
fn framer_discards_garbage_prefix() {
    let bytes = fixture();
    // Includes a false `80 20` without `42`, and a lone `80`.
    let garbage = [0x00, 0xFF, 0x80, 0x20, 0x43, 0x80, 0x11, 0x80, 0x20];
    let mut framer = StatusFramer::new();
    framer.push(&garbage);
    // Everything up to the trailing `80 20` (a possible header start) is dropped at once.
    assert_eq!(framer.discarded_bytes(), 7);
    assert_eq!(framer.pending_bytes(), 2);
    assert!(framer.next_frame().is_none());
    framer.push(&bytes);
    let frames = drain(&mut framer);
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].raw, bytes);
    assert_eq!(framer.discarded_bytes(), garbage.len());
}

#[test]
fn framer_garbage_between_frames() {
    let bytes = fixture();
    let mut stream = Vec::new();
    stream.extend_from_slice(&bytes);
    stream.extend_from_slice(&[0x80, 0x20, 0x00, 0x55]);
    stream.extend_from_slice(&bytes);
    stream.extend_from_slice(&[0x42]);
    let mut framer = StatusFramer::new();
    framer.push(&stream);
    assert_eq!(drain(&mut framer).len(), 2);
    assert_eq!(framer.discarded_bytes(), 5);
    assert_eq!(framer.pending_bytes(), 0);
}

#[test]
fn framer_garbage_only_never_accumulates() {
    let mut framer = StatusFramer::new();
    for _ in 0..1000 {
        framer.push(&[0x01, 0x02, 0x03, 0x04]);
    }
    assert!(framer.next_frame().is_none());
    assert_eq!(framer.pending_bytes(), 0);
    assert_eq!(framer.discarded_bytes(), 4000);
}

#[test]
fn framer_buffer_is_bounded() {
    let bytes = fixture();
    let mut framer = StatusFramer::new();
    for _ in 0..1000 {
        framer.push(&bytes);
    }
    assert!(framer.pending_bytes() <= StatusFramer::MAX_PENDING);
    let frames = drain(&mut framer);
    assert_eq!(frames.len(), StatusFramer::MAX_PENDING / STATUS_LEN);
    assert_eq!(
        framer.discarded_bytes(),
        1000 * STATUS_LEN - StatusFramer::MAX_PENDING
    );
}

#[test]
fn framer_clear() {
    let bytes = fixture();
    let mut framer = StatusFramer::new();
    framer.push(&bytes[..10]);
    framer.clear();
    assert_eq!(framer.pending_bytes(), 0);
    framer.push(&bytes);
    assert_eq!(drain(&mut framer).len(), 1);
}

// ---------------------------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------------------------

/// A valid frame: fixture header, arbitrary payload.
fn arb_frame() -> impl Strategy<Value = [u8; STATUS_LEN]> {
    prop::array::uniform32(any::<u8>()).prop_map(|mut f| {
        f[..3].copy_from_slice(&[0x80, 0x20, 0x42]);
        f
    })
}

/// Noise that cannot contain (part of) a header: no `0x80` byte.
fn arb_noise() -> impl Strategy<Value = Vec<u8>> {
    prop::collection::vec(any::<u8>().prop_filter("no 0x80", |&b| b != 0x80), 0..40)
}

proptest! {
    #[test]
    fn parse_status_never_panics_on_32_bytes(bytes in prop::array::uniform32(any::<u8>())) {
        let r = parse_status(&bytes);
        if bytes[..3] == [0x80, 0x20, 0x42] {
            let s = r.unwrap();
            prop_assert_eq!(s.raw, bytes);
            prop_assert_eq!(s.to_bytes(), bytes);
            let _ = s.to_string();
            let _ = s.errors.iter().count();
            for f in [None, Some(BatteryFormat::Legacy), Some(BatteryFormat::LevelAc)] {
                let _ = s.battery(f);
            }
        } else {
            prop_assert!(
                matches!(r, Err(Error::StatusHeader { .. })),
                "expected a StatusHeader error"
            );
        }
    }

    #[test]
    fn parse_status_never_panics_on_any_length(bytes in prop::collection::vec(any::<u8>(), 0..80)) {
        let _ = parse_status(&bytes);
    }

    #[test]
    fn framer_recovers_frames_from_chunked_noisy_stream(
        items in prop::collection::vec((arb_noise(), arb_frame()), 0..8),
        tail in arb_noise(),
        chunks in prop::collection::vec(1usize..50, 1..200),
    ) {
        let mut stream = Vec::new();
        let mut noise_len = tail.len();
        for (noise, frame) in &items {
            stream.extend_from_slice(noise);
            stream.extend_from_slice(frame);
            noise_len += noise.len();
        }
        stream.extend_from_slice(&tail);

        let mut framer = StatusFramer::new();
        let mut got = Vec::new();
        let mut rest = &stream[..];
        let mut sizes = chunks.iter().cycle();
        while !rest.is_empty() {
            let n = (*sizes.next().unwrap()).min(rest.len());
            framer.push(&rest[..n]);
            rest = &rest[n..];
            while let Some(r) = framer.next_frame() {
                got.push(r.unwrap().raw);
            }
        }
        let expected: Vec<_> = items.iter().map(|(_, f)| *f).collect();
        prop_assert_eq!(got, expected);
        prop_assert_eq!(framer.discarded_bytes(), noise_len);
        prop_assert_eq!(framer.pending_bytes(), 0);
    }

    #[test]
    fn framer_never_panics_on_arbitrary_input(
        chunks in prop::collection::vec(prop::collection::vec(any::<u8>(), 0..70), 0..20),
    ) {
        let mut framer = StatusFramer::new();
        let mut total = 0;
        let mut framed = 0;
        for c in &chunks {
            total += c.len();
            framer.push(c);
            while let Some(r) = framer.next_frame() {
                if r.is_ok() {
                    framed += STATUS_LEN;
                }
            }
            prop_assert!(framer.pending_bytes() <= StatusFramer::MAX_PENDING);
        }
        // Every byte is accounted for exactly once.
        prop_assert_eq!(framed + framer.discarded_bytes() + framer.pending_bytes(), total);
    }
}

// Review regressions: truncated frames must not be glued onto the next one.

#[test]
fn framer_resyncs_after_a_truncated_frame() {
    let mut completed = fixture();
    completed[18] = 0x01; // printing completed
    completed[19] = 0x06;
    let mut f = StatusFramer::new();
    f.push(&fixture()[..10]);
    assert!(f.next_frame().is_none());
    f.push(&completed);
    let st = f.next_frame().unwrap().unwrap();
    assert_eq!(st.status_type, ptouch::StatusType::PrintingCompleted);
    assert_eq!(st.raw, completed);
    assert!(f.next_frame().is_none());
    assert_eq!(f.pending_bytes(), 0);
    assert_eq!(f.discarded_bytes(), 10);
}

#[test]
fn framer_resyncs_after_a_header_fragment() {
    let mut f = StatusFramer::new();
    f.push(&[0x80, 0x20, 0x42]);
    f.push(&fixture());
    let st = f.next_frame().unwrap().unwrap();
    assert_eq!((st.series_code, st.model_code), (0x30, 0x76));
    assert!(f.next_frame().is_none());
    assert_eq!(f.pending_bytes(), 0);
}

#[test]
fn framer_waits_for_the_later_frame_when_it_is_split() {
    // The truncated candidate is complete (32 bytes) before the later frame is.
    let mut f = StatusFramer::new();
    f.push(&fixture()[..10]);
    f.push(&fixture()[..22]);
    assert!(f.next_frame().is_none());
    f.push(&fixture()[22..]);
    assert_eq!(f.next_frame().unwrap().unwrap().raw, fixture());
    assert!(f.next_frame().is_none());
}

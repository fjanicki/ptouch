//! Virtual printer: status replies, push frames, raster decoding and violation detection (WP5).

// Test helpers outside `#[test]` fns are not covered by clippy's `allow-*-in-tests`;
// failing loudly is the point of a test.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use proptest::prelude::*;

use ptouch::encode::JobOptions;
use ptouch::virtual_printer::parser::{Command, JobParser, Violation};
use ptouch::virtual_printer::{Behaviour, VirtualPrinter, VirtualTiming, decode_job};
use ptouch::{
    Bitmap, Compression, Error, Model, ModelProfile, Phase, STATUS_LEN, StatusType, TapeKind,
    TapeSpec, encode_job, parse_status, profile, profiles,
};

const FIXTURE: [u8; 32] = [
    0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x18, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

const ESC_I_S: [u8; 3] = [0x1B, 0x69, 0x53];

fn p710() -> &'static ModelProfile {
    profile(Model::PtP710bt).expect("P710BT")
}

fn tze(p: &'static ModelProfile, width: u8) -> &'static TapeSpec {
    p.media
        .iter()
        .copied()
        .find(|t| t.media_width_byte == width && t.kind == TapeKind::Tze)
        .expect("tape")
}

fn pattern(t: &TapeSpec, length: u32, seed: u32) -> Bitmap {
    let h = u32::from(t.print_pins);
    Bitmap::from_fn(length, t.print_pins, |x, y| {
        let y = u32::from(y);
        y == x % h || (x * 3 + y + seed).is_multiple_of(11) || y == 0 || y + 1 == h
    })
}

/// Every frame the printer emits until `until_ms`.
fn drain(vp: &mut VirtualPrinter, until_ms: u64) -> Vec<(u64, [u8; STATUS_LEN])> {
    let mut out = Vec::new();
    while let Some(at) = vp.next_output_at() {
        if at > until_ms {
            break;
        }
        let f = vp.poll_output(at).expect("due frame");
        out.push((at, f));
    }
    out
}

/// `47 W 00` + raw head line.
fn raw_line(head: &[u8]) -> Vec<u8> {
    let mut v = vec![0x47, head.len() as u8, 0x00];
    v.extend_from_slice(head);
    v
}

/// A hand-built single page for P710BT / `width` mm, uncompressed: `lines` raw head lines,
/// declaring `declared` lines.
fn raw_page(width: u8, declared: u32, lines: &[Vec<u8>], last: bool) -> Vec<u8> {
    let mut v = vec![0x1B, 0x69, 0x61, 0x01];
    v.extend_from_slice(&[0x1B, 0x69, 0x7A, 0x84, 0x00, width, 0x00]);
    v.extend_from_slice(&declared.to_le_bytes());
    v.extend_from_slice(&[0x00, 0x00]);
    v.extend_from_slice(&[0x1B, 0x69, 0x4D, 0x40, 0x1B, 0x69, 0x4B, 0x08]);
    v.extend_from_slice(&[0x1B, 0x69, 0x64, 0x0E, 0x00, 0x4D, 0x00]);
    for l in lines {
        v.extend_from_slice(&raw_line(l));
    }
    v.push(if last { 0x1A } else { 0x0C });
    v
}

fn preamble() -> Vec<u8> {
    let mut v = vec![0u8; 100];
    v.extend_from_slice(&[0x1B, 0x40]);
    v
}

#[test]
fn idle_status_and_reply_equal_the_fixture() {
    let p = p710();
    let mut vp = VirtualPrinter::new(p, tze(p, 24), Behaviour::Normal);
    assert_eq!(vp.idle_status(), FIXTURE);
    vp.handle_input(&ESC_I_S, 1_000);
    assert_eq!(vp.poll_output(1_000), None, "reply is not instantaneous");
    let at = vp.next_output_at().expect("reply scheduled");
    assert_eq!(at, 1_000 + VirtualTiming::default().reply_delay_ms);
    assert_eq!(vp.poll_output(at), Some(FIXTURE));
    assert_eq!(vp.poll_output(u64::MAX), None);

    // Other widths change st[10] only.
    let vp12 = VirtualPrinter::new(p, tze(p, 12), Behaviour::Normal);
    let mut expected = FIXTURE;
    expected[10] = 12;
    assert_eq!(vp12.idle_status(), expected);
}

#[test]
fn silent_printer_never_answers() {
    let p = p710();
    let mut vp = VirtualPrinter::new(p, tze(p, 24), Behaviour::Silent);
    vp.handle_input(&ESC_I_S, 0);
    let t = tze(p, 24);
    let job = encode_job(p, t, &[&pattern(t, 40, 0)], &JobOptions::default()).expect("job");
    vp.handle_input(&job.to_bytes(), 10);
    assert_eq!(vp.next_output_at(), None);
    assert_eq!(vp.printed().len(), 1);
}

#[test]
fn no_media_status() {
    let p = p710();
    let vp = VirtualPrinter::new(p, tze(p, 24), Behaviour::NoMedia);
    let s = parse_status(&vp.idle_status()).expect("parses");
    assert!(!s.has_media());
    assert_eq!(s.media_width_mm, 0);
    assert_eq!(s.errors.info1 & 0x01, 0x01);
}

#[test]
fn push_frames_follow_the_p710bt_sequence() {
    let p = p710();
    let t = tze(p, 24);
    let mut vp = VirtualPrinter::new(p, t, Behaviour::Normal);
    let job = encode_job(p, t, &[&pattern(t, 100, 0)], &JobOptions::default()).expect("job");
    vp.handle_input(&job.to_bytes(), 0);
    assert!(vp.is_printing(1));
    let frames: Vec<_> = drain(&mut vp, u64::MAX)
        .into_iter()
        .map(|(_, f)| parse_status(&f).expect("frame"))
        .collect();
    let kinds: Vec<_> = frames.iter().map(|s| (s.status_type, s.phase)).collect();
    assert_eq!(
        kinds,
        vec![
            (StatusType::PhaseChange, Phase::Printing(0)),
            (StatusType::PrintingCompleted, Phase::Printing(0)),
            (StatusType::PhaseChange, Phase::Receiving(0)),
        ]
    );
    // st[15] echoes ESC i M 40.
    assert!(frames.iter().all(|s| s.mode == 0x40 && s.errors.is_empty()));
    assert!(!vp.is_printing(u64::MAX));
    assert!(vp.violations().is_empty(), "{:?}", vp.violations());

    // Without ESC i ! 00 the printer stays silent.
    let mut vp = VirtualPrinter::new(p, t, Behaviour::Normal);
    let opts = JobOptions {
        auto_status: false,
        ..JobOptions::default()
    };
    let job = encode_job(p, t, &[&pattern(t, 100, 0)], &opts).expect("job");
    vp.handle_input(&job.to_bytes(), 0);
    assert_eq!(vp.next_output_at(), None);
    // A poll while printing answers "printing", without a violation (no push).
    vp.handle_input(&ESC_I_S, 100);
    let reply = parse_status(&vp.poll_output(u64::MAX).expect("reply")).expect("parses");
    assert_eq!(
        (reply.status_type, reply.phase),
        (StatusType::Reply, Phase::Printing(0))
    );
    assert!(vp.violations().is_empty());
}

#[test]
fn extra_frames_and_cooling() {
    let p = p710();
    let t = tze(p, 24);
    let job = encode_job(p, t, &[&pattern(t, 40, 0)], &JobOptions::default()).expect("job");

    let mut vp = VirtualPrinter::new(p, t, Behaviour::ExtraFrames(2));
    vp.handle_input(&job.to_bytes(), 0);
    assert_eq!(drain(&mut vp, u64::MAX).len(), 5);

    let mut vp = VirtualPrinter::new(p, t, Behaviour::CoolingOnPage(1));
    vp.handle_input(&job.to_bytes(), 0);
    let frames = drain(&mut vp, u64::MAX);
    let types: Vec<u8> = frames.iter().map(|(_, f)| f[18]).collect();
    let notes: Vec<u8> = frames.iter().map(|(_, f)| f[22]).collect();
    assert_eq!(types, vec![0x06, 0x05, 0x05, 0x01, 0x06]);
    assert_eq!(notes, vec![0, 3, 4, 0, 0]);
    assert!(frames[2].0 - frames[1].0 >= VirtualTiming::default().cooling_ms);
}

#[test]
fn printed_pages_equal_the_input_on_every_model() {
    for p in profiles() {
        for t in p.media.iter().copied().filter(|t| t.kind == TapeKind::Tze) {
            for compression in [Compression::PackBits, Compression::None] {
                if compression == Compression::PackBits && !p.caps.compression {
                    continue;
                }
                let pages = [pattern(t, 60, 1), pattern(t, 45, 2)];
                let refs: Vec<&Bitmap> = pages.iter().collect();
                let opts = JobOptions {
                    compression: Some(compression),
                    ..JobOptions::default()
                };
                let job = encode_job(p, t, &refs, &opts).expect("encodes");
                let mut vp = VirtualPrinter::new(p, t, Behaviour::Normal);
                // Paced like the session: page 2 only after page 1 is done.
                let mut now = 0;
                let mut first = job.preamble.clone();
                first.extend_from_slice(&job.pages[0]);
                vp.handle_input(&first, now);
                while vp.is_printing(now) {
                    now += 100;
                }
                vp.handle_input(&job.pages[1], now);
                assert_eq!(vp.printed(), &pages, "{} {} {compression:?}", p.name, t.id);
                assert!(
                    vp.violations().is_empty(),
                    "{} {} {compression:?}: {:?}",
                    p.name,
                    t.id,
                    vp.violations()
                );

                let decoded = decode_job(p, &job.to_bytes()).expect("decodes");
                assert_eq!(decoded.pages, pages, "{} {}", p.name, t.id);
                assert!(
                    decoded.violations.is_empty(),
                    "{} {}: {:?}",
                    p.name,
                    t.id,
                    decoded.violations
                );
            }
        }
    }
}

#[test]
fn hand_built_page_decodes_with_inverse_pin_mapping() {
    // 12 mm: print area = transmitted bits 29..99; dot p ↔ bit 98 − p.
    let p = p710();
    let t = tze(p, 12);
    let mut all_black = [0u8; 16];
    all_black[3..13].copy_from_slice(&[0x07, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xE0]);
    let mut dot0 = [0u8; 16];
    dot0[12] = 0x20;
    let lines = vec![all_black.to_vec(), dot0.to_vec(), vec![0u8; 16]];
    let mut stream = preamble();
    stream.extend(raw_page(12, 3, &lines, true));
    let decoded = decode_job(p, &stream).expect("decodes");
    assert!(decoded.violations.is_empty(), "{:?}", decoded.violations);
    let page = &decoded.pages[0];
    assert_eq!((page.length(), page.height()), (3, t.print_pins));
    // The first line received is the right end of the label (PROTOCOL.md §5.3,
    // `FeedOrder::LastColumnFirst`): received lines 0, 1, 2 are canvas columns 2, 1, 0.
    assert!((0..70).all(|y| page.get(2, y)));
    assert!(page.get(1, 0) && (1..70).all(|y| !page.get(1, y)));
    assert!(page.is_line_blank(0));
}

#[test]
fn violation_command_while_printing() {
    let p = p710();
    let t = tze(p, 24);
    let mut vp = VirtualPrinter::new(p, t, Behaviour::Normal);
    let job = encode_job(p, t, &[&pattern(t, 40, 0)], &JobOptions::default()).expect("job");
    let bytes = job.to_bytes();
    vp.handle_input(&bytes, 0);
    vp.handle_input(&ESC_I_S, 10);
    assert_eq!(
        vp.violations(),
        &[Violation::CommandWhilePrinting {
            offset: bytes.len()
        }]
    );
    // A cancel while printing is allowed.
    vp.handle_input(&preamble(), 20);
    assert_eq!(vp.violations().len(), 1);
    assert!(!vp.is_printing(21));
}

#[test]
fn violation_data_outside_print_area() {
    let p = p710();
    let mut vp = VirtualPrinter::new(p, tze(p, 12), Behaviour::Normal);
    let mut head = [0u8; 16];
    head[0] = 0x80; // transmitted bit 0 = pin 127, in the right margin of 12 mm tape
    let mut stream = preamble();
    stream.extend(raw_page(
        12,
        3,
        &[vec![0; 16], head.to_vec(), vec![0; 16]],
        true,
    ));
    vp.handle_input(&stream, 0);
    assert_eq!(
        vp.violations(),
        &[Violation::DataOutsidePrintArea { page: 1, line: 1 }]
    );
    assert!(vp.printed()[0].is_blank());
}

#[test]
fn violation_line_count_mismatch() {
    let p = p710();
    let mut vp = VirtualPrinter::new(p, tze(p, 24), Behaviour::Normal);
    let mut stream = preamble();
    stream.extend(raw_page(
        24,
        5,
        &[vec![0; 16], vec![0; 16], vec![0; 16]],
        true,
    ));
    vp.handle_input(&stream, 0);
    assert_eq!(
        vp.violations(),
        &[Violation::LineCountMismatch {
            page: 1,
            declared: 5,
            received: 3
        }]
    );
}

#[test]
fn missing_print_info_is_rejected_like_the_p710bt() {
    let p = p710();
    let mut vp = VirtualPrinter::new(p, tze(p, 24), Behaviour::Normal);
    let mut stream = preamble();
    stream.extend_from_slice(&[0x1B, 0x69, 0x61, 0x01, 0x4D, 0x00]);
    stream.extend(raw_line(&[0; 16]));
    stream.push(0x1A);
    vp.handle_input(&stream, 0);
    assert_eq!(vp.violations(), &[Violation::MissingPrintInfo { page: 1 }]);
    let err = parse_status(&vp.poll_output(u64::MAX).expect("error frame")).expect("parses");
    assert_eq!(err.status_type, StatusType::Error);
    assert_eq!(err.errors.info2, 0x01);
    assert!(vp.printed().is_empty());
    // decode_job cannot decode raster data without geometry.
    assert!(matches!(decode_job(p, &stream), Err(Error::Corrupt { .. })));
}

#[test]
fn violations_unsupported_and_malformed_commands() {
    let p = p710();
    let mut vp = VirtualPrinter::new(p, tze(p, 24), Behaviour::Normal);
    // Page 1: ESC i A 01 (not supported on P710BT) and half cut before the raster data.
    let mut first = preamble();
    let page_start = first.len();
    first.extend(raw_page(24, 1, &[vec![0; 16]], true));
    let at = page_start + 4 + 13;
    first.splice(at..at, [0x1B, 0x69, 0x41, 0x01, 0x1B, 0x69, 0x4B, 0x0C]);
    // Then (after page 1 printed): a garbage byte, and a page with a Z line in raw mode and
    // n9 = 1 on the first page of a new job.
    let mut second = vec![0xEE];
    second.extend(raw_page(24, 1, &[], true));
    let end = second.len() - 1;
    second.insert(end, 0x5A);
    second[1 + 4 + 11] = 0x01;

    let mut now = 0;
    vp.handle_input(&first, now);
    while vp.is_printing(now) {
        now += 100;
    }
    vp.handle_input(&second, now);
    let v = vp.violations();
    assert!(v.contains(&Violation::UnsupportedCommand {
        offset: at,
        what: "ESC i A (cut every)"
    }));
    assert!(v.contains(&Violation::UnsupportedCommand {
        offset: at + 4,
        what: "half cut"
    }));
    assert!(v.contains(&Violation::UnknownCommand {
        offset: first.len()
    }));
    assert!(v.contains(&Violation::ZeroLineWithoutCompression {
        offset: first.len() + end
    }));
    assert!(v.contains(&Violation::PagePosition {
        page: 2,
        got: 1,
        expected: 0
    }));
    assert_eq!(v.len(), 5, "{v:?}");
    assert_eq!(vp.printed().len(), 2);
}

#[test]
fn violation_out_of_order_control() {
    let p = p710();
    let mut vp = VirtualPrinter::new(p, tze(p, 24), Behaviour::Normal);
    let mut stream = preamble();
    let mut page = raw_page(24, 2, &[vec![0; 16], vec![0; 16]], true);
    // Move `4D 00` after the first raster line.
    let pos = page.iter().position(|&b| b == 0x47).expect("line");
    page.insert(pos + 19, 0x4D);
    page.insert(pos + 20, 0x00);
    stream.extend(page);
    vp.handle_input(&stream, 0);
    assert!(
        vp.violations()
            .iter()
            .any(|v| matches!(v, Violation::OutOfOrder { what, .. } if *what == "control command after raster data")),
        "{:?}",
        vp.violations()
    );
}

#[test]
fn wrong_media_width_raises_error_frame_and_discards_data() {
    let p = p710();
    let t24 = tze(p, 24);
    let mut vp = VirtualPrinter::new(p, tze(p, 12), Behaviour::Normal);
    let job = encode_job(p, t24, &[&pattern(t24, 40, 0)], &JobOptions::default()).expect("job");
    vp.handle_input(&job.to_bytes(), 0);
    let frames = drain(&mut vp, u64::MAX);
    assert_eq!(frames.len(), 1);
    let err = parse_status(&frames[0].1).expect("parses");
    assert_eq!(err.status_type, StatusType::Error);
    assert_eq!(err.errors.info2, 0x01);
    assert!(vp.printed().is_empty());

    // A status reply still shows the error until the host resets the printer.
    vp.handle_input(&ESC_I_S, 1_000);
    let s = parse_status(&vp.poll_output(u64::MAX).expect("reply")).expect("parses");
    assert_eq!(s.errors.info2, 0x01);
    vp.handle_input(&preamble(), 2_000);
    vp.handle_input(&ESC_I_S, 2_000);
    let s = parse_status(&vp.poll_output(u64::MAX).expect("reply")).expect("parses");
    assert!(s.is_ready());

    // WrongMedia rejects even a matching job.
    let mut vp = VirtualPrinter::new(p, t24, Behaviour::WrongMedia);
    vp.handle_input(&job.to_bytes(), 0);
    let err = parse_status(&vp.poll_output(u64::MAX).expect("error")).expect("parses");
    assert_eq!(err.errors.info2, 0x01);
}

#[test]
fn cover_open_error_frame() {
    let p = p710();
    let t = tze(p, 24);
    let mut vp = VirtualPrinter::new(p, t, Behaviour::CoverOpenOnPage(1));
    let job = encode_job(p, t, &[&pattern(t, 40, 0)], &JobOptions::default()).expect("job");
    vp.handle_input(&job.to_bytes(), 0);
    let frames: Vec<_> = drain(&mut vp, u64::MAX)
        .into_iter()
        .map(|(_, f)| parse_status(&f).expect("frame"))
        .collect();
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0].phase, Phase::Printing(0));
    assert_eq!(frames[1].status_type, StatusType::Error);
    assert_eq!(frames[1].errors.info2, 0x10);
}

#[test]
fn decode_job_errors() {
    let p = p710();
    let t = tze(p, 24);
    let job = encode_job(p, t, &[&pattern(t, 40, 0)], &JobOptions::default()).expect("job");
    let bytes = job.to_bytes();
    // Truncated in the middle of a raster line.
    let mut truncated = bytes.clone();
    truncated.truncate(bytes.iter().rposition(|&b| b == 0x47).expect("G") + 2);
    assert!(matches!(
        decode_job(p, &truncated),
        Err(Error::Corrupt { .. })
    ));
    // A width the model has no media for.
    let mut stream = preamble();
    stream.extend(raw_page(36, 1, &[vec![0; 16]], true));
    assert_eq!(
        decode_job(p, &stream),
        Err(Error::UnsupportedMedia {
            width_mm: 36,
            media_type: 0
        })
    );
    // Bad PackBits.
    let mut stream = preamble();
    let mut page = raw_page(24, 1, &[], true);
    let end = page.len() - 1;
    let m = page.iter().rposition(|&b| b == 0x4D).expect("M");
    page[m + 1] = 0x02;
    page.splice(end..end, [0x47, 0x02, 0x00, 0x05, 0x00]);
    stream.extend(page);
    assert!(matches!(
        decode_job(p, &stream),
        Err(Error::Corrupt {
            what: "packbits",
            ..
        })
    ));
    // Trailing NULs are fine.
    let mut padded = bytes.clone();
    padded.extend_from_slice(&[0; 10]);
    let decoded = decode_job(p, &padded).expect("decodes");
    assert_eq!(decoded.commands.last(), Some(&Command::Invalidate(10)));
}

#[test]
fn malformed_line_is_a_violation_online() {
    let p = p710();
    let mut vp = VirtualPrinter::new(p, tze(p, 24), Behaviour::Normal);
    let mut stream = preamble();
    stream.extend(raw_page(24, 2, &[vec![0; 15], vec![0xFF; 16]], true));
    vp.handle_input(&stream, 0);
    assert_eq!(
        vp.violations(),
        &[Violation::MalformedRasterLine { page: 1, line: 0 }]
    );
    // Violation line numbers count received lines; the page is in canvas order, so received
    // line 0 is canvas column 1 (PROTOCOL.md §5.3).
    let page = &vp.printed()[0];
    assert!(page.is_line_blank(1) && !page.is_line_blank(0));
}

fn parse_chunked(bytes: &[u8], cuts: &[usize]) -> Vec<Command> {
    let mut p = JobParser::new();
    let mut out = Vec::new();
    let mut start = 0;
    for &c in cuts {
        let end = (start + c).min(bytes.len());
        p.push(&bytes[start..end]);
        start = end;
        while let Some(cmd) = p.next_command() {
            out.push(cmd);
        }
    }
    p.push(&bytes[start..]);
    while let Some(cmd) = p.next_command() {
        out.push(cmd);
    }
    while let Some(cmd) = p.finish() {
        out.push(cmd);
    }
    out
}

/// Bytes that look like job commands, to reach deep parser states.
fn command_soup() -> impl Strategy<Value = Vec<u8>> {
    let piece = prop_oneof![
        Just(vec![
            0x1B, 0x69, 0x7A, 0x84, 0x00, 0x18, 0x00, 2, 0, 0, 0, 0, 0
        ]),
        Just(vec![0x1B, 0x69, 0x53]),
        Just(vec![0x1B, 0x40]),
        Just(vec![0x4D, 0x02]),
        Just(vec![0x4D, 0x00]),
        Just(vec![0x5A]),
        Just(vec![0x0C]),
        Just(vec![0x1A]),
        Just(vec![0x1B, 0x69]),
        Just(vec![0x1B, 0x69, 0x43]),
        Just(vec![0x1B, 0x69, 0x55, 0x4A, 0x00]),
        Just(vec![0x47, 0x02, 0x00, 0xF1, 0x00]),
        Just(vec![0x47, 0x10, 0x00]),
        prop::collection::vec(any::<u8>(), 0..20),
    ];
    prop::collection::vec(piece, 0..40).prop_map(|v| v.concat())
}

proptest! {
    #[test]
    fn parser_never_panics_and_ignores_chunking(
        bytes in prop_oneof![prop::collection::vec(any::<u8>(), 0..600), command_soup()],
        cuts in prop::collection::vec(0usize..40, 0..30),
    ) {
        let whole = parse_chunked(&bytes, &[]);
        let chunked = parse_chunked(&bytes, &cuts);
        prop_assert_eq!(&whole, &chunked);
        let ones: Vec<usize> = vec![1; bytes.len()];
        prop_assert_eq!(&whole, &parse_chunked(&bytes, &ones));
    }

    #[test]
    fn virtual_printer_and_decoder_never_panic(
        bytes in prop_oneof![prop::collection::vec(any::<u8>(), 0..600), command_soup()],
        cuts in prop::collection::vec(1usize..64, 0..20),
    ) {
        let p = p710();
        let mut vp = VirtualPrinter::new(p, tze(p, 24), Behaviour::Normal);
        let mut start = 0;
        let mut now = 0;
        for c in cuts {
            let end = (start + c).min(bytes.len());
            vp.handle_input(&bytes[start..end], now);
            start = end;
            now += 7;
            while vp.poll_output(now).is_some() {}
        }
        vp.handle_input(&bytes[start..], now);
        while vp.poll_output(u64::MAX).is_some() {}
        let _ = decode_job(p, &bytes);
    }
}

// Review regression: a long `00` run is counted, not buffered and rescanned.
#[test]
fn zero_runs_are_counted_not_buffered() {
    let mut p = JobParser::new();
    let chunk = vec![0u8; 100_000];
    for _ in 0..10 {
        p.push(&chunk);
        assert_eq!(p.next_command(), None);
    }
    assert_eq!(p.pending_bytes(), 1_000_000);
    assert_eq!(p.offset(), 0, "offset of the pending run");
    // One byte at a time stays linear (this took over a second when the run was rescanned).
    let started = std::time::Instant::now();
    for _ in 0..200_000 {
        p.push(&[0]);
        assert_eq!(p.next_command(), None);
    }
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    p.push(&[0x1B, 0x40]);
    assert_eq!(p.next_command(), Some(Command::Invalidate(1_200_000)));
    assert_eq!(p.offset(), 1_200_000);
    assert_eq!(p.next_command(), Some(Command::Initialize));
    assert_eq!(p.pending_bytes(), 0);
}

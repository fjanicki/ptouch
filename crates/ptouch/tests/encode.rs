//! Encoder tests (WP4): head-line mapping, the PROTOCOL.md §6.3–§6.7 sequences byte for byte,
//! options, geometry errors and the golden byte streams in `tests/golden/` (format in
//! `tests/golden/README.md`; regenerate with `UPDATE_GOLDEN=1 cargo test -p ptouch --test encode`).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fmt::Write as _;
use std::path::PathBuf;

use ptouch::encode::{
    CutMode, EncodedJob, JobOptions, cancel_sequence, encode_job, generic_handshake_sequence,
    handshake_sequence, line::head_line, reset_sequence,
};
use ptouch::model::profile;
use ptouch::{Bitmap, Compression, Error, FeedOrder, Model, ModelProfile, TapeSpec};

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

fn prof(model: Model) -> &'static ModelProfile {
    profile(model).unwrap_or_else(|| panic!("{model:?} missing from the generated model table"))
}

fn tape(p: &ModelProfile, id: &str) -> &'static TapeSpec {
    p.media
        .iter()
        .copied()
        .find(|t| t.id == id)
        .unwrap_or_else(|| panic!("{} has no media {id}", p.name))
}

fn p710() -> &'static ModelProfile {
    prof(Model::PtP710bt)
}

fn encode(p: &ModelProfile, t: &TapeSpec, pages: &[&Bitmap], opts: &JobOptions) -> EncodedJob {
    encode_job(p, t, pages, opts).unwrap()
}

fn blank(t: &TapeSpec, length: u32) -> Bitmap {
    Bitmap::new(length, t.print_pins)
}

/// Bitmap whose line `x` has exactly the dots in `dots(x)`.
fn bitmap(t: &TapeSpec, length: u32, dots: impl Fn(u32, u16) -> bool) -> Bitmap {
    Bitmap::from_fn(length, t.print_pins, dots)
}

fn nulls(n: usize) -> Vec<u8> {
    vec![0; n]
}

/// Length in bytes of the command starting at `b[0]` (the grammar of PROTOCOL.md §3.1).
fn command_len(b: &[u8]) -> usize {
    let at = |i: usize| b.get(i).copied();
    let n = match (at(0), at(1), at(2)) {
        (Some(0x00), ..) => b.iter().take_while(|&&x| x == 0).count(),
        (Some(0x1B), Some(0x40), _) => 2,
        (Some(0x1B), Some(0x69), Some(c)) => match c {
            0x53 | 0x18 => 3,
            0x61 | 0x21 | 0x4D | 0x41 | 0x4B | 0x70 => 4,
            0x64 => 5,
            0x4C | 0x6B => 6,
            0x7A => 13,
            0x43 => 4 + 3 * usize::from(at(3).unwrap_or(0)),
            _ => 3,
        },
        (Some(0x4D), ..) => 2,
        (Some(0x47), Some(lo), Some(hi)) => 3 + usize::from(u16::from_le_bytes([lo, hi])),
        _ => 1,
    };
    n.clamp(1, b.len().max(1))
}

/// Splits a byte stream into commands.
fn split(mut b: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    while !b.is_empty() {
        let n = command_len(b);
        out.push(&b[..n]);
        b = &b[n..];
    }
    out
}

/// The first command starting with `prefix`.
fn find<'a>(cmds: &[&'a [u8]], prefix: &[u8]) -> Option<&'a [u8]> {
    cmds.iter().copied().find(|c| c.starts_with(prefix))
}

fn count(cmds: &[&[u8]], prefix: &[u8]) -> usize {
    cmds.iter().filter(|c| c.starts_with(prefix)).count()
}

fn describe(c: &[u8]) -> String {
    let b = |i: usize| c.get(i).copied().unwrap_or(0);
    match c {
        [0x00, ..] => format!("invalidate ×{}", c.len()),
        [0x1B, 0x40] => "ESC @ initialize".into(),
        [0x1B, 0x69, 0x53] => "ESC i S status request".into(),
        [0x1B, 0x69, 0x18] => "ESC i 18 cancel".into(),
        [0x1B, 0x69, 0x61, n] => format!("ESC i a command mode {n:02X}"),
        [0x1B, 0x69, 0x21, n] => format!("ESC i ! status notification {n:02X}"),
        [0x1B, 0x69, 0x7A, ..] => format!(
            "ESC i z n1={:02X} n2={:02X} width={} length={} lines={} n9={}",
            b(3),
            b(4),
            b(5),
            b(6),
            u32::from_le_bytes([b(7), b(8), b(9), b(10)]),
            b(11)
        ),
        [0x1B, 0x69, 0x4D, n] => format!("ESC i M various mode {n:02X}"),
        [0x1B, 0x69, 0x41, n] => format!("ESC i A cut every {n}"),
        [0x1B, 0x69, 0x4B, n] => format!("ESC i K advanced mode {n:02X}"),
        [0x1B, 0x69, 0x6B, 0x63, lo, hi] => {
            format!("ESC i k c copies {}", u16::from_le_bytes([*lo, *hi]))
        }
        [0x1B, 0x69, 0x70, n] => format!("ESC i p stored-up printing {n:02X}"),
        [0x1B, 0x69, 0x4C, ..] => "ESC i L print line control".into(),
        [0x1B, 0x69, 0x43, ..] => "ESC i C colour information".into(),
        [0x1B, 0x69, 0x64, lo, hi] => format!("ESC i d margin {}", u16::from_le_bytes([*lo, *hi])),
        [0x4D, n] => format!("M compression {n:02X}"),
        [0x47, ..] => format!("G raster line ({} bytes)", c.len().saturating_sub(3)),
        [0x5A] => "Z blank line".into(),
        [0x0C] => "FF print".into(),
        [0x1A] => "^Z print and feed".into(),
        _ => "?? unknown".into(),
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::new();
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        write!(s, "{b:02X}").unwrap();
    }
    s
}

/// One line per command: `<hex>  # <description>`; invalidate runs are written `00*N`.
fn annotate(bytes: &[u8]) -> Vec<String> {
    split(bytes)
        .into_iter()
        .map(|c| {
            let h = if c.first() == Some(&0x00) {
                format!("00*{}", c.len())
            } else {
                hex(c)
            };
            format!("{h:<48} # {}", describe(c))
        })
        .collect()
}

/// Parses the golden hex format: whitespace-separated hex bytes, `XX*N` repeats, `#` comments.
fn parse_hex(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("");
        for tok in line.split_whitespace() {
            let (byte, n) = match tok.split_once('*') {
                Some((b, n)) => (b, n.parse::<usize>().unwrap()),
                None => (tok, 1),
            };
            let v = u8::from_str_radix(byte, 16)
                .unwrap_or_else(|_| panic!("bad hex token {tok:?} in golden"));
            out.extend(std::iter::repeat_n(v, n));
        }
    }
    out
}

/// Asserts `got == expected`, printing an annotated diff by command on mismatch.
#[track_caller]
fn assert_bytes(got: &[u8], expected: &[u8], what: &str) {
    if got == expected {
        return;
    }
    let g = annotate(got);
    let e = annotate(expected);
    let mut msg = format!(
        "{what}: byte streams differ ({} vs {} bytes, {} vs {} commands)\n",
        got.len(),
        expected.len(),
        g.len(),
        e.len()
    );
    let mut shown = 0;
    for i in 0..g.len().max(e.len()) {
        let (gl, el) = (g.get(i), e.get(i));
        if gl != el {
            writeln!(msg, "command #{i}:").unwrap();
            writeln!(msg, "  - expected {}", el.map_or("<none>", String::as_str)).unwrap();
            writeln!(msg, "  + got      {}", gl.map_or("<none>", String::as_str)).unwrap();
            shown += 1;
            if shown == 12 {
                msg.push_str("  …\n");
                break;
            }
        }
    }
    panic!("{msg}");
}

/// PackBits of the 12 mm all-black example and similar hand-encoded lines.
fn g(data: &[u8]) -> Vec<u8> {
    let mut v = vec![0x47, data.len() as u8, 0x00];
    v.extend_from_slice(data);
    v
}

// ---------------------------------------------------------------------------------------------
// head_line (PROTOCOL.md §5.1)
// ---------------------------------------------------------------------------------------------

fn head(t: &TapeSpec, bytes_per_line: usize, dots: &[u16]) -> Vec<u8> {
    let b = bitmap(t, 1, |_, y| dots.contains(&y));
    let mut dst = vec![0xA5; bytes_per_line];
    head_line(b.line(0), t, &mut dst);
    dst
}

fn all_dots(t: &TapeSpec) -> Vec<u16> {
    (0..t.print_pins).collect()
}

#[test]
fn head_line_12mm_all_black_worked_example() {
    let t = tape(p710(), "tze128-12");
    assert_eq!(
        head(t, 16, &all_dots(t)),
        [
            0x00, 0x00, 0x00, 0x07, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xE0, 0x00,
            0x00, 0x00
        ]
    );
}

#[test]
fn head_line_24mm_full_width() {
    let t = tape(p710(), "tze128-24");
    assert_eq!(head(t, 16, &all_dots(t)), [0xFF; 16]);
    assert_eq!(head(t, 16, &[]), [0x00; 16]);
}

#[test]
fn head_line_3_5mm() {
    // left 52, print 24, right 52: transmitted bits 52..=75 → bytes 6 (low nibble), 7, 8,
    // 9 (high nibble).
    let t = tape(p710(), "tze128-3.5");
    let mut expected = [0u8; 16];
    expected[6] = 0x0F;
    expected[7] = 0xFF;
    expected[8] = 0xFF;
    expected[9] = 0xF0;
    assert_eq!(head(t, 16, &all_dots(t)), expected);
}

#[test]
fn head_line_single_dot_positions() {
    // 12 mm: dot p → bit right + (print − 1 − p) = 29 + 69 − p.
    let t = tape(p710(), "tze128-12");
    // p = 0 → bit 98 → byte 12, bit 2 from the MSB (0x20) — the last bit of the print area.
    let mut expected = [0u8; 16];
    expected[12] = 0x20;
    assert_eq!(head(t, 16, &[0]), expected);
    // p = 69 → bit 29 → byte 3, 0x04 — the first bit of the print area.
    let mut expected = [0u8; 16];
    expected[3] = 0x04;
    assert_eq!(head(t, 16, &[69]), expected);
    // 24 mm: p = 0 → bit 127 = LSB of the last byte (pin 0); p = 127 → MSB of byte 0.
    let t = tape(p710(), "tze128-24");
    let mut expected = [0u8; 16];
    expected[15] = 0x01;
    assert_eq!(head(t, 16, &[0]), expected);
    let mut expected = [0u8; 16];
    expected[0] = 0x80;
    assert_eq!(head(t, 16, &[127]), expected);
}

#[test]
fn head_line_560_pin_p910bt_24mm() {
    let p = prof(Model::PtP910bt);
    let t = tape(p, "tze560-24");
    let line = head(t, usize::from(p.bytes_per_line), &all_dots(t));
    assert_eq!(line.len(), 70);
    assert!(
        line[..16].iter().all(|&b| b == 0),
        "right margin bytes 0–15"
    );
    assert!(
        line[16..56].iter().all(|&b| b == 0xFF),
        "print area bytes 16–55"
    );
    assert!(
        line[56..].iter().all(|&b| b == 0),
        "left margin bytes 56–69"
    );
    // p = 0 → pin 112 → bit 447 → byte 55 LSB.
    let line = head(t, 70, &[0]);
    assert_eq!(line[55], 0x01);
    assert_eq!(line.iter().filter(|&&b| b != 0).count(), 1);
}

#[test]
fn head_line_p300bt_12mm_stays_inside_bytes_4_to_11() {
    let p = prof(Model::PtP300bt);
    let t = tape(p, "p300-12");
    let line = head(t, 16, &all_dots(t));
    assert_eq!(
        line,
        [
            0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0
        ]
    );
}

// ---------------------------------------------------------------------------------------------
// Hand-built sequences (PROTOCOL.md §6.3–§6.7)
// ---------------------------------------------------------------------------------------------

/// The tiny 24 mm test label used by the hand-built vectors: 5 lines.
/// 0: all black; 1: blank; 2: dot 0; 3: dot 127; 4: dots 0–7.
fn tiny_24mm(t: &TapeSpec) -> Bitmap {
    bitmap(t, 5, |x, y| match x {
        0 => true,
        2 => y == 0,
        3 => y == 127,
        4 => y < 8,
        _ => false,
    })
}

/// Raster lines of [`tiny_24mm`] in PackBits mode, in send order: the last canvas column
/// first (PROTOCOL.md §5.3, `FeedOrder::LastColumnFirst`, \[HW\] PT-P710BT).
fn tiny_24mm_packbits() -> Vec<u8> {
    let mut v = Vec::new();
    v.extend(g(&[0xF2, 0x00, 0x00, 0xFF])); // column 4: 15 × 00, literal FF
    v.extend(g(&[0x00, 0x80, 0xF2, 0x00])); // column 3: literal 80, 15 × 00
    v.extend(g(&[0xF2, 0x00, 0x00, 0x01])); // column 2: 15 × 00, literal 01 (pin 0 = LSB of byte 15)
    v.push(0x5A); // column 1: blank
    v.extend(g(&[0xF1, 0xFF])); // column 0: 16 × FF
    v
}

#[test]
fn every_profile_sends_the_last_canvas_column_first() {
    // PROTOCOL.md §5.3: hardware-verified on PT-P710BT, applied to every PT model.
    for p in ptouch::profiles() {
        assert_eq!(p.feed_order(), FeedOrder::LastColumnFirst, "{}", p.name);
    }
    // A page whose only ink is in canvas column 0 sends that line last.
    let p = p710();
    let t = tape(p, "tze128-24");
    let page = bitmap(t, 4, |x, _| x == 0);
    let job = encode(p, t, &[&page], &JobOptions::default());
    let cmds = split(&job.pages[0]);
    let lines: Vec<&[u8]> = cmds
        .iter()
        .copied()
        .filter(|c| c[0] == 0x47 || c[0] == 0x5A)
        .collect();
    assert_eq!(lines, [&[0x5A][..], &[0x5A], &[0x5A], &g(&[0xF1, 0xFF])]);
}

#[test]
fn p710bt_single_label_matches_protocol_6_3() {
    let p = p710();
    let t = tape(p, "tze128-24");
    let job = encode(p, t, &[&tiny_24mm(t)], &JobOptions::default());

    let mut expected = nulls(100);
    expected.extend([0x1B, 0x40]);
    expected.extend([0x1B, 0x69, 0x61, 0x01]);
    expected.extend([0x1B, 0x69, 0x21, 0x00]);
    expected.extend([
        0x1B, 0x69, 0x7A, 0x84, 0x00, 0x18, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expected.extend([0x1B, 0x69, 0x4D, 0x40]);
    expected.extend([0x1B, 0x69, 0x4B, 0x08]);
    expected.extend([0x1B, 0x69, 0x64, 0x0E, 0x00]);
    expected.extend([0x4D, 0x02]);
    expected.extend(tiny_24mm_packbits());
    expected.push(0x1A);
    assert_bytes(&job.to_bytes(), &expected, "P710BT §6.3");

    assert_eq!(job.model, Model::PtP710bt);
    assert_eq!(job.media_width_byte, 24);
    assert_eq!(job.media_type_byte, 0x01);
    assert_eq!(job.preamble, [nulls(100), vec![0x1B, 0x40]].concat());
    assert_eq!(job.pages.len(), 1);
    assert_eq!(job.page_lines, [5]);
    assert_eq!(job.total_lines(), 5);
    assert_eq!(job.page_count(), 1);
    assert!(job.epilogue.is_empty());
}

#[test]
fn p710bt_header_matches_d1_dump() {
    // D1 dump: 1B 69 7A 84 00 18 00 AA 02 00 00 00 00 (682 lines) and `… 01 00` on page 2.
    let p = p710();
    let t = tape(p, "tze128-24");
    let page = blank(t, 0x2AA);
    let job = encode(p, t, &[&page, &page], &JobOptions::default());
    let p1 = split(&job.pages[0]);
    let p2 = split(&job.pages[1]);
    let z = [
        0x1B, 0x69, 0x7A, 0x84, 0x00, 0x18, 0x00, 0xAA, 0x02, 0x00, 0x00,
    ];
    assert_eq!(
        find(&p1, &[0x1B, 0x69, 0x7A]),
        Some(&[&z[..], &[0x00, 0x00]].concat()[..])
    );
    assert_eq!(
        find(&p2, &[0x1B, 0x69, 0x7A]),
        Some(&[&z[..], &[0x01, 0x00]].concat()[..])
    );
    for cmds in [&p1, &p2] {
        assert_eq!(
            find(cmds, &[0x1B, 0x69, 0x4D]),
            Some(&[0x1B, 0x69, 0x4D, 0x40][..])
        );
        assert_eq!(
            find(cmds, &[0x1B, 0x69, 0x4B]),
            Some(&[0x1B, 0x69, 0x4B, 0x08][..])
        );
        assert_eq!(
            find(cmds, &[0x1B, 0x69, 0x64]),
            Some(&[0x1B, 0x69, 0x64, 0x0E, 0x00][..])
        );
        assert_eq!(find(cmds, &[0x4D]), Some(&[0x4D, 0x02][..]));
        assert_eq!(count(cmds, &[0x5A]), 0x2AA);
        assert_eq!(count(cmds, &[0x1B, 0x69, 0x41]), 0, "no ESC i A on P710BT");
    }
    // With Z disabled, blank lines use the driver-dump form.
    let opts = JobOptions {
        z_for_blank_lines: false,
        ..JobOptions::default()
    };
    let job = encode(p, t, &[&page], &opts);
    let cmds = split(&job.pages[0]);
    assert_eq!(count(&cmds, &[0x47, 0x02, 0x00, 0xF1, 0x00]), 0x2AA);
    assert_eq!(count(&cmds, &[0x5A]), 0);
}

#[test]
fn p710bt_multi_page() {
    let p = p710();
    let t = tape(p, "tze128-24");
    let a = tiny_24mm(t);
    let b = blank(t, 4);
    let job = encode(p, t, &[&a, &b, &a], &JobOptions::default());
    assert_eq!(job.pages.len(), 3);
    assert_eq!(job.page_lines, [5, 4, 5]);
    assert_eq!(job.total_lines(), 14);

    let header = |lines: u8, n9: u8| {
        let mut v = vec![0x1B, 0x69, 0x61, 0x01];
        if n9 == 0 {
            v.extend([0x1B, 0x69, 0x21, 0x00]);
        }
        v.extend([
            0x1B, 0x69, 0x7A, 0x84, 0x00, 0x18, 0x00, lines, 0, 0, 0, n9, 0x00,
        ]);
        v.extend([0x1B, 0x69, 0x4D, 0x40, 0x1B, 0x69, 0x4B, 0x08]);
        v.extend([0x1B, 0x69, 0x64, 0x0E, 0x00, 0x4D, 0x02]);
        v
    };
    let page1 = [header(5, 0), tiny_24mm_packbits(), vec![0x0C]].concat();
    let page2 = [header(4, 1), vec![0x5A; 4], vec![0x0C]].concat();
    let page3 = [header(5, 1), tiny_24mm_packbits(), vec![0x1A]].concat();
    assert_bytes(&job.pages[0], &page1, "page 1");
    assert_bytes(&job.pages[1], &page2, "page 2");
    assert_bytes(&job.pages[2], &page3, "page 3");
    assert_eq!(
        job.to_bytes(),
        [job.preamble.clone(), page1, page2, page3].concat()
    );
}

#[test]
fn e560bt_single_label_matches_protocol_6_4() {
    let p = prof(Model::PtE560bt);
    let t = tape(p, "tze128-24");
    // 6 lines = min_lines at the default 14-dot margin (4.8 mm, PROTOCOL.md §5.6).
    let label = bitmap(t, 6, |x, y| x == 0 || (x == 5 && y == 0));
    let job = encode(p, t, &[&label], &JobOptions::default());

    let mut expected = nulls(200);
    expected.extend([0x1B, 0x40]);
    expected.extend([0x1B, 0x69, 0x61, 0x01]);
    expected.extend([0x1B, 0x69, 0x21, 0x00]);
    expected.extend([
        0x1B, 0x69, 0x7A, 0x84, 0x00, 0x18, 0x00, 0x06, 0x00, 0x00, 0x00, 0x02, 0x00,
    ]);
    expected.extend([0x1B, 0x69, 0x4D, 0x40]);
    expected.extend([0x1B, 0x69, 0x41, 0x01]);
    expected.extend([0x1B, 0x69, 0x4B, 0x08]);
    expected.extend([0x1B, 0x69, 0x70, 0x01]);
    expected.extend([0x1B, 0x69, 0x4C, 0x00, 0x01, 0x01]);
    expected.extend([0x1B, 0x69, 0x43, 0x01, 0xFF, 0xFF, 0xFF]);
    expected.extend([0x1B, 0x69, 0x64, 0x0E, 0x00]);
    expected.extend([0x4D, 0x00]);
    // Send order: canvas column 5 first, column 0 last (PROTOCOL.md §5.3).
    let mut last = [0u8; 16];
    last[15] = 0x01;
    expected.extend(g(&last));
    for _ in 0..4 {
        expected.extend(g(&[0x00; 16]));
    }
    expected.extend(g(&[0xFF; 16]));
    expected.push(0x1A);
    expected.extend([0x1B, 0x69, 0x61, 0xFF]);
    assert_bytes(&job.to_bytes(), &expected, "E560BT §6.4");
    assert_eq!(job.epilogue, [0x1B, 0x69, 0x61, 0xFF]);
}

#[test]
fn e560bt_one_page_per_label() {
    // §6.4 resolution: every label is its own page with n9 = 2 and 1A; the full control block
    // (incl. ESC i K) is repeated; intermediate labels are chained, the last is fed out.
    let p = prof(Model::PtE560bt);
    let t = tape(p, "tze128-12");
    let page = blank(t, 10);
    let job = encode(p, t, &[&page, &page, &page], &JobOptions::default());
    for (i, bytes) in job.pages.iter().enumerate() {
        let cmds = split(bytes);
        let z = find(&cmds, &[0x1B, 0x69, 0x7A]).unwrap();
        assert_eq!(z[11], 0x02, "n9 on page {i}");
        assert_eq!(cmds.last(), Some(&&[0x1A][..]));
        assert_eq!(count(&cmds, &[0x0C]), 0);
        let k = find(&cmds, &[0x1B, 0x69, 0x4B]).unwrap()[3];
        assert_eq!(k, if i == 2 { 0x08 } else { 0x00 }, "ESC i K on page {i}");
        assert_eq!(count(&cmds, &[0x1B, 0x69, 0x21]), usize::from(i == 0));
        assert_eq!(count(&cmds, &[0x1B, 0x69, 0x61, 0x01]), 1);
        assert_eq!(count(&cmds, &[0x47, 0x10, 0x00]), 10, "uncompressed lines");
    }
    // Chain: no page gets the no-chain bit.
    let opts = JobOptions {
        chain: true,
        ..JobOptions::default()
    };
    let job = encode(p, t, &[&page, &page], &opts);
    for bytes in &job.pages {
        assert_eq!(find(&split(bytes), &[0x1B, 0x69, 0x4B]).unwrap()[3], 0x00);
    }
    // Half cut: M 00 (M 40 would force a full cut per page), K 04 then 0C.
    let opts = JobOptions {
        cut: CutMode::HalfCut,
        ..JobOptions::default()
    };
    let job = encode(p, t, &[&page, &page], &opts);
    let ks: Vec<u8> = job
        .pages
        .iter()
        .map(|b| find(&split(b), &[0x1B, 0x69, 0x4B]).unwrap()[3])
        .collect();
    assert_eq!(ks, [0x04, 0x0C]);
    for bytes in &job.pages {
        let cmds = split(bytes);
        assert_eq!(find(&cmds, &[0x1B, 0x69, 0x4D]).unwrap()[3], 0x00);
        assert_eq!(
            count(&cmds, &[0x1B, 0x69, 0x41]),
            0,
            "no ESC i A without auto cut"
        );
    }
}

#[test]
fn p910bt_single_page_matches_protocol_6_5() {
    let p = prof(Model::PtP910bt);
    let t = tape(p, "tze560-24");
    // 30 lines (min_lines 29 at margin 14, 360 dpi); line 0 all black.
    let label = bitmap(t, 30, |x, _| x == 0);
    let job = encode(p, t, &[&label], &JobOptions::default());

    let mut expected = nulls(200);
    expected.extend([0x1B, 0x40]);
    expected.extend([0x1B, 0x69, 0x61, 0x01]);
    expected.extend([0x1B, 0x69, 0x21, 0x00]);
    expected.extend([
        0x1B, 0x69, 0x7A, 0x84, 0x00, 0x18, 0x00, 0x1E, 0x00, 0x00, 0x00, 0x02, 0x00,
    ]);
    expected.extend([0x1B, 0x69, 0x4D, 0x40]);
    expected.extend([0x1B, 0x69, 0x41, 0x01]);
    expected.extend([0x1B, 0x69, 0x4B, 0x08]);
    expected.extend([0x1B, 0x69, 0x6B, 0x63, 0x01, 0x00]);
    expected.extend([0x1B, 0x69, 0x64, 0x0E, 0x00]);
    expected.extend([0x4D, 0x02]);
    // Canvas columns 29…1 (blank) are sent first, column 0 last (PROTOCOL.md §5.3):
    // 16 × 00 (right margin), 40 × FF (print area), 14 × 00 (left margin).
    expected.extend([0x5A; 29]);
    expected.extend(g(&[0xF1, 0x00, 0xD9, 0xFF, 0xF3, 0x00]));
    expected.push(0x1A);
    assert_bytes(&job.to_bytes(), &expected, "P910BT §6.5");
    assert!(job.epilogue.is_empty());
}

#[test]
fn p910bt_multi_page_positions() {
    let p = prof(Model::PtP910bt);
    let t = tape(p, "tze560-12");
    let page = blank(t, 40);
    let n9s = |n: usize| -> Vec<(u8, u8)> {
        let pages: Vec<&Bitmap> = std::iter::repeat_n(&page, n).collect();
        let job = encode(p, t, &pages, &JobOptions::default());
        job.pages
            .iter()
            .map(|b| {
                let cmds = split(b);
                (
                    find(&cmds, &[0x1B, 0x69, 0x7A]).unwrap()[11],
                    *b.last().unwrap(),
                )
            })
            .collect()
    };
    assert_eq!(n9s(1), [(2, 0x1A)]);
    assert_eq!(n9s(2), [(0, 0x0C), (2, 0x1A)]);
    assert_eq!(n9s(4), [(0, 0x0C), (1, 0x0C), (1, 0x0C), (2, 0x1A)]);
}

#[test]
fn p300bt_matches_protocol_6_6() {
    let p = prof(Model::PtP300bt);
    let t = tape(p, "p300-12");
    let label = bitmap(t, 40, |_, y| y == 0);
    let job = encode(p, t, &[&label], &JobOptions::default());
    let bytes = job.to_bytes();
    let cmds = split(&bytes);
    let names: Vec<String> = cmds.iter().map(|c| describe(c)).collect();
    assert_eq!(cmds[0].len(), 100);
    assert_eq!(
        &cmds[1..8],
        &[
            &[0x1B, 0x40][..],
            &[0x1B, 0x69, 0x61, 0x01],
            &[
                0x1B, 0x69, 0x7A, 0xC4, 0x01, 0x0C, 0x00, 40, 0, 0, 0, 0x00, 0x00
            ],
            &[0x1B, 0x69, 0x4B, 0x08],
            &[0x1B, 0x69, 0x4D, 0x40],
            &[0x1B, 0x69, 0x64, 0x0E, 0x00],
            &[0x4D, 0x02],
        ],
        "{names:#?}"
    );
    // Dot 0 → pin 32 → transmitted bit 95 = LSB of byte 11.
    let mut line = [0u8; 16];
    line[11] = 0x01;
    let mut enc = Vec::new();
    ptouch::packbits_encode(&line, &mut enc);
    assert_eq!(cmds[8], &g(&enc)[..]);
    assert_eq!(count(&cmds, &[0x1B, 0x69, 0x21]), 0, "no ESC i ! on P300BT");
    assert_eq!(cmds.last(), Some(&&[0x1A][..]));
}

#[test]
fn n25bt_matches_protocol_6_7() {
    let p = prof(Model::PtN25bt);
    let t = tape(p, "n25-12");
    let label = bitmap(t, 40, |_, y| y == 63);
    let job = encode(p, t, &[&label], &JobOptions::default());
    let bytes = job.to_bytes();
    let cmds = split(&bytes);
    let mut first_line = [0u8; 8];
    first_line[0] = 0x80;
    let expected: Vec<&[u8]> = vec![
        &[0x1B, 0x69, 0x61, 0x01],
        &[0x1B, 0x40],
        &[0x1B, 0x69, 0x21, 0x00],
        &[0x1B, 0x69, 0x70, 0x01],
        &[
            0x1B, 0x69, 0x7A, 0xC4, 0x01, 0x0C, 0x00, 40, 0, 0, 0, 0x02, 0x00,
        ],
        &[0x1B, 0x69, 0x4B, 0x08],
        &[0x1B, 0x69, 0x4D, 0x40],
        &[0x1B, 0x69, 0x6B, 0x63, 0x01, 0x00],
        &[0x1B, 0x69, 0x64, 0x0E, 0x00],
        &[0x4D, 0x00],
        &[0x1B, 0x69, 0x4C, 0x00, 0x01, 0x01],
        &[0x1B, 0x69, 0x43, 0x01, 0xFF, 0xFF, 0xFF],
    ];
    assert_eq!(cmds[0].len(), 100);
    assert_eq!(&cmds[1..13], &expected[..]);
    assert_eq!(
        cmds[13],
        &[&[0x47, 0x08, 0x00][..], &first_line[..]].concat()[..]
    );
    assert_eq!(count(&cmds, &[0x47, 0x08, 0x00]), 40);
    assert_eq!(&bytes[bytes.len() - 5..], &[0x1A, 0x1B, 0x69, 0x61, 0xFF]);
    assert_eq!(job.preamble.len(), 106);
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

fn p710_cmds(opts: &JobOptions, t_id: &str, length: u32) -> Vec<Vec<u8>> {
    let p = p710();
    let t = tape(p, t_id);
    let job = encode(p, t, &[&blank(t, length)], opts);
    split(&job.pages[0])
        .into_iter()
        .map(<[u8]>::to_vec)
        .collect()
}

fn get(cmds: &[Vec<u8>], prefix: &[u8]) -> Vec<u8> {
    cmds.iter()
        .find(|c| c.starts_with(prefix))
        .cloned()
        .unwrap_or_else(|| panic!("no command {prefix:02X?}"))
}

#[test]
fn option_chain_cut_mirror() {
    let k = [0x1B, 0x69, 0x4B];
    let m = [0x1B, 0x69, 0x4D];
    let chain = JobOptions {
        chain: true,
        ..JobOptions::default()
    };
    let c = p710_cmds(&chain, "tze128-24", 10);
    assert_eq!(get(&c, &k), [0x1B, 0x69, 0x4B, 0x00]);
    assert_eq!(get(&c, &m), [0x1B, 0x69, 0x4D, 0x40]);

    let no_cut = JobOptions {
        cut: CutMode::None,
        ..JobOptions::default()
    };
    let c = p710_cmds(&no_cut, "tze128-24", 10);
    assert_eq!(get(&c, &m), [0x1B, 0x69, 0x4D, 0x00]);
    assert_eq!(get(&c, &k), [0x1B, 0x69, 0x4B, 0x08]);

    let mirror = JobOptions {
        mirror: true,
        ..JobOptions::default()
    };
    let c = p710_cmds(&mirror, "tze128-24", 10);
    assert_eq!(get(&c, &m), [0x1B, 0x69, 0x4D, 0xC0]);
}

#[test]
fn option_special_tape() {
    let opts = JobOptions {
        special_tape: true,
        ..JobOptions::default()
    };
    let c = p710_cmds(&opts, "tze128-24", 10);
    assert_eq!(get(&c, &[0x1B, 0x69, 0x4B]), [0x1B, 0x69, 0x4B, 0x18]);
    assert_eq!(get(&c, &[0x1B, 0x69, 0x4D]), [0x1B, 0x69, 0x4D, 0x00]);
    // Contradictory combinations are rejected, never dropped.
    let p = p710();
    let t = tape(p, "tze128-24");
    let bad = JobOptions {
        special_tape: true,
        chain: true,
        ..JobOptions::default()
    };
    assert!(matches!(
        encode_job(p, t, &[&blank(t, 10)], &bad),
        Err(Error::InvalidInput(_))
    ));
}

#[test]
fn option_high_resolution() {
    let opts = JobOptions {
        high_resolution: true,
        ..JobOptions::default()
    };
    let c = p710_cmds(&opts, "tze128-24", 20);
    assert_eq!(get(&c, &[0x1B, 0x69, 0x4B]), [0x1B, 0x69, 0x4B, 0x48]);
    let z = get(&c, &[0x1B, 0x69, 0x7A]);
    assert_eq!(&z[3..5], &[0x86, 0x09]);
    assert_eq!(get(&c, &[0x1B, 0x69, 0x64]), [0x1B, 0x69, 0x64, 0x1C, 0x00]);
}

#[test]
fn option_compression_none() {
    let opts = JobOptions {
        compression: Some(Compression::None),
        ..JobOptions::default()
    };
    let p = p710();
    let t = tape(p, "tze128-24");
    let job = encode(p, t, &[&tiny_24mm(t)], &opts);
    let cmds = split(&job.pages[0]);
    assert_eq!(find(&cmds, &[0x4D]), Some(&[0x4D, 0x00][..]));
    assert_eq!(count(&cmds, &[0x5A]), 0);
    let lines: Vec<&[u8]> = cmds.iter().copied().filter(|c| c[0] == 0x47).collect();
    assert_eq!(lines.len(), 5);
    // Send order is canvas column 4, 3, 2, 1, 0 (PROTOCOL.md §5.3).
    assert_eq!(lines[4], &g(&[0xFF; 16])[..]);
    assert_eq!(lines[3], &g(&[0x00; 16])[..]);
    let mut l2 = [0u8; 16];
    l2[15] = 0x01;
    assert_eq!(lines[2], &g(&l2)[..]);
}

#[test]
fn option_heat_shrink_sets_kind() {
    let c = p710_cmds(&JobOptions::default(), "hs2-128-23.6", 10);
    let z = get(&c, &[0x1B, 0x69, 0x7A]);
    assert_eq!(&z[3..6], &[0x86, 0x11, 24]);
}

#[test]
fn option_margin_and_auto_status() {
    let opts = JobOptions {
        feed_margin_dots: Some(0),
        auto_status: false,
        ..JobOptions::default()
    };
    let c = p710_cmds(&opts, "tze128-24", 40);
    assert_eq!(get(&c, &[0x1B, 0x69, 0x64]), [0x1B, 0x69, 0x64, 0x00, 0x00]);
    assert!(!c.iter().any(|x| x.starts_with(&[0x1B, 0x69, 0x21])));
}

#[test]
fn unsupported_options_are_rejected() {
    let p = p710();
    let t = tape(p, "tze128-24");
    let page = blank(t, 10);
    let run = |p: &ModelProfile, t: &TapeSpec, opts: JobOptions| {
        encode_job(p, t, &[&Bitmap::new(40, t.print_pins)], &opts)
    };
    assert_eq!(
        encode_job(
            p,
            t,
            &[&page],
            &JobOptions {
                cut: CutMode::HalfCut,
                ..JobOptions::default()
            }
        ),
        Err(Error::Unsupported("half cut"))
    );
    // High-res needs laminated TZe.
    let hs = tape(p, "hs2-128-23.6");
    assert!(matches!(
        run(
            p,
            hs,
            JobOptions {
                high_resolution: true,
                ..JobOptions::default()
            }
        ),
        Err(Error::Unsupported(_))
    ));
    // A tape of another head family.
    let p910 = prof(Model::PtP910bt);
    assert_eq!(
        run(p, tape(p910, "tze560-24"), JobOptions::default()),
        Err(Error::UnsupportedMedia {
            width_mm: 24,
            media_type: 0x01
        })
    );
    // P910BT: no high-res.
    assert!(matches!(
        run(
            p910,
            tape(p910, "tze560-24"),
            JobOptions {
                high_resolution: true,
                ..JobOptions::default()
            }
        ),
        Err(Error::Unsupported(_))
    ));
    // E560BT: hardware mirror is not enabled (software mirror).
    let e560 = prof(Model::PtE560bt);
    assert!(matches!(
        run(
            e560,
            tape(e560, "tze128-24"),
            JobOptions {
                mirror: true,
                ..JobOptions::default()
            }
        ),
        Err(Error::Unsupported(_))
    ));
    // P300BT: no special tape; N25BT: no PackBits.
    let p300 = prof(Model::PtP300bt);
    assert!(matches!(
        run(
            p300,
            tape(p300, "p300-12"),
            JobOptions {
                special_tape: true,
                ..JobOptions::default()
            }
        ),
        Err(Error::Unsupported(_))
    ));
    let n25 = prof(Model::PtN25bt);
    assert!(matches!(
        run(
            n25,
            tape(n25, "n25-12"),
            JobOptions {
                compression: Some(Compression::PackBits),
                ..JobOptions::default()
            }
        ),
        Err(Error::Unsupported(_))
    ));
}

// ---------------------------------------------------------------------------------------------
// Geometry (PROTOCOL.md §5.6)
// ---------------------------------------------------------------------------------------------

#[test]
fn geometry_errors() {
    let p = p710();
    let t = tape(p, "tze128-24");
    let opts = JobOptions::default();
    assert_eq!(encode_job(p, t, &[], &opts), Err(Error::Empty));
    assert_eq!(
        encode_job(p, t, &[&Bitmap::new(0, 128)], &opts),
        Err(Error::Empty)
    );
    assert_eq!(
        encode_job(p, t, &[&Bitmap::new(10, 70)], &opts),
        Err(Error::BitmapSize {
            expected_height: 128,
            got_height: 70
        })
    );
    // A bad later page fails the whole job.
    assert!(encode_job(p, t, &[&blank(t, 10), &Bitmap::new(10, 112)], &opts).is_err());
    assert_eq!(p.max_lines(false), Some(7086));
    assert!(encode_job(p, t, &[&blank(t, 7086)], &opts).is_ok());
    assert_eq!(
        encode_job(p, t, &[&blank(t, 7087)], &opts),
        Err(Error::TooLong {
            dots: 7087,
            max: 7086
        })
    );
}

#[test]
fn short_pages_are_padded() {
    let p = p710();
    let t = tape(p, "tze128-24");
    let page = bitmap(t, 2, |_, _| true);
    let job = encode(p, t, &[&page], &JobOptions::default());
    assert_eq!(job.page_lines, [3]);
    let cmds = split(&job.pages[0]);
    let z = find(&cmds, &[0x1B, 0x69, 0x7A]).unwrap();
    assert_eq!(&z[7..11], &[3, 0, 0, 0]);
    let lines: Vec<&[u8]> = cmds
        .iter()
        .copied()
        .filter(|c| c[0] == 0x47 || c[0] == 0x5A)
        .collect();
    // The padding column sits at the canvas end (right end of the label), which is sent
    // first (PROTOCOL.md §5.3, §5.6).
    assert_eq!(lines, [&[0x5A][..], &g(&[0xF1, 0xFF]), &g(&[0xF1, 0xFF])]);

    let strict = JobOptions {
        pad_short_pages: false,
        ..JobOptions::default()
    };
    assert_eq!(
        encode_job(p, t, &[&page], &strict),
        Err(Error::TooShort { dots: 2, min: 3 })
    );
    // Margin 0: the whole 4.4 mm minimum must be raster lines (31).
    let zero = JobOptions {
        feed_margin_dots: Some(0),
        ..JobOptions::default()
    };
    assert_eq!(encode(p, t, &[&page], &zero).page_lines, [31]);
}

// ---------------------------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------------------------

#[test]
fn control_sequences() {
    let p = p710();
    assert_eq!(reset_sequence(p), [nulls(100), vec![0x1B, 0x40]].concat());
    assert_eq!(cancel_sequence(p), [nulls(100), vec![0x1B, 0x40]].concat());
    assert_eq!(
        handshake_sequence(p),
        [nulls(100), vec![0x1B, 0x40, 0x1B, 0x69, 0x61, 0x01]].concat()
    );
    assert_eq!(
        generic_handshake_sequence(),
        [nulls(200), vec![0x1B, 0x40, 0x1B, 0x69, 0x61, 0x01]].concat()
    );
    let p910 = prof(Model::PtP910bt);
    assert_eq!(
        cancel_sequence(p910),
        [nulls(200), vec![0x1B, 0x69, 0x18]].concat()
    );
    assert_eq!(ptouch::STATUS_REQUEST, [0x1B, 0x69, 0x53]);
}

#[test]
fn every_profile_and_tape_encodes() {
    for p in ptouch::profiles() {
        for t in p.media {
            let page = Bitmap::from_fn(100, t.print_pins, |x, y| (x + u32::from(y)) % 3 == 0);
            let job = encode_job(p, t, &[&page, &page], &JobOptions::default())
                .unwrap_or_else(|e| panic!("{} {}: {e}", p.name, t.id));
            let bytes = job.to_bytes();
            let cmds = split(&bytes);
            // The tokenizer consumes the stream exactly and every page carries its lines.
            assert_eq!(cmds.iter().map(|c| c.len()).sum::<usize>(), bytes.len());
            let lines = count(&cmds, &[0x47]) + count(&cmds, &[0x5A]);
            assert_eq!(lines, 200, "{} {}", p.name, t.id);
            for c in cmds.iter().filter(|c| c[0] == 0x47) {
                let n = c.len() - 3;
                assert!(
                    n <= usize::from(p.bytes_per_line) + 1,
                    "{} {}",
                    p.name,
                    t.id
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Goldens (tests/golden/<name>.hex)
// ---------------------------------------------------------------------------------------------

/// 24 mm ruler: a long tick every 10 mm (71 dots, cumulative rounding), short ticks every mm.
fn ruler(t: &TapeSpec, length: u32) -> Bitmap {
    let h = t.print_pins;
    let mm = |x: u32| (0..=length / 7).any(|i| x == (i * 1800 + 127) / 254);
    let ten = |x: u32| (0..=length / 70).any(|i| x == (i * 18000 + 127) / 254);
    Bitmap::from_fn(length, h, |x, y| {
        let y = u32::from(y);
        let h = u32::from(h);
        y == 0 || y == h - 1 || (ten(x) && y < h / 2) || (mm(x) && y < h / 6)
    })
}

/// "F" orientation glyph near the left end of the label (canvas column 0) plus a border.
fn orientation(t: &TapeSpec, length: u32) -> Bitmap {
    let h = u32::from(t.print_pins);
    Bitmap::from_fn(length, t.print_pins, |x, y| {
        let y = u32::from(y);
        let border = x == 0 || x + 1 == length || y == 0 || y + 1 == h;
        let stem = (8..12).contains(&x) && (8..h - 8).contains(&y);
        let top = (8..40).contains(&x) && (8..12).contains(&y);
        let mid = (8..30).contains(&x) && (h / 2 - 2..h / 2 + 2).contains(&y);
        border || stem || top || mid
    })
}

/// Checkerboard text stand-in: blocks of 5×7 "glyphs".
fn text_like(t: &TapeSpec, length: u32) -> Bitmap {
    Bitmap::from_fn(length, t.print_pins, |x, y| {
        let (cx, cy) = (x % 12, u32::from(y) % 16);
        cx < 10 && cy < 14 && (cx / 2 + cy / 2) % 2 == 0
    })
}

struct Golden {
    name: &'static str,
    model: Model,
    tape: &'static str,
    pages: Vec<Bitmap>,
    opts: JobOptions,
}

fn goldens() -> Vec<Golden> {
    let t = |m: Model, id: &str| tape(prof(m), id);
    let p710_24 = t(Model::PtP710bt, "tze128-24");
    let p710_12 = t(Model::PtP710bt, "tze128-12");
    let d = JobOptions::default;
    vec![
        Golden {
            name: "p710bt_24mm_tiny",
            model: Model::PtP710bt,
            tape: "tze128-24",
            pages: vec![tiny_24mm(p710_24)],
            opts: d(),
        },
        Golden {
            name: "p710bt_24mm_blank",
            model: Model::PtP710bt,
            tape: "tze128-24",
            pages: vec![blank(p710_24, 64)],
            opts: d(),
        },
        Golden {
            name: "p710bt_24mm_ruler",
            model: Model::PtP710bt,
            tape: "tze128-24",
            pages: vec![ruler(p710_24, 360)],
            opts: d(),
        },
        Golden {
            name: "p710bt_24mm_orientation",
            model: Model::PtP710bt,
            tape: "tze128-24",
            pages: vec![orientation(p710_24, 180)],
            opts: d(),
        },
        Golden {
            name: "p710bt_12mm_text",
            model: Model::PtP710bt,
            tape: "tze128-12",
            pages: vec![text_like(p710_12, 120)],
            opts: d(),
        },
        Golden {
            name: "p710bt_24mm_two_copies",
            model: Model::PtP710bt,
            tape: "tze128-24",
            pages: vec![tiny_24mm(p710_24), tiny_24mm(p710_24)],
            opts: d(),
        },
        Golden {
            name: "p710bt_24mm_chain",
            model: Model::PtP710bt,
            tape: "tze128-24",
            pages: vec![tiny_24mm(p710_24)],
            opts: JobOptions { chain: true, ..d() },
        },
        Golden {
            name: "p710bt_24mm_mirror_nocut",
            model: Model::PtP710bt,
            tape: "tze128-24",
            pages: vec![tiny_24mm(p710_24)],
            opts: JobOptions {
                mirror: true,
                cut: CutMode::None,
                ..d()
            },
        },
        Golden {
            name: "p710bt_12mm_uncompressed",
            model: Model::PtP710bt,
            tape: "tze128-12",
            pages: vec![text_like(p710_12, 24)],
            opts: JobOptions {
                compression: Some(Compression::None),
                ..d()
            },
        },
        Golden {
            name: "e560bt_24mm_single",
            model: Model::PtE560bt,
            tape: "tze128-24",
            pages: vec![orientation(t(Model::PtE560bt, "tze128-24"), 40)],
            opts: d(),
        },
        Golden {
            name: "e560bt_12mm_two_labels",
            model: Model::PtE560bt,
            tape: "tze128-12",
            pages: vec![
                text_like(t(Model::PtE560bt, "tze128-12"), 24),
                text_like(t(Model::PtE560bt, "tze128-12"), 2),
            ],
            opts: d(),
        },
        Golden {
            name: "p910bt_24mm_single",
            model: Model::PtP910bt,
            tape: "tze560-24",
            pages: vec![orientation(t(Model::PtP910bt, "tze560-24"), 80)],
            opts: d(),
        },
        Golden {
            name: "p910bt_36mm_two_pages",
            model: Model::PtP910bt,
            tape: "tze560-36",
            pages: vec![
                ruler(t(Model::PtP910bt, "tze560-36"), 72),
                text_like(t(Model::PtP910bt, "tze560-36"), 36),
            ],
            opts: d(),
        },
        Golden {
            name: "p300bt_12mm_single",
            model: Model::PtP300bt,
            tape: "p300-12",
            pages: vec![text_like(t(Model::PtP300bt, "p300-12"), 36)],
            opts: d(),
        },
        Golden {
            name: "p750w_24mm_half_cut",
            model: Model::PtP750w,
            tape: "tze128-24",
            pages: vec![tiny_24mm(p710_24), tiny_24mm(p710_24)],
            opts: JobOptions {
                cut: CutMode::HalfCut,
                ..d()
            },
        },
    ]
}

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
}

fn render_golden(g: &Golden, job: &EncodedJob) -> String {
    let mut s = String::new();
    writeln!(
        s,
        "# Golden job stream `{}` (format: tests/golden/README.md).",
        g.name
    )
    .unwrap();
    writeln!(
        s,
        "# model = {:?}, tape = {:?}, pages = {}, lines = {:?}",
        g.model,
        g.tape,
        g.pages.len(),
        job.page_lines
    )
    .unwrap();
    writeln!(s, "# options = {:?}", g.opts).unwrap();
    writeln!(
        s,
        "# Raster lines in send order = {:?} (PROTOCOL.md §5.3; [HW] PT-P710BT).",
        prof(g.model).feed_order()
    )
    .unwrap();
    writeln!(
        s,
        "# Generated by `UPDATE_GOLDEN=1 cargo test -p ptouch --test encode`; review every change."
    )
    .unwrap();
    writeln!(s, "\n# -- preamble --").unwrap();
    for l in annotate(&job.preamble) {
        writeln!(s, "{l}").unwrap();
    }
    for (i, page) in job.pages.iter().enumerate() {
        writeln!(s, "\n# -- page {} --", i + 1).unwrap();
        for l in annotate(page) {
            writeln!(s, "{l}").unwrap();
        }
    }
    if !job.epilogue.is_empty() {
        writeln!(s, "\n# -- epilogue (after the last page completed) --").unwrap();
        for l in annotate(&job.epilogue) {
            writeln!(s, "{l}").unwrap();
        }
    }
    s
}

#[test]
fn goldens_match() {
    let update = std::env::var_os("UPDATE_GOLDEN").is_some_and(|v| v == "1");
    let dir = golden_dir();
    let mut failures = Vec::new();
    for g in goldens() {
        let p = prof(g.model);
        let t = tape(p, g.tape);
        let pages: Vec<&Bitmap> = g.pages.iter().collect();
        let job = encode(p, t, &pages, &g.opts);
        let bytes = job.to_bytes();
        let path = dir.join(format!("{}.hex", g.name));
        let text = render_golden(&g, &job);
        // The rendered form must round-trip through the parser.
        assert_eq!(parse_hex(&text), bytes, "{}: hex renderer", g.name);
        if update {
            std::fs::write(&path, text).unwrap();
            continue;
        }
        let Ok(expected) = std::fs::read_to_string(&path) else {
            failures.push(format!(
                "{}: missing {} (run with UPDATE_GOLDEN=1)",
                g.name,
                path.display()
            ));
            continue;
        };
        let expected = parse_hex(&expected);
        if let Err(e) = std::panic::catch_unwind(|| assert_bytes(&bytes, &expected, g.name)) {
            let msg = e
                .downcast_ref::<String>()
                .cloned()
                .unwrap_or_else(|| format!("{}: mismatch", g.name));
            failures.push(msg);
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn golden_hex_parser() {
    assert_eq!(
        parse_hex("00*3 1B 40 # comment 47\n\n# 5A\n1a"),
        [0, 0, 0, 0x1B, 0x40, 0x1A]
    );
}

// ---------------------------------------------------------------------------------------------
// Round trip through the virtual printer's offline decoder (WP5)
// ---------------------------------------------------------------------------------------------

#[cfg(feature = "virtual")]
#[test]
fn decode_job_round_trip() {
    use ptouch::virtual_printer::decode_job;
    let cases: &[(Model, &str, JobOptions)] = &[
        (Model::PtP710bt, "tze128-24", JobOptions::default()),
        (Model::PtP710bt, "tze128-12", JobOptions::default()),
        (
            Model::PtP710bt,
            "tze128-3.5",
            JobOptions {
                compression: Some(Compression::None),
                ..JobOptions::default()
            },
        ),
        (Model::PtE560bt, "tze128-18", JobOptions::default()),
        (Model::PtP910bt, "tze560-24", JobOptions::default()),
        (Model::PtP910bt, "tze560-36", JobOptions::default()),
        (Model::PtP300bt, "p300-12", JobOptions::default()),
    ];
    for (model, id, opts) in cases {
        let p = prof(*model);
        let t = tape(p, id);
        let a = text_like(t, 50);
        let b = bitmap(t, 2, |x, y| x == 1 && y % 2 == 0); // padded to the minimum
        let job = encode(p, t, &[&a, &b], opts);
        let decoded = decode_job(p, &job.to_bytes())
            .unwrap_or_else(|e| panic!("{model:?} {id}: decode failed: {e}"));
        assert!(
            decoded.violations.is_empty(),
            "{model:?} {id}: {:?}",
            decoded.violations
        );
        let expected = [a.clone(), b.padded_to(job.page_lines[1], 0)];
        assert_eq!(decoded.pages, expected, "{model:?} {id}");
    }
}

// ---------------------------------------------------------------------------------------------
// Review regressions: page-length and margin limits (PROTOCOL.md §3.2.4, §5.6), page count
// ---------------------------------------------------------------------------------------------

#[test]
fn heat_shrink_is_capped_at_500_mm() {
    let p = p710();
    let t = tape(p, "hs2-128-23.6");
    let opts = JobOptions::default();
    assert_eq!(encode(p, t, &[&blank(t, 3543)], &opts).page_lines, [3543]);
    for len in [3544, 7000] {
        assert_eq!(
            encode_job(p, t, &[&blank(t, len)], &opts),
            Err(Error::TooLong {
                dots: len,
                max: 3543
            }),
            "{len} lines on heat-shrink"
        );
    }
}

#[test]
fn high_res_maximum_matches_d1() {
    let p = p710();
    let t = tape(p, "tze128-24");
    let opts = JobOptions {
        high_resolution: true,
        ..JobOptions::default()
    };
    assert_eq!(encode(p, t, &[&blank(t, 14172)], &opts).page_lines, [14172]);
    assert_eq!(
        encode_job(p, t, &[&blank(t, 14173)], &opts),
        Err(Error::TooLong {
            dots: 14173,
            max: 14172
        })
    );
}

#[test]
fn feed_margin_upper_bound() {
    let p = p710();
    let t = tape(p, "tze128-24");
    let page = blank(t, 1);
    let with_margin = |dots: u16, high_resolution: bool| JobOptions {
        feed_margin_dots: Some(dots),
        high_resolution,
        ..JobOptions::default()
    };
    // 0 and the documented maximum are accepted.
    assert!(encode_job(p, t, &[&page], &with_margin(0, false)).is_ok());
    assert!(encode_job(p, t, &[&page], &with_margin(900, false)).is_ok());
    assert!(encode_job(p, t, &[&page], &with_margin(1800, true)).is_ok());
    for (dots, hr) in [(901, false), (5000, false), (u16::MAX, false), (1801, true)] {
        assert!(
            matches!(
                encode_job(p, t, &[&page], &with_margin(dots, hr)),
                Err(Error::InvalidInput(_))
            ),
            "margin {dots} (high-res {hr})"
        );
    }
}

#[test]
fn too_many_pages_are_rejected() {
    let p = p710();
    let t = tape(p, "tze128-24");
    let page = blank(t, 1);
    let pages = vec![&page; ptouch::encode::MAX_PAGES + 1];
    assert!(matches!(
        encode_job(p, t, &pages, &JobOptions::default()),
        Err(Error::InvalidInput(_))
    ));
}

#[test]
fn high_res_job_is_flagged_for_the_preflight() {
    let p = p710();
    let t = tape(p, "tze128-24");
    let page = blank(t, 10);
    assert!(!encode(p, t, &[&page], &JobOptions::default()).high_resolution);
    let hr = JobOptions {
        high_resolution: true,
        ..JobOptions::default()
    };
    assert!(encode(p, t, &[&page], &hr).high_resolution);
}

#[test]
fn prepare_pages_stretches_and_mirrors() {
    let p = p710();
    let t = tape(p, "tze128-24");
    let page = bitmap(t, 3, |x, _| x == 0);
    let opts = JobOptions {
        high_resolution: true,
        mirror: true,
        ..JobOptions::default()
    };
    // Hardware mirror on the P710BT: only stretched, option kept.
    let (pages, resolved) =
        ptouch::prepare_pages(p, t, std::slice::from_ref(&page), &opts).unwrap();
    assert_eq!(pages[0].length(), 6);
    assert!(pages[0].get(0, 0) && pages[0].get(1, 0) && !pages[0].get(2, 0));
    assert!(resolved.mirror);
    // No hardware mirror (D610BT): software mirror, option cleared.
    let d610 = prof(Model::PtD610bt);
    assert!(!d610.caps.mirror);
    let soft = JobOptions {
        mirror: true,
        ..JobOptions::default()
    };
    let (pages, resolved) =
        ptouch::prepare_pages(d610, t, std::slice::from_ref(&page), &soft).unwrap();
    // 3 lines is the D610BT minimum at the default margin: reversed, not padded.
    assert_eq!(d610.min_lines(t.default_feed_dots, false), 3);
    assert_eq!(pages[0], page.reversed());
    assert!(pages[0].get(2, 0) && !pages[0].get(0, 0));
    assert!(!resolved.mirror);
    // No high-resolution mode (P300BT).
    assert_eq!(
        ptouch::prepare_pages(prof(Model::PtP300bt), t, &[page], &opts).map(|_| ()),
        Err(Error::Unsupported("high-resolution printing"))
    );
}

/// Raster lines (`G`/`Z`) of page `index`, in send order.
fn raster_lines(job: &EncodedJob, index: usize) -> Vec<Vec<u8>> {
    split(&job.pages[index])
        .into_iter()
        .filter(|c| c[0] == 0x47 || c[0] == 0x5A)
        .map(<[u8]>::to_vec)
        .collect()
}

#[test]
fn software_mirror_sends_canvas_order_and_prints_the_mirror_image() {
    // PROTOCOL.md §5.3: a normal page is sent last column first; the software mirror reverses
    // the canvas, so its lines go out in canvas order, which prints the mirror image of the
    // readable label (what `ESC i M` bit 7 does on models that have it).
    let d610 = prof(Model::PtD610bt);
    let t = tape(d610, "tze128-24");
    let page = bitmap(t, 40, |x, y| x < 3 || (x == 39 && y == 0));
    let normal = encode(d610, t, &[&page], &JobOptions::default());
    let soft = JobOptions {
        mirror: true,
        ..JobOptions::default()
    };
    let (pages, resolved) =
        ptouch::prepare_pages(d610, t, std::slice::from_ref(&page), &soft).unwrap();
    let mirrored = encode(d610, t, &[&pages[0]], &resolved);
    let mut forward = raster_lines(&normal, 0);
    forward.reverse();
    assert_eq!(raster_lines(&mirrored, 0), forward);

    // The virtual printer models the physical label.
    #[cfg(feature = "virtual")]
    {
        let decoded = ptouch::decode_job(d610, &normal.to_bytes()).unwrap();
        assert_eq!(
            decoded.pages,
            std::slice::from_ref(&page),
            "normal job reads like the canvas"
        );
        let decoded = ptouch::decode_job(d610, &mirrored.to_bytes()).unwrap();
        assert_eq!(
            decoded.pages,
            [page.reversed()],
            "mirrored job reads mirrored"
        );
    }
}

#[test]
fn padded_software_mirror_is_the_exact_mirror_of_the_padded_label() {
    // A page shorter than the model minimum: encode_job pads the normal label at the canvas
    // end (right end of the label). The software mirror must put that padding at the left
    // end, i.e. print the exact mirror image of the padded normal label, as the hardware
    // mirror does.
    for (model, margin) in [
        (Model::PtD610bt, Some(0)),
        (Model::PtD610bt, None),
        (Model::PtE560bt, None),
    ] {
        let d610 = prof(model);
        assert!(!d610.caps.mirror);
        let t = tape(d610, "tze128-24");
        let page = bitmap(t, 2, |x, y| x == 0 || y < 4);
        let base = JobOptions {
            feed_margin_dots: margin,
            ..JobOptions::default()
        };
        let normal = encode(d610, t, &[&page], &base);
        let lines = normal.page_lines[0];
        assert!(lines > page.length(), "the page is padded");
        let soft = JobOptions {
            mirror: true,
            ..base.clone()
        };
        let (pages, resolved) =
            ptouch::prepare_pages(d610, t, std::slice::from_ref(&page), &soft).unwrap();
        let mirrored = encode(d610, t, &[&pages[0]], &resolved);
        assert_eq!(mirrored.page_lines, [lines], "no further padding");
        let mut forward = raster_lines(&normal, 0);
        forward.reverse();
        assert_eq!(raster_lines(&mirrored, 0), forward);

        #[cfg(feature = "virtual")]
        {
            let padded = page.padded_to(lines, 0);
            let decoded = ptouch::decode_job(d610, &normal.to_bytes()).unwrap();
            assert_eq!(decoded.pages, std::slice::from_ref(&padded));
            let decoded = ptouch::decode_job(d610, &mirrored.to_bytes()).unwrap();
            assert_eq!(
                decoded.pages,
                [padded.reversed()],
                "exact mirror, padding at the left"
            );
        }
    }
    // Without padding allowed, the software-mirrored short page is still rejected.
    let d610 = prof(Model::PtD610bt);
    let t = tape(d610, "tze128-24");
    let page = bitmap(t, 2, |x, _| x == 0);
    let strict = JobOptions {
        mirror: true,
        feed_margin_dots: Some(0),
        pad_short_pages: false,
        ..JobOptions::default()
    };
    let (pages, resolved) =
        ptouch::prepare_pages(d610, t, std::slice::from_ref(&page), &strict).unwrap();
    assert_eq!(pages[0].length(), 2);
    assert!(matches!(
        ptouch::encode_job(d610, t, &[&pages[0]], &resolved),
        Err(Error::TooShort { .. })
    ));
}

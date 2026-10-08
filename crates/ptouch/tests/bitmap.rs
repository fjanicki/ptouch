//! `Bitmap` layout, transforms, PBM I/O and `LabelRaster` composition (WP3).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use proptest::prelude::*;
use ptouch::model::{Geometry, TapeKind};
use ptouch::{Bitmap, Dither, Error, LabelRaster, ModuleMatrix, ToneAdjust};

const GLYPH_P1: &[u8] = include_bytes!("fixtures/pbm/glyph_f_p1.pbm");
const GLYPH_P4: &[u8] = include_bytes!("fixtures/pbm/glyph_f_p4.pbm");

/// Canvas rows of the glyph fixture.
const GLYPH: [&str; 7] = [
    "111110000001",
    "100000000011",
    "100000000101",
    "111100001001",
    "100000010001",
    "100000100001",
    "100001000001",
];

fn glyph() -> Bitmap {
    Bitmap::from_fn(12, 7, |x, y| {
        GLYPH[usize::from(y)].as_bytes()[x as usize] == b'1'
    })
}

fn ink_count(b: &Bitmap) -> usize {
    b.as_packed().iter().map(|v| v.count_ones() as usize).sum()
}

fn arb_bitmap() -> impl Strategy<Value = Bitmap> {
    (0u32..40, 0u16..40).prop_flat_map(|(l, h)| {
        let n = l as usize * Bitmap::stride_for(h);
        proptest::collection::vec(any::<u8>(), n)
            .prop_map(move |data| Bitmap::from_packed(l, h, data).unwrap())
    })
}

// ---------- layout ----------

#[test]
fn layout_is_line_major_msb_first() {
    let mut b = Bitmap::new(3, 10);
    assert_eq!(b.stride(), 2);
    assert_eq!(b.as_packed().len(), 6);
    b.set(0, 0, true);
    b.set(1, 9, true);
    b.set(2, 8, true);
    assert_eq!(b.as_packed(), [0x80, 0x00, 0x00, 0x40, 0x00, 0x80]);
    assert_eq!(b.line(1), [0x00, 0x40]);
    assert!(b.line(3).is_empty());
}

#[test]
fn from_packed_clears_padding_and_checks_length() {
    let b = Bitmap::from_packed(2, 10, vec![0xFF; 4]).unwrap();
    assert_eq!(b.as_packed(), [0xFF, 0xC0, 0xFF, 0xC0]);
    assert_eq!(
        Bitmap::from_packed(2, 10, vec![0; 5]),
        Err(Error::DataLength {
            expected: 4,
            got: 5
        })
    );
}

#[test]
fn get_set_bounds() {
    let mut b = Bitmap::new(4, 4);
    b.set(4, 0, true);
    b.set(0, 4, true);
    assert!(b.is_blank());
    assert!(!b.get(4, 0) && !b.get(0, 4) && !b.get(u32::MAX, u16::MAX));
    b.set(3, 3, true);
    assert!(b.get(3, 3));
    b.set(3, 3, false);
    assert!(b.is_blank());
}

#[test]
fn from_fn_and_from_luma_use_canvas_coordinates() {
    let g = glyph();
    assert_eq!(g.length(), 12);
    assert_eq!(g.height(), 7);
    // Line 0 = canvas column 0: all 7 rows set.
    assert_eq!(g.line(0), [0xFE]);
    // Line 11 = last column: all set.
    assert_eq!(g.line(11), [0xFE]);
    // Line 1: rows 0 and 3.
    assert_eq!(g.line(1), [0b1001_0000]);

    let luma: Vec<u8> = GLYPH
        .iter()
        .flat_map(|r| r.bytes().map(|c| if c == b'1' { 10 } else { 240 }))
        .collect();
    assert_eq!(Bitmap::from_luma(&luma, 12, 7, 128).unwrap(), g);
    assert!(Bitmap::from_luma(&luma, 12, 7, 0).unwrap().is_blank());
}

#[test]
fn blank_queries() {
    let mut b = Bitmap::new(10, 5);
    assert!(b.is_blank());
    assert_eq!(b.trim_blank(), None);
    b.set(3, 2, true);
    b.set(7, 4, true);
    assert!(!b.is_blank());
    assert!(b.is_line_blank(0) && !b.is_line_blank(3) && b.is_line_blank(99));
    assert_eq!(b.trim_blank(), Some((3, 7)));
    assert_eq!(Bitmap::new(0, 0).trim_blank(), None);
}

#[test]
fn crop_and_pad() {
    let g = glyph();
    let c = g.crop_lines(1, 4).unwrap();
    assert_eq!(c.length(), 3);
    assert_eq!(c.line(0), g.line(1));
    assert_eq!(c.line(2), g.line(3));
    assert!(matches!(g.crop_lines(3, 3), Err(Error::InvalidInput(_))));
    assert!(matches!(g.crop_lines(5, 13), Err(Error::InvalidInput(_))));
    assert!(g.crop_lines(0, 12).is_ok());

    let p = g.padded_to(20, 3);
    assert_eq!(p.length(), 20);
    assert!(p.is_line_blank(0) && p.is_line_blank(2));
    assert_eq!(p.line(3), g.line(0));
    assert_eq!(p.line(14), g.line(11));
    assert!(p.is_line_blank(15) && p.is_line_blank(19));
    // lead capped at the padding amount
    let p = g.padded_to(14, 100);
    assert_eq!(p.line(2), g.line(0));
    // already long enough
    assert_eq!(g.padded_to(5, 2), g);
}

#[test]
fn flips_and_rotations() {
    let g = glyph();
    let r = g.reversed();
    assert_eq!(r.line(0), g.line(11));
    assert!(r.get(1, 1) && !r.get(10, 1));
    let f = g.flipped_across();
    for x in 0..12 {
        for y in 0..7 {
            assert_eq!(f.get(x, y), g.get(x, 6 - y));
        }
    }
    let r180 = g.rotated_180();
    assert!(r180.get(11 - 1, 6)); // old (1, 0)
    assert_eq!(r180.rotated_180(), g);

    let cw = g.rotated_cw().unwrap();
    assert_eq!((cw.length(), cw.height()), (7, 12));
    for x in 0..12u32 {
        for y in 0..7u16 {
            assert_eq!(cw.get(u32::from(6 - y), x as u16), g.get(x, y));
        }
    }
    let ccw = g.rotated_ccw().unwrap();
    for x in 0..12u32 {
        for y in 0..7u16 {
            assert_eq!(ccw.get(u32::from(y), (11 - x) as u16), g.get(x, y));
        }
    }
    assert_eq!(cw.rotated_ccw().unwrap(), g);
    assert_eq!(cw.rotated_cw().unwrap(), r180);
    assert!(Bitmap::new(70_000, 1).rotated_cw().is_err());
}

#[test]
fn inverted_keeps_padding_zero() {
    let b = Bitmap::new(2, 10).inverted();
    assert_eq!(b.as_packed(), [0xFF, 0xC0, 0xFF, 0xC0]);
    assert_eq!(b.inverted(), Bitmap::new(2, 10));
}

#[test]
fn blit_or_clips() {
    let src = Bitmap::from_fn(3, 3, |_, _| true);
    let mut dst = Bitmap::new(5, 5);
    dst.blit_or(&src, -1, -2);
    assert!(dst.get(0, 0) && dst.get(1, 0) && !dst.get(2, 0) && !dst.get(0, 1));
    dst.blit_or(&src, 4, 4);
    assert!(dst.get(4, 4));
    assert_eq!(ink_count(&dst), 3);
    dst.blit_or(&src, i64::MAX / 2, i64::MIN / 2);
    dst.blit_or(&src, 100, 0);
    assert_eq!(ink_count(&dst), 3);
}

#[test]
fn print_area_placement() {
    let g = glyph(); // 7 high
    let c = g.centered_across(11);
    assert_eq!(c.height(), 11);
    for x in 0..12 {
        for y in 0..7 {
            assert_eq!(c.get(x, y + 2), g.get(x, y));
        }
        assert!(!c.get(x, 0) && !c.get(x, 1) && !c.get(x, 9) && !c.get(x, 10));
    }
    // Odd difference: extra blank row at the bottom.
    let c = g.centered_across(8);
    assert_eq!(c.line(0), [0xFE]);
    // Taller than the target: centre rows kept.
    let c = g.centered_across(3);
    for x in 0..12 {
        for y in 0..3 {
            assert_eq!(c.get(x, y), g.get(x, y + 2));
        }
    }
    let p = g.placed_across(10, -1);
    assert_eq!(p.get(1, 2), g.get(1, 3));
    assert_eq!(g.centered_across(7), g);
}

#[test]
fn for_tape_uses_print_pins() {
    // `TapeSpec` is `#[non_exhaustive]`: copy any table entry and set the fields the test
    // depends on, so the test does not depend on the generated values (WP1).
    let mut tape = **ptouch::all_media().first().expect("media table");
    tape.geometry = Geometry::Pt128;
    tape.head_pins = 128;
    tape.kind = TapeKind::Tze;
    tape.left_margin_pins = 29;
    tape.print_pins = 70;
    tape.right_margin_pins = 29;
    let b = glyph().for_tape(&tape);
    assert_eq!(b.height(), tape.print_pins);
    assert_eq!(b.length(), 12);
    assert_eq!(ink_count(&b), ink_count(&glyph()));
}

#[test]
fn to_rgba_canvas_order() {
    let mut b = Bitmap::new(2, 2);
    b.set(1, 0, true);
    let rgba = b.to_rgba(0xFFFF00, 0x112233);
    assert_eq!(
        rgba,
        [
            0xFF, 0xFF, 0x00, 0xFF, 0x11, 0x22, 0x33, 0xFF, // row 0
            0xFF, 0xFF, 0x00, 0xFF, 0xFF, 0xFF, 0x00, 0xFF, // row 1
        ]
    );
}

// ---------- PBM ----------

#[test]
fn pbm_fixtures_decode_identically() {
    let p1 = Bitmap::from_pbm(GLYPH_P1).unwrap();
    let p4 = Bitmap::from_pbm(GLYPH_P4).unwrap();
    assert_eq!(p1, glyph());
    assert_eq!(p4, glyph());
}

#[test]
fn to_pbm_format() {
    let pbm = glyph().to_pbm();
    assert!(pbm.starts_with(b"P4\n12 7\n"));
    assert_eq!(pbm.len(), 8 + 7 * 2);
    // Row 0 = 111110000001 → F8 10
    assert_eq!(&pbm[8..10], [0xF8, 0x10]);
    assert_eq!(Bitmap::from_pbm(&pbm).unwrap(), glyph());
}

#[test]
fn pbm_p1_without_spaces_and_with_comments() {
    let b = Bitmap::from_pbm(b"P1 # c\n3 # w\n2\n101\n# mid\n010").unwrap();
    assert!(b.get(0, 0) && !b.get(1, 0) && b.get(2, 0) && b.get(1, 1));
    assert_eq!(ink_count(&b), 3);
}

#[test]
fn pbm_errors() {
    let corrupt = |offset| Error::Corrupt {
        what: "pbm",
        offset,
    };
    assert_eq!(Bitmap::from_pbm(b"P5\n1 1\n\0"), Err(corrupt(0)));
    assert_eq!(Bitmap::from_pbm(b""), Err(corrupt(0)));
    assert_eq!(Bitmap::from_pbm(b"P4"), Err(corrupt(2)));
    assert_eq!(Bitmap::from_pbm(b"P4x"), Err(corrupt(2)));
    assert_eq!(Bitmap::from_pbm(b"P4\n8 \n"), Err(corrupt(6)));
    // Truncated P4 raster (needs 2 bytes).
    assert_eq!(Bitmap::from_pbm(b"P4\n8 2\n\xFF"), Err(corrupt(8)));
    // Missing separator after height.
    assert_eq!(Bitmap::from_pbm(b"P4\n8 2"), Err(corrupt(6)));
    // Truncated / invalid P1.
    assert_eq!(Bitmap::from_pbm(b"P1\n2 2\n1 0 1"), Err(corrupt(12)));
    assert_eq!(Bitmap::from_pbm(b"P1\n2 2\n1 0 2 0"), Err(corrupt(11)));
    assert_eq!(Bitmap::from_pbm(b"P1\n2 1\n1 x 1 1"), Err(corrupt(9)));
}

#[test]
fn pbm_huge_dimensions() {
    assert!(matches!(
        Bitmap::from_pbm(b"P4\n1 70000\n"),
        Err(Error::InvalidInput(_))
    ));
    assert!(matches!(
        Bitmap::from_pbm(b"P4\n4294967296 1\n"),
        Err(Error::InvalidInput(_))
    ));
    assert!(matches!(
        Bitmap::from_pbm(b"P1\n99999999999999999999999 1\n"),
        Err(Error::InvalidInput(_))
    ));
    // Within limits but larger than the data: rejected before allocating.
    assert_eq!(
        Bitmap::from_pbm(b"P4\n4294967295 65535\n\0"),
        Err(Error::Corrupt {
            what: "pbm",
            offset: 21
        })
    );
    assert_eq!(
        Bitmap::from_pbm(b"P1\n4294967295 65535\n0"),
        Err(Error::Corrupt {
            what: "pbm",
            offset: 21
        })
    );
}

proptest! {
    #[test]
    fn transforms_are_involutions(b in arb_bitmap()) {
        prop_assert_eq!(b.reversed().reversed(), b.clone());
        prop_assert_eq!(b.flipped_across().flipped_across(), b.clone());
        prop_assert_eq!(b.inverted().inverted(), b.clone());
        prop_assert_eq!(b.rotated_180().rotated_180(), b.clone());
        prop_assert_eq!(b.rotated_cw().unwrap().rotated_ccw().unwrap(), b);
    }

    #[test]
    fn pbm_roundtrip_p4(b in arb_bitmap()) {
        prop_assert_eq!(Bitmap::from_pbm(&b.to_pbm()).unwrap(), b);
    }

    #[test]
    fn pbm_roundtrip_p1(b in arb_bitmap()) {
        let mut s = format!("P1\n{} {}\n", b.length(), b.height());
        for y in 0..b.height() {
            for x in 0..b.length() {
                s.push(if b.get(x, y) { '1' } else { '0' });
                s.push(' ');
            }
            s.push('\n');
        }
        prop_assert_eq!(Bitmap::from_pbm(s.as_bytes()).unwrap(), b);
    }

    #[test]
    fn from_pbm_never_panics(data in proptest::collection::vec(any::<u8>(), 0..64)) {
        let _ = Bitmap::from_pbm(&data);
        let mut with_header = b"P4\n3 2\n".to_vec();
        with_header.extend_from_slice(&data);
        let _ = Bitmap::from_pbm(&with_header);
    }

    #[test]
    fn trim_blank_bounds(b in arb_bitmap()) {
        match b.trim_blank() {
            None => prop_assert!(b.is_blank()),
            Some((first, last)) => {
                prop_assert!(first <= last && last < b.length());
                prop_assert!(!b.is_line_blank(first) && !b.is_line_blank(last));
                prop_assert!((0..first).all(|x| b.is_line_blank(x)));
                prop_assert!((last + 1..b.length()).all(|x| b.is_line_blank(x)));
            }
        }
    }
}

// ---------- LabelRaster ----------

fn white_rgba(w: u32, h: u32) -> Vec<u8> {
    vec![255; (w * h * 4) as usize]
}

fn paint(rgba: &mut [u8], w: u32, x: u32, y: u32, px: [u8; 4]) {
    let i = ((y * w + x) * 4) as usize;
    rgba[i..i + 4].copy_from_slice(&px);
}

#[test]
fn crisp_3x_block_is_one_dot() {
    let mut r = LabelRaster::new(10, 8);
    let (w, h) = (30, 24);
    let mut rgba = white_rgba(w, h);
    for py in 6..9 {
        for px in 12..15 {
            paint(&mut rgba, w, px, py, [0, 0, 0, 255]);
        }
    }
    r.blit_crisp(&rgba, w, h, 3, 128).unwrap();
    let b = r.finish();
    assert!(b.get(4, 2));
    assert_eq!(ink_count(&b), 1);
}

#[test]
fn crisp_coverage_threshold() {
    // 4 of 9 sub-pixels black → coverage 113: on at threshold 100, off at 128.
    let (w, h) = (3, 3);
    let mut rgba = white_rgba(w, h);
    for (x, y) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
        paint(&mut rgba, w, x, y, [0, 0, 0, 255]);
    }
    let mut r = LabelRaster::new(1, 1);
    r.blit_crisp(&rgba, w, h, 3, 128).unwrap();
    assert!(r.finish().is_blank());
    let mut r = LabelRaster::new(1, 1);
    r.blit_crisp(&rgba, w, h, 3, 100).unwrap();
    assert!(r.finish().get(0, 0));
    // Threshold 0 still needs some ink.
    let mut r = LabelRaster::new(1, 1);
    r.blit_crisp(&white_rgba(3, 3), 3, 3, 3, 0).unwrap();
    assert!(r.finish().is_blank());
    // Transparent pixels count as white.
    let mut r = LabelRaster::new(1, 1);
    r.blit_crisp(&[0, 0, 0, 0], 1, 1, 1, 1).unwrap();
    assert!(r.finish().is_blank());
}

#[test]
fn crisp_validation() {
    let mut r = LabelRaster::new(4, 2);
    assert!(matches!(
        r.blit_crisp(&[], 0, 0, 0, 128),
        Err(Error::InvalidInput(_))
    ));
    assert!(matches!(
        r.blit_crisp(&white_rgba(12, 5), 12, 5, 3, 128),
        Err(Error::InvalidInput(_))
    ));
    assert_eq!(
        r.blit_crisp(&[0; 10], 12, 6, 3, 128),
        Err(Error::DataLength {
            expected: 288,
            got: 10
        })
    );
}

#[test]
fn tone_blit_clips_negative_offsets_and_respects_alpha() {
    let mut r = LabelRaster::new(4, 4);
    let mut rgba = vec![0u8; 3 * 3 * 4]; // opaque black...
    for p in rgba.chunks_exact_mut(4) {
        p[3] = 255;
    }
    rgba[4 * 4 + 3] = 0; // ...except a transparent centre (1, 1)
    r.blit_tone(
        &rgba,
        3,
        3,
        -1,
        -1,
        Dither::default(),
        ToneAdjust::default(),
    )
    .unwrap();
    let b = r.finish();
    // Source (1,1) → dest (0,0) is transparent: untouched.
    assert!(!b.get(0, 0));
    assert!(b.get(1, 0) && b.get(0, 1) && b.get(1, 1));
    assert_eq!(ink_count(&b), 3);
}

#[test]
fn tone_blit_writes_paper_too() {
    let mut r = LabelRaster::new(2, 1);
    r.blit_bitmap(&Bitmap::from_fn(2, 1, |_, _| true), 0, 0);
    r.blit_tone(
        &[255, 255, 255, 255],
        1,
        1,
        1,
        0,
        Dither::FloydSteinberg,
        ToneAdjust::default(),
    )
    .unwrap();
    let b = r.finish();
    assert!(b.get(0, 0) && !b.get(1, 0));
}

#[test]
fn tone_blit_length_mismatch() {
    let mut r = LabelRaster::new(2, 2);
    assert_eq!(
        r.blit_tone(&[0; 3], 1, 1, 0, 0, Dither::Bayer4, ToneAdjust::default()),
        Err(Error::DataLength {
            expected: 4,
            got: 3
        })
    );
}

#[test]
fn codes_are_not_overwritten_by_later_tone_blit() {
    let mut r = LabelRaster::new(20, 20);
    let m = ModuleMatrix {
        width: 2,
        height: 2,
        modules: vec![1, 0, 0, 1],
    };
    r.blit_code(&m, 8, 8, 1, true).unwrap();
    assert!(r.is_protected(4, 4) && r.is_protected(13, 13) && !r.is_protected(3, 4));
    // Black tone image over everything.
    let mut black = vec![0u8; 20 * 20 * 4];
    for p in black.chunks_exact_mut(4) {
        p[3] = 255;
    }
    r.blit_tone(
        &black,
        20,
        20,
        0,
        0,
        Dither::default(),
        ToneAdjust::default(),
    )
    .unwrap();
    r.blit_bitmap(&Bitmap::from_fn(20, 20, |_, _| true), 0, 0);
    let b = r.finish();
    assert!(b.get(8, 8) && !b.get(9, 8) && !b.get(8, 9) && b.get(9, 9));
    // Quiet zone stays white, everything outside it is black.
    assert!(!b.get(4, 4) && !b.get(13, 13) && !b.get(4, 13));
    assert!(b.get(3, 4) && b.get(14, 14));
    assert_eq!(ink_count(&b), 400 - 100 + 2);
}

#[test]
fn code_clears_underlying_ink() {
    let mut r = LabelRaster::new(10, 10);
    r.blit_bitmap(&Bitmap::from_fn(10, 10, |_, _| true), 0, 0);
    let m = ModuleMatrix {
        width: 1,
        height: 1,
        modules: vec![0],
    };
    r.blit_code(&m, 2, 2, 3, false).unwrap();
    let b = r.finish();
    assert_eq!(ink_count(&b), 100 - 9);
    assert!(!b.get(2, 2) && !b.get(4, 4) && b.get(5, 5));
}

#[test]
fn linear_code_quiet_zone_is_horizontal_only() {
    let mut r = LabelRaster::new(40, 10);
    r.blit_bitmap(&Bitmap::from_fn(40, 10, |_, _| true), 0, 0);
    let m = ModuleMatrix {
        width: 3,
        height: 2,
        modules: vec![1, 0, 1, 1, 0, 1],
    };
    r.blit_code(&m, 12, 3, 1, true).unwrap();
    let b = r.finish();
    // Quiet zone: x 2..25, y 3..5 only.
    assert!(!b.get(2, 3) && !b.get(24, 4) && b.get(1, 3) && b.get(25, 3));
    assert!(b.get(12, 2) && b.get(12, 5));
    assert!(b.get(12, 3) && !b.get(13, 3) && b.get(14, 4));
}

#[test]
fn code_clipping_and_module_size() {
    let mut r = LabelRaster::new(6, 6);
    let m = ModuleMatrix {
        width: 2,
        height: 2,
        modules: vec![0, 1, 1, 1],
    };
    r.blit_code(&m, -3, -3, 2, true).unwrap();
    // Only module (1, 1) lands on the raster, at dot (0, 0); the rest is quiet zone.
    let b = r.finish();
    assert!(b.get(0, 0));
    assert!(!b.get(1, 1));
    assert_eq!(ink_count(&b), 1);
}

#[test]
fn code_validation() {
    let mut r = LabelRaster::new(10, 10);
    let m = ModuleMatrix {
        width: 2,
        height: 2,
        modules: vec![1, 0, 0, 1],
    };
    assert!(matches!(
        r.blit_code(&m, 0, 0, 0, false),
        Err(Error::InvalidInput(_))
    ));
    let bad = ModuleMatrix {
        width: 3,
        height: 2,
        modules: vec![1; 5],
    };
    assert!(matches!(
        r.blit_code(&bad, 0, 0, 1, false),
        Err(Error::InvalidInput(_))
    ));
    // Far off-raster is fine (fully clipped).
    r.blit_code(&m, i32::MIN, i32::MAX, 255, true).unwrap();
    assert!(r.finish().is_blank());
}

#[test]
fn blit_bitmap_clips() {
    let mut r = LabelRaster::new(3, 3);
    r.blit_bitmap(&glyph(), -10, -4);
    let b = r.finish();
    for x in 0..2 {
        for y in 0..3 {
            assert_eq!(b.get(x, y), glyph().get(x + 10, y + 4));
        }
    }
}

// Review regressions: caller-chosen sizes and out-of-range lines.

#[test]
fn try_new_rejects_huge_sizes() {
    assert_eq!(Bitmap::try_new(10, 128).unwrap(), Bitmap::new(10, 128));
    assert!(matches!(
        Bitmap::try_new(134_217_728, 128),
        Err(Error::InvalidInput(_))
    ));
    assert!(matches!(
        Bitmap::try_new(u32::MAX, u16::MAX),
        Err(Error::InvalidInput(_))
    ));
    assert!(LabelRaster::try_new(40, 128).is_ok());
    assert!(matches!(
        LabelRaster::try_new(134_217_728, 128),
        Err(Error::InvalidInput(_))
    ));
    let small = Bitmap::new(4, 128);
    assert!(small.stretched_feed(2).is_ok());
    assert!(matches!(
        small.stretched_feed(u32::MAX),
        Err(Error::InvalidInput(_))
    ));
}

#[test]
fn line_out_of_range_is_empty() {
    let b = Bitmap::from_packed(2, 16, vec![0xAB, 0xCD, 0, 0]).unwrap();
    assert_eq!(b.line(0), [0xAB, 0xCD]);
    for x in [2, 0x8000_0000, u32::MAX] {
        assert!(b.line(x).is_empty(), "line({x:#x})");
        assert!(b.is_line_blank(x));
    }
}

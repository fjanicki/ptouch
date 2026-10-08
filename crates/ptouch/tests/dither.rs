//! Tone adjustment, thresholding and dithering (WP3).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use proptest::prelude::*;
use ptouch::dither::{adjust_tone, dither, rgba_to_luma};
use ptouch::{Bitmap, Dither, Error, ToneAdjust};

const ALL: [Dither; 5] = [
    Dither::Threshold { level: 128 },
    Dither::FloydSteinberg,
    Dither::Atkinson,
    Dither::Bayer4,
    Dither::Bayer8,
];

fn id() -> ToneAdjust {
    ToneAdjust::default()
}

#[test]
fn threshold_is_exact() {
    let luma: Vec<u8> = (0..=255).collect();
    for level in [0u8, 1, 127, 128, 200, 255] {
        let bmp = dither(&luma, 256, 1, Dither::Threshold { level }, &id()).unwrap();
        for v in 0..=255u8 {
            assert_eq!(bmp.get(u32::from(v), 0), v < level, "level {level} v {v}");
        }
    }
}

#[test]
fn default_dither_is_threshold_128() {
    assert_eq!(Dither::default(), Dither::Threshold { level: 128 });
}

#[test]
fn solid_inputs_stay_solid() {
    let (w, h) = (37u32, 23u16);
    let n = w as usize * usize::from(h);
    for method in ALL {
        let black = dither(&vec![0; n], w, h, method, &id()).unwrap();
        let white = dither(&vec![255; n], w, h, method, &id()).unwrap();
        assert!(white.is_blank(), "{method:?}");
        assert_eq!(black, Bitmap::from_fn(w, h, |_, _| true), "{method:?}");
    }
}

#[test]
fn canvas_row_major_mapping() {
    // 3 columns × 2 rows; only pixel (x=2, y=1) is black.
    let luma = [255, 255, 255, 255, 255, 0];
    for method in ALL {
        let bmp = dither(&luma, 3, 2, method, &id()).unwrap();
        assert!(bmp.get(2, 1), "{method:?}");
        assert_eq!(bmp.length(), 3);
        assert_eq!(bmp.height(), 2);
    }
}

#[test]
fn bayer4_tile_at_mid_grey() {
    // Ink where luma < (2M + 1) × 8. For luma 128: ink where M ≥ 8.
    // Bayer 4×4 [row][col]: 0 8 2 10 / 12 4 14 6 / 3 11 1 9 / 15 7 13 5.
    let expected: [[bool; 4]; 4] = [
        [false, true, false, true],
        [true, false, true, false],
        [false, true, false, true],
        [true, false, true, false],
    ];
    let bmp = dither(&[128; 16], 4, 4, Dither::Bayer4, &id()).unwrap();
    for (y, row) in expected.iter().enumerate() {
        for (x, &ink) in row.iter().enumerate() {
            assert_eq!(bmp.get(x as u32, y as u16), ink, "({x}, {y})");
        }
    }
    // Luma 64: ink where (2M + 1) × 8 > 64, i.e. M ≥ 4 → 12 of 16 dots.
    let bmp = dither(&[64; 16], 4, 4, Dither::Bayer4, &id()).unwrap();
    let count = (0..4)
        .flat_map(|x| (0..4).map(move |y| (x, y)))
        .filter(|&(x, y)| bmp.get(x, y))
        .count();
    assert_eq!(count, 12);
    assert!(!bmp.get(0, 0) && bmp.get(1, 0) && !bmp.get(2, 2));
}

#[test]
fn bayer_tiles_repeat() {
    let luma = vec![100u8; 16 * 16];
    for (method, n) in [(Dither::Bayer4, 4), (Dither::Bayer8, 8)] {
        let bmp = dither(&luma, 16, 16, method, &id()).unwrap();
        for x in 0..16u32 {
            for y in 0..16u16 {
                assert_eq!(bmp.get(x, y), bmp.get(x % n, y % n as u16));
            }
        }
    }
}

#[test]
fn error_diffusion_mean_tone() {
    // A 50 % grey field comes out close to 50 % ink (Floyd–Steinberg) and with fewer dots for
    // Atkinson (which drops 1/4 of the error).
    let (w, h) = (64u32, 64u16);
    let luma = vec![128u8; w as usize * usize::from(h)];
    let count = |m| {
        let b = dither(&luma, w, h, m, &id()).unwrap();
        (0..w)
            .flat_map(|x| (0..h).map(move |y| (x, y)))
            .filter(|&(x, y)| b.get(x, y))
            .count()
    };
    let fs = count(Dither::FloydSteinberg);
    assert!((1900..=2200).contains(&fs), "fs ink {fs}");
    let at = count(Dither::Atkinson);
    assert!(at <= 2200, "atkinson ink {at}");
}

#[test]
fn floyd_steinberg_first_pixels() {
    // Hand-computed: row [100, 100, 100].
    // p0 = 100 → ink, e = 100, right += 100*7/16 = 43 → p1 = 143 → paper, e = −112,
    // right += −112*7/16 = −49 → p2 = 51 → ink.
    let bmp = dither(&[100, 100, 100], 3, 1, Dither::FloydSteinberg, &id()).unwrap();
    assert!(bmp.get(0, 0));
    assert!(!bmp.get(1, 0));
    assert!(bmp.get(2, 0));
}

#[test]
fn atkinson_first_pixels() {
    // Row [100, 100, 100, 100]: p0 = 100 → ink, e = 100, +12 to x+1 and x+2.
    // p1 = 112 → ink, e = 112, +14 → p2 = 100 + 12 + 14 = 126 → ink, e = 126, +15.
    // p3 = 100 + 14 + 15 = 129 → paper.
    let bmp = dither(&[100; 4], 4, 1, Dither::Atkinson, &id()).unwrap();
    assert!(bmp.get(0, 0) && bmp.get(1, 0) && bmp.get(2, 0));
    assert!(!bmp.get(3, 0));
}

#[test]
fn dithering_is_deterministic() {
    let luma: Vec<u8> = (0..50 * 30).map(|i| ((i * 37) % 256) as u8).collect();
    for method in ALL {
        let a = dither(&luma, 50, 30, method, &id()).unwrap();
        let b = dither(&luma, 50, 30, method, &id()).unwrap();
        assert_eq!(a, b);
    }
}

#[test]
fn length_mismatch() {
    assert_eq!(
        dither(&[0; 5], 3, 2, Dither::Atkinson, &id()),
        Err(Error::DataLength {
            expected: 6,
            got: 5
        })
    );
    assert_eq!(
        rgba_to_luma(&[0; 7], 1, 2),
        Err(Error::DataLength {
            expected: 8,
            got: 7
        })
    );
    assert_eq!(
        Bitmap::from_luma(&[0; 7], 4, 2, 128),
        Err(Error::DataLength {
            expected: 8,
            got: 7
        })
    );
}

#[test]
fn rgba_to_luma_values() {
    let rgba = [
        0, 0, 0, 0, // transparent black → white
        0, 0, 0, 255, // opaque black
        255, 255, 255, 255, // white
        255, 0, 0, 255, // red: 299 × 255 / 1000 = 76
        0, 255, 0, 255, // green: 149
        0, 0, 255, 255, // blue: 29
        0, 0, 0, 128, // half-transparent black over white ≈ 127
    ];
    let luma = rgba_to_luma(&rgba, 7, 1).unwrap();
    assert_eq!(luma, [255, 0, 255, 76, 149, 29, 127]);
}

#[test]
fn identity_tone_adjust() {
    let mut luma: Vec<u8> = (0..=255).collect();
    adjust_tone(&mut luma, &ToneAdjust::default());
    assert_eq!(luma, (0..=255).collect::<Vec<u8>>());
    assert!(ToneAdjust::default().is_identity());
}

#[test]
fn invert_and_brightness() {
    let mut luma = vec![0u8, 100, 255];
    adjust_tone(
        &mut luma,
        &ToneAdjust {
            invert: true,
            ..ToneAdjust::default()
        },
    );
    assert_eq!(luma, [255, 155, 0]);

    let mut luma = vec![0u8, 100, 250];
    adjust_tone(
        &mut luma,
        &ToneAdjust {
            brightness: 10, // + 25
            ..ToneAdjust::default()
        },
    );
    assert_eq!(luma, [25, 125, 255]);
}

#[test]
fn contrast() {
    let full = ToneAdjust {
        contrast: 100,
        ..ToneAdjust::default()
    };
    let mut luma = vec![0u8, 127, 128, 255];
    adjust_tone(&mut luma, &full);
    assert_eq!(luma, [0, 0, 255, 255]);

    let flat = ToneAdjust {
        contrast: -100,
        ..ToneAdjust::default()
    };
    let mut luma = vec![0u8, 127, 128, 255];
    adjust_tone(&mut luma, &flat);
    assert_eq!(luma, [128, 128, 128, 128]);

    let half = ToneAdjust {
        contrast: 50, // ×2 around 128
        ..ToneAdjust::default()
    };
    let mut luma = vec![100u8, 128, 150, 250];
    adjust_tone(&mut luma, &half);
    assert_eq!(luma, [72, 128, 172, 255]);
}

#[test]
fn gamma_matches_float_reference() {
    for g in [10u16, 45, 50, 80, 150, 220, 400, 1000] {
        let mut luma: Vec<u8> = (0..=255).collect();
        adjust_tone(
            &mut luma,
            &ToneAdjust {
                gamma_x100: g,
                ..ToneAdjust::default()
            },
        );
        for (v, &out) in luma.iter().enumerate() {
            let reference = 255.0 * (v as f64 / 255.0).powf(100.0 / f64::from(g));
            assert!(
                (f64::from(out) - reference).abs() <= 1.0,
                "gamma {g}: {v} → {out}, expected ≈ {reference:.2}"
            );
        }
    }
}

#[test]
fn gamma_is_clamped() {
    let run = |g| {
        let mut luma: Vec<u8> = (0..=255).collect();
        adjust_tone(
            &mut luma,
            &ToneAdjust {
                gamma_x100: g,
                ..ToneAdjust::default()
            },
        );
        luma
    };
    assert_eq!(run(0), run(10));
    assert_eq!(run(5000), run(1000));
}

proptest! {
    #[test]
    fn tone_adjust_is_monotonic(b in -100i8..=100, c in -100i8..=99, g in 10u16..=1000) {
        let mut luma: Vec<u8> = (0..=255).collect();
        adjust_tone(&mut luma, &ToneAdjust { brightness: b, contrast: c, gamma_x100: g, invert: false });
        prop_assert!(luma.windows(2).all(|w| w[0] <= w[1]));
    }

    #[test]
    fn dither_never_panics(
        w in 0u32..20,
        h in 0u16..20,
        seed in any::<u64>(),
        m in 0usize..5,
    ) {
        let n = w as usize * usize::from(h);
        let luma: Vec<u8> = (0..n).map(|i| (seed.wrapping_mul(i as u64 + 1) >> 24) as u8).collect();
        let bmp = dither(&luma, w, h, ALL[m], &ToneAdjust::default()).unwrap();
        prop_assert_eq!(bmp.length(), w);
        prop_assert_eq!(bmp.height(), h);
    }
}

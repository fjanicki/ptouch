//! PackBits (PROTOCOL.md §5.5) vectors and properties (WP3).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use proptest::prelude::*;
use ptouch::{Error, packbits_decode, packbits_encode};

fn enc(line: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    packbits_encode(line, &mut out);
    out
}

fn hex(s: &str) -> Vec<u8> {
    s.split_whitespace()
        .map(|b| u8::from_str_radix(b, 16).unwrap())
        .collect()
}

#[test]
fn brother_doc_example() {
    let mut line = vec![0u8; 8];
    line.extend(hex("22 22 23 BA BF A2 22 2B"));
    let out = enc(&line);
    assert_eq!(out, hex("F9 00 FF 22 05 23 BA BF A2 22 2B"));
    assert_eq!(packbits_decode(&out, 16).unwrap(), line);
}

#[test]
fn architecture_vector_twenty_zeros() {
    let mut line = vec![0u8; 20];
    line.extend(hex("22 22 23 BA BF A2 22 2B"));
    let out = enc(&line);
    assert_eq!(out, hex("ED 00 FF 22 05 23 BA BF A2 22 2B"));
    assert_eq!(packbits_decode(&out, 28).unwrap(), line);
}

#[test]
fn blank_line() {
    assert_eq!(enc(&[0; 16]), hex("F1 00"));
    assert_eq!(enc(&[0; 70]), hex("BB 00"));
    assert_eq!(packbits_decode(&hex("F1 00"), 16).unwrap(), vec![0; 16]);
}

#[test]
fn incompressible_line_is_one_literal_run() {
    let line: Vec<u8> = (0u8..16).collect();
    let out = enc(&line);
    assert_eq!(out.len(), 17);
    assert_eq!(out[0], 0x0F);
    assert_eq!(&out[1..], &line[..]);
}

#[test]
fn literal_fallback_when_runs_would_be_longer() {
    // Naive encoding: 00 01 | FF 02 | 00 03 = 6 bytes > 4 → one literal run (5 bytes).
    assert_eq!(enc(&hex("01 02 02 03")), hex("03 01 02 02 03"));
}

#[test]
fn p710bt_12mm_full_black_line() {
    let line = hex("00 00 00 07 FF FF FF FF FF FF FF FF E0 00 00 00");
    assert_eq!(enc(&line), hex("FE 00 00 07 F9 FF 00 E0 FE 00"));
}

#[test]
fn full_black_line() {
    assert_eq!(enc(&[0xFF; 16]), hex("F1 FF"));
}

#[test]
fn long_repeat_is_split_at_128() {
    let out = enc(&[0xAA; 200]);
    assert_eq!(out, hex("81 AA B9 AA"));
    assert_eq!(packbits_decode(&out, 200).unwrap(), vec![0xAA; 200]);
}

#[test]
fn decoder_skips_0x80() {
    assert_eq!(packbits_decode(&hex("80 FF 01 80"), 2).unwrap(), vec![1, 1]);
}

#[test]
fn decoder_errors() {
    let corrupt = |offset| Error::Corrupt {
        what: "packbits",
        offset,
    };
    // Truncated literal (header promises 3 bytes, 2 present).
    assert_eq!(packbits_decode(&hex("02 01 02"), 3), Err(corrupt(0)));
    // Truncated repeat (no data byte).
    assert_eq!(packbits_decode(&hex("00 01 FF"), 3), Err(corrupt(2)));
    // Overrun.
    assert_eq!(packbits_decode(&hex("F1 00"), 15), Err(corrupt(0)));
    assert_eq!(packbits_decode(&hex("00 01 00 02"), 1), Err(corrupt(2)));
    // Underrun.
    assert_eq!(packbits_decode(&hex("FE 00"), 4), Err(corrupt(2)));
    assert_eq!(packbits_decode(&[], 1), Err(corrupt(0)));
}

#[test]
fn decoder_does_not_preallocate_from_expected() {
    // A huge `expected` with tiny input must fail cleanly, not abort on allocation.
    assert!(packbits_decode(&hex("F1 00"), usize::MAX).is_err());
}

proptest! {
    #[test]
    fn roundtrip(line in proptest::collection::vec(any::<u8>(), 1..=128)) {
        let out = enc(&line);
        prop_assert_eq!(packbits_decode(&out, line.len()).unwrap(), line);
    }

    #[test]
    fn roundtrip_run_heavy(line in proptest::collection::vec(prop_oneof![Just(0u8), Just(0xFF), any::<u8>()], 1..=128)) {
        let out = enc(&line);
        prop_assert_eq!(packbits_decode(&out, line.len()).unwrap(), line);
    }

    #[test]
    fn size_bound(line in proptest::collection::vec(any::<u8>(), 1..=128)) {
        prop_assert!(enc(&line).len() <= line.len() + 1);
    }

    #[test]
    fn size_bound_long(line in proptest::collection::vec(any::<u8>(), 1..=1000)) {
        let out = enc(&line);
        prop_assert!(out.len() <= line.len() + line.len().div_ceil(128));
        prop_assert_eq!(packbits_decode(&out, line.len()).unwrap(), line);
    }

    #[test]
    fn never_emits_0x80_header(line in proptest::collection::vec(any::<u8>(), 1..=128)) {
        let out = enc(&line);
        let mut i = 0;
        while i < out.len() {
            let h = out[i];
            prop_assert_ne!(h, 0x80);
            i += if h < 0x80 { usize::from(h) + 2 } else { 2 };
        }
    }

    #[test]
    fn deterministic(line in proptest::collection::vec(any::<u8>(), 0..=128)) {
        prop_assert_eq!(enc(&line), enc(&line));
    }

    #[test]
    fn decode_never_panics(data in proptest::collection::vec(any::<u8>(), 0..=300), expected in 0usize..=512) {
        if let Ok(out) = packbits_decode(&data, expected) {
            prop_assert_eq!(out.len(), expected);
        }
    }
}

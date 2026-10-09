//! Barcode / QR / DataMatrix module matrices (`fast_qr` 0.14.0, `barcoders` 2.0.0,
//! `datamatrix` 0.3.3).
//!
//! Matrices are whole modules; the renderer scales them by an integer `moduleDots` in
//! `Raster.blitCode`, so bars and QR modules stay crisp at 180 dpi. Linear codes have
//! `height = 1`: `blitCode` paints `moduleDots` rows per matrix row, so for a linear code of
//! `bar` dots the caller repeats the row `ceil(bar / moduleDots)` times (all rows equal ⇒ the
//! core still treats it as linear: 10-module side quiet zones, none above/below).

use barcoders::sym::code128::Code128;
use barcoders::sym::ean13::EAN13;
use datamatrix::{DataMatrix, SymbolList};
use fast_qr::{ECL, QRBuilder};
use tsify::Ts;
use wasm_bindgen::prelude::*;

use crate::dto::{CodeSpec, ModuleMatrix, QrEcc};
use crate::error::{BindError, from_ts, js_err, ts};

/// Encodes a QR / Code 128 / EAN-13 / DataMatrix symbol into a module matrix for
/// `Raster.blitCode`.
///
/// # Errors
/// `INVALID_INPUT` (bad shape, empty data, data too long for QR or DataMatrix, non-ASCII
/// Code 128, bad EAN-13 digits or check digit), with a message the UI can show next to the
/// field.
#[wasm_bindgen(js_name = encodeCode)]
pub fn encode_code(spec: Ts<CodeSpec>) -> Result<Ts<ModuleMatrix>, JsValue> {
    let spec = from_ts(&spec)?;
    ts(&encode(&spec).map_err(js_err)?)
}

/// Plain-Rust encoder behind [`encode_code`].
///
/// # Errors
/// `INVALID_INPUT` (see [`encode_code`]).
pub fn encode(spec: &CodeSpec) -> Result<ModuleMatrix, BindError> {
    match spec {
        CodeSpec::Qr { data, ecc } => qr(data, ecc.unwrap_or_default()),
        CodeSpec::Code128 { data } => {
            let syntax = code128_syntax(data)?;
            let bars = Code128::new(syntax)
                .map_err(|_| BindError::invalid("Code 128 cannot encode this text"))?
                .encode();
            Ok(linear(bars))
        }
        CodeSpec::Ean13 { data } => {
            let digits = data.trim();
            if !(digits.len() == 12 || digits.len() == 13)
                || !digits.bytes().all(|b| b.is_ascii_digit())
            {
                return Err(BindError::invalid(
                    "EAN-13 needs 12 digits (or 13 with the check digit)",
                ));
            }
            let code = EAN13::new(digits).map_err(|e| match e {
                barcoders::error::Error::Checksum => {
                    BindError::invalid("EAN-13 check digit is wrong")
                }
                _ => BindError::invalid("EAN-13 needs 12 digits (or 13 with the check digit)"),
            })?;
            Ok(linear(code.encode()))
        }
        CodeSpec::Datamatrix { data } => datamatrix(data),
    }
}

/// Square ECC 200 symbol, finder/timing border included, no quiet zone. Latin-1 text is
/// encoded as is; anything else gets the UTF-8 ECI (`encode_str`), which some scanners ignore.
fn datamatrix(data: &str) -> Result<ModuleMatrix, BindError> {
    if data.is_empty() {
        return Err(BindError::invalid("DataMatrix data is empty"));
    }
    let code = DataMatrix::encode_str(data, SymbolList::default().enforce_square())
        .map_err(|_| BindError::invalid("too much data for a DataMatrix code"))?;
    let bitmap = code.bitmap();
    let (w, h) = (bitmap.width(), bitmap.height());
    let mut modules = vec![0u8; w * h];
    for (x, y) in bitmap.pixels() {
        if let Some(m) = modules.get_mut(y * w + x) {
            *m = 1;
        }
    }
    Ok(ModuleMatrix {
        width: u32::try_from(w).unwrap_or(0),
        height: u32::try_from(h).unwrap_or(0),
        modules,
    })
}

/// One-row matrix from a bar pattern (1 = bar).
fn linear(bars: Vec<u8>) -> ModuleMatrix {
    ModuleMatrix {
        width: u32::try_from(bars.len()).unwrap_or(u32::MAX),
        height: 1,
        modules: bars,
    }
}

fn qr(data: &str, ecc: QrEcc) -> Result<ModuleMatrix, BindError> {
    if data.is_empty() {
        return Err(BindError::invalid("QR code data is empty"));
    }
    let ecl = match ecc {
        QrEcc::L => ECL::L,
        QrEcc::M => ECL::M,
        QrEcc::Q => ECL::Q,
        QrEcc::H => ECL::H,
    };
    let code = QRBuilder::new(data.as_bytes())
        .ecl(ecl)
        .build()
        .map_err(|_| BindError::invalid("too much data for a QR code"))?;
    let size = code.size;
    let modules: Vec<u8> = code
        .data
        .get(..size * size)
        .unwrap_or_default()
        .iter()
        .map(|m| u8::from(m.value()))
        .collect();
    let side = u32::try_from(size).unwrap_or(0);
    Ok(ModuleMatrix {
        width: side,
        height: side,
        modules,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Set {
    A,
    B,
    C,
}

impl Set {
    /// barcoders' code-set marker (start or switch).
    fn marker(self) -> char {
        match self {
            Self::A => 'À',
            Self::B => 'Ɓ',
            Self::C => 'Ć',
        }
    }
}

/// Converts plain ASCII text into barcoders' Code 128 syntax (code-set markers), choosing sets
/// automatically: C for runs of ≥ 4 digits at the start/end or ≥ 6 in the middle (or an
/// all-digit text of ≥ 2), A for control characters, B otherwise.
///
/// # Errors
/// `INVALID_INPUT` for empty or non-ASCII text.
pub fn code128_syntax(data: &str) -> Result<String, BindError> {
    if data.is_empty() {
        return Err(BindError::invalid("Code 128 data is empty"));
    }
    if !data.is_ascii() {
        return Err(BindError::invalid(
            "Code 128 supports plain ASCII characters only",
        ));
    }
    let bytes = data.as_bytes();
    let n = bytes.len();
    let mut out = String::with_capacity(n + 4);
    let mut set: Option<Set> = None;
    let mut i = 0;
    while i < n {
        let run = bytes[i..].iter().take_while(|b| b.is_ascii_digit()).count();
        let at_start = i == 0;
        let at_end = i + run == n;
        let use_c = if at_start && at_end {
            run >= 2
        } else if at_start || at_end {
            run >= 4
        } else {
            run >= 6
        };
        if use_c {
            let even = run & !1;
            if set != Some(Set::C) {
                out.push(Set::C.marker());
                set = Some(Set::C);
            }
            out.push_str(&data[i..i + even]);
            i += even;
            continue;
        }
        let b = bytes[i];
        let needed = match b {
            0..=31 => Set::A,
            96..=127 => Set::B,
            _ => match set {
                Some(Set::A) => Set::A,
                _ => Set::B,
            },
        };
        if set != Some(needed) {
            out.push(needed.marker());
            set = Some(needed);
        }
        // barcoders spells DEL (0x7F) in set B as U+00F7.
        out.push(if b == 0x7F { '\u{00F7}' } else { char::from(b) });
        i += 1;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;

    const STOP: &str = "1100011101011";

    fn bits(m: &ModuleMatrix) -> String {
        m.modules.iter().map(|b| char::from(b'0' + b)).collect()
    }

    fn c128(data: &str) -> ModuleMatrix {
        encode(&CodeSpec::Code128 { data: data.into() }).unwrap()
    }

    #[test]
    fn code128_set_selection() {
        assert_eq!(code128_syntax("Hello").unwrap(), "ƁHello");
        assert_eq!(code128_syntax("1234").unwrap(), "Ć1234");
        assert_eq!(code128_syntax("12").unwrap(), "Ć12");
        assert_eq!(code128_syntax("123").unwrap(), "Ć12Ɓ3");
        assert_eq!(code128_syntax("12345").unwrap(), "Ć1234Ɓ5");
        assert_eq!(code128_syntax("AB123").unwrap(), "ƁAB123");
        assert_eq!(code128_syntax("AB1234").unwrap(), "ƁABĆ1234");
        assert_eq!(code128_syntax("A123456B").unwrap(), "ƁAĆ123456ƁB");
        assert_eq!(code128_syntax("A12345B").unwrap(), "ƁA12345B");
        assert_eq!(code128_syntax("\tX").unwrap(), "À\tX");
        assert!(code128_syntax("").is_err());
        assert_eq!(code128_syntax("é").unwrap_err().code(), "INVALID_INPUT");
    }

    #[test]
    fn code128_known_vectors() {
        // "1234": START-C (105) 12 34, checksum (105 + 12 + 2·34) % 103 = 82, STOP.
        let m = c128("1234");
        assert_eq!(m.height, 1);
        assert_eq!(m.width, 11 * 4 + 13);
        let s = bits(&m);
        assert_eq!(&s[..11], "11010011100"); // START C
        assert_eq!(&s[11..22], "10110011100"); // 12
        assert_eq!(&s[22..33], "10001011000"); // 34
        assert_eq!(&s[33..44], "10010011110"); // 82
        assert!(s.ends_with(STOP));

        // "Hi": START-B (104) H(40) i(73); checksum (104 + 40 + 2·73) % 103 = 84.
        let s = bits(&c128("Hi"));
        assert_eq!(&s[..11], "11010010000");
        assert_eq!(&s[11..22], "11000101000"); // H
        assert_eq!(&s[22..33], "10000110100"); // i
        assert_eq!(&s[33..44], "10011110100"); // 84
        assert!(s.ends_with(STOP));

        // DEL and control characters are encodable.
        assert!(
            encode(&CodeSpec::Code128 {
                data: "a\u{7f}".into()
            })
            .is_ok()
        );
        assert!(
            encode(&CodeSpec::Code128 {
                data: "A\u{1}".into()
            })
            .is_ok()
        );
    }

    #[test]
    fn ean13_vectors() {
        // 400638133393 → check digit 1 (a well-known EAN-13).
        let a = encode(&CodeSpec::Ean13 {
            data: "400638133393".into(),
        })
        .unwrap();
        let b = encode(&CodeSpec::Ean13 {
            data: "4006381333931".into(),
        })
        .unwrap();
        assert_eq!(a, b);
        assert_eq!(a.width, 95);
        assert_eq!(a.height, 1);
        let s = bits(&a);
        assert_eq!(&s[..3], "101");
        assert_eq!(&s[45..50], "01010");
        assert_eq!(&s[92..], "101");
        // Right-hand digit 1 (check digit, R code) = 1100110 just before the end guard.
        assert_eq!(&s[85..92], "1100110");
        let e = encode(&CodeSpec::Ean13 {
            data: "4006381333932".into(),
        })
        .unwrap_err();
        assert_eq!(e.code(), "INVALID_INPUT");
        assert!(e.message().contains("check digit"));
        assert!(
            encode(&CodeSpec::Ean13 {
                data: "12345".into()
            })
            .is_err()
        );
        assert!(
            encode(&CodeSpec::Ean13 {
                data: "40063813339x".into()
            })
            .is_err()
        );
    }

    fn dm(data: &str) -> ModuleMatrix {
        encode(&CodeSpec::Datamatrix { data: data.into() }).unwrap()
    }

    fn dm_decode(m: &ModuleMatrix) -> Vec<u8> {
        let pixels: Vec<bool> = m.modules.iter().map(|&b| b == 1).collect();
        DataMatrix::decode(&pixels, m.width as usize).unwrap()
    }

    #[test]
    fn datamatrix_known_vector() {
        // "A1" = 2 ASCII codewords (66, 50) + 1 pad → the smallest symbol, 10×10 (ISO/IEC 16022
        // table 7: 3 data + 5 error codewords).
        let m = dm("A1");
        assert_eq!((m.width, m.height), (10, 10));
        assert_eq!(m.modules.len(), 100);
        assert_eq!(dm_decode(&m), b"A1");
        // "Hello, World!" needs 13 data codewords → 16×16.
        let m = dm("Hello, World!");
        assert_eq!((m.width, m.height), (16, 16));
        assert_eq!(dm_decode(&m), b"Hello, World!");
    }

    #[test]
    fn datamatrix_finder_pattern() {
        for data in ["A1", "https://fjanicki.github.io/ptouch/", &"7".repeat(300)] {
            let m = dm(data);
            let (w, h) = (m.width as usize, m.height as usize);
            assert_eq!(w, h, "square symbols only");
            let at = |x: usize, y: usize| m.modules[y * w + x];
            for i in 0..h {
                assert_eq!(at(0, i), 1, "left column solid");
                assert_eq!(at(i, h - 1), 1, "bottom row solid");
                // Timing: dark on even columns of the top row, dark on odd rows of the right
                // column (row 0 is dark too, as part of the top row).
                assert_eq!(at(i, 0), u8::from(i % 2 == 0), "top row timing");
                if i > 0 {
                    assert_eq!(at(w - 1, i), u8::from(i % 2 == 1), "right column timing");
                }
            }
        }
    }

    #[test]
    fn datamatrix_round_trips() {
        let cases = [
            "0123456789",
            "WIFI:T:WPA;S:Home;P:secret;;",
            "Café Ø", // Latin-1 → encoded without ECI
            "A-0001",
        ];
        for data in cases {
            let latin1 = datamatrix::data::utf8_to_latin1(data).unwrap();
            assert_eq!(dm_decode(&dm(data)), latin1, "{data}");
        }
        // Non-Latin-1 text gets the UTF-8 ECI; the crate's decoder does not read ECIs, so only
        // check that a valid square symbol comes out.
        let m = dm("日本語");
        assert_eq!(m.width, m.height);
        // Larger symbols carry extra alignment patterns (32×32 and up) and still decode.
        let long = "x".repeat(200);
        let m = dm(&long);
        assert!(m.width >= 32);
        assert_eq!(dm_decode(&m), long.as_bytes());
    }

    #[test]
    fn datamatrix_errors() {
        let e = encode(&CodeSpec::Datamatrix {
            data: String::new(),
        })
        .unwrap_err();
        assert_eq!(e.code(), "INVALID_INPUT");
        let e = encode(&CodeSpec::Datamatrix {
            data: "x".repeat(5000),
        })
        .unwrap_err();
        assert_eq!(e.code(), "INVALID_INPUT");
        assert!(e.message().contains("too much data"));
    }

    #[test]
    fn qr_vectors() {
        let m = encode(&CodeSpec::Qr {
            data: "HELLO".into(),
            ecc: None,
        })
        .unwrap();
        assert_eq!((m.width, m.height), (21, 21)); // version 1
        assert_eq!(m.modules.len(), 441);
        // Finder pattern top-left: 7 dark, then a light separator.
        let row = |y: usize| -> String {
            m.modules[y * 21..y * 21 + 8]
                .iter()
                .map(|b| char::from(b'0' + b))
                .collect()
        };
        assert_eq!(row(0), "11111110");
        assert_eq!(row(1), "10000010");
        assert_eq!(row(2), "10111010");
        // Timing pattern on row 6 between the finders alternates.
        let timing: String = (8..13)
            .map(|x| char::from(b'0' + m.modules[6 * 21 + x]))
            .collect();
        assert_eq!(timing, "10101");

        let url = "https://fjanicki.github.io/ptouch/";
        let low = encode(&CodeSpec::Qr {
            data: url.into(),
            ecc: Some(QrEcc::L),
        })
        .unwrap();
        let high = encode(&CodeSpec::Qr {
            data: url.into(),
            ecc: Some(QrEcc::H),
        })
        .unwrap();
        assert!(high.width > low.width);
        assert!(
            encode(&CodeSpec::Qr {
                data: String::new(),
                ecc: None
            })
            .is_err()
        );
        let huge = "x".repeat(4000);
        let e = encode(&CodeSpec::Qr {
            data: huge,
            ecc: None,
        })
        .unwrap_err();
        assert_eq!(e.code(), "INVALID_INPUT");
    }
}

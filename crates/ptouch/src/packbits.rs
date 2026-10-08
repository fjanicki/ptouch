//! TIFF PackBits line compression, Brother variant (WP3).
//!
//! # Contract (PROTOCOL.md §5.5)
//! - Repeat run of `c` bytes (2 ≤ c ≤ 128): header `(1 − c) as i8` (`0xFF`…`0x81`), then the
//!   byte. Literal run of `c` bytes (1 ≤ c ≤ 128): header `c − 1` (`0x00`…`0x7F`), then the
//!   bytes. `0x80` is never emitted; the decoder treats it as a no-op (TIFF) and continues.
//! - [`packbits_encode`] appends the encoding of the **full** line (margins included) to
//!   `out`. If the encoding would be longer than `line.len()` bytes, it appends a single
//!   literal run instead (`(W−1)` + W bytes; for W = 16: `0F` + 16 bytes = 17 bytes).
//!   Lines longer than 128 bytes cannot fit in one literal run; their fallback is a sequence
//!   of maximal (128-byte) literal runs.
//! - Deterministic: the encoder output is frozen by golden tests, so the run-splitting rule is
//!   part of the contract: runs of ≥ 2 equal bytes become repeat runs; everything else is
//!   collected into literal runs (max 128).
//! - Test vectors (ARCHITECTURE.md §8.1, PROTOCOL.md §5.5):
//!   - `00×8 22 22 23 BA BF A2 22 2B` → `F9 00 FF 22 05 23 BA BF A2 22 2B`
//!   - `00×20 22 22 23 BA BF A2 22 2B` → `ED 00 FF 22 05 23 BA BF A2 22 2B`
//!   - `00×16` → `F1 00`; 16 distinct bytes → `0F` + 16 bytes
//!   - 12 mm P710BT full-black line `00 00 00 07 FF×8 E0 00 00 00` → `FE 00 00 07 F9 FF 00 E0 FE 00`
//! - [`packbits_decode`] never reads out of bounds and never allocates more than `expected`.
//!
//! # Size bound
//! For a line of `W` bytes the encoding is at most `W + ceil(W / 128)` bytes (`W + 1` for
//! every real head line, W ≤ 128).
//!
//! # Example
//! ```
//! use ptouch::{packbits_decode, packbits_encode};
//!
//! let line = [0x00, 0x00, 0x00, 0x07, 0xFF, 0xFF, 0xFF, 0xFF,
//!             0xFF, 0xFF, 0xFF, 0xFF, 0xE0, 0x00, 0x00, 0x00];
//! let mut out = Vec::new();
//! packbits_encode(&line, &mut out);
//! assert_eq!(out, [0xFE, 0x00, 0x00, 0x07, 0xF9, 0xFF, 0x00, 0xE0, 0xFE, 0x00]);
//! assert_eq!(packbits_decode(&out, line.len()).unwrap(), line);
//! ```

use alloc::vec::Vec;

use crate::error::Error;

/// Maximum bytes covered by one run (literal or repeat).
const MAX_RUN: usize = 128;

/// Length of the run of bytes equal to `data[0]` at the start of `data`, capped at
/// [`MAX_RUN`]. Returns 0 for an empty slice.
fn repeat_len(data: &[u8]) -> usize {
    match data.first() {
        Some(&b) => data.iter().take(MAX_RUN).take_while(|&&x| x == b).count(),
        None => 0,
    }
}

/// Header byte of a literal run of `len` bytes (1..=128).
fn literal_header(len: usize) -> u8 {
    // len ∈ 1..=128 → 0x00..=0x7F
    (len.saturating_sub(1) & 0x7F) as u8
}

/// Header byte of a repeat run of `len` bytes (2..=128): `(1 − len) as i8`.
fn repeat_header(len: usize) -> u8 {
    // len ∈ 2..=128 → 257 − len ∈ 0x81..=0xFF
    (257usize.saturating_sub(len) & 0xFF) as u8
}

/// Appends `data` as a sequence of literal runs of at most 128 bytes each.
fn push_literals(data: &[u8], out: &mut Vec<u8>) {
    for chunk in data.chunks(MAX_RUN) {
        out.push(literal_header(chunk.len()));
        out.extend_from_slice(chunk);
    }
}

/// Appends the PackBits encoding of `line` to `out` (see module docs).
///
/// An empty `line` appends nothing.
pub fn packbits_encode(line: &[u8], out: &mut Vec<u8>) {
    let start = out.len();
    let mut i = 0;
    // Start of the literal run being collected, if any.
    let mut lit_start = 0;
    while i < line.len() {
        let rest = line.get(i..).unwrap_or(&[]);
        let run = repeat_len(rest);
        if run >= 2 {
            push_literals(line.get(lit_start..i).unwrap_or(&[]), out);
            out.push(repeat_header(run));
            out.push(rest.first().copied().unwrap_or(0));
            i += run;
            lit_start = i;
        } else {
            i += 1;
        }
    }
    push_literals(line.get(lit_start..).unwrap_or(&[]), out);

    // Literal fallback (PROTOCOL.md §5.5): never longer than the raw line plus headers.
    if out.len() - start > line.len() {
        out.truncate(start);
        push_literals(line, out);
    }
}

/// Decodes PackBits `data` that must expand to exactly `expected` bytes.
///
/// A `0x80` header is skipped (TIFF no-op).
///
/// # Errors
/// [`Error::Corrupt`] (`what = "packbits"`) if the data is truncated, overruns `expected`, or
/// ends short of it. `offset` is the position of the run header that is truncated or overruns,
/// or `data.len()` when the data ends short of `expected`.
pub fn packbits_decode(data: &[u8], expected: usize) -> Result<Vec<u8>, Error> {
    let corrupt = |offset| Error::Corrupt {
        what: "packbits",
        offset,
    };
    // Every input byte expands to at most 128 output bytes; never pre-allocate more than the
    // input can produce, nor more than `expected`.
    let mut out = Vec::with_capacity(expected.min(data.len().saturating_mul(MAX_RUN)));
    let mut i = 0;
    while let Some(&header) = data.get(i) {
        match header {
            0x80 => i += 1,
            0x00..=0x7F => {
                let n = usize::from(header) + 1;
                let bytes = data.get(i + 1..i + 1 + n).ok_or(corrupt(i))?;
                if out.len() + n > expected {
                    return Err(corrupt(i));
                }
                out.extend_from_slice(bytes);
                i += 1 + n;
            }
            0x81..=0xFF => {
                let n = 257 - usize::from(header);
                let &byte = data.get(i + 1).ok_or(corrupt(i))?;
                if out.len() + n > expected {
                    return Err(corrupt(i));
                }
                out.resize(out.len() + n, byte);
                i += 2;
            }
        }
    }
    if out.len() == expected {
        Ok(out)
    } else {
        Err(corrupt(data.len()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn enc(line: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        packbits_encode(line, &mut out);
        out
    }

    #[test]
    fn headers() {
        assert_eq!(literal_header(1), 0x00);
        assert_eq!(literal_header(128), 0x7F);
        assert_eq!(repeat_header(2), 0xFF);
        assert_eq!(repeat_header(128), 0x81);
    }

    #[test]
    fn appends_without_touching_existing_output() {
        let mut out = vec![0xAA];
        packbits_encode(&[0; 16], &mut out);
        assert_eq!(out, [0xAA, 0xF1, 0x00]);
    }

    #[test]
    fn empty_line() {
        assert!(enc(&[]).is_empty());
        assert_eq!(packbits_decode(&[], 0).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn long_line_fallback_is_chunked() {
        // 300 distinct-ish bytes (no two equal neighbours): 3 literal runs.
        let line: Vec<u8> = (0..300u32).map(|i| (i % 251) as u8).collect();
        let out = enc(&line);
        assert_eq!(out.len(), 300 + 3);
        assert_eq!(packbits_decode(&out, 300).unwrap(), line);
    }
}

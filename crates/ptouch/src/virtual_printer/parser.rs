//! Incremental parser for the host → printer command stream (WP5).
//!
//! # Contract
//! - Accepts the stream in arbitrary chunks ([`JobParser::push`]) and yields [`Command`]s in
//!   order ([`JobParser::next_command`]); a command split across chunks is held until complete.
//!   The sequence of commands does not depend on how the stream was chunked, except that a run
//!   of `00` bytes is reported once it is terminated by another byte (or by
//!   [`JobParser::finish`]). The bytes of an unterminated `00` run are counted, not buffered,
//!   so a long run costs O(1) memory and is never rescanned.
//! - Recognises every command in PROTOCOL.md §3.1 and §3.4; the optional §3.4 commands are
//!   framed to their documented length and reported as [`Command::NonPrint`]. Unknown `ESC`
//!   sequences become [`Command::Unknown`] (with the bytes consumed so far) instead of stalling.
//! - Tracks compression mode (`4D nn`, [`JobParser::compression`]); `G` lines are reported with
//!   their raw payload and the caller decompresses with [`crate::packbits_decode`].
//! - Never panics on arbitrary input (fuzz target `JobParser`). Memory is bounded by the
//!   longest command (`47` + 65 535 bytes) plus the unparsed tail of the last push; a pending
//!   `00` run is only a counter.

use alloc::vec::Vec;

use crate::bitmap::Bitmap;

/// One parsed host command.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Command {
    /// A run of `00` bytes.
    Invalidate(usize),
    /// `1B 40`.
    Initialize,
    /// `1B 69 53`.
    StatusRequest,
    /// `1B 69 61 n`.
    CommandMode(u8),
    /// `1B 69 21 n`.
    StatusNotification(u8),
    /// `1B 69 7A` + 10 bytes.
    PrintInfo([u8; 10]),
    /// `1B 69 4D n`.
    VariousMode(u8),
    /// `1B 69 41 n`.
    CutEvery(u8),
    /// `1B 69 4B n`.
    AdvancedMode(u8),
    /// `1B 69 64 nL nH`.
    Margin(u16),
    /// `1B 69 6B 63 nL nH`.
    Copies(u16),
    /// `1B 69 70 n`.
    StoredUpPrint(u8),
    /// `1B 69 4C n1 n2 n3`.
    LineControl([u8; 3]),
    /// `1B 69 43 n` + 3n bytes; the payload is `n` followed by the `3n` colour bytes.
    ColorInfo(Vec<u8>),
    /// `1B 69 18`.
    Cancel,
    /// `4D n`.
    Compression(u8),
    /// `47 nL nH data`.
    RasterLine(Vec<u8>),
    /// `5A`.
    ZeroLine,
    /// `0C`.
    Print,
    /// `1A`.
    PrintLast,
    /// A recognised optional command from PROTOCOL.md §3.4 (firmware/serial/battery queries,
    /// job ID, after-job command, …), with all its bytes. It plays no part in printing.
    NonPrint(Vec<u8>),
    /// Unrecognised bytes.
    Unknown(Vec<u8>),
}

/// A protocol rule broken by the host, as a real printer would punish it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Violation {
    /// A command arrived while a page was printing.
    CommandWhilePrinting {
        /// Byte offset in the stream.
        offset: usize,
    },
    /// Ink outside the tape's print area.
    DataOutsidePrintArea {
        /// 1-based page.
        page: u16,
        /// Raster line within the page.
        line: u32,
    },
    /// Line count differs from `ESC i z` n5–n8.
    LineCountMismatch {
        /// 1-based page.
        page: u16,
        /// Declared.
        declared: u32,
        /// Received.
        received: u32,
    },
    /// `5A` received while compression is off.
    ZeroLineWithoutCompression {
        /// Byte offset in the stream.
        offset: usize,
    },
    /// Raster data before `ESC i z` on a page.
    MissingPrintInfo {
        /// 1-based page.
        page: u16,
    },
    /// Bytes that are not a known command.
    UnknownCommand {
        /// Byte offset in the stream.
        offset: usize,
    },
    /// A command the model does not support (e.g. `ESC i A` or half cut on PT-P710BT).
    UnsupportedCommand {
        /// Byte offset in the stream.
        offset: usize,
        /// Which command / option.
        what: &'static str,
    },
    /// A command in the wrong place (e.g. `ESC i z` after raster data of the same page).
    OutOfOrder {
        /// Byte offset in the stream.
        offset: usize,
        /// What was out of order.
        what: &'static str,
    },
    /// A raster line that does not decode to exactly one head line (bad PackBits, wrong raw
    /// length). The line is treated as blank.
    MalformedRasterLine {
        /// 1-based page.
        page: u16,
        /// Raster line within the page.
        line: u32,
    },
    /// `ESC i z` n9 does not match the page's position for the model's `page_command`
    /// (PROTOCOL.md §3.2.1).
    PagePosition {
        /// 1-based page.
        page: u16,
        /// n9 sent.
        got: u8,
        /// n9 expected.
        expected: u8,
    },
}

/// Incremental command parser.
#[derive(Debug, Clone, Default)]
pub struct JobParser {
    buf: Vec<u8>,
    /// Stream offset of `buf[start]`.
    offset: usize,
    /// First unparsed byte in `buf`.
    start: usize,
    /// Last `4D n` value seen (0 until one is seen).
    compression: u8,
    /// Length of an unterminated `00` run that was taken out of `buf` (already counted in
    /// `offset`).
    pending_zeros: usize,
}

/// Outcome of trying to parse at the head of the buffer.
enum Parse {
    /// More bytes are needed.
    Incomplete,
    /// A command of `len` bytes.
    Done(Command, usize),
}

impl JobParser {
    /// Empty parser.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends stream bytes.
    pub fn push(&mut self, bytes: &[u8]) {
        // Compact before growing so the buffer never holds already-parsed bytes for long.
        if self.start > 0 {
            self.buf.drain(..self.start);
            self.start = 0;
        }
        self.buf.extend_from_slice(bytes);
    }

    /// Next complete command, if any.
    pub fn next_command(&mut self) -> Option<Command> {
        let data = self.buf.get(self.start..)?;
        let zeros = data.iter().take_while(|&&b| b == 0).count();
        if zeros == data.len() {
            // Only zeros (or nothing): count them instead of keeping them buffered.
            self.consume(zeros);
            self.pending_zeros = self.pending_zeros.saturating_add(zeros);
            return None;
        }
        if self.pending_zeros > 0 || zeros > 0 {
            // A non-zero byte terminates the run.
            self.consume(zeros);
            let run = core::mem::take(&mut self.pending_zeros).saturating_add(zeros);
            return Some(Command::Invalidate(run));
        }
        match parse_one(data, false) {
            Parse::Incomplete => None,
            Parse::Done(cmd, len) => {
                self.consume(len);
                if let Command::Compression(n) = cmd {
                    self.compression = n;
                }
                Some(cmd)
            }
        }
    }

    /// Flushes the end of the stream: returns a pending `00` run as [`Command::Invalidate`]
    /// and a truncated command as [`Command::Unknown`] with its bytes. Call it after the last
    /// [`JobParser::next_command`] returned `None` for a complete stream.
    pub fn finish(&mut self) -> Option<Command> {
        if let Some(cmd) = self.next_command() {
            return Some(cmd);
        }
        if self.pending_zeros > 0 {
            return Some(Command::Invalidate(core::mem::take(
                &mut self.pending_zeros,
            )));
        }
        let data = self.buf.get(self.start..)?;
        if data.is_empty() {
            return None;
        }
        match parse_one(data, true) {
            Parse::Done(cmd, len) => {
                self.consume(len);
                Some(cmd)
            }
            Parse::Incomplete => {
                let rest = data.to_vec();
                self.consume(rest.len());
                Some(Command::Unknown(rest))
            }
        }
    }

    /// Stream offset of the start of the next command (the start of a pending `00` run).
    #[must_use]
    pub fn offset(&self) -> usize {
        self.offset.saturating_sub(self.pending_zeros)
    }

    /// Bytes received but not yet returned as a command (a pending `00` run included, although
    /// it is only counted, not buffered).
    #[must_use]
    pub fn pending_bytes(&self) -> usize {
        self.buf
            .len()
            .saturating_sub(self.start)
            .saturating_add(self.pending_zeros)
    }

    /// The last compression mode selected with `4D n` (`0` until one is seen).
    #[must_use]
    pub fn compression(&self) -> u8 {
        self.compression
    }

    fn consume(&mut self, len: usize) {
        self.start = self.start.saturating_add(len).min(self.buf.len());
        self.offset = self.offset.saturating_add(len);
        if self.start == self.buf.len() {
            self.buf.clear();
            self.start = 0;
        }
    }
}

/// Parses one command at the start of `data` (non-empty). `at_end` = no more bytes will come
/// (a trailing `00` run is then complete).
fn parse_one(data: &[u8], at_end: bool) -> Parse {
    let Some(&first) = data.first() else {
        return Parse::Incomplete;
    };
    match first {
        0x00 => {
            let run = data.iter().take_while(|&&b| b == 0).count();
            if run == data.len() && !at_end {
                Parse::Incomplete
            } else {
                Parse::Done(Command::Invalidate(run), run)
            }
        }
        0x1B => parse_esc(data),
        0x4D => fixed(data, 2, |d| Command::Compression(d[1])),
        0x47 => {
            let Some(&[lo, hi]) = data.get(1..3).and_then(|s| <&[u8; 2]>::try_from(s).ok()) else {
                return Parse::Incomplete;
            };
            let len = usize::from(u16::from_le_bytes([lo, hi]));
            match data.get(3..3 + len) {
                Some(payload) => Parse::Done(Command::RasterLine(payload.to_vec()), 3 + len),
                None => Parse::Incomplete,
            }
        }
        0x5A => Parse::Done(Command::ZeroLine, 1),
        0x0C => Parse::Done(Command::Print, 1),
        0x1A => Parse::Done(Command::PrintLast, 1),
        other => Parse::Done(Command::Unknown(alloc::vec![other]), 1),
    }
}

/// A command of exactly `len` bytes built by `f` (which may index `0..len`).
fn fixed(data: &[u8], len: usize, f: impl FnOnce(&[u8]) -> Command) -> Parse {
    match data.get(..len) {
        Some(d) => Parse::Done(f(d), len),
        None => Parse::Incomplete,
    }
}

/// `len` bytes reported as [`Command::NonPrint`].
fn non_print(data: &[u8], len: usize) -> Parse {
    fixed(data, len, |d| Command::NonPrint(d.to_vec()))
}

/// `len` bytes reported as [`Command::Unknown`].
fn unknown(data: &[u8], len: usize) -> Parse {
    fixed(data, len, |d| Command::Unknown(d.to_vec()))
}

fn parse_esc(data: &[u8]) -> Parse {
    let Some(&second) = data.get(1) else {
        return Parse::Incomplete;
    };
    match second {
        0x40 => return Parse::Done(Command::Initialize, 2),
        0x69 => {}
        _ => return unknown(data, 2),
    }
    let Some(&op) = data.get(2) else {
        return Parse::Incomplete;
    };
    match op {
        0x53 => Parse::Done(Command::StatusRequest, 3),
        0x18 => Parse::Done(Command::Cancel, 3),
        0x61 => fixed(data, 4, |d| Command::CommandMode(d[3])),
        0x21 => fixed(data, 4, |d| Command::StatusNotification(d[3])),
        0x4D => fixed(data, 4, |d| Command::VariousMode(d[3])),
        0x41 => fixed(data, 4, |d| Command::CutEvery(d[3])),
        0x4B => fixed(data, 4, |d| Command::AdvancedMode(d[3])),
        0x70 => fixed(data, 4, |d| Command::StoredUpPrint(d[3])),
        0x64 => fixed(data, 5, |d| {
            Command::Margin(u16::from_le_bytes([d[3], d[4]]))
        }),
        0x4C => fixed(data, 6, |d| Command::LineControl([d[3], d[4], d[5]])),
        0x7A => fixed(data, 13, |d| {
            let mut n = [0u8; 10];
            n.copy_from_slice(&d[3..13]);
            Command::PrintInfo(n)
        }),
        0x43 => {
            let Some(&n) = data.get(3) else {
                return Parse::Incomplete;
            };
            let len = 4 + 3 * usize::from(n);
            fixed(data, len, |d| Command::ColorInfo(d[3..].to_vec()))
        }
        0x6B => {
            let Some(&sub) = data.get(3) else {
                return Parse::Incomplete;
            };
            if sub == 0x63 {
                fixed(data, 6, |d| {
                    Command::Copies(u16::from_le_bytes([d[4], d[5]]))
                })
            } else {
                unknown(data, 4)
            }
        }
        // §3.4 optional commands.
        0x11 => parse_esc_i_11(data),
        0x55 => {
            let Some(&sub) = data.get(3) else {
                return Parse::Incomplete;
            };
            match sub {
                // Battery info / media version queries.
                0x6E | 0x76 => non_print(data, 4),
                // Job ID: `1B 69 55 4A` + BE16 length + payload (driver dumps: `00 0C` + 12
                // bytes; SDK: `00 14` + 20 bytes).
                0x4A => {
                    let Some(&[hi, lo]) = data.get(4..6).and_then(|s| <&[u8; 2]>::try_from(s).ok())
                    else {
                        return Parse::Incomplete;
                    };
                    non_print(data, 6 + usize::from(u16::from_be_bytes([hi, lo])))
                }
                // After-job command `1B 69 55 74 1C 00`.
                0x74 => non_print(data, 6),
                _ => unknown(data, 4),
            }
        }
        // Internal model flag `1B 69 46 53` / `1B 69 46 69`.
        0x46 => non_print(data, 4),
        _ => unknown(data, 3),
    }
}

/// `1B 69 11 …`: firmware/media version, serial number, custom record (§3.3–§3.4).
fn parse_esc_i_11(data: &[u8]) -> Parse {
    let Some(&a) = data.get(3) else {
        return Parse::Incomplete;
    };
    match a {
        0x49 => {
            let Some(&b) = data.get(4) else {
                return Parse::Incomplete;
            };
            match b {
                // `1B 69 11 49 56 00 01 00 kk`.
                0x56 => non_print(data, 9),
                // `1B 69 11 49 53` serial number.
                0x53 => non_print(data, 5),
                _ => unknown(data, 5),
            }
        }
        // Custom record `1B 69 11 53 64 01 <len> <data>`.
        0x53 => {
            let Some(&len) = data.get(6) else {
                return Parse::Incomplete;
            };
            non_print(data, 7 + usize::from(len))
        }
        _ => unknown(data, 4),
    }
}

/// A decoded job (offline decode).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedJob {
    /// Every command in order (raster lines included).
    pub commands: Vec<Command>,
    /// Decoded pages in print order (print-area dots only).
    pub pages: Vec<Bitmap>,
    /// Rule violations found.
    pub violations: Vec<Violation>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn parse_all(bytes: &[u8]) -> Vec<Command> {
        let mut p = JobParser::new();
        p.push(bytes);
        let mut out = Vec::new();
        while let Some(c) = p.next_command() {
            out.push(c);
        }
        while let Some(c) = p.finish() {
            out.push(c);
        }
        out
    }

    #[test]
    fn p710bt_page_commands() {
        let mut job = vec![0u8; 100];
        job.extend_from_slice(&[0x1B, 0x40, 0x1B, 0x69, 0x61, 0x01, 0x1B, 0x69, 0x21, 0x00]);
        job.extend_from_slice(&[0x1B, 0x69, 0x7A, 0x84, 0x00, 0x18, 0x00, 3, 0, 0, 0, 0, 0]);
        job.extend_from_slice(&[0x1B, 0x69, 0x4D, 0x40, 0x1B, 0x69, 0x4B, 0x08]);
        job.extend_from_slice(&[0x1B, 0x69, 0x64, 0x0E, 0x00, 0x4D, 0x02]);
        job.extend_from_slice(&[0x5A, 0x47, 0x02, 0x00, 0xF1, 0x00, 0x5A, 0x1A]);
        assert_eq!(
            parse_all(&job),
            vec![
                Command::Invalidate(100),
                Command::Initialize,
                Command::CommandMode(1),
                Command::StatusNotification(0),
                Command::PrintInfo([0x84, 0, 0x18, 0, 3, 0, 0, 0, 0, 0]),
                Command::VariousMode(0x40),
                Command::AdvancedMode(0x08),
                Command::Margin(14),
                Command::Compression(2),
                Command::ZeroLine,
                Command::RasterLine(vec![0xF1, 0x00]),
                Command::ZeroLine,
                Command::PrintLast,
            ]
        );
    }

    #[test]
    fn optional_commands() {
        let cmds = parse_all(&[
            0x1B, 0x69, 0x6B, 0x63, 0x01, 0x00, // copies
            0x1B, 0x69, 0x70, 0x01, // stored-up
            0x1B, 0x69, 0x4C, 0x00, 0x01, 0x01, // line control
            0x1B, 0x69, 0x43, 0x01, 0xFF, 0xFF, 0xFF, // colour
            0x1B, 0x69, 0x18, // cancel
            0x1B, 0x69, 0x55, 0x4A, 0x00, 0x02, 0xAA, 0xBB, // job id
            0x1B, 0x69, 0x55, 0x74, 0x1C, 0x00, // after-job
            0x1B, 0x69, 0x11, 0x49, 0x53, // serial
            0x1B, 0x69, 0x99, // unknown ESC i
            0x1B, 0x77, // unknown ESC
            0xEE, // garbage
        ]);
        assert_eq!(
            cmds,
            vec![
                Command::Copies(1),
                Command::StoredUpPrint(1),
                Command::LineControl([0, 1, 1]),
                Command::ColorInfo(vec![1, 0xFF, 0xFF, 0xFF]),
                Command::Cancel,
                Command::NonPrint(vec![0x1B, 0x69, 0x55, 0x4A, 0x00, 0x02, 0xAA, 0xBB]),
                Command::NonPrint(vec![0x1B, 0x69, 0x55, 0x74, 0x1C, 0x00]),
                Command::NonPrint(vec![0x1B, 0x69, 0x11, 0x49, 0x53]),
                Command::Unknown(vec![0x1B, 0x69, 0x99]),
                Command::Unknown(vec![0x1B, 0x77]),
                Command::Unknown(vec![0xEE]),
            ]
        );
    }

    #[test]
    fn split_commands_are_held() {
        let stream = [
            0x1B, 0x69, 0x7A, 0x84, 0x00, 0x18, 0x00, 3, 0, 0, 0, 0, 0, 0x47, 0x01,
        ];
        let mut p = JobParser::new();
        for b in &stream {
            p.push(core::slice::from_ref(b));
        }
        assert!(matches!(p.next_command(), Some(Command::PrintInfo(_))));
        assert_eq!(p.next_command(), None);
        assert_eq!(p.offset(), 13);
        p.push(&[0x00, 0x00]);
        assert_eq!(p.next_command(), Some(Command::RasterLine(vec![0x00])));
        assert_eq!(p.offset(), stream.len() + 2);
        assert_eq!(p.pending_bytes(), 0);
    }

    #[test]
    fn zero_run_held_until_terminated_or_finished() {
        let mut p = JobParser::new();
        p.push(&[0, 0, 0]);
        assert_eq!(p.next_command(), None);
        p.push(&[0, 0]);
        assert_eq!(p.next_command(), None);
        assert_eq!(p.finish(), Some(Command::Invalidate(5)));
        assert_eq!(p.finish(), None);
        p.push(&[0, 0x1B]);
        assert_eq!(p.next_command(), Some(Command::Invalidate(1)));
        assert_eq!(p.next_command(), None);
        assert_eq!(p.finish(), Some(Command::Unknown(vec![0x1B])));
    }

    #[test]
    fn zero_run_is_not_kept_in_the_buffer() {
        let mut p = JobParser::new();
        for _ in 0..1000 {
            p.push(&[0; 100]);
            assert_eq!(p.next_command(), None);
            assert!(p.buf.is_empty(), "zeros are counted, not buffered");
        }
        assert_eq!(p.finish(), Some(Command::Invalidate(100_000)));
        assert_eq!(p.offset(), 100_000);
    }

    #[test]
    fn compression_is_tracked() {
        let mut p = JobParser::new();
        p.push(&[0x4D, 0x02]);
        assert_eq!(p.compression(), 0);
        assert_eq!(p.next_command(), Some(Command::Compression(2)));
        assert_eq!(p.compression(), 2);
    }
}

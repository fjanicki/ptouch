//! Status frame reassembly (WP2).
//!
//! # Contract
//! - Bytes arrive in arbitrary chunks (RFCOMM delivers e.g. 7 + 25, or several frames at
//!   once). [`StatusFramer::push`] appends; [`StatusFramer::next_frame`] returns complete frames
//!   in order.
//! - Synchronisation: a frame starts at `80 20 42`. Bytes before a header are discarded and
//!   counted in [`StatusFramer::discarded_bytes`]. A trailing `80` or `80 20` is kept, since
//!   it may be the start of a header split across reads. If a header is found but the 32
//!   bytes do not parse, the framer skips one byte and rescans (never loops, never panics).
//! - Truncated frames: a complete `80 20 42` inside the 32-byte window of a candidate means
//!   the candidate was cut short (bytes lost on the link, a dropped partial read). The
//!   candidate is discarded and the framer resyncs on the later header, so the following
//!   frame is not lost and no frame is glued together from two halves. This relies on a
//!   genuine frame never containing `80 20 42` past offset 0: `st[3]` is the series code
//!   (`30`/`41`) and no later field of §4.1 holds that byte sequence.
//! - Bounded memory: garbage is dropped as soon as it is pushed, so the buffer only holds data
//!   from the first header candidate on. If the caller pushes more than
//!   [`StatusFramer::MAX_PENDING`] bytes without draining frames, the oldest bytes are
//!   discarded (and counted) to stay within that bound.
//! - Invariant (WP2 test): the fixture split at every offset yields exactly one frame; a
//!   garbage prefix is discarded and the frame is still found.
//!
//! PROTOCOL.md §2.1 "Reads"; ARCHITECTURE.md §8.1.

use alloc::vec::Vec;

use super::{STATUS_HEADER, STATUS_LEN, Status, parse_status};
use crate::error::Error;

/// Reassembles 32-byte status frames from a chunked byte stream, resyncing on `80 20 42`.
///
/// ```
/// use ptouch::StatusFramer;
///
/// let mut frame = [0u8; 32];
/// frame[..5].copy_from_slice(&[0x80, 0x20, 0x42, 0x30, 0x76]);
///
/// let mut framer = StatusFramer::new();
/// framer.push(&[0xAA, 0xBB]); // line noise
/// framer.push(&frame[..7]);
/// assert!(framer.next_frame().is_none()); // incomplete
/// framer.push(&frame[7..]);
/// let status = framer.next_frame().unwrap().unwrap();
/// assert_eq!(status.model_code, 0x76);
/// assert_eq!(framer.discarded_bytes(), 2);
/// assert!(framer.next_frame().is_none());
/// ```
#[derive(Debug, Clone, Default)]
pub struct StatusFramer {
    buf: Vec<u8>,
    discarded: usize,
}

impl StatusFramer {
    /// Upper bound on buffered bytes (64 frames). Exceeding it drops the oldest bytes.
    pub const MAX_PENDING: usize = 64 * STATUS_LEN;

    /// Creates an empty framer.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends received bytes. Leading bytes that cannot start a frame are discarded at once.
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
        if self.buf.len() > Self::MAX_PENDING {
            let excess = self.buf.len() - Self::MAX_PENDING;
            self.drop_front(excess);
        }
        self.resync();
    }

    /// Returns the next complete frame, if any. `Some(Err(_))` reports a frame that had a
    /// header but failed to parse (it has already been skipped).
    pub fn next_frame(&mut self) -> Option<Result<Status, Error>> {
        self.resync();
        // A later header inside the window: the candidate was truncated (see module docs).
        while let Some(inner) = inner_header(&self.buf) {
            self.drop_front(inner);
        }
        let frame = self.buf.get(..STATUS_LEN)?;
        match parse_status(frame) {
            Ok(status) => {
                self.buf.drain(..STATUS_LEN);
                Some(Ok(status))
            }
            Err(e) => {
                // Unreachable with the current header-only validation, but keep the
                // contract: skip one byte so the next call rescans and cannot loop.
                self.drop_front(1);
                Some(Err(e))
            }
        }
    }

    /// Total bytes thrown away while resynchronising.
    #[must_use]
    pub fn discarded_bytes(&self) -> usize {
        self.discarded
    }

    /// Number of buffered bytes not yet returned as a frame.
    #[must_use]
    pub fn pending_bytes(&self) -> usize {
        self.buf.len()
    }

    /// Drops all buffered bytes (e.g. "drain input" before a handshake). They are not added
    /// to [`StatusFramer::discarded_bytes`].
    pub fn clear(&mut self) {
        self.buf.clear();
    }

    /// Discards everything before the first position that could start a frame.
    fn resync(&mut self) {
        let start = header_candidate(&self.buf);
        self.drop_front(start);
    }

    fn drop_front(&mut self, n: usize) {
        let n = n.min(self.buf.len());
        if n > 0 {
            self.buf.drain(..n);
            self.discarded += n;
        }
    }
}

/// Index of the first position where `buf` holds the header, or a prefix of it that runs to
/// the end of the buffer (a header split across reads). `buf.len()` if there is none.
fn header_candidate(buf: &[u8]) -> usize {
    (0..buf.len())
        .find(|&i| {
            let rest = &buf[i..];
            let n = rest.len().min(STATUS_HEADER.len());
            rest[..n] == STATUS_HEADER[..n]
        })
        .unwrap_or(buf.len())
}

/// Offset `1..STATUS_LEN` of a complete header inside the frame window that starts at
/// `buf[0]`, if any.
fn inner_header(buf: &[u8]) -> Option<usize> {
    let window = buf.get(1..)?;
    window
        .windows(STATUS_HEADER.len())
        .take(STATUS_LEN - 1)
        .position(|w| w == STATUS_HEADER)
        .map(|i| i + 1)
}

#[cfg(test)]
mod tests {
    use super::{header_candidate, inner_header};

    #[test]
    fn inner_header_positions() {
        let mut v = [0u8; 40];
        v[..3].copy_from_slice(&[0x80, 0x20, 0x42]);
        assert_eq!(inner_header(&v), None);
        v[10..13].copy_from_slice(&[0x80, 0x20, 0x42]);
        assert_eq!(inner_header(&v), Some(10));
        // A header at offset 32 belongs to the next frame.
        let mut w = [0u8; 40];
        w[32..35].copy_from_slice(&[0x80, 0x20, 0x42]);
        assert_eq!(inner_header(&w), None);
        // A header straddling the end of the window still counts (it starts at 31).
        let mut x = [0u8; 40];
        x[31..34].copy_from_slice(&[0x80, 0x20, 0x42]);
        assert_eq!(inner_header(&x), Some(31));
        assert_eq!(inner_header(&[]), None);
    }

    #[test]
    fn candidate_positions() {
        assert_eq!(header_candidate(&[]), 0);
        assert_eq!(header_candidate(&[0x80, 0x20, 0x42, 0x00]), 0);
        assert_eq!(header_candidate(&[0x00, 0x80]), 1);
        assert_eq!(header_candidate(&[0x00, 0x80, 0x20]), 1);
        assert_eq!(header_candidate(&[0x80, 0x20, 0x43, 0x80]), 3);
        assert_eq!(header_candidate(&[0x80, 0x21]), 2);
        assert_eq!(header_candidate(&[0x11, 0x22]), 2);
    }
}

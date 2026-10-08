//! Job encoder: bitmaps → printer byte stream (WP4).
//!
//! # Contract
//! - [`encode_job`] is a pure function of (profile, tape, pages, options) → [`EncodedJob`].
//!   Its output is frozen **byte-exactly** by golden tests (`tests/golden/`, ARCHITECTURE.md
//!   §8.2); any change in emitted bytes is a breaking change that needs a reviewed golden update.
//! - The stream follows PROTOCOL.md §6.2 (generic order from Brother's driver dumps) with every
//!   optional command gated by the model parameters in [`crate::ModelProfile`]; for PT-P710BT the
//!   result must equal PROTOCOL.md §6.3 exactly:
//!   ```text
//!   preamble: 00×100 1B 40
//!   page i:   1B 69 61 01 [1B 69 21 00 on page 1] 1B 69 7A 84 00 <w> 00 <lines LE32> <n9> 00
//!             1B 69 4D <M> 1B 69 4B <K> 1B 69 64 <margin LE16> 4D 02 {47 nL nH … | 5A}×lines
//!             0C (more pages) | 1A (last page)
//!   ```
//!   (`ESC i a 01` is part of every page so the session can pace pages independently; this
//!   matches the D1 dump, which repeats it from page 2, and §6.2 for page 1.)
//! - The **session** paces the job: `preamble + pages[0]` first, then each further page only
//!   after the previous one completed (PROTOCOL.md §6.8). [`EncodedJob::to_bytes`] is the
//!   unpaced concatenation, used for `--dry-run --out job.bin` and goldens.
//! - Geometry: every page must have `height == tape.print_pins`; canvas rows are mapped to
//!   head pins by [`line::head_line`] (PROTOCOL.md §5.1: row 0 = top edge of upright text).
//!   Pages shorter than `profile.min_lines(margin)` are padded with blank columns at the
//!   canvas end, i.e. the right end of the label (or rejected with [`Error::TooShort`] if
//!   `pad_short_pages` is false); longer than `max_lines` → [`Error::TooLong`].
//! - Feed order: pages are normal left-to-right canvases, and the raster lines are **sent in
//!   [`ModelProfile::feed_order`]** (PROTOCOL.md §5.3). For every PT model that is
//!   [`FeedOrder::LastColumnFirst`]: the printer prints the first line it receives at the
//!   right end of the label (\[HW\] orientation test label, PT-P710BT), so the encoder sends
//!   the padded canvas from its last column to column 0 (padding first). Callers never
//!   reverse pages themselves; the software mirror ([`prepare_pages`]) pads a short canvas to
//!   the model minimum and then reverses it, which the feed order turns into the exact mirror
//!   image of the readable label (padding at the left end instead of the right).
//! - Option validation: options the model lacks are rejected with [`Error::Unsupported`]
//!   (half cut, hardware mirror, high-res, special tape, chain when `caps.chain == Some(false)`),
//!   never silently dropped. `ESC i A` is never sent on PT-P710BT (`caps.cut_every`).
//! - Not done by [`encode_job`]: copies (the caller repeats pages), software mirror and the
//!   high-resolution line doubling ([`prepare_pages`] does both for any UI), the end-of-job
//!   `ESC i a FF` (the session sends [`EncodedJob::epilogue`] after the last page completed,
//!   PROTOCOL.md §6.10).
//!
//! # Sequence variants
//! The command *set* is gated by the table ([`crate::model::Caps`], [`crate::model::Sends`],
//! [`crate::model::PageCommand`]). The command *order* and the page framing are not in the
//! table; they follow the model-specific sections of PROTOCOL.md:
//!
//! | Models | Section | Differences from the §6.2 generic order |
//! |---|---|---|
//! | E310BT, E510, E560BT, D410, D460BT, D610BT (protocol 93/94) | §6.4 | one page per label: every page has n9 = `02` and ends with `1A` (hardware-verified community form, §8 #12). `ESC i K` bit 3 (no chain) only on the last page; intermediate labels are chained and separated by the next label's cut. Half cut sends `ESC i M 00` (`M 40` forces a full cut on every page). |
//! | P300BT, P300BTz | §6.6 | `ESC i z` n1 = `C4` with n2 from the table; `ESC i K` before `ESC i M`. |
//! | N25BT | §6.7 | preamble `00×N 1B 69 61 01 1B 40`; `ESC i p` before `ESC i z`; n1 = `C4`; K before M; `ESC i L`/`ESC i C` after `4D 00`. |
//! | everything else | §6.2, §6.3, §6.5 | – |
//!
//! `ESC i z` n2 is the table's `print_info_media_type` only where the printer must check it
//! (n1 `|= 0x02`: heat-shrink `11`/`17`, FLe `13`, high-res `09`); otherwise the driver-dump
//! value `00` is sent (§6.3–§6.5), except on the P300BT/N25BT sequences, which carry the table
//! value with n1 = `C4` (§6.6, §6.7).
//!
//! # Cutting (PROTOCOL.md §6.9)
//! | Options | `ESC i M` | `ESC i K` |
//! |---|---|---|
//! | `cut: EveryLabel` (default) | `40` (auto cut, or cut marks on cutter-less models) | `08` |
//! | `cut: HalfCut` (half-cut models) | `40` (`00` on the §6.4 family) | `0C` |
//! | `cut: None` | `00` | `08` |
//! | `chain: true` | unchanged | bit 3 cleared |
//! | `special_tape: true` | `00` | `profile.special_tape_k` |
//! | `high_resolution: true` | unchanged | bit 6 set |
//! | `mirror: true` | bit 7 set | unchanged |
//!
//! # Spec references
//! PROTOCOL.md §3.1–§3.3 (commands, gates), §5.1 (pins), §5.4 (resolution), §5.5
//! (compression), §5.6 (length), §6.2–§6.7 (sequences), §6.9 (cut/chain), §6.10 (cancel).

pub mod commands;
pub mod line;

use alloc::vec;
use alloc::vec::Vec;

use crate::bitmap::Bitmap;
use crate::error::Error;
use crate::model::{
    CancelCommand, Compression, FeedOrder, Model, ModelProfile, PageCommand, TapeSpec,
};
use crate::packbits::packbits_encode;

use self::commands::{PagePosition, PrintInfo};

/// `ESC i S`: status request (PROTOCOL.md §3.1).
pub const STATUS_REQUEST: [u8; 3] = [0x1B, 0x69, 0x53];

/// Most pages one job can have: the session numbers pages with `u16`
/// ([`crate::SessionState::Printing`]).
pub const MAX_PAGES: usize = u16::MAX as usize;

/// Invalidate length of [`generic_handshake_sequence`] (largest model value, PROTOCOL.md §3.1).
const GENERIC_NULL_BYTES: u16 = 200;

/// `ESC i a` raster mode.
const MODE_RASTER: u8 = 0x01;
/// `ESC i a` "mode set as default" (end of job, PROTOCOL.md §6.10).
const MODE_DEFAULT: u8 = 0xFF;

/// `ESC i z` n1: PI_KIND (n2 valid).
const PI_KIND: u8 = 0x02;
/// `ESC i z` n1 used by Brother's driver dumps: PI_RECOVER | PI_WIDTH.
const PI_DRIVER: u8 = 0x84;
/// `ESC i z` n1 used by the P300BT capture and the N25BT SDK sequence: PI_RECOVER |
/// PI_QUALITY | PI_WIDTH.
const PI_SDK: u8 = 0xC4;
/// `ESC i z` n2 media types that the printer must check (heat-shrink 2:1, FLe, heat-shrink 3:1).
const CHECKED_MEDIA_TYPES: [u8; 3] = [0x11, 0x13, 0x17];

/// `ESC i M` bit 6: auto cut (cut mark on cutter-less models).
const M_AUTO_CUT: u8 = 0x40;
/// `ESC i M` bit 7: mirror.
const M_MIRROR: u8 = 0x80;
/// `ESC i K` bit 2: half cut.
const K_HALF_CUT: u8 = 0x04;
/// `ESC i K` bit 3: no chain printing (feed and cut after the last page).
const K_NO_CHAIN: u8 = 0x08;
/// `ESC i K` bit 6: high-resolution printing.
const K_HIGH_RES: u8 = 0x40;

/// Cutting behaviour (PROTOCOL.md §6.9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum CutMode {
    /// Full cut after every label (`ESC i M 40`) — default. On models without a cutter
    /// (P300BT, N25BT) the same bit prints cut marks.
    #[default]
    EveryLabel,
    /// Half cut between labels, full cut at the end (`ESC i K 0C`; half-cut models only).
    HalfCut,
    /// No cut at all (`ESC i M 00`).
    None,
}

/// Options for [`encode_job`]. `Default` gives the PT-P710BT §6.3 stream.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct JobOptions {
    /// Cutting behaviour (`ESC i M` bit 6, `ESC i K` bit 2).
    pub cut: CutMode,
    /// Hardware mirror (`ESC i M` bit 7). Default false.
    pub mirror: bool,
    /// Chain printing: `ESC i K` bit 3 cleared ⇒ the last label stays in the printer.
    /// Default false.
    pub chain: bool,
    /// Special tape (fabric, stencil): `ESC i K` = `profile.special_tape_k`, no cut.
    pub special_tape: bool,
    /// High-resolution feed (`ESC i K` 0x40, doubled lines/margin; PROTOCOL.md §5.4).
    /// The caller supplies bitmaps already at the doubled feed resolution.
    pub high_resolution: bool,
    /// `ESC i d` feed margin in dots at the job's feed resolution. `None` = the tape's
    /// `default_feed_dots` (doubled in high-res). 0 is allowed; values above
    /// [`ModelProfile::max_margin_dots`] (900 at 180 dpi, 1800 in 180×360 high-res) are
    /// rejected with [`Error::InvalidInput`] (PROTOCOL.md §3.2.4).
    pub feed_margin_dots: Option<u16>,
    /// Compression. `None` = `profile.default_compression`.
    pub compression: Option<Compression>,
    /// Send `ESC i ! 00` on page 1 where `caps.status_notify` (default true; needed for
    /// completion pushes over Bluetooth).
    pub auto_status: bool,
    /// Encode all-zero lines as `5A` in PackBits mode (default true) instead of
    /// `47 02 00 (1−W) 00`.
    pub z_for_blank_lines: bool,
    /// Pad short pages with blank lines to the model minimum (default true); otherwise
    /// [`Error::TooShort`].
    pub pad_short_pages: bool,
}

impl Default for JobOptions {
    fn default() -> Self {
        Self {
            cut: CutMode::EveryLabel,
            mirror: false,
            chain: false,
            special_tape: false,
            high_resolution: false,
            feed_margin_dots: None,
            compression: None,
            auto_status: true,
            z_for_blank_lines: true,
            pad_short_pages: true,
        }
    }
}

/// A job split at page boundaries so the session can pace it page by page.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct EncodedJob {
    /// Model the job was encoded for.
    pub model: Model,
    /// Tape width byte (`ESC i z` n3 / expected `st[10]`), for the session preflight.
    pub media_width_byte: u8,
    /// Expected `st[11]` for the tape the job was encoded for.
    pub media_type_byte: u8,
    /// The job uses the high-resolution feed (`ESC i K` bit 6). PROTOCOL.md §5.4 allows that
    /// only on laminated TZe, so the session preflight additionally requires `st[11] = 01`.
    pub high_resolution: bool,
    /// Invalidate + initialize (`00×N 1B 40`).
    pub preamble: Vec<u8>,
    /// One control block + raster + `0C`/`1A` per page.
    pub pages: Vec<Vec<u8>>,
    /// Raster lines per page actually sent (after padding), for print-time estimates.
    pub page_lines: Vec<u32>,
    /// Sent after the last page has completed (`1B 69 61 FF` where
    /// `sends.mode_reset_at_end`); may be empty.
    pub epilogue: Vec<u8>,
}

impl EncodedJob {
    /// Unpaced concatenation `preamble ‖ pages… ‖ epilogue` (for files and goldens).
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        let len = self.preamble.len()
            + self.pages.iter().map(Vec::len).sum::<usize>()
            + self.epilogue.len();
        let mut out = Vec::with_capacity(len);
        out.extend_from_slice(&self.preamble);
        for page in &self.pages {
            out.extend_from_slice(page);
        }
        out.extend_from_slice(&self.epilogue);
        out
    }

    /// Number of pages. [`encode_job`] never produces more than [`MAX_PAGES`]; for a job
    /// assembled by hand with more pages this saturates, and [`crate::Session::submit`]
    /// rejects such a job.
    #[must_use]
    pub fn page_count(&self) -> u16 {
        u16::try_from(self.pages.len()).unwrap_or(u16::MAX)
    }

    /// Total raster lines over all pages.
    #[must_use]
    pub fn total_lines(&self) -> u32 {
        self.page_lines
            .iter()
            .fold(0u32, |a, &n| a.saturating_add(n))
    }
}

/// Command order and page framing (see "Sequence variants" in the module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sequence {
    /// PROTOCOL.md §6.2/§6.3/§6.5: driver-dump order, `0C` between pages.
    Driver,
    /// PROTOCOL.md §6.4: E/D 128-pin family, one page per label (n9 = 2, `1A` each).
    PerLabel,
    /// PROTOCOL.md §6.6: P300BT capture order (K before M, n1 = `C4`).
    Cube,
    /// PROTOCOL.md §6.7: N25BT SDK order.
    Aura,
}

impl Sequence {
    fn for_profile(profile: &ModelProfile) -> Self {
        match profile.model {
            Model::PtN25bt => Self::Aura,
            Model::PtP300bt | Model::PtP300btz => Self::Cube,
            _ if profile.page_command == PageCommand::StartNextEnd
                && matches!(profile.protocol(), 93 | 94) =>
            {
                Self::PerLabel
            }
            _ => Self::Driver,
        }
    }

    /// `ESC i K` before `ESC i M`, and n1 = `C4` with the table's n2.
    fn sdk_style(self) -> bool {
        matches!(self, Self::Cube | Self::Aura)
    }
}

/// Everything about a job that does not depend on the page (validated options).
#[derive(Debug, Clone, Copy)]
struct Plan {
    seq: Sequence,
    packbits: bool,
    z_for_blank_lines: bool,
    pad_short_pages: bool,
    notify: bool,
    margin: u16,
    min_lines: u32,
    max_lines: Option<u32>,
    n1: u8,
    n2: u8,
    /// `ESC i M` value.
    m: u8,
    /// `ESC i K` value without the no-chain bit (or the full special-tape value).
    k: u8,
    /// Set `ESC i K` bit 3 (on every page, or on the last page for [`Sequence::PerLabel`]).
    no_chain: bool,
    /// `ESC i K` is the fixed special-tape value.
    special: bool,
    cut_every: bool,
    /// Which canvas column each raster line carries ([`ModelProfile::feed_order`]).
    feed_order: FeedOrder,
}

/// `ESC i d` feed margin in dots at the job's feed resolution (PROTOCOL.md §3.2.4, §5.4):
/// `opts.feed_margin_dots`, or the tape default (doubled in high-res).
fn feed_margin(profile: &ModelProfile, tape: &TapeSpec, opts: &JobOptions) -> Result<u16, Error> {
    let high_res = opts.high_resolution;
    let margin = match opts.feed_margin_dots {
        Some(dots) => dots,
        None if high_res => tape
            .default_feed_dots
            .checked_mul(2)
            .ok_or(Error::InvalidInput("feed margin"))?,
        None => tape.default_feed_dots,
    };
    if u32::from(margin) > profile.max_margin_dots(high_res) {
        return Err(Error::InvalidInput(
            "feed margin above the documented maximum (127 mm: 900 dots at 180 dpi)",
        ));
    }
    Ok(margin)
}

impl Plan {
    fn new(profile: &ModelProfile, tape: &TapeSpec, opts: &JobOptions) -> Result<Self, Error> {
        if !profile.media.contains(&tape) {
            return Err(Error::UnsupportedMedia {
                width_mm: tape.media_width_byte,
                media_type: tape.status_media_type,
            });
        }
        let caps = &profile.caps;
        let seq = Sequence::for_profile(profile);

        let compression = opts.compression.unwrap_or(profile.default_compression);
        let packbits = compression == Compression::PackBits;
        if packbits && !caps.compression {
            return Err(Error::Unsupported("PackBits compression"));
        }

        let high_res = opts.high_resolution;
        let mut hr_media_type = None;
        // High-res needs laminated TZe (PROTOCOL.md §5.4); a table entry without a high-res
        // n2 is not laminated TZe. The loaded tape's `st[11]` is checked by the session
        // preflight (`EncodedJob::high_resolution`).
        if high_res {
            if !caps.high_resolution || profile.feed_dpi(true).is_none() {
                return Err(Error::Unsupported("high-resolution printing"));
            }
            hr_media_type = Some(
                tape.print_info_media_type_high_res
                    .ok_or(Error::Unsupported("high-resolution printing on this tape"))?,
            );
        }
        if opts.mirror && !caps.mirror {
            return Err(Error::Unsupported("hardware mirror"));
        }
        if opts.chain && caps.chain == Some(false) {
            return Err(Error::Unsupported("chain printing"));
        }
        if opts.cut == CutMode::HalfCut && !caps.half_cut {
            return Err(Error::Unsupported("half cut"));
        }

        // ESC i M / ESC i K (PROTOCOL.md §3.2.2, §3.2.3, §6.9).
        let mirror = if opts.mirror { M_MIRROR } else { 0 };
        let (m, k, special) = if opts.special_tape {
            let special_k = profile
                .special_tape_k
                .filter(|_| caps.special_tape)
                .ok_or(Error::Unsupported("special tape"))?;
            if opts.chain || opts.cut == CutMode::HalfCut || high_res {
                return Err(Error::InvalidInput(
                    "special tape cannot be combined with chain, half cut or high resolution",
                ));
            }
            (mirror, special_k, true)
        } else {
            let cut_bit = match opts.cut {
                CutMode::EveryLabel if caps.auto_cut || caps.cut_mark => M_AUTO_CUT,
                CutMode::HalfCut if caps.auto_cut && seq != Sequence::PerLabel => M_AUTO_CUT,
                CutMode::EveryLabel | CutMode::HalfCut | CutMode::None => 0,
            };
            let mut k = 0;
            if opts.cut == CutMode::HalfCut {
                k |= K_HALF_CUT;
            }
            if high_res {
                k |= K_HIGH_RES;
            }
            (cut_bit | mirror, k, false)
        };
        let cut_every = caps.cut_every == Some(true) && caps.auto_cut && m & M_AUTO_CUT != 0;

        // ESC i z n1/n2 (PROTOCOL.md §3.2.1).
        let table_type = hr_media_type.unwrap_or(tape.print_info_media_type);
        let checked = high_res || CHECKED_MEDIA_TYPES.contains(&table_type);
        let base_n1 = if seq.sdk_style() { PI_SDK } else { PI_DRIVER };
        let n1 = if checked { base_n1 | PI_KIND } else { base_n1 };
        let n2 = if checked || seq.sdk_style() {
            table_type
        } else {
            0x00
        };

        // ESC i d (PROTOCOL.md §3.2.4, §5.4).
        let margin = feed_margin(profile, tape, opts)?;

        // Page length (PROTOCOL.md §5.6): model maximum, FLe label length, heat-shrink 500 mm.
        let min_lines = profile.min_lines(margin, high_res);
        let max_lines = profile.max_lines_for(tape, high_res);

        Ok(Self {
            seq,
            packbits,
            z_for_blank_lines: opts.z_for_blank_lines,
            pad_short_pages: opts.pad_short_pages,
            notify: caps.status_notify && opts.auto_status,
            margin,
            min_lines,
            max_lines,
            n1,
            n2,
            m,
            k,
            no_chain: !opts.chain,
            special,
            cut_every,
            feed_order: profile.feed_order(),
        })
    }

    /// `ESC i K` for page `index` of `count`.
    fn k_for(&self, index: usize, count: usize) -> u8 {
        if self.special {
            return self.k;
        }
        let last = index + 1 == count;
        let no_chain = self.no_chain && (self.seq != Sequence::PerLabel || last);
        if no_chain {
            self.k | K_NO_CHAIN
        } else {
            self.k
        }
    }

    /// n9 for page `index` of `count` (PROTOCOL.md §3.2.1, §6.4).
    fn position_for(&self, page_command: PageCommand, index: usize, count: usize) -> PagePosition {
        let last = index + 1 == count;
        match page_command {
            _ if self.seq == Sequence::PerLabel => PagePosition::Last,
            PageCommand::StartEnd if index == 0 => PagePosition::First,
            PageCommand::StartEnd => PagePosition::Other,
            PageCommand::StartNextEnd if last => PagePosition::Last,
            PageCommand::StartNextEnd if index == 0 => PagePosition::First,
            PageCommand::StartNextEnd => PagePosition::Other,
        }
    }

    /// Raster lines actually sent for a page of `length` lines.
    fn lines_for(&self, length: u32) -> Result<u32, Error> {
        if length == 0 {
            return Err(Error::Empty);
        }
        if let Some(max) = self.max_lines
            && length > max
        {
            return Err(Error::TooLong { dots: length, max });
        }
        if length < self.min_lines {
            if !self.pad_short_pages {
                return Err(Error::TooShort {
                    dots: length,
                    min: self.min_lines,
                });
            }
            return Ok(self.min_lines);
        }
        Ok(length)
    }
}

/// Adapts normal-resolution, unmirrored pages (what a UI renders) to what [`encode_job`]
/// expects for `opts`, and returns them with the options to encode them with:
/// - `opts.high_resolution`: every line is repeated [`ModelProfile::feed_factor`] times
///   (PROTOCOL.md §5.4);
/// - `opts.mirror` on a model without hardware mirror (`caps.mirror`): the canvases are
///   reversed left↔right ([`Bitmap::reversed`], the software mirror of §5.3) and `mirror` is
///   cleared in the returned options. A page shorter than the model minimum for `tape` is
///   first padded at its end (as [`encode_job`] would pad the unmirrored page, if
///   `opts.pad_short_pages`), so after the reversal the padding is at the left end.
///   [`encode_job`] still applies the model's feed order, so the printed label is the exact
///   mirror image of the readable one, padding included, as with `ESC i M` bit 7 on models
///   that have it.
///
/// # Errors
/// [`Error::Unsupported`] for high-resolution printing on a model without it;
/// [`Error::InvalidInput`] if a stretched page would be too large ([`Bitmap::MAX_BYTES`]) or,
/// with the software mirror, if the feed margin is above the maximum.
///
/// ```
/// use ptouch::{Bitmap, JobOptions, Model, encode_job, prepare_pages, profile};
///
/// let p710 = profile(Model::PtP710bt).ok_or(ptouch::Error::Empty)?;
/// let tape = ptouch::media_by_id("tze128-24").ok_or(ptouch::Error::Empty)?;
/// let opts = JobOptions { high_resolution: true, ..JobOptions::default() };
/// let (pages, opts) = prepare_pages(p710, tape, &[Bitmap::new(40, tape.print_pins)], &opts)?;
/// assert_eq!(pages[0].length(), 80);
/// let refs: Vec<&Bitmap> = pages.iter().collect();
/// assert_eq!(encode_job(p710, tape, &refs, &opts)?.page_lines, [80]);
/// # Ok::<(), ptouch::Error>(())
/// ```
pub fn prepare_pages(
    profile: &ModelProfile,
    tape: &TapeSpec,
    pages: &[Bitmap],
    opts: &JobOptions,
) -> Result<(Vec<Bitmap>, JobOptions), Error> {
    if opts.high_resolution && (!profile.caps.high_resolution || profile.feed_dpi(true).is_none()) {
        return Err(Error::Unsupported("high-resolution printing"));
    }
    let factor = profile.feed_factor(opts.high_resolution);
    let soft_mirror = opts.mirror && !profile.caps.mirror;
    // The software mirror must also move the padding encode_job would add at the canvas end
    // (right end of the label) to the left end, so pad before reversing.
    let pad_to = if soft_mirror && opts.pad_short_pages {
        profile.min_lines(feed_margin(profile, tape, opts)?, opts.high_resolution)
    } else {
        0
    };
    let out = pages
        .iter()
        .map(|page| {
            let page = page.stretched_feed(factor)?;
            Ok(if soft_mirror {
                // A zero-length page stays empty so encode_job still rejects it.
                let min = if page.length() == 0 { 0 } else { pad_to };
                page.padded_to(min, 0).reversed()
            } else {
                page
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let mut resolved = opts.clone();
    if soft_mirror {
        resolved.mirror = false;
    }
    Ok((out, resolved))
}

/// Encodes `pages` for `profile` and `tape` (see module docs).
///
/// # Errors
/// [`Error::Empty`] (no pages / zero-length page), [`Error::BitmapSize`],
/// [`Error::TooShort`], [`Error::TooLong`], [`Error::Unsupported`],
/// [`Error::UnsupportedMedia`] (tape not in `profile.media`), [`Error::InvalidInput`]
/// (more than [`MAX_PAGES`] pages, feed margin above the maximum).
///
/// # Example
/// ```
/// use ptouch::{Bitmap, JobOptions, Model, encode_job, profile};
///
/// let p710 = profile(Model::PtP710bt).unwrap();
/// let tape = p710.media.iter().copied().find(|t| t.id == "tze128-24").unwrap();
/// let label = Bitmap::new(40, tape.print_pins);
/// let job = encode_job(p710, tape, &[&label], &JobOptions::default()).unwrap();
/// assert_eq!(job.page_lines, [40]);
/// assert_eq!(job.to_bytes().last(), Some(&0x1A));
/// ```
pub fn encode_job(
    profile: &ModelProfile,
    tape: &TapeSpec,
    pages: &[&Bitmap],
    opts: &JobOptions,
) -> Result<EncodedJob, Error> {
    if pages.is_empty() {
        return Err(Error::Empty);
    }
    if pages.len() > MAX_PAGES {
        return Err(Error::InvalidInput(
            "too many pages in one job (maximum 65535)",
        ));
    }
    let plan = Plan::new(profile, tape, opts)?;

    // Validate every page before encoding anything.
    let mut page_lines = Vec::with_capacity(pages.len());
    for page in pages {
        if page.height() != tape.print_pins {
            return Err(Error::BitmapSize {
                expected_height: tape.print_pins,
                got_height: page.height(),
            });
        }
        page_lines.push(plan.lines_for(page.length())?);
    }

    let mut preamble = Vec::with_capacity(usize::from(profile.null_bytes) + 6);
    commands::invalidate(&mut preamble, profile.null_bytes);
    if plan.seq == Sequence::Aura && profile.needs_mode_switch {
        commands::command_mode(&mut preamble, MODE_RASTER);
    }
    commands::initialize(&mut preamble);

    let width = usize::from(profile.bytes_per_line);
    let mut encoded = Vec::with_capacity(pages.len());
    for (index, (page, &lines)) in pages.iter().zip(&page_lines).enumerate() {
        let mut out = Vec::new();
        encode_page_header(&mut out, profile, tape, &plan, index, pages.len(), lines);
        encode_raster(&mut out, page, tape, &plan, width, lines);
        if plan.seq == Sequence::PerLabel || index + 1 == pages.len() {
            commands::print_last(&mut out);
        } else {
            commands::print_page(&mut out);
        }
        encoded.push(out);
    }

    let mut epilogue = Vec::new();
    if profile.sends.mode_reset_at_end {
        commands::command_mode(&mut epilogue, MODE_DEFAULT);
    }

    Ok(EncodedJob {
        model: profile.model,
        media_width_byte: tape.media_width_byte,
        media_type_byte: tape.status_media_type,
        high_resolution: opts.high_resolution,
        preamble,
        pages: encoded,
        page_lines,
        epilogue,
    })
}

/// Control block of one page, up to and including the compression command.
fn encode_page_header(
    out: &mut Vec<u8>,
    profile: &ModelProfile,
    tape: &TapeSpec,
    plan: &Plan,
    index: usize,
    count: usize,
    lines: u32,
) {
    let seq = plan.seq;
    let sends = &profile.sends;

    // On the N25BT sequence page 1's `ESC i a 01` is part of the preamble.
    if profile.needs_mode_switch && !(seq == Sequence::Aura && index == 0) {
        commands::command_mode(out, MODE_RASTER);
    }
    if index == 0 && plan.notify {
        commands::status_notification(out, true);
    }
    if seq == Sequence::Aura && sends.stored_up_print {
        commands::stored_up_print(out);
    }
    commands::print_info(
        out,
        &PrintInfo {
            valid_flags: plan.n1,
            media_type: plan.n2,
            width: tape.media_width_byte,
            length: tape.length_mm.unwrap_or(0),
            lines,
            position: plan.position_for(profile.page_command, index, count),
        },
    );
    let k = plan.k_for(index, count);
    if seq.sdk_style() {
        commands::advanced_mode(out, k);
        commands::various_mode(out, plan.m);
        if plan.cut_every {
            commands::cut_every(out, 1);
        }
    } else {
        commands::various_mode(out, plan.m);
        if plan.cut_every {
            commands::cut_every(out, 1);
        }
        commands::advanced_mode(out, k);
    }
    if sends.copies_command {
        commands::copies(out, 1);
    }
    if seq != Sequence::Aura {
        if sends.stored_up_print {
            commands::stored_up_print(out);
        }
        if sends.color_info {
            commands::mono_color_info(out);
        }
    }
    commands::margin(out, plan.margin);
    commands::compression(out, plan.packbits);
    if seq == Sequence::Aura && sends.color_info {
        commands::mono_color_info(out);
    }
}

/// Raster lines of one page: the canvas padded to `lines ≥ page.length()` columns (the
/// padding is blank and sits at the canvas end), sent in `plan.feed_order`.
fn encode_raster(
    out: &mut Vec<u8>,
    page: &Bitmap,
    tape: &TapeSpec,
    plan: &Plan,
    width: usize,
    lines: u32,
) {
    let mut head = vec![0u8; width];
    let mut scratch = Vec::with_capacity(width + 2);
    out.reserve((lines as usize).saturating_mul(if plan.packbits { 4 } else { width + 3 }));
    for i in 0..lines {
        let column = plan.feed_order.column(i, lines);
        if column < page.length() {
            line::head_line(page.line(column), tape, &mut head);
        } else {
            head.fill(0);
        }
        encode_line(out, &head, plan, &mut scratch);
    }
}

/// One `G`/`Z` line for a full head line (PROTOCOL.md §5.5).
fn encode_line(out: &mut Vec<u8>, head: &[u8], plan: &Plan, scratch: &mut Vec<u8>) {
    if !plan.packbits {
        commands::raster_line(out, head);
        return;
    }
    if plan.z_for_blank_lines && head.iter().all(|&b| b == 0) {
        commands::zero_line(out);
        return;
    }
    scratch.clear();
    packbits_encode(head, scratch);
    // Literal fallback: never send more than one literal run (W + 1 bytes).
    if scratch.len() > head.len()
        && let Some(header) = head.len().checked_sub(1).and_then(|n| u8::try_from(n).ok())
        && header < 0x80
    {
        scratch.clear();
        scratch.push(header);
        scratch.extend_from_slice(head);
    }
    commands::raster_line(out, scratch);
}

/// `00 × null_bytes` + `1B 40` (invalidate + initialize; PROTOCOL.md §3.1).
#[must_use]
pub fn reset_sequence(profile: &ModelProfile) -> Vec<u8> {
    let mut out = Vec::with_capacity(usize::from(profile.null_bytes) + 2);
    commands::invalidate(&mut out, profile.null_bytes);
    commands::initialize(&mut out);
    out
}

/// `00 × null_bytes` + `1B 40` or `1B 69 18` per `profile.cancel_command` (PROTOCOL.md §6.10).
#[must_use]
pub fn cancel_sequence(profile: &ModelProfile) -> Vec<u8> {
    let mut out = Vec::with_capacity(usize::from(profile.null_bytes) + 3);
    commands::invalidate(&mut out, profile.null_bytes);
    match profile.cancel_command {
        CancelCommand::EscAt => commands::initialize(&mut out),
        CancelCommand::EscI18 => out.extend_from_slice(&[0x1B, 0x69, 0x18]),
    }
    out
}

/// Handshake bytes before the first status request: reset + `ESC i a 01` where
/// `needs_mode_switch` (PROTOCOL.md §6.1 steps 2–3). The session sends [`STATUS_REQUEST`]
/// separately after draining.
#[must_use]
pub fn handshake_sequence(profile: &ModelProfile) -> Vec<u8> {
    let mut out = reset_sequence(profile);
    if profile.needs_mode_switch {
        commands::command_mode(&mut out, MODE_RASTER);
    }
    out
}

/// Handshake bytes when the model is not yet known (first contact): `00×200 1B 40 1B 69 61 01`
/// (200 NULs are harmless on every model; PROTOCOL.md §3.1).
#[must_use]
pub fn generic_handshake_sequence() -> Vec<u8> {
    let mut out = Vec::with_capacity(usize::from(GENERIC_NULL_BYTES) + 6);
    commands::invalidate(&mut out, GENERIC_NULL_BYTES);
    commands::initialize(&mut out);
    commands::command_mode(&mut out, MODE_RASTER);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::profile;

    #[test]
    fn sequence_variants() {
        let seq = |m| profile(m).map(Sequence::for_profile);
        assert_eq!(seq(Model::PtP710bt), Some(Sequence::Driver));
        // The remaining profiles exist once the generated table covers every model (WP1).
        for (model, expected) in [
            (Model::PtP910bt, Sequence::Driver),
            (Model::PtP750w, Sequence::Driver),
            (Model::PtE560bt, Sequence::PerLabel),
            (Model::PtE310bt, Sequence::PerLabel),
            (Model::PtD460bt, Sequence::PerLabel),
            (Model::PtP300bt, Sequence::Cube),
            (Model::PtN25bt, Sequence::Aura),
        ] {
            if let Some(s) = seq(model) {
                assert_eq!(s, expected, "{model:?}");
            }
        }
    }

    #[test]
    fn generic_handshake() {
        let h = generic_handshake_sequence();
        assert_eq!(h.len(), 206);
        assert!(h[..200].iter().all(|&b| b == 0));
        assert_eq!(&h[200..], &[0x1B, 0x40, 0x1B, 0x69, 0x61, 0x01]);
    }

    #[test]
    fn encode_line_literal_fallback() {
        let plan_bits = |packbits| Plan {
            seq: Sequence::Driver,
            packbits,
            z_for_blank_lines: true,
            pad_short_pages: true,
            notify: false,
            margin: 14,
            min_lines: 1,
            max_lines: None,
            n1: PI_DRIVER,
            n2: 0,
            m: 0,
            k: 0,
            no_chain: true,
            special: false,
            cut_every: false,
            feed_order: FeedOrder::LastColumnFirst,
        };
        let head: Vec<u8> = (0u8..16).collect();
        let mut out = Vec::new();
        let mut scratch = Vec::new();
        encode_line(&mut out, &head, &plan_bits(true), &mut scratch);
        assert_eq!(out.len(), 3 + 17);
        assert_eq!(&out[..4], &[0x47, 0x11, 0x00, 0x0F]);
        assert_eq!(&out[4..], &head[..]);

        out.clear();
        encode_line(&mut out, &[0; 16], &plan_bits(true), &mut scratch);
        assert_eq!(out, [0x5A]);

        out.clear();
        encode_line(&mut out, &[0; 16], &plan_bits(false), &mut scratch);
        assert_eq!(out.len(), 19);
        assert_eq!(&out[..3], &[0x47, 0x10, 0x00]);
    }
}

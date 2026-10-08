//! `ptouch print`. Renders `--text` (built-in font, a font file or a system font) or
//! `--image` (PNG/PBM/PGM, dithered) to the loaded tape's print height and prints it — or
//! previews / dry-runs it offline.

use std::io::Read as _;

use ptouch::{Bitmap, Dither, ModelProfile, TapeSpec, ToneAdjust};

use super::{check_label_length, print_pages};
use crate::cli::{Cli, DitherArg, PrintArgs};
use crate::error::CliError;
use crate::render::image::load_image;
use crate::render::text::{FontSource, TextOptions, missing_glyphs, render_text};
use crate::render::{fit_length, mm_to_dots, pad_length};

/// Runs the subcommand.
///
/// # Errors
/// Rendering, connection, preflight and print errors.
pub fn run(cli: &Cli, args: &PrintArgs) -> Result<(), CliError> {
    let source = Source::load(args)?;
    print_pages(cli, &args.job, &|profile, tape| {
        Ok(vec![render(args, &source, profile, tape)?])
    })
}

/// What to render, loaded once (fonts and stdin are read before connecting).
enum Source {
    Text { text: String, font: Box<FontSource> },
    Image,
}

impl Source {
    fn load(args: &PrintArgs) -> Result<Self, CliError> {
        let Some(text) = &args.text else {
            return Ok(Self::Image);
        };
        let text = if text == "-" {
            let mut s = String::new();
            std::io::stdin()
                .read_to_string(&mut s)
                .map_err(|e| CliError::file("<stdin>", e))?;
            s.trim_end_matches(['\n', '\r']).to_owned()
        } else {
            text.clone()
        };
        let (font, name) = FontSource::resolve(args.font.as_deref())?;
        let missing = missing_glyphs(&text, &font);
        if !missing.is_empty() {
            let list: String = missing.iter().collect();
            eprintln!("warning: font {name} cannot draw {list:?}; they print as placeholders");
        }
        Ok(Self::Text {
            text,
            font: Box::new(font),
        })
    }
}

fn dither_method(args: &PrintArgs) -> Dither {
    match args.dither {
        DitherArg::Threshold => Dither::Threshold {
            level: args.threshold,
        },
        DitherArg::FloydSteinberg => Dither::FloydSteinberg,
        DitherArg::Atkinson => Dither::Atkinson,
        DitherArg::Bayer4 => Dither::Bayer4,
        DitherArg::Bayer8 => Dither::Bayer8,
    }
}

fn tone(args: &PrintArgs) -> Result<ToneAdjust, CliError> {
    if !(args.gamma.is_finite() && (0.1..=10.0).contains(&args.gamma)) {
        return Err(CliError::Usage("--gamma must be between 0.1 and 10".into()));
    }
    Ok(ToneAdjust {
        brightness: args.brightness,
        contrast: args.contrast,
        gamma_x100: (args.gamma * 100.0).round() as u16,
        invert: args.invert,
    })
}

/// Renders one label for `tape` (normal feed resolution; high-res is applied later).
fn render(
    args: &PrintArgs,
    source: &Source,
    profile: &ModelProfile,
    tape: &TapeSpec,
) -> Result<Bitmap, CliError> {
    let content = match (source, &args.image) {
        (Source::Text { text, font }, _) => render_text(
            text,
            font,
            tape.print_pins,
            TextOptions {
                size: args.size,
                align: args.align,
            },
        )?,
        (Source::Image, Some(path)) => load_image(
            path,
            tape.print_pins,
            args.no_scale,
            dither_method(args),
            tone(args)?,
        )?,
        (Source::Image, None) => return Err(CliError::Usage("nothing to print".into())),
    };
    // Check the requested size before padding allocates it (a typo in --length/--padding
    // must not allocate gigabytes; PROTOCOL.md §5.6 limits).
    let padded_len =
        u64::from(content.length()).saturating_add(u64::from(args.padding).saturating_mul(2));
    check_label_length(profile, tape, padded_len, "the content plus --padding")?;
    if let Some(mm) = args.length.filter(|mm| mm.is_finite() && *mm > 0.0) {
        let dots = mm_to_dots(f64::from(mm), profile.dpi);
        check_label_length(profile, tape, u64::from(dots), "--length")?;
    }
    let padded = pad_length(&content, args.padding, args.padding);
    match args.length {
        Some(mm) if mm.is_finite() && mm > 0.0 => {
            fit_length(&padded, mm_to_dots(f64::from(mm), profile.dpi), args.align)
        }
        Some(_) => Err(CliError::Usage(
            "--length must be a positive number of mm".into(),
        )),
        None => Ok(padded),
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser as _;

    use super::*;
    use crate::cli::Command;
    use crate::commands::{dry_run_report, offline_profile, offline_tape, prepare_pages};

    /// `--length` / `--padding` beyond the model maximum fail before anything that long is
    /// allocated.
    #[test]
    fn oversized_length_and_padding_fail_fast() {
        for extra in [
            ["--length", "100000000"],
            ["--padding", "4000000000"],
            ["--length", "1001"],
        ] {
            let cli = Cli::try_parse_from(
                [
                    "ptouch",
                    "print",
                    "--text",
                    "hi",
                    "--tape",
                    "24",
                    "--dry-run",
                ]
                .into_iter()
                .chain(extra),
            )
            .unwrap();
            let Command::Print(args) = &cli.command else {
                panic!("parsed as print");
            };
            let profile = offline_profile(&cli).unwrap();
            let tape = offline_tape(profile, args.job.tape.as_deref()).unwrap();
            let source = Source::load(args).unwrap();
            let started = std::time::Instant::now();
            let err = render(args, &source, profile, tape).unwrap_err();
            assert!(matches!(err, CliError::Usage(_)), "{extra:?}: {err:?}");
            assert!(err.to_string().contains("7086"), "{err}");
            assert!(started.elapsed() < std::time::Duration::from_secs(2));
        }
    }

    /// End to end, offline: `ptouch print --text … --tape 24 --dry-run` for the PT-P710BT
    /// renders a label, encodes it, decodes the bytes, and prints them through the real
    /// `Session` against a `VirtualPrinter`; both the decoded and the printed bitmaps must
    /// equal the rendered input exactly.
    #[test]
    fn dry_run_text_label_p710bt_24mm_round_trips_through_session() {
        let cli = Cli::try_parse_from([
            "ptouch",
            "--model",
            "PT-P710BT",
            "print",
            "--text",
            "Hello P710",
            "--tape",
            "24",
            "--dry-run",
        ])
        .unwrap();
        let Command::Print(args) = &cli.command else {
            panic!("parsed as print");
        };
        let profile = offline_profile(&cli).unwrap();
        assert_eq!(profile.name, "PT-P710BT");
        let tape = offline_tape(profile, args.job.tape.as_deref()).unwrap();
        assert_eq!((tape.media_width_byte, tape.print_pins), (24, 128));

        let source = Source::load(args).unwrap();
        let pages = prepare_pages(profile, tape, &args.job, &|p, t| {
            Ok(vec![render(args, &source, p, t)?])
        })
        .unwrap();
        assert_eq!(pages.len(), 1);
        let input = &pages[0];
        assert_eq!(input.height(), 128);
        assert!(
            input.length() >= 100,
            "label is long enough not to be padded"
        );
        assert!((0..input.length()).any(|x| input.line(x).iter().any(|&b| b != 0)));

        let report = dry_run_report(profile, tape, &args.job, &pages).unwrap();
        assert_eq!(report.bytes.last(), Some(&0x1A), "P710BT jobs end with 1A");

        let decoded = report.decoded.as_ref().unwrap();
        assert!(decoded.violations.is_empty(), "{:?}", decoded.violations);
        assert_eq!(decoded.pages.as_slice(), pages.as_slice(), "offline decode");

        let sim = report.simulated.as_ref().unwrap();
        assert!(sim.violations.is_empty(), "{:?}", sim.violations);
        assert_eq!(
            sim.printed.as_slice(),
            pages.as_slice(),
            "session + virtual printer"
        );
        assert!(report.decoded_matches(&pages) && report.simulated_matches(&pages));
    }
}

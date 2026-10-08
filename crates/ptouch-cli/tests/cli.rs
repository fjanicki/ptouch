//! End-to-end tests of the `ptouch` binary (no hardware: offline commands and the
//! `virtual:` endpoint only).
//!
//! Goldens live in `tests/golden/`; regenerate with `UPDATE_GOLDEN=1 cargo test -p ptouch-cli`
//! and review the diff (the `.bin` golden is the byte-exact job of PROTOCOL.md §6.3).

// Test helpers outside `#[test]` functions: panicking on setup failures is the intent.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const BIN: &str = env!("CARGO_BIN_EXE_ptouch");

fn ptouch(args: &[&str]) -> Output {
    Command::new(BIN)
        .args(args)
        .env_remove("PTOUCH_DEVICE")
        .output()
        .expect("run ptouch")
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

fn ok(args: &[&str]) -> Output {
    let o = ptouch(args);
    assert!(
        o.status.success(),
        "ptouch {args:?} failed: {}\n{}",
        o.status,
        stderr(&o)
    );
    o
}

fn tmp(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("ptouch-cli-tests");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

/// Compares `actual` with `tests/golden/<name>` (or rewrites it with `UPDATE_GOLDEN=1`).
fn golden(name: &str, actual: &[u8]) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(name);
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, actual).unwrap();
        return;
    }
    let expected = std::fs::read(&path).unwrap_or_else(|_| {
        panic!(
            "missing golden {}; create it with UPDATE_GOLDEN=1",
            path.display()
        )
    });
    if expected != actual {
        let first = expected
            .iter()
            .zip(actual)
            .position(|(a, b)| a != b)
            .unwrap_or(expected.len().min(actual.len()));
        panic!(
            "{name} differs from the golden at byte {first} (expected {} bytes, got {}); \
             regenerate with UPDATE_GOLDEN=1 if the change is intended",
            expected.len(),
            actual.len()
        );
    }
}

// ---------------------------------------------------------------------------------------
// Offline commands that only need the CLI and the model table.

#[test]
fn help_and_version() {
    let o = ok(&["--help"]);
    for cmd in [
        "status",
        "print",
        "test-label",
        "list",
        "info",
        "decode",
        "fonts",
    ] {
        assert!(stdout(&o).contains(cmd), "{cmd} missing from --help");
    }
    ok(&["--version"]);
    // clap usage errors exit with 2.
    assert_eq!(ptouch(&["print"]).status.code(), Some(2));
}

#[test]
fn info_lists_models() {
    let o = ok(&["info"]);
    assert!(stdout(&o).contains("PT-P710BT"));
}

#[test]
fn info_shows_p710bt_print_areas() {
    let o = ok(&["info", "PT-P710BT"]);
    let s = stdout(&o);
    let prints: Vec<&str> = s
        .lines()
        .filter(|l| l.trim_start().starts_with("tze128-"))
        .filter_map(|l| l.split_whitespace().nth(6))
        .collect();
    assert_eq!(prints, ["24", "32", "50", "70", "112", "128"], "{s}");
    // Case-insensitive, prefix optional.
    ok(&["info", "p710bt"]);
}

#[test]
fn info_unknown_model_fails_cleanly() {
    let o = ptouch(&["info", "PT-NOPE"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(stderr(&o).contains("unknown model"), "{}", stderr(&o));
}

#[test]
fn text_preview_golden() {
    let o = ok(&["print", "--text", "Hi", "--tape", "24", "--preview"]);
    golden("text_hi_24mm_preview.txt", &o.stdout);
    assert!(stderr(&o).contains("24 mm TZe"));
}

#[test]
fn multiline_preview_on_12mm() {
    let o = ok(&[
        "print",
        "--text",
        "AB\\nC",
        "--tape",
        "12",
        "--align",
        "left",
        "--preview",
    ]);
    // 70 dots → 35 text rows + 2 frame lines.
    assert_eq!(stdout(&o).lines().count(), 37, "{}", stdout(&o));
}

#[test]
fn test_label_previews_are_deterministic() {
    for kind in ["orientation", "ruler"] {
        let a = ok(&["test-label", kind, "--tape", "24", "--preview"]);
        let b = ok(&["test-label", kind, "--tape", "24", "--preview"]);
        assert_eq!(a.stdout, b.stdout, "{kind}");
        assert!(!a.stdout.is_empty());
    }
    let o = ok(&["test-label", "ruler", "--tape", "24", "--preview"]);
    golden("ruler_24mm_preview.txt", &o.stdout);
}

#[test]
fn preview_png_has_tape_geometry() {
    let path = tmp("hi.png");
    ok(&[
        "print",
        "--text",
        "Hi",
        "--tape",
        "12",
        "--preview-png",
        path.to_str().unwrap(),
    ]);
    let decoder = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(&path).unwrap()));
    let reader = decoder.read_info().unwrap();
    let info = reader.info();
    // 12 mm: 70 printable dots + (84 − 70) / 2 tape edge on each side, ×4.
    assert_eq!(info.height, (70 + 2 * 7) * 4);
    // "Hi" = 11 columns × scale 9, plus 14-dot feed margins, ×4.
    assert_eq!(info.width, (99 + 2 * 14) * 4);
}

#[test]
fn tape_errors_are_clear() {
    let o = ptouch(&["print", "--text", "x", "--tape", "36", "--preview"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(stderr(&o).contains("no 36 mm tape"), "{}", stderr(&o));
    let o = ptouch(&[
        "print",
        "--text",
        "a\\nb\\nc\\nd",
        "--tape",
        "3.5",
        "--preview",
    ]);
    assert_eq!(o.status.code(), Some(1));
    assert!(stderr(&o).contains("prints only"), "{}", stderr(&o));
}

#[test]
fn jpeg_is_rejected_with_a_hint() {
    let path = tmp("photo.jpg");
    std::fs::write(&path, [0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10]).unwrap();
    let o = ptouch(&["print", "--image", path.to_str().unwrap(), "--preview"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(stderr(&o).contains("JPEG"), "{}", stderr(&o));
    assert!(stderr(&o).contains("hint:"), "{}", stderr(&o));
}

#[test]
fn pgm_image_preview() {
    let path = tmp("bar.pgm");
    // 4×2 image: left half black.
    std::fs::write(&path, b"P5 4 2 255\n\x00\x00\xff\xff\x00\x00\xff\xff").unwrap();
    let o = ok(&[
        "print",
        "--image",
        path.to_str().unwrap(),
        "--tape",
        "6",
        "--preview",
    ]);
    // Scaled to 32 dots tall → 64 dots long.
    assert!(stderr(&o).contains("64 dots long"), "{}", stderr(&o));
}

// ---------------------------------------------------------------------------------------
// Dry runs and decoding (encoder + virtual printer decoder).

#[test]
fn dry_run_text_golden_and_decode() {
    let bin = tmp("hi.bin");
    let o = ok(&[
        "print",
        "--text",
        "Hi",
        "--tape",
        "24",
        "--dry-run",
        "--out",
        bin.to_str().unwrap(),
    ]);
    let err = stderr(&o);
    assert!(
        err.contains("virtual printer: 208 command(s), 1 label(s), content matches"),
        "{err}"
    );
    // The same job printed by the real Session against the virtual printer.
    assert!(
        err.lines().any(|l| l
            .starts_with("simulated print (session + virtual printer): 1 label(s)")
            && l.ends_with("content matches")),
        "{err}"
    );
    assert!(!err.contains("violation"), "{err}");
    let bytes = std::fs::read(&bin).unwrap();
    assert_eq!(bytes.last(), Some(&0x1A), "P710BT jobs end with 1A");
    golden("text_hi_24mm.bin", &bytes);

    let pbm = tmp("hi.pbm");
    let o = ok(&[
        "decode",
        bin.to_str().unwrap(),
        "--out",
        pbm.to_str().unwrap(),
    ]);
    assert!(
        stderr(&o).contains("no protocol violations"),
        "{}",
        stderr(&o)
    );
    let page = std::fs::read(&pbm).unwrap();
    assert!(page.starts_with(b"P4"));
    let header = String::from_utf8_lossy(&page[..page.len().min(32)]).into_owned();
    let mut fields = header.split_ascii_whitespace().skip(1);
    let (_w, h) = (fields.next().unwrap(), fields.next().unwrap());
    assert_eq!(h, "128", "{header}");
}

#[test]
fn dry_run_hex_to_stdout_and_determinism() {
    let a = ok(&["test-label", "ruler", "--tape", "24", "--dry-run"]);
    let b = ok(&["test-label", "ruler", "--tape", "24", "--dry-run"]);
    assert_eq!(a.stdout, b.stdout);
    let first = stdout(&a);
    assert!(first.lines().all(|l| l.split(' ').all(|h| h.len() == 2)));
    assert!(first.trim_end().ends_with("1A"));
}

#[test]
fn dry_run_copies_and_options() {
    let bin = tmp("copies.bin");
    ok(&[
        "print",
        "--text",
        "Hi",
        "--tape",
        "12",
        "--copies",
        "2",
        "--chain",
        "--dry-run",
        "--out",
        bin.to_str().unwrap(),
    ]);
    let bytes = std::fs::read(&bin).unwrap();
    assert!(bytes.contains(&0x0C), "two pages are separated by 0C");
    let o = ok(&["decode", bin.to_str().unwrap()]);
    assert!(stderr(&o).contains("2 page(s)"), "{}", stderr(&o));
}

// ---------------------------------------------------------------------------------------
// Full stack against the in-process virtual printer (`virtual:` endpoint).

#[test]
fn virtual_status_shows_fixture_fields() {
    let o = ok(&["--device", "virtual:24", "status"]);
    let s = stdout(&o);
    assert!(s.contains("PT-P710BT"), "{s}");
    assert!(s.contains("24 mm TZe"), "{s}");
    assert!(s.contains("black text on white tape"), "{s}");
    assert!(s.contains("80 20 42 30 76 30 00 00 00 00 18 01"), "{s}");
}

#[test]
fn virtual_print_completes() {
    let o = ok(&["--device", "virtual:24", "print", "--text", "Hi"]);
    assert!(stderr(&o).contains("Done."), "{}", stderr(&o));
}

#[test]
fn virtual_tape_mismatch_is_reported() {
    let o = ptouch(&[
        "--device",
        "virtual:12",
        "print",
        "--text",
        "Hi",
        "--tape",
        "24",
    ]);
    assert_eq!(o.status.code(), Some(1));
    let e = stderr(&o);
    assert!(e.contains("tape mismatch"), "{e}");
    assert!(e.contains("12 mm"), "{e}");
    assert!(e.contains("hint:"), "{e}");
}

#[test]
fn conflicting_connection_flags() {
    let o = ptouch(&["--port", "/dev/null", "--tcp", "localhost", "status"]);
    assert_eq!(o.status.code(), Some(2));
    assert!(stderr(&o).contains("only one of"), "{}", stderr(&o));
}

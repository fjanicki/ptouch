//! `cargo xtask gen-models`: `docs/models.toml` → `crates/ptouch/src/model/generated.rs`.
//!
//! Pipeline: read the TOML → deserialize ([`schema`], `deny_unknown_fields`) → read the
//! `ptouch::Model` variants from `crates/ptouch/src/model/mod.rs` → [`validate`] →
//! [`emit::render`] → `rustfmt` (with the workspace `rustfmt.toml`) → write, or compare in
//! `--check` mode.

mod emit;
mod schema;
mod validate;

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Paths of the generator's inputs and output, relative to the workspace root.
pub const TOML_PATH: &str = "docs/models.toml";
/// Source of the `ptouch::Model` enum (checked against the table).
pub const MODEL_ENUM_PATH: &str = "crates/ptouch/src/model/mod.rs";
/// The generated file.
pub const OUTPUT_PATH: &str = "crates/ptouch/src/model/generated.rs";

/// Outcome of a run.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The file on disk already matched.
    UpToDate,
    /// The file was (re)written.
    Written,
    /// `--check`: the file on disk differs from the generator output.
    Stale,
}

/// The workspace root (the parent of the `xtask` package).
pub fn workspace_root() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest.parent().unwrap_or(manifest).to_path_buf()
}

/// Runs the generator against the workspace at `root`. With `check`, never writes.
pub fn run(root: &Path, check: bool) -> Result<Outcome, String> {
    let generated = generate(root)?;
    let out_path = root.join(OUTPUT_PATH);
    let current = std::fs::read_to_string(&out_path).unwrap_or_default();
    if current == generated {
        return Ok(Outcome::UpToDate);
    }
    if check {
        return Ok(Outcome::Stale);
    }
    std::fs::write(&out_path, generated)
        .map_err(|e| format!("cannot write {}: {e}", out_path.display()))?;
    Ok(Outcome::Written)
}

/// Produces the formatted contents of `generated.rs` for the workspace at `root`.
pub fn generate(root: &Path) -> Result<String, String> {
    let toml_path = root.join(TOML_PATH);
    let text = std::fs::read_to_string(&toml_path)
        .map_err(|e| format!("cannot read {}: {e}", toml_path.display()))?;
    let enum_path = root.join(MODEL_ENUM_PATH);
    let enum_src = std::fs::read_to_string(&enum_path)
        .map_err(|e| format!("cannot read {}: {e}", enum_path.display()))?;
    let variants = model_enum_variants(&enum_src)?;
    let raw = generate_unformatted(&text, &variants)?;
    rustfmt(root, &raw)
}

/// Parses, validates and renders (without `rustfmt`). Pure; used by the tests.
pub fn generate_unformatted(toml_text: &str, enum_variants: &[String]) -> Result<String, String> {
    let table: schema::Table =
        toml::from_str(toml_text).map_err(|e| format!("{TOML_PATH}: {e}"))?;
    validate::validate(&table, enum_variants).map_err(|errs| {
        let mut msg = format!("{TOML_PATH} failed validation ({} problems):", errs.len());
        for e in errs {
            msg.push_str("\n  - ");
            msg.push_str(&e);
        }
        msg
    })?;
    emit::render(&table)
}

/// Extracts the variant names of `pub enum Model { … }` from the module source, in order.
pub fn model_enum_variants(src: &str) -> Result<Vec<String>, String> {
    let start = src
        .find("pub enum Model {")
        .ok_or_else(|| format!("{MODEL_ENUM_PATH}: `pub enum Model {{` not found"))?;
    let body = &src[start + "pub enum Model {".len()..];
    let end = body
        .find('}')
        .ok_or_else(|| format!("{MODEL_ENUM_PATH}: unterminated `enum Model`"))?;
    let variants: Vec<String> = body[..end]
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("//") && !l.starts_with('#'))
        .flat_map(|l| l.split(','))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect();
    if let Some(bad) = variants
        .iter()
        .find(|v| !v.chars().all(|c| c.is_ascii_alphanumeric()))
    {
        return Err(format!(
            "{MODEL_ENUM_PATH}: cannot parse `enum Model` variant {bad:?} (plain unit variants only)"
        ));
    }
    Ok(variants)
}

/// Formats `src` with `rustfmt` using the workspace configuration.
fn rustfmt(root: &Path, src: &str) -> Result<String, String> {
    let rustfmt = std::env::var_os("RUSTFMT").unwrap_or_else(|| "rustfmt".into());
    let mut child = Command::new(&rustfmt)
        .current_dir(root)
        .args(["--edition", "2024", "--emit", "stdout", "--config-path"])
        .arg(root.join("rustfmt.toml"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run rustfmt ({}): {e}", rustfmt.to_string_lossy()))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "rustfmt stdin unavailable".to_owned())?;
    let input = src.to_owned();
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    let output = child
        .wait_with_output()
        .map_err(|e| format!("rustfmt failed: {e}"))?;
    writer
        .join()
        .map_err(|_| "rustfmt writer thread panicked".to_owned())?
        .map_err(|e| format!("cannot write to rustfmt: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "rustfmt exited with {}:\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    String::from_utf8(output.stdout).map_err(|e| format!("rustfmt output is not UTF-8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn real_inputs() -> (String, Vec<String>) {
        let root = workspace_root();
        let toml = std::fs::read_to_string(root.join(TOML_PATH)).unwrap();
        let src = std::fs::read_to_string(root.join(MODEL_ENUM_PATH)).unwrap();
        (toml, model_enum_variants(&src).unwrap())
    }

    /// Drift guard: the checked-in `generated.rs` is exactly what the generator produces.
    /// If this fails, run `cargo xtask gen-models` and commit the result.
    #[test]
    fn checked_in_generated_rs_is_up_to_date() {
        let root = workspace_root();
        let expected = generate(&root).unwrap();
        let actual = std::fs::read_to_string(root.join(OUTPUT_PATH)).unwrap();
        assert!(
            expected == actual,
            "{OUTPUT_PATH} is stale: run `cargo xtask gen-models`"
        );
        assert_eq!(run(&root, true).unwrap(), Outcome::UpToDate);
    }

    #[test]
    fn enum_variants_cover_the_table() {
        let (_, variants) = real_inputs();
        assert_eq!(variants.len(), 27);
        assert_eq!(variants.first().map(String::as_str), Some("PtP710bt"));
    }

    #[test]
    fn output_is_deterministic() {
        let (toml, variants) = real_inputs();
        let a = generate_unformatted(&toml, &variants).unwrap();
        let b = generate_unformatted(&toml, &variants).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn rejects_unknown_keys() {
        let (toml, variants) = real_inputs();
        let bad = toml.replacen("dpi = 180\n", "dpi = 180\nfrobnicate = true\n", 1);
        let err = generate_unformatted(&bad, &variants).unwrap_err();
        assert!(err.contains("frobnicate"), "{err}");
    }

    #[test]
    fn rejects_bad_margins() {
        let (toml, variants) = real_inputs();
        // tze128-24: 0/128/0 → 0/127/0.
        let bad = toml.replacen(
            "left_margin_pins = 0\nprint_pins = 128\n",
            "left_margin_pins = 0\nprint_pins = 127\n",
            1,
        );
        let err = generate_unformatted(&bad, &variants).unwrap_err();
        assert!(err.contains("!= head_pins 128"), "{err}");
    }

    #[test]
    fn rejects_unknown_key_with_value() {
        let (toml, variants) = real_inputs();
        let bad = toml.replacen(
            "unknown = [\"rfcomm_channel_observed\"]",
            "unknown = [\"dpi\"]",
            1,
        );
        let err = generate_unformatted(&bad, &variants).unwrap_err();
        assert!(err.contains("not an optional model key"), "{err}");
    }

    #[test]
    fn rejects_missing_unknown_entry() {
        let (toml, variants) = real_inputs();
        // PT-P710BT: drop min_length_mm without listing it as unknown.
        let bad = toml.replacen("min_length_mm = 4.4\n", "", 1);
        let err = generate_unformatted(&bad, &variants).unwrap_err();
        assert!(err.contains("PT-P710BT: min_length_mm is absent"), "{err}");
    }

    #[test]
    fn rejects_dangling_media_reference() {
        let (toml, variants) = real_inputs();
        let bad = toml.replacen(
            "\"tze128-3.5\", \"tze128-6\"",
            "\"tze128-3\", \"tze128-6\"",
            1,
        );
        let err = generate_unformatted(&bad, &variants).unwrap_err();
        assert!(err.contains("unknown media \"tze128-3\""), "{err}");
    }

    #[test]
    fn rejects_enum_mismatch() {
        let (toml, mut variants) = real_inputs();
        variants.pop();
        let err = generate_unformatted(&toml, &variants).unwrap_err();
        assert!(err.contains("ptouch::Model variants"), "{err}");
    }

    #[test]
    fn parses_enum_variants() {
        let src = "#[derive(Debug)]\npub enum Model {\n    A1,\n    // note\n    B2, C3\n}\n";
        assert_eq!(model_enum_variants(src).unwrap(), ["A1", "B2", "C3"]);
        assert!(model_enum_variants("enum X {}").is_err());
    }
}

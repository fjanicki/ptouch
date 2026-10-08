//! Repository tooling.
//!
//! ```text
//! cargo xtask gen-models           docs/models.toml → crates/ptouch/src/model/generated.rs
//! cargo xtask gen-models --check   exit 1 if generated.rs is stale (CI)
//! ```
//!
//! # Contract for `gen-models`
//! - Parses `docs/models.toml` with `serde` (`deny_unknown_fields`, so a new TOML key is a
//!   build failure until the Rust types learn it).
//! - Validates before emitting: every `media` id a model references exists; for every media
//!   `left + print + right == head_pins` and `head_pins` matches the model; `bytes_per_line ==
//!   head_pins / 8`; every key named in `unknown` is absent; model names map to a
//!   `ptouch::Model` variant (`PT-P710BT` → `PtP710bt`) and every variant is covered.
//!   (Plus the cross-field rules in `gen_models/validate.rs`: protocol-version gates,
//!   `max_print_pins`/`max_tape_mm` agree with the media, FLe-only keys, …)
//! - Emits the exact shape of the seed in `generated.rs` (one `static` per media entry named
//!   after its id, `MEDIA`, `PROFILES`), with mm values in tenths (`*_mm_x10`), hex bytes as
//!   `0xNN`, then runs `rustfmt` on the output. Output is deterministic (TOML order).
//!
//! The drift guard is the `xtask` unit test `checked_in_generated_rs_is_up_to_date`, which
//! runs as part of `cargo test --workspace`.

mod gen_models;

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("gen-models") => {
            let check = match args.get(1..).unwrap_or_default() {
                [] => false,
                [flag] if flag == "--check" => true,
                _ => return usage(),
            };
            let root = gen_models::workspace_root();
            match gen_models::run(&root, check) {
                Ok(gen_models::Outcome::UpToDate) => {
                    println!("{} is up to date", gen_models::OUTPUT_PATH);
                    ExitCode::SUCCESS
                }
                Ok(gen_models::Outcome::Written) => {
                    println!("wrote {}", gen_models::OUTPUT_PATH);
                    ExitCode::SUCCESS
                }
                Ok(gen_models::Outcome::Stale) => {
                    eprintln!(
                        "gen-models: {} is stale; run `cargo xtask gen-models`",
                        gen_models::OUTPUT_PATH
                    );
                    ExitCode::FAILURE
                }
                Err(e) => {
                    eprintln!("gen-models: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        _ => usage(),
    }
}

fn usage() -> ExitCode {
    eprintln!("usage: cargo xtask gen-models [--check]");
    ExitCode::from(2)
}

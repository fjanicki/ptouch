//! Minimal system font lookup for `--font <name>` (no font-database dependency).
//!
//! Scans the platform font directories for `.ttf`/`.otf`/`.ttc`/`.otc` files and reads only
//! the OpenType `name` table of each face (family, subfamily, full name) with positioned
//! reads, so a scan stays cheap. Matching ignores case, spaces and punctuation.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// One face of an installed font file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaceInfo {
    /// Font file.
    pub path: PathBuf,
    /// Face index inside a collection (0 for single fonts).
    pub index: u32,
    /// Family name (typographic family when present), e.g. `Helvetica Neue`.
    pub family: String,
    /// Subfamily / style, e.g. `Bold`.
    pub subfamily: String,
    /// Full name, e.g. `Helvetica Neue Bold`.
    pub full_name: String,
}

/// Platform font directories (existing or not).
#[must_use]
pub fn font_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/System/Library/Fonts"));
        dirs.push(PathBuf::from("/Library/Fonts"));
        if let Some(h) = &home {
            dirs.push(h.join("Library/Fonts"));
        }
    } else if cfg!(windows) {
        let windir =
            std::env::var_os("WINDIR").map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
        dirs.push(windir.join("Fonts"));
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join(r"Microsoft\Windows\Fonts"));
        }
    } else {
        dirs.push(PathBuf::from("/usr/share/fonts"));
        dirs.push(PathBuf::from("/usr/local/share/fonts"));
        if let Some(data) = std::env::var_os("XDG_DATA_HOME") {
            dirs.push(PathBuf::from(data).join("fonts"));
        }
        if let Some(h) = &home {
            dirs.push(h.join(".local/share/fonts"));
            dirs.push(h.join(".fonts"));
        }
    }
    dirs
}

/// Every face found in [`font_dirs`], sorted by full name.
#[must_use]
pub fn scan() -> Vec<FaceInfo> {
    let mut files = Vec::new();
    for dir in font_dirs() {
        collect_font_files(&dir, 0, &mut files);
    }
    files.sort();
    files.dedup();
    let mut faces: Vec<FaceInfo> = files
        .iter()
        .flat_map(|p| read_faces(p).unwrap_or_default())
        .collect();
    faces.sort_by(|a, b| a.full_name.cmp(&b.full_name).then(a.path.cmp(&b.path)));
    faces
}

/// Finds the best face for `query` (see module docs): exact full name, then family + style,
/// then the regular face of a family, then any face of the family, then the file name, then
/// the shortest full name starting with the query.
#[must_use]
pub fn find(query: &str) -> Option<FaceInfo> {
    let q = normalize(query);
    if q.is_empty() {
        return None;
    }
    let faces = scan();
    let rank = |f: &FaceInfo| -> Option<(u8, usize)> {
        let full = normalize(&f.full_name);
        let fam = normalize(&f.family);
        let fam_style = normalize(&format!("{}{}", f.family, f.subfamily));
        let stem = f
            .path
            .file_stem()
            .map(|s| normalize(&s.to_string_lossy()))
            .unwrap_or_default();
        let regular = matches!(
            normalize(&f.subfamily).as_str(),
            "regular" | "book" | "roman" | "normal" | "plain" | ""
        );
        let r = if full == q {
            0
        } else if fam_style == q {
            1
        } else if fam == q && regular {
            2
        } else if fam == q {
            3
        } else if stem == q && f.index == 0 {
            4
        } else if full.starts_with(&q) {
            5
        } else {
            return None;
        };
        Some((r, full.len()))
    };
    faces
        .into_iter()
        .filter_map(|f| rank(&f).map(|r| (r, f)))
        .min_by(|(ra, a), (rb, b)| ra.cmp(rb).then(a.path.cmp(&b.path)))
        .map(|(_, f)| f)
}

/// Lower-case alphanumerics only.
fn normalize(s: &str) -> String {
    s.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn collect_font_files(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
    if depth > 5 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            collect_font_files(&path, depth + 1, out);
        } else if path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
            matches!(
                e.to_ascii_lowercase().as_str(),
                "ttf" | "otf" | "ttc" | "otc"
            )
        }) {
            out.push(path);
        }
    }
}

fn read_at(f: &mut File, offset: u64, len: usize) -> std::io::Result<Vec<u8>> {
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf)?;
    Ok(buf)
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
        *b.get(at + 2)?,
        *b.get(at + 3)?,
    ]))
}

/// Reads the names of every face in a font file or collection.
///
/// # Errors
/// I/O errors; malformed files yield an empty list.
pub fn read_faces(path: &Path) -> std::io::Result<Vec<FaceInfo>> {
    let mut f = File::open(path)?;
    let head = read_at(&mut f, 0, 12)?;
    let offsets: Vec<u32> = if head.get(..4) == Some(b"ttcf") {
        let n = be32(&head, 8).unwrap_or(0).min(256);
        let table = read_at(&mut f, 12, usize::try_from(n).unwrap_or(0) * 4)?;
        (0..usize::try_from(n).unwrap_or(0))
            .filter_map(|i| be32(&table, i * 4))
            .collect()
    } else {
        vec![0]
    };
    let mut faces = Vec::new();
    for (index, off) in (0u32..).zip(offsets) {
        if let Ok(Some((family, subfamily, full_name))) = read_names(&mut f, u64::from(off)) {
            faces.push(FaceInfo {
                path: path.to_path_buf(),
                index,
                family,
                subfamily,
                full_name,
            });
        }
    }
    Ok(faces)
}

/// (family, subfamily, full name) of the face whose table directory starts at `off`.
fn read_names(f: &mut File, off: u64) -> std::io::Result<Option<(String, String, String)>> {
    let dir = read_at(f, off, 12)?;
    let num_tables = usize::from(be16(&dir, 4).unwrap_or(0));
    let records = read_at(f, off + 12, num_tables * 16)?;
    let Some((name_off, name_len)) = (0..num_tables).find_map(|i| {
        let r = records.get(i * 16..i * 16 + 16)?;
        (r.get(..4)? == b"name").then(|| Some((be32(r, 8)?, be32(r, 12)?)))?
    }) else {
        return Ok(None);
    };
    let len = usize::try_from(name_len.min(1 << 20)).unwrap_or(0);
    let table = read_at(f, u64::from(name_off), len)?;
    Ok(parse_name_table(&table))
}

/// Parses an OpenType `name` table.
fn parse_name_table(t: &[u8]) -> Option<(String, String, String)> {
    let count = usize::from(be16(t, 2)?);
    let strings = usize::from(be16(t, 4)?);
    // (name id) → (score, value); higher score wins.
    let mut best: [(u8, String); 5] = Default::default();
    for i in 0..count {
        let r = t.get(6 + i * 12..6 + i * 12 + 12)?;
        let (platform, encoding, language, name_id) =
            (be16(r, 0)?, be16(r, 2)?, be16(r, 4)?, be16(r, 6)?);
        let (len, offset) = (usize::from(be16(r, 8)?), usize::from(be16(r, 10)?));
        let slot = match name_id {
            1 => 0,
            2 => 1,
            4 => 2,
            16 => 3,
            17 => 4,
            _ => continue,
        };
        let Some(raw) = t.get(strings + offset..strings + offset + len) else {
            continue;
        };
        let (score, text) = match (platform, encoding) {
            (3, 1 | 10) | (0, _) => {
                let units: Vec<u16> = raw
                    .chunks_exact(2)
                    .map(|c| u16::from_be_bytes([c[0], c[1]]))
                    .collect();
                let english = platform == 0 || language == 0x0409;
                (
                    if english { 3 } else { 2 },
                    String::from_utf16_lossy(&units),
                )
            }
            (1, 0) => (1, raw.iter().map(|&b| char::from(b)).collect()),
            _ => continue,
        };
        if let Some(entry) = best.get_mut(slot)
            && score > entry.0
            && !text.trim().is_empty()
        {
            *entry = (score, text.trim().to_owned());
        }
    }
    let [family, sub, full, typo_family, typo_sub] = best.map(|(_, s)| s);
    let family = if typo_family.is_empty() {
        family
    } else {
        typo_family
    };
    let sub = if typo_sub.is_empty() { sub } else { typo_sub };
    if family.is_empty() {
        return None;
    }
    let full = if full.is_empty() {
        format!("{family} {sub}").trim().to_owned()
    } else {
        full
    };
    Some((family, sub, full))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a `name` table with Windows English UTF-16 records.
    fn name_table(records: &[(u16, &str)]) -> Vec<u8> {
        let mut strings = Vec::new();
        let mut recs = Vec::new();
        for &(id, s) in records {
            let bytes: Vec<u8> = s.encode_utf16().flat_map(u16::to_be_bytes).collect();
            for v in [
                3u16,
                1,
                0x0409,
                id,
                bytes.len() as u16,
                strings.len() as u16,
            ] {
                recs.extend_from_slice(&v.to_be_bytes());
            }
            strings.extend_from_slice(&bytes);
        }
        let mut t = Vec::new();
        for v in [0u16, records.len() as u16, (6 + recs.len()) as u16] {
            t.extend_from_slice(&v.to_be_bytes());
        }
        t.extend_from_slice(&recs);
        t.extend_from_slice(&strings);
        t
    }

    #[test]
    fn parses_name_records() {
        let t = name_table(&[(1, "Test Sans"), (2, "Bold"), (4, "Test Sans Bold")]);
        assert_eq!(
            parse_name_table(&t),
            Some(("Test Sans".into(), "Bold".into(), "Test Sans Bold".into()))
        );
        // Typographic family wins over the legacy one.
        let t = name_table(&[
            (1, "Test Sans Light"),
            (2, "Regular"),
            (16, "Test Sans"),
            (17, "Light"),
        ]);
        assert_eq!(
            parse_name_table(&t),
            Some(("Test Sans".into(), "Light".into(), "Test Sans Light".into()))
        );
        assert_eq!(parse_name_table(&[0, 0]), None);
        assert_eq!(parse_name_table(&name_table(&[])), None);
    }

    #[test]
    fn normalization() {
        assert_eq!(normalize("Helvetica Neue-Bold_1"), "helveticaneuebold1");
    }

    #[test]
    fn find_rejects_nonsense() {
        assert!(find("").is_none());
        assert!(find("zzzz no such font qqqq").is_none());
    }
}

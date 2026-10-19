//! Bounded literal-text search and optimistic, per-file replacement.
use crate::files;
use regex::{NoExpand, Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

#[derive(Serialize)]
pub struct Match {
    pub line: usize,
    pub text: String,
}
#[derive(Serialize, Deserialize)]
pub struct Snapshot {
    pub path: String,
    pub original: String,
}
#[derive(Serialize)]
pub struct SearchFile {
    pub path: String,
    pub original: String,
    pub matches: Vec<Match>,
    pub count: usize,
}
#[derive(Serialize)]
pub struct Results {
    pub files: Vec<SearchFile>,
    pub truncated: bool,
    pub skipped: usize,
}
#[derive(Serialize)]
pub struct Replacement {
    pub modified: Vec<String>,
    pub errors: Vec<String>,
}
fn pattern(query: &str, case_sensitive: bool) -> Result<Regex, String> {
    if query.is_empty() {
        return Err("Enter text to search for".into());
    }
    RegexBuilder::new(&regex::escape(query))
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| e.to_string())
}
pub fn search(root: &str, query: &str, case_sensitive: bool) -> Result<Results, String> {
    let pattern = pattern(query, case_sensitive)?;
    let root = Path::new(root).canonicalize().map_err(|e| e.to_string())?;
    let mut result = Results {
        files: vec![],
        truncated: false,
        skipped: 0,
    };
    let mut bytes = 0;
    let mut hits = 0;
    let mut scanned = 0;
    let walker = ignore::WalkBuilder::new(&root)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| {
            ![
                ".git",
                "node_modules",
                "target",
                ".next",
                ".turbo",
                "__pycache__",
            ]
            .iter()
            .any(|n| e.file_name() == *n)
        })
        .build();
    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        scanned += 1;
        if scanned > 25_000 {
            result.truncated = true;
            break;
        }
        let file = match files::read_file(&entry.path().to_string_lossy()) {
            Ok(f) => f,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        let count = pattern.find_iter(&file.content).count();
        if count == 0 {
            continue;
        }
        if bytes + file.content.len() > 8 * 1024 * 1024
            || result.files.len() >= 200
            || hits + count > 2000
        {
            result.truncated = true;
            break;
        }
        bytes += file.content.len();
        hits += count;
        let matches = file
            .content
            .lines()
            .enumerate()
            .filter(|(_, s)| pattern.is_match(s))
            .map(|(i, s)| Match {
                line: i + 1,
                text: s.chars().take(400).collect(),
            })
            .collect();
        result.files.push(SearchFile {
            path: entry
                .path()
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            original: file.content,
            matches,
            count,
        });
    }
    result.files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}
pub fn replace(
    root: &str,
    query: &str,
    replacement: &str,
    case_sensitive: bool,
    snapshots: Vec<Snapshot>,
) -> Result<Replacement, String> {
    let pattern = pattern(query, case_sensitive)?;
    let root = Path::new(root).canonicalize().map_err(|e| e.to_string())?;
    let mut result = Replacement {
        modified: vec![],
        errors: vec![],
    };
    for snapshot in snapshots {
        let apply = || -> Result<(), String> {
            let rel = Path::new(&snapshot.path);
            if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
                return Err("Invalid relative path".into());
            }
            let path = root.join(rel);
            if std::fs::symlink_metadata(&path)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err("Symbolic links aren't replaced".into());
            }
            if !path
                .canonicalize()
                .map_err(|e| e.to_string())?
                .starts_with(&root)
            {
                return Err("File is outside the project".into());
            }
            let current = files::read_file(&path.to_string_lossy())?.content;
            if current != snapshot.original {
                return Err("Changed since search; search again before replacing".into());
            }
            let next = pattern.replace_all(&current, NoExpand(replacement));
            files::write_file(&path.to_string_lossy(), &next)?;
            Ok(())
        };
        match apply() {
            Ok(()) => result.modified.push(snapshot.path),
            Err(e) => result.errors.push(format!("{}: {e}", snapshot.path)),
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn searches_ignored_files_and_replaces_without_clobbering_changes() {
        let dir = std::env::temp_dir().join(format!("desk-search-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), "skip.txt\n").unwrap();
        std::fs::write(dir.join("skip.txt"), "hello").unwrap();
        std::fs::write(dir.join("a.txt"), "Hello hello\n").unwrap();
        std::fs::write(dir.join("b.txt"), "hello\n").unwrap();
        let found = search(dir.to_str().unwrap(), "hello", false).unwrap();
        assert_eq!(found.files.len(), 2);
        assert_eq!(found.files[0].count, 2);
        std::fs::write(dir.join("b.txt"), "external edit").unwrap();
        let snapshots = found
            .files
            .into_iter()
            .map(|f| Snapshot {
                path: f.path,
                original: f.original,
            })
            .collect();
        let replaced =
            replace(dir.to_str().unwrap(), "hello", "$literal", false, snapshots).unwrap();
        assert_eq!(replaced.modified, ["a.txt"]);
        assert_eq!(replaced.errors.len(), 1);
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "$literal $literal\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("b.txt")).unwrap(),
            "external edit"
        );
        let escape = replace(
            dir.to_str().unwrap(),
            "x",
            "y",
            true,
            vec![Snapshot {
                path: "../outside".into(),
                original: "x".into(),
            }],
        )
        .unwrap();
        assert_eq!(escape.errors.len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

//! File tree, editor I/O and change notifications for project folders.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use ignore::WalkBuilder;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

const MAX_EDIT_BYTES: u64 = 8 * 1024 * 1024;
const QUICK_OPEN_LIMIT: usize = 25_000;
const WATCH_DEBOUNCE: Duration = Duration::from_millis(120);
const NOISY_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    ".next",
    ".turbo",
    "__pycache__",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub ignored: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub mtime: u64,
}

fn mtime(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// One level of a directory. Git-ignored entries are kept but flagged so the
/// tree can dim them, matching what editors usually show.
pub fn list_dir(path: &str) -> Result<Vec<Entry>, String> {
    let dir = Path::new(path);
    let visible: HashSet<PathBuf> = WalkBuilder::new(dir)
        .max_depth(Some(1))
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .require_git(false)
        .build()
        .flatten()
        .map(|e| e.into_path())
        .collect();

    let mut entries: Vec<Entry> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name == ".git" || name == ".DS_Store" {
                return None;
            }
            let path = e.path();
            let is_dir = fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
            Some(Entry {
                ignored: !visible.contains(&path),
                path: path.to_string_lossy().into_owned(),
                name,
                is_dir,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Every non-ignored file under `root`, relative paths, for quick open.
pub fn list_files(root: &str) -> Vec<String> {
    let root_path = Path::new(root);
    WalkBuilder::new(root_path)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build()
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| {
            e.path()
                .strip_prefix(root_path)
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        })
        .take(QUICK_OPEN_LIMIT)
        .collect()
}

pub fn read_file(path: &str) -> Result<FileContent, String> {
    let p = Path::new(path);
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_EDIT_BYTES {
        return Err(format!(
            "File is {} MB. Desk opens files up to 8 MB.",
            meta.len() / 1_048_576
        ));
    }
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Err("Desk can't show this kind of file. Open it in its default app instead.".into());
    }
    let content =
        String::from_utf8(bytes).map_err(|_| "File isn't valid UTF-8 text.".to_string())?;
    Ok(FileContent {
        content,
        mtime: mtime(p),
    })
}

/// Largest file the image, PDF and media viewers load.
const MAX_VIEW_BYTES: u64 = 200 * 1024 * 1024;

/// The raw bytes of a file for the viewers (images, PDFs, audio and video).
pub fn read_bytes(path: &str) -> Result<Vec<u8>, String> {
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > MAX_VIEW_BYTES {
        return Err(format!("File is {} MB. Desk shows files up to 200 MB; open it in its default app instead.", size / 1_048_576));
    }
    fs::read(path).map_err(|e| e.to_string())
}

/// Writes via a temp file and rename so a crash never leaves a half-written file.
pub fn write_file(path: &str, content: &str) -> Result<u64, String> {
    let p = Path::new(path);
    let name = p.file_name().ok_or("invalid path")?.to_string_lossy();
    let tmp = p.with_file_name(format!(".{name}.desk-tmp"));
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    if let Ok(meta) = fs::metadata(p) {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }
    fs::rename(&tmp, p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(mtime(p))
}

pub fn create_file(path: &str) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn create_dir(path: &str) -> Result<(), String> {
    if Path::new(path).exists() {
        return Err("Something with that name already exists".into());
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

pub fn rename(from: &str, to: &str) -> Result<(), String> {
    if Path::new(to).exists() {
        return Err("Something with that name already exists".into());
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}

pub fn move_to_trash(path: &str) -> Result<(), String> {
    trash::delete(path).map_err(|e| e.to_string())
}

pub fn git_branch(root: &str) -> Option<String> {
    let head = fs::read_to_string(Path::new(root).join(".git/HEAD")).ok()?;
    let head = head.trim();
    Some(match head.strip_prefix("ref: refs/heads/") {
        Some(branch) => branch.to_string(),
        None => head.chars().take(7).collect(),
    })
}

/// Files Git rewrites when the branch, the staged files or the commits change.
/// They are let through so the Git panel refreshes without polling.
fn is_git_state(rel: &Path) -> bool {
    let Ok(inner) = rel.strip_prefix(".git") else { return false };
    if inner.extension().is_some_and(|e| e == "lock") {
        return false;
    }
    [Path::new("HEAD"), Path::new("index"), Path::new("packed-refs")].contains(&inner) || inner.starts_with("refs")
}

fn is_noisy(path: &Path, root: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return true;
    };
    if is_git_state(rel) {
        return false;
    }
    rel.components()
        .any(|c| NOISY_DIRS.iter().any(|n| c.as_os_str() == *n))
        || rel
            .file_name()
            .map(|n| n.to_string_lossy().ends_with(".desk-tmp"))
            .unwrap_or(false)
}

/// One recursive watcher per project root, debounced into batches of paths.
#[derive(Default)]
pub struct Watchers {
    active: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl Watchers {
    pub fn watch<F>(&self, root: String, emit: F) -> Result<(), String>
    where
        F: Fn(&str, Vec<String>) + Send + 'static,
    {
        let mut active = self.active.lock().unwrap();
        if active.contains_key(&root) {
            return Ok(());
        }
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                for p in event.paths {
                    let _ = tx.send(p);
                }
            }
        })
        .map_err(|e| e.to_string())?;
        watcher
            .watch(Path::new(&root), RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;

        let root_for_thread = root.clone();
        thread::Builder::new()
            .name("fs-watch".into())
            .spawn(move || {
                let root_path = PathBuf::from(&root_for_thread);
                while let Ok(first) = rx.recv() {
                    let mut batch: HashSet<PathBuf> = HashSet::from([first]);
                    let deadline = Instant::now() + WATCH_DEBOUNCE;
                    loop {
                        let now = Instant::now();
                        if now >= deadline {
                            break;
                        }
                        match rx.recv_timeout(deadline - now) {
                            Ok(p) => {
                                batch.insert(p);
                            }
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    let paths: Vec<String> = batch
                        .into_iter()
                        .filter(|p| !is_noisy(p, &root_path))
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect();
                    if !paths.is_empty() {
                        emit(&root_for_thread, paths);
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        active.insert(root, watcher);
        Ok(())
    }

    pub fn unwatch(&self, root: &str) {
        // Dropping the watcher closes the channel, which ends the debounce thread.
        self.active.lock().unwrap().remove(root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lets_git_state_through_the_watcher() {
        let root = Path::new("/r");
        for path in [".git/HEAD", ".git/index", ".git/packed-refs", ".git/refs/heads/main", "src/a.ts"] {
            assert!(!is_noisy(&root.join(path), root), "{path}");
        }
        for path in [".git/index.lock", ".git/objects/ab/cd", ".git/refs/heads/main.lock", "node_modules/x/y.js"] {
            assert!(is_noisy(&root.join(path), root), "{path}");
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("desk-files-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_dirs_first_and_flags_ignored() {
        let dir = scratch("list");
        fs::write(dir.join(".gitignore"), "dist\n").unwrap();
        fs::create_dir(dir.join("dist")).unwrap();
        fs::create_dir(dir.join("src")).unwrap();
        fs::write(dir.join("b.txt"), "").unwrap();
        fs::write(dir.join("A.txt"), "").unwrap();
        let entries = list_dir(dir.to_str().unwrap()).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["dist", "src", ".gitignore", "A.txt", "b.txt"]);
        assert!(entries[0].ignored);
        assert!(!entries[1].ignored);
        let files = list_files(dir.to_str().unwrap());
        assert!(files.contains(&"A.txt".to_string()));
        assert!(!files.iter().any(|f| f.starts_with("dist")));
    }

    #[test]
    fn round_trips_and_rejects_binary() {
        let dir = scratch("rw");
        let file = dir.join("x.rs");
        let path = file.to_str().unwrap();
        write_file(path, "fn main() {}\n").unwrap();
        assert_eq!(read_file(path).unwrap().content, "fn main() {}\n");
        fs::write(&file, [0u8, 1, 2]).unwrap();
        assert!(read_file(path).is_err());
        assert!(create_file(path).is_err());
    }
}

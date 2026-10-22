//! Small differences between macOS and Windows.
//!
//! The interface works with forward-slash paths everywhere (`C:/Users/me/app` on
//! Windows). Windows accepts them, so paths handed to the interface go through
//! `slash`, and paths read from other tools are compared with `same_path`.

use std::path::Path;

/// A path as the interface expects it: forward slashes on every platform.
pub fn slash(path: impl AsRef<Path>) -> String {
    let s = path.as_ref().to_string_lossy();
    if cfg!(windows) { s.replace('\\', "/") } else { s.into_owned() }
}

/// Windows paths ignore case and can use either slash.
fn key(path: &str) -> String {
    let path = path.trim_end_matches(['/', '\\']);
    if cfg!(windows) { path.replace('\\', "/").to_lowercase() } else { path.to_string() }
}

pub fn same_path(a: &str, b: &str) -> bool {
    key(a) == key(b)
}

/// Whether `path` is `prefix` followed by more (compared like `same_path`).
/// `sep` is what must come right after the prefix, e.g. "/" for "inside".
pub fn has_prefix(path: &str, prefix: &str, sep: &str) -> bool {
    key(path).starts_with(&format!("{}{sep}", key(prefix)))
}

/// Opens a web link in the default browser.
pub fn open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    let mut command = {
        // rundll32 hands the URL straight to the registered browser, with no shell parsing.
        let mut c = std::process::Command::new("rundll32.exe");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut c = std::process::Command::new("/usr/bin/open");
        c.arg(url);
        c
    };
    command.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Shows a file selected in Finder or File Explorer.
pub fn reveal(path: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // explorer wants exactly `/select,"C:\path"`, unescaped by the usual argument quoting.
        let native = path.replace('/', "\\");
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{native}\""))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_paths() {
        assert!(same_path("/a/b/", "/a/b"));
        assert!(has_prefix("/a/b/c", "/a/b", "/"));
        assert!(has_prefix("/a/b.worktrees/x", "/a/b", ".worktrees/"));
        assert!(!has_prefix("/a/bc", "/a/b", "/"));
        if cfg!(windows) {
            assert!(same_path("C:\\Users\\Me\\app", "c:/users/me/app"));
        }
    }
}

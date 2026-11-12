//! Saved SSH connections. Passwords are kept in Desk's own support folder, one
//! owner-only file per connection, never in the workspace state, argv or env.
//! When a saved connection starts, ssh asks Desk's askpass helper, which reads
//! that file.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// ssh runs this for every prompt while a saved connection starts. The saved
/// password answers the first password prompt of each ssh process. Any other prompt
/// (host key confirmation, one-time codes) and any retry after a wrong password is
/// asked in the terminal, so a bad saved password is never sent repeatedly.
const ASKPASS: &str = r#"#!/bin/sh
# Written by Desk. Answers ssh's password prompt with the connection's saved password.
prompt=${1:-"Password: "}
lower=$(printf '%s' "$prompt" | tr '[:upper:]' '[:lower:]')
case $lower in
  *password*)
    state="${TMPDIR:-/tmp}/desk-askpass"
    mkdir -p "$state" 2>/dev/null
    if [ -r "$DESK_SSH_SECRET" ] && mkdir "$state/${DESK_SSH_SESSION:-0}-$PPID" 2>/dev/null; then
      printf '%s(saved password)\n' "$prompt" >/dev/tty 2>/dev/null
      /usr/bin/xxd -r -p <"$DESK_SSH_SECRET"
      exit 0
    fi
    ;;
esac
case $lower in
  *password*|*passphrase*|*pin*|*code*|*token*|*otp*) hide=1 ;;
  *) hide= ;;
esac
printf '%s' "$prompt" >/dev/tty
[ -n "$hide" ] && stty -echo </dev/tty
IFS= read -r answer </dev/tty
status=$?
if [ -n "$hide" ]; then
  stty echo </dev/tty
  printf '\n' >/dev/tty
fi
[ "$status" -eq 0 ] || exit 1
printf '%s\n' "$answer"
"#;

fn check_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok { Ok(()) } else { Err(format!("invalid connection id: {id}")) }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn support_dir() -> Result<PathBuf, String> {
    Ok(dirs::data_dir().ok_or("no Application Support folder")?.join(crate::variant::app_dir()))
}

/// Owner-only folder holding one file per saved password.
fn secrets_dir() -> Result<PathBuf, String> {
    let dir = support_dir()?.join("ssh-passwords");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn secret_path(id: &str) -> Result<PathBuf, String> {
    check_id(id)?;
    Ok(secrets_dir()?.join(id))
}

pub fn has_password(id: &str) -> bool {
    secret_path(id).is_ok_and(|p| p.is_file())
}

/// Saves the password hex-encoded so the shell helper can pass any bytes through.
/// The file is created owner-only before anything is written to it.
pub fn save_password(id: &str, password: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if password.is_empty() {
        return Err("The password is empty.".into());
    }
    let path = secret_path(id)?;
    let tmp = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    file.write_all(hex(password.as_bytes()).as_bytes()).map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn delete_password(id: &str) -> Result<(), String> {
    match std::fs::remove_file(secret_path(id)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Writes the askpass helper (owner-only) and returns its path. Rewritten every
/// time so an old or modified copy never lingers.
pub fn askpass_path(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join("ssh-askpass");
    let tmp = dir.join(".ssh-askpass.tmp");
    std::fs::write(&tmp, ASKPASS).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

/// The `export` line that turns the helper on for one connection's command.
pub fn askpass_exports(id: &str, session: u64) -> Result<String, String> {
    let askpass = askpass_path(&support_dir()?)?;
    let secret = secret_path(id)?;
    let quote = |p: &Path| {
        let s = p.to_string_lossy().into_owned();
        if s.contains('\'') { Err("Desk's support folder path contains a quote.".to_string()) } else { Ok(format!("'{s}'")) }
    };
    Ok(format!(
        "export SSH_ASKPASS={} SSH_ASKPASS_REQUIRE=force DESK_SSH_SECRET={} DESK_SSH_SESSION='{session}'",
        quote(&askpass)?,
        quote(&secret)?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_ids() {
        assert!(check_id("8d3e-41aa-9f").is_ok());
        assert!(check_id("a b").is_err());
        assert!(check_id("../x").is_err());
        assert!(check_id("").is_err());
    }

    #[test]
    fn hex_encodes_any_bytes() {
        assert_eq!(hex("p@ss w\"rd\\é".as_bytes()), "7040737320772272645cc3a9");
    }

    #[test]
    fn saved_password_is_owner_only_and_removable() {
        let id = format!("desk-test-{}", std::process::id());
        save_password(&id, "s3cret").unwrap();
        let path = secret_path(&id).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), hex(b"s3cret"));
        delete_password(&id).unwrap();
        assert!(!has_password(&id));
        delete_password(&id).unwrap();
    }

    #[test]
    fn askpass_is_owner_only() {
        let dir = std::env::temp_dir().join(format!("desk-askpass-test-{}", std::process::id()));
        let path = askpass_path(&dir).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
        let _ = std::fs::remove_dir_all(dir);
    }
}

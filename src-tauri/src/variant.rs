//! Desk, or "Desk Dev": a side-by-side test build that keeps its own data, so it
//! can run next to an installed Desk without touching it. Chosen at build time:
//! `DESK_VARIANT=dev` (see `npm run dev:app` and `npm run build:dev-app`).

pub const DEV: bool = match option_env!("DESK_VARIANT") {
    Some(v) => !v.is_empty(),
    None => false,
};

/// The app's name, for the menu bar icon's tooltip.
pub fn name() -> &'static str {
    if DEV { "Desk Dev" } else { "Desk" }
}

/// Folder name under Application Support (state, limits, saved passwords).
pub fn app_dir() -> &'static str {
    if DEV { "Desk Dev" } else { "Desk" }
}

/// Folder in your home folder (the bridge socket).
pub fn home_dir() -> &'static str {
    if DEV { ".desk-dev" } else { ".desk" }
}

/// Folder name under Caches (chat attachments).
pub fn cache_dir() -> &'static str {
    if DEV { "dev.desk.DeskDev" } else { "dev.desk.Desk" }
}

#[cfg(test)]
mod tests {
    #[test]
    fn release_build_keeps_desks_own_folders() {
        if !super::DEV {
            assert_eq!(super::app_dir(), "Desk");
            assert_eq!(super::home_dir(), ".desk");
            assert_eq!(super::cache_dir(), "dev.desk.Desk");
        }
    }
}

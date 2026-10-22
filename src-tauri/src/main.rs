// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    if let Some(code) = desk_lib::askpass_main() {
        std::process::exit(code);
    }
    desk_lib::run()
}

mod accounts;
mod files;
mod git;
mod pty;
mod search;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

use pty::{PtyManager, SpawnOpts};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExit {
    id: u32,
    code: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChange {
    root: String,
    paths: Vec<String>,
}

fn state_file() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Desk")
        .join("state.json")
}

#[derive(Default)]
struct QuitState(AtomicBool);

#[tauri::command]
fn workspace_exit(app: AppHandle, quit: State<'_, QuitState>) {
    quit.0.store(true, Ordering::SeqCst);
    app.exit(0);
}

// Terminal sessions

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    manager: State<'_, Arc<PtyManager>>,
    opts: SpawnOpts,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    manager.spawn(
        opts,
        move |bytes| {
            let _ = on_data.send(InvokeResponseBody::Raw(bytes));
        },
        move |id, code| {
            let _ = app.emit("pty-exit", PtyExit { id, code });
        },
    )
}

#[tauri::command]
fn pty_write(manager: State<'_, Arc<PtyManager>>, id: u32, data: String) -> Result<(), String> {
    manager.write(id, data.as_bytes())
}

#[tauri::command]
fn pty_write_bytes(
    manager: State<'_, Arc<PtyManager>>,
    id: u32,
    data: Vec<u8>,
) -> Result<(), String> {
    manager.write(id, &data)
}

#[tauri::command]
fn pty_resize(
    manager: State<'_, Arc<PtyManager>>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(id, cols, rows)
}

#[tauri::command]
fn pty_kill(manager: State<'_, Arc<PtyManager>>, id: u32) {
    manager.kill(id);
}

// Accounts

#[tauri::command]
fn accounts_detect() -> Vec<accounts::DetectedAccount> {
    accounts::detect()
}

#[tauri::command]
fn account_inspect(kind: String, dir: Option<String>) -> Result<accounts::DetectedAccount, String> {
    accounts::inspect(&kind, dir)
}

#[tauri::command]
async fn account_usage(path: String, dirs: Vec<Option<String>>) -> Vec<accounts::Usage> {
    tauri::async_runtime::spawn_blocking(move || accounts::claude_usage(&path, dirs))
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn account_create(kind: String, name: String) -> Result<String, String> {
    accounts::create(&kind, &name)
}

// Persisted app state (projects, accounts, layout). The frontend owns its shape.

#[tauri::command]
fn state_load() -> Value {
    std::fs::read_to_string(state_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

#[tauri::command]
fn state_save(state: Value) -> Result<(), String> {
    let path = state_file();
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    files::write_file(&path.to_string_lossy(), &json).map(|_| ())
}

// Files

#[tauri::command]
fn fs_list_dir(path: String) -> Result<Vec<files::Entry>, String> {
    files::list_dir(&path)
}

#[tauri::command]
async fn fs_list_files(root: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || files::list_files(&root))
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn fs_read(path: String) -> Result<files::FileContent, String> {
    files::read_file(&path)
}

#[tauri::command]
fn fs_write(path: String, content: String) -> Result<u64, String> {
    files::write_file(&path, &content)
}

#[tauri::command]
fn fs_create_file(path: String) -> Result<(), String> {
    files::create_file(&path)
}

#[tauri::command]
fn fs_create_dir(path: String) -> Result<(), String> {
    files::create_dir(&path)
}

#[tauri::command]
fn fs_rename(from: String, to: String) -> Result<(), String> {
    files::rename(&from, &to)
}

#[tauri::command]
fn fs_trash(path: String) -> Result<(), String> {
    files::move_to_trash(&path)
}

#[tauri::command]
fn fs_watch(
    app: AppHandle,
    watchers: State<'_, files::Watchers>,
    root: String,
) -> Result<(), String> {
    watchers.watch(root, move |root, paths| {
        let _ = app.emit(
            "fs-change",
            FsChange {
                root: root.to_string(),
                paths,
            },
        );
    })
}

#[tauri::command]
fn fs_unwatch(watchers: State<'_, files::Watchers>, root: String) {
    watchers.unwatch(&root);
}

#[tauri::command]
fn git_branch(root: String) -> Option<String> {
    files::git_branch(&root)
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
async fn git_status(root: String) -> Result<git::Status, String> {
    tauri::async_runtime::spawn_blocking(move || git::status(&root))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn git_diff(root: String, path: String, staged: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git::diff(&root, &path, staged))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn git_stage(root: String, path: String, staged: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::stage(&root, &path, staged))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn git_commit(root: String, message: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git::commit(&root, &message))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn project_search(
    root: String,
    query: String,
    case_sensitive: bool,
) -> Result<search::Results, String> {
    tauri::async_runtime::spawn_blocking(move || search::search(&root, &query, case_sensitive))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn project_replace(
    root: String,
    query: String,
    replacement: String,
    case_sensitive: bool,
    snapshots: Vec<search::Snapshot>,
) -> Result<search::Replacement, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search::replace(&root, &query, &replacement, case_sensitive, snapshots)
    })
    .await
    .map_err(|e| e.to_string())?
}

// macOS integration

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only web links can be opened".into());
    }
    std::process::Command::new("/usr/bin/open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Standard macOS menus. Close Window is left out on purpose: Cmd+W closes the
/// current tab inside Desk instead of the whole window.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let about = AboutMetadata {
        name: Some("Desk".into()),
        ..Default::default()
    };
    let app_menu = Submenu::with_items(
        app,
        "Desk",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Desk"), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(PtyManager::default()))
        .manage(files::Watchers::default())
        .manage(QuitState::default())
        .menu(build_menu)
        .invoke_handler(tauri::generate_handler![
            workspace_exit,
            pty_spawn,
            pty_write,
            pty_write_bytes,
            pty_resize,
            pty_kill,
            accounts_detect,
            account_inspect,
            account_create,
            account_usage,
            state_load,
            state_save,
            fs_list_dir,
            fs_list_files,
            fs_read,
            fs_write,
            fs_create_file,
            fs_create_dir,
            fs_rename,
            fs_trash,
            fs_watch,
            fs_unwatch,
            git_branch,
            git_status,
            git_diff,
            git_stage,
            git_commit,
            project_search,
            project_replace,
            path_exists,
            open_external,
            reveal_in_finder,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Desk");

    app.run(|handle, event| match event {
        RunEvent::ExitRequested { api, .. }
            if !handle.state::<QuitState>().0.load(Ordering::SeqCst) =>
        {
            api.prevent_exit();
            let _ = handle.emit("desk-quit", ());
        }
        RunEvent::Exit => handle.state::<Arc<PtyManager>>().kill_all(),
        _ => {}
    });
}

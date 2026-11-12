mod accounts;
mod files;
mod gh;
mod git;
mod limits;
mod bridge;
mod browser;
mod chat;
mod pty;
mod search;
mod sessions;
mod notch;
mod sandbox;
mod tray;
mod ssh;
mod usage_live;
mod variant;

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
        .join(variant::app_dir())
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
fn pty_set_background(manager: State<'_, Arc<PtyManager>>, id: u32, background: bool) {
    manager.set_background(id, background);
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

// Chat mode

#[tauri::command]
fn chat_spawn(chats: State<'_, Arc<chat::ChatManager>>, opts: chat::ChatOpts, on_line: Channel<String>) -> Result<u32, String> {
    chats.spawn(opts, move |line| {
        let _ = on_line.send(line);
    })
}

#[tauri::command]
fn chat_write(chats: State<'_, Arc<chat::ChatManager>>, id: u32, line: String) -> Result<(), String> {
    chats.write(id, &line)
}

#[tauri::command]
fn chat_kill(chats: State<'_, Arc<chat::ChatManager>>, id: u32) {
    chats.kill(id);
}

#[tauri::command]
async fn attachment_save(name: String, data: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || chat::save_attachment(&name, &data)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn attachment_image(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || chat::read_image(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn chat_history(tool: String, dir: Option<String>, cwd: String, id: String) -> Value {
    tauri::async_runtime::spawn_blocking(move || chat::history(&tool, dir, &cwd, &id)).await.unwrap_or(Value::Null)
}

#[tauri::command]
fn codex_models(dir: Option<String>) -> Value {
    chat::codex_models(dir)
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

#[tauri::command]
async fn tool_installed(bins: Vec<String>) -> bool {
    tauri::async_runtime::spawn_blocking(move || accounts::tool_installed(bins)).await.unwrap_or(false)
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

/// Sent as raw bytes (no JSON or base64), so a big image or PDF costs one copy.
#[tauri::command]
async fn fs_read_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || files::read_bytes(&path)).await.map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Opens a file in its default app (Preview, Numbers, ...).
#[tauri::command]
fn open_default(path: String) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open").arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
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
async fn git_change_count(root: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || git::change_count(&root))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn git_stage_all(root: String, staged: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::stage_all(&root, staged))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn git_discard(root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::discard(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn git_worktrees(root: String) -> Result<Vec<git::Worktree>, String> {
    tauri::async_runtime::spawn_blocking(move || git::worktrees(&root))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn git_branches(root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || git::branches(&root))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn git_worktree_path(root: String, branch: String) -> Result<String, String> {
    git::check_branch(&branch)?;
    git::worktree_path(&root, &branch)
}
#[tauri::command]
async fn git_worktree_add(root: String, branch: String, base: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git::add_worktree(&root, &branch, &base))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn git_commits_since(root: String, base: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || git::commits_since(&root, &base)).await.map_err(|e| e.to_string())?
}
// Async so they run off the main thread, which creating the webview needs.
#[tauri::command]
async fn browser_open(app: AppHandle, url: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    browser::open(&app, &url, x, y, width, height)
}
#[tauri::command]
async fn browser_bounds(app: AppHandle, x: f64, y: f64, width: f64, height: f64, visible: bool) -> Result<(), String> {
    browser::bounds(&app, x, y, width, height, visible)
}
#[tauri::command]
async fn browser_command(app: AppHandle, action: String) -> Result<(), String> {
    browser::command(&app, &action)
}
#[tauri::command]
async fn browser_close(app: AppHandle) -> Result<(), String> {
    browser::close(&app)
}
#[tauri::command]
async fn gh_run(cwd: String, args: Vec<String>, config: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || gh::run(&cwd, &args, config.as_deref())).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn git_push(root: String, config: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gh::push(&root, config.as_deref())).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn gh_pr_worktree(root: String, number: u32, config: Option<String>) -> Result<gh::PrWorktree, String> {
    tauri::async_runtime::spawn_blocking(move || gh::pr_worktree(&root, number, config.as_deref())).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn git_task_worktree(root: String, slug: String) -> Result<git::TaskWorktree, String> {
    tauri::async_runtime::spawn_blocking(move || git::task_worktree(&root, &slug))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn git_worktree_remove(root: String, path: String, force: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::remove_worktree(&root, &path, force))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn git_branch_delete(root: String, branch: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::delete_branch(&root, &branch))
        .await
        .map_err(|e| e.to_string())?
}

// Past conversations

#[tauri::command]
async fn sessions_list(project: String, claude: Vec<Option<String>>, codex: Vec<Option<String>>) -> Vec<sessions::Session> {
    tauri::async_runtime::spawn_blocking(move || sessions::list(&project, claude, codex))
        .await
        .unwrap_or_default()
}
#[tauri::command]
async fn session_trash(tool: String, dir: Option<String>, cwd: String, id: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || sessions::trash(&tool, dir, &cwd, &id, &sessions::user_trash()))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn claude_session_state(dir: Option<String>, cwd: String, id: String) -> &'static str {
    tauri::async_runtime::spawn_blocking(move || sessions::claude_state(dir, &cwd, &id))
        .await
        .unwrap_or("missing")
}

#[tauri::command]
async fn usage_limits(claude: Vec<Option<String>>, codex: Vec<Option<String>>) -> Vec<limits::Limits> {
    tauri::async_runtime::spawn_blocking(move || usage_live::merge(limits::list(claude, codex)))
        .await
        .unwrap_or_default()
}
/// Asks each provider for live numbers (in the background, every few minutes), then lists as above.
#[tauri::command]
async fn usage_refresh(claude: Vec<Option<String>>, codex: Vec<Option<String>>) -> Vec<limits::Limits> {
    tauri::async_runtime::spawn_blocking(move || {
        for e in usage_live::refresh(claude.clone(), codex.clone()) {
            eprintln!("usage: {e}");
        }
        usage_live::merge(limits::list(claude, codex))
    })
    .await
    .unwrap_or_default()
}
#[tauri::command]
fn claude_limits_hook(dir: Option<String>, cwd: String) -> Result<limits::ClaudeHook, String> {
    limits::claude_hook(dir, &cwd)
}

/// Dock badge with the number of agents waiting, and one bounce for a new one.
#[tauri::command]
fn attention(app: AppHandle, count: u32, bounce: bool) {
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.set_badge_count((count > 0).then_some(count as i64));
    if bounce {
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
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

// Saved SSH connections

#[tauri::command]
async fn ssh_save_password(id: String, password: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ssh::save_password(&id, &password))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ssh_forget_password(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ssh::delete_password(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ssh_has_password(id: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || ssh::has_password(&id))
        .await
        .unwrap_or(false)
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
/// The agents working or waiting, for the menu bar icon's menu.
#[tauri::command]
fn tray_update(app: AppHandle, items: Vec<tray::TrayItem>) -> Result<(), String> {
    tray::update(&app, &items).map_err(|e| e.to_string())
}

/// One provider command (docker, boat, render, the Modal helper), with its output.
#[tauri::command]
async fn sandbox_run(opts: sandbox::RunOpts) -> Result<sandbox::RunOutput, String> {
    tauri::async_runtime::spawn_blocking(move || sandbox::run(opts)).await.map_err(|e| e.to_string())?
}

/// A script Desk uploads into sandboxes (the runner) or builds them from (the Dockerfile).
#[tauri::command]
fn sandbox_resource(name: String) -> Result<String, String> {
    sandbox::resource(&name).map(str::to_string)
}

#[tauri::command]
fn sandbox_helper(name: String) -> Result<String, String> {
    sandbox::helper_path(&name).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn sandbox_secret_set(key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sandbox::secret_set(&key, &value)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn sandbox_secret_has(key: String) -> bool {
    sandbox::secret_has(&key)
}

#[tauri::command]
fn sandbox_secret_delete(key: String) -> Result<(), String> {
    sandbox::secret_delete(&key)
}

/// The feed for the notch, from the main window.
#[tauri::command]
fn notch_update(app: AppHandle, payload: Value) {
    notch::update(&app, payload);
}

#[tauri::command]
fn notch_snapshot(app: AppHandle) -> notch::Snapshot {
    notch::snapshot(&app)
}

#[tauri::command]
fn notch_action(app: AppHandle, action: Value) {
    notch::action(&app, action);
}

#[tauri::command]
fn notch_resize(app: AppHandle, width: f64, height: f64) {
    notch::resize(&app, width, height);
}

#[tauri::command]
fn notch_focus(app: AppHandle, focus: bool) {
    notch::focus(&app, focus);
}

pub fn run() {
    let ptys = Arc::new(PtyManager::default());
    bridge::start(Arc::clone(&ptys));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ptys)
        .manage(Arc::new(chat::ChatManager::default()))
        .manage(files::Watchers::default())
        .manage(QuitState::default())
        .menu(build_menu)
        .setup(|app| {
            // The menu bar icon is a nicety: Desk runs without it.
            if let Err(e) = tray::create(app.handle()) {
                eprintln!("Couldn't add the menu bar icon: {e}");
            }
            // So is the notch.
            if let Err(e) = notch::create(app.handle()) {
                eprintln!("Couldn't add the notch: {e}");
            }
            Ok(())
        })
        // Only Desk's own page may call its commands; the built-in browser's pages never can.
        .invoke_handler({
            let handler: Box<dyn Fn(tauri::ipc::Invoke) -> bool + Send + Sync> = Box::new(tauri::generate_handler![
            workspace_exit,
            pty_spawn,
            pty_write,
            pty_write_bytes,
            pty_resize,
            pty_kill,
            pty_set_background,
            chat_spawn,
            chat_write,
            chat_kill,
            chat_history,
            attachment_save,
            attachment_image,
            codex_models,
            usage_limits,
            usage_refresh,
            claude_limits_hook,
            accounts_detect,
            account_inspect,
            account_create,
            tool_installed,
            account_usage,
            state_load,
            state_save,
            fs_list_dir,
            fs_list_files,
            fs_read,
            fs_read_bytes,
            open_default,
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
            git_change_count,
            git_stage_all,
            git_discard,
            git_worktrees,
            git_branches,
            git_worktree_path,
            git_worktree_add,
            git_task_worktree,
            gh_run,
            browser_open,
            browser_bounds,
            browser_command,
            browser_close,
            git_commits_since,
            git_push,
            gh_pr_worktree,
            session_trash,
            git_worktree_remove,
            git_branch_delete,
            sessions_list,
            claude_session_state,
            attention,
            project_search,
            project_replace,
            path_exists,
            open_external,
            reveal_in_finder,
            ssh_save_password,
            ssh_forget_password,
            ssh_has_password,
            tray_update,
            notch_update,
            notch_snapshot,
            notch_action,
            notch_resize,
            notch_focus,
            sandbox_run,
            sandbox_resource,
            sandbox_helper,
            sandbox_secret_set,
            sandbox_secret_has,
            sandbox_secret_delete,
            ]);
            move |invoke: tauri::ipc::Invoke| {
                let label = invoke.message.webview().label().to_string();
                let allowed = label == "main" || (label == notch::LABEL && notch::COMMANDS.contains(&invoke.message.command()));
                if !allowed {
                    invoke.resolver.reject("Not allowed from this page");
                    return true;
                }
                handler(invoke)
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start Desk");

    app.run(|handle, event| match event {
        RunEvent::ExitRequested { api, .. }
            if !handle.state::<QuitState>().0.load(Ordering::SeqCst) =>
        {
            api.prevent_exit();
            let _ = handle.emit("desk-quit", ());
        }
        RunEvent::Exit => {
            handle.state::<Arc<PtyManager>>().kill_all();
            handle.state::<Arc<chat::ChatManager>>().kill_all();
        }
        _ => {}
    });
}

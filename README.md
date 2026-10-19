# Desk

A macOS workspace for Claude Code and Codex. Projects on the left, terminals in the middle, files on the right, and each project runs each tool with the account you choose for it.

## Make it yours

Open **Settings** from the sidebar, title bar, or **⌘,**. Choose Graphite, Midnight, Forest, Paper, or match your system appearance. Themes and text sizes apply to open terminals and editors without restarting sessions. Settings also includes comfortable/compact spacing, panel visibility, account management, and a shortcut reference. Desk’s interface accent is independent of terminal colors: choose Neutral (default), Amber, or Sage. Account color indicators are optional, and Workspace settings can hide the status bar, full paths, or account emails. Reduce interface motion is available under Appearance.

Search projects from the sidebar. Accounts start collapsed; expand the section or individual tool groups when needed. By default only the selected project shows account chips; enable **Always show project accounts** to keep every project’s chips visible. Preferences and collapsed sections are saved on this Mac.

## Workspace features

- **Recovery:** Desk restores open files, unsaved buffers, tab selection, and split layout. Normal quit waits for a recovery snapshot. Changed disk versions show a conflict before overwrite. Terminal tabs restore as restart cards: process output and running processes do not survive app exit.
- **Split panes:** Use the split button or **⌘\** to work side by side. Click a pane to target it when opening tabs; drag the divider or use its arrow keys to resize. If only one tab is open, splitting opens a shell beside it.
- **Source control:** Open **Changes** in the right panel to review working-tree or staged diffs, stage/unstage individual files, and commit staged changes. Git operations cover the repository root, including when the project is a subfolder. Desk never pushes automatically. Unsaved editor buffers are not included in commits.
- **Project search:** Open **Search** or **⌘⇧F** for literal text search with optional case sensitivity. Expand Replace to preview and confirm replacements. Dirty editor buffers and files changed since the search are skipped. Search respects ignore files, skips binary/unreadable files and common build folders, and reports limits (25,000 scanned files, 200 matching files, 2,000 matches, or 8 MB of matching text). Narrow a truncated search before replacing all.
- **Command palette:** **⌘⇧P** searches commands, projects, open tabs, and themes. Use arrows and Enter to choose an action.

## How accounts work

An account is a config folder:

| Tool        | Variable            | Default folder | Extra accounts            |
| ----------- | ------------------- | -------------- | ------------------------- |
| Claude Code | `CLAUDE_CONFIG_DIR` | `~/.claude`    | `~/.claude-<name>`        |
| Codex       | `CODEX_HOME`        | `~/.codex`     | `~/.codex-<name>`         |

Desk finds existing `~/.claude*` and `~/.codex*` folders on launch. Every terminal it opens gets the project's account folders set (or unset, for the default account), so `claude` and `codex` pick up the right sign-in automatically. **Add account** creates a new folder and runs the tool's own sign-in inside it. Desk never stores or sends tokens. To show which email is signed in, it reads `oauthAccount.emailAddress` from `.claude.json` and, for Codex, decodes only the `email` claim from the ID token in `auth.json`, locally.

## Shortcuts

| Keys            | Action                         |
| --------------- | ------------------------------ |
| ⌘⇧P             | Command palette                |
| ⌘⇧F             | Search and replace in project  |
| ⌘\              | Toggle split panes             |
| ⌘,              | Open settings                  |
| ⌘T              | New Claude Code tab            |
| ⌘W              | Close tab                      |
| ⌘S              | Save file                      |
| ⌘P              | Open file in project           |
| ⌘O              | Add project folder             |
| ⌘B / ⌘⇧B        | Toggle projects / files panel  |
| ⌘K              | Clear terminal                 |
| ⌘1–9, ⌘⇧[ ⌘⇧]   | Switch tabs                    |
| ⌥⌘↑ / ⌥⌘↓       | Switch projects                |
| ⇧Enter          | Newline in Claude Code / Codex |

Drop folders on the window to add projects; drop files on a terminal to paste their paths.

## Develop

Requires Rust (rustup) and Node 20+.

```sh
npm install
npm run tauri dev          # live-reloading dev build
npm run tauri build        # release Desk.app and .dmg in src-tauri/target/release/bundle
cd src-tauri && cargo test # backend tests
```

Layout: `src-tauri/src` is the Rust backend (`pty.rs` terminals, `accounts.rs` account discovery, `files.rs` tree/editor I/O and file watching). `src` is the React UI; `terminals.ts` and `editors.ts` keep xterm.js and CodeMirror instances alive outside React so sessions survive tab and project switches. App state is saved to `~/Library/Application Support/Desk/state.json`.

## Validation

```sh
npm run build
npm run test:backend
npm run dev -- --host 127.0.0.1 --port 1421
# In another terminal (uses an installed Chrome, isolated data, mocked IPC):
npm run test:ui
```

Set `CHROME_PATH` to use a different Chrome executable, or `DESK_TEST_URL` for a different dev-server address. The UI smoke test exercises restoration, split panes, search/replace protection, Git controls, the command palette, and quit-time persistence. Rust tests exercise real Git repositories and filesystem replacement conflicts in temporary directories.

Release bundles are copied to `releases/` before build-cache cleanup. Run `npm run tauri build` to produce a new `.app` and `.dmg`; building does not install Desk.

# Desk

A macOS workspace for Claude Code and Codex. Projects on the left, terminals in the middle, files on the right, and each project runs each tool with the account you choose for it.

## Make it yours

Open **Settings** from the sidebar, title bar, or **⌘,**. The original interface palettes—including Charcoal, Dim, Midnight, Forest, Graphite Classic, and warm Paper—are available alongside the new neutral collection, for 14 choices in total. Choose a theme or match your system appearance. Settings also includes comfortable/compact spacing, panel visibility, optional account colors, account management, and a shortcut reference. Reduce motion follows both Desk and system preferences. Selected projects and open history entries use a background change without a left-edge stripe.

Terminal settings offers all 12 original palettes plus six new neutral choices, individual color overrides, and smooth scrolling. Text contrast is corrected to 7:1 where xterm supports it. Browse up to 20,000 lines of history without incoming output moving you to the bottom; use **Latest output** or **⇧End** to return. **⇧Page Up / Down** browses history and **⇧Home** jumps to the oldest output. Full-screen terminal applications retain their own scrolling and navigation. Existing saved terminal palettes and custom colors remain supported.

**Editor** settings offers eight independent file color themes: Match Desk, VS Code Dark, GitHub Dark, Dracula, Nord, GitHub Light, Solarized Light, and Monochrome. Preview HTML, Python, Ruby, TypeScript, SQL, or Shell before choosing. Changes apply to open files while preserving edits, undo history, and scroll position. Syntax highlighting follows filenames, with lazy-loaded support for Ruby, Java, C/C++, SQL, Shell, and many more in addition to the existing HTML, JavaScript/TypeScript, Python, Rust, Go, CSS, YAML, JSON, and Markdown support.

Search projects from the sidebar. Accounts start collapsed; expand the section or individual tool groups when needed. By default only the selected project shows account chips; enable **Always show project accounts** to keep every project’s chips visible. Preferences and collapsed sections are saved on this Mac.

## Workspace features

- **Recovery:** Desk restores open files, unsaved buffers, tab selection, and split layout. Normal quit waits for a recovery snapshot. Changed disk versions show a conflict before overwrite. Terminal tabs restore as restart cards: process output and running processes do not survive app exit.
- **Tab order:** Drag tabs left or right to reorder them across projects. The insertion marker shows where a tab will land, and the strip scrolls at its edges. Press Escape to cancel a drag, or focus a tab and use **⌥⇧← / →** to move it with the keyboard. The order is restored when Desk reopens.
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
npm run test:appearance
```

Set `CHROME_PATH` to use a different Chrome executable, or `DESK_TEST_URL` for a different dev-server address. The UI smoke test exercises restoration, split panes, search/replace protection, Git controls, the command palette, and quit-time persistence. Appearance checks cover theme contrast, system theme changes, live terminal palettes, scrollback, and alternate-screen navigation. Rust tests exercise real Git repositories and filesystem replacement conflicts in temporary directories.

Release bundles are copied to `releases/` before build-cache cleanup. Run `npm run tauri build` to produce a new `.app` and `.dmg`; building does not install Desk.

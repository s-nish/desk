# Desk on Windows

Desk keeps your projects, your Claude Code and Codex sessions, and their files in one window.
This branch (`windows-app`) is the Windows version. It's new and has had little testing on real
Windows machines, so please report anything that looks off.

## Get the installer

1. Open the repository on GitHub, go to **Actions**, then **Windows build**, and pick the latest
   green run.
2. Under **Artifacts**, download **Desk-Windows-installer** and unzip it.
3. Run `Desk_0.1.0_x64-setup.exe`. It installs for your user only, so no admin rights are needed.

Desk isn't signed with a Microsoft certificate yet. If SmartScreen says "Windows protected your PC",
click **More info**, then **Run anyway**.

## Install the tools Desk runs

Desk runs the tools you already have; it doesn't install them. In PowerShell:

```powershell
winget install --id Git.Git -e                # Git for Windows (Claude Code needs it)
irm https://claude.ai/install.ps1 | iex       # Claude Code
winget install OpenJS.NodeJS.LTS              # Node.js, only needed for Codex
npm install -g @openai/codex                  # Codex (optional)
```

Close and reopen Desk afterwards, so new terminal tabs see the updated PATH.

## First steps

- When Desk first opens, a short tour points out the main parts of the window. The **?** button in
  the title bar opens the getting-started guide and can replay the tour.
- Add a project folder with the **+** next to Projects, or drag a folder onto the window.
- Start Claude Code (**Ctrl+Shift+D**), Codex (**Ctrl+Shift+E**) or a shell (**Ctrl+Shift+J**).
  The first Claude Code tab asks you to sign in in your browser.
- For a second account (say, work and personal), use **Accounts** in the sidebar. Each account keeps
  its login in its own folder.

## How Windows differs from the Mac version

- **Shortcuts.** Desk's shortcuts use **Ctrl+Shift** (like Windows Terminal), so plain Ctrl keys
  keep working in the shell and in Claude Code. Ctrl+Shift+P opens the command palette, and
  Settings → Shortcuts lists them all.
- **Copy and paste.** In a terminal, **Ctrl+C** copies selected text and otherwise stops the running
  command. **Ctrl+V** pastes.
- **Shell.** Terminal tabs run PowerShell 7 if it's installed, and Windows PowerShell otherwise.
  Each tab allows scripts for itself only (`-ExecutionPolicy Bypass`), so the npm shims for
  `claude` and `codex` work.
- **Alerts.** A waiting agent flashes the taskbar button. Windows has no badge count.
- **Usage limits.** Codex limits always show. Claude Code limits show only for accounts without their
  own status line, which Desk leaves untouched.
- **Not available:** the Speaky bridge (macOS only).

## Build it yourself

You need Node.js 22, Rust (via rustup) and the Visual Studio C++ Build Tools. Then:

```powershell
npm ci
npx tauri build
```

The installer is written to `src-tauri\target\release\bundle\nsis\`.

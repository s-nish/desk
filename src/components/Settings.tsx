import { useState } from "react";
import { Bell, Check, Code2, Keyboard, Monitor, Palette, Plus, RotateCcw, Server, SlidersHorizontal, SquareTerminal, Users } from "lucide-react";
import { THEMES } from "../appearance";
import { DEFAULT_PREFERENCES, TOOL_LABEL, useDesk } from "../store";
import { terminalTheme, deskTheme as terminalThemeForDesk } from "../terminals";
import { ANSI_KEYS, BASE_KEYS, COLOR_LABEL, TERMINAL_PRESETS, opaque, presetTheme, type ColorKey } from "../terminalThemes";
import { EditorSettings } from "./EditorSettings";
import { AccountRow, ConnectionRow } from "./Sidebar";

const sections = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "editor", label: "Editor", icon: Code2 },
  { id: "workspace", label: "Workspace", icon: SlidersHorizontal },
  { id: "alerts", label: "Alerts", icon: Bell },
  { id: "ssh", label: "SSH", icon: Server },
  { id: "accounts", label: "Accounts", icon: Users },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
] as const;

function Toggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: () => void }) {
  return <button className="setting-row" role="switch" aria-checked={checked} onClick={onChange}>
    <span><strong>{label}</strong><small>{description}</small></span><span className={"toggle-track" + (checked ? " is-on" : "")}><span /></span>
  </button>;
}

type Section = typeof sections[number]["id"];

export function Settings({ initial }: { initial?: string }) {
  const [section, setSection] = useState<Section>(sections.some((s) => s.id === initial) ? (initial as Section) : "appearance");
  const preferences = useDesk((s) => s.preferences);
  const setPreferences = useDesk((s) => s.setPreferences);
  const layout = useDesk((s) => s.layout);
  const setLayout = useDesk((s) => s.setLayout);
  const accounts = useDesk((s) => s.accounts);
  return <div className="settings-layout">
    <nav className="settings-nav" aria-label="Settings sections">
      {sections.map(({ id, label, icon: Icon }) => <button key={id} aria-label={label} aria-current={section === id ? "page" : undefined} className={section === id ? "is-active" : ""} onClick={() => setSection(id)}><Icon size={16} /><span>{label}</span></button>)}
      <span className="settings-local">Made for your workflow.<br />Saved on this Mac.</span>
    </nav>
    <div className="settings-content" key={section}>
      <div className="settings-intro"><h2>{sections.find((s) => s.id === section)?.label}</h2><p>{section === "appearance" ? "Your original palettes, plus a new range of neutral shades." : section === "workspace" ? "Keep what you need. Give your work room to breathe." : section === "editor" ? "Distinct syntax colors for every file. Choose a palette that suits your work." : section === "terminal" ? "Readable output. Comfortable spacing. Your place in the scrollback." : section === "alerts" ? "Know when Claude Code or Codex finishes, or needs an answer, while you're looking at something else." : section === "ssh" ? "Saved commands that open in their own tab, with the password filled in." : section === "accounts" ? "Manage the accounts you use across your projects." : "Stay in the flow, with your hands on the keyboard."}</p></div>
      {section === "appearance" && <>
        <div className="theme-families">{([false, true] as const).map((light) => <section className="theme-family" key={String(light)} aria-label={light ? "Light themes" : "Dark themes"}>
        <h3 className="settings-label">{light ? "Light" : "Dark"}</h3>
        <div className="theme-grid">{THEMES.filter((theme) => theme.light === light).map((theme) => <button key={theme.id} className={"theme-option" + (preferences.theme === theme.id ? " is-selected" : "")} aria-pressed={preferences.theme === theme.id} onClick={() => setPreferences({ theme: theme.id })}>
          <span className="theme-preview" style={{ background: theme.bg, "--preview-surface": theme.surface, "--preview-accent": theme.accent } as React.CSSProperties}><span className="preview-sidebar"><i /><i /><i /></span><span className="preview-main"><i /><i /><i /><i /></span></span>
          <span className="theme-name">{theme.name}{preferences.theme === theme.id && <Check size={14} />}</span><small>{theme.description}</small>
        </button>)}</div></section>)}</div>
        <button className={"system-theme" + (preferences.theme === "system" ? " is-selected" : "")} aria-pressed={preferences.theme === "system"} onClick={() => setPreferences({ theme: "system" })}><Monitor size={16} /><span>Match system appearance</span>{preferences.theme === "system" && <Check size={14} />}</button>
        <div className="setting-row"><span><strong>Interface density</strong><small>Choose how much space your sidebar uses.</small></span><div className="segmented">{(["comfortable", "compact"] as const).map((density) => <button key={density} aria-pressed={preferences.density === density} className={preferences.density === density ? "is-on" : ""} onClick={() => setPreferences({ density })}>{density === "comfortable" ? "Comfortable" : "Compact"}</button>)}</div></div>
        <label className="setting-row"><span><strong>Editor & terminal text</strong><small>Applies immediately to open files and sessions.</small></span><select aria-label="Editor and terminal text size" value={preferences.fontSize} onChange={(e) => setPreferences({ fontSize: Number(e.target.value) })}>{[11, 12, 13, 14, 15, 16, 18, 20].map((size) => <option key={size} value={size}>{size} px</option>)}</select></label>
        <Toggle label="Colored account indicators" description="Use account colors in tabs and sidebar chips. Off keeps the interface neutral." checked={preferences.accountColors} onChange={() => setPreferences({ accountColors: !preferences.accountColors })} />
        <Toggle label="Reduce interface motion" description="Keep Desk’s controls still. System accessibility preferences are also respected." checked={preferences.reduceMotion} onChange={() => setPreferences({ reduceMotion: !preferences.reduceMotion })} />
        <button className="text-button" onClick={() => setPreferences({ theme: DEFAULT_PREFERENCES.theme, density: DEFAULT_PREFERENCES.density, fontSize: DEFAULT_PREFERENCES.fontSize, accountColors: DEFAULT_PREFERENCES.accountColors, reduceMotion: DEFAULT_PREFERENCES.reduceMotion })}>Reset appearance to defaults</button>
      </>}
      {section === "terminal" && <TerminalSettings />}
      {section === "editor" && <EditorSettings />}
      {section === "ssh" && <SshSettings />}
      {section === "workspace" && <div className="settings-card">
        <Toggle label="Status bar" description="Show repository and account information along the bottom." checked={preferences.showStatusBar} onChange={() => setPreferences({ showStatusBar: !preferences.showStatusBar })} />
        <Toggle label="Full paths in window chrome" description="Show folder and file paths in the title and status bars." checked={preferences.showPaths} onChange={() => setPreferences({ showPaths: !preferences.showPaths })} />
        <Toggle label="Account emails in status bar" description="Show email addresses beside account names." checked={preferences.showAccountEmails} onChange={() => setPreferences({ showAccountEmails: !preferences.showAccountEmails })} />
        <Toggle label="Projects sidebar" description="Your projects and accounts, within reach." checked={layout.sidebarOpen} onChange={() => setLayout({ sidebarOpen: !layout.sidebarOpen })} />
        <Toggle label="Files panel" description="Browse the selected project's files." checked={layout.filesOpen} onChange={() => setLayout({ filesOpen: !layout.filesOpen })} />
        <Toggle label="Expand accounts" description="Show account groups in the sidebar." checked={layout.accountsOpen} onChange={() => setLayout({ accountsOpen: !layout.accountsOpen })} />
        <Toggle label="Always show project accounts" description="When off, only the selected project shows its accounts." checked={preferences.showProjectAccounts} onChange={() => setPreferences({ showProjectAccounts: !preferences.showProjectAccounts })} />
      </div>}
      {section === "alerts" && <>
        <div className="settings-card">
          <Toggle label="Mark agents that are waiting" description="A tab whose agent finished or asked something gets a white dot, and its project shows a count. Only when you can't see the tab." checked={preferences.agentAlerts} onChange={() => setPreferences({ agentAlerts: !preferences.agentAlerts })} />
          <Toggle label="Count on the Dock icon" description="Shows how many agents are waiting, even when Desk is in the background." checked={preferences.alertBadge} onChange={() => setPreferences({ alertBadge: !preferences.alertBadge })} />
          <Toggle label="Bounce the Dock icon" description="Once, when an agent starts waiting and Desk isn't the app in front." checked={preferences.alertBounce} onChange={() => setPreferences({ alertBounce: !preferences.alertBounce })} />
        </div>
        <p className="settings-note">Desk watches the terminal: an agent that was printing and goes quiet for a few seconds has finished. A terminal bell or a notification from the agent also counts. Press ⌘⇧A to jump to the next waiting tab.</p>
      </>}
      {section === "accounts" && <>{(["claude", "codex"] as const).map((kind) => <details className="settings-account-group" key={kind} open><summary>{TOOL_LABEL[kind]}<span className="section-count">{accounts.filter((a) => a.kind === kind).length}</span></summary><div>{accounts.filter((a) => a.kind === kind).map((account) => <AccountRow key={account.id} account={account} />)}<button className="text-button" onClick={() => useDesk.getState().setModal({ kind: "addAccount", tool: kind })}><Plus size={14} />Add {TOOL_LABEL[kind]} account</button></div></details>)}<p className="settings-note">Choose a project's account from its sidebar chips. Existing sessions keep the account they started with.</p></>}
      {section === "shortcuts" && <div className="shortcut-list">{[["New Claude Code tab in selected project", "⌘ D  /  ⌘ T"], ["New Codex tab in selected project", "⌘ E"], ["New shell tab in selected project", "⌘ J"], ["New SSH connection", "⌘ ⇧ N"], ["New worktree for selected project", "⌘ ⇧ T"], ["Jump to next waiting agent", "⌘ ⇧ A"], ["Move focused tab left / right", "⌥ ⇧ ← / →"], ["Command palette", "⌘ ⇧ P"], ["Search project", "⌘ ⇧ F"], ["Split panes", "⌘ \\"], ["Side by side / stacked", "⌘ ⌥ \\"], ["Focus left / right pane", "⌘ ⌥ ← / →"], ["Add project folder", "⌘ O"], ["Open file", "⌘ P"], ["Save file", "⌘ S"], ["Close tab", "⌘ W"], ["Toggle projects", "⌘ B"], ["Toggle files", "⌘ ⇧ B"], ["Switch tabs", "⌃ Tab"], ["Switch projects", "⌥ ⌘ ↑ / ↓"], ["Clear terminal", "⌘ K"], ["Open settings", "⌘ ,"]].map(([label, key]) => <div key={label}><span>{label}</span><kbd>{key}</kbd></div>)}</div>}
    </div>
  </div>;
}

/** Fake terminal output drawn with the theme's own colors. */
function TerminalPreview({ theme }: { theme: Record<string, string | undefined> }) {
  const c = (key: string) => ({ color: theme[key] });
  return (
    <div className="term-preview" style={{ background: theme.background, color: theme.foreground }} aria-hidden>
      <div><span style={c("green")}>nish@desk</span> <span style={c("blue")}>~/projects/desk</span> <span style={c("magenta")}>main</span> <span style={c("brightBlack")}>$</span> claude</div>
      <div><span style={c("cyan")}>●</span> Reading <span style={c("yellow")}>src/terminals.ts</span></div>
      <div><span style={c("green")}>+ 12</span> <span style={c("red")}>- 3</span> <span style={c("brightBlack")}>lines changed</span></div>
      <div><span style={{ background: theme.selectionBackground }}>selected text</span> <span className="term-preview-cursor" style={{ background: theme.cursor }} /></div>
      <div className="term-preview-ansi">{ANSI_KEYS.map((k) => <i key={k} style={{ background: theme[k] }} />)}</div>
    </div>
  );
}

function TerminalSettings() {
  const preferences = useDesk((s) => s.preferences);
  const setPreferences = useDesk((s) => s.setPreferences);
  const theme = terminalTheme() as Record<string, string | undefined>;
  const edited = Object.keys(preferences.terminalColors).length > 0;
  const setColor = (key: ColorKey, value: string) =>
    setPreferences({ terminalColors: { ...preferences.terminalColors, [key]: key === "selectionBackground" ? value + "55" : value } });
  return <>
    <TerminalPreview theme={theme} />
    <h3 className="settings-label">Color theme</h3>
    <div className="term-presets">
      {TERMINAL_PRESETS.map((p) => {
        const t = ((p.id === "desk" || p.id === "desk-neutral") ? terminalThemeForDesk(p.id === "desk-neutral") : presetTheme(p)) as Record<string, string>;
        const selected = preferences.terminalTheme === p.id;
        return <button key={p.id} className={"term-preset" + (selected ? " is-selected" : "")} aria-pressed={selected}
          onClick={() => setPreferences({ terminalTheme: p.id, terminalColors: {} })}>
          <span className="term-preset-swatch" style={{ background: t.background }}>
            {["red", "green", "yellow", "blue", "magenta", "cyan"].map((k) => <i key={k} style={{ background: t[k] }} />)}
          </span>
          <span className="term-preset-name">{p.id === "desk" ? "Match Desk" : p.name}{selected && <Check size={13} />}</span>
        </button>;
      })}
    </div>
    <details className="term-customize"><summary>Customize individual colors{edited ? " · Edited" : ""}</summary>
    <div className="settings-label term-custom-head">
      <span>Customize colors{edited && <em>Edited</em>}</span>
      {edited && <button className="text-button" onClick={() => setPreferences({ terminalColors: {} })}><RotateCcw size={12} />Reset to theme</button>}
    </div>
    <div className="term-colors">
      {[...BASE_KEYS, ...ANSI_KEYS].map((key) => (
        <label key={key} className={"term-color" + (preferences.terminalColors[key] ? " is-edited" : "")}>
          <input type="color" value={opaque(theme[key])} onChange={(e) => setColor(key, e.target.value)} />
          <span>{COLOR_LABEL[key]}</span>
        </label>
      ))}
    </div>
    </details>
    <Toggle label="Smooth scrolling" description="A short, gentle transition when browsing output. Respects Reduce motion." checked={preferences.smoothScroll} onChange={() => setPreferences({ smoothScroll: !preferences.smoothScroll })} />
    <p className="settings-note">20,000 lines of scrollback. ⇧Page Up / Down to browse; ⇧End or Latest output to return. New output keeps your place while you read.</p>
    <div className="setting-row"><span><strong>Cursor</strong><small>Shape of the cursor in every terminal.</small></span><div className="segmented">{(["bar", "block", "underline"] as const).map((style) => <button key={style} aria-pressed={preferences.cursorStyle === style} className={preferences.cursorStyle === style ? "is-on" : ""} onClick={() => setPreferences({ cursorStyle: style })}>{style === "bar" ? "Bar" : style === "block" ? "Block" : "Underline"}</button>)}</div></div>
    <Toggle label="Blinking cursor" description="Off keeps the cursor solid." checked={preferences.cursorBlink} onChange={() => setPreferences({ cursorBlink: !preferences.cursorBlink })} />
    <p className="settings-note">Text size is under Appearance. Changes apply to open terminals right away.</p>
  </>;
}

function SshSettings() {
  const connections = useDesk((s) => s.connections);
  return <>
    <div className="settings-account-group settings-connections">
      {connections.map((c) => <ConnectionRow key={c.id} connection={c} from="settings" />)}
      {connections.length === 0 && <p className="settings-note">No saved connections yet.</p>}
      <button className="text-button" onClick={() => useDesk.getState().setModal({ kind: "ssh", id: null, from: "settings" })}><Plus size={14} />New connection</button>
    </div>
    <p className="settings-note">
      Click a connection to open it in a new tab. When it drops, press Enter in that tab to reconnect. Passwords are kept in Desk's folder on this
      Mac, readable only by your user, and never in Desk's workspace file.
    </p>
  </>;
}

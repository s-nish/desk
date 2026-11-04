import { Fragment, useState } from "react";
import { Bell, Check, Code2, Gauge, Keyboard, MessagesSquare, Monitor, Palette, PanelsTopLeft, Plus, RotateCcw, Server, SquareTerminal, Users } from "lucide-react";
import { THEMES } from "../appearance";
import { AGENTS, DEFAULT_PREFERENCES, TOOL_LABEL, useDesk } from "../store";
import { UsageSettings } from "./Usage";
import { ToolLogo } from "./ToolLogo";
import { multiAccount } from "../actions";
import { terminalTheme, deskTheme as terminalThemeForDesk } from "../terminals";
import { ANSI_KEYS, BASE_KEYS, COLOR_LABEL, TERMINAL_PRESETS, opaque, presetTheme, type ColorKey } from "../terminalThemes";
import { EditorSettings } from "./EditorSettings";
import { AccountRow, ConnectionRow } from "./Sidebar";

const sections = [
  { id: "appearance", label: "Appearance", icon: Palette, group: "Personalize" },
  { id: "chat", label: "Chat", icon: MessagesSquare, group: "Personalize" },
  { id: "terminal", label: "Terminal", icon: SquareTerminal, group: "Personalize" },
  { id: "editor", label: "Editor", icon: Code2, group: "Personalize" },
  { id: "workspace", label: "Layout", icon: PanelsTopLeft, group: "Workspace" },
  { id: "alerts", label: "Alerts", icon: Bell, group: "Workspace" },
  { id: "accounts", label: "Accounts", icon: Users, group: "Connections" },
  { id: "usage", label: "Usage", icon: Gauge, group: "Connections" },
  { id: "ssh", label: "SSH", icon: Server, group: "Connections" },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard, group: "Help" },
] as const;

const INTRO: Record<string, string> = {
  appearance: "Themes, accent color and the shape of things.",
  chat: "How conversations look when Claude Code and Codex run as a chat.",
  terminal: "Readable output. Comfortable spacing. Your place in the scrollback.",
  editor: "Distinct syntax colors for every file. Choose a palette that suits your work.",
  workspace: "Keep what you need. Give your work room to breathe.",
  alerts: "Know when Claude Code or Codex finishes, or needs an answer, while you're looking at something else.",
  accounts: "Claude Code, Codex, Gemini CLI, Cursor Agent and Grok accounts, used across your projects.",
  usage: "How much of each plan's limits you've used, or have left, and when they reset.",
  ssh: "Saved commands that open in their own tab, with the password filled in.",
  shortcuts: "Stay in the flow, with your hands on the keyboard.",
};

export const ACCENTS = [
  { id: "neutral", name: "Neutral", color: "var(--text)" },
  { id: "sand", name: "Sand", color: "#d9bc8c" },
  { id: "sage", name: "Sage", color: "#9cc9a6" },
  { id: "sky", name: "Sky", color: "#8fbbea" },
  { id: "rose", name: "Rose", color: "#eba3b3" },
  { id: "amber", name: "Amber", color: "#f2b457" },
  { id: "coral", name: "Coral", color: "#ef8f76" },
] as const;

function Choice<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return <div className="segmented" role="radiogroup" aria-label={label}>{options.map(([v, text]) => <button key={String(v)} role="radio" aria-checked={value === v} className={value === v ? "is-on" : ""} onClick={() => onChange(v)}>{text}</button>)}</div>;
}

function Row({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return <div className="setting-row"><span><strong>{label}</strong>{description && <small>{description}</small>}</span>{children}</div>;
}

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
      {sections.map(({ id, label, icon: Icon, group }, i) => <Fragment key={id}>
        {group !== sections[i - 1]?.group && <span className="settings-nav-group">{group}</span>}
        <button aria-label={label} aria-current={section === id ? "page" : undefined} className={section === id ? "is-active" : ""} onClick={() => setSection(id)}><span className="settings-nav-icon"><Icon size={14} strokeWidth={1.8} /></span><span>{label}</span></button>
      </Fragment>)}
      <span className="settings-local">Saved on this Mac.</span>
    </nav>
    <div className="settings-content" key={section}>
      <div className="settings-intro"><h2>{sections.find((s) => s.id === section)?.label}</h2><p>{INTRO[section]}</p></div>
      {section === "appearance" && <>
        <h3 className="settings-label">Theme</h3>
        <div className="settings-card theme-card">
          {([false, true] as const).map((light) => <section className="theme-family" key={String(light)} aria-label={light ? "Light themes" : "Dark themes"}>
            <span className="theme-family-name">{light ? "Light" : "Dark"}</span>
            <div className="theme-grid">{THEMES.filter((theme) => theme.light === light).map((theme) => <button key={theme.id} className={"theme-option" + (preferences.theme === theme.id ? " is-selected" : "")} aria-pressed={preferences.theme === theme.id} title={theme.description} onClick={() => setPreferences({ theme: theme.id })}>
              <span className="theme-preview" style={{ background: theme.bg, "--preview-surface": theme.surface, "--preview-accent": theme.accent } as React.CSSProperties}><span className="preview-sidebar"><i /><i /><i /></span><span className="preview-main"><i /><i /><b /></span></span>
              <span className="theme-name">{theme.name}{preferences.theme === theme.id && <Check size={13} />}</span>
            </button>)}</div>
          </section>)}
          <button className={"system-theme" + (preferences.theme === "system" ? " is-selected" : "")} aria-pressed={preferences.theme === "system"} onClick={() => setPreferences({ theme: "system" })}><Monitor size={15} /><span>Match system appearance</span>{preferences.theme === "system" && <Check size={14} />}</button>
        </div>
        <h3 className="settings-label">Accent</h3>
        <div className="settings-card">
          <Row label="Accent color" description="Used for toggles, selection, the send button and focus rings. Neutral follows the theme.">
            <div className="accent-swatches" role="radiogroup" aria-label="Accent color">{ACCENTS.map((a) => <button key={a.id} role="radio" aria-checked={preferences.accentColor === a.id} aria-label={a.name} title={a.name} className={"accent-swatch" + (preferences.accentColor === a.id ? " is-on" : "")} style={{ "--swatch": a.color } as React.CSSProperties} onClick={() => setPreferences({ accentColor: a.id })}><i /></button>)}</div>
          </Row>
          <Row label="Corners" description="How rounded buttons, rows, tabs and panels are."><Choice label="Corners" value={preferences.corners} options={[["sharp", "Sharp"], ["soft", "Soft"], ["round", "Round"]]} onChange={(corners) => setPreferences({ corners })} /></Row>
          <Row label="Interface density" description="How much space the sidebar uses."><Choice label="Interface density" value={preferences.density} options={[["comfortable", "Comfortable"], ["compact", "Compact"]]} onChange={(density) => setPreferences({ density })} /></Row>
          <Row label="Editor & terminal text" description="Applies immediately to open files and sessions."><select aria-label="Editor and terminal text size" value={preferences.fontSize} onChange={(e) => setPreferences({ fontSize: Number(e.target.value) })}>{[11, 12, 13, 14, 15, 16, 18, 20].map((size) => <option key={size} value={size}>{size} px</option>)}</select></Row>
          <Toggle label="Colored account indicators" description="Use account colors in tabs and sidebar chips. Off keeps the interface neutral." checked={preferences.accountColors} onChange={() => setPreferences({ accountColors: !preferences.accountColors })} />
          <Toggle label="Animated background" description="Let the pixel waves on Home and in the sidebar roll gently, on every theme. Off shows them still. Also in the sidebar footer." checked={preferences.animatedBackground} onChange={() => setPreferences({ animatedBackground: !preferences.animatedBackground })} />
          <Toggle label="Reduce interface motion" description="Keep Desk’s controls still. System accessibility preferences are also respected." checked={preferences.reduceMotion} onChange={() => setPreferences({ reduceMotion: !preferences.reduceMotion })} />
        </div>
        <button className="text-button" onClick={() => setPreferences({ theme: DEFAULT_PREFERENCES.theme, density: DEFAULT_PREFERENCES.density, fontSize: DEFAULT_PREFERENCES.fontSize, accountColors: DEFAULT_PREFERENCES.accountColors, reduceMotion: DEFAULT_PREFERENCES.reduceMotion, animatedBackground: DEFAULT_PREFERENCES.animatedBackground, accentColor: DEFAULT_PREFERENCES.accentColor, corners: DEFAULT_PREFERENCES.corners })}><RotateCcw size={12} />Reset appearance</button>
      </>}
      {section === "chat" && <>
        <div className="settings-card">
          <Row label="Agent view" description="Terminal shows Claude Code and Codex as their own command line. Chat draws the same conversation as messages. Both run the same CLI with the same accounts and history; nothing goes through a proxy."><Choice label="Agent view" value={preferences.uiMode} options={[["terminal", "Terminal"], ["chat", "Chat"]]} onChange={(uiMode) => setPreferences({ uiMode })} /></Row>
          <Row label="Message text" description="Size of messages and replies."><select aria-label="Message text size" value={preferences.chatFontSize} onChange={(e) => setPreferences({ chatFontSize: Number(e.target.value) })}>{[13, 14, 15, 16, 17].map((size) => <option key={size} value={size}>{size} px</option>)}</select></Row>
          <Row label="Reading width" description="How wide the conversation runs on a big window."><Choice label="Reading width" value={preferences.chatWidth} options={[["narrow", "Narrow"], ["comfortable", "Comfortable"], ["wide", "Wide"]]} onChange={(chatWidth) => setPreferences({ chatWidth })} /></Row>
          <Toggle label="Show tool output open" description="Commands and file reads show their output without a click." checked={preferences.chatToolsOpen} onChange={() => setPreferences({ chatToolsOpen: !preferences.chatToolsOpen })} />
        </div>
        <p className="settings-note">In chat view, SSH connections and terminal tabs open as tabs next to your chats. Type / in a chat for commands, including /model and /effort.</p>
      </>}
      {section === "terminal" && <TerminalSettings />}
      {section === "editor" && <EditorSettings />}
      {section === "ssh" && <SshSettings />}
      {section === "workspace" && <div className="settings-card">
                <Toggle label="Status bar" description="Show repository and account information along the bottom." checked={preferences.showStatusBar} onChange={() => setPreferences({ showStatusBar: !preferences.showStatusBar })} />
        <Toggle label="Full paths in window chrome" description="Show folder and file paths in the title and status bars." checked={preferences.showPaths} onChange={() => setPreferences({ showPaths: !preferences.showPaths })} />
        <Toggle label="Claude Code usage limits" description="Show how much of each Claude account's 5-hour and weekly limit is used, next to the account in the status bar. Claude Code tabs start with a small status line wrapper that saves the numbers in Desk's folder and then runs your own status line. Codex limits always show; Codex records them itself." checked={preferences.usageLimits} onChange={() => setPreferences({ usageLimits: !preferences.usageLimits })} />
        <Toggle label="Account emails in status bar" description="Show email addresses beside account names." checked={preferences.showAccountEmails} onChange={() => setPreferences({ showAccountEmails: !preferences.showAccountEmails })} />
        <Toggle label="Projects sidebar" description="Your projects and accounts, within reach." checked={layout.sidebarOpen} onChange={() => setLayout({ sidebarOpen: !layout.sidebarOpen })} />
        <Toggle label="Files panel" description="Browse the selected project's files." checked={layout.filesOpen} onChange={() => setLayout({ filesOpen: !layout.filesOpen })} />
        <Toggle label="Expand accounts" description="Show account groups in the sidebar." checked={layout.accountsOpen} onChange={() => setLayout({ accountsOpen: !layout.accountsOpen })} />
      </div>}
      {section === "alerts" && <>
        <div className="settings-card">
          <Toggle label="Mark agents that are waiting" description="A tab whose agent finished or asked something gets a white dot, and its project shows a count. Only when you can't see the tab." checked={preferences.agentAlerts} onChange={() => setPreferences({ agentAlerts: !preferences.agentAlerts })} />
          <Toggle label="Count on the Dock icon" description="Shows how many agents are waiting, even when Desk is in the background." checked={preferences.alertBadge} onChange={() => setPreferences({ alertBadge: !preferences.alertBadge })} />
          <Toggle label="Bounce the Dock icon" description="Once, when an agent starts waiting and Desk isn't the app in front." checked={preferences.alertBounce} onChange={() => setPreferences({ alertBounce: !preferences.alertBounce })} />
        </div>
        <p className="settings-note">Desk watches the terminal: an agent that was printing and goes quiet for a few seconds has finished. A terminal bell or a notification from the agent also counts. Press ⌘⇧A to jump to the next waiting tab.</p>
      </>}
      {section === "accounts" && <>{AGENTS.map((kind) => { const list = accounts.filter((a) => a.kind === kind); const canAdd = multiAccount(kind) || list.length === 0; return <details className="settings-account-group" key={kind} open={list.length > 0 || kind === "claude" || kind === "codex"}><summary><ToolLogo tool={kind} size={14} />{TOOL_LABEL[kind]}<span className="section-count">{list.length}</span></summary><div>{list.map((account) => <AccountRow key={account.id} account={account} />)}{canAdd ? <button className="text-button" onClick={() => useDesk.getState().setModal({ kind: "addAccount", tool: kind })}><Plus size={14} />Add {TOOL_LABEL[kind]} account</button> : <p className="settings-note">{TOOL_LABEL[kind]} keeps one sign-in per Mac.</p>}</div></details>; })}<p className="settings-note">Choose a project's accounts from its ⋯ menu. Existing sessions keep the account they started with. Gemini CLI, Cursor Agent and Grok open in terminal tabs; chats are Claude Code and Codex.</p></>}
      {section === "usage" && <UsageSettings />}
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

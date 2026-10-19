import { useState } from "react";
import { Check, Keyboard, Monitor, Palette, Plus, SlidersHorizontal, Users } from "lucide-react";
import { THEMES } from "../appearance";
import { DEFAULT_PREFERENCES, TOOL_LABEL, useDesk } from "../store";
import { AccountRow } from "./Sidebar";

const sections = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "workspace", label: "Workspace", icon: SlidersHorizontal },
  { id: "accounts", label: "Accounts", icon: Users },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
] as const;

function Toggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: () => void }) {
  return <button className="setting-row" role="switch" aria-checked={checked} onClick={onChange}>
    <span><strong>{label}</strong><small>{description}</small></span><span className={"toggle-track" + (checked ? " is-on" : "")}><span /></span>
  </button>;
}

export function Settings() {
  const [section, setSection] = useState<typeof sections[number]["id"]>("appearance");
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
      <div className="settings-intro"><span className="eyebrow">MAKE IT YOURS</span><h2>{sections.find((s) => s.id === section)?.label}</h2><p>{section === "appearance" ? "A workspace that feels like you." : section === "workspace" ? "Keep what you need. Give your work room to breathe." : section === "accounts" ? "Manage the accounts you use across your projects." : "Stay in the flow, with your hands on the keyboard."}</p></div>
      {section === "appearance" && <>
        <h3 className="settings-label">Interface accent</h3>
        <div className="accent-options" role="group" aria-label="Interface accent">
          {(["neutral", "amber", "sage"] as const).map((accent) => <button key={accent} aria-pressed={preferences.accent === accent} className={preferences.accent === accent ? "is-selected" : ""} onClick={() => setPreferences({ accent })}><span className={"accent-dot is-" + accent} />{accent === "neutral" ? "Neutral" : accent === "amber" ? "Amber" : "Sage"}{preferences.accent === accent && <Check size={13} />}</button>)}
        </div>
        <p className="settings-note">Colors for Desk’s controls and highlights. Terminal output keeps its own colors.</p>
        <h3 className="settings-label">Color theme</h3>
        <div className="theme-grid">{THEMES.map((theme) => <button key={theme.id} className={"theme-option" + (preferences.theme === theme.id ? " is-selected" : "")} aria-pressed={preferences.theme === theme.id} onClick={() => setPreferences({ theme: theme.id })}>
          <span className="theme-preview" style={{ background: theme.bg, "--preview-surface": theme.surface, "--preview-accent": theme.id === "paper" ? "#555750" : "#dedbd4" } as React.CSSProperties}><span className="preview-sidebar"><i /><i /><i /></span><span className="preview-main"><i /><i /><i /><i /></span></span>
          <span className="theme-name">{theme.name}{preferences.theme === theme.id && <Check size={14} />}</span><small>{theme.description}</small>
        </button>)}</div>
        <button className={"system-theme" + (preferences.theme === "system" ? " is-selected" : "")} aria-pressed={preferences.theme === "system"} onClick={() => setPreferences({ theme: "system" })}><Monitor size={16} /><span>Match system appearance</span>{preferences.theme === "system" && <Check size={14} />}</button>
        <div className="setting-row"><span><strong>Interface density</strong><small>Choose how much space your sidebar uses.</small></span><div className="segmented">{(["comfortable", "compact"] as const).map((density) => <button key={density} aria-pressed={preferences.density === density} className={preferences.density === density ? "is-on" : ""} onClick={() => setPreferences({ density })}>{density === "comfortable" ? "Comfortable" : "Compact"}</button>)}</div></div>
        <label className="setting-row"><span><strong>Editor & terminal text</strong><small>Applies immediately to open sessions.</small></span><select aria-label="Editor and terminal text size" value={preferences.fontSize} onChange={(e) => setPreferences({ fontSize: Number(e.target.value) })}>{[11, 12, 13, 14, 15, 16, 18, 20].map((size) => <option key={size} value={size}>{size} px</option>)}</select></label>
        <Toggle label="Colored account indicators" description="Use account colors in tabs and sidebar chips. Off keeps the interface neutral." checked={preferences.accountColors} onChange={() => setPreferences({ accountColors: !preferences.accountColors })} />
        <Toggle label="Reduce interface motion" description="Keep Desk’s controls still. System accessibility preferences are also respected." checked={preferences.reduceMotion} onChange={() => setPreferences({ reduceMotion: !preferences.reduceMotion })} />
        <button className="text-button" onClick={() => setPreferences({ theme: DEFAULT_PREFERENCES.theme, density: DEFAULT_PREFERENCES.density, fontSize: DEFAULT_PREFERENCES.fontSize, accent: DEFAULT_PREFERENCES.accent, accountColors: DEFAULT_PREFERENCES.accountColors, reduceMotion: DEFAULT_PREFERENCES.reduceMotion })}>Reset appearance to defaults</button>
      </>}
      {section === "workspace" && <div className="settings-card">
        <Toggle label="Status bar" description="Show repository and account information along the bottom." checked={preferences.showStatusBar} onChange={() => setPreferences({ showStatusBar: !preferences.showStatusBar })} />
        <Toggle label="Full paths in window chrome" description="Show folder and file paths in the title and status bars." checked={preferences.showPaths} onChange={() => setPreferences({ showPaths: !preferences.showPaths })} />
        <Toggle label="Account emails in status bar" description="Show email addresses beside account names." checked={preferences.showAccountEmails} onChange={() => setPreferences({ showAccountEmails: !preferences.showAccountEmails })} />
        <Toggle label="Projects sidebar" description="Your projects and accounts, within reach." checked={layout.sidebarOpen} onChange={() => setLayout({ sidebarOpen: !layout.sidebarOpen })} />
        <Toggle label="Files panel" description="Browse the selected project's files." checked={layout.filesOpen} onChange={() => setLayout({ filesOpen: !layout.filesOpen })} />
        <Toggle label="Expand accounts" description="Show account groups in the sidebar." checked={layout.accountsOpen} onChange={() => setLayout({ accountsOpen: !layout.accountsOpen })} />
        <Toggle label="Always show project accounts" description="When off, only the selected project shows its accounts." checked={preferences.showProjectAccounts} onChange={() => setPreferences({ showProjectAccounts: !preferences.showProjectAccounts })} />
      </div>}
      {section === "accounts" && <>{(["claude", "codex"] as const).map((kind) => <details className="settings-account-group" key={kind} open><summary>{TOOL_LABEL[kind]}<span className="section-count">{accounts.filter((a) => a.kind === kind).length}</span></summary><div>{accounts.filter((a) => a.kind === kind).map((account) => <AccountRow key={account.id} account={account} />)}<button className="text-button" onClick={() => useDesk.getState().setModal({ kind: "addAccount", tool: kind })}><Plus size={14} />Add {TOOL_LABEL[kind]} account</button></div></details>)}<p className="settings-note">Choose a project's account from its sidebar chips. Existing sessions keep the account they started with.</p></>}
      {section === "shortcuts" && <div className="shortcut-list">{[["Move focused tab left / right", "⌥ ⇧ ← / →"], ["Command palette", "⌘ ⇧ P"], ["Search project", "⌘ ⇧ F"], ["Split panes", "⌘ \\"], ["Add project folder", "⌘ O"], ["New Claude Code tab", "⌘ T"], ["Open file", "⌘ P"], ["Save file", "⌘ S"], ["Close tab", "⌘ W"], ["Toggle projects", "⌘ B"], ["Toggle files", "⌘ ⇧ B"], ["Switch tabs", "⌃ Tab"], ["Switch projects", "⌥ ⌘ ↑ / ↓"], ["Clear terminal", "⌘ K"], ["Open settings", "⌘ ,"]].map(([label, key]) => <div key={label}><span>{label}</span><kbd>{key}</kbd></div>)}</div>}
    </div>
  </div>;
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Command, Search } from "lucide-react";
import { useDesk, TOOL_LABEL, focusedTabId } from "../store";
import { activeProject, addProjectsFromDialog, closeTab, connectionLabel, flipSplit, jumpToWaiting, openConnection, openTerminal, saveTab, splitWorkspace } from "../actions";
import { fuzzyScore } from "./QuickOpen";
import { THEMES } from "../appearance";

interface Action { id: string; label: string; group: string; shortcut?: string; run: () => void }

export function CommandPalette() {
  const open = useDesk((s) => s.commandOpen);
  return open ? <Palette /> : null;
}
function Palette() {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const projects = useDesk((s) => s.projects);
  const tabs = useDesk((s) => s.tabs);
  const activeProjectId = useDesk((s) => s.activeProjectId);
  const focusedId = useDesk(focusedTabId);
  const close = () => useDesk.getState().setCommandOpen(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const actions = useMemo(() => {
    const s = useDesk.getState();
    const items: Action[] = [
      { id: "add-project", label: "Add project folder", group: "Workspace", shortcut: "⌘O", run: () => void addProjectsFromDialog() },
      { id: "settings", label: "Open settings", group: "Preferences", shortcut: "⌘,", run: () => s.setModal({ kind: "settings" }) },
      { id: "sidebar", label: "Toggle projects sidebar", group: "View", shortcut: "⌘B", run: () => s.setLayout({ sidebarOpen: !useDesk.getState().layout.sidebarOpen }) },
      { id: "files", label: "Show file explorer", group: "View", run: () => s.setLayout({ filesOpen: true, panel: "files" }) },
    ];
    if (activeProject()) items.push(
      { id: "open-file", label: "Open file", group: "Workspace", shortcut: "⌘P", run: () => s.setQuickOpen(true) },
      { id: "search", label: "Search and replace in project", group: "Workspace", shortcut: "⌘⇧F", run: () => s.setLayout({ filesOpen: true, panel: "search" }) },
      { id: "git", label: "Review Git changes", group: "Source control", run: () => s.setLayout({ filesOpen: true, panel: "git" }) },
      { id: "worktree", label: "New worktree…", group: "Source control", shortcut: "⌘⇧T", run: () => { const project = activeProject(); if (project) s.setModal({ kind: "worktree", projectId: project.id }); } },
      { id: "sessions", label: "Resume a past conversation", group: "Terminal", run: () => s.setLayout({ filesOpen: true, panel: "sessions" }) },
      ...(["claude", "codex", "shell"] as const).map((tool) => ({ id: `new-${tool}`, label: `New ${TOOL_LABEL[tool]} session`, group: "Terminal", shortcut: { claude: "⌘D", codex: "⌘E", shell: "⌘J" }[tool], run: () => { const project = activeProject(); if (project) openTerminal(project.id, tool); } })),
    );
    if (focusedId) items.push(
      { id: "split", label: "Toggle split panes", group: "View", shortcut: "⌘\\", run: splitWorkspace },
      { id: "split-dir", label: "Split side by side or stacked", group: "View", shortcut: "⌘⌥\\", run: flipSplit },
      { id: "close", label: "Close current tab", group: "Workspace", shortcut: "⌘W", run: () => closeTab(focusedId) },
    );
    if (tabs.find((t) => t.id === focusedId)?.type === "file") items.push({ id: "save", label: "Save current file", group: "Editor", shortcut: "⌘S", run: () => void saveTab(focusedId!) });
    if (s.tabs.some((t) => t.type === "terminal" && t.attention)) items.unshift({ id: "waiting", label: "Jump to next waiting agent", group: "Terminal", shortcut: "⌘⇧A", run: jumpToWaiting });
    items.push({ id: "ssh-new", label: "New SSH connection", group: "SSH", shortcut: "⌘⇧N", run: () => s.setModal({ kind: "ssh", id: null }) });
    items.push(...s.connections.map((c) => ({ id: `ssh-${c.id}`, label: `Connect: ${c.name} (${connectionLabel(c)})`, group: "SSH", run: () => openConnection(c.id) })));
    items.push(...projects.map((p) => ({ id: `project-${p.id}`, label: `Switch project: ${p.name}`, group: "Projects", run: () => s.selectProject(p.id) })));
    items.push(...tabs.map((t) => ({ id: `tab-${t.id}`, label: `${(t.type === "terminal" && t.sshId ? s.connections.find((c) => c.id === t.sshId)?.name : t.title) || (t.type === "terminal" ? TOOL_LABEL[t.tool] : "File")} · ${projects.find((p) => p.id === t.projectId)?.name ?? ""}`, group: "Open tabs", run: () => s.selectTab(t.id) })));
    items.push(...THEMES.map((t) => ({ id: `theme-${t.id}`, label: `Theme: ${t.name}`, group: "Preferences", run: () => s.setPreferences({ theme: t.id }) })));
    return items;
  }, [projects, tabs, activeProjectId, focusedId]);
  const results = useMemo(() => actions.map((action) => ({ action, score: fuzzyScore(query, `${action.label} ${action.group}`) })).filter((r) => r.score !== null).sort((a, b) => query ? b.score! - a.score! : 0).slice(0, 60).map((r) => r.action), [query, actions]);
  const selected = Math.max(0, Math.min(index, results.length - 1));
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [selected]);
  const choose = (action: Action) => { close(); requestAnimationFrame(action.run); };
  return <div className="modal-backdrop is-top" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
    <div className="quickopen command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={(e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, Math.min(results.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))); }
      else if (e.key === "Enter" && results[selected]) { e.preventDefault(); choose(results[selected]); }
      else if (e.key === "Tab") { e.preventDefault(); input.current?.focus(); }
    }}>
      <div className="qo-input"><Search size={16} /><input ref={input} role="combobox" aria-label="Search commands" aria-expanded="true" aria-controls="command-results" aria-activedescendant={results[selected] ? `command-${results[selected].id}` : undefined} placeholder="What would you like to do?" value={query} onChange={(e) => { setQuery(e.target.value); setIndex(0); }} /><kbd>esc</kbd></div>
      <div className="qo-list" id="command-results" role="listbox" ref={list}>{results.map((action, i) => <div key={action.id} id={`command-${action.id}`} role="option" aria-selected={i === selected} className={"qo-item" + (i === selected ? " is-active" : "")} onMouseMove={() => setIndex(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(action)}><Command size={13} /><span className="qo-name">{action.label}</span><span className="qo-dir">{action.group}</span>{action.shortcut && <kbd>{action.shortcut}</kbd>}</div>)}{!results.length && <p className="qo-note">No matching commands.</p>}</div>
      <footer className="palette-foot"><span>↑↓ navigate</span><span>↵ run command</span><kbd>⌘⇧P</kbd></footer>
    </div>
  </div>;
}

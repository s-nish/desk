// Settings ▸ Agent setup: one set of rules (AGENTS.md) and one list of MCP servers
// for every agent. See src/agentRules.ts and src/mcp.ts.

import { useEffect, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { AGENTS, TOOL_LABEL, uid, useDesk } from "../store";
import { errorText, ipc } from "../ipc";
import { openFile } from "../actions";
import { RULES, applyChange, linkPlan, ruleFileNames, ruleStatus, type RuleFiles } from "../agentRules";
import { problem, secretKey, splitCommand, type McpServer } from "../mcp";
import { ToolLogo } from "./ToolLogo";
import type { Agent } from "../types";

async function readRules(root: string): Promise<RuleFiles> {
  const files: RuleFiles = {};
  for (const name of ruleFileNames()) files[name] = await ipc.readFile(`${root}/${name}`).then((f) => f.content, () => null);
  return files;
}

function RulesCard() {
  const project = useDesk((s) => { const p = s.projects.find((x) => x.id === s.activeProjectId); return p?.worktreeOf ? s.projects.find((x) => x.id === p.worktreeOf) ?? p : p; });
  const [files, setFiles] = useState<RuleFiles | null>(null);
  const reload = () => { if (project) void readRules(project.path).then(setFiles); };
  useEffect(() => { setFiles(null); reload(); }, [project?.path]);
  if (!project) return <div className="settings-card"><div className="setting-row"><span><strong>No project open</strong><small>Open a project to see which agents read its rules.</small></span></div></div>;
  const status = files ? ruleStatus(files) : [];
  const plan = files ? linkPlan(files) : [];
  const desk = useDesk.getState();
  const linkAll = () => desk.setModal({
    kind: "confirm",
    title: "Point every agent at AGENTS.md?",
    body: plan.map((c) => (c.action === "create" ? `Create ${c.file} with one line: ${c.text.trim()}` : `Add one line to the end of ${c.file}: ${c.text.trim()}`)).join("\n") + "\n\nNothing else in these files changes.",
    confirm: "Link all",
    onConfirm: async () => {
      try {
        // Read again right before writing, so a file changed meanwhile is never clobbered.
        const now = await readRules(project.path);
        for (const change of linkPlan(now)) await ipc.writeFile(`${project.path}/${change.file}`, applyChange(now[change.file], change));
        desk.toast("Every agent now reads AGENTS.md.");
      } catch (e) { desk.toast(errorText(e), "error"); }
      reload();
    },
  });
  const create = async () => {
    const path = `${project.path}/${RULES}`;
    try {
      if ((await readRules(project.path))[RULES] != null) return reload();
      await ipc.writeFile(path, `# ${project.name}\n\nRules for every coding agent working in this project.\n`);
      desk.setModal(null);
      void openFile(project.id, path);
    } catch (e) { desk.toast(errorText(e), "error"); }
  };
  return (
    <>
      <div className="settings-card">
        {status.map((r) => (
          <div className="setting-row" key={r.tool}>
            <span className="agent-rule"><ToolLogo tool={r.tool} size={14} /><span><strong>{TOOL_LABEL[r.tool]}</strong><small>{r.why}</small></span></span>
            <span className={"agent-rule-mark" + (r.sees ? " is-yes" : "")} aria-label={r.sees ? "Reads the rules" : "Doesn't read them"}>{r.sees ? <Check size={14} /> : <X size={14} />}</span>
          </div>
        ))}
        <div className="setting-row">
          <span><strong>{project.name}</strong><small>{files?.[RULES] == null ? `Write the rules once in ${RULES}; Desk points the other agents at it.` : plan.length ? `Link all adds a one-line pointer to ${plan.map((c) => c.file).join(" and ")}.` : "Every agent reads the same rules."}</small></span>
          {files?.[RULES] == null
            ? <button className="text-button" onClick={() => void create()}>Create {RULES}</button>
            : <button className="text-button" disabled={!plan.length} onClick={linkAll}>Link all</button>}
        </div>
      </div>
    </>
  );
}

const NO_SERVERS: McpServer[] = [];

const blank = (): McpServer => ({ id: uid(), name: "", kind: "stdio", command: "", args: [], url: "", env: {}, secrets: [], off: [], projects: "all", enabled: true });

function envText(env: Record<string, string>) {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
}

function parseEnv(text: string) {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) env[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return env;
}

function ServerForm({ server, onDone }: { server: McpServer; onDone: () => void }) {
  const servers = useDesk((s) => s.preferences.mcpServers ?? NO_SERVERS);
  const activeProject = useDesk((s) => s.activeProjectId);
  const projects = useDesk((s) => s.projects);
  const [draft, setDraft] = useState(server);
  const [line, setLine] = useState([server.command, ...server.args.map((a) => (/\s|^$/.test(a) ? JSON.stringify(a) : a))].join(" ").trim());
  const [env, setEnv] = useState(envText(server.env));
  const [keys, setKeys] = useState(server.secrets.join(", "));
  const built: McpServer = {
    ...draft,
    name: draft.name.trim(),
    ...splitCommand(line),
    env: parseEnv(env),
    secrets: keys.split(/[\s,]+/).filter(Boolean),
  };
  const error = problem(built, servers);
  const save = () => {
    if (error) return;
    const list = servers.some((s) => s.id === built.id) ? servers.map((s) => (s.id === built.id ? built : s)) : [...servers, built];
    useDesk.getState().setPreferences({ mcpServers: list });
    onDone();
  };
  const projectId = activeProject ? projects.find((p) => p.id === activeProject)?.worktreeOf ?? activeProject : null;
  const projectName = projects.find((p) => p.id === projectId)?.name;
  const toggle = (tool: Agent) => setDraft((d) => ({ ...d, off: d.off.includes(tool) ? d.off.filter((t) => t !== tool) : [...d.off, tool] }));
  return (
    <form className="mcp-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <label><span>Name</span><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="github" autoFocus /></label>
      <div className="segmented is-small" role="group" aria-label="How it runs">
        <button type="button" className={draft.kind === "stdio" ? "is-on" : ""} onClick={() => setDraft({ ...draft, kind: "stdio" })}>Command</button>
        <button type="button" className={draft.kind === "http" ? "is-on" : ""} onClick={() => setDraft({ ...draft, kind: "http" })}>URL</button>
      </div>
      {draft.kind === "stdio"
        ? <label><span>Command</span><input value={line} onChange={(e) => setLine(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-github" spellCheck={false} /></label>
        : <label><span>URL</span><input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://example.com/mcp" spellCheck={false} /></label>}
      {draft.kind === "stdio" && <label><span>Variables</span><textarea rows={2} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="NAME=value, one per line" spellCheck={false} /></label>}
      {draft.kind === "stdio" && <label><span>Keys</span><input value={keys} onChange={(e) => setKeys(e.target.value)} placeholder="GITHUB_TOKEN" spellCheck={false} /><small>Variable names only. Paste each value after saving; it's kept owner-only, not in Desk's settings.</small></label>}
      <fieldset><legend>Agents</legend>{AGENTS.map((tool) => <label key={tool} className="mcp-agent"><input type="checkbox" checked={!draft.off.includes(tool)} onChange={() => toggle(tool)} /><ToolLogo tool={tool} size={12} />{TOOL_LABEL[tool]}</label>)}</fieldset>
      <label><span>Projects</span>
        <select value={draft.projects === "all" ? "all" : "one"} onChange={(e) => setDraft({ ...draft, projects: e.target.value === "all" || !projectId ? "all" : [projectId] })}>
          <option value="all">Every project</option>
          {(projectId || draft.projects !== "all") && <option value="one">Only {draft.projects === "all" ? projectName : draft.projects.map((id) => projects.find((p) => p.id === id)?.name ?? "a removed project").join(", ")}</option>}
        </select>
      </label>
      <footer>
        {error && built.name && <small className="mcp-error">{error}</small>}
        <button type="button" className="text-button" onClick={onDone}>Cancel</button>
        <button className="btn is-primary" disabled={!!error}>Save</button>
      </footer>
    </form>
  );
}

function SecretField({ server, name }: { server: McpServer; name: string }) {
  const key = secretKey(server, name);
  const [saved, setSaved] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  useEffect(() => { void ipc.sandboxSecretHas(key).then(setSaved, () => setSaved(false)); }, [key]);
  if (saved) return <span className="mcp-secret"><code>{name}</code> saved <button className="text-button" onClick={() => void ipc.sandboxSecretDelete(key).then(() => setSaved(false))}>Forget</button></span>;
  return (
    <span className="mcp-secret">
      <code>{name}</code>
      <input type="password" value={value} placeholder="Paste the value" aria-label={`Value for ${name}`} onChange={(e) => setValue(e.target.value)} />
      <button className="text-button" disabled={!value.trim()} onClick={() => void ipc.sandboxSecretSet(key, value).then(() => { setValue(""); setSaved(true); }, (e) => useDesk.getState().toast(errorText(e), "error"))}>Save</button>
    </span>
  );
}

function McpCard() {
  const servers = useDesk((s) => s.preferences.mcpServers ?? NO_SERVERS);
  const projects = useDesk((s) => s.projects);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const set = (list: McpServer[]) => useDesk.getState().setPreferences({ mcpServers: list });
  const remove = (s: McpServer) => {
    for (const name of s.secrets) void ipc.sandboxSecretDelete(secretKey(s, name)).catch(() => {});
    set(servers.filter((x) => x.id !== s.id));
  };
  return (
    <div className="settings-card">
      {servers.map((s) => editing?.id === s.id ? <ServerForm key={s.id} server={s} onDone={() => setEditing(null)} /> : (
        <div className="setting-row mcp-row" key={s.id}>
          <span>
            <strong>{s.name}</strong>
            <small>
              {s.kind === "http" ? s.url : [s.command, ...s.args].join(" ")}
              {" · "}{s.projects === "all" ? "every project" : s.projects.map((id) => projects.find((p) => p.id === id)?.name ?? "removed project").join(", ")}
              {s.off.length ? ` · not for ${s.off.map((t) => TOOL_LABEL[t]).join(", ")}` : ""}
            </small>
            {s.secrets.length > 0 && <span className="mcp-secrets">{s.secrets.map((n) => <SecretField key={n} server={s} name={n} />)}</span>}
          </span>
          <span className="sandbox-row-actions">
            <button className="text-button" onClick={() => setEditing(s)}>Edit</button>
            <button className="text-button is-danger" onClick={() => remove(s)}>Remove</button>
            <button role="switch" aria-checked={s.enabled} aria-label={`Use ${s.name}`} className={"toggle-track" + (s.enabled ? " is-on" : "")} onClick={() => set(servers.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)))}><span /></button>
          </span>
        </div>
      ))}
      {editing && !servers.some((s) => s.id === editing.id) && <ServerForm server={editing} onDone={() => setEditing(null)} />}
      {!editing && <div className="setting-row"><span><strong>{servers.length ? "Add another" : "No servers yet"}</strong><small>Add an MCP server once and every agent gets it when it starts.</small></span><button className="text-button" onClick={() => setEditing(blank())}><Plus size={13} />Add server</button></div>}
    </div>
  );
}

export function AgentSetupSettings() {
  return (
    <>
      <h3 className="settings-subhead">Rules</h3>
      <RulesCard />
      <h3 className="settings-subhead">MCP servers</h3>
      <McpCard />
      <p className="settings-note">Desk passes these servers to each agent as it starts (Claude Code's --mcp-config, Codex's -c settings, session/new for the others) and changes nothing in ~/.claude, ~/.codex or any agent's own config. Untrusted folders get none. In a sandbox, only URL servers go along, since a command may not exist there. Gemini CLI, Cursor Agent, Grok and OpenCode get them in chats, not in their own terminal tabs.</p>
    </>
  );
}

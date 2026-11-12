// Sandboxes in the interface: where a chat runs (a chip in the composer), the
// strip on a sandbox chat, a one-line suggestion on long local tasks, the setup
// sheet for a provider, and Settings ▸ Sandboxes. Nothing here is ever required:
// "This Mac" is always first and needs no account.

import { useEffect, useMemo, useState } from "react";
import { Check, Cloud, Copy, ExternalLink, Laptop, LoaderCircle, SquareTerminal } from "lucide-react";
import { useDesk } from "../store";
import { useChats, type Chat } from "../chat";
import { openTerminal } from "../actions";
import { ipc } from "../ipc";
import { openMenu } from "./Menu";
import { Shell } from "./Modals";
import {
  PROVIDERS, checkAllProviders, checkProvider, createSandbox, provider, refreshStates, removeSandbox, shellCommand, stopSandbox, tokenKey, useSandboxes,
  type ProviderId, type Sandbox,
} from "../sandbox";
import { pullChanges } from "../sandbox/chats";
import type { MenuItem } from "../types";

const HINT_AFTER_MS = 10 * 60_000;

const label = (id: string) => provider(id)?.label ?? id;

export function openSandboxSetup(id: ProviderId) {
  useDesk.getState().setModal({ kind: "sandboxSetup", provider: id });
}

function setWhere(chat: Chat, where: string | null) {
  useChats.getState().patch(chat.id, { where, remote: null, ...(where ? { worktree: false } : {}) });
}

/** "This Mac" or a sandbox, chosen before the first message. */
export function RunInChip({ chat, fresh, repo }: { chat: Chat; fresh: boolean; repo: boolean }) {
  const sandboxes = useDesk((s) => s.sandboxes);
  const checks = useSandboxes((s) => s.checks);
  const states = useSandboxes((s) => s.states);
  const progress = useSandboxes((s) => s.progress[`new:${chat.projectId}`]);
  const current = sandboxes.find((x) => x.id === chat.where);
  const projectId = useDesk((s) => s.projects.find((p) => p.id === chat.projectId)?.worktreeOf ?? chat.projectId);
  const mine = sandboxes.filter((x) => x.projectId === projectId);

  if (!fresh) {
    if (!current) return null;
    return <span className="chat-chip is-static" title={`Runs in ${label(current.provider)} (${current.name})`}><Cloud size={12} />{label(current.provider)}</span>;
  }
  const open = async (at: Element) => {
    void checkAllProviders();
    const items: MenuItem[] = [
      { label: "This Mac", icon: <Laptop size={13} />, checked: !chat.where, onSelect: () => setWhere(chat, null) },
    ];
    if (mine.length) {
      items.push({ separator: true });
      for (const x of mine) {
        const state = states[x.id];
        items.push({ label: `${x.name}`, hint: `${label(x.provider)}${state ? ` · ${state}` : ""}`, icon: <Cloud size={13} />, checked: chat.where === x.id, onSelect: () => setWhere(chat, x.id) });
      }
    }
    items.push({ separator: true });
    for (const p of PROVIDERS) {
      const check = checks[p.id];
      items.push(check?.ready
        ? { label: `New ${p.label} sandbox`, hint: p.blurb, onSelect: () => void make(p.id) }
        : { label: p.label, hint: "Set up…", onSelect: () => openSandboxSetup(p.id) });
    }
    items.push({ separator: true }, { label: "Sandbox settings…", onSelect: () => useDesk.getState().setModal({ kind: "settings", section: "sandboxes" }) });
    openMenu(at, items);
  };
  const make = async (id: ProviderId) => {
    try {
      const sandbox = await createSandbox(projectId, id);
      setWhere(chat, sandbox.id);
      useDesk.getState().toast(`${label(id)} sandbox ready. Your first message sends the code there.`);
    } catch (e) {
      useDesk.getState().toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  if (!repo) return null;
  return (
    <button className="chat-chip" title={current ? `Runs in ${label(current.provider)} (${current.name}). Keeps going when you close Desk.` : "Where this chat runs. A sandbox keeps going when you close Desk (or the lid, with a cloud one)."} onClick={(e) => void open(e.currentTarget)}>
      {progress ? <LoaderCircle size={12} className="is-spinning" /> : current ? <Cloud size={12} /> : <Laptop size={12} />}
      <span className="chip-label">{progress ? "Making sandbox…" : current ? label(current.provider) : "This Mac"}</span>
    </button>
  );
}

/** One line on a sandbox chat: where, its state, and what you can do. */
export function SandboxStrip({ chat }: { chat: Chat }) {
  const sandbox = useDesk((s) => s.sandboxes.find((x) => x.id === chat.where));
  const state = useSandboxes((s) => (sandbox ? s.states[sandbox.id] : undefined));
  const [pulling, setPulling] = useState(false);
  useEffect(() => { if (sandbox && !state) void refreshStates(sandbox.projectId); }, [sandbox, state]);
  if (!sandbox) return null;
  const p = provider(sandbox.provider);
  const shell = shellCommand(sandbox);
  const toast = useDesk.getState().toast;
  const pull = async () => {
    setPulling(true);
    try {
      const got = await pullChanges(chat.id);
      toast(`Pulled ${got.branch} into ${got.path}${got.changes ? ", with its uncommitted changes" : ""}.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setPulling(false);
    }
  };
  const signIn = () => {
    const account = useDesk.getState().accounts.find((a) => a.id === chat.accountId);
    const folder = account?.dir ? account.dir.split("/").pop()!.replace(/^\.+/, "") : null;
    const variable = chat.tool === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
    const command = folder ? `${variable}=~/.desk/accounts/${folder} ${chat.tool}` : chat.tool;
    if (shell) openTerminal(chat.projectId, "shell", { command: shell });
    toast(`In the sandbox, run: ${command}${chat.tool === "claude" ? " then /login" : " login"}. The sign-in stays there; Desk never sees it.`);
  };
  return (
    <div className="sandbox-strip" role="status">
      <Cloud size={12} />
      <span className="sandbox-strip-where">{p?.label} · {sandbox.name}</span>
      <span className={"sandbox-strip-state is-" + (state ?? "unknown")}>{state ?? "…"}</span>
      {chat.remote && <span className="sandbox-strip-branch">{chat.remote.branch}</span>}
      <span className="sandbox-strip-gap" />
      {chat.remote && <button className="text-button" disabled={pulling} onClick={() => void pull()}>{pulling ? "Pulling…" : "Pull changes"}</button>}
      {shell && <button className="text-button" title="A terminal tab with a shell in the sandbox" onClick={() => openTerminal(chat.projectId, "shell", { command: shell })}><SquareTerminal size={12} />Terminal</button>}
      <button className="text-button" onClick={(e) => openMenu(e.currentTarget, [
        { label: `Sign in to ${chat.tool === "codex" ? "Codex" : "Claude Code"} there…`, disabled: !shell, onSelect: signIn },
        { label: "Stop the sandbox", hint: "Its disk is kept", disabled: state !== "running" || chat.status !== "idle", onSelect: () => void stopSandbox(sandbox) },
      ])}>More</button>
    </div>
  );
}

/** Once per project, on a long local task: a calm suggestion. Never blocks anything. */
export function SandboxHint({ chat }: { chat: Chat }) {
  const prefs = useDesk((s) => s.preferences);
  const projectId = useDesk((s) => s.projects.find((p) => p.id === chat.projectId)?.worktreeOf ?? chat.projectId);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (chat.status === "idle") return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [chat.status]);
  const off = prefs.sandboxHints === false || (prefs.sandboxHintOff ?? []).includes(projectId);
  if (off || chat.where || chat.status === "idle" || !chat.startedAt || now - chat.startedAt < HINT_AFTER_MS) return null;
  const notNow = () => useDesk.getState().setPreferences({ sandboxHintOff: [...(prefs.sandboxHintOff ?? []), projectId] });
  return (
    <div className="sandbox-hint">
      <Cloud size={12} />
      <span>Want this to keep going with the lid closed? Run it in a sandbox.</span>
      <button className="text-button" onClick={() => useDesk.getState().setModal({ kind: "settings", section: "sandboxes" })}>Set up</button>
      <button className="text-button" onClick={notNow}>Not now</button>
    </div>
  );
}

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="sandbox-command">
      <code>{text}</code>
      <button className="text-button" onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

/** Install, sign in, check. Close it at any point; nothing is lost. */
export function SandboxSetup({ id }: { id: ProviderId }) {
  const p = provider(id)!;
  const check = useSandboxes((s) => s.checks[id]);
  const projectId = useDesk((s) => s.activeProjectId);
  const [checking, setChecking] = useState(false);
  const recheck = async () => { setChecking(true); await checkProvider(id, true).finally(() => setChecking(false)); };
  useEffect(() => { void recheck(); }, [id]);
  const installed = !!check?.installed;
  const runInTab = (command: string) => projectId && openTerminal(projectId, "shell", { command });
  return (
    <Shell title={`Set up ${p.label}`}>
      <div className="sandbox-setup">
        <p className="sandbox-setup-intro">{p.caps.lidClosed ? "Your agent keeps working when you close the lid." : "It runs on this Mac, isolated from your files; it keeps going when you quit Desk, not when the Mac sleeps."} Desk uses your own {p.label} account and never stores its sign-in.</p>
        <ol className="sandbox-steps">
          <li className={installed ? "is-done" : ""}>
            <strong>{installed ? <Check size={13} /> : "1"} Install</strong>
            {p.install.command ? <CopyLine text={p.install.command} /> : <span>Follow {p.label}'s install guide.</span>}
            <div className="sandbox-step-actions">
              {p.install.command && projectId && <button className="text-button" onClick={() => runInTab(p.install.command!)}><SquareTerminal size={12} />Run in a terminal tab</button>}
              <button className="text-button" onClick={() => void ipc.openExternal(p.install.url)}><ExternalLink size={12} />Install guide</button>
            </div>
          </li>
          <li className={check?.ready ? "is-done" : ""}>
            <strong>{check?.ready ? <Check size={13} /> : "2"} Sign in</strong>
            {p.login ? <CopyLine text={p.login.join(" ")} /> : <span>Start Docker Desktop (or OrbStack). There's nothing to sign in to.</span>}
            <div className="sandbox-step-actions">
              {p.login && projectId && <button className="text-button" onClick={() => runInTab(p.login!.join(" "))}><SquareTerminal size={12} />Sign in in a terminal tab</button>}
              <button className="text-button" onClick={() => void ipc.openExternal(p.signup)}><ExternalLink size={12} />Create an account</button>
            </div>
          </li>
          <li className={check?.ready ? "is-done" : ""}>
            <strong>{check?.ready ? <Check size={13} /> : "3"} Check</strong>
            <span className={"sandbox-check" + (check?.ready ? " is-ready" : "")}>{checking ? "Checking…" : check?.detail ?? "Not checked yet."}</span>
            <div className="sandbox-step-actions"><button className="text-button" disabled={checking} onClick={() => void recheck()}>Check again</button></div>
          </li>
        </ol>
        <footer className="modal-foot"><button className="btn is-primary" onClick={() => useDesk.getState().setModal(null)}>{check?.ready ? "Done" : "Not now"}</button></footer>
      </div>
    </Shell>
  );
}

function SandboxRow({ sandbox }: { sandbox: Sandbox }) {
  const state = useSandboxes((s) => s.states[sandbox.id]);
  const project = useDesk((s) => s.projects.find((p) => p.id === sandbox.projectId));
  const remove = () => useDesk.getState().setModal({
    kind: "confirm",
    title: `Delete ${sandbox.name}?`,
    body: `Deletes it at ${label(sandbox.provider)}, with its disk: anything not pulled to this Mac is lost, and sign-ins made there.`,
    confirm: "Delete",
    danger: true,
    onConfirm: () => void removeSandbox(sandbox),
  });
  return (
    <div className="setting-row">
      <span><strong>{sandbox.name}</strong><small>{label(sandbox.provider)} · {project?.name ?? "removed project"} · {state ?? "…"}</small></span>
      <span className="sandbox-row-actions">
        {state === "running" && <button className="text-button" onClick={() => void stopSandbox(sandbox)}>Stop</button>}
        <button className="text-button is-danger" onClick={remove}>Delete</button>
      </span>
    </div>
  );
}

function TokenRow({ accountId, name, kind }: { accountId: string; name: string; kind: string }) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const key = tokenKey(accountId);
  useEffect(() => { void ipc.sandboxSecretHas(key).then(setSaved); }, [key]);
  const hint = kind === "claude" ? "From `claude setup-token`" : "An OpenAI API key";
  return (
    <div className="setting-row">
      <span><strong>{name}</strong><small>{saved ? "A token is saved for sandboxes." : hint}</small></span>
      {saved
        ? <button className="text-button" onClick={() => void ipc.sandboxSecretDelete(key).then(() => setSaved(false))}>Forget</button>
        : <span className="sandbox-token">
            <input type="password" placeholder="Paste a token" value={value} onChange={(e) => setValue(e.target.value)} aria-label={`Token for ${name}`} />
            <button className="text-button" disabled={!value.trim()} onClick={() => void ipc.sandboxSecretSet(key, value).then(() => { setValue(""); setSaved(true); }, (e) => useDesk.getState().toast(String(e), "error"))}>Save</button>
          </span>}
    </div>
  );
}

function Switch({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: () => void }) {
  return <button className="setting-row" role="switch" aria-checked={checked} onClick={onChange}>
    <span><strong>{label}</strong><small>{description}</small></span><span className={"toggle-track" + (checked ? " is-on" : "")}><span /></span>
  </button>;
}

export function SandboxSettings() {
  const prefs = useDesk((s) => s.preferences);
  const setPreferences = useDesk((s) => s.setPreferences);
  const sandboxes = useDesk((s) => s.sandboxes);
  const allAccounts = useDesk((s) => s.accounts);
  const accounts = useMemo(() => allAccounts.filter((a) => a.kind === "claude" || a.kind === "codex"), [allAccounts]);
  const checks = useSandboxes((s) => s.checks);
  useEffect(() => { void checkAllProviders(); void refreshStates(); }, []);
  return (
    <>
      <div className="settings-card">
        {PROVIDERS.map((p) => (
          <div className="setting-row" key={p.id}>
            <span><strong>{p.label}</strong><small>{p.blurb}{checks[p.id] ? ` · ${checks[p.id]!.detail}` : ""}</small></span>
            <button className="text-button sandbox-setup-button" onClick={() => openSandboxSetup(p.id)}>{checks[p.id]?.ready ? "Ready" : "Set up…"}</button>
          </div>
        ))}
      </div>
      <div className="settings-card">
        <div className="setting-row">
          <span><strong>Unattended for up to</strong><small>The provider stops a run left alone this long. That's your cost ceiling.</small></span>
          <select value={prefs.sandboxHours ?? 8} onChange={(e) => setPreferences({ sandboxHours: Number(e.target.value) })} aria-label="Unattended hours">
            {[1, 2, 4, 8, 12, 24].map((h) => <option key={h} value={h}>{h} hour{h > 1 ? "s" : ""}</option>)}
          </select>
        </div>
        <Switch label="Stop idle sandboxes" description="After 10 minutes with no agent running, while Desk is open. The disk is kept." checked={prefs.sandboxAutoStop !== false} onChange={() => setPreferences({ sandboxAutoStop: prefs.sandboxAutoStop === false })} />
        <Switch label="Suggest a sandbox for long tasks" description="One line under the message box after ten minutes, once per project." checked={prefs.sandboxHints !== false} onChange={() => setPreferences({ sandboxHints: prefs.sandboxHints === false, sandboxHintOff: [] })} />
      </div>
      {sandboxes.length > 0 && <div className="settings-card">{sandboxes.map((x) => <SandboxRow key={x.id} sandbox={x} />)}</div>}
      <div className="settings-card">
        {accounts.map((a) => <TokenRow key={a.id} accountId={a.id} name={`${a.kind === "claude" ? "Claude Code" : "Codex"} · ${a.name}`} kind={a.kind} />)}
      </div>
      <p className="settings-note">Agents in a sandbox sign in there, with their own login, so Desk never sees the token. Pasting one is optional: it's kept in an owner-only file on this Mac and sent to the sandbox on stdin, never in a command line or a log. Code goes in and comes back with git; Desk commits and pushes nothing.</p>
    </>
  );
}

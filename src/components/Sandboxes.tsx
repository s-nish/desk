// Sandboxes in the interface: where an agent runs (a radial picker in the chat
// composer, the terminal's new-tab menus), the bar on a sandbox chat or tab, a
// one-line suggestion on long local tasks, and Settings ▸ Sandboxes. Nothing
// here is ever required: "This Mac" is always first and needs no account.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Container, Copy, Download, ExternalLink, GitBranch, Globe, Network, LoaderCircle, MoreHorizontal, Play, Plus, RefreshCw, Settings2, Square, SquareTerminal, Trash2, X } from "lucide-react";
import { TOOL_LABEL, uid, useDesk, type SandboxStartup } from "../store";
import { restartAgent, updateItems } from "../chat";
import { useChats, type Chat } from "../chat";
import { openTerminal, rootProject } from "../actions";
import { ipc } from "../ipc";
import { openMenu } from "./Menu";
import { Radial, useRadial, type RadialItem } from "./Radial";
import { SandboxLogo } from "./SandboxLogo";
import { ToolLogo } from "./ToolLogo";
import {
  PROVIDERS, checkAllProviders, checkProvider, createSandbox, making, provider, refreshStates, removeSandbox, shellCommand, startProvider, stopSandbox, tokenKey, useSandboxes, wakeSandbox,
  type ProviderCheck, type ProviderId, type Sandbox,
} from "../sandbox";
import { forgetBridge, pullWork } from "../sandbox/chats";
import { MODE_TEXT, chatSandboxMode, defaultSandboxMode, type SandboxMode } from "../sandbox/bridge";
import { canRunTerminal, openSandboxTerminal } from "../sandbox/terminal";
import { forward, localUrl, scan, unforward, usePorts } from "../sandbox/ports";
import { openBrowser } from "./Browser";
import type { Agent, MenuItem, TerminalTab } from "../types";

const HINT_AFTER_MS = 10 * 60_000;

const label = (id: string) => provider(id)?.label ?? id;

/** Settings ▸ Sandboxes, opened at a provider's setup steps. */
export function openSandboxSetup(id: ProviderId) {
  useDesk.getState().setModal({ kind: "settings", section: "sandboxes", provider: id });
}

function toastError(e: unknown) {
  useDesk.getState().toast(e instanceof Error ? e.message : String(e), "error");
}

type Dot = "ok" | "bad" | "warn";
function checkDot(check?: ProviderCheck): Dot { return check?.ready ? "ok" : check?.stopped ? "warn" : "bad"; }
function stateDot(state?: string): Dot { return state === "running" ? "ok" : state === "missing" ? "bad" : "warn"; }
/** What a sandbox's status reads as, and its dot: amber while starting or unknown. */
function shownState(state: string | undefined, waking: string | undefined): { text: string; dot: Dot } {
  const text = waking ? "starting" : state ?? "checking";
  return { text, dot: text === "starting" || text === "checking" ? "warn" : stateDot(text) };
}
function checkText(p: { label: string }, check?: ProviderCheck) {
  if (!check) return "Checking…";
  if (check.ready) return "Ready";
  if (check.stopped) return `${p.label} isn't running`;
  return check.installed ? "Not signed in" : "Not installed";
}

/** Makes a sandbox with a provider: starts Docker first if it's closed, or opens setup if it isn't set up. */
async function withProvider(id: ProviderId, then: () => Promise<void> | void) {
  let check = useSandboxes.getState().checks[id] ?? (await checkProvider(id));
  if (!check.ready && check.stopped) check = await startProvider(id).catch((e) => { toastError(e); return check; });
  if (!check.ready) return openSandboxSetup(id);
  await then();
}

/**
 * The radial's items: This Mac, this project's sandboxes, a new one with each
 * provider, and settings. `terminal` leaves out providers with no interactive tab.
 */
function whereItems(o: {
  projectId: string;
  current: string | null;
  terminal?: boolean;
  /** Why sandboxes can't be used from here (shown on them, and they're disabled). */
  blocked?: string;
  onMac?: () => void;
  onSandbox: (x: Sandbox) => void;
  onNew: (id: ProviderId) => void;
}): RadialItem[] {
  const { sandboxes } = useDesk.getState();
  const { checks, states } = useSandboxes.getState();
  const items: RadialItem[] = [];
  if (o.onMac) items.push({ key: "mac", icon: <SandboxLogo provider="mac" size={18} />, label: "This Mac", sub: "Runs here, in your folder", on: !o.current, onSelect: o.onMac });
  const mine = sandboxes.filter((x) => x.projectId === o.projectId && (!o.terminal || canRunTerminal(x.provider))).sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);
  for (const x of mine) {
    const state = states[x.id];
    items.push({ key: x.id, icon: <SandboxLogo provider={x.provider} size={20} />, label: x.name, sub: `${label(x.provider)} · ${state ?? "checking…"}`, on: o.current === x.id, dot: stateDot(state), disabled: !!o.blocked, onSelect: () => o.onSandbox(x) });
  }
  for (const p of PROVIDERS) {
    if (o.terminal && !p.tty) continue;
    const check = checks[p.id];
    const sub = o.blocked ? o.blocked : check?.ready ? p.blurb : check?.stopped ? `${p.label} isn't running. Pick to start it` : check ? "Not set up. Pick to set it up" : "Checking…";
    items.push({ key: `new-${p.id}`, icon: <SandboxLogo provider={p.id} size={20} />, label: `New ${p.label} sandbox`, sub, dot: checkDot(check), badge: <Plus size={9} strokeWidth={3} />, disabled: !!o.blocked, onSelect: () => o.onNew(p.id) });
  }
  items.push({ key: "settings", icon: <Settings2 size={17} />, label: "Sandbox settings", sub: "Providers, startup, tokens", onSelect: () => useDesk.getState().setModal({ kind: "settings", section: "sandboxes" }) });
  return items;
}

function setWhere(chat: Chat, where: string | null) {
  const mode = where ? defaultSandboxMode() : undefined;
  forgetBridge(chat.id);
  // The agent stays here in code mode, so a worktree still makes sense; in the sandbox it gets a branch there.
  useChats.getState().patch(chat.id, { where, sandboxMode: mode, remote: null, ...(mode === "agent" ? { worktree: false } : {}) });
}

/**
 * Where the chat runs, always in the composer: "This Mac" or a sandbox, with a
 * radial of logos and status dots. Before the first message it picks the place;
 * after, it moves the chat (a new conversation there).
 */
export function RunInChip({ chat, fresh, repo }: { chat: Chat; fresh: boolean; repo: boolean }) {
  const sandboxes = useDesk((s) => s.sandboxes);
  useSandboxes((s) => s.checks);
  useSandboxes((s) => s.states);
  const current = sandboxes.find((x) => x.id === chat.where);
  const gone = !!chat.where && !current;
  const projectId = useDesk((s) => s.projects.find((p) => p.id === chat.projectId)?.worktreeOf ?? chat.projectId);
  // Only this chat's own sandbox in the making; others may be on their way at the same time.
  const progress = useSandboxes((s) => Object.entries(s.progress).find(([k, v]) => v && k.startsWith("new:") && k.endsWith(`|${chat.id}`))?.[1]);
  const radial = useRadial();
  const mover = useMovePicker(chat, repo);

  const make = (id: ProviderId) => void withProvider(id, async () => {
    try {
      const sandbox = await createSandbox(projectId, id, chat.id);
      setWhere(chat, sandbox.id);
      useDesk.getState().toast(`${label(id)} sandbox ready. Your first message sends the code there.`);
    } catch (e) { toastError(e); }
  });
  const open = (el: HTMLElement) => {
    if (!fresh) { mover.open(el); return; }
    void checkAllProviders();
    void refreshStates(projectId);
    radial.open(el);
  };
  const opened = radial.opened || mover.opened;
  const items = radial.state ? whereItems({ projectId, current: chat.where ?? null, blocked: repo ? undefined : NEEDS_REPO, onMac: () => setWhere(chat, null), onSandbox: (x) => setWhere(chat, x.id), onNew: make }) : [];
  const name = progress ? "Making sandbox…" : current ? label(current.provider) : gone ? "Sandbox gone" : "This Mac";
  const title = gone
    ? "This chat's sandbox was deleted. Pick where it goes on (a new conversation there)."
    : !fresh
      ? `${current ? `Runs in ${label(current.provider)} (${current.name})` : "Runs on this Mac"}. Pick another place to move this chat (a new conversation there).`
      : current
        ? chatSandboxMode(chat) === "code"
          ? `The agent works on this Mac; your code builds and runs in ${label(current.provider)} (${current.name}).`
          : `Runs in ${label(current.provider)} (${current.name}). Keeps going when you close Desk.`
        : "Where this chat runs. A sandbox keeps going when you close Desk (or the lid, with a cloud one).";
  return (
    <>
      <button className={"chat-chip run-in-chip" + (opened ? " is-open" : "") + (gone ? " is-gone" : "")} aria-haspopup="menu" aria-expanded={opened} title={title} onClick={(e) => (radial.opened ? radial.close() : open(e.currentTarget))}>
        {progress ? <LoaderCircle size={12} className="is-spinning" /> : <SandboxLogo provider={current?.provider ?? "mac"} size={13} />}
        <span className="chip-label">{name}</span>
        <ChevronDown size={11} />
      </button>
      {radial.state && <Radial state={radial.state} items={items} label="Where this chat runs" onClosed={radial.close} />}
      {mover.element}
    </>
  );
}

const NEEDS_REPO = "Needs a git repository (the code goes there as a branch)";

/** The terminal's "in a sandbox" picker: opens an agent tab in a sandbox. */
export function useSandboxTerminalPicker() {
  const radial = useRadial();
  const [req, setReq] = useState<{ projectId: string; tool: Agent } | null>(null);
  useSandboxes((s) => s.checks);
  useSandboxes((s) => s.states);
  const open = (el: HTMLElement, projectId: string, tool: Agent) => {
    const project = useDesk.getState().projects.find((p) => p.id === projectId);
    if (!project) return;
    void checkAllProviders();
    void refreshStates(rootProject(project).id);
    setReq({ projectId, tool });
    radial.open(el);
  };
  const root = req ? rootProject(useDesk.getState().projects.find((p) => p.id === req.projectId)!) : null;
  const element = radial.state && req && root ? (
    <Radial
      state={radial.state}
      label={`Run ${TOOL_LABEL[req.tool]} in a sandbox`}
      onClosed={radial.close}
      items={whereItems({
        projectId: root.id,
        current: null,
        terminal: true,
        onSandbox: (x) => void openSandboxTerminal(req.projectId, req.tool, { sandboxId: x.id }),
        onNew: (id) => void withProvider(id, () => openSandboxTerminal(req.projectId, req.tool, { provider: id })),
      })}
    />
  ) : null;
  return { open, element };
}

/**
 * The tab bar's sandbox button: Claude Code in a sandbox, in one click and a pick
 * from the radial (every provider, and this project's sandboxes). ⌥-click for Codex.
 */
export function SandboxTabButton({ projectId, picker }: { projectId: string; picker: ReturnType<typeof useSandboxTerminalPicker> }) {
  const root = useDesk((s) => { const p = s.projects.find((x) => x.id === projectId); return p ? (p.worktreeOf ?? p.id) : projectId; });
  const sandboxes = useDesk((s) => s.sandboxes);
  const states = useSandboxes((s) => s.states);
  const running = sandboxes.filter((x) => x.projectId === root && states[x.id] === "running").length;
  const busy = useSandboxes((s) => Object.entries(s.progress).some(([k, v]) => v && (k.startsWith("term:|") || k.startsWith("new:|")) && k.split("|")[1] === root));
  return (
    <button className={"icon-btn sandbox-tab-button" + (busy ? " is-busy" : "")} aria-label="Agent in a sandbox" title={"Claude Code in a sandbox: Docker, Docker Cloud, Boat or Modal\n⌥-click for Codex"} onClick={(e) => picker.open(e.currentTarget, projectId, e.altKey ? "codex" : "claude")}>
      {busy ? <LoaderCircle size={15} className="is-spinning" /> : <Container size={15} />}
      {running > 0 && <span className="sandbox-tab-count" aria-label={`${running} running`}>{running}</span>}
    </button>
  );
}

/** Menu items for a new agent tab in a sandbox; `pick` opens the radial at the menu's button. */
export function sandboxTabItems(at: HTMLElement, projectId: string, picker: ReturnType<typeof useSandboxTerminalPicker>) {
  return (["claude", "codex"] as Agent[]).map((tool) => ({
    label: `${TOOL_LABEL[tool]} in a sandbox…`,
    hint: "Docker or the cloud",
    icon: <ToolLogo tool={tool} size={14} />,
    onSelect: () => setTimeout(() => picker.open(at, projectId, tool), 0),
  }));
}

/** One slim bar on a sandbox chat or tab: where, its state, the branch, and what you can do. */
export function SandboxBar({ sandbox, remote, projectId, tool, accountId, idle = true, terminal, move, moving, extra, codeOnly }: {
  sandbox: Sandbox;
  remote: { cwd: string; branch: string; base: string } | null;
  projectId: string;
  tool: Agent | "shell";
  accountId: string | null;
  idle?: boolean;
  /** Sits above a terminal tab instead of a message box. */
  terminal?: boolean;
  /** Opens the picker to move a chat elsewhere. */
  move?: (el: HTMLElement) => void;
  moving?: string;
  extra?: React.ReactNode;
  /** The agent runs on this Mac; only the code runs in the sandbox. */
  codeOnly?: boolean;
}) {
  const state = useSandboxes((s) => s.states[sandbox.id]);
  const waking = useSandboxes((s) => s.progress[`wake:${sandbox.id}`]);
  const [pulling, setPulling] = useState(false);
  useEffect(() => { if (!state) void refreshStates(sandbox.projectId); }, [sandbox, state]);
  const p = provider(sandbox.provider);
  const shell = shellCommand(sandbox);
  const toast = useDesk.getState().toast;
  const pull = async () => {
    if (!remote) return;
    setPulling(true);
    try {
      const got = await pullWork(sandbox, projectId, remote);
      toast(`Pulled ${got.branch} into ${got.path}${got.changes ? ", with its uncommitted changes" : ""}.`);
    } catch (e) { toastError(e); } finally { setPulling(false); }
  };
  const signIn = () => {
    const account = useDesk.getState().accounts.find((a) => a.id === accountId);
    const folder = account?.dir ? account.dir.split("/").pop()!.replace(/^\.+/, "") : null;
    const variable = tool === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
    const command = folder ? `${variable}=~/.desk/accounts/${folder} ${tool}` : tool;
    if (shell) openTerminal(projectId, "shell", { command: shell });
    toast(`In the sandbox, run: ${command}${tool === "claude" ? " then /login" : " login"}. The sign-in stays there; Desk never sees it.`);
  };
  const shown = shownState(state, waking);
  return (
    <div className={"sandbox-bar" + (terminal ? " is-terminal" : "")} role="status">
      <span className="sandbox-bar-logo"><SandboxLogo provider={sandbox.provider} size={14} /></span>
      <span className="sandbox-bar-where"><strong>{p?.label}</strong><span>{sandbox.name}</span></span>
      <span className={"sandbox-bar-state is-" + shown.dot} title={waking || undefined}><i />{shown.text}</span>
      {codeOnly && <span className="sandbox-bar-mode" title={MODE_TEXT.code.body}>{MODE_TEXT.code.short}</span>}
      {remote && <span className="sandbox-bar-branch" title={`From ${remote.base}`}><GitBranch size={11} />{remote.branch}</span>}
      <span className="sandbox-bar-gap" />
      {moving && <span className="sandbox-bar-moving"><LoaderCircle size={12} className="is-spinning" />{moving}</span>}
      {!waking && (state === "stopped" || state === "missing") && <button className="sandbox-bar-btn is-primary" title={state === "missing" ? "It's gone at the provider: Desk makes a new one with the same name" : "Start it again; its disk was kept"} onClick={() => void wakeSandbox(sandbox).catch(toastError)}><Play size={12} /><span>{state === "missing" ? "Make a new one" : "Start"}</span></button>}
      {move && <button className="sandbox-bar-btn" title="Move this chat to another sandbox, or to this Mac" onClick={(e) => move(e.currentTarget)}><RefreshCw size={12} /><span>Move</span></button>}
      {remote && <button className="sandbox-bar-btn" disabled={pulling} title="Bring the branch home as a worktree, with uncommitted changes" onClick={() => void pull()}>{pulling ? <LoaderCircle size={12} className="is-spinning" /> : <Download size={12} />}<span>{pulling ? "Pulling…" : "Pull changes"}</span></button>}
      {state === "running" && <PortsButton sandbox={sandbox} />}
      {shell && <button className="sandbox-bar-btn" title="A terminal tab with a shell in the sandbox" onClick={() => openTerminal(projectId, "shell", { command: shell })}><SquareTerminal size={12} /><span>Shell</span></button>}
      <button className="sandbox-bar-btn is-icon" aria-label="More sandbox actions" title="More" onClick={(e) => openMenu(e.currentTarget, [
        ...(codeOnly ? [] : [{ label: `Sign in to ${tool === "codex" ? "Codex" : "Claude Code"} there…`, disabled: !shell || tool === "shell", onSelect: signIn }]),
        { label: "Check again", icon: <RefreshCw size={13} />, onSelect: () => void refreshStates(sandbox.projectId) },
        state !== "running"
          ? { label: "Start the sandbox", icon: <Play size={13} />, onSelect: () => void wakeSandbox(sandbox).catch(toastError) }
          : { label: "Stop the sandbox", hint: "Its disk is kept", icon: <Square size={13} />, disabled: !idle, onSelect: () => void stopSandbox(sandbox) },
        { separator: true },
        { label: "Sandbox settings…", onSelect: () => useDesk.getState().setModal({ kind: "settings", section: "sandboxes" }) },
      ])}><MoreHorizontal size={14} /></button>
      {extra}
    </div>
  );
}

/** Servers running in the sandbox, forwarded to localhost here. */
function PortsButton({ sandbox }: { sandbox: Sandbox }) {
  const forwards = usePorts((s) => s.forwards);
  const seen = usePorts((s) => s.seen[sandbox.id]);
  const mine = Object.values(forwards).filter((f) => f.sandboxId === sandbox.id).sort((a, b) => a.remote - b.remote);
  const others = (seen ?? []).filter((port) => !mine.some((f) => f.remote === port));
  const show = async (el: HTMLElement) => {
    const items: MenuItem[] = [];
    for (const f of mine) {
      const url = localUrl(f);
      if (items.length) items.push({ separator: true });
      items.push(
        { label: `localhost:${f.local}`, hint: f.local === f.remote ? "Open in Desk" : `Port ${f.remote} there`, icon: <Globe size={13} />, onSelect: () => openBrowser(url) },
        { label: "Open in your browser", icon: <ExternalLink size={13} />, onSelect: () => void ipc.openExternal(url) },
        { label: "Copy address", icon: <Copy size={13} />, onSelect: () => void navigator.clipboard.writeText(url) },
        { label: "Stop forwarding", icon: <X size={13} />, onSelect: () => unforward(f, true) },
      );
    }
    if (others.length) {
      if (items.length) items.push({ separator: true });
      for (const port of others) items.push({ label: `Forward port ${port}`, icon: <Plus size={13} />, onSelect: () => void forward(sandbox, port).then((f) => openBrowser(localUrl(f))).catch(toastError) });
    }
    if (!items.length) items.push({ label: "Nothing is listening there yet", hint: "Servers show up here when they start", disabled: true });
    items.push({ separator: true }, { label: "Look again", icon: <RefreshCw size={13} />, onSelect: () => void scan(sandbox) });
    openMenu(el, items);
  };
  return (
    <button className="sandbox-bar-btn" title="Servers in the sandbox, at localhost on this Mac" onClick={(e) => void show(e.currentTarget)}>
      <Network size={12} /><span>{mine.length ? `Ports · ${mine.length}` : "Ports"}</span>
    </button>
  );
}

/**
 * Moves a chat that has already started to another sandbox, or back to this Mac.
 * The agent there starts a new conversation (its history was in the old place);
 * the messages above stay.
 */
export function moveChat(chat: Chat, to: Sandbox | null) {
  const project = useDesk.getState().projects.find((p) => p.id === chat.projectId);
  const toMode: SandboxMode | null = to ? defaultSandboxMode() : null;
  forgetBridge(chat.id);
  // The agent stays on this Mac either way: same conversation, only where the code runs changes.
  if (chatSandboxMode(chat) !== "agent" && toMode !== "agent") {
    restartAgent(chat.id);
    useChats.getState().patch(chat.id, { where: to?.id ?? null, sandboxMode: toMode ?? undefined, remote: null, runId: null });
    if (chat.saved || chat.items.length) updateItems(chat.id, (items) => [...items, { kind: "notice", id: `move-${Date.now()}`, text: to ? `Same conversation; your code now builds and runs in ${label(to.provider)} (${to.name}).` : "Same conversation; your code runs on this Mac again." }]);
    return;
  }
  const started = !!chat.remote || chat.saved;
  restartAgent(chat.id);
  useChats.getState().patch(chat.id, {
    where: to?.id ?? null,
    sandboxMode: toMode ?? undefined,
    remote: null,
    runId: null,
    worktree: false,
    ...(started ? { sessionId: chat.tool === "claude" ? uid() : null, saved: false } : {}),
    ...(project ? { cwd: project.path } : {}),
  });
  if (started) updateItems(chat.id, (items) => [...items, { kind: "notice", id: `move-${Date.now()}`, text: to ? (toMode === "agent" ? `Continues in ${label(to.provider)} (${to.name}) as a new conversation. Your next message sends the code there.` : `Continues on this Mac as a new conversation; your code builds and runs in ${label(to.provider)} (${to.name}).`) : "Continues on this Mac, in the project folder, as a new conversation." }]);
}

/** Picks somewhere else for a started chat: the same radial, with every provider. */
function useMovePicker(chat: Chat, repo = true) {
  const radial = useRadial();
  useSandboxes((s) => s.checks);
  useSandboxes((s) => s.states);
  const projectId = useDesk((s) => s.projects.find((p) => p.id === chat.projectId)?.worktreeOf ?? chat.projectId);
  const open = (el: HTMLElement) => { void checkAllProviders(); void refreshStates(projectId); radial.open(el); };
  const element = radial.state ? (
    <Radial state={radial.state} label="Move this chat" onClosed={radial.close} items={whereItems({
      projectId,
      current: chat.where ?? null,
      blocked: repo ? undefined : NEEDS_REPO,
      onMac: () => { if (chat.where) moveChat(chat, null); },
      onSandbox: (x) => { if (x.id !== chat.where) moveChat(chat, x); },
      onNew: (id) => void withProvider(id, async () => {
        try { moveChat(chat, await createSandbox(projectId, id, chat.id)); } catch (e) { toastError(e); }
      }),
    })} />
  ) : null;
  return { open, element, opened: radial.opened };
}

/** The bar on a sandbox chat; when its sandbox was deleted, a way on. */
export function SandboxStrip({ chat }: { chat: Chat }) {
  const sandbox = useDesk((s) => s.sandboxes.find((x) => x.id === chat.where));
  const mover = useMovePicker(chat);
  const progress = useSandboxes((s) => Object.entries(s.progress).find(([k, v]) => v && k.startsWith("new:") && k.endsWith(`|${chat.id}`))?.[1]);
  const idle = chat.status === "idle";
  if (!sandbox) {
    return (
      <div className="sandbox-bar is-missing" role="status">
        <span className="sandbox-bar-state is-bad"><i />deleted</span>
        <span className="sandbox-bar-where"><span>{progress ?? "This chat's sandbox was deleted."}</span></span>
        <span className="sandbox-bar-gap" />
        <button className="sandbox-bar-btn is-primary" disabled={!!progress} onClick={(e) => mover.open(e.currentTarget)}>{progress ? <LoaderCircle size={12} className="is-spinning" /> : <Plus size={12} />}<span>New sandbox</span></button>
        <button className="sandbox-bar-btn" disabled={!!progress} onClick={() => moveChat(chat, null)}><SandboxLogo provider="mac" size={12} /><span>This Mac</span></button>
        {mover.element}
      </div>
    );
  }
  return <SandboxBar sandbox={sandbox} remote={chat.remote ?? null} projectId={chat.projectId} tool={chat.tool} accountId={chat.accountId} idle={idle} codeOnly={chatSandboxMode(chat) === "code"}
    move={idle && !progress ? (el) => mover.open(el) : undefined} moving={progress} extra={mover.element} />;
}

/** The bar above a terminal tab whose agent runs in a sandbox. */
export function SandboxTabBar({ tab }: { tab: TerminalTab }) {
  const sandbox = useDesk((s) => s.sandboxes.find((x) => x.id === (tab.sandboxId ?? tab.codeSandbox)));
  if (!sandbox) return null;
  return <SandboxBar terminal sandbox={sandbox} remote={tab.remote ?? null} projectId={tab.projectId} tool={tab.tool as Agent} accountId={tab.accountId} idle={!tab.busy} codeOnly={!tab.sandboxId} />;
}

/** Shown in the terminal view while sandbox tabs are being prepared: one line each. */
export function SandboxTerminalProgress({ projectId }: { projectId: string }) {
  const root = useDesk((s) => { const p = s.projects.find((x) => x.id === projectId); return p ? (p.worktreeOf ?? p.id) : null; });
  const progress = useSandboxes((s) => s.progress);
  const lines = Object.entries(progress).filter(([k, v]) => v && k.startsWith("term:|") && k.split("|")[1] === root).map(([k, v]) => ({ k, v, tool: k.split("|")[2] as Agent }));
  if (!lines.length) return null;
  return (
    <div className="sandbox-progress" role="status">
      {lines.map((l) => <span key={l.k}><LoaderCircle size={12} className="is-spinning" /><ToolLogo tool={l.tool} size={12} />{l.v}</span>)}
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
      <SandboxLogo provider="docker" size={12} />
      <span>Want this to keep going with the lid closed? Run it in a sandbox.</span>
      <button className="text-button" onClick={() => useDesk.getState().setModal({ kind: "settings", section: "sandboxes" })}>Set up</button>
      <button className="text-button" onClick={notNow}>Not now</button>
    </div>
  );
}

// Settings ▸ Sandboxes

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="sandbox-command">
      <code>{text}</code>
      <button className="text-button" onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

function Refresh({ busy, onClick, label: name }: { busy: boolean; onClick: () => void; label: string }) {
  return <button className="icon-btn sandbox-refresh" aria-label={name} title={name} disabled={busy} onClick={onClick}><RefreshCw size={13} className={busy ? "is-spinning" : ""} /></button>;
}

/** A provider: its status, a refresh, and its setup steps inline. */
function ProviderCard({ id, open, onToggle }: { id: ProviderId; open: boolean; onToggle: () => void }) {
  const p = provider(id)!;
  const check = useSandboxes((s) => s.checks[id]);
  const checking = useSandboxes((s) => !!s.checking[id]);
  const starting = useSandboxes((s) => s.progress[`start:${id}`]);
  const projectId = useDesk((s) => s.activeProjectId);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [open]);
  const runInTab = (command: string) => projectId && openTerminal(projectId, "shell", { command });
  const dot = checkDot(check);
  const installed = !!check?.installed;
  return (
    <div ref={ref} className={"sandbox-provider" + (open ? " is-open" : "") + (check?.ready ? " is-ready" : "")}>
      <div className="sandbox-provider-head">
        <span className="sandbox-provider-logo"><SandboxLogo provider={id} size={22} /></span>
        <span className="sandbox-provider-name">
          <strong>{p.label}</strong>
          <small>{p.blurb}</small>
        </span>
        <Refresh busy={checking} label={`Check ${p.label} again`} onClick={() => void checkProvider(id, true)} />
      </div>
      <div className="sandbox-provider-status">
        <span className={"sandbox-dot is-" + dot} />
        <span className="sandbox-provider-state">{starting || (checking && !check ? "Checking…" : checkText(p, check))}</span>
        {check && !check.ready && check.installed && !check.stopped && check.detail && !starting && <span className="sandbox-provider-detail" title={check.detail}>{check.detail}</span>}
        {check?.ready && <span className="sandbox-provider-detail">{check.detail}</span>}
      </div>
      <div className="sandbox-provider-caps">
        <span>{p.caps.lidClosed ? "Keeps going with the lid closed" : "Stops when this Mac sleeps"}</span>
        <span>{p.caps.maxHours ? `Up to ${p.caps.maxHours} hours each` : "No time limit"}</span>
        <span>{p.tty ? "Chats and terminal tabs" : "Chats"}</span>
      </div>
      <div className="sandbox-provider-actions">
        {check?.stopped && <button className="btn is-primary" disabled={!!starting} onClick={() => void startProvider(id).catch(toastError)}>{starting ? <LoaderCircle size={13} className="is-spinning" /> : <Play size={13} />}Start {p.label}</button>}
        {!check?.ready && !check?.stopped && <button className="btn" aria-expanded={open} onClick={onToggle}>{open ? "Hide steps" : "Set up…"}</button>}
        {check?.ready && <button className="text-button" aria-expanded={open} onClick={onToggle}>{open ? "Hide" : "How it's set up"}</button>}
      </div>
      {open && (
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
            <strong>{check?.ready ? <Check size={13} /> : "2"} {p.login ? "Sign in" : "Start it"}</strong>
            {p.login ? <CopyLine text={p.login.join(" ")} /> : <span>Open Docker Desktop (or OrbStack). There's nothing to sign in to; Desk can start it for you.</span>}
            <div className="sandbox-step-actions">
              {p.login && projectId && <button className="text-button" onClick={() => runInTab(p.login!.join(" "))}><SquareTerminal size={12} />Sign in in a terminal tab</button>}
              {p.start && <button className="text-button" onClick={() => void startProvider(id).catch(toastError)}><Play size={12} />Start {p.label}</button>}
              <button className="text-button" onClick={() => void ipc.openExternal(p.signup)}><ExternalLink size={12} />{p.login ? "Create an account" : "Website"}</button>
            </div>
          </li>
          <li className={check?.ready ? "is-done" : ""}>
            <strong>{check?.ready ? <Check size={13} /> : "3"} Check</strong>
            <span className={"sandbox-check" + (check?.ready ? " is-ready" : "")}>{checking ? "Checking…" : check?.detail ?? "Not checked yet."}</span>
            <div className="sandbox-step-actions"><button className="text-button" disabled={checking} onClick={() => void checkProvider(id, true)}><RefreshCw size={12} />Check again</button></div>
          </li>
        </ol>
      )}
    </div>
  );
}

function SandboxRow({ sandbox }: { sandbox: Sandbox }) {
  const state = useSandboxes((s) => s.states[sandbox.id]);
  const waking = useSandboxes((s) => s.progress[`wake:${sandbox.id}`]);
  const [busy, setBusy] = useState(false);
  const shell = shellCommand(sandbox);
  const remove = () => useDesk.getState().setModal({
    kind: "confirm",
    title: `Delete ${sandbox.name}?`,
    body: `Deletes it at ${label(sandbox.provider)}, with its disk: anything not pulled to this Mac is lost, and sign-ins made there.`,
    confirm: "Delete",
    danger: true,
    onConfirm: () => void removeSandbox(sandbox),
  });
  const recheck = async () => { setBusy(true); await refreshStates(sandbox.projectId).finally(() => setBusy(false)); };
  const shown = shownState(state, waking);
  return (
    <div className="sandbox-row">
      <SandboxLogo provider={sandbox.provider} size={16} />
      <span className="sandbox-row-name"><strong>{sandbox.name}</strong><small>{label(sandbox.provider)} · made {new Date(sandbox.createdAt).toLocaleDateString()}</small></span>
      <span className={"sandbox-bar-state is-" + shown.dot}><i />{waking || shown.text}</span>
      <span className="sandbox-row-actions">
        <Refresh busy={busy} label={`Check ${sandbox.name} again`} onClick={() => void recheck()} />
        {state === "running"
          ? <button className="text-button" onClick={() => void stopSandbox(sandbox)}><Square size={11} />Stop</button>
          : <button className="text-button" disabled={!!waking} onClick={() => void wakeSandbox(sandbox).catch(toastError)}><Play size={11} />Start</button>}
        {shell && <button className="text-button" onClick={() => openTerminal(sandbox.projectId, "shell", { command: shell })}><SquareTerminal size={11} />Shell</button>}
        <button className="text-button is-danger" onClick={remove}><Trash2 size={11} />Delete</button>
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
            <button className="text-button" disabled={!value.trim()} onClick={() => void ipc.sandboxSecretSet(key, value).then(() => { setValue(""); setSaved(true); }, toastError)}>Save</button>
          </span>}
    </div>
  );
}

function Switch({ label: name, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: () => void }) {
  return <button className="setting-row" role="switch" aria-checked={checked} onClick={onChange}>
    <span><strong>{name}</strong><small>{description}</small></span><span className={"toggle-track" + (checked ? " is-on" : "")}><span /></span>
  </button>;
}

/** A text area that saves when you leave it. */
function Script({ value, onSave, placeholder, ariaLabel, rows = 4 }: { value: string; onSave: (v: string) => void; placeholder: string; ariaLabel: string; rows?: number }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return <textarea className="sandbox-script" spellCheck={false} rows={rows} aria-label={ariaLabel} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onSave(text)} />;
}

function Startup() {
  const st = useDesk((s) => s.preferences.sandboxStartup) ?? {};
  const setPreferences = useDesk((s) => s.setPreferences);
  const allProjects = useDesk((s) => s.projects);
  const projects = useMemo(() => allProjects.filter((p) => !p.worktreeOf), [allProjects]);
  const active = useDesk((s) => s.activeProjectId);
  const [projectId, setProjectId] = useState(() => { const p = allProjects.find((x) => x.id === active); return p ? (p.worktreeOf ?? p.id) : projects[0]?.id ?? ""; });
  const save = (patch: Partial<SandboxStartup>) => setPreferences({ sandboxStartup: { ...useDesk.getState().preferences.sandboxStartup, ...patch } });
  const env = st.env ?? [];
  const setEnv = (list: { key: string; value: string }[]) => save({ env: list });
  const badKey = (k: string) => !!k && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
  return (
    <>
      <div className="settings-card sandbox-startup">
        <div className="sandbox-field">
          <span><strong>Start script for every project</strong><small>For example installing dependencies. Runs once per sandbox. If it fails you'll see why, and the agent starts anyway.</small></span>
          <Script ariaLabel="Start script for every project" value={st.script ?? ""} placeholder={"# e.g.\nnpm ci\ncp .env.example .env"} onSave={(script) => save({ script })} />
        </div>
        {projects.length > 0 && <div className="sandbox-field">
          <span className="sandbox-field-head"><strong>Start script for</strong>
            <select aria-label="Project for its start script" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </span>
          <small>Runs after the shared one, only for this project.</small>
          {projectId && <Script key={projectId} ariaLabel="Start script for this project" value={st.projectScripts?.[projectId] ?? ""} placeholder={"# e.g.\npnpm install\npnpm db:migrate"} onSave={(v) => save({ projectScripts: { ...st.projectScripts, [projectId]: v } })} />}
        </div>}
      </div>
      <SectionHead title="Environment variables" lead="Every agent, terminal and script in a sandbox gets these. They're saved in plain text in Desk's settings, so no secrets here (tokens go under Sign-in tokens)." />
      <div className="settings-card">
        <div className="sandbox-env">
          {env.map((e, i) => (
            <Fragment key={i}>
              <input className={badKey(e.key) ? "is-bad" : ""} aria-label="Variable name" placeholder="NAME" value={e.key} onChange={(x) => setEnv(env.map((y, j) => (j === i ? { ...y, key: x.target.value.trim() } : y)))} />
              <input aria-label="Value" placeholder="value" value={e.value} onChange={(x) => setEnv(env.map((y, j) => (j === i ? { ...y, value: x.target.value } : y)))} />
              <button className="icon-btn" aria-label={`Remove ${e.key || "variable"}`} onClick={() => setEnv(env.filter((_, j) => j !== i))}><X size={13} /></button>
            </Fragment>
          ))}
        </div>
        <div className="sandbox-env-foot">
          <button className="text-button" onClick={() => setEnv([...env, { key: "", value: "" }])}><Plus size={12} />Add variable</button>
          {!env.length && <small>None yet.</small>}
        </div>
      </div>
      <SectionHead title="Machine size" lead="For new sandboxes. Default is the provider's own size." />
      <div className="settings-card">
        <div className="setting-row">
          <span><strong>CPUs</strong><small>Local Docker: a limit. Docker Cloud: the nearest size (1, 2, 4, 8 or 16).</small></span>
          <select aria-label="CPUs" value={st.cpus ?? 0} onChange={(e) => save({ cpus: Number(e.target.value) || null })}>
            <option value={0}>Default</option>
            {[1, 2, 4, 8, 16].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="setting-row">
          <span><strong>Memory</strong><small>Local Docker only.</small></span>
          <select aria-label="Memory" value={st.memoryGb ?? 0} onChange={(e) => save({ memoryGb: Number(e.target.value) || null })}>
            <option value={0}>Default</option>
            {[2, 4, 8, 16, 32].map((n) => <option key={n} value={n}>{n} GB</option>)}
          </select>
        </div>
        <div className="sandbox-field">
          <span><strong>Extra image lines</strong><small>Dockerfile lines for local Docker sandboxes, run as root on Debian with Node 22. A change builds a new image for the next sandbox you make.</small></span>
          <Script ariaLabel="Extra Dockerfile lines" rows={3} value={st.imageLines ?? ""} placeholder={"RUN apt-get update && apt-get install -y python3 make\nRUN npm install -g pnpm"} onSave={(imageLines) => save({ imageLines })} />
        </div>
      </div>
    </>
  );
}

function SectionHead({ title, lead }: { title: string; lead?: string }) {
  return <div className="sandbox-head"><h3 className="settings-label">{title}</h3>{lead && <p className="section-lead">{lead}</p>}</div>;
}

export function SandboxSettings({ provider: focus }: { provider?: ProviderId }) {
  const prefs = useDesk((s) => s.preferences);
  const setPreferences = useDesk((s) => s.setPreferences);
  const sandboxes = useDesk((s) => s.sandboxes);
  const projects = useDesk((s) => s.projects);
  const allAccounts = useDesk((s) => s.accounts);
  const accounts = useMemo(() => allAccounts.filter((a) => a.kind === "claude" || a.kind === "codex"), [allAccounts]);
  const anyChecking = useSandboxes((s) => Object.values(s.checking).some(Boolean));
  useSandboxes((s) => s.progress);
  const pending = making();
  const [open, setOpen] = useState<ProviderId | null>(focus ?? null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => { void checkAllProviders(true); void refreshStates(); }, []);
  useEffect(() => { if (focus) setOpen(focus); }, [focus]);
  const groups = useMemo(() => {
    const by = new Map<string, Sandbox[]>();
    for (const x of sandboxes) by.set(x.projectId, [...(by.get(x.projectId) ?? []), x]);
    for (const m of pending) if (!by.has(m.projectId)) by.set(m.projectId, []);
    return [...by.entries()];
  }, [sandboxes, pending.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const refreshAll = async () => { setRefreshing(true); await refreshStates().finally(() => setRefreshing(false)); };
  const mode = prefs.sandboxMode ?? "code";
  return (
    <>
      <SectionHead title="How sandboxes work" />
      <div className="settings-card sandbox-modes" role="radiogroup" aria-label="How sandboxes work">
        {(["code", "agent"] as SandboxMode[]).map((m) => (
          <button key={m} className={"sandbox-mode" + (mode === m ? " is-on" : "")} role="radio" aria-checked={mode === m} onClick={() => setPreferences({ sandboxMode: m })}>
            <span className="sandbox-mode-dot" aria-hidden="true" />
            <span>
              <strong>{MODE_TEXT[m].title}{m === "code" && <em>Recommended</em>}</strong>
              <small>{MODE_TEXT[m].body}</small>
            </span>
          </button>
        ))}
      </div>
      <p className="settings-note sandbox-after">Applies to chats and tabs you put in a sandbox from now on. A chat keeps the way it started; Move in its sandbox bar switches it.</p>

      <div className="settings-label sandbox-section-head">
        <span>Providers <span className="section-lead">Where sandboxes run. Set up the ones you want; each chat or tab picks one.</span></span>
        <Refresh busy={anyChecking} label="Check every provider again" onClick={() => void checkAllProviders(true)} />
      </div>
      <div className="sandbox-providers">
        {PROVIDERS.map((p) => <ProviderCard key={p.id} id={p.id} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} />)}
      </div>

      <div className="settings-label sandbox-section-head">
        <span>Your sandboxes <span className="section-count">{sandboxes.length}{pending.length ? ` + ${pending.length} on the way` : ""}</span></span>
        {sandboxes.length > 0 && <Refresh busy={refreshing} label="Check every sandbox again" onClick={() => void refreshAll()} />}
      </div>
      {groups.length ? groups.map(([projectId, list]) => (
        <div className="settings-card sandbox-group" key={projectId}>
          <div className="sandbox-group-head">{projects.find((p) => p.id === projectId)?.name ?? "Removed project"}</div>
          {list.map((x) => <SandboxRow key={x.id} sandbox={x} />)}
          {pending.filter((m) => m.projectId === projectId).map((m) => (
            <div className="sandbox-row is-making" key={m.key}>
              <SandboxLogo provider={m.provider} size={16} />
              <span className="sandbox-row-name"><strong>{m.name}</strong><small>{label(m.provider)} · {m.text}</small></span>
              <span className="sandbox-bar-state is-warn"><LoaderCircle size={11} className="is-spinning" />making</span>
            </div>
          ))}
        </div>
      )) : <p className="settings-note">None yet. Pick one under "Run in" in a chat's message box, or "in a sandbox" from the terminal's new-tab menu.</p>}

      <SectionHead title="When the code arrives" lead="Runs in every sandbox, in the project's folder there, before the agent's first command." />
      <Startup />

      <SectionHead title="Time and cost" lead="Limits that keep a forgotten sandbox from running up your bill." />
      <div className="settings-card">
        <div className="setting-row">
          <span><strong>Unattended for up to</strong><small>The provider stops a run left alone this long. That's your cost ceiling.</small></span>
          <select value={prefs.sandboxHours ?? 8} onChange={(e) => setPreferences({ sandboxHours: Number(e.target.value) })} aria-label="Unattended hours">
            {[1, 2, 4, 8, 12, 24].map((h) => <option key={h} value={h}>{h} hour{h > 1 ? "s" : ""}</option>)}
          </select>
        </div>
        <Switch label="Forward ports automatically" description="When a server starts listening in a sandbox you're using, it opens at localhost on this Mac. Nothing is made public." checked={prefs.forwardPorts !== false} onChange={() => setPreferences({ forwardPorts: prefs.forwardPorts === false })} />
        <Switch label="Stop idle sandboxes" description="After 10 minutes with no agent running, while Desk is open. The disk is kept." checked={prefs.sandboxAutoStop !== false} onChange={() => setPreferences({ sandboxAutoStop: prefs.sandboxAutoStop === false })} />
        <Switch label="Suggest a sandbox for long tasks" description="One line under the message box after ten minutes, once per project." checked={prefs.sandboxHints !== false} onChange={() => setPreferences({ sandboxHints: prefs.sandboxHints === false, sandboxHintOff: [] })} />
      </div>

      <SectionHead title="Sign-in tokens" lead={mode === "code"
        ? `Not needed now: with the agent on this Mac, no token or sign-in goes anywhere. Only for "${MODE_TEXT.agent.title}".`
        : "Optional. An agent in a sandbox can sign in there itself, so Desk never sees a token. If you paste one, it stays in an owner-only file on this Mac and goes to the sandbox on stdin, never in a command line or a log."} />
      <div className={"settings-card" + (mode === "code" ? " is-quiet" : "")}>
        {accounts.map((a) => <TokenRow key={a.id} accountId={a.id} name={`${a.kind === "claude" ? "Claude Code" : "Codex"} · ${a.name}`} kind={a.kind} />)}
      </div>
      <p className="settings-note">Code goes to a sandbox and comes back with git (or as files, with the agent on this Mac). Desk commits and pushes nothing.</p>
    </>
  );
}

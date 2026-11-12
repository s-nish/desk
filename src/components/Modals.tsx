import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SandboxSetup } from "./Sandboxes";
import { ArrowLeftRight, CircleCheck, Download, Eye, EyeOff, KeyRound, Server, X } from "lucide-react";
import { ACCOUNT_COLORS, ACCOUNT_KINDS, ENV_VAR, TOOL_LABEL, TOOL_SHORT, isChatTool, uid, useDesk, type Modal } from "../store";
import { INSTALL, connectionLabel, createAccount, multiAccount, openConnection, parseSsh, refreshIdentities, saveConnection, signInSpec } from "../actions";
import { disposeTerminal, mountTerminal, setTerminalVisible } from "../terminals";
import { errorText, ipc } from "../ipc";
import { Review } from "./Review";
import { WorktreeDialog } from "./Worktrees";
import { CreatePrDialog } from "./GitHub";
import { Settings } from "./Settings";
import type { AccountKind } from "../types";
import { ToolLogo } from "./ToolLogo";

export function ModalLayer() {
  const modal = useDesk((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case "diff":
      return <Shell title="Review changes" wide review><Review root={modal.root} path={modal.path} staged={modal.staged} /></Shell>;
    case "worktree":
      return <WorktreeDialog projectId={modal.projectId} />;
    case "createPr":
      return <CreatePrDialog root={modal.root} branch={modal.branch} base={modal.base} />;
    case "settings":
      return <Shell title="Settings" wide settings><Settings initial={modal.section} /></Shell>;
    case "ssh":
      return <SshEditor id={modal.id} from={modal.from} />;
    case "addAccount":
      return <AddAccount initial={modal.tool} />;
    case "signin":
      return <SignIn accountId={modal.accountId} />;
    case "prompt":
      return <Prompt modal={modal} />;
    case "confirm":
      return <Confirm modal={modal} />;
    case "sandboxSetup":
      return <SandboxSetup id={modal.provider} />;
  }
}

const close = () => useDesk.getState().setModal(null);

export function Shell({ title, children, wide, settings, review, escape = true }: { title: string; children: React.ReactNode; wide?: boolean; settings?: boolean; review?: boolean; escape?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (!dialog.current?.contains(document.activeElement)) dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && escape) { e.preventDefault(); close(); }
      if (e.key !== "Tab") return;
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select, summary, [tabindex="0"], textarea') ?? []).filter((el) => el.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { e.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus(); };
  }, [escape]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => escape && e.target === e.currentTarget && close()}>
      <div ref={dialog} tabIndex={-1} className={"modal" + (wide ? " is-wide" : "") + (settings ? " settings-shell" : "") + (review ? " review-shell" : "")} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={close}>
            <X size={15} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function slug(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function AddAccount({ initial }: { initial: AccountKind }) {
  const accounts = useDesk((s) => s.accounts);
  const [tool, setTool] = useState<AccountKind>(initial);
  const [name, setName] = useState("");
  const [color, setColor] = useState(() => ACCOUNT_COLORS.find((c) => !accounts.some((a) => a.color === c)) ?? ACCOUNT_COLORS[1]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // null while checking; checked in the same login shell terminals use.
  const [installed, setInstalled] = useState<Record<string, boolean | null>>({});
  const multi = multiAccount(tool);
  const taken = !multi && accounts.some((a) => a.kind === tool);
  const s = slug(name);
  const folder = `~/.${tool}-${s || "name"}`;
  const install = INSTALL[tool];
  const has = installed[tool];

  useEffect(() => {
    if (installed[tool] !== undefined) return;
    setInstalled((m) => ({ ...m, [tool]: null }));
    void ipc.toolInstalled(INSTALL[tool].bins).then((ok) => setInstalled((m) => ({ ...m, [tool]: ok }))).catch(() => setInstalled((m) => ({ ...m, [tool]: true })));
  }, [tool]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (taken) return;
    if (multi && !s) return setError("Give the account a name, like Work or Personal.");
    setBusy(true);
    try {
      const account = await createAccount(tool, name || TOOL_SHORT[tool], color);
      useDesk.getState().setModal({ kind: "signin", accountId: account.id });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Shell title="Add account">
      <form className="modal-body" onSubmit={submit}>
        <div className="tool-picker" role="radiogroup" aria-label="Tool">
          {ACCOUNT_KINDS.map((t) => (
            <button type="button" key={t} role="radio" aria-checked={tool === t} aria-label={TOOL_LABEL[t]} className={tool === t ? "is-on" : ""} onClick={() => (setTool(t), setError(""))}>
              <ToolLogo tool={t} size={20} />
              <span>{TOOL_SHORT[t]}</span>
            </button>
          ))}
        </div>
        {taken ? (
          <p className="modal-note">
            {TOOL_LABEL[tool]} keeps one sign-in per Mac, so Desk shows it as a single account, and it's already added. Use its ⋯ menu in Accounts to sign in again.
          </p>
        ) : <>
          <label className="field">
            <span>Name</span>
            <input autoFocus value={name} placeholder={multi ? "Work" : TOOL_SHORT[tool]} onChange={(e) => (setName(e.target.value), setError(""))} />
          </label>
          <div className="field">
            <span>Color</span>
            <div className="swatch-row">
              {ACCOUNT_COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={"swatch" + (c === color ? " is-current" : "")}
                  style={{ background: c }}
                  aria-label={`Color ${c}`}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>
          {has === false && (
            <div className="install-note" role="note">
              <Download size={15} />
              <div>
                <strong>{TOOL_LABEL[tool]} isn't installed on this Mac.</strong>
                <span>Desk will install it from {install.source} when you continue, by running:</span>
                <code>{install.command}</code>
                <span>You'll see the install in the next window, then sign in there.</span>
              </div>
            </div>
          )}
          <p className="modal-note">
            {multi
              ? <>Desk creates <code>{folder}</code> for this account's sign-in and settings ({ENV_VAR[tool]}), then opens {TOOL_LABEL[tool]} there so you can sign in. Your other accounts aren't touched.</>
              : <>{TOOL_LABEL[tool]} keeps one sign-in per Mac, so this account uses its normal sign-in. Desk opens {TOOL_LABEL[tool]} so you can sign in.</>}
            {!isChatTool(tool) && <> It chats in the chat view and runs in terminal tabs. Usage limits are Claude Code and Codex only.</>}
          </p>
        </>}
        {error && <p className="form-error">{error}</p>}
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn is-primary" disabled={busy || taken || has === null}>
            {has === null ? "Checking…" : has === false ? "Install and sign in" : "Create and sign in"}
          </button>
        </footer>
      </form>
    </Shell>
  );
}

function SignIn({ accountId }: { accountId: string }) {
  const account = useDesk((s) => s.accounts.find((a) => a.id === accountId));
  const identity = useDesk((s) => s.identities[accountId]);
  const mount = useRef<HTMLDivElement>(null);
  const key = `signin:${accountId}`;

  useLayoutEffect(() => {
    if (!account || !mount.current) return;
    mountTerminal(key, { spec: () => signInSpec(account) }, mount.current);
    setTerminalVisible(key, true);
    const poll = setInterval(() => void refreshIdentities(), 2000);
    return () => {
      clearInterval(poll);
      disposeTerminal(key);
      void refreshIdentities();
    };
    // The session belongs to this dialog; restarting it on re-render would interrupt sign-in.
  }, [key]);

  if (!account) return null;
  const HOW: Record<AccountKind, string> = {
    github: "gh auth login runs below using this account's folder. Choose GitHub.com and sign in through the browser, then close this window.",
    claude: "Claude Code opens below using this account's folder. Follow its sign-in steps (run /login if it doesn't ask), then close this window.",
    codex: "codex login runs below using this account's folder. Finish in the browser, then close this window.",
    gemini: "Gemini CLI opens below using this account's folder. Pick \"Login with Google\" and finish in the browser, then close this window.",
    cursor: "Cursor Agent's login runs below. Finish in the browser, then close this window.",
    grok: "Grok opens below and signs you in through the browser. Finish there, then close this window.",
    opencode: "opencode auth login runs below. Pick a provider and finish signing in, then close this window.",
  };
  const how = (INSTALL[account.kind] ? "If it isn't installed yet, Desk installs it first. " : "") + HOW[account.kind];

  return (
    <Shell title={`Sign in to ${account.name}`} wide escape={false}>
      <div className="modal-body">
        <div className="signin-status" style={{ "--acct": account.color } as React.CSSProperties}>
          <span className="account-bar" />
          <span>{TOOL_LABEL[account.kind]}</span>
          <code>{identity?.path ?? account.dir ?? `~/.${account.kind}`}</code>
          {identity?.signedIn && (
            <span className="signed-in">
              <CircleCheck size={14} /> {identity.email ?? identity.org ?? "Signed in"}
            </span>
          )}
        </div>
        <p className="modal-note">{how}</p>
        <div className="signin-terminal" ref={mount} />
        <footer className="modal-foot">
          <button className="btn is-primary" onClick={close}>
            Done
          </button>
        </footer>
      </div>
    </Shell>
  );
}

function Prompt({ modal }: { modal: Extract<Modal, { kind: "prompt" }> }) {
  const [value, setValue] = useState(modal.initial);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = input.current!;
    el.focus();
    if (modal.select) el.setSelectionRange(...modal.select);
    else el.select();
  }, [modal]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = await modal.onSubmit(value);
    if (err) setError(err);
    else close();
  };

  return (
    <Shell title={modal.title}>
      <form className="modal-body" onSubmit={submit}>
        <label className="field">
          <span>{modal.label}</span>
          <input ref={input} value={value} onChange={(e) => (setValue(e.target.value), setError(""))} />
        </label>
        {error && <p className="form-error">{error}</p>}
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn is-primary">
            {modal.confirm}
          </button>
        </footer>
      </form>
    </Shell>
  );
}

function Confirm({ modal }: { modal: Extract<Modal, { kind: "confirm" }> }) {
  const run = (fn?: () => void) => {
    close();
    fn?.();
  };
  return (
    <Shell title={modal.title}>
      <div className="modal-body">
        <p className="modal-text" style={{ whiteSpace: "pre-line" }}>{modal.body}</p>
        <footer className="modal-foot">
          {modal.alt && (
            <button className="btn is-left" onClick={() => run(modal.onAlt)}>
              {modal.alt}
            </button>
          )}
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button autoFocus className={"btn " + (modal.danger ? "is-danger" : "is-primary")} onClick={() => run(modal.onConfirm)}>
            {modal.confirm}
          </button>
        </footer>
      </div>
    </Shell>
  );
}

function SshEditor({ id, from }: { id: string | null; from?: "settings" }) {
  const back = () => useDesk.getState().setModal(from === "settings" ? { kind: "settings", section: "ssh" } : null);
  const existing = useDesk((s) => s.connections.find((c) => c.id === id));
  const projects = useDesk((s) => s.projects);
  const [name, setName] = useState(existing?.name ?? "");
  const [command, setCommand] = useState(existing?.command ?? "");
  const [projectId, setProjectId] = useState(existing?.projectId ?? "");
  // The password stays in this dialog only and is dropped once saved.
  const [password, setPassword] = useState("");
  const [changing, setChanging] = useState(!existing?.password);
  const [forget, setForget] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const summary = parseSsh(command);
  const fallbackName = command.trim() ? connectionLabel({ command }) : "";

  const submit = async (e: React.FormEvent | React.MouseEvent, andConnect = true) => {
    e.preventDefault();
    if (!command.trim()) return setError("Enter the command to run, for example ssh user@host.");
    setBusy(true);
    try {
      const connection = { id: existing?.id ?? uid(), name: name.trim() || fallbackName, command: command.trim(), password: existing?.password ?? false, projectId: projectId || null };
      await saveConnection(connection, forget ? null : changing && password ? password : undefined);
      setPassword("");
      if (andConnect) {
        close();
        openConnection(connection.id);
      } else back();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Shell title={existing ? "Edit connection" : "New connection"}>
      <form className="modal-body ssh-editor" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span>Command</span>
          <textarea
            className="ssh-command"
            autoFocus={!existing}
            rows={2}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={command}
            placeholder="ssh -N -L 5901:127.0.0.1:5900 user@203.0.113.10"
            onChange={(e) => (setCommand(e.target.value), setError(""))}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
          />
        </label>
        {summary.host && (
          <div className="ssh-summary" aria-label="What this command connects to">
            <span><Server size={12} />{summary.user ? `${summary.user}@` : ""}{summary.host}{summary.port ? `:${summary.port}` : ""}</span>
            {summary.jump && <span>via {summary.jump}</span>}
            {summary.forwards.map((f) => <span key={f}><ArrowLeftRight size={12} />{f}</span>)}
          </div>
        )}
        <label className="field">
          <span>Name</span>
          <input value={name} placeholder={fallbackName || "Office tunnel"} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span>Password <em>optional</em></span>
          {changing && !forget ? (
            <div className="password-input">
              <KeyRound size={14} />
              <input
                type={reveal ? "text" : "password"}
                autoComplete="off"
                autoFocus={!!existing && existing.password}
                value={password}
                placeholder={existing?.password ? "New password" : "Typed for you when ssh asks"}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button type="button" className="icon-btn" aria-label={reveal ? "Hide password" : "Show password"} onClick={() => setReveal(!reveal)}>
                {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          ) : (
            <div className="password-saved">
              <KeyRound size={14} />
              <span>{forget ? "Will be removed when you save" : "Saved on this Mac"}</span>
              {!forget && <button type="button" className="mini-btn" onClick={() => setChanging(true)}>Change</button>}
              <button type="button" className="mini-btn" onClick={() => setForget(!forget)}>{forget ? "Keep" : "Remove"}</button>
            </div>
          )}
        </div>
        <label className="field">
          <span>Open in</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Selected project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <p className="modal-note">
          Desk types the password once, when ssh asks for it. Other questions, like trusting a new host, stay in the terminal. The password is kept in
          Desk's folder on this Mac, readable only by your user. It isn't encrypted.
        </p>
        {error && <p className="form-error">{error}</p>}
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={back}>Cancel</button>
          <button type="button" className="btn" disabled={busy} onClick={(e) => void submit(e, false)}>Save</button>
          <button type="submit" className="btn is-primary" disabled={busy}>Save and connect</button>
        </footer>
      </form>
    </Shell>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CircleCheck, X } from "lucide-react";
import { ACCOUNT_COLORS, TOOL_LABEL, useDesk, type Modal } from "../store";
import { createAccount, refreshIdentities, signInSpec } from "../actions";
import { disposeTerminal, mountTerminal, setTerminalVisible } from "../terminals";
import { errorText } from "../ipc";
import { DiffView } from "./ProjectTools";
import { Settings } from "./Settings";
import type { Tool } from "../types";

export function ModalLayer() {
  const modal = useDesk((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case "diff":
      return <Shell title="Review changes" wide><DiffView root={modal.root} path={modal.path} staged={modal.staged} /></Shell>;
    case "settings":
      return <Shell title="Settings" wide settings><Settings /></Shell>;
    case "addAccount":
      return <AddAccount initial={modal.tool} />;
    case "signin":
      return <SignIn accountId={modal.accountId} />;
    case "prompt":
      return <Prompt modal={modal} />;
    case "confirm":
      return <Confirm modal={modal} />;
  }
}

const close = () => useDesk.getState().setModal(null);

function Shell({ title, children, wide, settings, escape = true }: { title: string; children: React.ReactNode; wide?: boolean; settings?: boolean; escape?: boolean }) {
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
      <div ref={dialog} tabIndex={-1} className={"modal" + (wide ? " is-wide" : "") + (settings ? " settings-shell" : "")} role="dialog" aria-modal="true" aria-label={title}>
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

function AddAccount({ initial }: { initial: Tool }) {
  const accounts = useDesk((s) => s.accounts);
  const [tool, setTool] = useState<Tool>(initial);
  const [name, setName] = useState("");
  const [color, setColor] = useState(() => ACCOUNT_COLORS.find((c) => !accounts.some((a) => a.color === c)) ?? ACCOUNT_COLORS[1]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const s = slug(name);
  const folder = `~/.${tool}-${s || "name"}`;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!s) return setError("Give the account a name, like Work or Personal.");
    setBusy(true);
    try {
      const account = await createAccount(tool, name, color);
      useDesk.getState().setModal({ kind: "signin", accountId: account.id });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Shell title="Add account">
      <form className="modal-body" onSubmit={submit}>
        <div className="segmented" role="radiogroup" aria-label="Tool">
          {(["claude", "codex"] as Tool[]).map((t) => (
            <button type="button" key={t} role="radio" aria-checked={tool === t} className={tool === t ? "is-on" : ""} onClick={() => setTool(t)}>
              {TOOL_LABEL[t]}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} placeholder="Work" onChange={(e) => (setName(e.target.value), setError(""))} />
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
        <p className="modal-note">
          Desk creates <code>{folder}</code> for this account's sign-in and settings, then opens {TOOL_LABEL[tool]} there so you can sign in. Your
          other accounts aren't touched.
        </p>
        {error && <p className="form-error">{error}</p>}
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn is-primary" disabled={busy}>
            Create and sign in
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
  const how =
    account.kind === "claude"
      ? "Claude Code opens below using this account's folder. Follow its sign-in steps (run /login if it doesn't ask), then close this window."
      : "codex login runs below using this account's folder. Finish in the browser, then close this window.";

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
        <p className="modal-text">{modal.body}</p>
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

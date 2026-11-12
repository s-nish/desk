// Settings ▸ Phone: the agent feed on your phone over Tailscale (see remote.rs).

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ExternalLink, QrCode, RefreshCw } from "lucide-react";
import { useDesk } from "../store";
import { errorText, ipc } from "../ipc";

type Status = Awaited<ReturnType<typeof ipc.remoteStatus>>;
type Tailscale = Awaited<ReturnType<typeof ipc.remoteTailscale>>;

/** Starts the local server at launch when the phone remote was left on. */
export function watchRemote() {
  // Back on when Desk opens, once your settings have loaded (before that "remote" reads as off).
  const start = () => { if (useDesk.getState().preferences.remote) void ipc.remoteEnable(true).then(() => ipc.remoteServe(true)).catch(() => {}); };
  let unloaded = () => {};
  if (useDesk.getState().loaded) start();
  else unloaded = useDesk.subscribe((s) => { if (s.loaded) { unloaded(); start(); } });
  // Turned off from the menu bar icon.
  const off = listen("remote-off", () => useDesk.getState().setPreferences({ remote: false }));
  return () => { unloaded(); void off.then((f) => f()); };
}

function ago(secs: number) {
  if (!secs) return "never";
  const m = Math.round((Date.now() / 1000 - secs) / 60);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

export function PhoneSettings() {
  const on = useDesk((s) => !!s.preferences.remote);
  const [status, setStatus] = useState<Status | null>(null);
  const [ts, setTs] = useState<Tailscale | null>(null);
  const [qr, setQr] = useState<{ svg: string; until: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Whether `tailscale serve` is publishing Desk: null while unknown, or the link
  // to turn Serve on for the tailnet when that's what's missing.
  const [serve, setServe] = useState<{ ok: true } | { enable: string } | { error: string } | "checking" | null>(null);
  const desk = useDesk.getState();

  const publish = async () => {
    setServe("checking");
    try {
      await ipc.remoteServe(true);
      setServe({ ok: true });
    } catch (e) {
      const text = errorText(e);
      setServe(text.startsWith("ENABLE ") ? { enable: text.slice(7).trim() } : { error: text });
    }
  };

  const refresh = () => {
    void ipc.remoteStatus().then(setStatus).catch(() => {});
    void ipc.remoteLog().then(setLog).catch(() => {});
  };
  useEffect(() => {
    refresh();
    void ipc.remoteTailscale().then(setTs).catch((e) => setTs({ installed: false, running: false, url: null, detail: errorText(e) }));
    const off = listen("remote-changed", () => { setQr(null); refresh(); });
    return () => { void off.then((f) => f()); };
  }, []);
  // With the remote on, make sure the tailnet address is up (it's quick when it already is).
  useEffect(() => {
    if (on && ts?.running && serve == null) void publish();
  }, [on, ts?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async () => {
    setBusy(true);
    try {
      if (on) {
        await ipc.remoteServe(false).catch(() => {});
        await ipc.remoteEnable(false);
        setQr(null);
        setServe(null);
        desk.setPreferences({ remote: false });
      } else {
        // On first; reaching it from the phone is a separate step that can need Serve turned on.
        await ipc.remoteEnable(true);
        desk.setPreferences({ remote: true });
        if (ts?.running) await publish();
      }
    } catch (e) {
      desk.toast(errorText(e), "error");
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const pair = async () => {
    if (!ts?.url) return;
    try {
      const code = await ipc.remotePair();
      setQr({ svg: await ipc.remoteQr(`${ts.url}/pair?code=${code}`), until: Date.now() + 10 * 60_000 });
    } catch (e) { desk.toast(errorText(e), "error"); }
  };

  return (
    <>
      <div className="settings-card">
        <button className="setting-row" role="switch" aria-checked={on} disabled={busy} onClick={() => void toggle()}>
          <span><strong>Phone remote</strong><small>See your agents on your phone and allow, deny, reply or stop. Only over your own tailnet; off by default.</small></span>
          <span className={"toggle-track" + (on ? " is-on" : "")}><span /></span>
        </button>
        <div className="setting-row">
          <span>
            <strong>Tailscale</strong>
            <small>{ts == null ? "Checking…" : ts.installed ? `${ts.detail}${ts.url ? ` ${ts.url}` : ""}` : "Not installed. Install it on this Mac and your phone, and sign in to both with the same account."}</small>
          </span>
          {ts && !ts.installed && <button className="text-button" onClick={() => void ipc.openExternal("https://tailscale.com/download")}><ExternalLink size={12} />Get Tailscale</button>}
        </div>
        {on && ts?.running && serve && serve !== "checking" && "enable" in serve && (
          <div className="setting-row phone-serve">
            <span>
              <strong>Turn on Tailscale Serve</strong>
              <small>Your tailnet doesn't allow Serve yet. It gives Desk a private https address that only your own devices can open. Turn it on once on Tailscale's page (it also turns on HTTPS certificates), then come back and try again.</small>
            </span>
            <span className="phone-serve-actions">
              <button className="text-button" onClick={() => void ipc.openExternal(serve.enable)}><ExternalLink size={12} />Turn on Serve</button>
              <button className="text-button" onClick={() => void publish()}><RefreshCw size={12} />Try again</button>
            </span>
          </div>
        )}
        {on && ts?.running && serve && serve !== "checking" && "error" in serve && (
          <div className="setting-row phone-serve">
            <span><strong>Couldn't reach the tailnet</strong><small>tailscale serve: {serve.error}</small></span>
            <button className="text-button" onClick={() => void publish()}><RefreshCw size={12} />Try again</button>
          </div>
        )}
        {on && ts?.running && serve === "checking" && (
          <div className="setting-row"><span><strong>Pair a phone</strong><small>Putting Desk on your tailnet…</small></span></div>
        )}
        {on && ts?.url && serve && serve !== "checking" && "ok" in serve && (
          <div className="setting-row phone-pair">
            <span><strong>Pair a phone</strong><small>Scan with the phone's camera. The code works once, for ten minutes. Then use Share ▸ Add to Home Screen for an app icon.</small></span>
            {qr && qr.until > Date.now()
              ? <img className="phone-qr" alt="Pairing code" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}`} />
              : <button className="text-button" onClick={() => void pair()}><QrCode size={13} />Show code</button>}
          </div>
        )}
        {on && ts && ts.installed && !ts.running && (
          <div className="setting-row"><span><strong>Pair a phone</strong><small>Open Tailscale on this Mac and connect, then come back here.</small></span>
            <button className="text-button" onClick={() => void ipc.remoteTailscale().then(setTs)}><RefreshCw size={12} />Check again</button>
          </div>
        )}
      </div>
      {status && !status.page && <p className="settings-note phone-warn">This is a development build (npm run dev:app), which has no phone page to serve. Use npm run build:dev-app to try the phone remote.</p>}
      {(status?.devices.length ?? 0) > 0 && (
        <div className="settings-card">
          {status!.devices.map((d) => (
            <div className="setting-row" key={d.hash}>
              <span><strong>{d.name}</strong><small>{d.login} · paired {ago(d.added)} · last seen {ago(d.lastSeen)}</small></span>
              <button className="text-button is-danger" onClick={() => void ipc.remoteRevoke(d.hash).then(refresh)}>Remove</button>
            </div>
          ))}
        </div>
      )}
      {log.length > 0 && (
        <details className="settings-card phone-log">
          <summary>Recent phone actions</summary>
          <ol>{log.map((l, i) => { const [t, ...rest] = l.split("\t"); return <li key={i}><time>{new Date(Number(t) * 1000).toLocaleString()}</time> {rest.filter(Boolean).join(" · ")}</li>; })}</ol>
        </details>
      )}
      <p className="settings-note">Desk listens on this Mac only (127.0.0.1:{status?.port ?? 47821}); <code>tailscale serve</code> makes it reachable from your own devices, with a real certificate. Each request needs a paired phone and the Tailscale login that paired it. The phone can allow once, deny, reply and stop, never change modes, accounts or settings, and every action is logged here.</p>
    </>
  );
}

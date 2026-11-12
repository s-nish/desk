// Settings ▸ Phone: the agent feed on your phone over Tailscale (see remote.rs).

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ExternalLink, QrCode } from "lucide-react";
import { useDesk } from "../store";
import { errorText, ipc } from "../ipc";

type Status = Awaited<ReturnType<typeof ipc.remoteStatus>>;
type Tailscale = Awaited<ReturnType<typeof ipc.remoteTailscale>>;

/** Starts the local server at launch when the phone remote was left on. */
export function watchRemote() {
  if (useDesk.getState().preferences.remote) void ipc.remoteEnable(true).catch(() => {});
  // Turned off from the menu bar icon.
  const off = listen("remote-off", () => useDesk.getState().setPreferences({ remote: false }));
  return () => { void off.then((f) => f()); };
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
  const desk = useDesk.getState();

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

  const toggle = async () => {
    setBusy(true);
    try {
      if (on) {
        await ipc.remoteServe(false).catch(() => {});
        await ipc.remoteEnable(false);
        setQr(null);
      } else {
        await ipc.remoteEnable(true);
        if (ts?.running) await ipc.remoteServe(true);
      }
      desk.setPreferences({ remote: !on });
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
        {on && ts?.url && (
          <div className="setting-row phone-pair">
            <span><strong>Pair a phone</strong><small>Scan with the phone's camera. The code works once, for ten minutes. Then use Share ▸ Add to Home Screen for an app icon.</small></span>
            {qr && qr.until > Date.now()
              ? <img className="phone-qr" alt="Pairing code" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}`} />
              : <button className="text-button" onClick={() => void pair()}><QrCode size={13} />Show code</button>}
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

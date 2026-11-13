// Port forwarding: a server running in a sandbox (a dev server an agent started,
// or `desk-sandbox serve`) opens on this Mac at http://localhost:<port>.
//
// While a chat or terminal tab uses a running sandbox, Desk looks at which ports
// listen there every few seconds and forwards new ones to the same port here, or
// the next free one. Each connection goes through the provider's own exec command
// (see ports.rs); nothing is made public.

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useDesk } from "../store";
import { useChats } from "../chat";
import { provider, run, useSandboxes } from "./index";
import type { Sandbox } from "./types";
import { PORTS_SCRIPT, autoForwardable, localCandidates, parseListening, relayScript } from "./portsCore";

const EVERY_MS = 10_000;

export { PORTS_SCRIPT, parseListening, relayScript };

export interface Forward {
  sandboxId: string;
  /** The port in the sandbox. */
  remote: number;
  /** Where it is on this Mac. */
  local: number;
}

interface PortStore {
  /** By `${sandboxId}:${remote}`. */
  forwards: Record<string, Forward>;
  /** Listening in each sandbox, last time Desk looked. */
  seen: Record<string, number[]>;
}

export const usePorts = create<PortStore>(() => ({ forwards: {}, seen: {} }));

const keyOf = (sandboxId: string, remote: number) => `${sandboxId}:${remote}`;
/** Ports you stopped: not forwarded again by themselves until they close and open again. */
const dismissed = new Set<string>();

export const forwardsOf = (sandboxId: string) =>
  Object.values(usePorts.getState().forwards).filter((f) => f.sandboxId === sandboxId).sort((a, b) => a.remote - b.remote);

export const localUrl = (f: Forward) => `http://localhost:${f.local}`;

/** `auto`: Desk started it, not you, so it only takes a dev-server port here (or one the system picks). */
export async function forward(sandbox: Sandbox, remote: number, auto = false): Promise<Forward> {
  const p = provider(sandbox.provider);
  if (!p) throw new Error("That sandbox's provider isn't available.");
  const script = relayScript(remote);
  const args = await (p.pipe ?? p.exec).call(p, sandbox.remoteId, script);
  const key = keyOf(sandbox.id, remote);
  const local = await invoke<number>("port_forward_start", { key, args, ports: localCandidates(remote, auto) });
  const f: Forward = { sandboxId: sandbox.id, remote, local };
  dismissed.delete(key);
  usePorts.setState((s) => ({ forwards: { ...s.forwards, [key]: f } }));
  return f;
}

export function unforward(f: Pick<Forward, "sandboxId" | "remote">, byYou = false) {
  const key = keyOf(f.sandboxId, f.remote);
  if (byYou) dismissed.add(key);
  void invoke("port_forward_stop", { key }).catch(() => {});
  usePorts.setState((s) => {
    const forwards = { ...s.forwards };
    delete forwards[key];
    return { forwards };
  });
}

/** Sandboxes a chat or terminal tab is using right now. */
function inUse(): Set<string> {
  const ids = new Set<string>();
  for (const c of Object.values(useChats.getState().chats)) if (c.where) ids.add(c.where);
  for (const t of useDesk.getState().tabs) {
    if (t.type !== "terminal" || t.status !== "running") continue;
    if (t.sandboxId) ids.add(t.sandboxId);
    if (t.codeSandbox) ids.add(t.codeSandbox);
  }
  return ids;
}

const looking = new Set<string>();

/** Looks at one sandbox's ports and forwards or drops to match. */
export async function scan(sandbox: Sandbox, auto = useDesk.getState().preferences.forwardPorts !== false) {
  const p = provider(sandbox.provider);
  if (!p || looking.has(sandbox.id)) return;
  looking.add(sandbox.id);
  try {
    const out = await run(await p.exec(sandbox.remoteId, PORTS_SCRIPT), { timeoutSecs: 60 });
    if (out.code !== 0 && !out.stdout) return;
    const now = parseListening(out.stdout);
    const before = usePorts.getState().seen[sandbox.id];
    usePorts.setState((s) => ({ seen: { ...s.seen, [sandbox.id]: now } }));
    const open = new Set(now);
    for (const f of forwardsOf(sandbox.id)) if (!open.has(f.remote)) unforward(f);
    for (const key of [...dismissed]) {
      const [id, port] = [key.slice(0, key.lastIndexOf(":")), Number(key.slice(key.lastIndexOf(":") + 1))];
      if (id === sandbox.id && !open.has(port)) dismissed.delete(key);
    }
    if (!auto) return;
    // Ports already open the first time Desk looks are forwarded quietly.
    const quiet = before === undefined;
    for (const port of now) {
      const key = keyOf(sandbox.id, port);
      if (usePorts.getState().forwards[key] || dismissed.has(key) || !autoForwardable(port)) continue;
      try {
        const f = await forward(sandbox, port, true);
        if (!quiet) announce(f);
      } catch (e) {
        useDesk.getState().toast(`Couldn't forward port ${port}: ${e instanceof Error ? e.message : String(e)}`, "error");
        dismissed.add(key);
      }
    }
  } catch {
    // The sandbox may be starting or stopping; the next look tries again.
  } finally {
    looking.delete(sandbox.id);
  }
}

function announce(f: Forward) {
  const text = f.local === f.remote ? `Port ${f.remote} → localhost:${f.local}` : `Port ${f.remote} → localhost:${f.local} (${f.remote} was taken here)`;
  useDesk.getState().toast(text, "info", { label: "Open", run: () => void import("../components/Browser").then((m) => m.openBrowser(localUrl(f))) });
}

/** Keeps forwards in step with the sandboxes in use. Returns a function that stops it. */
export function watchPorts() {
  const tick = () => {
    const desk = useDesk.getState();
    const states = useSandboxes.getState().states;
    const used = inUse();
    for (const sandbox of desk.sandboxes) {
      const state = states[sandbox.id];
      if (state === "stopped" || state === "missing" || state === "stopping") {
        for (const f of forwardsOf(sandbox.id)) unforward(f);
      } else if (state === "running" && used.has(sandbox.id)) void scan(sandbox);
    }
    // Forwards to sandboxes Desk no longer has.
    const known = new Set(desk.sandboxes.map((x) => x.id));
    for (const f of Object.values(usePorts.getState().forwards)) if (!known.has(f.sandboxId)) unforward(f);
  };
  const timer = setInterval(tick, EVERY_MS);
  const first = setTimeout(tick, 2_000);
  return () => {
    clearInterval(timer);
    clearTimeout(first);
    for (const f of Object.values(usePorts.getState().forwards)) unforward(f);
  };
}

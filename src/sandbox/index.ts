// Sandboxes in Desk: which providers are set up, making and waking sandboxes,
// stopping idle ones, and opening a shell in one.

import { create } from "zustand";
import { ipc } from "../ipc";
import { useDesk } from "../store";
import { PROVIDERS, provider } from "./providers";
import { forgetSandbox, remoteRuns } from "./transport";
import type { ProviderId, Runner, Sandbox, SandboxState } from "./types";

export { PROVIDERS, provider };
export type { ProviderId, Sandbox };

export const run: Runner = (args, opts = {}) => ipc.sandboxRun(args, opts);

export interface ProviderCheck {
  /** Installed and signed in. */
  ready: boolean;
  /** Its CLI is there, signed in or not. */
  installed: boolean;
  /** The account or version it reported, or why it isn't ready. */
  detail: string;
  checked: number;
}

interface SandboxStore {
  checks: Partial<Record<ProviderId, ProviderCheck>>;
  states: Record<string, SandboxState | "starting" | "stopping">;
  /** What's happening while a sandbox is made or woken, for the composer. */
  progress: Record<string, string>;
  set(patch: Partial<Pick<SandboxStore, "checks" | "states" | "progress">>): void;
}

export const useSandboxes = create<SandboxStore>((set) => ({
  checks: {},
  states: {},
  progress: {},
  set: (patch) => set((s) => ({
    checks: { ...s.checks, ...patch.checks },
    states: { ...s.states, ...patch.states },
    progress: { ...s.progress, ...patch.progress },
  })),
}));

const sb = () => useSandboxes.getState();

/** Asks the provider's CLI whether it's installed and signed in. Cached for a minute. */
export async function checkProvider(id: ProviderId, force = false): Promise<ProviderCheck> {
  const cached = sb().checks[id];
  if (cached && !force && Date.now() - cached.checked < 60_000) return cached;
  const p = provider(id)!;
  let check: ProviderCheck;
  try {
    const out = await run(await p.whoami(), { timeoutSecs: 30 });
    const text = (out.code === 0 ? out.stdout : out.stderr || out.stdout).trim().split("\n").slice(-3).join(" ");
    const missing = out.code === 127 || /command not found|No such file/.test(out.stderr);
    check = {
      ready: out.code === 0,
      installed: !missing,
      detail: out.code === 0 ? summarize(id, out.stdout) : missing ? `${p.label} isn't installed.` : text || "Not signed in.",
      checked: Date.now(),
    };
  } catch (e) {
    check = { ready: false, installed: false, detail: `Couldn't check: ${e instanceof Error ? e.message : String(e)}`, checked: Date.now() };
  }
  sb().set({ checks: { [id]: check } });
  return check;
}

function summarize(id: ProviderId, out: string) {
  const text = out.trim();
  if (id === "boat") {
    try {
      const list = JSON.parse(text);
      const n = Array.isArray(list) ? list.length : Array.isArray(list?.boats) ? list.boats.length : null;
      return n == null ? "Signed in" : `Signed in · ${n} Boat${n === 1 ? "" : "s"}`;
    } catch { return "Signed in"; }
  }
  return text.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 80) || "Ready";
}

export function checkAllProviders(force = false) {
  return Promise.all(PROVIDERS.map((p) => checkProvider(p.id, force)));
}

const hours = () => useDesk.getState().preferences.sandboxHours ?? 8;

function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "project";
}

/** Makes a new sandbox for a project. */
export async function createSandbox(projectId: string, id: ProviderId): Promise<Sandbox> {
  const desk = useDesk.getState();
  const project = desk.projects.find((p) => p.id === projectId);
  if (!project) throw new Error("No such project.");
  const p = provider(id)!;
  const local = `${Date.now().toString(36)}`;
  const name = `${slug(project.name)}-${local.slice(-5)}`;
  const key = `new:${projectId}`;
  sb().set({ progress: { [key]: `Making a ${p.label} sandbox…` } });
  try {
    const remoteId = await p.create(run, name, hours(), (text) => sb().set({ progress: { [key]: text } }));
    const sandbox: Sandbox = { id: `${id}-${local}`, provider: id, remoteId, projectId, name, createdAt: Date.now() };
    useDesk.getState().saveSandbox(sandbox);
    sb().set({ states: { [sandbox.id]: "running" } });
    return sandbox;
  } finally {
    sb().set({ progress: { [key]: "" } });
  }
}

/** Makes sure a sandbox is up: wakes a stopped one, or replaces one that's gone. */
export async function ensureRunning(sandbox: Sandbox, progress: (text: string) => void): Promise<Sandbox> {
  const p = provider(sandbox.provider)!;
  let state = await p.status(run, sandbox.remoteId);
  if (state === "running") {
    sb().set({ states: { [sandbox.id]: "running" } });
    lastUsed.set(sandbox.id, Date.now());
    return sandbox;
  }
  sb().set({ states: { [sandbox.id]: "starting" } });
  if (state === "stopped") {
    progress(`Waking the ${p.label} sandbox…`);
    if (await p.resume(run, sandbox.remoteId)) state = "running";
  }
  if (state !== "running") {
    // Gone (Render and Modal end theirs): a new one in its place, same name.
    progress(`Making a new ${p.label} sandbox…`);
    const remoteId = await p.create(run, sandbox.name, hours(), progress);
    sandbox = { ...sandbox, remoteId };
    useDesk.getState().saveSandbox(sandbox);
    forgetSandbox(sandbox.id);
  }
  await p.keepAlive?.(run, sandbox.remoteId, hours()).catch(() => {});
  sb().set({ states: { [sandbox.id]: "running" } });
  lastUsed.set(sandbox.id, Date.now());
  return sandbox;
}

export async function stopSandbox(sandbox: Sandbox) {
  sb().set({ states: { [sandbox.id]: "stopping" } });
  await provider(sandbox.provider)!.stop(run, sandbox.remoteId).catch(() => {});
  forgetSandbox(sandbox.id);
  sb().set({ states: { [sandbox.id]: "stopped" } });
}

/** Deletes it at the provider and forgets it. Its disk goes too. */
export async function removeSandbox(sandbox: Sandbox) {
  await provider(sandbox.provider)!.remove(run, sandbox.remoteId).catch(() => {});
  forgetSandbox(sandbox.id);
  useDesk.getState().removeSandbox(sandbox.id);
}

export async function refreshStates(projectId?: string) {
  const list = useDesk.getState().sandboxes.filter((x) => !projectId || x.projectId === projectId);
  await Promise.all(list.map(async (x) => {
    const state = await provider(x.provider)!.status(run, x.remoteId).catch(() => "missing" as const);
    sb().set({ states: { [x.id]: state } });
  }));
}

/** A terminal tab with a shell in the sandbox, or null where the provider has none. */
export function shellCommand(sandbox: Sandbox): string | null {
  return provider(sandbox.provider)?.shell?.(sandbox.remoteId) ?? null;
}

// Idle sandboxes stop by themselves (only while Desk is open to notice).

const IDLE_MS = 10 * 60_000;
const lastUsed = new Map<string, number>();

export function watchSandboxes() {
  const tick = setInterval(() => {
    const desk = useDesk.getState();
    if (desk.preferences.sandboxAutoStop === false) return;
    const busy = new Set(remoteRuns().map((r) => r.sandboxId));
    for (const x of desk.sandboxes) {
      if (busy.has(x.id)) { lastUsed.set(x.id, Date.now()); continue; }
      // Render deletes a stopped sandbox; it suspends idle ones by itself.
      if (x.provider === "render") continue;
      const since = lastUsed.get(x.id);
      if (since && Date.now() - since > IDLE_MS && sb().states[x.id] === "running") {
        lastUsed.delete(x.id);
        void stopSandbox(x);
      }
    }
  }, 60_000);
  return () => clearInterval(tick);
}

/** Saved token name for an account's agent in sandboxes. */
export const tokenKey = (accountId: string) => `acct-${accountId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 70)}`;

/** The variable each agent reads a pasted token from. */
export const TOKEN_VAR: Partial<Record<string, string>> = {
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
  codex: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

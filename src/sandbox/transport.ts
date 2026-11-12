// Where an agent process runs. Locally it's chat.rs, as always. In a sandbox the
// agent belongs to desk-run, and Desk only follows its log and sends it lines,
// so closing the lid or losing the network changes nothing for the agent.
//
// Both look the same to chat.ts and acp.ts: a process id, lines in, lines out,
// and one `desk_exit` line at the end.

import { ipc } from "../ipc";
import { provider } from "./providers";
import { q, type Sandbox } from "./types";

export interface SpawnOpts { cwd: string; args: string[]; env: Record<string, string>; unset: string[]; stdin: boolean }

/** Where a sandbox agent runs, and the tokens (if you pasted any) it gets. */
export interface RemoteTarget {
  sandbox: Sandbox;
  /** Folder in the sandbox. */
  cwd: string;
  secrets?: { name: string; key: string }[];
  /** Called with each run's id once it starts, so the chat can save it. */
  onRun?: (runId: string) => void;
  /** Reattach to this run (after a restart) instead of starting a new one. */
  attach?: { runId: string; line: number };
}

interface Remote {
  runId: string;
  target: RemoteTarget;
  /** Lines of out.jsonl already handed on. */
  line: number;
  onLine: (line: string) => void;
  tail: number | null;
  writer: number | null;
  ended: boolean;
  retry: number;
}

const remotes = new Map<number, Remote>();
let nextRemote = -1;
const runnerReady = new Map<string, Promise<void>>();
const homes = new Map<string, Promise<string>>();

const RUNNER = '"$HOME/.desk/bin/desk-run"';

/** The runner's line count for each live sandbox run, for reattaching later. */
export function remoteRuns(): { proc: number; runId: string; sandboxId: string; line: number }[] {
  return [...remotes.entries()].map(([proc, r]) => ({ proc, runId: r.runId, sandboxId: r.target.sandbox.id, line: r.line }));
}

async function run(sandbox: Sandbox, script: string, opts: { stdin?: string; secrets?: RemoteTarget["secrets"]; timeoutSecs?: number } = {}) {
  const p = provider(sandbox.provider);
  if (!p) throw new Error(`Unknown sandbox provider: ${sandbox.provider}`);
  return ipc.sandboxRun(await p.exec(sandbox.remoteId, script), opts);
}

/** Runs a script in the sandbox and returns stdout, or throws with its error. */
export async function sandboxExec(sandbox: Sandbox, script: string, opts: { stdin?: string; timeoutSecs?: number } = {}) {
  const out = await run(sandbox, script, opts);
  if (out.code !== 0) throw new Error((out.stderr || out.stdout).trim().split("\n").slice(-6).join("\n") || `exit ${out.code}`);
  return out.stdout;
}

/** Uploads the runner once per sandbox per launch, so an old copy never lingers. */
function ensureRunner(sandbox: Sandbox) {
  let ready = runnerReady.get(sandbox.id);
  if (!ready) {
    ready = ipc.sandboxResource("desk-run").then((body) => sandboxExec(sandbox,
      'mkdir -p "$HOME/.desk/bin" && cat > "$HOME/.desk/bin/desk-run.tmp" && chmod 700 "$HOME/.desk/bin/desk-run.tmp" && mv "$HOME/.desk/bin/desk-run.tmp" "$HOME/.desk/bin/desk-run"',
      { stdin: body })).then(() => undefined);
    ready.catch(() => runnerReady.delete(sandbox.id));
    runnerReady.set(sandbox.id, ready);
  }
  return ready;
}

/** The sandbox's home folder. */
export function remoteHome(sandbox: Sandbox) {
  let home = homes.get(sandbox.id);
  if (!home) {
    home = sandboxExec(sandbox, 'printf %s "$HOME"').then((h) => h.trim().split("\n").slice(-1)[0] || "/root");
    home.catch(() => homes.delete(sandbox.id));
    homes.set(sandbox.id, home);
  }
  return home;
}

/** Forgets what Desk knows about a sandbox (it was recreated or removed). */
export function forgetSandbox(id: string) {
  runnerReady.delete(id);
  homes.delete(id);
}

/** Account folders on this Mac become folders of the same name under ~/.desk/accounts there. */
export function remoteEnv(env: Record<string, string>, unset: string[], localHome: string, home: string) {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\n\r]/.test(value)) continue;
    const mapped = localHome && value.startsWith(localHome + "/") ? `${home}/.desk/accounts/${value.slice(localHome.length + 1).replace(/^\.+/, "").replace(/\//g, "-")}` : value;
    lines.push(`${key}=${mapped}`);
  }
  for (const key of unset) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) lines.push(`!${key}`);
  return lines.join("\n") + (lines.length ? "\n" : "");
}

let localHomeDir: string | null = null;
async function localHome() {
  if (localHomeDir == null) {
    const { homeDir } = await import("@tauri-apps/api/path");
    localHomeDir = (await homeDir().catch(() => "")).replace(/\/+$/, "");
  }
  return localHomeDir;
}

function newRunId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Starts an agent here or in a sandbox. Returns its process id. */
export async function agentSpawn(opts: SpawnOpts, onLine: (line: string) => void, target?: RemoteTarget | null): Promise<number> {
  if (!target) return ipc.chatSpawn(opts, onLine);
  const { sandbox } = target;
  await ensureRunner(sandbox);
  let runId: string;
  let line = 0;
  if (target.attach) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(target.attach.runId)) throw new Error("Bad run id.");
    runId = target.attach.runId;
    line = target.attach.line;
  } else {
    runId = newRunId();
    const env = remoteEnv(opts.env, opts.unset, await localHome(), await remoteHome(sandbox));
    const cwd = target.cwd.startsWith("~/") ? `"$HOME"/${q(target.cwd.slice(2))}` : q(target.cwd);
    const script = `${RUNNER} start ${runId} ${cwd} ${opts.stdin ? "" : "--no-stdin "}-- ${opts.args.map(q).join(" ")}`;
    const out = await run(sandbox, script, { stdin: env, secrets: target.secrets, timeoutSecs: 120 });
    if (out.code !== 0) throw new Error((out.stderr || out.stdout).trim().split("\n").slice(-6).join("\n") || "Couldn't start the agent in the sandbox.");
  }
  const proc = nextRemote--;
  const remote: Remote = { runId, target, line, onLine, tail: null, writer: null, ended: false, retry: 0 };
  remotes.set(proc, remote);
  target.onRun?.(runId);
  void follow(proc, remote);
  return proc;
}

/** Follows the run's log from the last line seen; reconnects if the link drops. */
async function follow(proc: number, r: Remote) {
  if (r.ended || !remotes.has(proc)) return;
  const p = provider(r.target.sandbox.provider);
  if (!p) return;
  const argv = await p.exec(r.target.sandbox.remoteId, `${RUNNER} tail ${r.runId} ${r.line}`);
  try {
    r.tail = await ipc.chatSpawn({ cwd: "", args: argv, env: {}, unset: [], stdin: false }, (raw) => {
      let record: { type?: string; run?: string } | null = null;
      try { record = JSON.parse(raw); } catch { /* Not ours to read; pass it on. */ }
      if (record?.type === "desk_exit") {
        if (record.run === r.runId) {
          // The agent ended. Hand on the runner's exit line, shaped like chat.rs's.
          r.ended = true;
          remotes.delete(proc);
          if (r.writer != null) void ipc.chatKill(r.writer).catch(() => {});
          r.onLine(raw);
        } else if (!r.ended) {
          // The connection ended, not the agent: pick up again after a pause.
          r.tail = null;
          const wait = Math.min(30_000, 1000 * 2 ** Math.min(r.retry++, 5));
          setTimeout(() => void follow(proc, r), wait);
        }
        return;
      }
      r.line++;
      r.retry = 0;
      r.onLine(raw);
    });
  } catch {
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(r.retry++, 5));
    setTimeout(() => void follow(proc, r), wait);
  }
}

/** Sends one line to the agent. */
export async function agentWrite(proc: number, line: string): Promise<void> {
  const r = remotes.get(proc);
  if (!r) {
    if (proc < 0) throw new Error("this chat has stopped");
    return ipc.chatWrite(proc, line);
  }
  // One long-lived writer per run; a fresh one if the link dropped.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (r.writer == null) {
      const p = provider(r.target.sandbox.provider)!;
      const argv = await p.exec(r.target.sandbox.remoteId, `${RUNNER} send ${r.runId}`);
      const writer = await ipc.chatSpawn({ cwd: "", args: argv, env: {}, unset: [], stdin: true }, (raw) => {
        if (raw.includes('"desk_exit"') && r.writer === writer) r.writer = null;
      });
      r.writer = writer;
    }
    try {
      await ipc.chatWrite(r.writer, line);
      return;
    } catch {
      r.writer = null;
    }
  }
  throw new Error("Couldn't reach the sandbox.");
}

/** Ends the agent. In a sandbox, the runner stops it and everything it started. */
export async function agentKill(proc: number): Promise<void> {
  const r = remotes.get(proc);
  if (!r) {
    if (proc < 0) return;
    return ipc.chatKill(proc);
  }
  await run(r.target.sandbox, `${RUNNER} stop ${r.runId}`, { timeoutSecs: 60 }).catch(() => {});
  // The tail sees the exit and reports it; stop following only if it doesn't.
  setTimeout(() => {
    if (!r.ended) {
      r.ended = true;
      remotes.delete(proc);
      if (r.tail != null) void ipc.chatKill(r.tail).catch(() => {});
      if (r.writer != null) void ipc.chatKill(r.writer).catch(() => {});
      r.onLine(JSON.stringify({ type: "desk_exit", run: r.runId, code: 143, stderr: "" }));
    }
  }, 8000);
}

/** Lets go of a sandbox run without stopping it (Desk is closing, or the chat closed). */
export function agentDetach(proc: number) {
  const r = remotes.get(proc);
  if (!r) return;
  r.ended = true;
  remotes.delete(proc);
  if (r.tail != null) void ipc.chatKill(r.tail).catch(() => {});
  if (r.writer != null) void ipc.chatKill(r.writer).catch(() => {});
}

export const isRemote = (proc: number | null | undefined) => proc != null && remotes.has(proc);

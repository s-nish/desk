// "Agent on this Mac, code in the sandbox". The agent runs here with your own
// sign-in (nothing about it goes anywhere); when it builds, tests or runs
// something it calls `desk-sandbox run '<command>'`, which sends the project's
// changed files to the sandbox, runs the command there and streams the output
// back. The other way, "agent in the sandbox", is src/sandbox/chats.ts.

import { ipc } from "../ipc";
import { useDesk } from "../store";
import { ensureRunning, provider, useSandboxes } from "./index";
import { q, type Sandbox } from "./types";

export type SandboxMode = "code" | "agent";

/** How new sandbox chats work (Settings ▸ Sandboxes). The code-only way unless you chose otherwise. */
export const defaultSandboxMode = (): SandboxMode => useDesk.getState().preferences.sandboxMode ?? "code";

/** A chat's way of using its sandbox; chats from before there was a choice ran the agent there. */
export const chatSandboxMode = (chat: { where?: string | null; sandboxMode?: SandboxMode }): SandboxMode | null =>
  chat.where ? chat.sandboxMode ?? "agent" : null;

export const MODE_TEXT: Record<SandboxMode, { title: string; short: string; body: string }> = {
  code: {
    title: "Agent on this Mac, code runs in the sandbox",
    short: "Agent here, code runs there",
    body: "Claude Code or Codex runs on this Mac with your own sign-in, which never leaves it. When it builds, tests or runs your code, Desk sends the project's changed files to the sandbox, runs the command there and shows the output here. Stops when this Mac sleeps.",
  },
  agent: {
    title: "Agent runs in the sandbox",
    short: "Agent and code run there",
    body: "The agent itself runs in the sandbox, on its own copy of the code (a new branch), so it keeps working when you close Desk, or the lid with a cloud sandbox. It needs a sign-in there: a token you paste, or signing in inside the sandbox.",
  },
};

/** What a code-mode agent is told, on top of its own instructions. */
export function bridgeInstructions(label: string) {
  return [
    `This project's code runs in a sandbox (${label}), not on this Mac.`,
    "Read, search and edit files here as usual, and use git here.",
    "To install dependencies, build, run tests, start servers or run any of the project's own commands, run them through `desk-sandbox run '<command>'` from the project folder.",
    "It sends the project's changed files to the sandbox, runs the command there (in the same folder you're in) and prints its output and exit code.",
    "Don't run those commands on this Mac directly.",
    "For a server that should keep running (a dev server, an API), use `desk-sandbox serve '<command>'` instead: it starts it in the background there and says which port it listens on.",
    "Desk forwards ports that open in the sandbox to this Mac, so the server is at http://localhost:<port> here (Desk shows the address if that port was taken).",
  ].join(" ");
}

// The command every run sends: it reads one line (the real script, in base64) from stdin and runs it,
// so the rest of stdin (the files) reaches it.
const READ_SCRIPT = `IFS= read -r h; eval "$(printf '%s' "$h" | base64 -d)"`;

function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "project";
}

function shortHash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export interface Bridge { env: Record<string, string>; instructions: string; label: string }

/** Sets up desk-sandbox for a sandbox and a project: the environment an agent needs to use it. */
export async function makeBridge(sandbox: Sandbox, project: { id: string; name: string }): Promise<Bridge> {
  const p = provider(sandbox.provider);
  if (!p) throw new Error("That sandbox's provider isn't available.");
  const argv = await p.exec(sandbox.remoteId, READ_SCRIPT);
  const label = `${p.label}, ${sandbox.name}`;
  const conf = [
    `DESK_LABEL=${q(label)}`,
    // A new sandbox in its place (Modal ends its own) starts its copy from scratch.
    `DESK_KEY=${q(`${sandbox.id}:${sandbox.remoteId}`)}`,
    // Expanded there, so it's in the sandbox's home folder.
    `DESK_REMOTE_DIR=${q(`$HOME/desk-code/${slug(project.name)}-${shortHash(project.id)}`)}`,
    `DESK_EXEC=(${argv.map(q).join(" ")})`,
  ].join("\n") + "\n";
  const made = await ipc.sandboxBridge(sandbox.id, conf);
  return { env: { DESK_PATH_PREPEND: made.bin, DESK_SANDBOX_CONF: made.conf }, instructions: bridgeInstructions(label), label };
}

/** Checked recently enough to skip asking the provider again before each message. */
const fresh = new Map<string, number>();

/** Makes sure the sandbox is up (asking the provider at most every two minutes) and sets up the bridge. */
export async function readyBridge(sandbox: Sandbox, project: { id: string; name: string }, progress: (text: string) => void): Promise<Bridge> {
  const recent = (fresh.get(sandbox.id) ?? 0) > Date.now() - 120_000 && useSandboxes.getState().states[sandbox.id] === "running";
  if (!recent) {
    progress("Starting the sandbox…");
    sandbox = await ensureRunning(sandbox, progress);
    fresh.set(sandbox.id, Date.now());
  }
  return makeBridge(sandbox, project);
}

/** Codex in code mode: told about desk-sandbox, and its own sandbox lets desk-sandbox reach the provider. */
export function codexBridgeArgs(bridge: Bridge, mode: string) {
  const state = bridge.env.DESK_SANDBOX_CONF.replace(/\/[^/]*$/, "/state");
  return [
    "-c", `developer_instructions=${JSON.stringify(bridge.instructions)}`,
    ...(mode === "danger-full-access" || mode === "read-only" ? [] : ["-c", "sandbox_workspace_write.network_access=true", "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([state])}`]),
  ];
}

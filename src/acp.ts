// Agent Client Protocol (https://agentclientprotocol.com): JSON-RPC over stdio.
// Gemini CLI, Cursor Agent, Grok and OpenCode all speak it, so one client gives
// each of them a chat: streamed replies, tool calls, approvals, modes and models,
// and past conversations replayed with `session/load`.
//
// This file has no store in it: a connection, and a pure function that folds the
// agent's `session/update` notifications into chat items. chat.ts does the rest.

import { ipc } from "./ipc";
import type { Agent } from "./types";

export type AcpAgent = Exclude<Agent, "claude" | "codex">;
export const ACP_AGENTS: AcpAgent[] = ["gemini", "cursor", "grok", "opencode"];
export const isAcpAgent = (tool: string): tool is AcpAgent => (ACP_AGENTS as string[]).includes(tool);

/** Cursor's CLI is `cursor-agent`; newer installs also call it `agent`. */
const CURSOR_ACP = `if command -v cursor-agent >/dev/null 2>&1; then exec cursor-agent acp; else exec agent acp; fi`;

/** The command that starts each agent as an ACP server on stdio. */
export const ACP_COMMAND: Record<AcpAgent, string[]> = {
  gemini: ["gemini", "--acp"],
  cursor: ["sh", "-c", CURSOR_ACP],
  grok: ["grok", "agent", "stdio"],
  opencode: ["opencode", "acp"],
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** One choice list the agent offers: mode, model or effort ("thought_level"). */
export interface AcpOption {
  /** The config option's id, or `__mode` / `__model` for the older modes/models fields. */
  id: string;
  category: "mode" | "model" | "thought_level" | string;
  name: string;
  current: string;
  choices: { value: string; name: string; description?: string }[];
}

/** The agent's choices from a `session/new` or `session/load` answer, or a config update. */
export function readOptions(result: Json | undefined): AcpOption[] {
  if (!result) return [];
  const out: AcpOption[] = [];
  for (const o of Array.isArray(result.configOptions) ? result.configOptions : []) {
    if (o?.type && o.type !== "select") continue;
    const choices = (Array.isArray(o?.options) ? o.options : []).flatMap((c: Json) =>
      // Grouped options carry their own list.
      Array.isArray(c?.options) ? c.options : [c],
    ).filter((c: Json) => typeof c?.value === "string").map((c: Json) => ({ value: c.value, name: String(c.name ?? c.value), ...(c.description ? { description: String(c.description) } : {}) }));
    if (typeof o?.id !== "string" || !choices.length) continue;
    out.push({ id: o.id, category: String(o.category ?? o.id), name: String(o.name ?? o.id), current: String(o.currentValue ?? ""), choices });
  }
  const has = (category: string) => out.some((o) => o.category === category);
  const modes = result.modes;
  if (!has("mode") && Array.isArray(modes?.availableModes) && modes.availableModes.length) {
    out.push({ id: "__mode", category: "mode", name: "Mode", current: String(modes.currentModeId ?? ""), choices: modes.availableModes.map((m: Json) => ({ value: String(m.id), name: String(m.name ?? m.id), ...(m.description ? { description: String(m.description) } : {}) })) });
  }
  const models = result.models;
  if (!has("model") && Array.isArray(models?.availableModels) && models.availableModels.length) {
    out.push({ id: "__model", category: "model", name: "Model", current: String(models.currentModelId ?? ""), choices: models.availableModels.map((m: Json) => ({ value: String(m.modelId), name: String(m.name ?? m.modelId), ...(m.description ? { description: String(m.description) } : {}) })) });
  }
  return out;
}

/** The request that changes one option. */
export function optionRequest(option: AcpOption, sessionId: string, value: string): [string, Json] {
  if (option.id === "__mode") return ["session/set_mode", { sessionId, modeId: value }];
  if (option.id === "__model") return ["session/set_model", { sessionId, modelId: value }];
  return ["session/set_config_option", { sessionId, configId: option.id, value }];
}

// Items

export type AcpItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming?: boolean }
  | { kind: "tool"; id: string; name: string; summary: string; output?: string; state: "running" | "done" | "error" }
  | { kind: "notice"; id: string; text: string; tone?: "error" };

/** Where a stream of updates is: which reply segment text joins, and whether it is history. */
export interface Fold { turn: string; segment: number; last: "text" | "user" | "tool" | null; replay: boolean; n: number }
export const newFold = (turn: string, replay = false): Fold => ({ turn, segment: 0, last: null, replay, n: 0 });

const oneLine = (text: string, max = 200) => {
  const line = text.trim().split(/\s+/).join(" ");
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
};

const contentText = (content: unknown): string => {
  if (!content || typeof content !== "object") return "";
  const c = content as Json;
  if (c.type === "text") return String(c.text ?? "");
  if (c.type === "resource_link") return String(c.uri ?? c.name ?? "");
  if (c.type === "resource") return String(c.resource?.text ?? c.resource?.uri ?? "");
  if (c.type === "image") return "[image]";
  return "";
};

/** Tool output, from its content list: text, or the files a diff touched. */
function toolOutput(content: unknown): string | undefined {
  if (!Array.isArray(content) || !content.length) return undefined;
  const parts = content.map((c: Json) => {
    if (c?.type === "content") return contentText(c.content);
    if (c?.type === "diff") return `${c.path ?? "file"}\n${String(c.newText ?? "").replace(/^\+\+ b\/\S*\n/, "")}`;
    if (c?.type === "terminal") return `[terminal ${c.terminalId ?? ""}]`;
    return "";
  }).filter(Boolean);
  return parts.length ? parts.join("\n\n").slice(0, 6000) : undefined;
}

const KIND_NAME: Record<string, string> = { read: "Read", edit: "Edit", delete: "Delete", move: "Move", search: "Search", execute: "Shell", think: "Think", fetch: "Fetch", switch_mode: "Mode" };

/** "Edit `/a/b.ts`" reads as the path; a bare tool name stays. */
export function describeToolCall(update: Json, cwd: string): { name: string; summary: string } {
  const kind = String(update.kind ?? update._meta?.["x.ai/tool"]?.kind ?? "");
  const name = KIND_NAME[kind] ?? (kind === "write" ? "Edit" : kind ? kind[0].toUpperCase() + kind.slice(1) : "Tool");
  const input: Json = update.rawInput ?? {};
  const pick = input.command ?? input.cmd ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? update.locations?.[0]?.path;
  const raw = typeof pick === "string" ? pick : Array.isArray(pick) ? pick.join(" ") : String(update.title ?? "").replace(/`/g, "");
  const shown = cwd && raw.startsWith(cwd + "/") ? raw.slice(cwd.length + 1) : raw;
  return { name, summary: oneLine(shown) };
}

const STATE: Record<string, "running" | "done" | "error"> = { pending: "running", in_progress: "running", completed: "done", failed: "error" };

/**
 * Folds one `session/update` into the items. Replayed history (from `session/load`)
 * keeps what you typed; live, your message is already on screen.
 */
export function foldUpdate<T extends { id: string; kind: string }>(items: T[], update: Json, fold: Fold, cwd = ""): T[] {
  const put = (item: AcpItem) => {
    const i = items.findIndex((x) => x.id === item.id);
    if (i < 0) return [...items, item as unknown as T];
    const next = items.slice();
    next[i] = { ...items[i], ...item } as unknown as T;
    return next;
  };
  switch (update?.sessionUpdate) {
    case "user_message_chunk": {
      if (!fold.replay) return items;
      const text = contentText(update.content);
      if (fold.last !== "user") { fold.n++; fold.segment = 0; }
      fold.last = "user";
      const id = `u:${fold.turn}:${fold.n}`;
      const existing = items.find((x) => x.id === id) as unknown as AcpItem | undefined;
      return put({ kind: "user", id, text: (existing?.kind === "user" ? existing.text : "") + text });
    }
    case "agent_message_chunk": {
      const text = contentText(update.content);
      if (!text) return items;
      if (fold.last !== "text") fold.segment++;
      fold.last = "text";
      const id = `a:${fold.turn}:${fold.n}:${fold.segment}`;
      const existing = items.find((x) => x.id === id) as unknown as AcpItem | undefined;
      return put({ kind: "assistant", id, text: (existing?.kind === "assistant" ? existing.text : "") + text, streaming: !fold.replay });
    }
    case "tool_call":
    case "tool_call_update": {
      if (typeof update.toolCallId !== "string") return items;
      fold.last = "tool";
      const id = `t:${update.toolCallId}`;
      const existing = items.find((x) => x.id === id) as unknown as AcpItem | undefined;
      const prev = existing?.kind === "tool" ? existing : null;
      const title = describeToolCall(update, cwd);
      const state = STATE[update.status] ?? prev?.state ?? (fold.replay ? "done" : "running");
      const output = toolOutput(update.content) ?? prev?.output;
      return put({
        kind: "tool",
        id,
        // Updates often carry only the status; keep the name and summary from before.
        name: prev && !(update.kind || update._meta?.["x.ai/tool"]?.kind) ? prev.name : title.name,
        summary: title.summary || prev?.summary || "",
        ...(output ? { output } : {}),
        state: fold.replay && state === "running" ? "done" : state,
      });
    }
    case "plan": {
      const entries: Json[] = Array.isArray(update.entries) ? update.entries : [];
      if (!entries.length) return items;
      fold.last = "tool";
      return put({ kind: "tool", id: `p:${fold.turn}:${fold.n}`, name: "Plan", summary: entries.map((e) => `${e.status === "completed" ? "✓" : "·"} ${oneLine(String(e.content ?? ""), 80)}`).join("  "), state: "done" });
    }
    default:
      return items;
  }
}

// Connection

export interface AcpRequest { id: number | string; method: string; params: Json }

/**
 * One agent process. Requests resolve with the agent's answer; requests from the
 * agent (`session/request_permission`) go to `onRequest`, which must answer them.
 */
/** How an agent process is reached: here through chat.rs, or in a sandbox (see sandbox/transport.ts). */
export interface AgentIO {
  spawn(opts: { cwd: string; args: string[]; env: Record<string, string>; unset: string[]; stdin: boolean }, onLine: (line: string) => void): Promise<number>;
  write(proc: number, line: string): Promise<void>;
  kill(proc: number): Promise<void>;
}

const localIO: AgentIO = {
  spawn: (opts, onLine) => ipc.chatSpawn(opts, onLine),
  write: (proc, line) => ipc.chatWrite(proc, line),
  kill: (proc) => ipc.chatKill(proc),
};

export class AcpConnection {
  proc = -1;
  private io: AgentIO = localIO;
  private next = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  private closed = false;

  constructor(
    private onNotify: (method: string, params: Json) => void,
    private onRequest: (req: AcpRequest) => void,
    private onExit: (code: number | null, stderr: string) => void,
  ) {}

  static async start(
    opts: { cwd: string; args: string[]; env: Record<string, string>; unset: string[] },
    handlers: { onNotify: (method: string, params: Json) => void; onRequest: (req: AcpRequest) => void; onExit: (code: number | null, stderr: string) => void },
    io: AgentIO = localIO,
  ) {
    const c = new AcpConnection(handlers.onNotify, handlers.onRequest, handlers.onExit);
    c.io = io;
    c.proc = await io.spawn({ ...opts, stdin: true }, (line) => c.handle(line));
    return c;
  }

  private handle(line: string) {
    let m: Json;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === "desk_exit") {
      this.closed = true;
      const reason = String(m.stderr ?? "").trim().split("\n").slice(-6).join("\n");
      for (const [, p] of this.pending) { if (p.timer) clearTimeout(p.timer); p.reject(new Error(reason || `The agent stopped (exit ${m.code ?? "?"}).`)); }
      this.pending.clear();
      this.onExit(m.code ?? null, reason);
      return;
    }
    if (typeof m.method === "string") {
      if (m.id != null) this.onRequest({ id: m.id, method: m.method, params: m.params ?? {} });
      else this.onNotify(m.method, m.params ?? {});
      return;
    }
    const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
    if (!p) return;
    this.pending.delete(m.id);
    if (p.timer) clearTimeout(p.timer);
    if (m.error) p.reject(Object.assign(new Error(String(m.error.message ?? "The agent returned an error.")), { code: m.error.code, data: m.error.data }));
    else p.resolve(m.result ?? {});
  }

  private write(message: Json) {
    if (this.closed) return Promise.reject(new Error("The agent isn't running."));
    return this.io.write(this.proc, JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  /** Sends a request; `timeout` (ms) only for start-up steps, never for a prompt. */
  request(method: string, params: Json, timeout?: number): Promise<Json> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(new Error(`The agent didn't answer ${method} in ${Math.round(timeout / 1000)} seconds.`)); }, timeout) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params }).catch((e) => { this.pending.delete(id); if (timer) clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); });
    });
  }

  notify(method: string, params: Json) {
    return this.write({ method, params }).catch(() => {});
  }

  respond(id: number | string, result: Json) {
    return this.write({ id, result }).catch(() => {});
  }

  fail(id: number | string, code: number, message: string) {
    return this.write({ id, error: { code, message } }).catch(() => {});
  }

  get alive() { return !this.closed; }

  kill() {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) { if (p.timer) clearTimeout(p.timer); p.reject(new Error("Stopped.")); }
    this.pending.clear();
    void this.io.kill(this.proc);
  }
}

export const ACP_INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "desk", title: "Desk", version: "1.0.0" } };

/** A short, readable reason for a failed start: sign-in problems say what to do. */
export function startError(tool: AcpAgent, label: string, error: unknown): string {
  const e = error as { message?: string; code?: number };
  const message = String(e?.message ?? error).trim();
  if (e?.code === -32000 || /auth|sign.?in|log.?in|credential|api key/i.test(message)) {
    const how = tool === "cursor" ? "cursor-agent login" : tool === "opencode" ? "opencode auth login" : tool === "grok" ? "grok login" : "gemini";
    return `${label} couldn't start: ${message}\n\nSign in by running \`${how}\` in a terminal tab, then send again.`;
  }
  return `${label} couldn't start: ${message}`;
}

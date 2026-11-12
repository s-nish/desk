// MCP servers kept by Desk and handed to every agent when it starts, so you add
// one once instead of in each agent's own config. Desk writes nothing into
// ~/.claude, ~/.codex or any agent folder: Claude Code gets --mcp-config, Codex
// gets -c overrides, ACP agents get session/new's mcpServers.
//
// Keys (an API token for a server) are saved owner-only by the backend. They
// reach the agent as process environment, filled in by the backend from a
// `desk-secret:<key>` placeholder; Claude's config refers to them as ${NAME},
// Codex forwards them with env_vars.

import type { Agent } from "./types";

export interface McpServer {
  id: string;
  /** Letters, digits, - and _: it becomes a config key. */
  name: string;
  kind: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  /** Plain variables, saved with Desk's settings. */
  env: Record<string, string>;
  /** Variables whose values are saved owner-only, never in settings. */
  secrets: string[];
  /** Off for these agents (everything else gets it). */
  off: Agent[];
  /** Every project, or only these. */
  projects: "all" | string[];
  enabled: boolean;
}

export const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The token-store key for one of a server's secret variables. */
export const secretKey = (server: Pick<McpServer, "id">, name: string) => `mcp-${server.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}-${name}`.slice(0, 80);

/** Why a server can't be saved, or null. */
export function problem(s: McpServer, others: McpServer[]): string | null {
  if (!NAME_RE.test(s.name)) return "Use letters, digits, - and _ for the name.";
  if (others.some((o) => o.id !== s.id && o.name === s.name)) return "Another server has that name.";
  if (s.kind === "stdio" && !s.command.trim()) return "Give the command that starts it.";
  if (s.kind === "http" && !/^https?:\/\/\S+$/.test(s.url.trim())) return "Give its http:// or https:// address.";
  const bad = [...Object.keys(s.env), ...s.secrets].find((k) => !VAR_RE.test(k));
  if (bad) return `${bad} isn't a valid variable name.`;
  return null;
}

/** The servers an agent gets in a project. None in untrusted folders. */
export function serversFor(all: McpServer[] | undefined, projectId: string | null, tool: Agent, untrusted: boolean) {
  if (untrusted || !all) return [];
  return all.filter((s) => s.enabled && !s.off.includes(tool) && (s.projects === "all" || (projectId != null && s.projects.includes(projectId))));
}

/** Placeholders for the secret variables; the backend fills them in. */
export function secretEnv(servers: McpServer[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const s of servers) for (const name of s.secrets) env[name] = `desk-secret:${secretKey(s, name)}`;
  return env;
}

/** Claude Code: one --mcp-config with every server. Secrets as ${NAME}. */
export function claudeMcpArgs(servers: McpServer[]): string[] {
  if (!servers.length) return [];
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    const env = { ...s.env, ...Object.fromEntries(s.secrets.map((n) => [n, `\${${n}}`])) };
    mcpServers[s.name] = s.kind === "http"
      ? { type: "http", url: s.url.trim() }
      : { command: s.command.trim(), args: s.args, ...(Object.keys(env).length ? { env } : {}) };
  }
  return ["--mcp-config", JSON.stringify({ mcpServers })];
}

/** A TOML string (JSON's escapes are valid TOML basic-string escapes). */
const toml = (v: string) => JSON.stringify(v);

/** Codex: -c overrides, one per field. Secrets are forwarded from the environment. */
export function codexMcpArgs(servers: McpServer[]): string[] {
  const out: string[] = [];
  for (const s of servers) {
    const key = `mcp_servers.${s.name}`;
    if (s.kind === "http") {
      out.push("-c", `${key}.url=${toml(s.url.trim())}`);
      continue;
    }
    out.push("-c", `${key}.command=${toml(s.command.trim())}`);
    out.push("-c", `${key}.args=[${s.args.map(toml).join(", ")}]`);
    const env = Object.entries(s.env);
    if (env.length) out.push("-c", `${key}.env={ ${env.map(([k, v]) => `${k} = ${toml(v)}`).join(", ")} }`);
    if (s.secrets.length) out.push("-c", `${key}.env_vars=[${s.secrets.map(toml).join(", ")}]`);
  }
  return out;
}

/** ACP session/new's mcpServers. Secret variables are in the agent's own
 *  environment, which the servers it starts inherit. */
export function acpMcpServers(servers: McpServer[]) {
  return servers.map((s) => s.kind === "http"
    ? { type: "http", name: s.name, url: s.url.trim(), headers: [] }
    : { name: s.name, command: s.command.trim(), args: s.args, env: Object.entries(s.env).map(([name, value]) => ({ name, value })) });
}

/** Splits a command line typed in the form into the program and its arguments. */
export function splitCommand(line: string): { command: string; args: string[] } {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let any = false;
  for (const ch of line.trim()) {
    if (quote) { if (ch === quote) quote = null; else word += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (word || any) words.push(word); word = ""; any = false; continue; }
    word += ch;
  }
  if (word || any) words.push(word);
  return { command: words[0] ?? "", args: words.slice(1) };
}

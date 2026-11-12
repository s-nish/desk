// Config once: MCP servers handed to each agent at launch, and AGENTS.md pointers.
import ts from "typescript";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "desk-config-"));
const load = async (name) => {
  const out = ts.transpileModule(readFileSync(join(root, "src", name), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const f = join(dir, name.replace(".ts", ".mjs"));
  writeFileSync(f, out);
  return import(pathToFileURL(f).href);
};
const mcp = await load("mcp.ts");
const rules = await load("agentRules.ts");

const server = (over) => ({ id: "abc-123", name: "github", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], url: "", env: { LOG: "warn" }, secrets: ["GITHUB_TOKEN"], off: [], projects: "all", enabled: true, ...over });
const docs = server({ id: "d", name: "docs", kind: "http", url: "https://mcp.example.com/mcp", env: {}, secrets: [], off: ["codex"], projects: ["p1"] });

try {
  // Who gets what.
  const all = [server(), docs, server({ id: "x", name: "off", enabled: false })];
  assert.deepEqual(mcp.serversFor(all, "p1", "claude", false).map((s) => s.name), ["github", "docs"]);
  assert.deepEqual(mcp.serversFor(all, "p2", "claude", false).map((s) => s.name), ["github"], "per-project server stays in its project");
  assert.deepEqual(mcp.serversFor(all, "p1", "codex", false).map((s) => s.name), ["github"], "switched off for Codex");
  assert.deepEqual(mcp.serversFor(all, "p1", "claude", true), [], "untrusted folders get none");

  // Claude: one --mcp-config, secrets as ${NAME}, never their values.
  const [flag, json] = mcp.claudeMcpArgs([server(), docs]);
  assert.equal(flag, "--mcp-config");
  assert.deepEqual(JSON.parse(json), { mcpServers: {
    github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { LOG: "warn", GITHUB_TOKEN: "${GITHUB_TOKEN}" } },
    docs: { type: "http", url: "https://mcp.example.com/mcp" },
  } });
  assert.deepEqual(mcp.claudeMcpArgs([]), []);

  // Codex: -c overrides, TOML values, secrets forwarded by name.
  assert.deepEqual(mcp.codexMcpArgs([server(), docs]), [
    "-c", 'mcp_servers.github.command="npx"',
    "-c", 'mcp_servers.github.args=["-y", "@modelcontextprotocol/server-github"]',
    "-c", 'mcp_servers.github.env={ LOG = "warn" }',
    "-c", 'mcp_servers.github.env_vars=["GITHUB_TOKEN"]',
    "-c", 'mcp_servers.docs.url="https://mcp.example.com/mcp"',
  ]);
  assert.equal(mcp.codexMcpArgs([server({ args: ['a "quoted" \\ arg'] })])[3], 'mcp_servers.github.args=["a \\"quoted\\" \\\\ arg"]');

  // ACP session/new.
  assert.deepEqual(mcp.acpMcpServers([server(), docs]), [
    { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: [{ name: "LOG", value: "warn" }] },
    { type: "http", name: "docs", url: "https://mcp.example.com/mcp", headers: [] },
  ]);

  // Keys: placeholders the backend fills in.
  assert.deepEqual(mcp.secretEnv([server()]), { GITHUB_TOKEN: "desk-secret:mcp-abc123-GITHUB_TOKEN" });

  // Validation and the command field.
  assert.equal(mcp.problem(server({ name: "bad name" }), []), "Use letters, digits, - and _ for the name.");
  assert.equal(mcp.problem(server({ id: "2" }), [server()]), "Another server has that name.");
  assert.match(mcp.problem(server({ kind: "http", url: "ftp://x" }), []), /http/);
  assert.match(mcp.problem(server({ secrets: ["A-B"] }), []), /A-B/);
  assert.equal(mcp.problem(server(), []), null);
  assert.deepEqual(mcp.splitCommand(`npx -y "@scope/server name" --flag=''`), { command: "npx", args: ["-y", "@scope/server name", "--flag="] });
  assert.deepEqual(mcp.splitCommand(`uvx srv ""`), { command: "uvx", args: ["srv", ""] });

  // Rules: who sees AGENTS.md, and what Link all would do.
  const by = (files) => Object.fromEntries(rules.ruleStatus(files).map((r) => [r.tool, r.sees]));
  assert.deepEqual(by({ "AGENTS.md": null, "CLAUDE.md": "rules", "GEMINI.md": null }), { codex: false, cursor: false, opencode: false, claude: false, gemini: false });
  assert.deepEqual(rules.linkPlan({ "AGENTS.md": null, "CLAUDE.md": "x", "GEMINI.md": null }), [], "nothing to link without AGENTS.md");

  const fresh = { "AGENTS.md": "# Rules\n", "CLAUDE.md": null, "GEMINI.md": null };
  assert.deepEqual(by(fresh), { codex: true, cursor: true, opencode: true, claude: false, gemini: false });
  assert.deepEqual(rules.linkPlan(fresh), [{ file: "CLAUDE.md", action: "create", text: "@AGENTS.md\n" }, { file: "GEMINI.md", action: "create", text: "@./AGENTS.md\n" }]);

  // A file with its own content only ever gets one line appended.
  const own = { "AGENTS.md": "# Rules\n", "CLAUDE.md": "Use pnpm.", "GEMINI.md": "@AGENTS.md\n" };
  const plan = rules.linkPlan(own);
  assert.deepEqual(plan, [{ file: "CLAUDE.md", action: "append", text: "\n\n@AGENTS.md\n" }], "GEMINI.md already points (either form)");
  assert.equal(rules.applyChange(own["CLAUDE.md"], plan[0]), "Use pnpm.\n\n@AGENTS.md\n");
  const linked = { ...own, "CLAUDE.md": rules.applyChange(own["CLAUDE.md"], plan[0]) };
  assert.deepEqual(rules.linkPlan(linked), [], "already linked: nothing to do");
  assert.ok(Object.values(by(linked)).every(Boolean));
  console.log("PASS config: MCP per agent/project/untrusted, Claude/Codex/ACP shapes, secrets as placeholders, validation, AGENTS.md status and Link all");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

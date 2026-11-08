// Folds real ACP traffic (recorded from Cursor Agent, OpenCode and Grok, paths
// replaced) through acp.ts and checks what the chat would show.
import ts from "typescript";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
// acp.ts on its own: its one import (the Tauri bridge) isn't used by what's tested here.
const source = readFileSync(`${root}src/acp.ts`, "utf8").replace(/^import \{ ipc \} from "\.\/ipc";$/m, "const ipc = {};");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const acp = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const fixture = (name) => JSON.parse(readFileSync(`${root}tests/fixtures/acp-${name}.json`, "utf8"));
const cwd = "/tmp/proj";

function fold(entries, replay) {
  const f = acp.newFold(replay ? "h" : "t1", replay);
  let items = [];
  for (const e of entries) if (e.update) items = acp.foldUpdate(items, e.update, f, cwd);
  return items;
}

const failures = [];
const check = (name, fn) => { try { fn(); } catch (e) { failures.push(`${name}: ${e.message}`); } };

for (const agent of ["cursor", "opencode", "grok"]) {
  const live = fold(fixture(agent), false);
  check(`${agent} live`, () => {
    const tools = live.filter((i) => i.kind === "tool");
    assert.equal(tools.length, 1, "one tool call");
    assert.equal(tools[0].name, "Edit");
    assert.equal(tools[0].summary, "hello.txt", "summary is the path inside the project");
    assert.equal(tools[0].state, "done");
    const text = live.filter((i) => i.kind === "assistant").map((i) => i.text).join(" ");
    assert.ok(text.length > 5, "has a reply");
    assert.ok(!live.some((i) => i.kind === "user"), "live: your message isn't drawn twice");
    assert.ok(live.every((i) => i.kind !== "assistant" || i.streaming), "live text is streaming until the turn ends");
  });
  check(`${agent} replay`, () => {
    const history = fold(fixture(`${agent}-load`), true);
    const users = history.filter((i) => i.kind === "user");
    assert.ok(users.length >= 1, "replay shows what you typed");
    assert.match(users[0].text, /hello\.txt/);
    assert.ok(history.some((i) => i.kind === "tool" && i.state === "done"), "replayed tool calls are finished");
    assert.ok(history.every((i) => i.kind !== "assistant" || !i.streaming), "replayed text isn't streaming");
    // Ids must be unique, or React and upsert mix items up.
    assert.equal(new Set(history.map((i) => i.id)).size, history.length);
  });
  check(`${agent} options`, () => {
    const result = fixture(agent).find((e) => e.result)?.result;
    const options = acp.readOptions(result);
    assert.ok(options.find((o) => o.category === "model")?.choices.length > 0, "lists models");
    if (agent === "grok") assert.ok(options.find((o) => o.category === "thought_level")?.choices.some((c) => c.value === "high"), "grok lists efforts");
    if (agent !== "grok") assert.ok(options.find((o) => o.category === "mode")?.choices.length >= 2, "lists modes");
    const model = options.find((o) => o.category === "model");
    const [method, params] = acp.optionRequest(model, "s1", model.choices[0].value);
    assert.ok(method === "session/set_config_option" || method === "session/set_model");
    assert.equal(params.sessionId, "s1");
  });
}

check("grok permission", () => {
  const ask = fixture("grok").find((e) => e.permission)?.permission;
  assert.ok(ask, "grok asked before writing");
  const { name, summary } = acp.describeToolCall(ask.toolCall, cwd);
  assert.equal(name, "Edit");
  assert.equal(summary, "hello.txt");
  assert.ok(ask.options.some((o) => o.kind === "allow_once") && ask.options.some((o) => o.kind === "reject_once"));
});

check("text after a tool call starts a new reply", () => {
  const f = acp.newFold("t", false);
  let items = [];
  for (const u of [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking." } },
    { sessionUpdate: "tool_call", toolCallId: "x", kind: "read", title: "Read", rawInput: { path: "/tmp/proj/a.ts" }, status: "in_progress" },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
  ]) items = acp.foldUpdate(items, u, f, cwd);
  assert.deepEqual(items.map((i) => i.kind), ["assistant", "tool", "assistant"]);
  assert.equal(items[1].summary, "a.ts");
  assert.equal(items[1].state, "running");
});

check("sign-in errors say how to sign in", () => {
  assert.match(acp.startError("cursor", "Cursor Agent", Object.assign(new Error("Authentication required"), { code: -32000 })), /cursor-agent login/);
});

if (failures.length) {
  console.error("FAIL:\n" + failures.map((f) => "  " + f).join("\n"));
  process.exit(1);
}
console.log("PASS: ACP folding (Cursor Agent, OpenCode, Grok: live, replay, options), permission requests, reply segments, sign-in errors.");

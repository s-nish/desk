// The agent feed (src/feedCore.ts): what the tray, notch and phone page show.
import ts from "typescript";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
// feedCore.ts only imports types, which transpiling drops.
const source = readFileSync(`${root}src/feedCore.ts`, "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const feed = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

const chat = (over) => ({
  id: "x", projectId: "p1", tool: "claude", accountId: "a1", title: "Task", items: [], status: "idle", startedAt: null, unread: false, ...over,
});
const tab = (over) => ({
  id: "t", projectId: "p1", type: "terminal", tool: "codex", accountId: null, title: "", status: "running", busy: false, attention: null, ...over,
});
const base = {
  projects: [{ id: "p1", name: "desk" }],
  accounts: [{ id: "a1", color: "#4f7cff" }, { id: "a2", color: "#ff9f5a" }],
  label: (tool) => ({ claude: "Claude Code", codex: "Codex" })[tool] ?? tool,
  tabTitle: (t) => t.title,
};
const build = (chats = [], tabs = []) => feed.buildFeedFrom({ ...base, chats, tabs });

const failures = [];
const check = (name, fn) => { try { fn(); } catch (e) { failures.push(`${name}: ${e.message}`); } };

check("idle read chat is left out", () => assert.equal(build([chat({})]).length, 0));

check("working chat", () => {
  const [item] = build([chat({
    id: "w", status: "running", startedAt: 1000,
    items: [{ kind: "user", id: "u", text: "go" }, { kind: "tool", id: "t1", name: "Bash", summary: "npm test", state: "running" }],
  })]);
  assert.equal(item.id, "c:w");
  assert.equal(item.state, "working");
  assert.equal(item.since, 1000);
  assert.equal(item.activity, "Bash npm test");
  assert.equal(item.accountColor, "#4f7cff");
  assert.equal(item.project, "desk");
  assert.equal(item.approval, null);
  assert.equal(item.canReply, true);
});

check("activity falls back to the end of the answer", () => {
  const long = "word ".repeat(40).trim();
  const [item] = build([chat({ status: "running", items: [{ kind: "user", id: "u", text: "hi" }, { kind: "assistant", id: "a", text: long }] })]);
  assert.ok(item.activity.startsWith("…"));
  assert.equal(item.activity.length, 80);
});

check("a tool from an earlier turn isn't current activity", () => {
  const [item] = build([chat({ status: "running", items: [
    { kind: "tool", id: "old", name: "Bash", summary: "ls", state: "running" },
    { kind: "user", id: "u", text: "next" },
  ] })]);
  assert.equal(item.activity, "");
});

check("pending approval", () => {
  const [item] = build([chat({ status: "running", items: [
    { kind: "approval", id: "r1", tool: "Bash", summary: "rm -rf build", input: {}, state: "pending" },
  ] })]);
  assert.equal(item.state, "waiting");
  assert.deepEqual(item.approval, { requestId: "r1", tool: "Bash", summary: "rm -rf build", plan: false });
});

check("answered approval is not waiting", () => {
  const [item] = build([chat({ status: "running", items: [
    { kind: "approval", id: "r1", tool: "Bash", summary: "x", input: {}, state: "allowed" },
  ] })]);
  assert.equal(item.state, "working");
  assert.equal(item.approval, null);
});

check("plan approval", () => {
  const [item] = build([chat({ status: "running", items: [
    { kind: "approval", id: "p", tool: "ExitPlanMode", summary: "", input: {}, state: "pending" },
  ] })]);
  assert.equal(item.approval.plan, true);
});

check("unread finished chat is done", () => {
  const [item] = build([chat({ unread: true, startedAt: 5 })]);
  assert.equal(item.state, "done");
  assert.equal(item.since, null);
});

check("terminal tabs", () => {
  const items = build([], [
    tab({ id: "busy", busy: true, title: "Fixing tests", accountId: "a2" }),
    tab({ id: "ask", attention: "Needs your permission", runAs: { codex: "a1" } }),
    tab({ id: "idle" }),
    tab({ id: "shell", tool: "shell", busy: true }),
    tab({ id: "ssh", sshId: "s", busy: true }),
    tab({ id: "exited", busy: true, status: "exited" }),
  ]);
  assert.deepEqual(items.map((i) => i.id), ["t:ask", "t:busy"]);
  assert.equal(items[0].title, "Codex", "untitled tab uses the agent's name");
  assert.equal(items[0].activity, "Needs your permission");
  assert.equal(items[0].accountColor, "#4f7cff", "the account it runs as wins");
  assert.equal(items[1].accountColor, "#ff9f5a");
  assert.equal(items[1].canReply, false);
  assert.equal(items[1].approval, null);
});

check("order: waiting, working, done; stable within a group", () => {
  const items = build([
    chat({ id: "d", unread: true }),
    chat({ id: "w1", status: "running" }),
    chat({ id: "q", status: "running", items: [{ kind: "approval", id: "r", tool: "Bash", summary: "", input: {}, state: "pending" }] }),
    chat({ id: "w2", status: "starting" }),
  ], [tab({ id: "tw", busy: true })]);
  assert.deepEqual(items.map((i) => i.id), ["c:q", "c:w1", "c:w2", "t:tw", "c:d"]);
});

check("chatBusy", () => {
  assert.equal(feed.chatBusy(undefined), null);
  assert.equal(feed.chatBusy(chat({})), null);
  assert.equal(feed.chatBusy(chat({ status: "starting" })), "running");
});

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("feed: all checks passed");

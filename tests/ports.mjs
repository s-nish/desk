// Port forwarding's sandbox side (src/sandbox/portsCore.ts): which ports count as
// listening from /proc/net/tcp{,6}, and the relay script each connection runs,
// tried here with sh against a local server (node, then the Python fallback).
import ts from "typescript";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const js = ts.transpileModule(readFileSync(`${root}src/sandbox/portsCore.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const core = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

const tcp = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0
   1: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2 1 0000000000000000 100 0 0 10 0
   2: 0A00000F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3 1 0000000000000000 100 0 0 10 0
   3: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4 1 0000000000000000 100 0 0 10 0
   4: 0100007F:1435 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 5 1 0000000000000000 100 0 0 10 0
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:2328 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 6 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:1F40 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7 1 0000000000000000 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:1389 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 8 1 0000000000000000 100 0 0 10 0
   3: B80D0120000000000000000000000001:1A0A 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 9 1 0000000000000000 100 0 0 10 0
`;
// 5173 any, 3000 loopback, 9000 ::1, 8000 ::, 5001 ::ffff:127.0.0.1. Left out:
// 8080 on one interface only, 22, a connection (not listening), 6666 on one IPv6 address.
assert.deepEqual(core.parseListening(tcp), [3000, 5001, 5173, 8000, 9000]);
assert.deepEqual(core.parseListening(""), []);
assert.ok(core.autoForwardable(5173) && core.autoForwardable(3000) && core.autoForwardable(8080));
assert.ok([80, 5432, 6379, 2375, 9229, 9222, 11434, 1080].every((p) => !core.autoForwardable(p)), "never by itself: privileged, databases, Docker's API, debuggers, model runtimes, proxies");
// Automatic forwards only land on dev-server ports here too, never the next port over into a service's.
assert.deepEqual(core.localCandidates(5180, true), [5180, 5181, 5182, 5183]);
assert.deepEqual(core.localCandidates(5425, true), []);
assert.equal(core.localCandidates(5425, false).length, 10);

const upper = (d) => Buffer.from(d.map((b) => (b >= 0x61 && b <= 0x7a ? b - 32 : b)));
const server = createServer((c) => c.on("data", (d) => c.write(upper(d))).on("end", () => c.end()));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

async function through(script, env, input) {
  const child = spawn("sh", ["-c", script], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const out = [];
  let err = "";
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => (err += d));
  child.stdin.end(input);
  const code = await new Promise((r) => child.on("close", r));
  return { code, out: Buffer.concat(out), err };
}

const input = Buffer.from([0x68, 0x69, 0x00, 0xff, 0x0a, 0x7a]);
const want = Buffer.from([0x48, 0x49, 0x00, 0xff, 0x0a, 0x5a]);
const script = core.relayScript(port);
let r = await through(script, {}, input);
assert.equal(r.code, 0, r.err);
assert.ok(r.out.equals(want), `node relay: ${r.out.toString("hex")}`);

// Without node on the PATH, the Python one.
const noNode = process.env.PATH.split(":").filter((d) => { try { readFileSync(`${d}/node`); return false; } catch { return true; } }).join(":");
r = await through(script, { PATH: noNode }, input);
assert.equal(r.code, 0, r.err);
assert.ok(r.out.equals(want), `python relay: ${r.out.toString("hex")}`);

server.close();
console.log("PASS ports: listening ports from /proc/net/tcp{,6} (any and loopback only, no ssh), relay script byte for byte with node and with python");

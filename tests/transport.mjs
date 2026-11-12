// sandbox/transport.ts end to end on this Mac: the real runner, a fake agent, and a
// "provider" whose exec is plain sh. Covers start, send, a dropped link, and stop.
import ts from 'typescript';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), 'desk-home-'));
const env = { ...process.env, HOME: home };
const agent = `${root}tests/fixtures/fake-agent.mjs`;
const toUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
const compile = (file) => ts.transpileModule(readFileSync(`${root}src/${file}`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;

const procs = new Map();
let next = 1;
globalThis.__ipc = {
  async chatSpawn(opts, onLine) {
    const id = next++;
    const p = spawn(opts.args[0], opts.args.slice(1), { env });
    procs.set(id, p);
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim().startsWith('{')) onLine(line); }
    });
    p.on('close', (code) => { procs.delete(id); onLine(JSON.stringify({ type: 'desk_exit', code, stderr: '' })); });
    return id;
  },
  async chatWrite(id, line) { const p = procs.get(id); if (!p) throw new Error('stopped'); p.stdin.write(line + '\n'); },
  async chatKill(id) { procs.get(id)?.kill(); },
  sandboxRun(args, opts = {}) {
    return new Promise((resolve) => {
      const p = execFile(args[0], args.slice(1), { env }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
      p.stdin.end(opts.stdin ?? '');
    });
  },
  async sandboxResource() { return readFileSync(`${root}src-tauri/resources/desk-run.sh`, 'utf8'); },
};
const types = toUrl(compile('sandbox/types.ts'));
const providers = toUrl(`export const provider = () => ({ id: 'local', exec: async (_id, script) => ['sh', '-c', script] });`);
const ipc = toUrl('export const ipc = globalThis.__ipc;');
const path = toUrl(`export const homeDir = async () => ${JSON.stringify('/Users/someone')};`);
const transport = compile('sandbox/transport.ts')
  .replace('from "../ipc"', `from "${ipc}"`)
  .replace('from "./providers"', `from "${providers}"`)
  .replace('from "./types"', `from "${types}"`)
  .replace('import("@tauri-apps/api/path")', `import("${path}")`);
const t = await import(toUrl(transport));

const sandbox = { id: 'sb1', provider: 'local', remoteId: 'x', projectId: 'p', name: 'test', createdAt: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
try {
  const lines = [];
  let runId = null;
  const proc = await t.agentSpawn(
    { cwd: '', args: ['node', agent], env: { DESK_FAKE: 'yes', CLAUDE_CONFIG_DIR: '/Users/someone/.claude-work' }, unset: ['DESK_GONE'], stdin: true },
    (line) => lines.push(JSON.parse(line)),
    { sandbox, cwd: '~/', onRun: (id) => { runId = id; } },
  );
  assert.ok(proc < 0, 'sandbox procs are negative');
  assert.ok(t.isRemote(proc));
  for (let i = 0; i < 40 && !lines.length; i++) await sleep(100);
  assert.equal(lines[0].type, 'hello');
  assert.equal(lines[0].env, 'yes');
  assert.ok(lines[0].cwd.endsWith(home.replace(/^\/private/, '')), 'runs in the sandbox home');
  // Account folders on this Mac map to the same names under ~/.desk/accounts there.
  assert.equal(t.remoteEnv({ CLAUDE_CONFIG_DIR: '/Users/someone/.claude-work' }, ['X'], '/Users/someone', '/home/desk'), 'CLAUDE_CONFIG_DIR=/home/desk/.desk/accounts/claude-work\n!X\n');

  await t.agentWrite(proc, JSON.stringify({ text: 'one' }));
  for (let i = 0; i < 40 && !lines.some((l) => l.text === 'one'); i++) await sleep(100);
  assert.ok(lines.some((l) => l.type === 'echo' && l.text === 'one'));

  // Drop every connection mid-turn: the agent carries on, Desk catches up, nothing twice.
  await t.agentWrite(proc, JSON.stringify({ text: 'slow' }));
  await sleep(500);
  for (const p of procs.values()) p.kill();
  for (let i = 0; i < 80 && !lines.some((l) => l.text === 'slow'); i++) await sleep(100);
  const steps = lines.filter((l) => l.type === 'step').map((l) => l.i);
  assert.deepEqual(steps, [0, 1, 2, 3], `steps after reconnect: ${JSON.stringify(steps)}`);
  assert.equal(t.remoteRuns()[0].line, lines.length);
  // The writer was dropped too; the next message makes a new one.
  await t.agentWrite(proc, JSON.stringify({ text: 'two' }));
  for (let i = 0; i < 40 && !lines.some((l) => l.text === 'two'); i++) await sleep(100);
  assert.ok(lines.some((l) => l.text === 'two'));

  await t.agentKill(proc);
  for (let i = 0; i < 80 && lines.slice(-1)[0]?.type !== 'desk_exit'; i++) await sleep(100);
  const end = lines.slice(-1)[0];
  assert.equal(end.type, 'desk_exit');
  assert.equal(end.run, runId);
  assert.ok(!t.isRemote(proc));
} catch (e) {
  failures.push(e.stack);
}
for (const p of procs.values()) p.kill();
rmSync(home, { recursive: true, force: true });
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('PASS: transport start in the sandbox home, env and account folders, send, dropped link caught up without loss, new writer, stop.');
process.exit(0);

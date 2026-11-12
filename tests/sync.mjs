// sandbox/sync.ts with real git: a repo on "this Mac", a "sandbox" home in a temp
// folder, bundles both ways, uncommitted changes, pulling twice, and refusals.
import ts from 'typescript';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url).pathname;
const base = mkdtempSync(join(tmpdir(), 'desk-sync-'));
const repo = join(base, 'my app');
const home = join(base, 'sandbox-home');
execFileSync('mkdir', ['-p', repo, home]);
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
g(repo, 'init', '-q', '-b', 'main');
g(repo, 'config', 'user.name', 'Test'); g(repo, 'config', 'user.email', 'test@example.com');
writeFileSync(join(repo, 'a.txt'), 'one\n');
g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'first');

const toUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
const compile = (file) => ts.transpileModule(readFileSync(`${root}src/${file}`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
const run = (args, opts = {}, env = process.env) => new Promise((resolve) => {
  const p = execFile(args[0], args.slice(1), { env, maxBuffer: 64 << 20 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  p.stdin.end(opts.stdin ?? '');
});
globalThis.__ipc = { sandboxRun: (args, opts) => run(args, opts) };
globalThis.__exec = async (_sandbox, script, opts = {}) => {
  const out = await run(['sh', '-c', script], opts, { ...process.env, HOME: home });
  if (out.code !== 0) throw new Error(out.stderr || out.stdout);
  return out.stdout;
};
const types = toUrl(compile('sandbox/types.ts'));
const sync = await import(toUrl(compile('sandbox/sync.ts')
  .replace('from "../ipc"', `from "${toUrl('export const ipc = globalThis.__ipc;')}"`)
  .replace('from "./transport"', `from "${toUrl('export const sandboxExec = globalThis.__exec;')}"`)
  .replace('from "./types"', `from "${types}"`)));

const sandbox = { id: 's', provider: 'docker', remoteId: 'x', projectId: 'p', name: 'n', createdAt: 0 };
const failures = [];
try {
  // Unpushed local work travels with the code.
  writeFileSync(join(repo, 'b.txt'), 'local\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'unpushed');
  const work = await sync.syncIn(sandbox, repo, 'fix-bug', () => {});
  assert.equal(work.branch, 'desk/fix-bug');
  assert.equal(work.base, 'main');
  assert.ok(work.cwd.endsWith('/work/my-app-wt/fix-bug'), work.cwd);
  assert.equal(readFileSync(join(work.cwd, 'b.txt'), 'utf8'), 'local\n');
  assert.equal(g(work.cwd, 'config', 'user.email').trim(), 'test@example.com');

  // The agent commits one thing and leaves another uncommitted, plus a new file.
  writeFileSync(join(work.cwd, 'a.txt'), 'two\n');
  g(work.cwd, 'commit', '-qam', 'agent change');
  writeFileSync(join(work.cwd, 'b.txt'), 'edited in sandbox\n');
  writeFileSync(join(work.cwd, 'new.txt'), 'brand new\n');

  const wtPath = join(base, 'my app-desk-fix-bug');
  const pulled = await sync.pullOut(sandbox, repo, work, async () => wtPath);
  assert.equal(pulled.changes, true);
  assert.equal(readFileSync(join(wtPath, 'a.txt'), 'utf8'), 'two\n', 'committed work arrives as commits');
  assert.equal(g(wtPath, 'log', '-1', '--format=%s').trim(), 'agent change');
  assert.equal(readFileSync(join(wtPath, 'b.txt'), 'utf8'), 'edited in sandbox\n', 'uncommitted edits arrive uncommitted');
  assert.equal(readFileSync(join(wtPath, 'new.txt'), 'utf8'), 'brand new\n', 'new files too');
  assert.match(g(wtPath, 'status', '--porcelain'), /b\.txt/);
  assert.equal(g(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main', 'your checkout is untouched');

  // Pulling again replaces what the last pull applied.
  writeFileSync(join(work.cwd, 'b.txt'), 'edited again\n');
  await sync.pullOut(sandbox, repo, work, async () => wtPath);
  assert.equal(readFileSync(join(wtPath, 'b.txt'), 'utf8'), 'edited again\n');

  // Your own edits in that worktree are never overwritten.
  writeFileSync(join(wtPath, 'a.txt'), 'mine\n');
  await assert.rejects(sync.pullOut(sandbox, repo, work, async () => wtPath), /changes of its own/);
  assert.equal(readFileSync(join(wtPath, 'a.txt'), 'utf8'), 'mine\n');

  // A second chat reuses the clone and gets its own worktree from the latest local code.
  writeFileSync(join(repo, 'c.txt'), 'later\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'later');
  const second = await sync.syncIn(sandbox, repo, 'other', () => {});
  assert.ok(existsSync(join(second.cwd, 'c.txt')));
  assert.ok(!existsSync(join(second.cwd, 'new.txt')));
} catch (e) {
  failures.push(e.stack);
}
rmSync(base, { recursive: true, force: true });
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('PASS: sync in with unpushed commits and identity, pull commits plus uncommitted and new files, pull again, refuse to overwrite your edits, second worktree.');

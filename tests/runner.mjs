// desk-run (src-tauri/resources/desk-run.sh) on this Mac, with a fake agent.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url).pathname;
const runner = `${root}src-tauri/resources/desk-run.sh`;
const agent = `${root}tests/fixtures/fake-agent.mjs`;
const runs = mkdtempSync(join(tmpdir(), 'desk-runs-'));
const env = { ...process.env, DESK_RUNS: runs };
const sh = (args, input = '') => execFileSync('sh', [runner, ...args], { env, input, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Follows a run until desk_exit or `until` matches; returns the JSON lines. */
function follow(run, from, until) {
  return new Promise((resolve, reject) => {
    const p = spawn('sh', [runner, 'tail', run, String(from)], { env });
    const got = [];
    let buf = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error(`tail timed out: ${JSON.stringify(got)}`)); }, 15000);
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        got.push(line);
        if (line.type === 'desk_exit' || until?.(line, got)) { clearTimeout(timer); p.kill(); resolve(got); }
      }
    });
  });
}

const failures = [];
async function check(name, fn) { try { await fn(); } catch (e) { failures.push(`${name}: ${e.stack}`); } }

await check('start, send, reattach, exit', async () => {
  const out = sh(['start', 'r1', tmpdir(), '--', 'node', agent], 'DESK_FAKE=hi there=1\n!DESK_GONE\n');
  assert.deepEqual(JSON.parse(out), { run: 'r1', started: true });
  assert.equal(statSync(join(runs, 'r1')).mode & 0o777, 0o700, 'run folder is owner-only');
  // The env file is read once and removed.
  await sleep(300);
  assert.throws(() => statSync(join(runs, 'r1', 'env')));
  const first = await follow('r1', 0, (l) => l.type === 'hello');
  assert.equal(first[0].env, 'hi there=1');
  assert.equal(first[0].gone, null);
  // Starting again leaves the live run alone.
  assert.equal(JSON.parse(sh(['start', 'r1', tmpdir(), '--', 'node', agent], '')).started, false);
  // A reader drops mid-turn; the agent carries on; a new reader resumes from line 1.
  sh(['send', 'r1'], JSON.stringify({ text: 'slow' }) + '\n');
  const part = await follow('r1', 1, (l) => l.type === 'step' && l.i === 1);
  assert.deepEqual(part.map((l) => l.i), [0, 1]);
  await sleep(1500);
  const rest = await follow('r1', 3, (l) => l.type === 'echo');
  assert.deepEqual(rest.map((l) => l.type), ['step', 'step', 'echo'], 'nothing lost, nothing repeated');
  const status = JSON.parse(sh(['status', 'r1']));
  assert.equal(status.running, true);
  assert.equal(status.lines, 6);
  // Two readers at once see the same lines.
  const [a, b] = await Promise.all([follow('r1', 6, (l) => l.type === 'bye'), follow('r1', 6, (l) => l.type === 'bye'), (async () => { await sleep(500); sh(['send', 'r1'], JSON.stringify({ text: 'bye' }) + '\n'); })()]);
  assert.deepEqual(a, b);
  const end = await follow('r1', 0);
  assert.deepEqual(end.at(-1), { type: 'desk_exit', run: 'r1', code: 0, stderr: '' });
  assert.equal(JSON.parse(sh(['status', 'r1'])).running, false);
  assert.equal(readFileSync(join(runs, 'r1', 'in.jsonl'), 'utf8').trim().split('\n').length, 2);
});

await check('no stdin, exit code, stderr', async () => {
  sh(['start', 'r2', tmpdir(), '--no-stdin', '--', 'node', agent, '--count'], '');
  const lines = await follow('r2', 0);
  assert.equal(lines.filter((l) => l.type === 'tick').length, 5);
  const exit = lines.at(-1);
  assert.equal(exit.code, 3);
  assert.equal(exit.stderr, 'done "counting"');
});

await check('stop', async () => {
  sh(['start', 'r3', tmpdir(), '--', 'node', agent], '');
  await follow('r3', 0, (l) => l.type === 'hello');
  sh(['stop', 'r3']);
  const end = await follow('r3', 1);
  assert.equal(end.at(-1).type, 'desk_exit');
  assert.notEqual(end.at(-1).code, 0);
});

await check('bad run ids are refused', async () => {
  assert.throws(() => sh(['status', '../x']));
  assert.equal(JSON.parse(sh(['status', 'nope'])).exists, false);
  const missing = await follow('nope', 0);
  assert.equal(missing[0].type, 'desk_exit');
});

rmSync(runs, { recursive: true, force: true });
if (failures.length) { console.error(failures.join('\n\n')); process.exit(1); }
console.log('PASS: runner start, env on stdin, reattach without loss, two readers, no-stdin, exit code and stderr, stop, id checks.');

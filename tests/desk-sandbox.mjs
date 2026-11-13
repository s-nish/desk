// desk-sandbox (src-tauri/resources/desk-sandbox) against a fake sandbox: a
// local shell in a temp folder. Checks the first run sends every file, later
// runs send only changes and deletions, ignored files never go, commands run
// in the same subfolder with their exit code, and a lost copy is sent again.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const script = new URL('../src-tauri/resources/desk-sandbox', import.meta.url).pathname;
const base = mkdtempSync(join(tmpdir(), 'desk-sandbox-test-'));
try {
  const proj = join(base, 'proj');
  const remote = join(base, 'remote', 'code');
  mkdirSync(join(proj, 'sub'), { recursive: true });
  mkdirSync(join(proj, 'node_modules'), { recursive: true });
  writeFileSync(join(proj, 'a.txt'), 'a\n');
  writeFileSync(join(proj, 'sub', "b c's.txt"), 'quoted\n');
  writeFileSync(join(proj, '.gitignore'), 'node_modules\n');
  writeFileSync(join(proj, 'node_modules', 'big'), 'x\n');
  const git = (...a) => execFileSync('git', a, { cwd: proj, stdio: 'pipe' });
  git('init', '-q'); git('add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  writeFileSync(join(proj, 'new.txt'), 'new\n');
  const conf = join(base, 'conf');
  writeFileSync(conf, [
    "DESK_LABEL='Fake, test'",
    "DESK_KEY='fake-1'",
    `DESK_REMOTE_DIR='${remote}'`,
    `DESK_SANDBOX_STATE='${join(base, 'state')}'`,
    `DESK_EXEC=( sh -c 'IFS= read -r h; eval "$(printf %s "$h" | base64 -d)"' )`,
  ].join('\n') + '\n');
  const run = (cwd, ...args) => spawnSync('bash', [script, ...args], { cwd, env: { ...process.env, DESK_SANDBOX_CONF: conf }, encoding: 'utf8' });

  let r = run(proj, 'run', 'ls -A | sort');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['.desk-sync', '.gitignore', 'a.txt', 'new.txt', 'sub']);
  assert.equal(readFileSync(join(remote, 'sub', "b c's.txt"), 'utf8'), 'quoted\n');
  assert.ok(!existsSync(join(remote, 'node_modules')), 'ignored files stay home');

  writeFileSync(join(proj, 'a.txt'), 'a2\n');
  unlinkSync(join(proj, 'new.txt'));
  r = run(join(proj, 'sub'), 'run', 'pwd; cat ../a.txt; exit 7');
  assert.equal(r.status, 7, 'exit code comes back');
  assert.match(r.stdout, /remote\/code\/sub\n/, 'same subfolder');
  assert.match(r.stdout, /a2/);
  assert.ok(!existsSync(join(remote, 'new.txt')), 'deletions go too');

  rmSync(remote, { recursive: true });
  r = run(proj, 'npm', '--version');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /sending every file/);
  assert.ok(existsSync(join(remote, 'a.txt')), 'sent again after the copy was lost');

  r = run(proj, 'info');
  assert.match(r.stdout, /Fake, test/);
  r = spawnSync('bash', [script, 'run', 'true'], { cwd: proj, env: { ...process.env, DESK_SANDBOX_CONF: '' }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no sandbox is set up/);
  console.log('PASS desk-sandbox: full then changed-only sends, deletions, ignored files, subfolder and exit code, resend after loss');
} finally {
  rmSync(base, { recursive: true, force: true });
}

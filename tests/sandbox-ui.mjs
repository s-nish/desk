// Sandboxes, with no provider installed and with Docker installed but closed:
// Settings is a full-width page; each provider has a status dot and a refresh;
// setup steps open inline; Docker can be started from there; the chat's
// "Run in" chip opens a radial of logos. Run against npm run dev
// (DESK_TEST_URL, default http://localhost:1420).
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mockDesktop } from './desktop-mock.mjs';

const base = process.env.DESK_TEST_URL || 'http://localhost:1420';
const shot = process.env.DESK_SCREENSHOT;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
await page.addInitScript(mockDesktop);
await page.goto(base);
await page.waitForTimeout(1200);

// Settings is a page across the window, not a modal.
await page.keyboard.press('Meta+Comma');
await page.locator('.settings-page').waitFor();
const box = await page.locator('.settings-page').boundingBox();
assert.ok(box.width >= 1270, `settings spans the window (${box.width})`);
await page.getByRole('button', { name: /Sandboxes/ }).first().click();
await page.getByText('Unattended for up to').waitFor();
// How sandboxes work: the agent here and the code there is the default; the other is one click.
const modes = page.getByRole('radiogroup', { name: 'How sandboxes work' });
assert.equal(await modes.getByRole('radio', { name: /Agent on this Mac, code runs in the sandbox/ }).getAttribute('aria-checked'), 'true');
await modes.getByRole('radio', { name: /Agent runs in the sandbox/ }).click();
assert.equal(await modes.getByRole('radio', { name: /Agent runs in the sandbox/ }).getAttribute('aria-checked'), 'true');
await modes.getByRole('radio', { name: /Agent on this Mac/ }).click();
assert.equal(await modes.getByRole('radio', { name: /Agent on this Mac/ }).getAttribute('aria-checked'), 'true');
for (const name of ['Docker', 'Docker Cloud', 'Boat', 'Modal']) await page.locator('.sandbox-provider-name strong', { hasText: new RegExp(`^${name}$`) }).waitFor();
assert.equal(await page.getByText('Render', { exact: true }).count(), 0, 'Render is gone');
await page.locator('.sandbox-provider').first().getByText('Not installed').waitFor();
assert.equal(await page.locator('.sandbox-provider .sandbox-dot.is-bad').count(), 4, 'four red dots');
assert.equal(await page.getByText(/TypeError/).count(), 0, 'no raw errors');

// Setup steps open inline, nothing ticked.
await page.locator('.sandbox-provider').first().getByRole('button', { name: 'Set up…' }).click();
await page.locator('.sandbox-provider.is-open .sandbox-steps').waitFor();
assert.equal(await page.locator('.sandbox-steps li.is-done').count(), 0, 'nothing ticked when not installed');
await page.getByRole('button', { name: 'Check Docker again' }).click();
await page.getByLabel('Start script for every project').fill('npm ci');
await page.getByLabel('Start script for every project').blur();
await page.getByRole('button', { name: 'Add variable' }).click();
await page.getByLabel('Variable name').fill('NODE_ENV');
await page.getByLabel('Value', { exact: true }).fill('development');
await page.waitForTimeout(1200);
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('test-state'))?.preferences?.sandboxStartup);
assert.equal(saved?.script, 'npm ci');
if (shot) await page.screenshot({ path: shot.replace('.png', '-settings.png') });
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await page.locator('.settings-page').waitFor({ state: 'detached' });

// Docker installed but closed: amber, with Start Docker, which opens it and waits.
await page.evaluate(() => localStorage.setItem('test-sandbox', 'docker'));
await page.reload();
await page.waitForTimeout(1000);
await page.keyboard.press('Meta+Comma');
await page.getByRole('button', { name: /Sandboxes/ }).first().click();
await page.getByText("Docker isn't running").first().waitFor();
assert.equal(await page.locator('.sandbox-provider').first().locator('.sandbox-dot.is-warn').count(), 1, 'amber while closed');
await page.getByRole('button', { name: 'Start Docker' }).first().click();
await page.locator('.sandbox-provider').first().getByText('Ready', { exact: true }).waitFor({ timeout: 10000 });
assert.ok(await page.evaluate(() => window.testCalls.some((c) => c.cmd === 'sandbox_run' && c.args.opts.args.join(' ') === 'open -g -a Docker')), 'opened Docker Desktop');
await page.keyboard.press('Escape');

// The chat's Run in chip: a radial of logos with dots.
await page.getByRole('button', { name: 'Add project folder', exact: true }).last().click();
await page.waitForTimeout(600);
await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('test-state')); s.preferences.uiMode = 'chat'; localStorage.setItem('test-state', JSON.stringify(s)); });
await page.reload();
await page.waitForTimeout(1200);
await page.keyboard.press('Meta+n');
await page.locator('.run-in-chip').click();
await page.locator('.radial.is-shown').waitFor();
await page.getByRole('menuitemradio', { name: /^This Mac/ }).waitFor();
await page.getByRole('menuitemradio', { name: /^New Docker sandbox/ }).waitFor();
// The reload closed the mock's Docker again: amber, and picking it would start it.
await page.waitForTimeout(500);
assert.equal(await page.locator('.radial-item .radial-dot.is-warn').count(), 1, 'Docker amber');
assert.equal(await page.locator('.radial-item .radial-dot.is-bad').count(), 3, 'the rest red');
if (shot) { await page.waitForTimeout(700); await page.screenshot({ path: shot.replace('.png', '-radial.png') }); }
await page.keyboard.press('Escape');

// After the first message the chip stays, on This Mac too, and moves the chat.
await page.waitForTimeout(300);
await page.locator('.chat-composer textarea').fill('hello');
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
assert.equal(await page.locator('.run-in-chip').count(), 1, 'chip after the first message');
assert.ok(await page.evaluate(() => { const c = document.querySelector('.run-in-chip'); return /This Mac/.test(c.textContent) && c.scrollWidth <= c.clientWidth + 1; }), 'This Mac chip, not cut off');
await page.locator('.run-in-chip').click();
await page.locator('.radial.is-shown .radial-hub[aria-label="Move this chat"]').waitFor({ state: 'attached' });
await page.keyboard.press('Escape');

// The composer keeps Send inside the box, even narrow.
await page.setViewportSize({ width: 1000, height: 860 });
await page.waitForTimeout(300);
const fit = await page.evaluate(() => { const c = document.querySelector('.chat-composer').getBoundingClientRect(); const b = document.querySelector('.chat-send').getBoundingClientRect(); return b.right <= c.right + 0.5; });
assert.ok(fit, 'send button inside the composer');
await page.setViewportSize({ width: 1280, height: 860 });
assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.chat-thread') ?? document.body).userSelect), await page.evaluate(() => document.querySelector('.chat-thread') ? 'text' : 'none'), 'chat text selectable');

// Terminal view: every provider can run an agent tab.
await page.getByRole('radio', { name: 'Terminal view' }).click();
await page.getByRole('button', { name: 'More tab types' }).click();
await page.getByRole('menuitem', { name: /Claude Code in a sandbox/ }).click();
await page.locator('.radial.is-shown').waitFor();
await page.getByRole('menuitemradio', { name: /^New Docker sandbox/ }).waitFor();
await page.getByRole('menuitemradio', { name: /^New Docker Cloud sandbox/ }).waitFor();
await page.getByRole('menuitemradio', { name: /^New Boat sandbox/ }).waitFor();
await page.getByRole('menuitemradio', { name: /^New Modal sandbox/ }).waitFor();
assert.equal(await page.getByRole('menuitemradio', { name: /^This Mac/ }).count(), 0, 'already a choice in the menu');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// The tab bar's own sandbox button opens the same radial.
await page.getByRole('button', { name: 'Agent in a sandbox' }).click();
await page.locator('.radial.is-shown').waitFor();
assert.equal(await page.getByRole('menuitemradio', { name: /^New .* sandbox/ }).count(), 4, 'all four providers');
if (shot) { await page.waitForTimeout(700); await page.screenshot({ path: shot.replace('.png', '-terminal.png') }); }
await page.keyboard.press('Escape');

// Ports: a server that opens in the chat's sandbox is forwarded to localhost, with a toast and a menu.
await page.getByRole('radio', { name: 'Chat view' }).click();
await page.waitForTimeout(300);
await page.evaluate(async () => {
  const { useDesk } = await import('/src/store.ts');
  const { useChats } = await import('/src/chat.ts');
  const { useSandboxes } = await import('/src/sandbox/index.ts');
  const desk = useDesk.getState();
  const id = useChats.getState().activeId;
  const sandbox = { id: 'sb1', provider: 'docker', remoteId: 'c0ffee', projectId: useChats.getState().chats[id].projectId, name: 'studio-1', createdAt: Date.now() };
  useDesk.setState({ sandboxes: [...desk.sandboxes, sandbox] });
  useSandboxes.getState().set({ states: { sb1: 'running' } });
  useChats.getState().patch(id, { where: 'sb1', sandboxMode: 'code' });
  window.testSandbox = sandbox;
});
await page.locator('.sandbox-bar').getByRole('button', { name: /^Ports/ }).waitFor();
const tcp = (ports) => '  sl  local_address rem_address   st\n' + ports.map((p, i) => `   ${i}: 00000000:${p.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 1\n`).join('');
// Already open the first time Desk looks: forwarded quietly.
await page.evaluate(async (t) => { window.testListening = t; const m = await import('/src/sandbox/ports.ts'); await m.scan(window.testSandbox); }, tcp([3000]));
await page.locator('.sandbox-bar').getByRole('button', { name: 'Ports · 1' }).waitFor();
// One that opens later: a toast with the address here (5173 was taken, so 5174).
await page.evaluate(async (t) => { window.testListening = t; const m = await import('/src/sandbox/ports.ts'); await m.scan(window.testSandbox); }, tcp([3000, 5173]));
await page.getByText('Port 5173 → localhost:5174 (5173 was taken here)').waitFor();
await page.locator('.sandbox-bar').getByRole('button', { name: 'Ports · 2' }).click();
await page.getByRole('menuitem', { name: /localhost:5174/ }).waitFor();
await page.getByRole('menuitem', { name: /localhost:3000/ }).waitFor();
if (shot) await page.screenshot({ path: shot.replace('.png', '-ports.png') });
// Stopping one keeps it stopped while it stays open there.
await page.getByRole('menuitem', { name: 'Stop forwarding' }).first().click();
await page.locator('.sandbox-bar').getByRole('button', { name: 'Ports · 1' }).waitFor();
await page.evaluate(async () => { const m = await import('/src/sandbox/ports.ts'); await m.scan(window.testSandbox); });
assert.equal(await page.locator('.sandbox-bar').getByRole('button', { name: 'Ports · 1' }).count(), 1, 'a stopped port is not forwarded again by itself');
assert.ok(await page.evaluate(() => window.testCalls.some((c) => c.cmd === 'port_forward_stop' && c.args.key === 'sb1:3000')));
// Its relay runs the provider's exec with the relay script.
const started = await page.evaluate(() => window.testCalls.find((c) => c.cmd === 'port_forward_start' && c.args.ports[0] === 5173).args);
assert.deepEqual(started.args.slice(0, 6), ['docker', 'exec', '-i', 'c0ffee', 'sh', '-lc']);
assert.match(started.args[6], /connect\(5173,/);
// Closed there: the forward goes.
await page.evaluate(async () => { window.testListening = ''; const m = await import('/src/sandbox/ports.ts'); await m.scan(window.testSandbox); });
await page.locator('.sandbox-bar').getByRole('button', { name: 'Ports', exact: true }).waitFor();

assert.deepEqual(errors, []);
await browser.close();
console.log('PASS sandbox-ui: settings page, four providers, dots and refresh, inline setup, startup saved, Start Docker, radial Run in, ports forwarded with a toast, menu, stop, closed');

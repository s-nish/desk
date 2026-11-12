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
page.on('pageerror', (e) => errors.push(e.message));
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

// Terminal view: the new-tab menu offers an agent in a sandbox, with only the
// providers that can run a terminal (Docker and Docker Cloud).
await page.getByRole('radio', { name: 'Terminal view' }).click();
await page.getByRole('button', { name: 'More tab types' }).click();
await page.getByRole('menuitem', { name: /Claude Code in a sandbox/ }).click();
await page.locator('.radial.is-shown').waitFor();
await page.getByRole('menuitemradio', { name: /^New Docker sandbox/ }).waitFor();
await page.getByRole('menuitemradio', { name: /^New Docker Cloud sandbox/ }).waitFor();
assert.equal(await page.getByRole('menuitemradio', { name: /^New (Boat|Modal) sandbox/ }).count(), 0, 'no Boat or Modal for terminal tabs');
assert.equal(await page.getByRole('menuitemradio', { name: /^This Mac/ }).count(), 0, 'already a choice in the menu');
if (shot) { await page.waitForTimeout(700); await page.screenshot({ path: shot.replace('.png', '-terminal.png') }); }
await page.keyboard.press('Escape');

assert.deepEqual(errors, []);
await browser.close();
console.log('PASS sandbox-ui: settings page, four providers, dots and refresh, inline setup, startup saved, Start Docker, radial Run in');

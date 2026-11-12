// One sidebar in both views: a project's terminal agents and chats as the same rows;
// clicking a row opens it in the view it lives in.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mockDesktop } from './desktop-mock.mjs';

const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
await p.addInitScript(mockDesktop);
await p.goto(process.env.DESK_TEST_URL || 'http://localhost:1420');
await p.getByText('Good work starts here.').waitFor();
await p.getByRole('button', { name: 'Add project folder', exact: true }).last().click();
await p.waitForTimeout(600);
await p.keyboard.press('Meta+d'); await p.waitForTimeout(300);
await p.keyboard.press('Meta+e'); await p.waitForTimeout(300);
const project = p.locator('.project').first();
await project.click();
if (!(await p.locator('.agent-row').count())) await project.click();
await p.locator('.agent-row', { hasText: 'Claude Code' }).waitFor();
await p.locator('.agent-row', { hasText: 'Codex' }).waitFor();
if (process.env.DESK_SCREENSHOT) await p.screenshot({ path: process.env.DESK_SCREENSHOT, clip: { x: 0, y: 0, width: 520, height: 400 } });

// Same sidebar in chat view; a terminal row brings you back to the terminal view.
await p.getByRole('radio', { name: 'Chat view' }).click().catch(async () => p.locator('.view-switch button').nth(1).click());
await p.locator('.agent-sidebar').waitFor();
await p.locator('.agent-row', { hasText: 'Codex' }).click();
await p.waitForFunction(() => document.querySelector('.view-switch button[aria-checked="true"], .view-switch .is-on')?.textContent !== null);
assert.equal(await p.locator('.workspace, .tabs-bar').count() > 0, true, 'back in the terminal view');
assert.deepEqual(errors, []);
await b.close();
console.log('PASS sidebar: one sidebar in both views, terminal agents as rows, rows open where they live');

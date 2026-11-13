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

// Each row has Open, Rename and Delete: on right-click, and behind its ⋯ button.
await p.locator('.agent-row', { hasText: 'Codex' }).click({ button: 'right' });
for (const name of ['Open', 'Rename…', 'Delete…']) await p.getByRole('menuitem', { name }).waitFor();
await p.keyboard.press('Escape');
await p.locator('.agent-row', { hasText: 'Codex' }).hover();
await p.getByRole('button', { name: /^Actions for Codex/ }).click();
await p.getByRole('menuitem', { name: 'Rename…' }).click();
await p.getByRole('dialog').getByRole('textbox').fill('API work');
await p.keyboard.press('Enter');
await p.locator('.agent-row', { hasText: 'API work' }).waitFor();
if (process.env.DESK_SCREENSHOT) { await p.locator('.agent-row', { hasText: 'API work' }).click({ button: 'right' }); await p.screenshot({ path: process.env.DESK_SCREENSHOT.replace('.png', '-menu.png'), clip: { x: 0, y: 0, width: 520, height: 400 } }); await p.keyboard.press('Escape'); }

// Same sidebar in chat view; a terminal row brings you back to the terminal view.
await p.getByRole('radio', { name: 'Chat view' }).click().catch(async () => p.locator('.view-switch button').nth(1).click());
await p.locator('.agent-sidebar').waitFor();
await p.locator('.agent-row', { hasText: 'API work' }).click();
await p.locator('.chat-main').waitFor({ state: 'detached' });
await p.locator('.workspace').waitFor();
assert.equal(await p.getByRole('radio', { name: 'Terminal view' }).getAttribute('aria-checked'), 'true', 'back in the terminal view');
assert.deepEqual(errors, []);
await b.close();
console.log('PASS sidebar: one sidebar in both views, terminal agents as rows, open/rename/delete on each row, rows open where they live');

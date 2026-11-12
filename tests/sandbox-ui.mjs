// Sandboxes in Settings and the setup sheet, with no provider installed: the
// sheet explains, never forces, and "Not now" closes it. Run against npm run dev
// (DESK_TEST_URL, default http://localhost:1420).
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mockDesktop } from './desktop-mock.mjs';

const base = process.env.DESK_TEST_URL || 'http://localhost:1420';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(mockDesktop);
await page.goto(base);
await page.waitForTimeout(1200);

await page.keyboard.press('Meta+Comma');
await page.getByRole('button', { name: /Sandboxes/ }).first().click();
await page.getByText('Unattended for up to').waitFor();
for (const name of ['Docker', 'Boat', 'Render', 'Modal']) {
  await page.getByText(name, { exact: true }).first().waitFor();
}
await page.getByText("Docker isn't installed.").waitFor();
assert.equal(await page.getByText(/TypeError/).count(), 0, 'no raw errors');

await page.getByRole('button', { name: 'Set up…' }).first().click();
await page.getByText('Set up Docker').waitFor();
assert.equal(await page.locator('.sandbox-steps li.is-done').count(), 0, 'nothing ticked when not installed');
await page.getByRole('button', { name: 'Not now' }).click();
await page.getByText('Set up Docker').waitFor({ state: 'detached' });

assert.deepEqual(errors, []);
await browser.close();
console.log('PASS sandbox-ui');

// Settings ▸ Phone against a mocked Desk: turning the remote on stays on even
// when the tailnet hasn't allowed Tailscale Serve; the page offers the link to
// turn it on and a retry, and the pairing code appears once Serve works.
// Run against npm run dev (DESK_TEST_URL, default http://localhost:1420).
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mockDesktop } from './desktop-mock.mjs';

const base = process.env.DESK_TEST_URL || 'http://localhost:1420';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(mockDesktop);
await page.goto(base);
await page.waitForTimeout(1200);

await page.keyboard.press('Meta+Comma');
await page.locator('.settings-page').waitFor();
await page.getByRole('button', { name: 'Phone', exact: true }).click();
await page.getByText('Connected to your tailnet.').waitFor();
await page.getByRole('switch', { name: /Phone remote/ }).click();
await page.getByText('Turn on Tailscale Serve').waitFor();
assert.equal(await page.getByRole('switch', { name: /Phone remote/ }).getAttribute('aria-checked'), 'true', 'stays on');
await page.getByRole('button', { name: 'Turn on Serve' }).click();
assert.ok(await page.evaluate(() => window.testCalls.some((c) => c.cmd === 'plugin:opener|open_url' || (JSON.stringify(c.args ?? {}).includes('login.tailscale.com/f/serve')))), 'opens the enable link');
await page.getByRole('button', { name: 'Try again' }).click();
await page.getByRole('button', { name: 'Show code' }).click();
await page.getByAltText('Pairing code').waitFor();

assert.deepEqual(errors, []);
await browser.close();
console.log('PASS phone-settings: remote stays on, Serve enable link, retry, pairing code');

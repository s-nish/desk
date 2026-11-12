// The browser pane: Home goes back to the start page, which lists recent addresses.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mockDesktop } from './desktop-mock.mjs';

const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
await p.addInitScript(mockDesktop);
await p.goto(process.env.DESK_TEST_URL || 'http://localhost:1420');
await p.getByText('Good work starts here.').waitFor();
await p.keyboard.press('Meta+Shift+l');
const pane = p.getByRole('region', { name: 'Browser' });
await pane.getByText('Preview your app').waitFor();
assert.ok(await pane.getByRole('button', { name: 'Home' }).isDisabled(), 'no Home before a page is open');
await pane.getByLabel('Address').fill('localhost:5173');
await pane.getByLabel('Address').press('Enter');
await p.waitForFunction(() => window.testCalls.some((c) => c.cmd === 'browser_open' && c.args.url === 'localhost:5173'));
// The page reports where it ended up, which is remembered.
await p.evaluate(() => { for (const [, cb] of window.testCallbacks) try { cb({ event: 'browser-state', payload: { url: 'http://localhost:5173/', loading: false }, id: 1 }); } catch {} });
await pane.getByRole('button', { name: 'Home' }).click();
await pane.getByText('Preview your app').waitFor();
assert.ok(await p.evaluate(() => window.testCalls.some((c) => c.cmd === 'browser_close')));
await pane.getByLabel('Address').fill('tauri docs');
await pane.getByLabel('Address').press('Enter');
await p.waitForFunction(() => window.testCalls.some((c) => c.cmd === 'browser_open' && c.args.url.startsWith('https://duckduckgo.com/?q=tauri')));
if (process.env.DESK_SCREENSHOT) await p.screenshot({ path: process.env.DESK_SCREENSHOT });
assert.deepEqual(errors, []);
await b.close();
console.log('PASS browser-ui: open, Home back to the start page, words search');

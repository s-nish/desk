// Run against npm run dev. Uses real xterm with mocked native I/O.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mockDesktop } from './desktop-mock.mjs';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const screenshot = async name => page.screenshot({ path: `/private/tmp/desk-refined-${name}.png` });
try {
  await page.addInitScript(mockDesktop);
  await page.goto(process.env.DESK_TEST_URL || 'http://127.0.0.1:1421');
  await page.getByText('Good work starts here.').waitFor();
  await screenshot('welcome');
  await page.getByRole('button', { name: 'Add project folder', exact: true }).last().click();
  await page.getByRole('heading', { name: 'studio', exact: true }).waitFor();
  assert.equal(await page.locator('.project.is-active').evaluate(el => getComputedStyle(el).boxShadow), 'none');
  await page.getByRole('button', { name: 'Open settings' }).click();
  assert.equal(await page.locator('.theme-option').count(), 20);
  const contrastResults = [];
  for (const name of ['Black', 'Obsidian', 'Graphite', 'Dim Soft', 'Light', 'Porcelain', 'Silver', 'Mist']) {
    await page.locator('.theme-option').filter({ has: page.locator('.theme-name', { hasText: new RegExp(`^${name}$`) }) }).click();
    const result = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const hex = name => css.getPropertyValue(name).trim();
      const luminance = hex => {
        const rgb = hex.match(/[a-f\d]{2}/gi).map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
        return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
      };
      const ratio = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      const pairs = ['--text', '--text-2', '--muted', '--muted-2'].flatMap(fg => ['--bg', '--surface', '--bg-raised', '--bg-press', '--bg-hover', '--bg-overlay'].map(bg => ({ fg, bg, ratio: ratio(luminance(hex(fg)), luminance(hex(bg))) })));
      return { theme: document.documentElement.dataset.theme, minimum: Math.min(...pairs.map(p => p.ratio)), failed: pairs.filter(p => p.ratio < 4.5) };
    });
    assert.deepEqual(result.failed, [], `Text contrast: ${name}`);
    contrastResults.push({ theme: result.theme, minimum: result.minimum.toFixed(2) });
    await screenshot(`theme-${name.toLowerCase()}`);
  }
  // Theme survives reload, and all light modes use light editor/terminal colors.
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('desk-recovery-v2') || '{}').preferences?.theme === 'mist');
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'mist');
  assert.equal(await page.locator('html').getAttribute('data-color-scheme'), 'light');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Match system appearance' }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'black');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'paper');
  await page.locator('.theme-option').filter({ hasText: 'Obsidian' }).click();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  assert.equal(await page.locator('.term-preset').count(), 18);
  await screenshot('terminal-settings');
  await page.getByRole('switch', { name: /Smooth scrolling/ }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.keyboard.press('Meta+j');
  await page.locator('.xterm').waitFor();
  let outputIndex = 0;
  const output = async text => {
    const title = `Shell · output ${++outputIndex}`;
    await page.evaluate(({ text, title }) => {
      const spawn = window.testCalls.find(c => c.cmd === 'pty_spawn');
      spawn.args.onData.onmessage(new TextEncoder().encode(text + '\x1b]0;' + title + '\x07').buffer);
    }, { text, title });
    await page.locator('.tab-label').getByText(title, { exact: true }).waitFor();
  };
  await output(Array.from({ length: 320 }, (_, i) => `Line ${String(i + 1).padStart(3, '0')}   Build output — readable history\r\n`).join('') + '\x1b[2mSecondary information\x1b[0m\r\n\x1b[97mBright text\x1b[0m\r\n');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Shift+PageUp');
  await page.getByRole('button', { name: 'Latest output' }).waitFor();
  await output('More output while reading\r\n');
  await page.getByRole('button', { name: 'Latest output' }).waitFor();
  await screenshot('scrollback');
  console.log('Terminal scrollbar:', await page.locator('.xterm .slider').last().evaluate(el => getComputedStyle(el).backgroundColor));
  await page.getByRole('button', { name: 'Latest output' }).click();
  await page.waitForFunction(() => document.querySelector('.term-latest').hidden);
  const termBox = await page.locator('.xterm').boundingBox();
  await page.mouse.move(termBox.x + termBox.width / 2, termBox.y + termBox.height / 2);
  await page.mouse.wheel(0, -900);
  await page.getByRole('button', { name: 'Latest output' }).waitFor();
  await page.keyboard.press('Shift+End');
  await page.waitForFunction(() => document.querySelector('.term-latest').hidden);
  // Alternate screen applications own their navigation and have no scrollback pill.
  await page.keyboard.press('Shift+PageUp');
  await page.getByRole('button', { name: 'Latest output' }).waitFor();
  await output('\x1b[?1049hFull-screen application\r\n');
  await page.waitForFunction(() => document.querySelector('.term-latest').hidden);
  await page.keyboard.press('Shift+PageUp');
  assert.equal(await page.locator('.term-latest').isVisible(), false);
  await output('\x1b[?1049l');
  // Reconfiguring themes does not restart the running process.
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.locator('.theme-option').filter({ hasText: 'Silver' }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await page.evaluate(() => window.testCalls.filter(c => c.cmd === 'pty_spawn').length), 1);
  await screenshot('terminal-light');
  await page.setViewportSize({ width: 960, height: 600 });
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('switch', { name: /Blinking cursor/ }).scrollIntoViewIfNeeded();
  const bounds = await page.locator('.modal').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 960 && bounds.y + bounds.height <= 600);
  await screenshot('minimum-size');
  assert.deepEqual(errors, []);
  console.log('PASS: eight theme contrast checks, persistence, system appearance, 18 terminal presets, real terminal wheel/keyboard scrollback, incoming output, return to latest, alternate screen, live theme changes, minimum window size.');
  console.table(contrastResults);
} catch (e) {
  await screenshot('failure');
  throw e;
} finally {
  await browser.close();
}

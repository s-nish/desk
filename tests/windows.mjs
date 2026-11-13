// More than one Desk window (src/windows.ts), with two pages standing in for the
// main window and an extra one, and the test passing Tauri events between them:
// ⇧⌘N asks for a new window and ⌥⌘N is a new SSH connection; the extra window
// starts with no projects but the main window's settings; it saves only its own
// part; a setting changed there reaches the main window (whose view stays its
// own); its waiting agent shows in the main window's menu bar and Dock badge;
// clicks meant for it are applied there; closing it asks while an agent works,
// then forgets it; quitting waits for it to save.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mockDesktop } from './desktop-mock.mjs';

const base = process.env.DESK_TEST_URL || 'http://localhost:1420';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const errors = [];

const mainState = {
  version: 4, savedAt: 1,
  accounts: [], sandboxes: [], connections: [],
  projects: [{ id: 'p1', name: 'studio', path: '/demo/studio' }], activeProjectId: 'p1',
  layout: {}, preferences: { theme: 'mist', themeVersion: 2, uiMode: 'chat', showStatusBar: true },
  tabs: [], activeTabId: null, secondaryTabId: null, focusedPane: 'primary',
};

async function open(label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  await page.addInitScript(mockDesktop);
  await page.addInitScript(({ label, mainState }) => {
    window.__TAURI_INTERNALS__.metadata = { currentWindow: { label }, currentWebview: { label } };
    if (label === 'main') { if (!localStorage.getItem('test-state')) localStorage.setItem('test-state', JSON.stringify(mainState)); }
    else window.testMainState = mainState;
  }, { label, mainState });
  await page.goto(base);
  await page.waitForTimeout(1200);
  return page;
}

/** Events a page sent (emit / emit_to) since last time, delivered to the other page's listeners. */
const sent = new Map();
async function relay(from, to, label) {
  const calls = await from.evaluate(() => window.testCalls.map((c, i) => ({ i, ...c })).filter((c) => c.cmd === 'plugin:event|emit' || c.cmd === 'plugin:event|emit_to'));
  const seen = sent.get(from) ?? 0;
  const fresh = calls.filter((c) => c.i >= seen);
  sent.set(from, calls.length ? calls[calls.length - 1].i + 1 : seen);
  for (const c of fresh) {
    const target = c.args.target?.label ?? c.args.target;
    if (c.cmd === 'plugin:event|emit_to' && target && target !== label && target?.kind !== 'Any') continue;
    await fire(to, c.args.event, c.args.payload);
  }
}
async function fire(page, event, payload) {
  await page.evaluate(({ event, payload }) => {
    for (const c of window.testCalls) if (c.cmd === 'plugin:event|listen' && c.args.event === event) window.testCallbacks.get(c.args.handler)?.({ event, id: 1, payload });
  }, { event, payload });
}

try {
  const main = await open('main');
  const extra = await open('w-test');

  // ⇧⌘N asks for a new window; ⌥⌘N is a new SSH connection now.
  await main.bringToFront();
  await main.keyboard.press('Meta+Shift+N');
  await main.waitForTimeout(200);
  assert.ok(await main.evaluate(() => window.testCalls.some((c) => c.cmd === 'window_new')), '⇧⌘N opens a window');
  await main.keyboard.press('Meta+Alt+N');
  await main.getByText(/New SSH connection|SSH connection/).first().waitFor();
  await main.keyboard.press('Escape');

  // The extra window: no projects, the main window's settings.
  assert.equal(await extra.evaluate(async () => (await import('/src/store.ts')).useDesk.getState().projects.length), 0, 'starts with no projects');
  assert.equal(await extra.evaluate(async () => (await import('/src/store.ts')).useDesk.getState().preferences.theme), 'mist', 'shares settings');
  assert.equal(await extra.evaluate(() => document.documentElement.dataset.theme), 'mist');

  // It saves only its own part.
  await extra.evaluate(async () => (await import('/src/store.ts')).useDesk.getState().setLayout({ sidebarWidth: 300 }));
  await extra.waitForTimeout(500);
  const own = await extra.evaluate(() => [...window.testCalls].reverse().find((c) => c.cmd === 'state_save')?.args.state);
  assert.ok(own, 'saves');
  assert.equal(own.layout.sidebarWidth, 300);
  assert.ok(!('accounts' in own) && !('connections' in own) && !('preferences' in own), `only its own part: ${Object.keys(own)}`);

  // A setting changed there reaches the main window; each keeps its own view.
  await extra.evaluate(async () => (await import('/src/store.ts')).useDesk.getState().setPreferences({ showStatusBar: false, uiMode: 'terminal' }));
  await extra.waitForTimeout(100);
  await relay(extra, main, 'main');
  await main.waitForTimeout(200);
  const prefs = await main.evaluate(async () => (await import('/src/store.ts')).useDesk.getState().preferences);
  assert.equal(prefs.showStatusBar, false, 'setting reached the main window');
  assert.equal(prefs.uiMode, 'chat', 'the main window keeps its own view');

  // An agent waiting in the extra window shows in the main window's menu bar and Dock badge.
  await extra.evaluate(async () => {
    const { useDesk } = await import('/src/store.ts');
    const s = useDesk.getState();
    s.addProject('/demo/other');
    const projectId = useDesk.getState().projects[0].id;
    s.addTab({ id: 'tx', type: 'terminal', projectId, tool: 'claude', accountId: null, title: 'Claude Code', status: 'running', busy: false, attention: null, activity: false });
    s.addTab({ id: 'ty', type: 'terminal', projectId, tool: 'shell', accountId: null, title: 'zsh', status: 'running', busy: false, attention: null, activity: false });
    s.selectTab('ty');
  });
  // Waiting in a tab that isn't on screen (one on screen is cleared as you look at it).
  await extra.waitForTimeout(300);
  await extra.evaluate(async () => (await import('/src/store.ts')).useDesk.getState().patchTab('tx', { attention: 'Needs your answer', status: 'running' }));
  await extra.waitForTimeout(400);
  await relay(extra, main, 'main');
  await main.waitForTimeout(600);
  const tray = await main.evaluate(() => [...window.testCalls].reverse().find((c) => c.cmd === 'tray_update')?.args.items ?? []);
  assert.ok(tray.some((i) => i.id === 't:tx' && i.waiting), `menu bar has the other window's agent: ${JSON.stringify(tray)}`);
  const badge = await main.evaluate(() => [...window.testCalls].reverse().find((c) => c.cmd === 'attention')?.args.count);
  assert.equal(badge, 1, 'Dock badge counts it');

  // A click meant for it (from the menu bar) is applied there, and that window comes forward.
  await fire(extra, 'tray-open', 't:tx');
  await extra.waitForTimeout(200);
  assert.ok(await extra.evaluate(() => window.testCalls.some((c) => c.cmd === 'window_focus')), 'its window comes forward');
  assert.equal(await main.evaluate(() => window.testCalls.filter((c) => c.cmd === 'window_focus').length), 0);

  // Quitting: the main window waits for the others to save.
  await main.evaluate(() => { window.testWindowLabels = ['w-test']; });
  await fire(main, 'desk-quit', null);
  await main.waitForTimeout(100);
  await relay(main, extra, 'w-test');
  await extra.waitForTimeout(300);
  await relay(extra, main, 'main');
  await main.waitForFunction(() => window.testCalls.some((c) => c.cmd === 'workspace_exit'), null, { timeout: 3000 });

  // Closing the extra window while its agent runs asks first; then it's forgotten.
  await fire(extra, 'tauri://close-requested', null);
  await extra.getByText('Close this window?').waitFor();
  assert.equal(await extra.evaluate(() => window.testCalls.filter((c) => c.cmd === 'window_forget').length), 0, 'asks first');
  await extra.getByRole('button', { name: 'Close window' }).click();
  await extra.waitForFunction(() => window.testCalls.some((c) => c.cmd === 'window_forget'));
  assert.ok(await extra.evaluate(() => window.testCalls.some((c) => c.cmd === 'pty_kill' || c.cmd === 'window_forget')));

  assert.deepEqual(errors, []);
  console.log('PASS windows: ⇧⌘N new window, ⌥⌘N SSH, empty window with shared settings, saves its own part, settings sync (view stays per window), other window\'s agent in menu bar and badge, click applied in its window, quit waits for it, close asks then forgets');
} finally {
  await browser.close();
}

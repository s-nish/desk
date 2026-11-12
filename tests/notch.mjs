// The notch page (notch.html) against a mocked feed. Run against npm run dev
// (DESK_TEST_URL, default http://localhost:1420).
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const base = process.env.DESK_TEST_URL || 'http://localhost:1420';
const now = Date.now();
const item = (over) => ({ kind: 'chat', where: 'local', account: null, accountColor: null, canReply: true, approval: null, since: now - 300000, activity: '', project: 'desk', ...over });
const feed = (items, over = {}) => ({ enabled: true, peek: 'waiting', rings: true, otherScreens: true, reduceMotion: false, onScreen: null, usage: [{ account: 'a1', name: 'work', color: '#0297de', tool: 'claude', used: 62 }], preview: false, items, ...over });
const asking = item({ id: 'c:1', tool: 'claude', title: 'Fix flaky auth test', state: 'waiting', approval: { requestId: 'r1', tool: 'Bash', summary: 'npm test -- --runInBand auth', plan: false, allowOnce: true } });
const working = item({ id: 'c:2', tool: 'codex', title: 'Migrate settings', state: 'working', activity: 'Edit store.ts' });
const done = item({ id: 'c:3', tool: 'claude', title: 'Add CSV export', state: 'done', since: null });
const notch = { hasNotch: true, notchWidth: 184, notchHeight: 32, top: 0 };

function mock({ payload, geometry }) {
  let id = 0;
  window.calls = [];
  window.callbacks = new Map();
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'notch' }, currentWebview: { label: 'notch' } },
    transformCallback: (fn) => { window.callbacks.set(++id, fn); return id; },
    unregisterCallback: () => {},
    invoke: async (cmd, args) => {
      window.calls.push({ cmd, args });
      if (cmd === 'notch_snapshot') return { payload, geometry };
      return null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.emit = (event, payload) => {
    for (const c of window.calls) if (c.cmd === 'plugin:event|listen' && c.args.event === event) window.callbacks.get(c.args.handler)({ event, payload });
  };
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const errors = [];
async function open(payload, geometry = notch) {
  const page = await browser.newPage({ viewport: { width: 640, height: 600 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(mock, { payload, geometry });
  await page.goto(`${base}/notch.html`);
  await page.waitForSelector('.notch');
  return page;
}
const calls = (page, cmd) => page.evaluate((cmd) => window.calls.filter((c) => c.cmd === cmd).map((c) => c.args), cmd);
const emit = (page, event, payload) => page.evaluate(([e, p]) => window.emit(e, p), [event, payload]);

try {
  // Collapsed: wings with the count and the waiting dot, sized to the notch.
  let page = await open(feed([asking, working, done]));
  await page.waitForSelector('.notch.is-collapsed .notch-wait');
  assert.equal(await page.textContent('.notch-wing.is-left .notch-count'), '2');
  assert.equal(await page.textContent('.notch-wing.is-right .notch-count'), '1');
  await page.waitForFunction(() => window.calls.some((c) => c.cmd === 'notch_resize' && c.args.width === 184 + 152 + 24 && c.args.height === 32));

  // Hover opens it; the window grows to fit before the shell does.
  await emit(page, 'notch-hover', true);
  await page.waitForSelector('.notch.is-expanded .feed-card');
  assert.match(await page.textContent('.feed-code'), /npm test -- --runInBand auth/);
  assert.ok(!(await page.textContent('.notch-content')).includes('Full access'), 'never offers Full access');
  await page.waitForFunction(() => window.calls.some((c) => c.cmd === 'notch_resize' && c.args.width === 480 + 24 && c.args.height > 100));
  assert.match(await page.textContent('.notch-foot'), /work 62%/);

  // Allow answers the question and the card says so.
  await page.click('.feed-card .feed-btn.is-primary');
  assert.deepEqual((await calls(page, 'notch_action')).at(-1), { action: { type: 'answer', id: 'c:1', requestId: 'r1', allow: true } });
  await page.waitForSelector('.feed-answered.is-allowed');

  // Reply goes to the selected chat; a finished chat isn't busy, so it's sent, not queued.
  await page.click('.feed-row.is-done');
  assert.match(await page.getAttribute('.feed-reply input', 'placeholder'), /Add CSV export/);
  await page.click('.feed-reply input');
  await page.keyboard.type('also add JSON');
  await page.press('.feed-reply input', 'Enter');
  assert.deepEqual((await calls(page, 'notch_action')).at(-1), { action: { type: 'reply', id: 'c:3', text: 'also add JSON' } });
  assert.equal(await page.textContent('.feed-reply-hint'), 'Sent');
  assert.ok((await calls(page, 'notch_focus')).some((a) => a.focus === true), 'the reply field takes the keyboard');

  // Keys: ⌘⌫ denies the selected question; Esc closes and hands the keyboard back.
  await emit(page, 'notch-feed', feed([{ ...asking, approval: { ...asking.approval, requestId: 'r2' } }, working, done]));
  await page.click('.feed-card');
  await page.keyboard.press('Meta+Backspace');
  assert.deepEqual((await calls(page, 'notch_action')).at(-1), { action: { type: 'answer', id: 'c:1', requestId: 'r2', allow: false } });
  await page.keyboard.press('Escape');
  await emit(page, 'notch-hover', false);
  await page.waitForSelector('.notch.is-collapsed');
  assert.equal((await calls(page, 'notch_focus')).at(-1).focus, false);

  // Stop and Open.
  await emit(page, 'notch-hover', true);
  await page.waitForSelector('.notch.is-expanded');
  await page.hover('.feed-row.is-working');
  await page.click('.feed-row.is-working [aria-label^="Stop"]');
  assert.deepEqual((await calls(page, 'notch_action')).at(-1), { action: { type: 'stop', id: 'c:2' } });
  await page.click('.notch-open');
  assert.deepEqual((await calls(page, 'notch_action')).at(-1), { action: { type: 'open', id: '' } });
  // An agent that only offers "always allow" is answered in Desk, never from here.
  await emit(page, 'notch-feed', feed([{ ...asking, approval: { ...asking.approval, requestId: 'r3', allowOnce: false } }]));
  await emit(page, 'notch-hover', false);
  await page.waitForTimeout(50);
  await emit(page, 'notch-hover', true);
  await page.waitForSelector('text=Allow in Desk…');
  const before = (await calls(page, 'notch_action')).length;
  await page.click('.feed-card');
  await page.keyboard.press('Meta+Enter');
  assert.equal((await calls(page, 'notch_action')).length, before, '⌘↵ does nothing');
  await page.close();

  // Peek: a newly waiting chat opens one card by itself; not when Desk shows it.
  page = await open(feed([working]));
  await page.waitForSelector('.notch.is-collapsed .notch-wave');
  await emit(page, 'notch-feed', feed([asking, working]));
  await page.waitForSelector('.notch.is-peek .feed-card');
  assert.equal((await calls(page, 'notch_focus')).length, 0, 'a peek never takes the keyboard');
  await page.close();
  page = await open(feed([working]));
  await page.waitForSelector('.notch.is-collapsed');
  await emit(page, 'notch-feed', feed([asking, working], { onScreen: 'c:1' }));
  await page.waitForTimeout(150);
  assert.ok(await page.$('.notch.is-collapsed'), 'no peek for the chat on screen');

  // Nothing running: the window goes away.
  await emit(page, 'notch-feed', feed([]));
  await page.waitForFunction(() => window.calls.some((c) => c.cmd === 'notch_resize' && c.args.width === 0 && c.args.height === 0));
  await page.close();

  // No notch: the pill. Turned off: nothing. Reduced motion: no wave animation.
  page = await open(feed([working], { reduceMotion: true }), { hasNotch: false, notchWidth: 0, notchHeight: 30, top: 25 });
  await page.waitForSelector('.notch.is-pill.is-reduced.is-collapsed');
  assert.equal(await page.$eval('.notch-wave i', (el) => getComputedStyle(el).animationName), 'none');
  await emit(page, 'notch-feed', feed([working], { otherScreens: false }));
  await page.waitForSelector('.notch.is-hidden');
  await page.close();

  assert.deepEqual(errors, []);
  console.log('PASS: notch collapsed, hover open, allow, deny by key, reply, stop, open, peek (and none for the chat on screen), hide when idle, pill, reduced motion.');
} finally {
  await browser.close();
}

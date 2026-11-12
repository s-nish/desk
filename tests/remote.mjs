// The phone page (remote.html) against a mocked Desk: the feed arrives over
// server-sent events, Allow posts a once-only answer, an unpaired phone is told so.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const base = process.env.DESK_TEST_URL || 'http://localhost:1420';
const now = Date.now();
const feed = { usage: [{ account: 'a1', name: 'work', color: '#0297de', tool: 'claude', used: 40 }], items: [
  { id: 'c:1', kind: 'chat', tool: 'claude', title: 'Fix flaky auth test', project: 'desk', where: 'local', account: 'a1', accountColor: '#0297de', state: 'waiting', since: now - 120000, activity: '', canReply: true, approval: { requestId: 'r1', tool: 'Bash', summary: 'npm test -- auth', plan: false, allowOnce: true } },
  { id: 'c:2', kind: 'chat', tool: 'codex', title: 'Migrate settings', project: 'desk', where: 'local', account: null, accountColor: null, state: 'working', since: now - 60000, activity: 'Edit store.ts', canReply: true, approval: null },
] };

function mock({ feed, paired }) {
  window.posts = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/events')) return new Response('', { status: paired ? 200 : 401 });
    if (String(url).endsWith('/action')) { window.posts.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    return realFetch(url, init);
  };
  window.EventSource = class { constructor() { setTimeout(() => this.onmessage?.({ data: JSON.stringify(feed) }), 50); } close() {} };
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(mock, { feed, paired: true });
  await page.goto(`${base}/remote.html`);
  await page.getByText('Fix flaky auth test').waitFor();
  await page.getByText('Live').waitFor();
  await page.getByText('Migrate settings').waitFor();
  assert.equal(await page.getByText(/Always|Full access/).count(), 0, 'never offers a standing allow');
  if (process.env.DESK_SCREENSHOT) await page.screenshot({ path: process.env.DESK_SCREENSHOT });
  await page.getByRole('button', { name: /^Allow/ }).first().click();
  await page.waitForFunction(() => window.posts.length > 0);
  assert.deepEqual(await page.evaluate(() => window.posts[0]), { type: 'answer', id: 'c:1', requestId: 'r1', allow: true });
  await page.getByLabel('Reply to Fix flaky auth test').fill('also run lint');
  await page.getByLabel('Reply to Fix flaky auth test').press('Enter');
  await page.waitForFunction(() => window.posts.some((p) => p.type === 'reply'));
  assert.deepEqual(errors, []);

  const unpaired = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await unpaired.addInitScript(mock, { feed, paired: false });
  await unpaired.goto(`${base}/remote.html`);
  await unpaired.getByText('Not paired').waitFor();
  console.log('PASS remote: feed over SSE, allow once, reply, unpaired phone told to pair');
} finally {
  await browser.close();
}

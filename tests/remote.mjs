// The phone page (remote.html) against a mocked Desk: every open session over
// server-sent events, grouped by project with "Needs you" first; opening one asks
// Desk to watch it and shows the conversation; Allow once and replies post the
// right actions; a reply shows at once; back returns to the list; an unpaired
// phone is told so. DESK_SCREENSHOT saves the list and a thread.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const base = process.env.DESK_TEST_URL || 'http://localhost:1420';
const shot = process.env.DESK_SCREENSHOT;
const now = Date.now();
const mac = { provider: 'mac', label: 'This Mac' };
const feed = {
  usage: [{ account: 'a1', name: 'work', color: '#0297de', tool: 'claude', used: 40 }],
  sessions: [
    { id: 'c:1', kind: 'chat', tool: 'claude', title: 'Fix flaky auth test', project: 'desk', projectId: 'p1', where: mac, state: 'waiting', since: now - 120000, updated: now - 5000, activity: 'Bash npm test -- auth', approval: { requestId: 'r1', tool: 'Bash', summary: 'npm test -- auth', plan: false, allowOnce: true }, canReply: true, canStop: true, unread: false, queued: 0 },
    { id: 'c:2', kind: 'chat', tool: 'codex', title: 'Migrate settings', project: 'desk', projectId: 'p1', where: { provider: 'modal', label: 'Modal · desk-1', mode: 'code' }, state: 'working', since: now - 60000, updated: now - 2000, activity: 'Edit store.ts', approval: null, canReply: true, canStop: true, unread: false, queued: 0 },
    { id: 'c:3', kind: 'chat', tool: 'claude', title: 'Landing page copy', project: 'site', projectId: 'p2', where: mac, state: 'idle', since: null, updated: now - 3600000, activity: 'Done. The hero now says what Desk is in one line.', approval: null, canReply: true, canStop: false, unread: false, queued: 0 },
    { id: 't:9', kind: 'terminal', tool: 'claude', title: 'Claude Code', project: 'site', projectId: 'p2', where: mac, state: 'idle', since: null, updated: now - 7200000, activity: 'In a terminal tab', approval: null, canReply: true, canStop: false, unread: false, queued: 0 },
  ],
  threads: {},
};
const thread = { kind: 'chat', truncated: false, entries: [
  { kind: 'user', id: 'u1', text: 'The auth test fails about one run in five. Find out why and fix it.' },
  { kind: 'tool', id: 't1', name: 'Read', summary: 'src/auth.test.ts', state: 'done' },
  { kind: 'tool', id: 't2', name: 'Grep', summary: 'setTimeout src/auth', state: 'done', output: 'src/auth/session.ts:41: setTimeout(refresh, 0)' },
  { kind: 'assistant', id: 'a1', text: 'The test races the **token refresh**: `session.ts` schedules it with `setTimeout(…, 0)`, so sometimes it lands after the assertion.\n\nI\'ll make the refresh awaitable and run the tests:\n\n```ts\nawait session.refresh();\n```' },
  { kind: 'approval', id: 'r1', tool: 'Bash', summary: 'npm test -- auth', state: 'pending' },
] };

function mock({ feed, thread, paired }) {
  window.posts = [];
  const realFetch = window.fetch.bind(window);
  let source = null;
  const emit = () => source?.onmessage?.({ data: JSON.stringify(window.feedNow) });
  window.feedNow = feed;
  window.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/events')) return new Response('', { status: paired ? 200 : 401 });
    if (String(url).endsWith('/action')) {
      const action = JSON.parse(init.body);
      window.posts.push(action);
      // Desk answers a watch by sending that conversation along.
      if (action.type === 'watch') { window.feedNow = { ...window.feedNow, threads: { ...window.feedNow.threads, [action.id]: thread } }; setTimeout(emit, 30); }
      return new Response(null, { status: 204 });
    }
    return realFetch(url, init);
  };
  window.EventSource = class { constructor() { source = this; setTimeout(emit, 50); } close() {} };
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(mock, { feed, thread, paired: true });
  await page.goto(`${base}/remote.html`);

  // The list: Needs you first, then each project; idle sessions are there too.
  await page.getByText('Fix flaky auth test').waitFor();
  await page.getByText('Live').waitFor();
  assert.deepEqual(await page.locator('.ph-group h2').allInnerTexts(), ['NEEDS YOU', 'DESK', 'SITE']);
  await page.getByText('Landing page copy').waitFor();
  await page.getByText('Claude Code', { exact: true }).first().waitFor();
  assert.equal(await page.getByText(/Always|Full access/).count(), 0, 'never offers a standing allow');
  if (shot) { await page.waitForTimeout(400); await page.screenshot({ path: shot.replace('.png', '-list.png') }); }

  // Open a conversation: Desk is asked to watch it, and the thread shows.
  await page.locator('.ph-row-main', { hasText: 'Fix flaky auth test' }).click();
  await page.waitForFunction(() => window.posts.some((p) => p.type === 'watch' && p.id === 'c:1'));
  await page.getByText('The auth test fails about one run in five.').waitFor();
  await page.locator('.ph-msg.is-agent code', { hasText: 'session.ts' }).waitFor();
  await page.getByText('Read, Grep · 2 steps').waitFor();
  await page.locator('.ph-pinned').getByText('npm test -- auth').waitFor();
  await page.waitForTimeout(500);
  if (shot) await page.screenshot({ path: shot.replace('.png', '-thread.png') });

  // Allow once, from the pinned card.
  await page.locator('.ph-pinned').getByRole('button', { name: 'Allow once' }).click();
  await page.waitForFunction(() => window.posts.some((p) => p.type === 'answer'));
  assert.deepEqual(await page.evaluate(() => window.posts.find((p) => p.type === 'answer')), { type: 'answer', id: 'c:1', requestId: 'r1', allow: true });

  // A reply posts and shows at once.
  await page.getByPlaceholder(/Queued until this turn ends|Reply to/).fill('also run lint');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForFunction(() => window.posts.some((p) => p.type === 'reply'));
  assert.deepEqual(await page.evaluate(() => window.posts.find((p) => p.type === 'reply')), { type: 'reply', id: 'c:1', text: 'also run lint' });
  await page.locator('.ph-msg.is-pending', { hasText: 'also run lint' }).waitFor();

  // Back to the list.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.waitForFunction(() => !location.hash);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.ph-thread').count(), 0, 'the thread is gone');
  assert.deepEqual(errors, []);

  const unpaired = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await unpaired.addInitScript(mock, { feed, thread, paired: false });
  await unpaired.goto(`${base}/remote.html`);
  await unpaired.getByText('Not paired').waitFor();
  console.log('PASS remote: every session by project, open a thread (watch), allow once, reply shows at once, back, unpaired phone told to pair');
} finally {
  await browser.close();
}

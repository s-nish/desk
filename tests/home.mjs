// Run against the dev server. Home screen, chat-tab closing, pixel themes and sidebar footer.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mockDesktop } from './desktop-mock.mjs';

const shots = process.env.DESK_SHOTS || '/private/tmp';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.addInitScript(mockDesktop);
  await page.goto(process.env.DESK_TEST_URL || 'http://127.0.0.1:1421');
  await page.getByText('Good work starts here.').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-style'), 'pixel');
  assert.equal(await page.locator('.ambient canvas').count() >= 1, true, 'pixel backdrop renders');

  // Terminal view: Home lists projects with one heading per project name.
  await page.getByRole('button', { name: 'Add project folder', exact: true }).last().click();
  await page.getByRole('heading', { name: 'studio', exact: true }).waitFor();
  await page.locator('.home-card').first().waitFor();
  assert.equal(await page.locator('.sidebar-foot .usage-ring').count() >= 1, true, 'usage rings in sidebar');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/desk-home.png` });

  // Animation switch in the sidebar footer flips the preference.
  const sw = page.getByRole('switch', { name: 'Animated background' });
  assert.equal(await sw.getAttribute('aria-checked'), 'true');
  await sw.click();
  assert.equal(await sw.getAttribute('aria-checked'), 'false');
  await sw.click();

  // Chat view: closing the last tab leaves no tab and shows Home (no blank chat respawns).
  await page.getByRole('radio', { name: 'Chat view' }).click().catch(async () => page.locator('.view-switch button').nth(1).click());
  await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
  await page.locator('.chat-tab').first().waitFor();
  while (await page.locator('.chat-tab').count()) {
    await page.locator('.chat-tab .chat-tab-close').first().click();
  }
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.chat-tab').count(), 0, 'all chat tabs closed');
  await page.locator('.chat-main .home').waitFor();
  await page.screenshot({ path: `${shots}/desk-chat-home.png` });

  // Light pixel theme.
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.locator('.theme-option').filter({ has: page.locator('.theme-name', { hasText: /^Electric Light$/ }) }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-color-scheme'), 'light');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/desk-electric-light.png` });

  // Sidebar project row: no account pills; clicking the selected project folds its conversations.
  await page.getByRole('radio', { name: 'Terminal view' }).click().catch(async () => page.locator('.view-switch button').first().click());
  assert.equal(await page.locator('.sidebar .pill, .project-accounts, .project-sessions-toggle').count(), 0, 'no account pills or Conversations row');
  const row = page.locator('.sidebar .project').first();
  const before = await row.getAttribute('aria-expanded');
  await row.click();
  assert.notEqual(await row.getAttribute('aria-expanded'), before, 'clicking the selected project toggles its conversations');
  if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
  assert.equal(await row.getAttribute('aria-expanded'), 'true');

  // Six subscriptions: one ring each, the row scrolls sideways, footer buttons stay put.
  await page.evaluate(() => localStorage.setItem('test-detected', JSON.stringify(
    ['work', 'personal', 'team'].flatMap((n, i) => [
      { kind: 'claude', dir: `/demo/.claude-${n}`, path: `/demo/.claude-${n}`, email: `${n}@example.com`, org: null, signedIn: true },
      ...(i < 2 ? [{ kind: 'codex', dir: `/demo/.codex-${n}`, path: `/demo/.codex-${n}`, email: null, org: null, signedIn: true }] : []),
    ]))));
  await page.reload();
  await page.locator('.sidebar-foot .usage-ring').nth(6).waitFor();
  assert.equal(await page.locator('.sidebar-foot .usage-ring').count(), 7, 'one ring per account');
  const scroll = page.locator('.usage-rings-scroll');
  assert.ok(await scroll.evaluate(el => el.scrollWidth > el.clientWidth), 'rings overflow into a scroller');
  assert.ok(await scroll.evaluate(el => el.classList.contains('fade-end')), 'faded edge shows more rings');
  for (const name of ['Animated background', 'Settings']) assert.ok(await page.locator('.sidebar-foot').getByRole(name === 'Settings' ? 'button' : 'switch', { name, exact: true }).isVisible(), `${name} stays visible`);
  const badge = await page.locator('.usage-ring-value').first().boundingBox(), clip = await scroll.boundingBox();
  assert.ok(badge.y + badge.height <= clip.y + clip.height + .5 && badge.x >= clip.x - .5, '% badge not clipped');
  await scroll.hover();
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(100);
  assert.ok(await scroll.evaluate(el => el.scrollLeft > 0), 'mouse wheel scrolls the rings');
  await page.screenshot({ path: `${shots}/desk-rings-overflow.png` });

  // The usage popover sits above every sidebar section (it used to slide under SSH).
  await page.locator('.sidebar-foot .usage-ring').first().click();
  const pop = page.locator('.usage-popover');
  await pop.waitFor();
  const box = await pop.boundingBox();
  for (const [fx, fy] of [[.5, .2], [.5, .5], [.5, .8]]) {
    const inside = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.usage-popover'), [box.x + box.width * fx, box.y + box.height * fy]);
    assert.ok(inside, `usage popover on top at ${fx},${fy}`);
  }
  assert.equal(await pop.locator('.usage-account').count(), 1, 'popover shows only the clicked account');
  assert.ok(await pop.locator('.tool-logo').count() >= 1, 'popover shows the tool logo');
  assert.ok(await page.locator('.sidebar-foot .usage-ring .tool-logo').count() >= 7, 'rings use real tool logos');
  await page.screenshot({ path: `${shots}/desk-usage-popover.png` });

  // Settings ▸ Usage lists every account and switches to "remaining".
  await page.locator('.usage-all').click();
  await page.locator('.usage-settings').waitFor();
  assert.equal(await page.locator('.usage-settings .usage-card').count(), 7);
  await page.getByRole('radio', { name: 'Remaining' }).click();
  await page.locator('.usage-settings .usage-window-used', { hasText: '58% left' }).first().waitFor();
  await page.screenshot({ path: `${shots}/desk-usage-settings.png` });
  await page.getByRole('radio', { name: 'Used' }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // Adding a Gemini account: tells you Desk will install the CLI, and spawns nothing until you continue.
  const spawnsBefore = await page.evaluate(() => window.testCalls.filter((c) => c.cmd === 'pty_spawn').length);
  await page.locator('.sidebar').getByRole('button', { name: 'Add account', exact: true }).click();
  await page.getByRole('radio', { name: 'Gemini CLI' }).click();
  await page.locator('.install-note', { hasText: 'npm install -g @google/gemini-cli' }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Install and sign in' }).isVisible());
  await page.getByRole('radio', { name: 'Grok' }).click();
  await page.locator('.install-note', { hasText: 'https://x.ai/cli/install.sh' }).waitFor();
  await page.getByRole('radio', { name: 'Claude Code' }).click();
  await page.getByRole('button', { name: 'Create and sign in' }).waitFor();
  assert.equal(await page.locator('.install-note').count(), 0, 'no install note for an installed CLI');
  assert.equal(await page.evaluate(() => window.testCalls.filter((c) => c.cmd === 'pty_spawn').length), spawnsBefore, 'nothing runs before you continue');
  await page.getByRole('radio', { name: 'Gemini CLI' }).click();
  await page.screenshot({ path: `${shots}/desk-add-gemini.png` });
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Every light pixel theme renders the light scheme with the backdrop.
  for (const name of ['Ember Light', 'Aurora Light', 'Snow', 'Onyx', 'Charcoal', 'Obsidian']) {
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.locator('.theme-option').filter({ has: page.locator('.theme-name', { hasText: new RegExp(`^${name}$`) }) }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('data-color-scheme'), ['Onyx', 'Charcoal', 'Obsidian'].includes(name) ? 'dark' : 'light');
    assert.equal(await page.locator('.ambient canvas').count() >= 1, true, `${name} has the pixel backdrop`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${shots}/desk-${name.toLowerCase().replace(' ', '-')}.png` });
  }

  // Home backdrop stays fixed while the content scrolls (no hard edge mid-screen).
  const home = page.locator('.home').first();
  if (await home.count()) {
    const top0 = await page.locator('.home-shell > .ambient').first().evaluate(el => el.getBoundingClientRect().top);
    await home.evaluate(el => { el.scrollTop = 400; });
    assert.equal(await page.locator('.home-shell > .ambient').first().evaluate(el => el.getBoundingClientRect().top), top0, 'backdrop does not scroll');
  }

  // Minimum window size still lays out.
  await page.setViewportSize({ width: 960, height: 600 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/desk-home-min.png` });
  assert.deepEqual(errors, []);
  console.log('PASS: home grid, chat close-all shows Home, animation switch, sidebar dropdown, 7 scrolling usage rings, popover on top, per-account popover, Settings usage + remaining, add-account install notice, pixel backdrop on every theme, fixed backdrop, minimum size; no browser errors.');
} catch (e) {
  await page.screenshot({ path: `${shots}/desk-home-failure.png` });
  throw e;
} finally { await browser.close(); }

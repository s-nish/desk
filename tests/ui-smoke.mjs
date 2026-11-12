// Run against npm run dev. Uses an isolated browser and mocked desktop services.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mockDesktop } from './desktop-mock.mjs';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(mockDesktop);
  await page.goto(process.env.DESK_TEST_URL || 'http://127.0.0.1:1421');
  await page.getByText('Good work starts here.').waitFor();
  await page.getByRole('button', { name: 'Add project folder', exact: true }).last().click();
  await page.getByRole('heading', { name: 'studio', exact: true }).waitFor();
  // Command palette is discoverable and handles keyboard selection.
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await page.getByRole('combobox').fill('theme light');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'paper');
  await page.keyboard.press('Meta+Shift+p');
  await page.getByRole('combobox').fill('open file');
  await page.keyboard.press('Enter');
  await page.getByPlaceholder('Open a file in studio').fill('a.ts');
  await page.keyboard.press('Enter');
  await page.locator('.cm-editor').waitFor();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+End');
  await page.keyboard.insertText('// unsaved recovery');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('desk-recovery-v2') || '{}').tabs?.some((t) => t.recovery?.content.includes('unsaved recovery')));
  // Auto-created second pane starts one shell; opening/switching keeps it alive.
  await page.getByRole('button', { name: 'Toggle split panes' }).click();
  await page.locator('.xterm').waitFor();
  assert.equal(await page.locator('.workspace-pane:visible').count(), 2);
  assert.equal(await page.evaluate(() => window.testCalls.filter((c) => c.cmd === 'pty_spawn').length), 1);
  await page.getByRole('separator', { name: 'Resize split panes' }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('separator', { name: 'Resize split panes' }).getAttribute('aria-valuenow'), '55');
  if (process.env.DESK_SCREENSHOT) await page.screenshot({ path: process.env.DESK_SCREENSHOT.replace('.png', '-split.png') });
  // Reordering preserves the selected tab, split panes and running terminal.
  const tabOrder = () => page.locator('.tabs [data-tab-id]').evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tabId));
  const originalOrder = await tabOrder();
  const selectedId = await page.locator('.tabs [aria-selected="true"]').getAttribute('data-tab-id');
  const first = await page.getByRole('tab').first().boundingBox();
  const last = await page.getByRole('tab').last().boundingBox();
  await page.mouse.move(first.x + 25, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width - 5, last.y + last.height / 2, { steps: 12 });
  await page.mouse.up();
  assert.deepEqual(await tabOrder(), [...originalOrder].reverse());
  assert.equal(await page.locator('.tabs [aria-selected="true"]').getAttribute('data-tab-id'), selectedId);
  assert.equal(await page.evaluate(() => window.testCalls.filter((c) => c.cmd === 'pty_spawn').length), 1);
  assert.equal(await page.locator('.workspace-pane:visible').count(), 2);
  await page.getByRole('tab').first().focus();
  await page.keyboard.press('Alt+Shift+ArrowRight');
  assert.deepEqual(await tabOrder(), originalOrder);
  await page.getByRole('tab').last().focus();
  await page.keyboard.press('Alt+Shift+ArrowLeft');
  const reorderedIds = await tabOrder();
  assert.deepEqual(reorderedIds, [...originalOrder].reverse());
  const cancelFrom = await page.getByRole('tab').first().boundingBox();
  const cancelTo = await page.getByRole('tab').last().boundingBox();
  await page.mouse.move(cancelFrom.x + 25, cancelFrom.y + 17);
  await page.mouse.down();
  await page.mouse.move(cancelTo.x + cancelTo.width - 5, cancelTo.y + 17, { steps: 8 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.deepEqual(await tabOrder(), reorderedIds);
  if (process.env.DESK_SCREENSHOT) await page.screenshot({ path: process.env.DESK_SCREENSHOT.replace('.png', '-tabs.png') });
  // Recovery saves tab layout, drafts and resumes terminals only on explicit restart.
  await page.reload();
  await page.getByText('Session restored', { exact: true }).waitFor();
  assert.deepEqual(await tabOrder(), reorderedIds);
  await page.locator('.cm-content').getByText('// unsaved recovery', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.testCalls.filter((c) => c.cmd === 'pty_spawn').length), 0);
  assert.equal(await page.locator('.workspace-pane:visible').count(), 2);
  await page.getByRole('button', { name: 'Restart Shell' }).click();
  await page.locator('.xterm').waitFor();
  // Search replacement skips open dirty files and updates safe files.
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByLabel('Search project text').fill('hello');
  await page.getByText('2 matches in 2 files', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Replace…', exact: true }).click();
  await page.getByLabel('Replacement text').fill('goodbye');
  await page.getByRole('button', { name: 'Replace all 2 matches' }).click();
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await page.getByText('1 file(s) updated. 1 unsaved file(s) skipped.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.testFiles['/demo/studio/b.ts']), 'goodbye world\n');
  // Git diff, stage, unstage and commit are bound to the selected repository.
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  await page.getByRole('button', { name: 'Review a.ts', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review changes' }).getByText('new', { exact: true }).waitFor();
  if (process.env.DESK_SCREENSHOT) await page.screenshot({ path: process.env.DESK_SCREENSHOT.replace('.png', '-diff.png') });
  // Another agent reviews the changes; its finding lands on the line and can be left out.
  const review = page.getByRole('dialog', { name: 'Review changes' });
  await review.getByRole('button', { name: /Review with/ }).click();
  await page.getByRole('menuitem', { name: /Codex/ }).click();
  await review.getByText('Renamed without callers').waitFor();
  await review.getByText('1 of 1 comment').waitFor();
  await review.getByLabel("Send Codex's comment").uncheck();
  await review.getByText('0 of 1 comment').waitFor();
  assert.ok(await review.getByRole('button', { name: 'Send to agent' }).isDisabled());
  if (process.env.DESK_SCREENSHOT) await page.screenshot({ path: process.env.DESK_SCREENSHOT.replace('.png', '-crossreview.png') });
  await review.getByRole('button', { name: 'Delete comment' }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Stage a.ts', exact: true }).click();
  await page.getByRole('button', { name: 'Unstage a.ts', exact: true }).click();
  await page.getByRole('button', { name: 'Stage a.ts', exact: true }).click();
  await page.getByLabel('Commit message').fill('Update greeting');
  await page.getByRole('button', { name: 'Commit 1 file', exact: true }).click();
  await page.getByText("No changes", { exact: true }).waitFor();
  // Dirty buffer changes outside Desk surface a conflict on restoration.
  await page.evaluate(() => { window.testFiles['/demo/studio/a.ts'] = 'external change\n'; localStorage.setItem('test-files', JSON.stringify(window.testFiles)); });
  await page.reload();
  await page.getByText('This file changed on disk while you were editing it.').waitFor();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+s');
  await page.getByRole('dialog', { name: 'Overwrite the disk version?' }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.evaluate(() => window.testFiles['/demo/studio/a.ts']), 'external change\n');
  // Closing one pane promotes the other rather than leaving a blank workspace.
  await page.getByRole('tab').filter({ hasText: 'Shell' }).getByRole('button', { name: 'Close Shell' }).click();
  assert.equal(await page.locator('.workspace-pane:visible').count(), 1);
  await page.setViewportSize({ width: 960, height: 600 });
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await page.getByRole('combobox').fill('no-such-command-zzzz');
  await page.getByText('No matching commands.').waitFor();
  await page.keyboard.press('Escape');
  if (process.env.DESK_SCREENSHOT) await page.screenshot({ path: process.env.DESK_SCREENSHOT });
  // Native quit waits for a final state_save before requesting workspace_exit.
  await page.evaluate(() => {
    const listener = window.testCalls.find((c) => c.cmd === 'plugin:event|listen' && c.args.event === 'desk-quit');
    window.testCallbacks.get(listener.args.handler)({ event: 'desk-quit', payload: null });
  });
  await page.waitForFunction(() => window.testCalls.some((c) => c.cmd === 'workspace_exit'));
  const calls = await page.evaluate(() => window.testCalls.map((c) => c.cmd));
  assert.ok(calls.lastIndexOf('state_save') < calls.lastIndexOf('workspace_exit'));
  assert.deepEqual(errors, []);
  console.log('PASS: palette, split panes, resize, draft/session restoration, external-edit conflicts, search/replace dirty-file protection, Git diff/stage/unstage/commit, cross-agent review, minimum window size; no browser errors.');
} catch (e) {
  if (page) { await page.screenshot({ path: '/private/tmp/desk-ui-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw e;
} finally { await browser.close(); }

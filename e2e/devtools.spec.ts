import { expect, go, test } from './fixtures';

test('take a ticket over, then hand it back to the Tester', async ({ page, factory }) => {
  const t = await factory.ticket('Tweak the copy');
  await factory.waitForStage(t.id, 'awaiting_approval');
  await go(page, 'board');
  await page.locator('.tcard', { hasText: t.key }).click();
  await page.getByRole('button', { name: /Take over/ }).click();
  await expect(page.locator('.handoff')).toContainText('You have this one');
  await factory.waitForStage(t.id, 'manual');
  await page.getByPlaceholder(/What did you change/).fill('Reworded the button');
  await page.getByRole('button', { name: /Hand back/ }).click();
  await factory.waitForStage(t.id, 'awaiting_approval');
  const s = await factory.state();
  expect(s.tickets.find((x: { id: string }) => x.id === t.id).notes.at(-1).text).toContain('Reworded the button');
});

test('ask a ticket a question', async ({ page, factory }) => {
  const t = await factory.ticket('Add CSV export');
  await factory.waitForStage(t.id, 'awaiting_approval');
  await go(page, 'board');
  await page.locator('.tcard', { hasText: t.key }).click();
  await page.getByRole('button', { name: /^Ask/ }).click();
  await page.getByRole('button', { name: 'Do the tests pass?' }).click();
  await expect(page.locator('.qa .a').last()).toContainText('Tests pass');
  await page.getByPlaceholder(`Ask about ${t.key}…`).fill('what files changed?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.qa .a').last()).toContainText('src/features/');
});

test('a ticket can wait on another one', async ({ page, factory }) => {
  await page.request.post('/api/factory/pause', { data: { paused: true } });
  const a = await factory.ticket('First', 'backlog');
  const b = await factory.ticket('Second', 'backlog');
  await go(page, 'board');
  await page.locator('.tcard', { hasText: b.key }).click();
  await page.getByRole('button', { name: '＋ Add' }).click();
  await page.locator('.drawer select').last().selectOption(a.id);
  await expect(page.locator('.chip.dep')).toContainText(a.key);
  await page.request.patch(`/api/tickets/${b.id}`, { data: { stage: 'ready' } });
  await page.request.post('/api/factory/pause', { data: { paused: false } });
  await expect.poll(async () => (await factory.state()).tickets.find((x: { id: string }) => x.id === b.id)?.waitingOn?.keys).toEqual([a.key]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.tcard', { hasText: b.key })).toContainText(`⛓ ${a.key}`);
});

test('coming back after a while shows what happened', async ({ page, factory }) => {
  const t = await factory.ticket('Happened while away');
  await factory.waitForStage(t.id, 'awaiting_approval');
  await page.addInitScript(() => localStorage.setItem('factory.lastSeen', String(Date.now() - 3 * 3_600_000)));
  await go(page, 'board');
  await expect(page.locator('.away')).toContainText('While you were away');
  await expect(page.locator('.away')).toContainText(`Sign off ${t.key}`);
  await page.getByRole('button', { name: 'Got it' }).click();
  await expect(page.locator('.away')).toHaveCount(0);
});

import { expect, go, test } from './fixtures';

test('sign-offs show the safety score and proof for each acceptance criterion', async ({ page, factory }) => {
  const t = await factory.ticket('Add CSV export', 'ready', '## Acceptance criteria\n- [ ] Export button downloads the rows\n- [ ] The file has a header row');
  await factory.waitForStage(t.id, 'awaiting_approval');
  await go(page, 'inbox');
  const card = page.locator('.acard', { hasText: `Sign off ${t.key}` });
  await expect(card.locator('.safety')).toContainText('High confidence');
  await expect(card.locator('.proof')).toContainText('2/2 proven');
  await expect(card.locator('.proof')).toContainText('The file has a header row');
  await card.getByRole('button', { name: 'Why?' }).click();
  await expect(card.locator('.reasons')).toContainText('CI is green');
});

test('a shipped ticket can be reverted from its drawer, which queues a redo', async ({ page, factory }) => {
  const t = await factory.ticket('Fix date formatting');
  await factory.waitForStage(t.id, 'awaiting_approval');
  await page.request.post(`/api/tickets/${t.id}/approve`, { data: {} });
  await factory.waitForStage(t.id, 'done');
  await expect.poll(async () => (await factory.state()).tickets.find((x: { id: string }) => x.id === t.id)?.ship?.smoke?.state).toBe('passed');

  await go(page, 'board');
  await page.locator('.tcard', { hasText: t.key }).click();
  await expect(page.locator('.shippanel')).toContainText('Smoke test passed');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: /Revert & redo/ }).click();
  await expect(page.locator('.shippanel')).toContainText('Reverted');
  await expect.poll(async () => (await factory.state()).tickets.some((x: { title: string }) => x.title === `Redo ${t.key}: Fix date formatting`)).toBe(true);
});

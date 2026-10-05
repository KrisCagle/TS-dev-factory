import { expect, go, test } from './fixtures';

test('shipping celebrates, awards XP and shows up in the Trophy room', async ({ page, factory }) => {
  await go(page, 'board');
  const before = (await factory.state()).game.xp;
  const t = await factory.ticket('Ship for XP', 'ready', '## Acceptance criteria\n- [ ] It works');
  await factory.waitForStage(t.id, 'awaiting_approval');
  await page.request.post(`/api/tickets/${t.id}/approve`, { data: {} });
  await expect(page.locator('.celebrate.ship')).toContainText(`Shipped ${t.key}`);
  await expect.poll(async () => (await factory.state()).game.xp).toBeGreaterThan(before);

  await page.locator('.gpill').click();
  await expect(page.locator('.gpop')).toContainText('Today’s quests');
  await page.locator('.gpop').getByRole('button', { name: /Trophy room/ }).click();
  await expect(page.locator('.topbar h1')).toHaveText('Trophy room');
  await expect(page.locator('.ach.on').first()).toBeVisible();
  await expect(page.locator('.tcard-agent')).toHaveCount(4);
  await expect(page.locator('.xplog')).toContainText(`Shipped ${t.key}`);
});

test('gamification can be switched off everywhere', async ({ page, factory: _ }) => {
  await go(page, 'trophies');
  await page.getByRole('button', { name: 'Turn gamification off' }).click();
  await expect(page.locator('.gpill')).toHaveCount(0);
  await expect(page.getByText('Gamification is switched off.')).toBeVisible();
  await page.getByRole('button', { name: 'Turn it on' }).click();
  await expect(page.locator('.gpill')).toBeVisible();
});

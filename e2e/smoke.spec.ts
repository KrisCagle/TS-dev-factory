import { expect, go, test } from './fixtures';

const VIEWS: Array<[string, string]> = [
  ['inbox', 'Needs you'], ['office', 'Office'], ['board', 'Board'], ['reports', 'Reports'],
  ['agents', 'Agents'], ['rules', 'House rules'], ['activity', 'Activity'], ['settings', 'Settings'],
];

test('every page renders without errors', async ({ page, factory: _ }) => {
  for (const [hash, title] of VIEWS) {
    await go(page, hash);
    await expect(page.locator('.topbar h1')).toHaveText(title);
  }
});

test('keyboard shortcuts navigate', async ({ page, factory: _ }) => {
  await go(page, 'office');
  await page.keyboard.press('g');
  await page.keyboard.press('b');
  await expect(page.locator('.topbar h1')).toHaveText('Board');
  await page.keyboard.press('g');
  await page.keyboard.press('r');
  await expect(page.locator('.topbar h1')).toHaveText('Reports');
});

test('the office loads demo tickets and agents start working', async ({ page, factory }) => {
  await go(page, 'office');
  await page.getByRole('button', { name: /Load demo tickets/ }).click();
  await expect.poll(async () => (await factory.state()).tickets.length).toBeGreaterThan(3);
  await expect.poll(async () => (await factory.state()).factory.running.length, { timeout: 20_000 }).toBeGreaterThan(0);
  await go(page, 'board');
  await expect(page.locator('.tcard').first()).toBeVisible();
});

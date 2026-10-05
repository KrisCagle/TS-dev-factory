import { expect, go, test } from './fixtures';

test('settings show the Claude, Slack, Sentry and plugin integrations', async ({ page, factory: _ }) => {
  await go(page, 'settings');
  await expect(page.getByRole('heading', { name: /Use it from Claude/ })).toBeVisible();
  await expect(page.locator('code.cmd').first()).toHaveText('/plugin marketplace add KrisCagle/TS-dev-factory');
  await expect(page.getByRole('heading', { name: /Approve from Slack/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Plugins/ })).toBeVisible();
  // Sentry connector form opens when switched on
  await page.locator('.row', { has: page.getByText('🐞 Sentry', { exact: true }) }).locator('button.toggle').click();
  await expect(page.getByPlaceholder('acme')).toBeVisible();
  await expect(page.getByText('Unsaved factory settings')).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
});

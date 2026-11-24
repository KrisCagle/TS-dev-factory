import { expect, go, test } from './fixtures';

test('a session works in your repo, posts a review, and wraps up when you validate it', async ({ page }) => {
  await go(page, 'sessions');
  await page.getByRole('button', { name: '＋ New session' }).click();
  await page.getByPlaceholder(/What should it do/).fill('Add a CSV export to the reports page');
  await page.getByRole('button', { name: 'Start', exact: true }).click();

  const detail = page.locator('.sdcard');
  await expect(detail.locator('h2')).toHaveText('Add a CSV export to the reports page');
  await expect(detail.locator('.sev.tool').first()).toBeVisible();
  const review = detail.locator('.acard', { hasText: 'Review:' });
  await expect(review).toBeVisible();
  await expect(detail.locator('.sreport')).toContainText('REVIEW');

  // the same item is in Needs you, labelled with where it came from
  await go(page, 'inbox');
  const card = page.locator('.acard', { hasText: 'Review:' }).first();
  await expect(card.locator('.chip.origin')).toContainText('Session');
  await card.getByRole('button', { name: /Start review/ }).click();
  await page.getByRole('button', { name: /Start case 1/ }).click();
  for (let i = 0; i < 10; i++) {
    const approve = page.getByRole('button', { name: '✓ Approve' });
    if (!(await approve.isVisible().catch(() => false))) break;
    await approve.click();
  }
  await page.getByRole('button', { name: /Approve & ship|Send/ }).first().click();
  await go(page, 'sessions');
  await expect(page.locator('.sdcard .sreport')).toContainText('RESULT', { timeout: 20_000 });
});

test('permission requests land in your queue and Allow lets the session continue', async ({ page, request }) => {
  const s = await (await request.get('/api/state')).json();
  await request.patch('/api/settings', { data: { engine: { ...s.settings.engine, permissionMode: 'ask' } } });
  await request.post('/api/sessions', { data: { prompt: 'Run the test suite and fix what fails' } });
  await go(page, 'inbox');
  const ask = page.locator('.acard', { hasText: 'allow Bash?' });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('npm test');
  await ask.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.locator('.acard', { hasText: 'Review:' })).toBeVisible({ timeout: 20_000 });
});

test('a pipeline goes from scope to tickets on the board with your validations', async ({ page }) => {
  await go(page, 'pipelines');
  await page.getByPlaceholder(/Users can invite teammates/).fill('Users can invite teammates by email.\nAdmins can revoke pending invites.');
  await page.getByRole('button', { name: 'Start pipeline' }).click();

  const detail = page.locator('.sdcard');
  await expect(detail.getByText('📖 User stories (2)')).toBeVisible({ timeout: 20_000 });
  await detail.getByRole('button', { name: /Approve stories/ }).click();
  await expect(detail.getByText(/🎫 Tickets \(4/)).toBeVisible({ timeout: 20_000 });

  // send one draft back first: the note is required
  await expect(detail.getByRole('button', { name: /Send back/ })).toBeDisabled();
  await detail.getByRole('button', { name: /Approve tickets/ }).click();
  await expect(detail.locator('.chip', { hasText: /FAC-\d+/ }).first()).toBeVisible({ timeout: 20_000 });
  await expect(detail.getByText(/wave 2/).first()).toBeVisible();

  await go(page, 'board');
  await expect(page.locator('.card, .tcard', { hasText: 'Backend:' }).first()).toBeVisible();
});

test('the assistant takes typed requests and acts on them', async ({ page, request }) => {
  await go(page, 'office');
  await page.locator('.adock-fab').click();
  const dock = page.locator('.adock');
  await dock.getByPlaceholder('Type to the assistant…').fill('New ticket: add dark mode to the profile screen');
  await dock.getByPlaceholder('Type to the assistant…').press('Enter');
  await expect(dock.locator('.aturn.assistant').last()).toContainText(/Added FAC-\d+/);
  await expect(dock.locator('.chip', { hasText: 'Created' })).toBeVisible();
  const s = await (await request.get('/api/state')).json();
  expect(s.tickets.some((t: { title: string }) => t.title === 'Add dark mode to the profile screen')).toBe(true);

  await dock.getByPlaceholder('Type to the assistant…').fill('what needs me?');
  await dock.getByPlaceholder('Type to the assistant…').press('Enter');
  await expect(dock.locator('.aturn.assistant').last()).toContainText(/queue|need/i);
});

test('tickets can go to Scarif and come back done (simulated droids)', async ({ page, factory }) => {
  const t = await factory.ticket('Bump the API client', 'backlog');
  await go(page, 'board');
  await page.getByText('Bump the API client').first().click();
  await page.getByRole('button', { name: /Send to Scarif/ }).click();
  await expect(page.locator('.banner', { hasText: 'Scarif:' })).toBeVisible();
  await factory.waitForStage(t.id, 'done', 30_000);
});

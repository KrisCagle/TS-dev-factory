import { expect, go, test } from './fixtures';

test('a ticket goes from Ready to shipped through the review walkthrough', async ({ page, factory }) => {
  const t = await factory.ticket('Add CSV export to the reports table');
  await factory.waitForStage(t.id, 'awaiting_approval');

  await go(page, 'inbox');
  const card = page.locator('.acard', { hasText: `Sign off ${t.key}` }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Recommend');
  await card.getByRole('button', { name: /Start review/ }).click();
  await page.getByRole('button', { name: /Start case 1/ }).click();

  // approve every case, then ship
  for (let i = 0; i < 10; i++) {
    const approve = page.getByRole('button', { name: '✓ Approve' });
    if (!(await approve.isVisible().catch(() => false))) break;
    await approve.click();
  }
  await page.getByRole('button', { name: /Approve & ship/ }).click();
  await factory.waitForStage(t.id, 'done');

  await go(page, 'reports');
  await expect(page.getByText(t.key).first()).toBeVisible();
});

test('sending feedback from the walkthrough returns the ticket to the Coder', async ({ page, factory }) => {
  const t = await factory.ticket('Fix date formatting on invoices');
  await factory.waitForStage(t.id, 'awaiting_approval');
  await go(page, 'inbox');
  await page.locator('.acard', { hasText: `Sign off ${t.key}` }).getByRole('button', { name: /Start review/ }).click();
  await page.getByRole('button', { name: /Start case 1/ }).click();
  await page.getByPlaceholder(/describe what's wrong/i).fill('The date shows in UTC, not the customer’s timezone');
  await page.getByRole('button', { name: 'Send feedback' }).click();
  // skip to the summary and send it back
  await page.getByTitle('Summary').click();
  await page.getByRole('button', { name: /Send back with feedback/ }).click();
  await expect.poll(async () => (await factory.state()).tickets.find((x: { id: string }) => x.id === t.id)?.notes.at(-1)?.text ?? '').toContain('UTC');
});

test('the ticket writer drafts a ticket you can create', async ({ page, factory }) => {
  await go(page, 'board');
  await page.keyboard.press('n');
  await page.locator('.modal textarea').first().fill('customers say the invoice PDF shows the wrong date');
  await page.getByRole('button', { name: /Draft ticket/ }).click();
  await expect(page.getByPlaceholder('What needs doing?')).toHaveValue('Fix: invoice PDF shows the wrong date');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(async () => (await factory.state()).tickets.map((x: { title: string }) => x.title)).toContain('Fix: invoice PDF shows the wrong date');
});

test('projects: add one, switch to it, and new tickets get its prefix', async ({ page, factory }) => {
  await go(page, 'settings');
  await page.getByRole('button', { name: '＋ Add project' }).click();
  const name = page.locator('.proj').last().getByLabel('Name');
  await name.fill('Acme storefront');
  await page.locator('.proj').last().getByLabel('Ticket prefix').fill('ACME');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect.poll(async () => (await factory.state()).settings.projects.length).toBe(2);

  const acme = (await factory.state()).settings.projects.find((p: { name: string }) => p.name === 'Acme storefront');
  await page.locator('.pswitch select').selectOption(acme.id);
  await page.keyboard.press('n');
  await page.getByRole('button', { name: 'Write it myself' }).click();
  await page.getByPlaceholder('What needs doing?').fill('Acme only ticket');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(async () => (await factory.state()).tickets.find((x: { title: string }) => x.title === 'Acme only ticket')?.key).toBe('ACME-1');
});

test('house rules save and suggestions can be added', async ({ page, factory }) => {
  const t = await factory.ticket('Something', 'backlog');
  await page.request.post(`/api/tickets/${t.id}/notes`, { data: { text: 'Always use the shared logger' } });
  await go(page, 'rules');
  await page.getByRole('button', { name: /Add as rule/ }).first().click();
  await expect(page.locator('.rules-edit')).toHaveValue(/Always use the shared logger/);
  await page.getByRole('button', { name: 'Save' }).click();
  const s = await factory.state();
  const r = await (await page.request.get(`/api/projects/${s.settings.defaultProjectId}/rules`)).json();
  expect(r.text).toContain('Always use the shared logger');
});

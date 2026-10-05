import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';

/** Each test starts from an empty factory (tickets, inbox and extra projects cleared) and fails on console errors. */
export const test = base.extend<{ factory: Factory }>({
  factory: async ({ request }, use) => {
    const f = new Factory(request);
    await f.reset();
    await use(f);
  },
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      // fonts are fetched from the internet and may be blocked in CI sandboxes
      if (m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text())) errors.push(m.text());
    });
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('e2e-init')) {
        localStorage.clear();
        sessionStorage.setItem('e2e-init', '1');
      }
    });
    await use(page);
    expect(errors, 'browser console errors').toEqual([]);
  },
});
export { expect };

export class Factory {
  constructor(private api: APIRequestContext) {}

  async state() {
    return (await this.api.get('/api/state')).json();
  }

  async reset() {
    await this.api.post('/api/factory/pause', { data: { paused: true } });
    const s = await this.state();
    for (const t of s.tickets) await this.api.delete(`/api/tickets/${t.id}`);
    const def = s.settings.projects.find((p: { id: string }) => p.id === s.settings.defaultProjectId);
    await this.api.patch('/api/settings', { data: { projects: [def], gates: { plan: false, merge: true } } });
    await this.api.post('/api/factory/pause', { data: { paused: false } });
  }

  async ticket(title: string, stage: 'ready' | 'backlog' = 'ready') {
    return (await this.api.post('/api/tickets', { data: { title, stage } })).json();
  }

  async waitForStage(id: string, stage: string, timeout = 45_000) {
    await expect.poll(async () => (await this.state()).tickets.find((t: { id: string }) => t.id === id)?.stage, { timeout }).toBe(stage);
  }
}

export async function go(page: Page, view: string) {
  await page.goto(`/#${view}`);
  await expect(page.locator('.topbar h1')).toBeVisible();
}

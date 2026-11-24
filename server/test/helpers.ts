import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFactory, type FactoryOptions } from '../src/app.js';
import { seeded, type MockOptions } from '../src/agents/mock.js';
import type { Settings, Stage, Ticket } from '../src/types.js';

export function tmpData(name = 'db.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
  return path.join(dir, name);
}

export type TestFactory = ReturnType<typeof createFactory>;

/**
 * A simulated factory that runs ~300× faster than the demo, with seeded randomness
 * and (by default) agents that always succeed. Override outcomes per test.
 */
export function makeFactory(opts: { mock?: MockOptions; settings?: Partial<Settings>; dataFile?: string; speed?: number } = {}) {
  const factory = createFactory({
    dataFile: opts.dataFile ?? tmpData(),
    mode: 'mock',
    serveWeb: false,
    schedules: false,
    pluginsDir: '',
    speed: opts.speed ?? 0.01,
    mock: {
      speed: 0.003,
      random: seeded(42),
      testsPass: () => true,
      reviewRequestsChanges: () => false,
      hangs: () => false,
      ciPasses: () => true,
      smokePasses: () => true,
      coverageDrops: () => false,
      leavesUnproven: () => false,
      ...opts.mock,
    },
  });
  // quiet, predictable defaults for tests
  factory.store.updateSettings({
    concurrency: 4,
    notifications: { ...factory.store.settings().notifications, enabled: false },
    ...opts.settings,
  });
  return factory;
}

export async function waitFor<T>(fn: () => T | undefined | false | null, { timeout = 15_000, every = 20, what = 'condition' } = {}): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

export function waitForStage(f: TestFactory, id: string, stage: Stage | Stage[], timeout?: number): Promise<Ticket> {
  const want = Array.isArray(stage) ? stage : [stage];
  return waitFor(() => {
    const t = f.store.ticket(id);
    return t && want.includes(t.stage) ? t : undefined;
  }, { timeout, what: `${f.store.ticket(id)?.key} to reach ${want.join('/')} (now ${f.store.ticket(id)?.stage})` });
}

export function openItem(f: TestFactory, ticketId: string, keyPrefix?: string) {
  return f.store.attention().find((a) => a.ticketId === ticketId && a.status === 'open' && (!keyPrefix || a.key.startsWith(keyPrefix)));
}

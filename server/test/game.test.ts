import { afterEach, describe, expect, it } from 'vitest';
import { Game, dayKey, levelFor, previousWorkday, questsFor, type GameEvent } from '../src/game.js';
import { Store } from '../src/store.js';
import type { Ticket } from '../src/types.js';
import { makeFactory, openItem, waitFor, waitForStage, tmpData, type TestFactory } from './helpers.js';

const at = (iso: string) => () => new Date(iso);

function setup(now = at('2026-10-06T09:00:00')) {
  const store = new Store(tmpData());
  const events: GameEvent[] = [];
  const clock = { now };
  const game = new Game(store, (e) => events.push(e), { now: () => clock.now() });
  const ship = (over: Partial<Ticket> = {}) => {
    const t = store.createTicket({ title: over.title ?? 'Thing', stage: 'ready', projectId: over.projectId });
    store.updateTicket(t.id, { stage: 'reviewing', iterations: 0, ...over });
    return store.updateTicket(t.id, { stage: 'done', ship: { how: 'simulated', sha: 'x', at: clock.now().getTime() } })!;
  };
  return { store, game, events, ship, clock };
}

const high = { confidence: { score: 100, level: 'high' as const, reasons: [] }, testReport: { passed: true, summary: '', failures: [], criteria: [{ criterion: 'a', status: 'proven' as const }] } };

describe('levels and days', () => {
  it('levels up at the thresholds', () => {
    expect(levelFor(0)).toMatchObject({ level: 1, title: 'Intern' });
    expect(levelFor(149).level).toBe(1);
    expect(levelFor(150)).toMatchObject({ level: 2, title: 'Junior PM', next: 400 });
    expect(levelFor(1e9).title).toBe('Factory Legend');
  });
  it('skips weekends when looking for the previous working day', () => {
    expect(previousWorkday('2026-10-05')).toBe('2026-10-02'); // Monday → Friday
    expect(previousWorkday('2026-10-07')).toBe('2026-10-06');
  });
  it('gives three distinct quests per day, the same all day', () => {
    const a = questsFor('2026-10-06');
    expect(a).toHaveLength(3);
    expect(new Set(a.map((q) => q.id)).size).toBe(3);
    expect(questsFor('2026-10-06')).toEqual(a);
  });
});

describe('XP rewards quality, not volume', () => {
  it('a clean, proven, high-confidence ship is worth more than a messy one', () => {
    const a = setup();
    a.ship(high);
    const clean = a.store.game()!.xp;
    const b = setup();
    b.ship({ iterations: 3, confidence: { score: 40, level: 'low', reasons: [] } });
    const messy = b.store.game()!.xp;
    expect(clean).toBeGreaterThan(messy);
  });

  it('counts each ticket once, even if it is updated again after shipping', () => {
    const { store, ship } = setup();
    const t = ship(high);
    const xp = store.game()!.xp;
    store.updateTicket(t.id, { stage: 'done', title: 'renamed' });
    store.updateTicket(t.id, { stage: 'backlog' });
    store.updateTicket(t.id, { stage: 'done' });
    expect(store.game()!.xp).toBe(xp);
    expect(store.game()!.counters.ships).toBe(1);
  });

  it('celebrates the ship and the first achievements', () => {
    const { events, ship } = setup();
    ship(high);
    expect(events.some((e) => e.type === 'ship')).toBe(true);
    const ach = events.filter((e) => e.type === 'achievement').map((e) => (e as { achievement: { id: string } }).achievement.id);
    expect(ach).toEqual(expect.arrayContaining(['first_ship', 'clean_sweep', 'show_your_work']));
  });

  it('levels up and says so', () => {
    const { events, ship } = setup();
    for (let i = 0; i < 3; i++) ship(high);
    expect(events.find((e) => e.type === 'levelup')).toMatchObject({ level: 2, title: 'Junior PM' });
  });
});

describe('streaks', () => {
  it('grows on consecutive working days and survives a weekend', () => {
    const s = setup(at('2026-10-01T10:00:00')); // Thursday
    s.ship(high);
    s.clock.now = at('2026-10-02T10:00:00'); // Friday
    s.ship(high);
    s.clock.now = at('2026-10-05T10:00:00'); // Monday
    s.ship(high);
    expect(s.game.view().streak).toMatchObject({ current: 3, best: 3 });
  });
  it('resets after a missed working day', () => {
    const s = setup(at('2026-10-05T10:00:00'));
    s.ship(high);
    s.clock.now = at('2026-10-07T10:00:00');
    expect(s.game.view().streak.current).toBe(0);
    s.ship(high);
    expect(s.game.view().streak).toMatchObject({ current: 1, best: 1 });
  });
  it('earns "On a roll" at 5 days', () => {
    const s = setup(at('2026-10-05T10:00:00'));
    for (const d of ['05', '06', '07', '08', '09']) {
      s.clock.now = at(`2026-10-${d}T10:00:00`);
      s.ship(high);
    }
    expect(s.game.view().achievements.find((a) => a.id === 'on_a_roll')!.earnedAt).toBeTruthy();
  });
});

describe('achievements and quests', () => {
  it('Safe hands: 5 high-confidence ships in a row, reset by a low one', () => {
    const s = setup();
    for (let i = 0; i < 4; i++) s.ship(high);
    s.ship({ confidence: { score: 30, level: 'low', reasons: [] } });
    s.ship(high);
    expect(s.game.view().achievements.find((a) => a.id === 'safe_hands')!.earnedAt).toBeUndefined();
    for (let i = 0; i < 4; i++) s.ship(high);
    expect(s.game.view().achievements.find((a) => a.id === 'safe_hands')!.earnedAt).toBeTruthy();
  });

  it('Juggler: ships in 3 projects', () => {
    const s = setup();
    const d = s.store.projects()[0];
    s.store.updateSettings({ projects: [d, { ...d, id: 'b', keyPrefix: 'B' }, { ...d, id: 'c', keyPrefix: 'C' }] });
    s.ship({ projectId: d.id } as Partial<Ticket>);
    s.ship({ projectId: 'b' } as Partial<Ticket>);
    s.ship({ projectId: 'c' } as Partial<Ticket>);
    expect(s.game.view().achievements.find((a) => a.id === 'juggler')!.earnedAt).toBeTruthy();
  });

  it('Rulemaker and Wordsmith come from saving rules and using the ticket writer', () => {
    const s = setup();
    s.store.emit('game:event', { type: 'rules' });
    for (let i = 0; i < 5; i++) s.store.emit('game:event', { type: 'scoped' });
    const got = s.game.view().achievements.filter((a) => a.earnedAt).map((a) => a.id);
    expect(got).toEqual(expect.arrayContaining(['rulemaker', 'wordsmith']));
  });

  it('a revert costs XP, but reverting quickly earns "Owned it"', () => {
    const s = setup();
    const t = s.ship(high);
    const before = s.store.game()!.xp;
    s.store.emit('game:event', { type: 'revert', ticketId: t.id });
    const v = s.game.view();
    expect(v.achievements.find((a) => a.id === 'owned_it')!.earnedAt).toBeTruthy();
    expect(v.history.some((h) => h.xp < 0)).toBe(true);
    expect(v.xp).toBe(before - 20 + 50);
  });

  it('quick answers and inbox zero', () => {
    const s = setup(at('2026-10-06T09:00:00'));
    const item = s.store.postAttention({ kind: 'decision', key: 'k:1', ticketId: 't', title: 'q' });
    s.store.updateAttention(item.id, { status: 'resolved', resolution: { at: item.createdAt + 60_000 } });
    const v = s.game.view();
    expect(v.counters.quickAnswers).toBe(1);
    expect(v.achievements.find((a) => a.id === 'inbox_zero')!.earnedAt).toBeTruthy();
  });

  it('daily quests progress and reset the next day', () => {
    const s = setup(at('2026-10-06T09:00:00'));
    const quests = s.game.view().daily.quests;
    if (quests.some((q) => q.id === 'ship_2')) {
      s.ship(high);
      s.ship(high);
      expect(s.game.view().daily.quests.find((q) => q.id === 'ship_2')!.done).toBe(true);
    }
    s.clock.now = at('2026-10-07T09:00:00');
    const next = s.game.view().daily;
    expect(next.day).toBe('2026-10-07');
    expect(next.quests.every((q) => q.progress === 0)).toBe(true);
  });

  it('office unlocks follow level and achievements', () => {
    const s = setup();
    expect(s.game.view().unlocks.find((u) => u.id === 'trophies')!.unlocked).toBe(false);
    s.ship(high);
    expect(s.game.view().unlocks.find((u) => u.id === 'trophies')!.unlocked).toBe(true);
  });
});

describe('agent trading cards', () => {
  it('credits each agent for tickets they worked and what they caught', () => {
    const s = setup();
    s.ship({ ...high, plan: { summary: '', steps: [], risks: [], files: [] }, review: { verdict: 'approve', summary: '', comments: [] }, loops: { tests: 2, review: 1 }, iterations: 3, costByRole: { coder: 0.5, tester: 0.2 } });
    const a = s.game.view().agents;
    expect(a.coder.tickets).toBe(1);
    expect(a.coder.firstTry).toBe(0);
    expect(a.coder.costUsd).toBe(0.5);
    expect(a.tester.caught).toBe(2);
    expect(a.reviewer.caught).toBe(1);
    expect(a.planner.tickets).toBe(1);
  });
});

let f: TestFactory;
afterEach(async () => f?.close());

describe('game in the running factory', () => {
  it('awards XP when a ticket ships through the real pipeline and exposes it over the API', async () => {
    f = makeFactory();
    f.orch.start();
    const t = f.store.createTicket({ title: 'Ship me', stage: 'ready', description: '## Acceptance criteria\n- [ ] It works' });
    await waitForStage(f, t.id, 'awaiting_approval');
    f.orch.resolve(openItem(f, t.id, 'merge:')!.id, { option: 'ship' });
    await waitForStage(f, t.id, 'done');
    const v = await waitFor(() => f.game.view().xp > 0 && f.game.view(), { what: 'xp' });
    expect(v.counters.ships).toBe(1);
    expect(v.agents.coder.tickets).toBe(1);
    expect(v.weeklyHighlight?.key).toBe(t.key);
    expect(dayKey()).toBe(v.daily.day);
  });
});

import type { Store } from './store.js';
import type { Achievement, AgentCard, AgentRole, AttentionItem, GameState, GameView, Quest, Ticket } from './types.js';

/**
 * Gamification that rewards quality, not volume: XP comes from shipped, reviewed,
 * well-tested work and from keeping the agents unblocked — never from raw ticket count.
 * Everything is derived from what the factory already records, and every event is
 * idempotent, so replays and restarts never double-count.
 */

export const ROLES: AgentRole[] = ['planner', 'coder', 'tester', 'reviewer'];

export const LEVELS = [
  { at: 0, title: 'Intern' },
  { at: 150, title: 'Junior PM' },
  { at: 400, title: 'Product Manager' },
  { at: 800, title: 'Senior PM' },
  { at: 1400, title: 'Lead PM' },
  { at: 2200, title: 'Head of Product' },
  { at: 3300, title: 'Director of Shipping' },
  { at: 4700, title: 'VP of Shipping' },
  { at: 6500, title: 'Chief Factory Officer' },
  { at: 9000, title: 'Factory Legend' },
];

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_ship', icon: '🚀', title: 'Liftoff', desc: 'Ship your first ticket.' },
  { id: 'clean_sweep', icon: '🧼', title: 'Clean sweep', desc: 'Ship a ticket with zero rework loops.' },
  { id: 'show_your_work', icon: '✅', title: 'Show your work', desc: 'Ship a ticket with every acceptance criterion proven.' },
  { id: 'safe_hands', icon: '🛡', title: 'Safe hands', desc: 'Ship 5 high-confidence tickets in a row.' },
  { id: 'green_machine', icon: '🚦', title: 'Green machine', desc: '10 tickets in a row pass CI on the first try.' },
  { id: 'inbox_zero', icon: '📭', title: 'Inbox zero', desc: 'Clear the Needs you inbox before 10am.' },
  { id: 'quick_decider', icon: '⚡', title: 'Quick decider', desc: 'Answer 10 inbox items within 5 minutes of them arriving.' },
  { id: 'rulemaker', icon: '📐', title: 'Rulemaker', desc: 'Save house rules for a project.' },
  { id: 'wordsmith', icon: '✨', title: 'Wordsmith', desc: 'Draft 5 tickets with the ticket writer.' },
  { id: 'owned_it', icon: '↩️', title: 'Owned it', desc: 'Revert a broken ship within 30 minutes.' },
  { id: 'comeback', icon: '🔁', title: 'Comeback', desc: 'Ship a redo after a revert.' },
  { id: 'on_a_roll', icon: '🔥', title: 'On a roll', desc: 'Ship something on 5 working days in a row.' },
  { id: 'juggler', icon: '🤹', title: 'Juggler', desc: 'Ship in 3 different projects.' },
  { id: 'ten_down', icon: '🏅', title: 'Ten down', desc: 'Ship 10 tickets.' },
  { id: 'half_century', icon: '🏆', title: 'Half century', desc: 'Ship 50 tickets.' },
  { id: 'quest_master', icon: '🗺', title: 'Quest master', desc: 'Finish every daily quest in one day.' },
];

const QUEST_POOL: Array<Omit<Quest, 'progress' | 'done'>> = [
  { id: 'ship_2', icon: '🚀', title: 'Ship 2 tickets', goal: 2, xp: 25 },
  { id: 'inbox_clear', icon: '📭', title: 'Clear the inbox', goal: 1, xp: 20 },
  { id: 'proven_ship', icon: '✅', title: 'Ship a ticket with every criterion proven', goal: 1, xp: 25 },
  { id: 'quick_answers', icon: '⚡', title: 'Answer 3 inbox items within 5 minutes', goal: 3, xp: 20 },
  { id: 'write_ticket', icon: '✨', title: 'Write a ticket with the ticket writer', goal: 1, xp: 15 },
  { id: 'house_rule', icon: '📐', title: 'Add or update a house rule', goal: 1, xp: 15 },
  { id: 'first_try', icon: '🧼', title: 'Ship a ticket with no rework', goal: 1, xp: 25 },
  { id: 'walkthrough', icon: '🧾', title: 'Finish a review walkthrough', goal: 1, xp: 15 },
];

export const UNLOCKS: Array<{ id: string; icon: string; title: string; how: string; test: (g: GameState, level: number) => boolean }> = [
  { id: 'plants', icon: '🪴', title: 'Office plants', how: 'Reach level 2', test: (_g, l) => l >= 2 },
  { id: 'trophies', icon: '🏆', title: 'Trophy shelf in your office', how: 'Earn your first achievement', test: (g) => g.earned.length > 0 },
  { id: 'coffee', icon: '☕', title: 'Espresso bar in the break room', how: 'Reach level 3', test: (_g, l) => l >= 3 },
  { id: 'neon', icon: '🔥', title: 'Streak sign over the ship dock', how: 'A 3-day shipping streak', test: (g) => g.streak.best >= 3 },
  { id: 'arcade', icon: '🕹', title: 'Arcade cabinet', how: 'Reach level 5', test: (_g, l) => l >= 5 },
  { id: 'aquarium', icon: '🐠', title: 'Aquarium in the huddle room', how: 'Reach level 7', test: (_g, l) => l >= 7 },
  { id: 'gold_rocket', icon: '🌟', title: 'Golden rocket', how: 'Earn “Half century”', test: (g) => g.earned.some((e) => e.id === 'half_century') },
];

export function levelFor(xp: number) {
  let i = 0;
  while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1].at) i++;
  return { level: i + 1, title: LEVELS[i].title, floor: LEVELS[i].at, next: LEVELS[i + 1]?.at ?? LEVELS[i].at };
}

/** Agents level up from tickets they helped ship: every 5 tickets, slowing down later. */
export function agentLevel(xp: number) {
  return Math.max(1, Math.floor(Math.sqrt(xp / 60)) + 1);
}

export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The previous working day (weekends don't break a streak). */
export function previousWorkday(day: string) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  do dt.setDate(dt.getDate() - 1);
  while (dt.getDay() === 0 || dt.getDay() === 6);
  return dayKey(dt);
}

/** Three quests a day, picked the same way all day so they don't reshuffle. */
export function questsFor(day: string): Quest[] {
  let h = 2166136261;
  for (const c of day) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const pool = [...QUEST_POOL];
  const out: Quest[] = [];
  while (out.length < 3 && pool.length) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    const [q] = pool.splice(h % pool.length, 1);
    out.push({ ...q, progress: 0, done: false });
  }
  return out;
}

const emptyCard = (role: AgentRole): AgentCard => ({ role, level: 1, xp: 0, tickets: 0, firstTry: 0, caught: 0, costUsd: 0, bestStreak: 0, streak: 0 });

export function freshGame(day = dayKey()): GameState {
  return {
    xp: 0,
    earned: [],
    streak: { current: 0, best: 0 },
    daily: { day, quests: questsFor(day) },
    agents: Object.fromEntries(ROLES.map((r) => [r, emptyCard(r)])) as Record<AgentRole, AgentCard>,
    counters: {},
    shippedProjects: [],
    highlights: [],
    history: [],
  };
}

export type GameEvent =
  | { type: 'xp'; amount: number; why: string }
  | { type: 'achievement'; achievement: Achievement; xp: number }
  | { type: 'levelup'; level: number; title: string }
  | { type: 'quest'; quest: Quest }
  | { type: 'ship'; ticketId: string; key: string; title: string; xp: number; score?: number; firstTry: boolean };

export class Game {
  private stages = new Map<string, string>();
  private resolved = new Set<string>();
  private now: () => Date;

  /** `emit` receives celebrations for the UI (ship, achievements, level-ups, quests). */
  constructor(private store: Store, private emit: (e: GameEvent) => void = () => undefined, opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
    for (const t of store.tickets()) this.stages.set(t.id, t.stage);
    for (const a of store.attention()) if (a.status === 'resolved') this.resolved.add(a.id);
    if (!store.game()) store.setGame(freshGame(dayKey(this.now())));

    store.on('ticket', (t: Ticket) => {
      const prev = this.stages.get(t.id);
      this.stages.set(t.id, t.stage);
      if (prev !== undefined && prev !== 'done' && t.stage === 'done') this.onShip(t);
    });
    store.on('attention', (items: AttentionItem[]) => this.onAttention(items));
    store.on('game:event', (e: { type: string; ticketId?: string }) => this.onSignal(e));
  }

  // ------------------------------------------------------------------ read
  view(): GameView {
    const g = this.state();
    const lv = levelFor(g.xp);
    const earnedAt = new Map(g.earned.map((e) => [e.id, e.at]));
    const weekAgo = this.now().getTime() - 7 * 86_400_000;
    const weekly = g.highlights.filter((h) => h.at >= weekAgo).sort((a, b) => b.score - a.score || b.at - a.at)[0];
    return {
      ...g,
      level: lv.level,
      title: lv.title,
      levelFloor: lv.floor,
      nextLevelAt: lv.next,
      achievements: ACHIEVEMENTS.map((a) => ({ ...a, earnedAt: earnedAt.get(a.id) })),
      unlocks: UNLOCKS.map((u) => ({ id: u.id, icon: u.icon, title: u.title, how: u.how, unlocked: u.test(g, lv.level) })),
      weeklyHighlight: weekly,
    };
  }

  /** Current state, rolling over to today's quests if the day changed. */
  private state(): GameState {
    const g = this.store.game() ?? freshGame(dayKey(this.now()));
    const today = dayKey(this.now());
    if (g.daily.day !== today) {
      g.daily = { day: today, quests: questsFor(today) };
      // a streak survives weekends, but not a missed working day
      if (g.streak.lastDay && g.streak.lastDay !== today && g.streak.lastDay !== previousWorkday(today)) g.streak.current = 0;
      this.store.setGame(g);
    }
    return g;
  }

  private save(g: GameState) {
    this.store.setGame(g);
    this.store.emit('game', this.view());
  }

  // ------------------------------------------------------------------ write helpers
  private award(g: GameState, amount: number, why: string) {
    if (!amount) return;
    const before = levelFor(g.xp).level;
    g.xp = Math.max(0, g.xp + amount);
    g.history = [{ at: this.now().getTime(), xp: amount, why }, ...g.history].slice(0, 100);
    this.emit({ type: 'xp', amount, why });
    const after = levelFor(g.xp);
    if (after.level > before) this.emit({ type: 'levelup', level: after.level, title: after.title });
  }

  private earn(g: GameState, id: string, ticketKey?: string) {
    if (g.earned.some((e) => e.id === id)) return;
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    if (!a) return;
    g.earned.push({ id, at: this.now().getTime(), ticketKey });
    this.emit({ type: 'achievement', achievement: a, xp: 50 });
    this.award(g, 50, `Achievement: ${a.title}`);
  }

  private bump(g: GameState, key: string, by = 1) {
    g.counters[key] = (g.counters[key] ?? 0) + by;
    return g.counters[key];
  }

  private quest(g: GameState, id: string, by = 1) {
    const q = g.daily.quests.find((x) => x.id === id);
    if (!q || q.done) return;
    q.progress = Math.min(q.goal, q.progress + by);
    if (q.progress >= q.goal) {
      q.done = true;
      this.emit({ type: 'quest', quest: q });
      this.award(g, q.xp, `Quest: ${q.title}`);
      if (g.daily.quests.every((x) => x.done)) this.earn(g, 'quest_master');
    }
  }

  // ------------------------------------------------------------------ events
  private onShip(t: Ticket) {
    const g = this.state();
    if (g.counters[`shipped:${t.id}`]) return; // already counted
    g.counters[`shipped:${t.id}`] = 1;
    const today = dayKey(this.now());
    const firstTry = t.iterations === 0 && !t.loops?.pm;
    const criteria = t.testReport?.criteria ?? [];
    const allProven = criteria.length > 0 && criteria.every((c) => c.status === 'proven');
    const score = t.confidence?.score;

    // XP: quality, not volume
    const xp = 40 + Math.round((score ?? 60) / 4) + (firstTry ? 15 : 0) + (allProven ? 10 : 0);
    this.award(g, xp, `Shipped ${t.key}`);
    this.emit({ type: 'ship', ticketId: t.id, key: t.key, title: t.title, xp, score, firstTry });

    const shipped = this.bump(g, 'ships');
    if (!g.shippedProjects.includes(t.projectId)) g.shippedProjects.push(t.projectId);

    // streak of working days with a ship
    if (g.streak.lastDay !== today) {
      g.streak.current = g.streak.lastDay === previousWorkday(today) ? g.streak.current + 1 : 1;
      g.streak.lastDay = today;
      g.streak.best = Math.max(g.streak.best, g.streak.current);
    }

    // in-a-row counters
    g.counters.highInARow = t.confidence?.level === 'high' ? (g.counters.highInARow ?? 0) + 1 : 0;
    if (t.ci) g.counters.ciFirstTryInARow = !t.loops?.ci ? (g.counters.ciFirstTryInARow ?? 0) + 1 : 0;

    // agent trading cards
    for (const role of ROLES) {
      const c = g.agents[role] ?? emptyCard(role);
      const touched = role === 'planner' ? !!t.plan : role === 'tester' ? !!t.testReport : role === 'reviewer' ? !!t.review : true;
      if (!touched) continue;
      c.tickets += 1;
      c.costUsd = +(c.costUsd + (t.costByRole?.[role] ?? 0)).toFixed(4);
      const clean =
        role === 'coder' ? firstTry
        : role === 'tester' ? !t.loops?.ci && !t.loops?.pm // nothing slipped past testing
        : role === 'reviewer' ? !t.loops?.pm && !t.ship?.reverted
        : !t.loops?.pm;
      if (clean) c.firstTry += 1;
      if (role === 'tester') c.caught += (t.loops?.tests ?? 0) + (t.loops?.coverage ?? 0) + (t.loops?.proof ?? 0);
      if (role === 'reviewer') c.caught += t.loops?.review ?? 0;
      c.streak = clean ? c.streak + 1 : 0;
      c.bestStreak = Math.max(c.bestStreak, c.streak);
      c.xp += 10 + (clean ? 5 : 0);
      c.level = agentLevel(c.xp);
      g.agents[role] = c;
    }

    g.highlights = [{ ticketId: t.id, key: t.key, title: t.title, score: (score ?? 60) + (firstTry ? 10 : 0) + (allProven ? 5 : 0), at: this.now().getTime() }, ...g.highlights].slice(0, 50);

    // achievements
    this.earn(g, 'first_ship', t.key);
    if (firstTry) this.earn(g, 'clean_sweep', t.key);
    if (allProven) this.earn(g, 'show_your_work', t.key);
    if ((g.counters.highInARow ?? 0) >= 5) this.earn(g, 'safe_hands', t.key);
    if ((g.counters.ciFirstTryInARow ?? 0) >= 10) this.earn(g, 'green_machine', t.key);
    if (g.streak.current >= 5) this.earn(g, 'on_a_roll', t.key);
    if (g.shippedProjects.length >= 3) this.earn(g, 'juggler', t.key);
    if (shipped >= 10) this.earn(g, 'ten_down', t.key);
    if (shipped >= 50) this.earn(g, 'half_century', t.key);
    if (/^Redo [A-Z0-9]+-\d+:/.test(t.title)) this.earn(g, 'comeback', t.key);

    // quests
    this.quest(g, 'ship_2');
    if (allProven) this.quest(g, 'proven_ship');
    if (firstTry) this.quest(g, 'first_try');
    this.save(g);
  }

  private onAttention(items: AttentionItem[]) {
    const fresh = items.filter((a) => a.status === 'resolved' && !this.resolved.has(a.id));
    const g = this.state();
    let changed = false;
    for (const a of fresh) {
      this.resolved.add(a.id);
      const took = (a.resolution?.at ?? a.updatedAt) - a.createdAt;
      if (took <= 5 * 60_000) {
        changed = true;
        const n = this.bump(g, 'quickAnswers');
        this.award(g, 5, 'Quick decision');
        this.quest(g, 'quick_answers');
        if (n >= 10) this.earn(g, 'quick_decider');
      }
      if (a.resolution?.verdicts?.length) {
        changed = true;
        this.quest(g, 'walkthrough');
      }
    }
    // inbox cleared (it had something, now nothing open)
    const open = items.filter((a) => a.status === 'open').length;
    if (fresh.length && open === 0) {
      changed = true;
      this.quest(g, 'inbox_clear');
      if (this.now().getHours() < 10) this.earn(g, 'inbox_zero');
    }
    if (changed) this.save(g);
  }

  /** Signals from other services: rules saved, ticket written with the Scoper, revert. */
  private onSignal(e: { type: string; ticketId?: string }) {
    const g = this.state();
    if (e.type === 'rules') {
      this.quest(g, 'house_rule');
      this.earn(g, 'rulemaker');
    } else if (e.type === 'scoped') {
      this.quest(g, 'write_ticket');
      if (this.bump(g, 'scoped') >= 5) this.earn(g, 'wordsmith');
    } else if (e.type === 'revert' && e.ticketId) {
      const t = this.store.ticket(e.ticketId);
      // a revert costs some XP, but catching it fast is the right call
      this.award(g, -20, `Reverted ${t?.key ?? 'a ticket'}`);
      if (t?.ship && this.now().getTime() - t.ship.at <= 30 * 60_000) this.earn(g, 'owned_it', t.key);
      const reviewer = g.agents.reviewer;
      if (reviewer) reviewer.streak = 0;
    } else return;
    this.save(g);
  }
}

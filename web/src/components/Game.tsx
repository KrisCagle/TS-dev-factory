import { useEffect, useRef, useState } from 'react';
import { ROLE_META, money } from '../meta';
import { usePrefs } from '../prefs';
import { useFactory, type Celebration } from '../state';
import { useUI } from '../ui';
import type { AgentCard as Card, AgentConfig, AgentRole, GameView } from '../types';

const ROLE_NAME: Record<AgentRole, string> = { planner: 'Planner', coder: 'Coder', tester: 'Tester', reviewer: 'Reviewer' };

export function xpProgress(g: GameView) {
  const span = Math.max(1, g.nextLevelAt - g.levelFloor);
  return g.nextLevelAt === g.levelFloor ? 1 : Math.min(1, (g.xp - g.levelFloor) / span);
}

/** Top-bar pill: level, XP to next level, streak and today's quests. */
export function GamePill() {
  const { game } = useFactory();
  const { prefs } = usePrefs();
  const ui = useUI();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  if (!game || !prefs.game.enabled) return null;
  const done = game.daily.quests.filter((q) => q.done).length;
  return (
    <div className="gpill-wrap" ref={ref}>
      <button className="gpill" onClick={() => setOpen(!open)} title={`${game.title} — ${game.xp} XP`}>
        <span className="lvl">Lv {game.level}</span>
        <span className="xpbar"><span style={{ width: `${xpProgress(game) * 100}%` }} /></span>
        {game.streak.current > 0 && <span title={`${game.streak.current}-day shipping streak`}>🔥{game.streak.current}</span>}
        <span className="muted small" title="Daily quests">🗺 {done}/{game.daily.quests.length}</span>
      </button>
      {open && (
        <div className="card gpop">
          <div className="row">
            <strong>{game.title}</strong>
            <span className="grow" />
            <span className="small muted">{game.xp} / {game.nextLevelAt} XP</span>
          </div>
          <div className="xpbar big"><span style={{ width: `${xpProgress(game) * 100}%` }} /></div>
          <Quests game={game} />
          <button className="btn sm" onClick={() => { setOpen(false); ui.go('trophies'); }}>🏆 Trophy room</button>
        </div>
      )}
    </div>
  );
}

export function Quests({ game }: { game: GameView }) {
  return (
    <div className="quests">
      <div className="small muted">Today’s quests</div>
      {game.daily.quests.map((q) => (
        <div key={q.id} className={`quest ${q.done ? 'done' : ''}`}>
          <span className="qicon">{q.done ? '✓' : q.icon}</span>
          <span className="grow">{q.title}</span>
          {q.goal > 1 && !q.done && <span className="small muted">{q.progress}/{q.goal}</span>}
          <span className="small muted">+{q.xp} XP</span>
        </div>
      ))}
    </div>
  );
}

/** Trading card for one agent: level, record and what it cost. */
export function AgentTradingCard({ card, agent, color }: { card?: Card; agent?: AgentConfig; color?: string }) {
  if (!card) return null;
  const role = card.role;
  const pct = card.tickets ? Math.round((card.firstTry / card.tickets) * 100) : 0;
  const label = role === 'coder' ? 'Shipped without rework' : role === 'tester' ? 'Nothing slipped past' : role === 'reviewer' ? 'Approved, stayed approved' : 'Plans that held up';
  const c = color ?? agent?.color ?? 'var(--accent)';
  return (
    <div className="tcard-agent" style={{ ['--ag' as string]: c }}>
      <div className="row">
        <span className="avatar" style={{ background: c }}>{ROLE_META[role].icon}</span>
        <div style={{ lineHeight: 1.2 }}>
          <strong>{agent?.name ?? ROLE_NAME[role]}</strong>
          <div className="small muted">{ROLE_NAME[role]} · Level {card.level}</div>
        </div>
        <span className="grow" />
        {card.streak >= 3 && <span className="chip" title="Clean tickets in a row">🔥 {card.streak}</span>}
      </div>
      <div className="stats3">
        <div><b>{card.tickets}</b><span>tickets shipped</span></div>
        <div><b>{card.tickets ? `${pct}%` : '—'}</b><span>{label.toLowerCase()}</span></div>
        <div><b>{role === 'tester' || role === 'reviewer' ? card.caught : money(card.costUsd)}</b><span>{role === 'tester' ? 'problems caught' : role === 'reviewer' ? 'issues sent back' : 'spent'}</span></div>
      </div>
      <div className="small muted">Best run: {card.bestStreak} clean in a row{role === 'tester' || role === 'reviewer' ? ` · ${money(card.costUsd)} spent` : ''}</div>
    </div>
  );
}

// ---------------------------------------------------------------- celebrations

interface Shown { id: number; kind: 'ship' | 'achievement' | 'levelup' | 'quest'; icon: string; title: string; sub?: string }

/** Pop-up celebrations: rocket + confetti on ship, cards for achievements, quests and level-ups. */
export function Celebrations() {
  const { onCelebrate } = useFactory();
  const { prefs } = usePrefs();
  const [shown, setShown] = useState<Shown[]>([]);
  const [rocket, setRocket] = useState(0);
  const seq = useRef(0);
  const queue = useRef<Array<{ s: Omit<Shown, 'id'>; ms: number }>>([]);
  const visible = useRef(0);
  const p = useRef(prefs.game);
  p.current = prefs.game;

  // show at most 3 at a time; the rest wait their turn, so a big moment never pushes the ship off screen
  const pump = () => {
    while (visible.current < 3 && queue.current.length) {
      const { s, ms } = queue.current.shift()!;
      const id = ++seq.current;
      visible.current++;
      setShown((x) => [...x, { ...s, id }]);
      window.setTimeout(() => {
        visible.current--;
        setShown((x) => x.filter((y) => y.id !== id));
        pump();
      }, ms);
    }
  };

  useEffect(() => onCelebrate((e: Celebration) => {
    const g = p.current;
    if (!g.enabled || !g.celebrations) return;
    const add = (s: Omit<Shown, 'id'>, ms = 3500, first = false) => {
      // never build a long backlog: if lots happened at once, keep the newest few
      if (queue.current.length > 4) queue.current.splice(0, queue.current.length - 4);
      if (first) queue.current.unshift({ s, ms });
      else queue.current.push({ s, ms });
      pump();
    };
    if (e.type === 'ship') {
      setRocket(Date.now());
      add({ kind: 'ship', icon: '🚀', title: `Shipped ${e.key}`, sub: `+${e.xp} XP${e.firstTry ? ' · no rework' : ''}${e.score !== undefined ? ` · safety ${e.score}` : ''}` }, 3500, true);
      if (g.sound) chime([523, 659, 784]);
    } else if (e.type === 'achievement') {
      add({ kind: 'achievement', icon: e.achievement.icon, title: `Achievement: ${e.achievement.title}`, sub: e.achievement.desc }, 4000);
      if (g.sound) chime([659, 784, 988, 1319]);
    } else if (e.type === 'levelup') {
      add({ kind: 'levelup', icon: '⭐', title: `Level ${e.level}!`, sub: `You’re now ${e.title}` }, 4000);
      if (g.sound) chime([392, 523, 659, 784, 1047]);
    } else if (e.type === 'quest') {
      add({ kind: 'quest', icon: '🗺', title: `Quest done: ${e.quest.title}`, sub: `+${e.quest.xp} XP` }, 2500);
      if (g.sound) chime([784, 988]);
    }
  }), [onCelebrate]);

  return (
    <>
      {rocket > 0 && <Launch key={rocket} />}
      <div className="celebrations">
        {shown.map((s) => (
          <div key={s.id} className={`celebrate ${s.kind}`}>
            <span className="cicon">{s.icon}</span>
            <div><strong>{s.title}</strong>{s.sub && <div className="small">{s.sub}</div>}</div>
          </div>
        ))}
      </div>
    </>
  );
}

const CONFETTI = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#0ea5e9'];

function Launch() {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setGone(true), 2600);
    return () => window.clearTimeout(t);
  }, []);
  if (gone || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null;
  return (
    <div className="launch" aria-hidden>
      <span className="rocket">🚀</span>
      {Array.from({ length: 36 }, (_, i) => (
        <i key={i} style={{ left: `${(i * 37) % 100}%`, background: CONFETTI[i % CONFETTI.length], animationDelay: `${(i % 9) * 0.05}s`, ['--dx' as string]: `${((i * 53) % 120) - 60}px` }} />
      ))}
    </div>
  );
}

/** A tiny synthesized chime — no audio files, and only when you turn sound on. */
let lastChime = 0;
function chime(notes: number[]) {
  // one chime per moment, even when a ship unlocks several things at once
  if (Date.now() - lastChime < 1500) return;
  lastChime = Date.now();
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const gain = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.09;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(gain).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.4);
    });
    window.setTimeout(() => void ctx.close(), notes.length * 120 + 600);
  } catch {
    /* no audio available */
  }
}

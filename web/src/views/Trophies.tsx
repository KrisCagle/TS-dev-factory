import { AgentTradingCard, Quests, xpProgress } from '../components/Game';
import { ago } from '../meta';
import { usePrefs } from '../prefs';
import { useFactory } from '../state';
import { useUI } from '../ui';
import type { AgentRole } from '../types';

const ROLES: AgentRole[] = ['planner', 'coder', 'tester', 'reviewer'];

/** Level, quests, achievements, agent trading cards and office unlocks. */
export function Trophies() {
  const { game, agents, allTickets } = useFactory();
  const { prefs, set } = usePrefs();
  const ui = useUI();
  if (!game) return <div className="empty">Loading…</div>;
  if (!prefs.game.enabled) {
    return (
      <div className="empty card" style={{ margin: 18, padding: 28 }}>
        <div>Gamification is switched off.</div>
        <button className="btn" onClick={() => set({ game: { ...prefs.game, enabled: true } })}>Turn it on</button>
      </div>
    );
  }
  const earned = game.achievements.filter((a) => a.earnedAt).length;
  const hl = game.weeklyHighlight;
  const hlTicket = hl && allTickets.find((t) => t.id === hl.ticketId);

  return (
    <div className="trophies">
      <section className="card levelcard">
        <div className="row wrap">
          <div className="lvlbadge">{game.level}</div>
          <div className="grow">
            <h2 style={{ margin: 0 }}>{game.title}</h2>
            <div className="small muted">{game.xp} XP · {game.nextLevelAt > game.xp ? `${game.nextLevelAt - game.xp} XP to level ${game.level + 1}` : 'Top level reached'}</div>
            <div className="xpbar big"><span style={{ width: `${xpProgress(game) * 100}%` }} /></div>
          </div>
          <div className="lstat"><b>🔥 {game.streak.current}</b><span>day streak (best {game.streak.best})</span></div>
          <div className="lstat"><b>🏅 {earned}/{game.achievements.length}</b><span>achievements</span></div>
          <div className="lstat"><b>🚀 {game.counters.ships ?? 0}</b><span>shipped</span></div>
        </div>
        <div className="small muted">XP comes from shipping well — high safety scores, no rework, every criterion proven — and from unblocking the team quickly. Shipping more tickets badly earns less.</div>
      </section>

      <div className="tgrid">
        <section className="card"><Quests game={game} /></section>
        <section className="card">
          <h2>⭐ This week’s highlight</h2>
          {hl ? (
            <div className="highlight">
              <button className="linkish mono" onClick={() => hlTicket && ui.openTicket(hlTicket.id)}>{hl.key}</button> {hl.title}
              <div className="small muted">Shipped {ago(hl.at)} ago · best combination of safety, proof and zero rework this week</div>
            </div>
          ) : <div className="small muted">Ship something this week to get a highlight.</div>}
          <h2 style={{ marginTop: 12 }}>📈 Recent XP</h2>
          <ul className="xplog">
            {game.history.slice(0, 6).map((h, i) => <li key={i}><span className={h.xp < 0 ? 'neg' : 'pos'}>{h.xp > 0 ? '+' : ''}{h.xp}</span> {h.why} <span className="muted small">{ago(h.at)} ago</span></li>)}
            {!game.history.length && <li className="muted small">Nothing yet.</li>}
          </ul>
        </section>
      </div>

      <section className="card">
        <h2>🏅 Achievements <span className="muted small">({earned}/{game.achievements.length})</span></h2>
        <div className="achgrid">
          {game.achievements.map((a) => (
            <div key={a.id} className={`ach ${a.earnedAt ? 'on' : ''}`} title={a.earnedAt ? `Earned ${ago(a.earnedAt)} ago` : 'Not yet earned'}>
              <span className="aicon">{a.icon}</span>
              <div><strong>{a.title}</strong><div className="small muted">{a.desc}</div></div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>🃏 The team</h2>
        <div className="small muted">Agents level up from tickets they helped ship cleanly.</div>
        <div className="cardgrid">
          {ROLES.map((r) => {
            const agent = agents.find((a) => a.role === r);
            return <AgentTradingCard key={r} card={game.agents[r]} agent={agent} color={prefs.office.looks[r]?.color ?? agent?.color} />;
          })}
        </div>
      </section>

      <section className="card">
        <h2>🏢 Office upgrades</h2>
        <div className="unlocks">
          {game.unlocks.map((u) => (
            <div key={u.id} className={`unlock ${u.unlocked ? 'on' : ''}`}>
              <span className="aicon">{u.unlocked ? u.icon : '🔒'}</span>
              <div><strong>{u.title}</strong><div className="small muted">{u.unlocked ? 'Unlocked — see it in the Office' : u.how}</div></div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>⚙️ Preferences</h2>
        <div className="row wrap" style={{ gap: 18 }}>
          <label className="row"><input type="checkbox" checked={prefs.game.celebrations} onChange={(e) => set({ game: { ...prefs.game, celebrations: e.target.checked } })} /> Celebrations (rocket, confetti, pop-ups)</label>
          <label className="row"><input type="checkbox" checked={prefs.game.sound} onChange={(e) => set({ game: { ...prefs.game, sound: e.target.checked } })} /> Sound</label>
          <button className="btn ghost sm" onClick={() => set({ game: { ...prefs.game, enabled: false } })}>Turn gamification off</button>
        </div>
      </section>
    </div>
  );
}

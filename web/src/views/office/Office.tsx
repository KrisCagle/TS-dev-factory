import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { usePrefs, type CharacterLook } from '../../prefs';
import { useFactory } from '../../state';
import { useUI } from '../../ui';
import { PRIORITY_META, ROLE_META, ago } from '../../meta';
import type { AgentRole, Ticket } from '../../types';
import { Decor } from './Decor';
import { AgentTradingCard } from '../../components/Game';
import { CORRIDOR_Y, DEFAULT_ZONES, DEPARTMENTS, DESK_Y, H, SEATS, W, breakSpots, chairPt, cx, points, seatX, zoneMap, type Pt, type Zone, type ZoneId } from './layout';
import { Sim, type Char, type Role } from './sim';
import { ACCESSORIES, HAIRS, SHIRTS, SKINS, Sprite } from './Sprite';

const DEFAULT_LOOKS: Record<Role, CharacterLook> = {
  pm: { skin: SKINS[1], hair: HAIRS[1], accessory: 'none' },
  planner: { skin: SKINS[0], hair: HAIRS[3], accessory: 'glasses' },
  coder: { skin: SKINS[3], hair: HAIRS[0], accessory: 'headphones' },
  tester: { skin: SKINS[2], hair: HAIRS[4], accessory: 'cap' },
  reviewer: { skin: SKINS[4], hair: HAIRS[5], accessory: 'glasses' },
};

function palette(dark: boolean) {
  return dark
    ? { floor: '#161a24', tile: '#1c2130', room: '#1d2333', wall: '#3b4560', wallTop: '#2a3246', text: '#aab3c8', desk: '#5c4531', deskTop: '#6f543b', monitor: '#0a0d14', chair: '#2c3346', glass: '#7dd3fc', cork: '#6b4e2e', paper: '#e8e3d3', plant: '#2f7d4a', couch: '#3f4f7a', rug: '#2a2440' }
    : { floor: '#ebe6dc', tile: '#e1dbcf', room: '#f6f3ec', wall: '#9aa3b4', wallTop: '#c9ced8', text: '#475569', desk: '#b98d5e', deskTop: '#d2a676', monitor: '#1f2937', chair: '#475569', glass: '#38bdf8', cork: '#c4955d', paper: '#fffdf5', plant: '#3f9d5a', couch: '#7486b8', rug: '#e9d8f4' };
}

export function Office() {
  const { tickets, agents, settings, factory, logs, onLog, stats, needsYou, targetProjectId, game } = useFactory();
  const { prefs, setOffice } = usePrefs();
  const ui = useUI();
  const svgRef = useRef<SVGSVGElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Sim>(new Sim());
  const [, setFrame] = useState(0);
  const [editLayout, setEditLayout] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const dragRef = useRef<{ kind: 'char' | 'zone'; id: string; start: Pt; orig: Pt; moved: boolean } | null>(null);

  const sim = simRef.current;
  const zones = useMemo(() => zoneMap(prefs.office.zones), [prefs.office.zones]);
  sim.setZones(zones);
  sim.speed = prefs.office.speed;

  const dark = document.documentElement.dataset.theme === 'dark';
  const C = palette(dark);

  // server state → simulation
  useEffect(() => {
    sim.sync(tickets, agents, settings?.concurrency ?? 2);
  }, [tickets, agents, settings?.concurrency]);

  useEffect(() => onLog((e) => sim.onLog(e)), [onLog]);

  // animation loop (~40fps render)
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastRender = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      sim.step(dt, now);
      if (now - lastRender > 24) {
        lastRender = now;
        setFrame((f) => (f + 1) % 1_000_000);
      }
    };
    const loop = (now: number) => {
      tick(now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    // Fallback: some embedded/background browsers throttle or pause requestAnimationFrame.
    const fallback = window.setInterval(() => {
      const now = performance.now();
      if (now - last > 120) tick(now);
    }, 50);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(fallback);
    };
  }, []);

  const t = sim.now / 1000;
  const byId = new Map(tickets.map((x) => [x.id, x]));
  const agentOf = (r: Role) => agents.find((a) => a.role === r);
  const look = (r: Role): CharacterLook & { color: string; name: string } => {
    const o: Partial<CharacterLook> = prefs.office.looks[r] ?? {};
    const d = DEFAULT_LOOKS[r];
    return {
      ...d,
      ...o,
      color: o.color ?? (r === 'pm' ? prefs.accent : agentOf(r)?.color ?? '#64748b'),
      name: o.name ?? (r === 'pm' ? prefs.office.pmName : agentOf(r)?.name ?? r),
    };
  };

  // ---------------------------------------------------------------- pointer handling
  const toSvg = (e: { clientX: number; clientY: number }): Pt => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  };

  const onDown = (kind: 'char' | 'zone', id: string, orig: Pt) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { kind, id, start: toSvg(e), orig, moved: false };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = toSvg(e);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    if (d.kind === 'char') {
      const c = sim.chars.find((x) => x.id === d.id);
      if (c) sim.drag(c, { x: clamp(d.orig.x + dx, 20, W - 20), y: clamp(d.orig.y + dy, 20, H - 20) });
    } else {
      const nx = Math.round(clamp(d.orig.x + dx, 0, W - zones[d.id as ZoneId].w) / 2) * 2;
      const ny = Math.round(clamp(d.orig.y + dy, 0, H - zones[d.id as ZoneId].h) / 2) * 2;
      setOffice({ zones: { ...prefs.office.zones, [d.id]: { x: nx, y: ny } } });
    }
  };

  const onUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.kind === 'char') {
      const c = sim.chars.find((x) => x.id === d.id);
      if (!c) return;
      if (d.moved) sim.dropChar(c);
      else setSelected((s) => (s === c.id ? null : c.id));
    }
  };

  // ---------------------------------------------------------------- derived
  const ready = tickets.filter((x) => x.stage === 'ready').sort((a, b) => PRIORITY_META[a.priority].rank - PRIORITY_META[b.priority].rank);
  const backlogN = tickets.filter((x) => x.stage === 'backlog').length;
  const failed = tickets.filter((x) => x.stage === 'failed');
  const needIds = new Set(needsYou.map((a) => a.ticketId));
  const awaiting = tickets.filter((x) => needIds.has(x.id));
  const inCi = tickets.filter((x) => x.stage === 'ci');
  const shipped = tickets.filter((x) => x.stage === 'done').length;
  const seatedTicket = (role: AgentRole, slot: number): Ticket | undefined => {
    const c = sim.chars.find((x) => x.role === role && x.slot === slot);
    if (!c || !sim.isWorking(c)) return undefined;
    const tk = sim.ticketOf(c);
    return tk && !sim.carried(tk.id) ? tk : undefined;
  };
  const selChar = sim.chars.find((c) => c.id === selected);

  // popover position (svg → container px)
  let pop: { left: number; top: number } | null = null;
  if (selChar && svgRef.current && stageRef.current) {
    const m = svgRef.current.getScreenCTM();
    const r = stageRef.current.getBoundingClientRect();
    if (m) {
      const left = selChar.x * m.a + m.e - r.left;
      const top = selChar.y * m.d + m.f - r.top;
      pop = { left: clamp(left + 24, 8, r.width - 270), top: clamp(top - 40, 8, r.height - 340) };
    }
  }

  const feed = logs.slice(-80).reverse();
  const empty = tickets.length === 0;

  return (
    <div className={`office-wrap ${prefs.office.showFeed ? '' : 'nofeed'}`}>
      <div className="office-stage" ref={stageRef} onPointerDown={() => setSelected(null)}>
        <div className="office-tools" onPointerDown={(e) => e.stopPropagation()}>
          <button className={`btn sm ${editLayout ? 'primary' : ''}`} onClick={() => setEditLayout((v) => !v)}>{editLayout ? '✓ Done arranging' : '✥ Arrange rooms'}</button>
          {editLayout && <button className="btn sm" onClick={() => setOffice({ zones: {} })}>Reset layout</button>}
          <div className="seg">
            {[0.5, 1, 2].map((s) => <button key={s} className={prefs.office.speed === s ? 'on' : ''} onClick={() => setOffice({ speed: s })}>{s}×</button>)}
          </div>
          <button className="btn sm" onClick={() => setOffice({ showBubbles: !prefs.office.showBubbles })}>{prefs.office.showBubbles ? '💬 Bubbles on' : '💬 Bubbles off'}</button>
          <button className="btn sm" onClick={() => setOffice({ showFeed: !prefs.office.showFeed })}>{prefs.office.showFeed ? 'Hide feed' : 'Show feed'}</button>
          <button className="btn sm" onClick={() => api.pause(!factory.paused)}>{factory.paused ? '▶ Resume factory' : '⏸ Pause factory'}</button>
        </div>

        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} role="img" aria-label="Top-down view of the agent office">
          <defs>
            <pattern id="tiles" width="40" height="40" patternUnits="userSpaceOnUse">
              <rect width="40" height="40" fill={C.floor} />
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke={C.tile} strokeWidth="1.5" />
            </pattern>
            <pattern id="wood" width="60" height="14" patternUnits="userSpaceOnUse">
              <rect width="60" height="14" fill={C.room} />
              <path d="M 0 14 L 60 14 M 30 0 L 30 14" stroke={C.tile} strokeWidth="1" />
            </pattern>
            <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity="0.18" /></filter>
          </defs>

          {/* floor + outer wall */}
          <rect x={0} y={0} width={W} height={H} rx={18} fill="url(#tiles)" />
          <rect x={6} y={6} width={W - 12} height={H - 12} rx={14} fill="none" stroke={C.wall} strokeWidth={10} />
          {/* corridor runner */}
          <rect x={20} y={CORRIDOR_Y - 26} width={W - 40} height={52} rx={26} fill={C.tile} opacity={0.55} />
          <text x={W / 2} y={CORRIDOR_Y + 5} textAnchor="middle" fontSize={12} fill={C.text} opacity={0.35} letterSpacing={6}>CORRIDOR</text>

          {/* rooms */}
          {Object.values(zones).map((z) => (
            <g key={z.id}>
              <Room z={z} C={C} dark={dark} edit={editLayout} onDown={onDown('zone', z.id, { x: z.x, y: z.y })} />
              {z.id === 'wall' && <TicketWall z={z} C={C} ready={ready} backlogN={backlogN} failed={failed} open={ui.openTicket} />}
              {DEPARTMENTS.includes(z.id as AgentRole) && (
                <Department z={z} C={C} role={z.id as AgentRole} t={t} color={look(z.id as AgentRole).color} seatTicket={(i) => seatedTicket(z.id as AgentRole, i)} pool={Math.min(3, settings?.concurrency ?? 2)} enabled={agentOf(z.id as AgentRole)?.enabled !== false} open={ui.openTicket} />
              )}
              {z.id === 'pm' && <PmOffice z={z} C={C} awaiting={awaiting} open={ui.openTicket} accent={prefs.accent} />}
              {z.id === 'break' && <BreakRoom z={z} C={C} />}
              {z.id === 'huddle' && <Huddle z={z} C={C} />}
              {z.id === 'servers' && <Servers z={z} C={C} t={t} busy={(stats?.inFlight ?? 0) > 0 || inCi.length > 0} ci={inCi.filter((x) => !sim.carried(x.id))} open={ui.openTicket} />}
              {z.id === 'ship' && <ShipDock z={z} C={C} t={t} shipped={shipped} launching={sim.launchUntil > sim.now} />}
            </g>
          ))}

          {/* unlocked upgrades from the Trophy room */}
          {game && prefs.game.enabled && !editLayout && <Decor zones={zones} game={game} dark={dark} />}

          {/* characters, sorted by y for depth */}
          {!editLayout && [...sim.chars].sort((a, b) => a.y - b.y).map((c) => {
            const lk = look(c.role);
            const off = !sim.enabled(c.role);
            const working = sim.isWorking(c);
            const tk = sim.ticketOf(c);
            return (
              <g key={c.id} className="char" onPointerDown={onDown('char', c.id, { x: c.x, y: c.y })}>
                <Sprite x={c.x} y={c.y} facing={c.facing} shirt={lk.color} skin={lk.skin} hair={lk.hair} accessory={lk.accessory} walking={c.walking} working={working} t={t + c.slot} dim={off} glow={working ? lk.color : selected === c.id ? prefs.accent : undefined} />
                {c.carry && <Paper x={c.x + 12} y={c.y - 34} label={c.carry.key} color={c.carry.color} C={C} />}
                <NameTag x={c.x} y={c.y + 28} text={`${lk.name}${c.slot ? ` ${c.slot + 1}` : ''}`} color={lk.color} sub={working && tk ? tk.key : c.role === 'pm' && awaiting.length ? `${awaiting.length} waiting` : undefined} />
                {working && !c.bubble && prefs.office.showBubbles && <Thinking x={c.x} y={c.y - 32} t={t} />}
                {c.bubble && prefs.office.showBubbles && <Bubble x={c.x} y={c.y - (c.carry ? 48 : 30)} text={c.bubble.text} tone={c.bubble.tone} C={C} dark={dark} />}
              </g>
            );
          })}

          {/* confetti */}
          {sim.particles.map((p, i) => (
            <rect key={i} x={p.x - 3} y={p.y - 1.5} width={6} height={3} fill={p.color} opacity={Math.min(1, p.life)} transform={`rotate(${p.r} ${p.x} ${p.y})`} />
          ))}

          {factory.paused && (
            <g>
              <rect x={W / 2 - 170} y={CORRIDOR_Y - 20} width={340} height={40} rx={20} fill="#f59e0b" opacity={0.95} />
              <text x={W / 2} y={CORRIDOR_Y + 5} textAnchor="middle" fontSize={14} fontWeight={600} fill="#1f1300">⏸ Factory paused — no new tickets picked up</text>
            </g>
          )}
        </svg>

        {empty && (
          <div className="card" style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', padding: 20, textAlign: 'center', display: 'grid', gap: 10, maxWidth: 380 }} onPointerDown={(e) => e.stopPropagation()}>
            <strong>The office is quiet ☕</strong>
            <span className="small muted">Give the team something to do. Tickets you send to the factory get pinned on the Ticket Wall, and the agents take it from there.</span>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={() => ui.newTicket('ready')}>＋ New ticket</button>
              <button className="btn" onClick={() => api.demo(targetProjectId)}>🎲 Load demo tickets</button>
            </div>
          </div>
        )}

        {selChar && pop && (
          CharPopover({
            c: selChar,
            sim,
            style: pop,
            lookFor: look,
            ticket: selChar.ticketId ? byId.get(selChar.ticketId) : undefined,
            onClose: () => setSelected(null),
          })
        )}
      </div>

      {prefs.office.showFeed && (
        <aside className="feed">
          <h3>📡 Floor feed <span className="muted small" style={{ marginLeft: 'auto', fontWeight: 400 }}>{factory.running.length} running</span></h3>
          <ul>
            {feed.map((l) => {
              const tk = byId.get(l.ticketId);
              const role = l.agent as Role;
              const color = l.agent === 'pm' ? prefs.accent : l.agent === 'factory' ? 'var(--faint)' : look(role).color;
              return (
                <li key={l.id} onClick={() => ui.openTicket(l.ticketId)}>
                  <span className="dot" style={{ background: color, marginTop: 6 }} />
                  <span>
                    <span className="who" style={{ color }}>{l.agent === 'pm' ? prefs.office.pmName : l.agent === 'factory' ? 'Factory' : look(role).name}</span>{' '}
                    <span className="tk">{tk?.key}</span> <span className="muted small">· {ago(l.ts)}</span>
                    <div style={{ color: l.kind === 'error' ? 'var(--bad)' : l.kind === 'tool' ? 'var(--muted)' : undefined }}>{l.kind === 'tool' ? '↳ ' : ''}{l.text.length > 120 ? `${l.text.slice(0, 120)}…` : l.text}</div>
                  </span>
                </li>
              );
            })}
            {!feed.length && <li className="muted">Nothing yet.</li>}
          </ul>
        </aside>
      )}
    </div>
  );

  // ---------------------------------------------------------------- popover (called as a plain function so inputs keep focus across frames)
  function CharPopover({ c, sim, style, lookFor, ticket, onClose }: { c: Char; sim: Sim; style: { left: number; top: number }; lookFor: typeof look; ticket?: Ticket; onClose: () => void }) {
    const lk = lookFor(c.role);
    const patch = (p: Partial<CharacterLook>) => setOffice({ looks: { ...prefs.office.looks, [c.role]: { ...lk, ...(prefs.office.looks[c.role] ?? {}), ...p } } });
    const working = sim.isWorking(c);
    const status = c.role === 'pm'
      ? `${awaiting.length} ticket${awaiting.length === 1 ? '' : 's'} waiting on you`
      : !sim.enabled(c.role) ? 'Off duty (disabled)' : working ? `Working on ${ticket?.key}` : c.walking ? 'On the move' : 'Idle — hanging out';
    return (
      <div className="card char-pop" style={style} onPointerDown={(e) => e.stopPropagation()}>
        <div className="row">
          <span className="avatar" style={{ background: lk.color, width: 30, height: 30, fontSize: 15 }}>{c.role === 'pm' ? '✋' : ROLE_META[c.role as AgentRole].icon}</span>
          <div style={{ lineHeight: 1.2 }}>
            <strong>{lk.name}{c.slot ? ` ${c.slot + 1}` : ''}</strong>
            <div className="small muted">{c.role === 'pm' ? 'Project manager' : ROLE_META[c.role as AgentRole].desc}</div>
          </div>
          <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose}>✕</button>
        </div>
        <div className="small">{status}</div>
        {c.role !== 'pm' && game && prefs.game.enabled && <AgentTradingCard card={game.agents[c.role as AgentRole]} agent={agentOf(c.role as AgentRole)} color={lk.color} />}
        {c.role === 'pm' && game && prefs.game.enabled && <div className="small">⭐ Level {game.level} · {game.title}{game.streak.current ? ` · 🔥 ${game.streak.current}-day streak` : ''}</div>}
        {ticket && <button className="btn sm" onClick={() => ui.openTicket(ticket.id)}>Open {ticket.key}: {ticket.title.slice(0, 28)}{ticket.title.length > 28 ? '…' : ''}</button>}
        {c.role === 'pm' && awaiting[0] && <button className="btn sm primary" onClick={() => ui.openTicket(awaiting[0].id)}>Review {awaiting[0].key}</button>}
        {c.home && <button className="btn sm" onClick={() => sim.releaseHome(c)}>Let them roam again</button>}
        <label className="field">Name
          <input className="input" value={lk.name} onChange={(e) => c.role === 'pm' ? setOffice({ pmName: e.target.value }) : patch({ name: e.target.value })} />
        </label>
        <div className="field">Outfit
          <div className="swatches">{SHIRTS.map((s) => <span key={s} className={`swatch ${lk.color === s ? 'on' : ''}`} style={{ background: s }} onClick={() => patch({ color: s })} />)}</div>
        </div>
        <div className="field">Skin
          <div className="swatches">{SKINS.map((s) => <span key={s} className={`swatch ${lk.skin === s ? 'on' : ''}`} style={{ background: s }} onClick={() => patch({ skin: s })} />)}</div>
        </div>
        <div className="field">Hair
          <div className="swatches">{HAIRS.map((s) => <span key={s} className={`swatch ${lk.hair === s ? 'on' : ''}`} style={{ background: s }} onClick={() => patch({ hair: s })} />)}</div>
        </div>
        <label className="field">Accessory
          <select className="select" value={lk.accessory} onChange={(e) => patch({ accessory: e.target.value as CharacterLook['accessory'] })}>
            {ACCESSORIES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <div className="small muted">Tip: drag characters around. Idle ones stay where you drop them.</div>
      </div>
    );
  }
}

// ==================================================================== scene pieces
type Pal = ReturnType<typeof palette>;

function Room({ z, C, dark, edit, onDown }: { z: Zone; C: Pal; dark: boolean; edit: boolean; onDown: (e: React.PointerEvent) => void }) {
  const glass = z.id === 'pm';
  return (
    <g className={edit ? 'zone-drag' : undefined} onPointerDown={edit ? onDown : undefined}>
      <rect x={z.x} y={z.y} width={z.w} height={z.h} rx={12} fill={z.id === 'break' || z.id === 'pm' ? 'url(#wood)' : C.room} stroke={glass ? C.glass : C.wallTop} strokeWidth={glass ? 3 : 2.5} strokeOpacity={glass ? 0.8 : 1} />
      {glass && <rect x={z.x - 3} y={CORRIDOR_Y - 22} width={7} height={44} fill={C.floor} />}
      {glass && <rect x={z.x + z.w / 2 - 22} y={z.y + z.h - 3} width={44} height={7} fill={C.floor} />}
      <text x={z.x + 12} y={z.y + 20} fontSize={11.5} fontWeight={700} letterSpacing={0.6} fill={C.text}>{z.icon} {z.label.toUpperCase()}</text>
      {edit && <rect x={z.x} y={z.y} width={z.w} height={z.h} rx={12} fill={dark ? '#6366f1' : '#6366f1'} opacity={0.12} stroke="#6366f1" strokeDasharray="6 5" strokeWidth={2} />}
    </g>
  );
}

function Paper({ x, y, label, color, C, onClick }: { x: number; y: number; label: string; color: string; C: Pal; onClick?: () => void }) {
  return (
    <g transform={`translate(${x} ${y})`} onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined} filter="url(#soft)">
      <rect x={-17} y={-11} width={34} height={22} rx={2} fill={C.paper} stroke={color} strokeWidth={1.5} />
      <rect x={-17} y={-11} width={34} height={4} fill={color} />
      <text y={7} textAnchor="middle" fontSize={7.5} fontWeight={700} fill="#334155" fontFamily="JetBrains Mono, monospace">{label}</text>
    </g>
  );
}

function NameTag({ x, y, text, color, sub }: { x: number; y: number; text: string; color: string; sub?: string }) {
  const w = Math.max(text.length, sub ? sub.length + 2 : 0) * 5.6 + 12;
  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none">
      <rect x={-w / 2} y={-7} width={w} height={sub ? 23 : 14} rx={7} fill={color} opacity={0.92} />
      <text y={3} textAnchor="middle" fontSize={9} fontWeight={700} fill="white">{text}</text>
      {sub && <text y={13.5} textAnchor="middle" fontSize={8} fill="white" opacity={0.9} fontFamily="JetBrains Mono, monospace">{sub}</text>}
    </g>
  );
}

function Bubble({ x, y, text, tone, C, dark }: { x: number; y: number; text: string; tone: string; C: Pal; dark: boolean }) {
  const w = Math.min(230, text.length * 6.1 + 18);
  const border = tone === 'bad' ? '#ef4444' : tone === 'ok' ? '#10b981' : tone === 'think' ? '#a78bfa' : '#94a3b8';
  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none" filter="url(#soft)">
      <rect x={-w / 2} y={-26} width={w} height={20} rx={10} fill={dark ? '#0f1320' : '#ffffff'} stroke={border} strokeWidth={1.3} />
      <path d="M -5 -6.5 L 0 0 L 5 -6.5 Z" fill={dark ? '#0f1320' : '#ffffff'} stroke={border} strokeWidth={1.3} />
      <rect x={-5.5} y={-8} width={11} height={3} fill={dark ? '#0f1320' : '#ffffff'} />
      <text y={-12.5} textAnchor="middle" fontSize={10} fill={C.text === '#475569' ? '#1e293b' : '#e2e8f0'}>{text.length > 38 ? `${text.slice(0, 37)}…` : text}</text>
    </g>
  );
}

function Thinking({ x, y, t }: { x: number; y: number; t: number }) {
  return (
    <g transform={`translate(${x} ${y - 12})`} pointerEvents="none">
      {[0, 1, 2].map((i) => (
        <circle key={i} cx={(i - 1) * 7} cy={-Math.max(0, Math.sin(t * 6 - i * 0.7)) * 3} r={2.3} fill="#a78bfa" opacity={0.85} />
      ))}
    </g>
  );
}

function TicketWall({ z, C, ready, backlogN, failed, open }: { z: Zone; C: Pal; ready: Ticket[]; backlogN: number; failed: Ticket[]; open: (id: string) => void }) {
  const bx = z.x + 16;
  const by = z.y + 32;
  const bw = z.w - 32;
  return (
    <g>
      <rect x={bx} y={by} width={bw} height={132} rx={6} fill={C.cork} stroke={C.desk} strokeWidth={3} />
      {ready.slice(0, 12).map((tk, i) => {
        const col = i % 4;
        const row = Math.floor(i / 4);
        return (
          <g key={tk.id} transform={`rotate(${((i * 37) % 9) - 4} ${bx + 26 + col * 46} ${by + 24 + row * 40})`}>
            <Paper x={bx + 26 + col * 46} y={by + 24 + row * 40} label={tk.key} color={PRIORITY_META[tk.priority].color} C={C} onClick={() => open(tk.id)} />
            <circle cx={bx + 26 + col * 46} cy={by + 14 + row * 40} r={2.4} fill="#dc2626" />
          </g>
        );
      })}
      {!ready.length && <text x={bx + bw / 2} y={by + 70} textAnchor="middle" fontSize={11} fill="#fff" opacity={0.8}>Queue empty</text>}
      {ready.length > 12 && <text x={bx + bw - 6} y={by + 128} textAnchor="end" fontSize={10} fill="#fff">+{ready.length - 12} more</text>}
      <text x={z.x + 16} y={z.y + 186} fontSize={10.5} fill={C.text}>📥 {ready.length} ready · 🗂 {backlogN} in backlog</text>
      {failed.length > 0 && (
        <g style={{ cursor: 'pointer' }} onClick={() => open(failed[0].id)}>
          <rect x={z.x + 16} y={z.y + 212} width={z.w - 32} height={24} rx={6} fill="#ef4444" opacity={0.15} stroke="#ef4444" />
          <text x={z.x + z.w / 2} y={z.y + 228} textAnchor="middle" fontSize={10.5} fill="#ef4444" fontWeight={700}>⚠ {failed.length} failed — click to triage</text>
        </g>
      )}
    </g>
  );
}

function Desk({ x, y, C, lit, color, t, twin }: { x: number; y: number; C: Pal; lit: boolean; color: string; t: number; twin?: boolean }) {
  return (
    <g>
      <rect x={x - 30} y={y - 16} width={60} height={32} rx={4} fill={C.desk} filter="url(#soft)" />
      <rect x={x - 28} y={y - 14} width={56} height={28} rx={3} fill={C.deskTop} />
      {(twin ? [-11, 11] : [0]).map((dx) => (
        <g key={dx}>
          <rect x={x + dx - 10} y={y - 13} width={20} height={6} rx={1.5} fill={C.monitor} />
          {lit && <rect x={x + dx - 9} y={y - 12} width={18} height={4} rx={1} fill={color} opacity={0.55 + Math.sin(t * 5 + dx) * 0.25} />}
        </g>
      ))}
      <rect x={x - 11} y={y + 2} width={22} height={6} rx={1.5} fill={C.monitor} opacity={0.7} />
      <circle cx={x + 18} cy={y + 5} r={3} fill="#e5e7eb" stroke="#9ca3af" strokeWidth={0.8} />
    </g>
  );
}

function Department({ z, C, role, t, color, seatTicket, pool, enabled, open }: {
  z: Zone; C: Pal; role: AgentRole; t: number; color: string; seatTicket: (i: number) => Ticket | undefined; pool: number; enabled: boolean; open: (id: string) => void;
}) {
  return (
    <g opacity={enabled ? 1 : 0.6}>
      {Array.from({ length: SEATS }, (_, i) => {
        const x = seatX(z, i);
        const y = z.y + DESK_Y;
        const tk = seatTicket(i);
        const chair = chairPt(z, i);
        return (
          <g key={i} opacity={i < pool ? 1 : 0.4}>
            <circle cx={chair.x} cy={chair.y + 3} r={12} fill={C.chair} opacity={0.8} />
            <Desk x={x} y={y} C={C} lit={!!tk} color={color} t={t + i} twin={role === 'coder'} />
            {tk && <Paper x={x - 20} y={y + 6} label={tk.key} color={PRIORITY_META[tk.priority].color} C={C} onClick={() => open(tk.id)} />}
          </g>
        );
      })}
      <DeptProp z={z} C={C} role={role} t={t} />
      {!enabled && <text x={cx(z)} y={z.y + z.h - 14} textAnchor="middle" fontSize={10.5} fill={C.text}>disabled in Agents</text>}
    </g>
  );
}

function DeptProp({ z, C, role, t }: { z: Zone; C: Pal; role: AgentRole; t: number }) {
  const p = points.prop(z);
  switch (role) {
    case 'planner':
      return (
        <g>
          <rect x={p.x - 50} y={p.y - 30} width={100} height={12} rx={3} fill="#f8fafc" stroke="#94a3b8" />
          <path d={`M ${p.x - 42} ${p.y - 24} q 10 -4 20 0 t 20 0 M ${p.x + 4} ${p.y - 25} l 30 0`} stroke="#8b5cf6" strokeWidth={1.4} fill="none" />
          <Plant x={z.x + z.w - 22} y={z.y + z.h - 24} C={C} />
        </g>
      );
    case 'coder':
      return (
        <g>
          <rect x={p.x - 44} y={p.y - 28} width={88} height={14} rx={3} fill={C.desk} />
          {[0, 1, 2, 3, 4, 5, 6].map((i) => <rect key={i} x={p.x - 40 + i * 12} y={p.y - 26} width={9} height={10} rx={1} fill={['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#64748b', '#ec4899'][i]} opacity={0.8} />)}
          <Plant x={z.x + 22} y={z.y + z.h - 24} C={C} />
        </g>
      );
    case 'tester':
      return (
        <g>
          <rect x={p.x - 40} y={p.y - 30} width={80} height={16} rx={3} fill={C.desk} />
          {[0, 1, 2, 3].map((i) => <rect key={i} x={p.x - 34 + i * 18} y={p.y - 28} width={10} height={12} rx={2} fill={C.monitor} stroke={Math.sin(t * 3 + i) > 0 ? '#10b981' : '#f59e0b'} strokeWidth={1.2} />)}
        </g>
      );
    case 'reviewer':
      return (
        <g>
          <rect x={p.x - 46} y={p.y - 26} width={92} height={14} rx={3} fill={C.desk} />
          {[0, 1, 2, 3, 4, 5].map((i) => <rect key={i} x={p.x - 42 + i * 14} y={p.y - 24} width={11} height={10} rx={1} fill={['#0ea5e9', '#f97316', '#22c55e', '#a855f7', '#eab308', '#14b8a6'][i]} opacity={0.75} />)}
          <Plant x={z.x + z.w - 22} y={z.y + z.h - 24} C={C} />
        </g>
      );
  }
}

function Plant({ x, y, C }: { x: number; y: number; C: Pal }) {
  return (
    <g>
      <circle cx={x} cy={y} r={9} fill="#8b6b4a" />
      {[0, 72, 144, 216, 288].map((a) => <ellipse key={a} cx={x + Math.cos((a * Math.PI) / 180) * 7} cy={y + Math.sin((a * Math.PI) / 180) * 7} rx={7} ry={4} transform={`rotate(${a} ${x + Math.cos((a * Math.PI) / 180) * 7} ${y + Math.sin((a * Math.PI) / 180) * 7})`} fill={C.plant} />)}
      <circle cx={x} cy={y} r={4} fill={C.plant} />
    </g>
  );
}

function PmOffice({ z, C, awaiting, open, accent }: { z: Zone; C: Pal; awaiting: Ticket[]; open: (id: string) => void; accent: string }) {
  const chair = points.pmChair(z);
  const tray = points.inboxTray(z);
  return (
    <g>
      <ellipse cx={cx(z)} cy={z.y + 140} rx={80} ry={60} fill={C.rug} opacity={0.6} />
      <circle cx={chair.x} cy={chair.y + 3} r={13} fill={C.chair} />
      <rect x={cx(z) - 50} y={z.y + 100} width={100} height={36} rx={5} fill={C.desk} filter="url(#soft)" />
      <rect x={cx(z) - 47} y={z.y + 103} width={94} height={30} rx={4} fill={C.deskTop} />
      <rect x={cx(z) - 16} y={z.y + 105} width={32} height={8} rx={2} fill={C.monitor} />
      <rect x={cx(z) - 15} y={z.y + 106} width={30} height={6} rx={1} fill={accent} opacity={0.6} />
      {/* inbox tray */}
      <g style={{ cursor: awaiting.length ? 'pointer' : 'default' }} onClick={() => awaiting[0] && open(awaiting[0].id)}>
        <rect x={tray.x - 30} y={tray.y - 20} width={60} height={40} rx={5} fill={C.desk} stroke={awaiting.length ? accent : 'none'} strokeWidth={2} />
        {awaiting.slice(0, 5).map((tk, i) => <rect key={tk.id} x={tray.x - 17 + i * 1.5} y={tray.y - 12 - i * 3} width={34} height={22} rx={2} fill={C.paper} stroke={PRIORITY_META[tk.priority].color} />)}
        <text x={tray.x} y={tray.y + 34} textAnchor="middle" fontSize={10} fontWeight={700} fill={awaiting.length ? accent : C.text}>INBOX {awaiting.length ? `(${awaiting.length})` : ''}</text>
      </g>
      {awaiting.slice(0, 4).map((tk, i) => (
        <g key={tk.id} style={{ cursor: 'pointer' }} onClick={() => open(tk.id)}>
          <text x={z.x + 108} y={z.y + 250 + i * 16} fontSize={9.5} fill={C.text} fontFamily="JetBrains Mono, monospace">• {tk.key} {tk.gate === 'plan' ? 'plan' : 'ship?'}</text>
        </g>
      ))}
      <Plant x={z.x + z.w - 24} y={z.y + 42} C={C} />
      <Plant x={z.x + z.w - 24} y={z.y + z.h - 24} C={C} />
      <rect x={z.x + 16} y={z.y + 36} width={50} height={24} rx={3} fill="#f8fafc" stroke="#94a3b8" />
      <path d={`M ${z.x + 20} ${z.y + 54} l 8 -6 l 8 3 l 8 -9 l 8 4 l 8 -6`} stroke={accent} strokeWidth={1.6} fill="none" />
    </g>
  );
}

function BreakRoom({ z, C }: { z: Zone; C: Pal }) {
  const s = breakSpots(z);
  return (
    <g>
      {/* coffee machine + counter */}
      <rect x={z.x + 16} y={z.y + 34} width={90} height={24} rx={4} fill={C.desk} />
      <rect x={z.x + 24} y={z.y + 30} width={22} height={24} rx={3} fill="#374151" />
      <circle cx={z.x + 35} cy={z.y + 42} r={4} fill="#ef4444" opacity={0.8} />
      <circle cx={z.x + 62} cy={z.y + 46} r={4} fill="#f8fafc" stroke="#9ca3af" />
      {/* water cooler */}
      <circle cx={z.x + z.w - 36} cy={z.y + 48} r={12} fill="#bae6fd" stroke="#38bdf8" strokeWidth={2} />
      {/* round table */}
      <circle cx={(s[5].x + s[6].x) / 2} cy={s[5].y - 2} r={20} fill={C.deskTop} filter="url(#soft)" />
      <circle cx={(s[5].x + s[6].x) / 2 - 4} cy={s[5].y - 5} r={4} fill="#f59e0b" />
      {/* couch */}
      <rect x={z.x + 64} y={z.y + 228} width={166} height={26} rx={10} fill={C.couch} filter="url(#soft)" />
      <rect x={z.x + 64} y={z.y + 240} width={166} height={16} rx={8} fill={C.couch} opacity={0.8} />
      <Plant x={z.x + 30} y={z.y + z.h - 30} C={C} />
    </g>
  );
}

function Huddle({ z, C }: { z: Zone; C: Pal }) {
  return (
    <g>
      <circle cx={cx(z)} cy={z.y + 140} r={30} fill={C.deskTop} stroke={C.desk} strokeWidth={4} filter="url(#soft)" />
      {[0, 1, 2, 3].map((i) => {
        const p = points.huddle(z, i);
        return <circle key={i} cx={p.x} cy={p.y + 4} r={10} fill={C.chair} opacity={0.7} />;
      })}
      <rect x={z.x + 20} y={z.y + 34} width={z.w - 40} height={14} rx={3} fill="#f8fafc" stroke="#94a3b8" />
      <text x={cx(z)} y={z.y + 44} textAnchor="middle" fontSize={8} fill="#64748b">rework &amp; decisions</text>
    </g>
  );
}

function Servers({ z, C, t, busy, ci, open }: { z: Zone; C: Pal; t: number; busy: boolean; ci: Ticket[]; open: (id: string) => void }) {
  const red = ci.some((x) => x.ci?.state === 'failure');
  const rack = points.ciRack(z);
  return (
    <g>
      <rect x={rack.x - 70} y={rack.y - 16} width={140} height={34} rx={5} fill={C.desk} opacity={0.9} />
      {ci.slice(0, 3).map((tk, i) => (
        <g key={tk.id}>
          <Paper x={rack.x - 44 + i * 44} y={rack.y + 1} label={tk.key} color={tk.ci?.state === 'failure' ? '#ef4444' : tk.ci?.state === 'success' ? '#10b981' : '#f59e0b'} C={C} onClick={() => open(tk.id)} />
        </g>
      ))}
      {ci.length > 0 && <text x={cx(z)} y={z.y + z.h - 10} textAnchor="middle" fontSize={10} fill={red ? '#ef4444' : C.text}>🚦 {ci.length} waiting on CI</text>}
      {[0, 1, 2].map((r) => (
        <g key={r}>
          <rect x={z.x + 24 + r * 50} y={z.y + 44} width={36} height={130} rx={4} fill={C.monitor} filter="url(#soft)" />
          {Array.from({ length: 9 }, (_, i) => (
            <circle key={i} cx={z.x + 34 + r * 50 + (i % 2) * 14} cy={z.y + 56 + Math.floor(i / 2) * 26} r={2.4}
              fill={busy && Math.sin(t * (5 + i) + r * 3) > 0.2 ? (red && i % 3 === 0 ? '#ef4444' : ci.length ? '#f59e0b' : '#22c55e') : '#334155'} />
          ))}
        </g>
      ))}
    </g>
  );
}

function ShipDock({ z, C, t, shipped, launching }: { z: Zone; C: Pal; t: number; shipped: number; launching: boolean }) {
  const pad = points.shipPad(z);
  const lift = launching ? Math.max(0, Math.sin(t * 3) * 6) : 0;
  return (
    <g>
      <circle cx={pad.x} cy={pad.y} r={34} fill="none" stroke="#f59e0b" strokeWidth={3} strokeDasharray="8 6" transform={`rotate(${t * 20} ${pad.x} ${pad.y})`} />
      <circle cx={pad.x} cy={pad.y} r={24} fill={C.tile} />
      <g transform={`translate(${pad.x} ${pad.y - lift})`}>
        {launching && <ellipse cx={0} cy={18} rx={6} ry={10 + Math.sin(t * 30) * 3} fill="#f97316" opacity={0.85} />}
        <path d="M 0 -20 C 9 -10 9 6 6 12 L -6 12 C -9 6 -9 -10 0 -20 Z" fill="#e2e8f0" stroke="#64748b" />
        <circle cy={-4} r={3.5} fill="#38bdf8" />
        <path d="M -6 6 L -12 14 L -6 12 Z M 6 6 L 12 14 L 6 12 Z" fill="#ef4444" />
      </g>
      {/* shipped crates */}
      {Array.from({ length: Math.min(shipped, 9) }, (_, i) => (
        <rect key={i} x={z.x + z.w - 50 + (i % 3) * 12} y={z.y + z.h - 30 - Math.floor(i / 3) * 12} width={11} height={11} rx={1.5} fill="#c08a4f" stroke="#8b5e34" />
      ))}
      <text x={z.x + 14} y={z.y + z.h - 14} fontSize={11} fontWeight={700} fill={C.text}>🚀 {shipped} shipped</text>
    </g>
  );
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

export { DEFAULT_ZONES };

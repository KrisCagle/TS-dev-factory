import type { AgentConfig, AgentRole, LogEvent, Stage, Ticket } from '../../types';
import { PRIORITY_META } from '../../meta';
import { breakSpots, chairPt, deliverPt, points, route, type Pt, type Zone, type ZoneId } from './layout';

export type Role = AgentRole | 'pm';
export interface Carry { ticketId: string; key: string; color: string }

type Action =
  | { type: 'walk'; to: () => Pt }
  | { type: 'wait'; ms: number }
  | { type: 'pick'; carry: Carry }
  | { type: 'drop'; ship?: boolean }
  | { type: 'say'; text: string; ms?: number; tone?: Tone }
  | { type: 'do'; fn: () => void };

export type Tone = 'info' | 'ok' | 'bad' | 'think';

export interface Char {
  id: string;
  role: Role;
  slot: number;
  x: number;
  y: number;
  facing: number;
  path: Pt[];
  actions: Action[];
  waitUntil: number;
  carry?: Carry;
  ticketId?: string;
  bubble?: { text: string; until: number; tone: Tone };
  nextWander: number;
  nextFidget: number;
  home?: Pt;
  spot?: number;
  dragging: boolean;
  seated: boolean;
  walking: boolean;
  sadUntil?: number;
}

export interface Particle { x: number; y: number; vx: number; vy: number; r: number; vr: number; color: string; life: number }

const ACTIVE: Stage[] = ['planning', 'coding', 'testing', 'reviewing'];
const ROLES: AgentRole[] = ['planner', 'coder', 'tester', 'reviewer'];
const BASE_SPEED = 135; // px/s
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export class Sim {
  chars: Char[] = [];
  particles: Particle[] = [];
  zones!: Record<ZoneId, Zone>;
  zoneList: Zone[] = [];
  speed = 1;
  now = 0;
  launchUntil = 0;
  private prev = new Map<string, { stage: Stage; agent?: AgentRole }>();
  private tickets = new Map<string, Ticket>();
  private agents: AgentConfig[] = [];
  private initialized = false;

  setZones(z: Record<ZoneId, Zone>) {
    this.zones = z;
    this.zoneList = Object.values(z);
  }

  private say(c: Char, text: string, ms = 3500, tone: Tone = 'info') {
    c.bubble = { text, until: this.now + ms, tone };
  }

  pm() {
    return this.chars.find((c) => c.role === 'pm')!;
  }

  private busy(c: Char) {
    if (!c.ticketId || c.role === 'pm') return false;
    const t = this.tickets.get(c.ticketId);
    return !!t && ACTIVE.includes(t.stage) && t.activeAgent === c.role;
  }

  isWorking(c: Char) {
    return this.busy(c) && c.seated;
  }

  ticketOf(c: Char) {
    return c.ticketId ? this.tickets.get(c.ticketId) : undefined;
  }

  enabled(role: Role) {
    return role === 'pm' || this.agents.find((a) => a.role === role)?.enabled !== false;
  }

  // ------------------------------------------------------------ roster
  private ensureChars(pool: number) {
    if (!this.chars.some((c) => c.role === 'pm')) {
      const p = points.pmChair(this.zones.pm);
      this.chars.push(this.mk('pm', 0, p));
    }
    for (const role of ROLES) {
      for (let slot = 0; slot < pool; slot++) {
        if (!this.chars.some((c) => c.role === role && c.slot === slot)) {
          const spots = breakSpots(this.zones.break);
          const taken = new Set(this.chars.map((c) => c.spot));
          const idx = spots.findIndex((_, i) => !taken.has(i));
          const s = spots[Math.max(0, idx)];
          // newcomers enter from the corridor
          const c = this.mk(role, slot, this.initialized ? { x: 20, y: 372 } : { x: s.x, y: s.y });
          if (!this.initialized && idx >= 0) c.spot = idx;
          this.chars.push(c);
        }
      }
    }
    this.chars = this.chars.filter((c) => c.role === 'pm' || c.slot < pool || c.ticketId || c.actions.length);
  }

  private mk(role: Role, slot: number, p: Pt): Char {
    return {
      id: `${role}-${slot}`, role, slot, x: p.x, y: p.y, facing: -90, path: [], actions: [], waitUntil: 0,
      nextWander: this.now + rnd(1000, 6000), nextFidget: this.now + rnd(6000, 12000), dragging: false, seated: false, walking: false,
    };
  }

  private assign(ticketId: string, role: AgentRole): Char | undefined {
    const mine = this.chars.find((c) => c.role === role && c.ticketId === ticketId);
    if (mine) return mine;
    const free = this.chars.filter((c) => c.role === role && !c.ticketId).sort((a, b) => a.slot - b.slot)[0];
    if (free) {
      free.ticketId = ticketId;
      return free;
    }
    return undefined; // more tickets than desks — the work still happens, just off-screen
  }

  // ------------------------------------------------------------ sync with server state
  sync(tickets: Ticket[], agents: AgentConfig[], concurrency: number) {
    this.agents = agents;
    this.tickets = new Map(tickets.map((t) => [t.id, t]));
    this.ensureChars(Math.max(1, Math.min(3, concurrency)));

    if (!this.initialized) {
      for (const t of tickets) {
        this.prev.set(t.id, { stage: t.stage, agent: ACTIVE.includes(t.stage) ? t.activeAgent : undefined });
        if (ACTIVE.includes(t.stage) && t.activeAgent) {
          const c = this.assign(t.id, t.activeAgent);
          if (c) Object.assign(c, chairPt(this.zones[t.activeAgent], c.slot), { seated: true });
        }
      }
      this.initialized = true;
      return;
    }

    for (const t of tickets) {
      const cur = { stage: t.stage, agent: ACTIVE.includes(t.stage) ? t.activeAgent : undefined };
      const p = this.prev.get(t.id);
      this.prev.set(t.id, cur);
      if (!p) continue;
      if (p.stage === cur.stage && p.agent === cur.agent) continue;
      this.transition(t, p, cur);
    }
    for (const id of [...this.prev.keys()]) if (!this.tickets.has(id)) this.prev.delete(id);

    // safety net: release characters whose ticket moved on and who have nothing queued
    for (const c of this.chars) {
      if (c.ticketId && !this.busy(c) && !c.actions.length && !c.path.length) c.ticketId = undefined;
    }
    // and make sure every active ticket has someone on it (e.g. after a reload)
    for (const t of tickets) if (ACTIVE.includes(t.stage) && t.activeAgent) this.assign(t.id, t.activeAgent);
  }

  private name(role: Role) {
    return role === 'pm' ? 'PM' : this.agents.find((a) => a.role === role)?.name ?? role;
  }

  private transition(t: Ticket, p: { stage: Stage; agent?: AgentRole }, cur: { stage: Stage; agent?: AgentRole }) {
    const z = this.zones;
    const carry: Carry = { ticketId: t.id, key: t.key, color: PRIORITY_META[t.priority].color };
    const A = p.agent ? this.chars.find((c) => c.role === p.agent && c.ticketId === t.id) : undefined;
    const pm = this.pm();

    if (A && A.role !== cur.agent) A.ticketId = undefined;

    if (cur.agent) {
      if (A && A.role === cur.agent) return;
      const B = this.assign(t.id, cur.agent);
      if (!B) return;
      if (!A && p.stage === 'ci') {
        // Red CI: the Coder fetches the ticket back from the server room.
        B.actions.push(
          { type: 'walk', to: () => points.ciRack(z.servers) },
          { type: 'say', text: '❌ CI red — on it', ms: 2200, tone: 'bad' },
          { type: 'pick', carry },
        );
      } else if (!A) {
        const fromPm = p.stage === 'awaiting_approval';
        if (fromPm) this.say(pm, t.gate === 'plan' || p.stage === 'awaiting_approval' ? '👍 Go for it' : '↩ Try again', 2500, 'ok');
        B.actions.push(
          { type: 'walk', to: () => (fromPm ? points.pmInbox(z.pm) : points.wallPickup(z.wall)) },
          { type: 'pick', carry },
          { type: 'say', text: `Got ${t.key}!`, ms: 1800 },
        );
      } else if ((A.role === 'reviewer' || A.role === 'tester') && cur.agent === 'coder') {
        // rework: meet at the huddle table
        A.actions.push(
          { type: 'pick', carry },
          { type: 'walk', to: () => points.huddle(z.huddle, 0) },
          { type: 'say', text: A.role === 'reviewer' ? '🔁 Needs changes' : '❌ Tests failing', ms: 3200, tone: 'bad' },
          { type: 'wait', ms: 3000 },
          { type: 'drop' },
        );
        B.actions.push(
          { type: 'walk', to: () => points.huddle(z.huddle, 2) },
          { type: 'wait', ms: 900 },
          { type: 'say', text: 'On it! 💪', ms: 2200, tone: 'ok' },
          { type: 'wait', ms: 2000 },
          { type: 'pick', carry },
        );
      } else {
        // forward hand-off, desk to desk
        const bSlot = B.slot;
        const bRole = cur.agent;
        A.actions.push(
          { type: 'pick', carry },
          { type: 'walk', to: () => deliverPt(z[bRole], bSlot) },
          { type: 'say', text: `${t.key} → ${this.name(bRole)}`, ms: 2000 },
          { type: 'wait', ms: 600 },
          { type: 'drop' },
        );
      }
      return;
    }

    if (cur.stage === 'ci') {
      if (A) {
        A.actions.push(
          { type: 'pick', carry },
          { type: 'walk', to: () => points.ciRack(z.servers) },
          { type: 'say', text: `🚦 ${t.key} → CI`, ms: 2000 },
          { type: 'wait', ms: 500 },
          { type: 'drop' },
        );
      }
      return;
    }

    if (cur.stage === 'awaiting_approval') {
      if (A) {
        A.actions.push(
          { type: 'pick', carry },
          { type: 'walk', to: () => points.pmInbox(z.pm) },
          { type: 'say', text: '✋ Ready for you', ms: 2200, tone: 'ok' },
          { type: 'wait', ms: 500 },
          { type: 'drop' },
        );
      }
      this.say(pm, `📥 ${t.key} needs you`, 5000, 'info');
      return;
    }

    if (cur.stage === 'done') {
      const who = p.stage === 'awaiting_approval' ? pm : A;
      if (who) {
        if (who === pm) this.say(pm, '✅ Approved', 1800, 'ok');
        who.actions.push(
          ...(who === pm ? [{ type: 'walk', to: () => points.pmInbox(z.pm) } as Action] : []),
          { type: 'pick', carry },
          { type: 'walk', to: () => points.shipStand(z.ship) },
          { type: 'say', text: '🚀 Shipping!', ms: 2200, tone: 'ok' },
          { type: 'wait', ms: 500 },
          { type: 'drop', ship: true },
          { type: 'wait', ms: 1200 },
        );
      } else this.launch();
      return;
    }

    if (cur.stage === 'failed' && A) {
      this.say(A, `⚠ ${t.error?.slice(0, 40) ?? 'Failed'}`, 6000, 'bad');
      A.sadUntil = this.now + 6000;
      return;
    }

    if (cur.stage === 'backlog' && A) this.say(A, '⏹ Stopped by PM', 3000, 'bad');
  }

  launch() {
    this.launchUntil = this.now + 2600;
    const pad = points.shipPad(this.zones.ship);
    const colors = ['#f43f5e', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#facc15'];
    for (let i = 0; i < 70; i++) {
      const a = rnd(-Math.PI, 0);
      const v = rnd(90, 260);
      this.particles.push({ x: pad.x, y: pad.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, r: rnd(0, 360), vr: rnd(-400, 400), color: colors[i % colors.length], life: rnd(1.2, 2.2) });
    }
  }

  // ------------------------------------------------------------ live log → speech bubbles
  onLog(e: LogEvent) {
    if (e.agent === 'pm') {
      if (e.kind === 'pm') this.say(this.pm(), e.text.slice(0, 44), 3500, 'ok');
      return;
    }
    if (e.agent === 'factory') {
      if (e.text.startsWith('⏰')) {
        const c = this.chars.find((x) => x.ticketId === e.ticketId && x.role !== 'pm');
        if (c) {
          this.say(c, '⏰ Nudged by the watchdog', 3500, 'bad');
          c.sadUntil = this.now + 3000;
        }
      }
      if (/CI is green/.test(e.text)) this.say(this.pm(), '🚦 CI green — ready for you', 3000, 'ok');
      return;
    }
    if (!e.agent) return;
    const c = this.chars.find((x) => x.role === e.agent && x.ticketId === e.ticketId);
    if (!c) return;
    switch (e.kind) {
      case 'tool':
        this.say(c, toolBubble(e.text), 3000, 'info');
        break;
      case 'text':
        this.say(c, `💭 ${clip(e.text, 52)}`, 4500, 'think');
        break;
      case 'result':
        this.say(c, clip(e.text, 56), 5000, /❌|🔁|fail/i.test(e.text) ? 'bad' : 'ok');
        break;
      case 'error':
        this.say(c, `⚠ ${clip(e.text, 50)}`, 6000, 'bad');
        break;
    }
  }

  // ------------------------------------------------------------ per-frame update
  step(dtSec: number, nowMs: number) {
    this.now = nowMs;
    const v = BASE_SPEED * this.speed;
    const z = this.zones;

    for (const c of this.chars) {
      if (c.bubble && c.bubble.until < nowMs) c.bubble = undefined;
      if (c.dragging) { c.walking = false; continue; }

      // movement
      if (c.path.length) {
        const tgt = c.path[0];
        const dx = tgt.x - c.x;
        const dy = tgt.y - c.y;
        const d = Math.hypot(dx, dy);
        const s = v * dtSec;
        c.seated = false;
        c.walking = true;
        if (d > 0.5) c.facing = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (d <= s) { c.x = tgt.x; c.y = tgt.y; c.path.shift(); }
        else { c.x += (dx / d) * s; c.y += (dy / d) * s; }
        continue;
      }
      c.walking = false;
      if (c.waitUntil > nowMs) continue;

      // scripted actions
      if (c.actions.length) {
        const a = c.actions.shift()!;
        switch (a.type) {
          case 'walk': c.path = route(c, a.to(), this.zoneList); c.seated = false; break;
          case 'wait': c.waitUntil = nowMs + a.ms / this.speed; break;
          case 'pick': c.carry = a.carry; break;
          case 'drop': c.carry = undefined; if (a.ship) this.launch(); break;
          case 'say': this.say(c, a.text, a.ms, a.tone); break;
          case 'do': a.fn(); break;
        }
        continue;
      }

      // default behaviour
      if (c.role === 'pm') {
        this.goSit(c, points.pmChair(z.pm));
        continue;
      }
      if (this.busy(c)) {
        c.spot = undefined;
        const seat = chairPt(z[c.role as AgentRole], c.slot);
        if (this.goSit(c, seat)) {
          c.carry = undefined; // paper lands on the desk
          if (nowMs > c.nextFidget) {
            c.nextFidget = nowMs + rnd(9000, 16000);
            if (Math.random() < 0.3) {
              const zoneFor: ZoneId = c.role === 'tester' ? 'servers' : (c.role as ZoneId);
              c.actions.push({ type: 'walk', to: () => points.prop(z[zoneFor]) }, { type: 'say', text: PROP_SAY[c.role as AgentRole], ms: 2000, tone: 'think' }, { type: 'wait', ms: 2200 });
            }
          }
        }
        continue;
      }
      // idle
      if (c.home) {
        this.goSit(c, c.home, false);
        continue;
      }
      if (nowMs > c.nextWander) {
        c.nextWander = nowMs + rnd(7000, 15000);
        const spots = breakSpots(z.break);
        const taken = new Set(this.chars.filter((o) => o !== c).map((o) => o.spot));
        const off = !this.enabled(c.role);
        const choices = spots.map((_, i) => i).filter((i) => !taken.has(i) && (!off || (i >= 2 && i <= 4)));
        const i = choices[Math.floor(Math.random() * choices.length)];
        if (i !== undefined) {
          c.spot = i;
          const s = spots[i];
          c.actions.push({ type: 'walk', to: () => breakSpots(this.zones.break)[i] }, { type: 'say', text: off ? '💤 off duty' : s.say, ms: 1800 });
        }
      }
    }

    // confetti
    for (const p of this.particles) {
      p.vy += 260 * dtSec;
      p.vx *= 0.99;
      p.x += p.vx * dtSec;
      p.y += p.vy * dtSec;
      p.r += p.vr * dtSec;
      p.life -= dtSec;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  /** Walk to a point; returns true once seated there. */
  private goSit(c: Char, p: Pt, faceUp = true) {
    if (Math.hypot(c.x - p.x, c.y - p.y) > 2) {
      c.path = route(c, p, this.zoneList);
      c.seated = false;
      return false;
    }
    if (faceUp) c.facing = -90;
    c.seated = true;
    return true;
  }

  // ------------------------------------------------------------ user interaction
  drag(c: Char, p: Pt) {
    c.dragging = true;
    c.x = p.x;
    c.y = p.y;
    c.path = [];
  }

  dropChar(c: Char) {
    c.dragging = false;
    c.seated = false;
    if (c.role === 'pm') { this.say(c, 'Back to my desk…', 1800); return; }
    if (this.busy(c)) {
      this.say(c, 'Back to work! 🏃', 1800);
    } else {
      c.home = { x: c.x, y: c.y };
      c.spot = undefined;
      this.say(c, 'Nice spot 👍', 1800, 'ok');
    }
  }

  releaseHome(c: Char) {
    c.home = undefined;
    c.nextWander = 0;
  }

  /** Is a ticket currently being carried by someone? */
  carried(ticketId: string) {
    return this.chars.some((c) => c.carry?.ticketId === ticketId);
  }
}

const PROP_SAY: Record<AgentRole, string> = {
  planner: '🖊 sketching…',
  coder: '📚 checking docs',
  tester: '🖥 checking CI',
  reviewer: '📖 reading guidelines',
};

function clip(s: string, n: number) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function toolBubble(text: string) {
  const [tool, ...rest] = text.split(' ');
  const arg = rest.join(' ');
  const file = arg.split('/').pop() ?? arg;
  const icon: Record<string, string> = { Read: '📖', Edit: '✏️', Write: '📝', Bash: '▶', Grep: '🔎', Glob: '🗂', WebFetch: '🌐', WebSearch: '🌐', Task: '🧩' };
  return `${icon[tool] ?? '🔧'} ${tool} ${clip(tool === 'Bash' ? arg : file, 30)}`;
}

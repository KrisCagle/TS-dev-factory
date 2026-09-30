import type { AgentRole } from '../../types';

export interface Pt { x: number; y: number }
export type ZoneId = 'wall' | AgentRole | 'pm' | 'break' | 'huddle' | 'servers' | 'ship';

export interface Zone {
  id: ZoneId;
  label: string;
  icon: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const W = 1280;
export const H = 760;
export const CORRIDOR_Y = 372;
export const SEATS = 3;
export const DESK_Y = 64;   // desk offset from zone top
export const CHAIR_DY = 50; // chair offset below desk

export const DEFAULT_ZONES: Zone[] = [
  { id: 'wall', label: 'Ticket Wall', icon: '📌', x: 40, y: 40, w: 220, h: 250 },
  { id: 'planner', label: 'Planning', icon: '🧭', x: 290, y: 40, w: 216, h: 250 },
  { id: 'coder', label: 'Engineering', icon: '⌨️', x: 536, y: 40, w: 236, h: 250 },
  { id: 'tester', label: 'QA Lab', icon: '🧪', x: 802, y: 40, w: 206, h: 250 },
  { id: 'pm', label: 'PM Office', icon: '✋', x: 1038, y: 40, w: 202, h: 420 },
  { id: 'break', label: 'Break Room', icon: '☕', x: 40, y: 452, w: 260, h: 268 },
  { id: 'reviewer', label: 'Code Review', icon: '🔍', x: 330, y: 452, w: 236, h: 268 },
  { id: 'huddle', label: 'Huddle', icon: '💬', x: 596, y: 452, w: 196, h: 268 },
  { id: 'servers', label: 'CI / Servers', icon: '🖥', x: 822, y: 452, w: 186, h: 268 },
  { id: 'ship', label: 'Ship Dock', icon: '🚀', x: 1038, y: 490, w: 202, h: 230 },
];

export const DEPARTMENTS: AgentRole[] = ['planner', 'coder', 'tester', 'reviewer'];

export function zoneMap(overrides: Record<string, Pt>): Record<ZoneId, Zone> {
  const out = {} as Record<ZoneId, Zone>;
  for (const z of DEFAULT_ZONES) out[z.id] = { ...z, ...(overrides[z.id] ?? {}) };
  return out;
}

export const cx = (z: Zone) => z.x + z.w / 2;

export function seatX(z: Zone, i: number) {
  return z.x + (z.w * (i + 1)) / (SEATS + 1);
}
export function chairPt(z: Zone, i: number): Pt {
  return { x: seatX(z, i), y: z.y + DESK_Y + CHAIR_DY };
}
export function deliverPt(z: Zone, i: number): Pt {
  return { x: seatX(z, i) + 26, y: z.y + DESK_Y + CHAIR_DY + 16 };
}

export const points = {
  wallPickup: (z: Zone): Pt => ({ x: cx(z), y: z.y + 200 }),
  pmChair: (z: Zone): Pt => ({ x: cx(z), y: z.y + 168 }),
  pmInbox: (z: Zone): Pt => ({ x: z.x + 58, y: z.y + 300 }),
  inboxTray: (z: Zone): Pt => ({ x: z.x + 58, y: z.y + 262 }),
  shipPad: (z: Zone): Pt => ({ x: cx(z), y: z.y + 128 }),
  shipStand: (z: Zone): Pt => ({ x: cx(z) - 50, y: z.y + 150 }),
  huddle: (z: Zone, i: number): Pt => {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    return { x: cx(z) + Math.cos(a) * 46, y: z.y + 140 + Math.sin(a) * 46 };
  },
  prop: (z: Zone): Pt => ({ x: cx(z), y: z.y + z.h - 44 }),
};

/** Break-room hangout spots, with what people do there. */
export function breakSpots(z: Zone): Array<Pt & { say: string }> {
  return [
    { x: z.x + 50, y: z.y + 86, say: '☕' },
    { x: z.x + 214, y: z.y + 88, say: '💧' },
    { x: z.x + 92, y: z.y + 214, say: '😌' },
    { x: z.x + 136, y: z.y + 214, say: '📱' },
    { x: z.x + 180, y: z.y + 214, say: '😴' },
    { x: z.x + 96, y: z.y + 146, say: '🍩' },
    { x: z.x + 176, y: z.y + 146, say: '🗣' },
    { x: z.x + 136, y: z.y + 112, say: '🎧' },
    { x: z.x + 40, y: z.y + 160, say: '🌱' },
    { x: z.x + 226, y: z.y + 160, say: '📖' },
  ];
}

export function inside(p: Pt, z: Zone, pad = 0) {
  return p.x >= z.x - pad && p.x <= z.x + z.w + pad && p.y >= z.y - pad && p.y <= z.y + z.h + pad;
}

/** Walk out of the current room via its centre line, along the corridor, and into the target room. */
export function route(from: Pt, to: Pt, zones: Zone[]): Pt[] {
  const fz = zones.find((z) => inside(from, z));
  const tz = zones.find((z) => inside(to, z));
  if (fz && tz && fz.id === tz.id) return [to];
  const path: Pt[] = [];
  if (fz) path.push({ x: cx(fz), y: from.y }, { x: cx(fz), y: CORRIDOR_Y });
  else path.push({ x: from.x, y: CORRIDOR_Y });
  if (tz) path.push({ x: cx(tz), y: CORRIDOR_Y }, { x: cx(tz), y: to.y }, to);
  else path.push({ x: to.x, y: CORRIDOR_Y }, to);
  // drop zero-length hops
  return path.filter((p, i) => i === path.length - 1 || Math.hypot(p.x - (path[i + 1]?.x ?? 0), p.y - (path[i + 1]?.y ?? 0)) > 1);
}

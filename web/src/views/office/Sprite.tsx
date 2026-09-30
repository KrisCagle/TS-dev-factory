import type { Accessory } from '../../prefs';

export interface SpriteProps {
  x: number;
  y: number;
  facing: number;   // degrees, 0 = right, -90 = up
  shirt: string;
  skin: string;
  hair: string;
  accessory: Accessory;
  walking: boolean;
  working: boolean;
  t: number;        // seconds, for animation
  dim?: boolean;
  glow?: string;
}

/** A tiny top-down person. Local coords: front of the body faces -y. */
export function Sprite({ x, y, facing, shirt, skin, hair, accessory, walking, working, t, dim, glow }: SpriteProps) {
  const rot = facing + 90;
  const step = walking ? Math.sin(t * 14) * 5 : 0;
  const bob = walking ? Math.abs(Math.sin(t * 14)) * 1.2 : 0;
  const typing = working ? Math.sin(t * 22) * 2 : 0;
  const breathe = !walking && !working ? Math.sin(t * 2) * 0.4 : 0;
  return (
    <g transform={`translate(${x} ${y}) scale(1.25)`} opacity={dim ? 0.55 : 1}>
      {glow && (
        <circle r={21} fill="none" stroke={glow} strokeWidth={2} opacity={0.35 + Math.sin(t * 4) * 0.25} />
      )}
      <ellipse cx={0} cy={6} rx={15} ry={9} fill="black" opacity={0.14} />
      <g transform={`rotate(${rot}) translate(0 ${-bob})`}>
        {/* legs/feet */}
        <ellipse cx={-5} cy={-2 + step} rx={3.6} ry={5} fill="#2b2f3a" />
        <ellipse cx={5} cy={-2 - step} rx={3.6} ry={5} fill="#2b2f3a" />
        {/* body */}
        <ellipse cx={0} cy={0} rx={13 + breathe} ry={9.5} fill={shirt} />
        <ellipse cx={0} cy={-1.5} rx={9} ry={5} fill="white" opacity={0.12} />
        {/* arms */}
        <circle cx={-12} cy={-4 - (working ? 3 + typing : -step * 0.6)} r={3.6} fill={skin} />
        <circle cx={12} cy={-4 - (working ? 3 - typing : step * 0.6)} r={3.6} fill={skin} />
        {/* head */}
        <circle cx={0} cy={0.5} r={8.6} fill={skin} />
        {/* hair (back of head is +y) */}
        <path d="M -8.6 0.5 A 8.6 8.6 0 0 0 8.6 0.5 Q 0 -3 -8.6 0.5 Z" fill={hair} />
        <Acc kind={accessory} hair={hair} shirt={shirt} />
      </g>
    </g>
  );
}

function Acc({ kind, shirt }: { kind: Accessory; hair: string; shirt: string }) {
  switch (kind) {
    case 'cap':
      return (
        <g>
          <circle cx={0} cy={1} r={8.2} fill={shirt} stroke="black" strokeOpacity={0.15} />
          <path d="M -6 -4 Q 0 -13 6 -4 Z" fill={shirt} stroke="black" strokeOpacity={0.2} />
        </g>
      );
    case 'beanie':
      return (
        <g>
          <circle cx={0} cy={1} r={8.4} fill="#ef4444" />
          <circle cx={0} cy={1} r={2.6} fill="#fecaca" />
        </g>
      );
    case 'headphones':
      return (
        <g>
          <rect x={-9} y={0} width={18} height={2.2} rx={1} fill="#111827" />
          <rect x={-11.5} y={-3} width={4} height={7} rx={2} fill="#111827" />
          <rect x={7.5} y={-3} width={4} height={7} rx={2} fill="#111827" />
        </g>
      );
    case 'glasses':
      return (
        <g fill="none" stroke="#111827" strokeWidth={1.3}>
          <circle cx={-3.4} cy={-6.5} r={2.3} />
          <circle cx={3.4} cy={-6.5} r={2.3} />
        </g>
      );
    case 'bow':
      return (
        <g transform="translate(5 3)">
          <path d="M 0 0 L -4 -3 L -4 3 Z M 0 0 L 4 -3 L 4 3 Z" fill="#ec4899" />
          <circle r={1.3} fill="#be185d" />
        </g>
      );
    default:
      return null;
  }
}

export const SKINS = ['#f5d0b5', '#e8b98f', '#c98e62', '#a86b44', '#7a4a2c', '#5a3620'];
export const HAIRS = ['#1f2937', '#4b3621', '#8b5a2b', '#d4a24c', '#b83b1d', '#9ca3af', '#7c3aed'];
export const SHIRTS = ['#8b5cf6', '#0ea5e9', '#f59e0b', '#10b981', '#ef4444', '#ec4899', '#6366f1', '#14b8a6', '#64748b'];
export const ACCESSORIES: Accessory[] = ['none', 'cap', 'headphones', 'glasses', 'beanie', 'bow'];

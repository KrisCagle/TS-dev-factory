import type { GameView } from '../../types';
import { points, type Zone, type ZoneId } from './layout';

/**
 * Office upgrades unlocked in the Trophy room: plants, a trophy shelf, an espresso bar,
 * a streak sign, an arcade cabinet, an aquarium and a golden rocket. Purely decorative.
 */
export function Decor({ zones, game, dark }: { zones: Record<ZoneId, Zone>; game: GameView; dark: boolean }) {
  const on = new Set(game.unlocks.filter((u) => u.unlocked).map((u) => u.id));
  if (!on.size) return null;
  const earned = game.achievements.filter((a) => a.earnedAt).slice(-8);
  const pm = zones.pm;
  const brk = zones.break;
  const hud = zones.huddle;
  const ship = zones.ship;
  const wood = dark ? '#6b4b2e' : '#a77b52';
  return (
    <g pointerEvents="none" className="decor">
      {on.has('plants') && (['planner', 'coder', 'tester', 'reviewer'] as ZoneId[]).map((id) => {
        const z = zones[id];
        return <Plant key={id} x={z.x + z.w - 22} y={z.y + z.h - 24} />;
      })}

      {on.has('trophies') && (
        <g>
          <rect x={pm.x + pm.w - 92} y={pm.y + 46} width={78} height={34} rx={4} fill={wood} opacity={0.9} />
          <rect x={pm.x + pm.w - 92} y={pm.y + 62} width={78} height={3} fill={dark ? '#3b2a19' : '#7a5636'} />
          {earned.map((a, i) => (
            <text key={a.id} x={pm.x + pm.w - 84 + (i % 4) * 18} y={pm.y + (i < 4 ? 60 : 78)} fontSize={12} textAnchor="middle">{a.icon}</text>
          ))}
        </g>
      )}

      {on.has('coffee') && (
        <g transform={`translate(${brk.x + 26} ${brk.y + brk.h - 46})`}>
          <rect x={-14} y={0} width={44} height={22} rx={3} fill={wood} />
          <rect x={-8} y={-16} width={18} height={18} rx={3} fill={dark ? '#9ca3af' : '#4b5563'} />
          <text x={22} y={-2} fontSize={13} textAnchor="middle">☕</text>
        </g>
      )}

      {on.has('arcade') && (
        <g transform={`translate(${brk.x + brk.w - 34} ${brk.y + brk.h - 64})`}>
          <rect x={0} y={0} width={24} height={40} rx={3} fill="#7c3aed" />
          <rect x={3} y={4} width={18} height={12} rx={1} fill="#22d3ee" />
          <circle cx={8} cy={24} r={2} fill="#f43f5e" />
          <circle cx={16} cy={24} r={2} fill="#facc15" />
        </g>
      )}

      {on.has('aquarium') && (
        <g transform={`translate(${hud.x + hud.w - 58} ${hud.y + 34})`}>
          <rect x={0} y={0} width={44} height={26} rx={4} fill="#38bdf8" opacity={0.55} stroke="#0ea5e9" />
          <text x={14} y={17} fontSize={10}>🐠</text>
          <text x={30} y={22} fontSize={8}>🐟</text>
        </g>
      )}

      {on.has('neon') && game.streak.current > 0 && (
        <text x={ship.x + ship.w / 2} y={ship.y + ship.h - 14} textAnchor="middle" fontSize={12} fontWeight={700} fill="#f97316" style={{ filter: 'drop-shadow(0 0 3px #fb923c)' }}>
          🔥 {game.streak.current}-day streak
        </text>
      )}

      {on.has('gold_rocket') && (() => {
        const p = points.shipPad(ship);
        return <circle cx={p.x} cy={p.y + 6} r={34} fill="none" stroke="#facc15" strokeWidth={3} strokeDasharray="4 5" opacity={0.8} />;
      })()}
    </g>
  );
}

function Plant({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d="M -7 0 L 7 0 L 5 10 L -5 10 Z" fill="#b45309" />
      <ellipse cx={-4} cy={-5} rx={5} ry={8} fill="#16a34a" transform="rotate(-25 -4 -5)" />
      <ellipse cx={4} cy={-6} rx={5} ry={9} fill="#22c55e" transform="rotate(20 4 -6)" />
      <ellipse cx={0} cy={-9} rx={4} ry={8} fill="#15803d" />
    </g>
  );
}

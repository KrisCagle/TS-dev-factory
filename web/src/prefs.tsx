import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AgentRole, Stage } from './types';

export type Accessory = 'none' | 'cap' | 'headphones' | 'glasses' | 'beanie' | 'bow';

export interface CharacterLook {
  name?: string;
  color?: string;
  skin: string;
  hair: string;
  accessory: Accessory;
}

export interface ZonePos { x: number; y: number }

export interface Prefs {
  theme: 'system' | 'light' | 'dark';
  accent: string;
  density: 'comfortable' | 'compact';
  columns: Stage[];                                   // visible board columns, in order
  cardFields: { labels: boolean; cost: boolean; agent: boolean; source: boolean; age: boolean };
  widgets: { throughput: boolean; inFlight: boolean; awaiting: boolean; cost: boolean; cycle: boolean; loops: boolean; harvest: boolean };
  groupBy: 'none' | 'priority' | 'source';
  defaultView: View;
  knownColumns?: Stage[];
  activeProject: string;                              // 'all' or a project id
  office: {
    looks: Partial<Record<AgentRole | 'pm', CharacterLook>>;
    zones: Record<string, ZonePos>;                   // user-dragged zone positions
    showBubbles: boolean;
    showFeed: boolean;
    speed: number;                                    // walk speed multiplier
    pmName: string;
  };
}

export type View = 'inbox' | 'board' | 'office' | 'agents' | 'activity' | 'reports' | 'rules' | 'settings';

export const ALL_COLUMNS: Stage[] = ['backlog', 'ready', 'planning', 'coding', 'testing', 'reviewing', 'ci', 'awaiting_approval', 'done', 'failed'];

const DEFAULTS: Prefs = {
  theme: 'system',
  accent: '#6366f1',
  density: 'comfortable',
  columns: ALL_COLUMNS,
  cardFields: { labels: true, cost: true, agent: true, source: true, age: false },
  widgets: { throughput: true, inFlight: true, awaiting: true, cost: true, cycle: true, loops: false, harvest: true },
  groupBy: 'none',
  defaultView: 'office',
  activeProject: 'all',
  office: { looks: {}, zones: {}, showBubbles: true, showFeed: true, speed: 1, pmName: 'You' },
};

const KEY = 'factory.prefs.v1';

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!raw) return DEFAULTS;
    return {
      ...DEFAULTS,
      ...raw,
      cardFields: { ...DEFAULTS.cardFields, ...raw.cardFields },
      widgets: { ...DEFAULTS.widgets, ...raw.widgets },
      office: { ...DEFAULTS.office, ...raw.office },
      // add columns introduced after the prefs were saved, in their natural place
      columns: ALL_COLUMNS.filter((c) => (raw.columns ?? ALL_COLUMNS).includes(c) || !(raw.knownColumns ?? ALL_COLUMNS.filter((x) => x !== 'ci')).includes(c)),
      knownColumns: ALL_COLUMNS,
    };
  } catch {
    return DEFAULTS;
  }
}

const Ctx = createContext<{ prefs: Prefs; set: (p: Partial<Prefs>) => void; setOffice: (p: Partial<Prefs['office']>) => void; reset: () => void } | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* private mode */
    }
    const root = document.documentElement;
    const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.density = prefs.density;
    root.style.setProperty('--accent', prefs.accent);
  }, [prefs]);

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const fn = () => setPrefs((p) => ({ ...p }));
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);

  return (
    <Ctx.Provider
      value={{
        prefs,
        set: (p) => setPrefs((cur) => ({ ...cur, ...p })),
        setOffice: (p) => setPrefs((cur) => ({ ...cur, office: { ...cur.office, ...p } })),
        reset: () => setPrefs(DEFAULTS),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function usePrefs() {
  const c = useContext(Ctx);
  if (!c) throw new Error('usePrefs outside provider');
  return c;
}

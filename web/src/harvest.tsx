import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type HarvestStatus } from './api';
import { useFactory } from './state';

interface HarvestCtx {
  status: HarvestStatus | null;
  refresh: (force?: boolean) => Promise<void>;
  /** Start a PM-review timer for a ticket if auto-timers are on and none is running. */
  autoStart: (ticketId: string, reason?: string) => void;
}

const Ctx = createContext<HarvestCtx | null>(null);

export function HarvestProvider({ children }: { children: ReactNode }) {
  const { settings, tickets } = useFactory();
  const [status, setStatus] = useState<HarvestStatus | null>(null);
  const enabled = !!settings?.harvest.enabled;

  const refresh = useCallback(async (force = false) => {
    if (!enabled) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await api.harvestStatus(force));
    } catch {
      /* shown as not configured */
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  // A timer started or stopped anywhere → refresh the pill.
  const timerSig = tickets.map((t) => t.harvest?.timer?.entryId ?? '').join(',');
  useEffect(() => {
    void refresh(true);
  }, [timerSig, refresh]);

  const autoStart = (ticketId: string, reason = 'PM review') => {
    if (!enabled || !settings?.harvest.autoTimer || !status?.configured) return;
    const t = tickets.find((x) => x.id === ticketId);
    if (!t || t.harvest?.timer) return;
    api.timerStart(ticketId, reason).catch(() => undefined);
  };

  return <Ctx.Provider value={{ status, refresh, autoStart }}>{children}</Ctx.Provider>;
}

export function useHarvest() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useHarvest outside provider');
  return c;
}

export function fmtHours(h: number) {
  const m = Math.round(h * 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

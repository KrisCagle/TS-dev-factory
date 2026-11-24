import { createContext, useContext } from 'react';
import type { View } from './prefs';
import type { Stage } from './types';

export interface UI {
  view: View;
  go: (v: View) => void;
  openTicket: (id: string | null) => void;
  newTicket: (stage?: Stage) => void;
  toast: (msg: string) => void;
  palette: () => void;
  /** Jump to a session or pipeline (from the queue, the palette or the assistant). */
  focus: (what: { session?: string; pipeline?: string }) => void;
  focused: { session?: string; pipeline?: string };
}

export const UICtx = createContext<UI | null>(null);
export function useUI() {
  const c = useContext(UICtx);
  if (!c) throw new Error('useUI outside provider');
  return c;
}

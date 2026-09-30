import type { Settings, Stage, Ticket, TicketSource } from '../types.js';

export type ImportedTicket = Pick<Ticket, 'title' | 'description' | 'priority' | 'labels' | 'externalId' | 'externalUrl' | 'key'>;

export interface Connector {
  source: Exclude<TicketSource, 'local'>;
  label: string;
  isEnabled(s: Settings): boolean;
  /** Fetch tickets that should be worked by the factory. */
  pull(s: Settings): Promise<ImportedTicket[]>;
  /** Mirror factory progress back to the tracker (comment and/or transition). */
  onStage(s: Settings, t: Ticket, stage: Stage, message: string): Promise<void>;
  /** Quick credential check for the settings page. */
  test(s: Settings): Promise<string>;
}

export async function http<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

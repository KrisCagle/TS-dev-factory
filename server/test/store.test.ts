import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MASK, Store } from '../src/store.js';
import { tmpData } from './helpers.js';

describe('Store', () => {
  it('starts with one default project and sensible settings', () => {
    const s = new Store(tmpData());
    expect(s.projects()).toHaveLength(1);
    expect(s.settings().defaultProjectId).toBe(s.projects()[0].id);
    expect(s.settings().mode).toBe('mock');
  });

  it('numbers tickets per project prefix, starting at 1', () => {
    const s = new Store(tmpData());
    const d = s.projects()[0];
    s.updateSettings({ projects: [{ ...d, keyPrefix: 'WING' }, { ...d, id: 'acme', keyPrefix: 'ACME' }] });
    expect(s.createTicket({ title: 'a' }).key).toBe('WING-1');
    expect(s.createTicket({ title: 'b' }).key).toBe('WING-2');
    expect(s.createTicket({ title: 'c', projectId: 'acme' }).key).toBe('ACME-1');
    expect(s.createTicket({ title: 'd' }).key).toBe('WING-3');
  });

  it('never reuses a deleted ticket key (its branch may still exist)', () => {
    const s = new Store(tmpData());
    const a = s.createTicket({ title: 'a' });
    const b = s.createTicket({ title: 'b' });
    s.deleteTicket(b.id);
    const c = s.createTicket({ title: 'c' });
    expect(c.key).not.toBe(b.key);
    expect(Number(c.key.split('-')[1])).toBeGreaterThan(Number(b.key.split('-')[1]));
    expect(a.key).not.toBe(c.key);
  });

  it('migrates a pre-projects database into a default project', () => {
    const file = tmpData();
    fs.writeFileSync(file, JSON.stringify({
      seq: 7,
      tickets: [{ id: 't1', key: 'FAC-7', title: 'old', stage: 'backlog', notes: [], labels: [], iterations: 0, costUsd: 0, tokens: 0, order: 0, createdAt: 1, updatedAt: 1, priority: 'medium', source: 'local', description: '' }],
      settings: { repoPath: '/code/app', baseBranch: 'develop', mergeStrategy: 'pull-request', connectors: { github: { repo: 'me/app' } } },
    }));
    const s = new Store(file);
    const p = s.projects()[0];
    expect(p.repoPath).toBe('/code/app');
    expect(p.baseBranch).toBe('develop');
    expect(p.mergeStrategy).toBe('pull-request');
    expect(p.githubRepo).toBe('me/app');
    expect(s.ticket('t1')!.projectId).toBe(p.id);
    // continuing numbering after the old ticket
    expect(s.createTicket({ title: 'new' }).key).toBe('FAC-8');
  });

  it('keeps a copy of a database it cannot read instead of overwriting it', () => {
    const file = tmpData();
    fs.writeFileSync(file, '{ not json');
    const s = new Store(file);
    expect(s.tickets()).toHaveLength(0);
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), backups[0]), 'utf8')).toBe('{ not json');
  });

  it('persists to disk and reloads', () => {
    const file = tmpData();
    const a = new Store(file);
    const t = a.createTicket({ title: 'persist me' });
    a.flush();
    const b = new Store(file);
    expect(b.ticket(t.id)?.title).toBe('persist me');
  });

  it('masks secrets for the browser and keeps them when the mask comes back', () => {
    const s = new Store(tmpData());
    s.updateSettings({
      connectors: { ...s.settings().connectors, github: { ...s.settings().connectors.github, token: 'ghp_secret' } },
      harvest: { ...s.settings().harvest, token: 'hv_secret' },
      notifications: { ...s.settings().notifications, slack: { enabled: true, webhookUrl: 'https://hooks.slack.com/x' } },
    });
    const pub = s.publicSettings();
    expect(pub.connectors.github.token).toBe(MASK);
    expect(pub.harvest.token).toBe(MASK);
    expect(pub.notifications.slack.webhookUrl).toBe(MASK);
    expect(JSON.stringify(pub)).not.toContain('secret');
    // the UI saves the masked settings back unchanged
    s.updateSettings(pub);
    expect(s.settings().connectors.github.token).toBe('ghp_secret');
    expect(s.settings().harvest.token).toBe('hv_secret');
    expect(s.settings().notifications.slack.webhookUrl).toBe('https://hooks.slack.com/x');
  });

  it('moves tickets to the default project when their project is removed', () => {
    const s = new Store(tmpData());
    const d = s.projects()[0];
    s.updateSettings({ projects: [d, { ...d, id: 'gone', keyPrefix: 'GONE' }] });
    const t = s.createTicket({ title: 'x', projectId: 'gone' });
    s.updateSettings({ projects: [d] });
    expect(s.ticket(t.id)!.projectId).toBe(d.id);
  });

  it('supersedes an open inbox item when the same question is asked again', () => {
    const s = new Store(tmpData());
    const base = { kind: 'decision' as const, key: 'plan:t1', ticketId: 't1', title: 'Q' };
    const first = s.postAttention(base);
    const second = s.postAttention({ ...base, title: 'Q again' });
    expect(s.attentionItem(first.id)!.status).toBe('dismissed');
    expect(s.attentionItem(second.id)!.status).toBe('open');
    expect(s.openAttention('plan:t1')!.id).toBe(second.id);
  });

  it('closes every open item for a ticket', () => {
    const s = new Store(tmpData());
    s.postAttention({ kind: 'decision', key: 'plan:t1', ticketId: 't1', title: 'a' });
    s.postAttention({ kind: 'error', key: 'error:t1', ticketId: 't1', title: 'b' });
    s.postAttention({ kind: 'error', key: 'error:t2', ticketId: 't2', title: 'c' });
    s.closeAttentionFor('t1');
    expect(s.attention().filter((a) => a.status === 'open').map((a) => a.ticketId)).toEqual(['t2']);
  });
});

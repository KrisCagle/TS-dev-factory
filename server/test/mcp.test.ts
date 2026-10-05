import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFactory, openItem, waitForStage, type TestFactory } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, '../../integrations/claude-code-plugin/mcp/factory-mcp.mjs');

let f: TestFactory;
let proc: ChildProcessWithoutNullStreams;
let nextId = 1;
const pending = new Map<number, (m: Record<string, unknown>) => void>();

function rpc(method: string, params?: unknown) {
  const id = nextId++;
  return new Promise<Record<string, any>>((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return { text: r.result.content[0].text as string, isError: !!r.result.isError };
};

beforeAll(async () => {
  f = makeFactory();
  const port = await f.listen(0);
  proc = spawn('node', [SCRIPT], { env: { ...process.env, FACTORY_URL: `http://127.0.0.1:${port}` } });
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    }
  });
});
afterAll(async () => {
  proc?.kill();
  await f?.close();
});

describe('factory MCP server', () => {
  it('speaks MCP: initialize and list tools', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(init.result.serverInfo.name).toBe('ai-dev-factory');
    expect(init.result.capabilities.tools).toBeDefined();
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = await rpc('tools/list');
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['factory_status', 'draft_ticket', 'create_ticket', 'inbox', 'answer_inbox', 'ask_ticket', 'report', 'catch_up']));
    for (const t of list.result.tools) expect(t.inputSchema.type).toBe('object');
    const unknown = await rpc('nope/method');
    expect(unknown.error.code).toBe(-32601);
  });

  it('drafts and creates tickets, then shows them in status', async () => {
    const draft = await call('draft_ticket', { text: 'customers say the invoice PDF shows the wrong date' });
    expect(draft.text).toContain('Title: Fix: invoice PDF shows the wrong date');
    const created = await call('create_ticket', { title: 'Add CSV export', description: '## Acceptance criteria\n- [ ] It downloads', priority: 'high' });
    expect(created.text).toMatch(/Created [A-Z]+-\d+: Add CSV export \(in Backlog\)/);
    const status = await call('factory_status');
    expect(status.text).toContain('Waiting on you');
    const list = await call('list_tickets', { stage: 'backlog' });
    expect(list.text).toContain('Add CSV export');
  });

  it('clears the inbox: lists an item and approves it by ticket key', async () => {
    f.orch.start();
    const t = f.store.createTicket({ title: 'Ship via MCP', stage: 'ready' });
    await waitForStage(f, t.id, 'awaiting_approval');
    const inbox = await call('inbox');
    expect(inbox.text).toContain(`Sign off ${t.key}`);
    expect(inbox.text).toContain('Recommend:');
    const wrong = await call('answer_inbox', { ticket: t.key, option: 'yolo' });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain('ship');
    const ok = await call('answer_inbox', { ticket: t.key.toLowerCase(), option: 'ship' });
    expect(ok.isError).toBe(false);
    await waitForStage(f, t.id, 'done');
    expect(openItem(f, t.id)).toBeUndefined();
  });

  it('answers questions, adds notes and reports', async () => {
    const t = f.store.createTicket({ title: 'Question me' });
    expect((await call('ask_ticket', { ticket: t.key, question: "what's left?" })).text).toContain('backlog');
    await call('add_note', { ticket: t.key, note: 'Use the shared logger' });
    expect(f.store.ticket(t.id)!.notes.at(-1)!.text).toBe('Use the shared logger');
    expect((await call('report', { range: 'week' })).text).toMatch(/^### Week of/);
    expect((await call('catch_up', { hours: 1 })).text.length).toBeGreaterThan(5);
    expect((await call('get_ticket', { ticket: 'NOPE-1' })).isError).toBe(true);
  });

  it('explains clearly when the factory is not running', async () => {
    const lonely = spawn('node', [SCRIPT], { env: { ...process.env, FACTORY_URL: 'http://127.0.0.1:9' } });
    const out = await new Promise<string>((resolve) => {
      lonely.stdout.once('data', (d) => resolve(d.toString()));
      lonely.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'factory_status', arguments: {} } })}\n`);
    });
    lonely.kill();
    const m = JSON.parse(out);
    expect(m.result.isError).toBe(true);
    expect(m.result.content[0].text).toMatch(/Can't reach the factory/);
  });
});

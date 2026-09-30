import type { AgentRunner, RunOptions, RunResult } from './runner.js';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });

const rand = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const FILES = ['src/api/routes.ts', 'src/components/Header.tsx', 'src/lib/auth.ts', 'src/utils/format.ts', 'src/db/schema.ts', 'README.md'];

/**
 * Simulated agents — lets you try the whole factory (board, office, gates, loops)
 * without an API key or a repo. Timings are compressed so a ticket finishes in ~1 minute.
 */
export class MockRunner implements AgentRunner {
  private reviewedOnce = new Set<string>();

  async run({ agent, prompt, signal, onEvent }: RunOptions): Promise<RunResult> {
    const key = prompt.match(/Ticket ([A-Z]+-\d+)/)?.[1] ?? 'X';
    const steps = 3 + Math.floor(Math.random() * 4);
    const tools = agent.allowedTools;
    const nudged = prompt.startsWith('⏰');
    // Now and then an agent "hangs" so you can watch the watchdog catch it.
    const willHang = !nudged && Math.random() < 0.07;
    onEvent('text', rand([
      `Looking at ${key}. Let me get oriented in the codebase first.`,
      `Picking up ${key}.`,
      `On it — reading the ticket and the relevant code.`,
    ]));
    if (nudged) onEvent('text', 'Picking back up where I left off.');
    for (let i = 0; i < steps; i++) {
      if (willHang && i === 1) {
        onEvent('text', 'Waiting on a long-running command…');
        await sleep(10 * 60_000, signal); // until the watchdog aborts this attempt
      }
      await sleep(1200 + Math.random() * 1800, signal);
      const tool = rand(tools);
      const arg = tool === 'Bash' ? rand(['npm test', 'npm run lint', 'git diff --stat', 'npm run build']) : tool === 'Grep' || tool === 'Glob' ? rand(['useAuth', '**/*.test.ts', 'TODO', 'export function']) : rand(FILES);
      onEvent('tool', `${tool} ${arg}`);
    }
    await sleep(800, signal);

    const base = { costUsd: +(0.02 + Math.random() * 0.12).toFixed(4), tokens: 4000 + Math.floor(Math.random() * 20000) };

    switch (agent.role) {
      case 'planner': {
        const structured = {
          summary: `Implement ${key} with a small, contained change and tests.`,
          steps: ['Locate the affected module', 'Add the new behavior behind a clear function', 'Wire it into the caller', 'Add unit tests', 'Update docs'],
          risks: ['Existing callers may depend on current behavior'],
          files: [rand(FILES), rand(FILES)],
        };
        onEvent('text', 'Plan ready: 5 steps, 1 risk flagged.');
        return { ...base, text: structured.summary, structured };
      }
      case 'coder':
        onEvent('text', 'Implemented the change and updated the affected call sites. Build passes locally.');
        return { ...base, text: 'Implemented the change.' };
      case 'tester': {
        const passed = Math.random() > 0.2;
        const structured = passed
          ? { passed, summary: 'All 42 tests pass, added 3 new tests.', failures: [] }
          : { passed, summary: '1 test failing.', failures: ['format.test.ts › handles empty input — expected "" but got undefined'] };
        onEvent('text', structured.summary);
        return { ...base, text: structured.summary, structured };
      }
      case 'reviewer': {
        const first = !this.reviewedOnce.has(key);
        this.reviewedOnce.add(key);
        const requestChanges = first && Math.random() < 0.45;
        const structured = requestChanges
          ? { verdict: 'request_changes', summary: 'Solid approach, one real issue to fix.', comments: [{ file: rand(FILES), line: 42, severity: 'major', comment: 'Missing null check — this throws when the user is signed out.' }, { file: rand(FILES), severity: 'nit', comment: 'Consider a more descriptive name.' }] }
          : {
              verdict: 'approve',
              summary: 'Looks good. Clean, tested and consistent with the codebase.',
              comments: [{ severity: 'nit', comment: 'Could extract a helper later.' }],
              walkthrough: mockWalkthrough(prompt),
            };
        onEvent('text', structured.summary);
        return { ...base, text: structured.summary, structured };
      }
    }
  }
}

function mockWalkthrough(prompt: string) {
  const title = prompt.match(/# Ticket [A-Z]+-\d+: (.*)/)?.[1] ?? 'the change';
  return {
    setup: ['npm run dev', 'Open http://localhost:3000 and sign in as the demo user'],
    cases: [
      {
        title: `Happy path: ${title}`,
        steps: ['Go to the screen this ticket touches', 'Perform the main action described in the ticket'],
        expect: 'The new behavior works and nothing else on the screen changed.',
      },
      {
        title: 'Empty or missing input',
        steps: ['Repeat the action with the field left empty', 'Submit'],
        expect: 'A clear inline message appears — no crash, no blank screen.',
      },
      {
        title: 'Signed-out user',
        steps: ['Sign out', 'Open the same URL directly'],
        expect: 'You are redirected to sign in, then land back on this screen.',
      },
    ],
  };
}

export function mockDiff(key: string, title: string) {
  return `diff --git a/src/features/${key.toLowerCase()}.ts b/src/features/${key.toLowerCase()}.ts
new file mode 100644
--- /dev/null
+++ b/src/features/${key.toLowerCase()}.ts
@@ -0,0 +1,14 @@
+// ${title}
+export function handle(input?: string) {
+  if (!input) return '';
+  return input.trim();
+}
+
+export default handle;
diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -3,7 +3,8 @@ import { app } from './app';
 import { config } from './config';
-import { legacyHandle } from './legacy';
+import handle from './features/${key.toLowerCase()}';

-app.use(legacyHandle);
+app.use((req, _res, next) => { req.body = handle(req.body); next(); });
 app.listen(config.port);
`;
}

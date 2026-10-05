import type { AgentRunner, RunOptions, RunResult } from './runner.js';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });

const FILES = ['src/api/routes.ts', 'src/components/Header.tsx', 'src/lib/auth.ts', 'src/utils/format.ts', 'src/db/schema.ts', 'README.md'];

/** Knobs for tests and demos. Everything defaults to the lively demo behaviour. */
export interface MockOptions {
  /** Multiplies every simulated delay: 1 = demo pace (~1 min per ticket), 0.01 = near-instant. */
  speed?: number;
  /** Source of randomness; pass a seeded generator for reproducible runs. */
  random?: () => number;
  /** Force outcomes instead of rolling dice. */
  testsPass?: (key: string) => boolean;
  reviewRequestsChanges?: (key: string, firstReview: boolean) => boolean;
  hangs?: (key: string, role: string) => boolean;
  /** Simulated CI result for a ticket's first run (later runs always pass). */
  ciPasses?: (key: string) => boolean;
  /** Does the base branch's smoke test pass after this ticket ships? */
  smokePasses?: (key: string) => boolean;
  /** Does this run of the Tester report a coverage drop? */
  coverageDrops?: (key: string) => boolean;
  /** Should the Tester leave this criterion unproven? */
  leavesUnproven?: (key: string, criterion: string) => boolean;
}

/** Small deterministic PRNG (mulberry32) for reproducible simulated runs. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulated agents — lets you try the whole factory (board, office, gates, loops)
 * without an API key or a repo. Timings are compressed so a ticket finishes in ~1 minute.
 */
export class MockRunner implements AgentRunner {
  private reviewedOnce = new Set<string>();
  private random: () => number;
  private speed: number;

  constructor(private opts: MockOptions = {}) {
    this.random = opts.random ?? Math.random;
    this.speed = opts.speed ?? 1;
  }

  private rand<T>(xs: T[]) {
    return xs[Math.floor(this.random() * xs.length)];
  }

  async run({ agent, prompt, signal, onEvent }: RunOptions): Promise<RunResult> {
    const rand = <T,>(xs: T[]) => this.rand(xs);
    const random = this.random;
    const wait = (ms: number) => sleep(ms * this.speed, signal);
    const key = prompt.match(/Ticket ([A-Z0-9]+-\d+)/)?.[1] ?? 'X';
    const steps = 3 + Math.floor(random() * 4);
    const tools = agent.allowedTools.length ? agent.allowedTools : ['Read'];
    const nudged = prompt.startsWith('⏰');
    // Now and then an agent "hangs" so you can watch the watchdog catch it.
    const willHang = !nudged && (this.opts.hangs ? this.opts.hangs(key, agent.role) : random() < 0.07);
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
      await wait(1200 + random() * 1800);
      const tool = rand(tools);
      const arg = tool === 'Bash' ? rand(['npm test', 'npm run lint', 'git diff --stat', 'npm run build']) : tool === 'Grep' || tool === 'Glob' ? rand(['useAuth', '**/*.test.ts', 'TODO', 'export function']) : rand(FILES);
      onEvent('tool', `${tool} ${arg}`);
    }
    await wait(800);

    const base = { costUsd: +(0.02 + random() * 0.12).toFixed(4), tokens: 4000 + Math.floor(random() * 20000) };

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
        const passed = this.opts.testsPass ? this.opts.testsPass(key) : random() > 0.2;
        const criteria = criteriaFrom(prompt).map((criterion, i) => {
          const skip = this.opts.leavesUnproven ? this.opts.leavesUnproven(key, criterion) : random() < 0.12;
          return skip
            ? { criterion, status: 'unproven', evidence: undefined }
            : { criterion, status: passed ? 'proven' : 'failed', evidence: `${key.toLowerCase()}.test.ts › ${criterion.toLowerCase().slice(0, 48)}${i === 0 ? ' (+ screenshot 01-happy-path.png)' : ''}` };
        });
        const drops = this.opts.coverageDrops ? this.opts.coverageDrops(key) : random() < 0.08;
        const before = +(78 + random() * 10).toFixed(1);
        const after = +(drops ? before - 1.5 - random() * 2 : before + random() * 1.2).toFixed(1);
        const coverage = { before, after, files: [{ file: `src/features/${key.toLowerCase()}.ts`, pct: drops ? 61 : 92 }] };
        const structured = passed
          ? { passed, summary: 'All 42 tests pass, added 3 new tests.', failures: [], testsAdded: 3, criteria, coverage }
          : { passed, summary: '1 test failing.', failures: ['format.test.ts › handles empty input — expected "" but got undefined'], testsAdded: 2, criteria, coverage };
        onEvent('text', structured.summary);
        return { ...base, text: structured.summary, structured };
      }
      case 'reviewer': {
        const first = !this.reviewedOnce.has(key);
        this.reviewedOnce.add(key);
        const requestChanges = this.opts.reviewRequestsChanges ? this.opts.reviewRequestsChanges(key, first) : first && random() < 0.45;
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

/** The numbered criteria list the tester prompt includes, so the simulated Tester can answer per criterion. */
function criteriaFrom(prompt: string) {
  const block = prompt.split('## Prove every acceptance criterion')[1];
  if (!block) return ['The change works as described'];
  return [...block.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
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

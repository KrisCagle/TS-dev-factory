import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFactory } from './app.js';
import { seeded, type MockOptions } from './agents/mock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4317);
const mode = process.env.FACTORY_MODE === 'live' || process.env.FACTORY_MODE === 'mock' ? process.env.FACTORY_MODE : undefined;
// FACTORY_MOCK_SPEED=0.1 runs the simulated agents 10× faster (handy for demos and end-to-end tests).
const speed = process.env.FACTORY_MOCK_SPEED ? Number(process.env.FACTORY_MOCK_SPEED) : undefined;

// FACTORY_MOCK_SEED makes simulated runs reproducible; FACTORY_MOCK_HAPPY=1 makes every agent succeed first time.
const mock: MockOptions = {};
if (speed) mock.speed = speed;
if (process.env.FACTORY_MOCK_SEED) mock.random = seeded(Number(process.env.FACTORY_MOCK_SEED));
if (process.env.FACTORY_MOCK_HAPPY === '1') {
  Object.assign(mock, { testsPass: () => true, reviewRequestsChanges: () => false, hangs: () => false, ciPasses: () => true, smokePasses: () => true, coverageDrops: () => false, leavesUnproven: () => false });
}

const factory = createFactory({
  dataFile: process.env.FACTORY_DATA ?? path.resolve(__dirname, '../../.factory/db.json'),
  mode,
  repoPath: process.env.FACTORY_REPO,
  mock,
});

factory.listen(PORT).then((port) => {
  const s = factory.store.settings();
  console.log(`\n🏭 AI Dev Factory on http://localhost:${port}  (mode: ${s.mode}, ${s.projects.length} project${s.projects.length === 1 ? '' : 's'})\n`);
});

const shutdown = async () => {
  await factory.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

import fs from 'node:fs';
import path from 'node:path';

/** Keeps a running changelog of everything the factory ships. */
export default {
  name: 'changelog',
  description: 'Appends every shipped ticket to CHANGELOG.factory.md.',
  setup(api) {
    const file = path.resolve(String(api.config.file ?? 'CHANGELOG.factory.md'));
    api.on('shipped', (t) => {
      const day = new Date().toISOString().slice(0, 10);
      fs.appendFileSync(file, `- ${day} **${t.key}** ${t.title}\n`);
      api.log(t.id, `Added to ${path.basename(file)}`);
    });
  },
};

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Imports tickets from a JSON file — a template for wiring up any tool with an API. */
const besideMe = () => path.join(path.dirname(fileURLToPath(import.meta.url)), 'inbox.json');

export default {
  name: 'json-inbox',
  description: 'Imports tickets from plugins/inbox.json ([{ "id", "title", "description", "priority" }]).',
  setup(api) {
    const file = path.resolve(String(api.config.file ?? besideMe()));
    api.addSource({
      id: 'json-inbox',
      label: 'JSON inbox',
      pull: () => {
        if (!fs.existsSync(file)) return [];
        const items = JSON.parse(fs.readFileSync(file, 'utf8'));
        return items.map((x) => ({ externalId: String(x.id), title: String(x.title), description: x.description, priority: x.priority, labels: x.labels }));
      },
    });
  },
};

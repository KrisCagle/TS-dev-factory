# Factory plugins

Drop a `.mjs` file in this folder and restart the factory to load it. Files in `examples/` are not loaded — copy one up a level to try it:

```bash
cp plugins/examples/security-reviewer.mjs plugins/
```

Turn plugins on or off, and see what each one adds, in **Settings → Plugins**.

> Plugins run inside the factory with the same access to your machine as the factory itself. Only use plugins you wrote or trust.

## Writing one

```js
// plugins/my-plugin.mjs
export default {
  name: 'my-plugin',
  description: 'What it does, shown in Settings',
  setup(api) {
    api.addGate({ ... });     // a quality check before your sign-off
    api.addRole({ ... });     // an extra agent after the Tester or Reviewer
    api.addSource({ ... });   // a ticket source with an "Import now" button
    api.addRoom({ ... });     // a booth in the Office
    api.on('shipped', (ticket) => { ... });   // also 'ticketCreated', 'stageChanged'
  },
};
```

- **Gate**: `{ id, name, check(ticket) => { ok, message }, onFail: 'sendback' | 'flag' }`. `sendback` returns the change to the Coder with your message; `flag` only lowers the safety score and shows in your review.
- **Role**: `{ id, name, icon, after: 'tester' | 'reviewer', prompt(ticket) => string, model?, tools?, mock?(ticket) }`. In live mode it's a Claude session in the ticket's branch copy that returns `{ passed, summary, findings }`; `passed: false` sends the work back to the Coder with the findings. `mock` is what it reports with simulated agents.
- **Source**: `{ id, label, pull() => [{ externalId, title, description?, priority?, labels?, externalUrl? }] }`. Imported tickets land in Backlog, once each.
- **Room**: `{ id, label, icon }`, shown as a booth in the Office corridor.
- `api.config` holds this plugin's settings from `settings.plugins["<name>"].config`; `api.addNote(ticketId, text)` and `api.log(ticketId, text)` write to a ticket.

A ticket passed to your code has `id, key, title, description, stage, labels, diff, plan, testReport, projectId`.

## Examples

| File | Adds |
| --- | --- |
| `security-reviewer.mjs` | A Security reviewer agent after the Reviewer, plus a booth in the Office |
| `no-leftovers.mjs` | A gate that flags added `TODO`, `FIXME`, `console.log` and `debugger` lines |
| `changelog.mjs` | Appends every shipped ticket to `CHANGELOG.factory.md` in the repo you run the factory from |
| `json-inbox.mjs` | A ticket source that imports tickets from `plugins/inbox.json` |
